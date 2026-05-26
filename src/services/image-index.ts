import type { Env, Eleven5FileInfo } from "../utils/types";
import {
  getDirectories,
  updateDirectorySyncTime,
  deleteImagesByDir,
} from "../db/queries";
import { listDirectory } from "./eleven5";

const PAGE_SIZE = 32;

export async function syncDirectory(
  env: Env,
  dirId: string,
  includeSubdirs: boolean
): Promise<number> {
  const seen = new Set<string>();
  const allFileIds: string[] = [];
  let totalSynced = 0;

  await syncDirectoryRecursive(env, dirId, dirId, includeSubdirs, seen, (images, fileIds) => {
    totalSynced += images;
    allFileIds.push(...fileIds);
  });

  // Remove stale images that no longer exist in 115
  await cleanupStaleImages(env.DB, dirId, allFileIds);

  await updateDirectorySyncTime(env.DB, dirId);
  return totalSynced;
}

async function syncDirectoryRecursive(
  env: Env,
  dirId: string,
  rootDirId: string,
  includeSubdirs: boolean,
  seen: Set<string>,
  onBatch: (count: number, fileIds: string[]) => void
): Promise<void> {
  if (seen.has(dirId)) return;
  seen.add(dirId);

  let offset = 0;
  const batchStatements: D1PreparedStatement[] = [];

  while (true) {
    const response = await listDirectory(env, dirId, offset, PAGE_SIZE);

    if (response.errno !== 0) {
      console.error(`Failed to list directory ${dirId}: errno ${response.errno}`);
      break;
    }

    const files = response.data?.files ?? [];
    const imageFileIds: string[] = [];

    for (const file of files) {
      if (file.is_dir === 1) {
        // Subdirectory
        if (includeSubdirs) {
          await syncDirectoryRecursive(env, file.file_id, rootDirId, true, seen, onBatch);
        }
      } else {
        // Image file — queue for batch upsert
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

    // Execute batch upsert (D1 batch sends all statements in one round trip)
    if (batchStatements.length > 0) {
      await env.DB.batch(batchStatements);
      batchStatements.length = 0;
    }

    onBatch(imageFileIds.length, imageFileIds);

    // Check if we've fetched all pages
    if (files.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

async function cleanupStaleImages(
  db: D1Database,
  rootDirId: string,
  currentFileIds: string[]
): Promise<void> {
  if (currentFileIds.length === 0) {
    // No images found — delete all for this directory
    await deleteImagesByDir(db, rootDirId);
    return;
  }

  // Delete images that were previously synced for this root_dir_id
  // but are no longer present in the 115 directory
  const placeholders = currentFileIds.map((_, i) => `?${i + 2}`).join(",");
  await db
    .prepare(
      `DELETE FROM images WHERE root_dir_id = ?1 AND file_id NOT IN (${placeholders})`
    )
    .bind(rootDirId, ...currentFileIds)
    .run();
}

export async function syncAll(env: Env): Promise<void> {
  const directories = await getDirectories(env.DB);

  for (const dir of directories) {
    try {
      const count = await syncDirectory(
        env,
        dir.dir_id,
        dir.include_subdirs === 1
      );
      console.log(`Synced directory ${dir.dir_id}: ${count} images`);
    } catch (err) {
      console.error(`Failed to sync directory ${dir.dir_id}:`, err);
    }
  }
}
