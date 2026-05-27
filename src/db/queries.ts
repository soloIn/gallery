import type { Env, ImageRecord, ClientState, DirectoryConfig } from "../utils/types";

// --- Images ---

export async function upsertImage(
  db: D1Database,
  image: Omit<ImageRecord, "id" | "created_at">
): Promise<void> {
  await db
    .prepare(
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
    )
    .bind(
      image.file_id,
      image.pick_code,
      image.name,
      image.dir_id,
      image.root_dir_id ?? "",
      image.sha1,
      image.size,
      image.suffix
    )
    .run();
}

export async function getImagesByDir(
  db: D1Database,
  dirId: string
): Promise<ImageRecord[]> {
  const result = await db
    .prepare("SELECT * FROM images WHERE dir_id = ?1 ORDER BY id ASC")
    .bind(dirId)
    .all<ImageRecord>();
  return result.results;
}

export async function getImageCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM images")
    .first<{ count: number }>();
  return result?.count ?? 0;
}


export async function getRandomImage(
  db: D1Database,
  index: number
): Promise<ImageRecord | null> {
  const count = await getImageCount(db);
  if (count === 0) return null;

  const normalizedIndex = index % count;
  const result = await db
    .prepare(
      `SELECT * FROM images WHERE id >= (SELECT id FROM images ORDER BY id ASC LIMIT 1 OFFSET ?1) ORDER BY id ASC LIMIT 1`
    )
    .bind(normalizedIndex)
    .first<ImageRecord>();
  return result ?? null;
}

export async function getNextImage(
  db: D1Database,
  lastIndex: number
): Promise<{ image: ImageRecord | null; nextIndex: number }> {
  const count = await getImageCount(db);
  if (count === 0) return { image: null, nextIndex: 0 };

  const normalizedIndex = lastIndex % count;

  // Use cursor-based pagination for better performance at scale.
  // Find the Nth image by id ordering using a subquery.
  const result = await db
    .prepare(
      `SELECT * FROM images WHERE id >= (SELECT id FROM images ORDER BY id ASC LIMIT 1 OFFSET ?1) ORDER BY id ASC LIMIT 1`
    )
    .bind(normalizedIndex)
    .first<ImageRecord>();

  const nextIndex = (normalizedIndex + 1) % count;
  return { image: result ?? null, nextIndex };
}

// --- Client State ---

export async function getClientState(
  db: D1Database,
  clientId: string
): Promise<ClientState> {
  const result = await db
    .prepare("SELECT * FROM client_state WHERE client_id = ?1")
    .bind(clientId)
    .first<ClientState>();

  if (result) return result;

  // Create default state
  const defaultState: ClientState = {
    client_id: clientId,
    last_index: 0,
    version: 0,
    updated_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO client_state (client_id, last_index, version, updated_at)
       VALUES (?1, ?2, ?3, ?4)`
    )
    .bind(
      defaultState.client_id,
      defaultState.last_index,
      defaultState.version,
      defaultState.updated_at
    )
    .run();

  return defaultState;
}

export async function setClientState(
  db: D1Database,
  clientId: string,
  state: Partial<Pick<ClientState, "last_index">>
): Promise<void> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Read existing state to merge with partial update
    const existing = await db
      .prepare("SELECT last_index, version FROM client_state WHERE client_id = ?1")
      .bind(clientId)
      .first<{ last_index: number; version: number }>();

    const lastIndex = state.last_index ?? existing?.last_index ?? 0;
    const currentVersion = existing?.version ?? 0;
    const newVersion = currentVersion + 1;
    const now = new Date().toISOString();

    if (existing) {
      // Update with version check for optimistic concurrency
      const result = await db
        .prepare(
          `UPDATE client_state
           SET last_index = ?1, version = ?2, updated_at = ?3
           WHERE client_id = ?4 AND version = ?5`
        )
        .bind(lastIndex, newVersion, now, clientId, currentVersion)
        .run();
      if (result.meta.changes > 0) return; // Success
      // Concurrent modification — retry
    } else {
      // Insert new row
      await db
        .prepare(
          `INSERT INTO client_state (client_id, last_index, version, updated_at)
           VALUES (?1, ?2, ?3, ?4)`
        )
        .bind(clientId, lastIndex, newVersion, now)
        .run();
      return;
    }
  }
  // If all retries exhausted, fall through (best-effort)
}

// --- Directories ---

export async function upsertDirectory(
  db: D1Database,
  dir: Omit<DirectoryConfig, "id" | "created_at" | "last_synced">
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO directories (dir_id, name, include_subdirs)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(dir_id) DO UPDATE SET
         name = excluded.name,
         include_subdirs = excluded.include_subdirs`
    )
    .bind(dir.dir_id, dir.name, dir.include_subdirs)
    .run();
}

export async function getDirectories(
  db: D1Database
): Promise<DirectoryConfig[]> {
  const result = await db
    .prepare("SELECT * FROM directories ORDER BY id ASC")
    .all<DirectoryConfig>();
  return result.results;
}

export async function getDirectory(
  db: D1Database,
  dirId: string
): Promise<DirectoryConfig | null> {
  const result = await db
    .prepare("SELECT * FROM directories WHERE dir_id = ?1")
    .bind(dirId)
    .first<DirectoryConfig>();
  return result ?? null;
}

export async function deleteDirectory(
  db: D1Database,
  dirId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM directories WHERE dir_id = ?1")
    .bind(dirId)
    .run();
  // Delete images from this directory AND all nested subdirectories
  // using root_dir_id which tracks the top-level configured directory
  await db
    .prepare("DELETE FROM images WHERE root_dir_id = ?1 OR dir_id = ?1")
    .bind(dirId)
    .run();
}

export async function updateDirectorySyncTime(
  db: D1Database,
  dirId: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE directories SET last_synced = ?1 WHERE dir_id = ?2")
    .bind(now, dirId)
    .run();
}

export async function deleteImagesByDir(
  db: D1Database,
  dirId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM images WHERE root_dir_id = ?1")
    .bind(dirId)
    .run();
}
