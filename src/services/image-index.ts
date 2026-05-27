import type { Env, SyncProgress, DailyWriteCounter } from "../utils/types";
import {
  getDirectories,
  updateDirectorySyncTime,
} from "../db/queries";
import { listDirectory } from "./eleven5";
import { withD1ErrorHandling } from "../utils/cloudflare-errors";

const PAGE_SIZE = 32;
const MAX_DAILY_WRITES = 100_000;
const WRITE_COUNTER_KEY = "sync:writecount";
const GENERATION_KEY = "sync:generation";
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

// --- Sync generation counter ---

async function getSyncGeneration(kv: KVNamespace): Promise<number> {
  const gen = await kv.get<string>(GENERATION_KEY);
  return gen ? parseInt(gen, 10) : 0;
}

async function incrementSyncGeneration(kv: KVNamespace): Promise<number> {
  const current = await getSyncGeneration(kv);
  const next = current + 1;
  await kv.put(GENERATION_KEY, String(next));
  return next;
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

// --- Generation-aware image helpers ---

async function getExistingSha1s(
  db: D1Database,
  fileIds: string[]
): Promise<Map<string, string>> {
  if (fileIds.length === 0) return new Map();

  const map = new Map<string, string>();
  // Batch in groups of 900 to stay under D1 parameter limit
  const BATCH = 900;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const chunk = fileIds.slice(i, i + BATCH);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
    const rows = await withD1ErrorHandling(() =>
      db
        .prepare(`SELECT file_id, sha1 FROM images WHERE file_id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ file_id: string; sha1: string }>()
    );
    for (const row of rows.results) {
      map.set(row.file_id, row.sha1);
    }
  }
  return map;
}

async function updateImageGeneration(
  db: D1Database,
  fileIds: string[],
  generation: number
): Promise<void> {
  if (fileIds.length === 0) return;

  const BATCH = 900;
  for (let i = 0; i < fileIds.length; i += BATCH) {
    const chunk = fileIds.slice(i, i + BATCH);
    const placeholders = chunk.map((_, j) => `?${j + 2}`).join(",");
    await withD1ErrorHandling(() =>
      db
        .prepare(
          `UPDATE images SET sync_generation = ?1 WHERE file_id IN (${placeholders})`
        )
        .bind(generation, ...chunk)
        .run()
    );
  }
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

  // Increment generation counter for this sync pass
  const generation = await incrementSyncGeneration(env.KV_CONFIG);

  const result = await syncDirectoryRecursive(
    env, dirId, dirId, includeSubdirs, seen, generation,
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
    await cleanupStaleImages(env.DB, dirId, generation);
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
  generation: number,
  onBatch: (count: number, fileIds: string[]) => void
): Promise<{ paused: boolean; nextOffset: number }> {
  if (seen.has(dirId)) return { paused: false, nextOffset: 0 };
  seen.add(dirId);

  let offset = 0;

  while (true) {
    // Check remaining write quota before each batch
    const remaining = await getRemainingWrites(env.KV_CONFIG);
    if (remaining <= 0) {
      return { paused: true, nextOffset: offset };
    }

    const response = await listDirectory(env, dirId, offset, PAGE_SIZE);

    if (response.errno !== 0) {
      console.error(`Failed to list directory ${dirId}: errno ${response.errno}`);
      break;
    }

    const files = response.data?.files ?? [];
    const imageFileIds: string[] = [];
    const imageFiles = files.filter((f) => f.is_dir !== 1);
    const dirFiles = files.filter((f) => f.is_dir === 1);

    // Recurse into subdirectories first
    for (const dir of dirFiles) {
      if (includeSubdirs) {
        const subResult = await syncDirectoryRecursive(
          env, dir.file_id, rootDirId, true, seen, generation, onBatch
        );
        if (subResult.paused) return { paused: true, nextOffset: offset };
      }
    }

    if (imageFiles.length > 0) {
      // R2: Content-addressable sync fingerprinting
      const incomingIds = imageFiles.map((f) => f.file_id);
      const existingSha1s = await getExistingSha1s(env.DB, incomingIds);

      const toUpsert: typeof imageFiles = [];
      const skippedIds: string[] = [];

      for (const file of imageFiles) {
        const existingSha1 = existingSha1s.get(file.file_id);
        if (existingSha1 !== undefined && existingSha1 === file.sha1) {
          // Content unchanged — skip write, but update generation
          skippedIds.push(file.file_id);
        } else {
          // New file or content changed — needs upsert
          toUpsert.push(file);
        }
      }

      // Update generation on skipped files (lightweight, not counted as writes)
      if (skippedIds.length > 0) {
        await updateImageGeneration(env.DB, skippedIds, generation);
      }

      // Batch upsert changed/new files
      if (toUpsert.length > 0) {
        const batchStatements: D1PreparedStatement[] = toUpsert.map((file) =>
          env.DB.prepare(
            `INSERT INTO images (file_id, pick_code, name, dir_id, root_dir_id, sha1, size, suffix, sync_generation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(file_id) DO UPDATE SET
               pick_code = excluded.pick_code,
               name = excluded.name,
               dir_id = excluded.dir_id,
               root_dir_id = excluded.root_dir_id,
               sha1 = excluded.sha1,
               size = excluded.size,
               suffix = excluded.suffix,
               sync_generation = excluded.sync_generation`
          ).bind(
            file.file_id,
            file.pick_code,
            file.name,
            dirId,
            rootDirId,
            file.sha1,
            file.size,
            file.suffix,
            generation
          )
        );

        await withD1ErrorHandling(() => env.DB.batch(batchStatements));
        await incrementWriteCount(env.KV_CONFIG, toUpsert.length);
      }

      imageFileIds.push(...incomingIds);
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
  generation: number
): Promise<void> {
  // Single DELETE: remove all images in this directory that weren't touched in this sync pass
  await withD1ErrorHandling(() =>
    db
      .prepare("DELETE FROM images WHERE root_dir_id = ?1 AND sync_generation < ?2")
      .bind(rootDirId, generation)
      .run()
  );
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
