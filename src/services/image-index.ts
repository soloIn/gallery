import type { Env, SyncProgress, DailyWriteCounter } from "../utils/types";
import {
  getDirectories,
  updateDirectorySyncTime,
  deleteImagesByDir,
} from "../db/queries";
import { listDirectory } from "./eleven5";
import { withD1ErrorHandling } from "../utils/cloudflare-errors";

const PAGE_SIZE = 32;
const MAX_DAILY_WRITES = 100_000;
const WRITE_COUNTER_KEY = "sync:writecount";
const PROGRESS_KEY_PREFIX = "sync:progress:";

// --- Daily write counter management ---

async function getDailyWriteCount(kv: KVNamespace): Promise<{ date: string; count: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const counter = await kv.get<DailyWriteCounter>(WRITE_COUNTER_KEY, "json");
  if (counter && counter.date === today) {
    return counter;
  }
  return { date: today, count: 0 };
}

async function incrementWriteCount(kv: KVNamespace, amount: number): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const counter = await getDailyWriteCount(kv);
  const newCount = counter.count + amount;
  await kv.put(WRITE_COUNTER_KEY, JSON.stringify({ date: today, count: newCount }));
  return newCount;
}

async function getRemainingWrites(kv: KVNamespace): Promise<number> {
  const counter = await getDailyWriteCount(kv);
  return Math.max(0, MAX_DAILY_WRITES - counter.count);
}

// --- Progress management ---

async function getProgress(kv: KVNamespace, dirId: string): Promise<SyncProgress | null> {
  return kv.get<SyncProgress>(`${PROGRESS_KEY_PREFIX}${dirId}`, "json");
}

async function saveProgress(kv: KVNamespace, progress: SyncProgress): Promise<void> {
  await kv.put(
    `${PROGRESS_KEY_PREFIX}${progress.dirId}`,
    JSON.stringify(progress),
    { expirationTtl: 86400 * 7 } // 7 days
  );
}

async function clearProgress(kv: KVNamespace, dirId: string): Promise<void> {
  await kv.delete(`${PROGRESS_KEY_PREFIX}${dirId}`);
}

export async function getAllProgress(kv: KVNamespace): Promise<SyncProgress[]> {
  const list = await kv.list({ prefix: PROGRESS_KEY_PREFIX });
  const results: SyncProgress[] = [];
  for (const key of list.keys) {
    const progress = await kv.get<SyncProgress>(key.name, "json");
    if (progress) results.push(progress);
  }
  return results;
}

// --- Core sync logic ---

export async function syncDirectory(
  env: Env,
  dirId: string,
  includeSubdirs: boolean
): Promise<{ synced: number; paused: boolean }> {
  const seen = new Set<string>();
  const allFileIds: string[] = [];
  let totalSynced = 0;
  let paused = false;

  const result = await syncDirectoryRecursive(
    env, dirId, dirId, includeSubdirs, seen,
    (images, fileIds) => {
      totalSynced += images;
      allFileIds.push(...fileIds);
    }
  );

  if (result.paused) {
    paused = true;
    await saveProgress(env.KV_CONFIG, {
      dirId,
      status: "paused",
      totalSynced,
      lastOffset: result.nextOffset,
      writeCount: totalSynced,
      date: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
    });
  } else {
    // Only cleanup stale images on full completion
    await cleanupStaleImages(env.DB, dirId, allFileIds);
    await updateDirectorySyncTime(env.DB, dirId);
    await clearProgress(env.KV_CONFIG, dirId);
  }

  return { synced: totalSynced, paused };
}

