import type { Env, ImageRecord, ClientState, DirectoryConfig } from "../utils/types";

// --- Images ---

export async function upsertImage(
  db: D1Database,
  image: Omit<ImageRecord, "id" | "created_at">
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO images (file_id, pick_code, name, dir_id, sha1, size, suffix)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(file_id) DO UPDATE SET
         pick_code = excluded.pick_code,
         name = excluded.name,
         dir_id = excluded.dir_id,
         sha1 = excluded.sha1,
         size = excluded.size,
         suffix = excluded.suffix`
    )
    .bind(
      image.file_id,
      image.pick_code,
      image.name,
      image.dir_id,
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

export async function getRandomUnseenImage(
  db: D1Database,
  seenIds: string[]
): Promise<ImageRecord | null> {
  if (seenIds.length === 0) {
    const result = await db
      .prepare("SELECT * FROM images ORDER BY RANDOM() LIMIT 1")
      .first<ImageRecord>();
    return result ?? null;
  }

  // Build NOT IN clause
  const placeholders = seenIds.map((_, i) => `?${i + 1}`).join(",");
  const result = await db
    .prepare(
      `SELECT * FROM images WHERE file_id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`
    )
    .bind(...seenIds)
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

  const result = await db
    .prepare("SELECT * FROM images ORDER BY id ASC LIMIT 1 OFFSET ?1")
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
    seen_images: "[]",
    updated_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO client_state (client_id, last_index, seen_images, updated_at)
       VALUES (?1, ?2, ?3, ?4)`
    )
    .bind(
      defaultState.client_id,
      defaultState.last_index,
      defaultState.seen_images,
      defaultState.updated_at
    )
    .run();

  return defaultState;
}

export async function setClientState(
  db: D1Database,
  clientId: string,
  state: Partial<Pick<ClientState, "last_index" | "seen_images">>
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO client_state (client_id, last_index, seen_images, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(client_id) DO UPDATE SET
         last_index = COALESCE(excluded.last_index, client_state.last_index),
         seen_images = COALESCE(excluded.seen_images, client_state.seen_images),
         updated_at = excluded.updated_at`
    )
    .bind(
      clientId,
      state.last_index ?? 0,
      state.seen_images ?? "[]",
      now
    )
    .run();
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
  await db
    .prepare("DELETE FROM images WHERE dir_id = ?1")
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
    .prepare("DELETE FROM images WHERE dir_id = ?1")
    .bind(dirId)
    .run();
}
