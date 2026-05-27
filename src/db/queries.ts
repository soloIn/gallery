import type { Env, ImageRecord, ClientState, DirectoryConfig } from "../utils/types";

// --- Images ---

export async function upsertImage(
  db: D1Database,
  image: Omit<ImageRecord, "id" | "created_at">,
  syncGeneration?: number
): Promise<void> {
  await db
    .prepare(
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
    )
    .bind(
      image.file_id,
      image.pick_code,
      image.name,
      image.dir_id,
      image.root_dir_id ?? "",
      image.sha1,
      image.size,
      image.suffix,
      syncGeneration ?? 0
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


const BUCKET_COUNT = 20;
const MAX_RECENT_RANGES = 10;
const TEMP_MIN = 0.1;
const TEMP_MAX = 2.0;

export async function getRandomImage(
  db: D1Database,
  recentRangesJson: string,
  count?: number
): Promise<{ image: ImageRecord | null; newRecentRanges: string }> {
  const imageCount = count ?? await getImageCount(db);
  if (imageCount === 0) return { image: null, newRecentRanges: "[]" };

  // Get min/max id range
  const range = await db
    .prepare("SELECT MIN(id) as min_id, MAX(id) as max_id FROM images")
    .first<{ min_id: number; max_id: number }>();

  if (!range) return { image: null, newRecentRanges: "[]" };

  // Parse recent ranges (bucket indices recently visited)
  let recentBuckets: number[] = [];
  try {
    const parsed = JSON.parse(recentRangesJson);
    if (Array.isArray(parsed)) recentBuckets = parsed;
  } catch {
    // Invalid JSON — degrade to uniform random
  }

  // Divide id space into BUCKET_COUNT buckets
  const span = range.max_id - range.min_id + 1;
  const bucketSize = Math.ceil(span / BUCKET_COUNT);

  // Compute temperature per bucket: recently visited = low, unvisited = high
  const temperatures: number[] = [];
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const lastVisit = recentBuckets.lastIndexOf(i);
    if (lastVisit === -1) {
      temperatures.push(TEMP_MAX); // Never visited
    } else {
      // Closer to end of recent list = more recent = lower temperature
      const recency = recentBuckets.length - 1 - lastVisit;
      temperatures.push(Math.max(TEMP_MIN, TEMP_MAX - recency * 0.3));
    }
  }

  // Weighted random bucket selection
  const totalTemp = temperatures.reduce((a, b) => a + b, 0);
  let roll = Math.random() * totalTemp;
  let selectedBucket = BUCKET_COUNT - 1;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    roll -= temperatures[i];
    if (roll <= 0) { selectedBucket = i; break; }
  }

  // Uniform random within the selected bucket
  const bucketMin = range.min_id + selectedBucket * bucketSize;
  const bucketMax = Math.min(range.min_id + (selectedBucket + 1) * bucketSize - 1, range.max_id);
  const randomId = bucketMin + Math.floor(Math.random() * (bucketMax - bucketMin + 1));

  // Find image at or after randomId, wrap around if needed
  let image = await db
    .prepare("SELECT * FROM images WHERE id >= ?1 ORDER BY id ASC LIMIT 1")
    .bind(randomId)
    .first<ImageRecord>();

  if (!image) {
    image = await db
      .prepare("SELECT * FROM images ORDER BY id ASC LIMIT 1")
      .first<ImageRecord>();
  }

  if (!image) return { image: null, newRecentRanges: recentRangesJson };

  // Update recent ranges: append selected bucket, FIFO if over limit
  const newBuckets = [...recentBuckets, selectedBucket];
  if (newBuckets.length > MAX_RECENT_RANGES) newBuckets.shift();

  return { image, newRecentRanges: JSON.stringify(newBuckets) };
}

export async function getNextImage(
  db: D1Database,
  lastId: number
): Promise<{ image: ImageRecord | null; nextId: number }> {
  // Keyset cursor: WHERE id > lastId. O(log n) on primary key.
  let result = await db
    .prepare("SELECT * FROM images WHERE id > ?1 ORDER BY id ASC LIMIT 1")
    .bind(lastId)
    .first<ImageRecord>();

  // Wrap around: if no image after lastId, go back to the first
  if (!result && lastId > 0) {
    result = await db
      .prepare("SELECT * FROM images ORDER BY id ASC LIMIT 1")
      .first<ImageRecord>();
  }

  return { image: result ?? null, nextId: result?.id ?? 0 };
}

export async function getImageIndexById(
  db: D1Database,
  id: number
): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM images WHERE id <= ?1")
    .bind(id)
    .first<{ count: number }>();
  return (result?.count ?? 1) - 1; // 0-based index
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
    last_id: 0,
    recent_ranges: "[]",
    version: 0,
    updated_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO client_state (client_id, last_index, last_id, recent_ranges, version, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      defaultState.client_id,
      defaultState.last_index,
      defaultState.last_id,
      defaultState.recent_ranges,
      defaultState.version,
      defaultState.updated_at
    )
    .run();

  return defaultState;
}

export async function setClientState(
  db: D1Database,
  clientId: string,
  state: Partial<Pick<ClientState, "last_index" | "last_id" | "recent_ranges">>
): Promise<void> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Read existing state to merge with partial update
    const existing = await db
      .prepare("SELECT last_index, last_id, recent_ranges, version FROM client_state WHERE client_id = ?1")
      .bind(clientId)
      .first<{ last_index: number; last_id: number; recent_ranges: string; version: number }>();

    const lastIndex = state.last_index ?? existing?.last_index ?? 0;
    const lastId = state.last_id ?? existing?.last_id ?? 0;
    const recentRanges = state.recent_ranges ?? existing?.recent_ranges ?? "[]";
    const currentVersion = existing?.version ?? 0;
    const newVersion = currentVersion + 1;
    const now = new Date().toISOString();

    if (existing) {
      // Update with version check for optimistic concurrency
      const result = await db
        .prepare(
          `UPDATE client_state
           SET last_index = ?1, last_id = ?2, recent_ranges = ?3, version = ?4, updated_at = ?5
           WHERE client_id = ?6 AND version = ?7`
        )
        .bind(lastIndex, lastId, recentRanges, newVersion, now, clientId, currentVersion)
        .run();
      if (result.meta.changes > 0) return; // Success
      // Concurrent modification — retry
    } else {
      // Insert new row
      await db
        .prepare(
          `INSERT INTO client_state (client_id, last_index, last_id, recent_ranges, version, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(clientId, lastIndex, lastId, recentRanges, newVersion, now)
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
