-- Migration: Add keyset cursor (last_id), weighted random (recent_ranges),
-- and sync generation counter (sync_generation)
-- Strategy: Rebuild table (D1/SQLite compatibility, consistent with 0002)
-- Idempotent: safe to run multiple times

-- ===== client_state: add last_id and recent_ranges =====

CREATE TABLE IF NOT EXISTS client_state_new (
  client_id TEXT PRIMARY KEY,
  last_index INTEGER NOT NULL DEFAULT 0,
  last_id INTEGER NOT NULL DEFAULT 0,
  recent_ranges TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Copy data with backfill: compute last_id from last_index
INSERT OR IGNORE INTO client_state_new (client_id, last_index, last_id, recent_ranges, version, updated_at)
SELECT
  cs.client_id,
  cs.last_index,
  COALESCE(
    (SELECT i.id FROM images i ORDER BY i.id ASC LIMIT 1 OFFSET cs.last_index),
    0
  ) AS last_id,
  '[]' AS recent_ranges,
  cs.version,
  cs.updated_at
FROM client_state cs
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='client_state');

DROP TABLE IF EXISTS client_state;
ALTER TABLE client_state_new RENAME TO client_state;

-- ===== images: add sync_generation =====

CREATE TABLE IF NOT EXISTS images_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT UNIQUE NOT NULL,
  pick_code TEXT NOT NULL,
  name TEXT NOT NULL,
  dir_id TEXT NOT NULL,
  root_dir_id TEXT NOT NULL DEFAULT '',
  sha1 TEXT NOT NULL,
  size INTEGER NOT NULL,
  suffix TEXT NOT NULL,
  sync_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO images_new (id, file_id, pick_code, name, dir_id, root_dir_id, sha1, size, suffix, sync_generation, created_at)
SELECT id, file_id, pick_code, name, dir_id, root_dir_id, sha1, size, suffix, 1, created_at
FROM images
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='images');

DROP TABLE IF EXISTS images;
ALTER TABLE images_new RENAME TO images;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_images_dir_id ON images(dir_id);
CREATE INDEX IF NOT EXISTS idx_images_file_id ON images(file_id);