async function syncDirectoryRecursive(
  env: Env,
  dirId: string,
  rootDirId: string,
  includeSubdirs: boolean,
  seen: Set<string>,
  onBatch: (count: number, fileIds: string[]) => void
): Promise<{ paused: boolean; nextOffset: number }> {
  if (seen.has(dirId)) return { paused: false, nextOffset: 0 };
  seen.add(dirId);

  let offset = 0;
  const batchStatements: D1PreparedStatement[] = [];

  while (true) {
    // Check remaining write quota before each batch
    const remaining = await getRemainingWrites(env.KV_CONFIG);
    if (remaining <= 0) {
      // Save progress and pause
      if (batchStatements.length > 0) {
        await withD1ErrorHandling(() => env.DB.batch(batchStatements));
        await incrementWriteCount(env.KV_CONFIG, batchStatements.length);
        batchStatements.length = 0;
      }
      return { paused: true, nextOffset: offset };
    }

    const response = await listDirectory(env, dirId, offset, PAGE_SIZE);

    if (response.errno !== 0) {
      console.error(`Failed to list directory ${dirId}: errno ${response.errno}`);
      break;
    }

    const files = response.data?.files ?? [];
    const imageFileIds: string[] = [];

    for (const file of files) {
      if (file.is_dir === 1) {
        if (includeSubdirs) {
          const subResult = await syncDirectoryRecursive(
            env, file.file_id, rootDirId, true, seen, onBatch
          );
          if (subResult.paused) return { paused: true, nextOffset: offset };
        }
      } else {
        batchStatements.push(
          env.DB.prepare(
            `INSERT INTO images (file_id, pick_code, name, dir_id, root_dir_id, sha1, size, suffix)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(file_id) DO UPDATE SET
               pick_code = excluded.pick_code,
               name = excluded.name,
               dir_id = excluded.dir_id,
               root_dir_id = excluded.root_dir_id,
               sha1 = excluded.sha1,
               size = excluded.size,
               suffix = excluded.suffix`
          ).bind(
            file.file_id,
            file.pick_code,
            file.name,
            dirId,
            rootDirId,
            file.sha1,
            file.size,
            file.suffix
          )
        );
        imageFileIds.push(file.file_id);
      }
    }

    // Execute batch upsert
    if (batchStatements.length > 0) {
      const writeCount = batchStatements.length;
      await withD1ErrorHandling(() => env.DB.batch(batchStatements));
      await incrementWriteCount(env.KV_CONFIG, writeCount);
      batchStatements.length = 0;
    }

    onBatch(imageFileIds.length, imageFileIds);

    if (files.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { paused: false, nextOffset: offset };
}

async function cleanupStaleImages(
  db: D1Database,
  rootDirId: string,
  currentFileIds: string[]
): Promise<void> {
  if (currentFileIds.length === 0) {
    await withD1ErrorHandling(() => deleteImagesByDir(db, rootDirId));
    return;
  }

  const BATCH_SIZE = 100;
  const currentSet = new Set(currentFileIds);

  let offset = 0;
  while (true) {
    const rows = await withD1ErrorHandling(() =>
      db
        .prepare("SELECT file_id FROM images WHERE root_dir_id = ?1 LIMIT ?2 OFFSET ?3")
        .bind(rootDirId, 1000, offset)
        .all<{ file_id: string }>()
    );

    const staleIds = rows.results
      .map((r) => r.file_id)
      .filter((id) => !currentSet.has(id));

    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = staleIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map((_, j) => `?${j + 2}`).join(",");
      await withD1ErrorHandling(() =>
        db
          .prepare(
            `DELETE FROM images WHERE root_dir_id = ?1 AND file_id IN (${placeholders})`
          )
          .bind(rootDirId, ...batch)
          .run()
      );
    }

    if (rows.results.length < 1000) break;
    offset += 1000;
  }
}

export async function syncAll(env: Env): Promise<void> {
  const directories = await getDirectories(env.DB);

  // First check for paused syncs
  for (const dir of directories) {
    const progress = await getProgress(env.KV_CONFIG, dir.dir_id);
    if (progress && progress.status === "paused") {
      console.log(`Resuming paused sync for directory ${dir.dir_id} from offset ${progress.lastOffset}`);
      try {
        const result = await syncDirectory(
          env,
          dir.dir_id,
          dir.include_subdirs === 1
        );
        if (result.paused) {
          console.log(`Sync paused again for ${dir.dir_id}: daily write limit reached`);
          return; // Stop processing other directories
        }
        console.log(`Resumed sync completed for ${dir.dir_id}: ${result.synced} images`);
      } catch (err) {
        console.error(`Failed to resume sync for directory ${dir.dir_id}:`, err);
        return;
      }
    }
  }

  // Then sync all directories
  for (const dir of directories) {
    const remaining = await getRemainingWrites(env.KV_CONFIG);
    if (remaining <= 0) {
      console.log("Daily write limit reached, stopping sync");
      break;
    }

    try {
      const result = await syncDirectory(
        env,
        dir.dir_id,
        dir.include_subdirs === 1
      );
      if (result.paused) {
        console.log(`Sync paused for ${dir.dir_id}: daily write limit reached`);
        return;
      }
      console.log(`Synced directory ${dir.dir_id}: ${result.synced} images`);
    } catch (err) {
      console.error(`Failed to sync directory ${dir.dir_id}:`, err);
    }
  }
}
