import type { Env, Eleven5FileInfo } from "../utils/types";
import {
  getDirectories,
  upsertImage,
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
  let totalSynced = 0;

  await syncDirectoryRecursive(env, dirId, includeSubdirs, seen, (images) => {
    totalSynced += images;
  });

  await updateDirectorySyncTime(env.DB, dirId);
  return totalSynced;
}

async function syncDirectoryRecursive(
  env: Env,
  dirId: string,
  includeSubdirs: boolean,
  seen: Set<string>,
  onBatch: (count: number) => void
): Promise<void> {
  if (seen.has(dirId)) return;
  seen.add(dirId);

  let offset = 0;

  while (true) {
    const response = await listDirectory(env, dirId, offset, PAGE_SIZE);

    if (response.errno !== 0) {
      console.error(`Failed to list directory ${dirId}: errno ${response.errno}`);
      break;
    }

    const files = response.data?.files ?? [];

    for (const file of files) {
      if (file.is_dir === 1) {
        // Subdirectory
        if (includeSubdirs) {
          await syncDirectoryRecursive(env, file.file_id, true, seen, onBatch);
        }
      } else {
        // Image file
        await upsertImage(env.DB, {
          file_id: file.file_id,
          pick_code: file.pick_code,
          name: file.name,
          dir_id: dirId,
          sha1: file.sha1,
          size: file.size,
          suffix: file.suffix,
        });
      }
    }

    onBatch(files.filter((f) => f.is_dir !== 1).length);

    // Check if we've fetched all pages
    if (files.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
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
