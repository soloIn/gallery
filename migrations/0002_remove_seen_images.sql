-- Migration: Remove seen_images column from client_state
-- Strategy: Rebuild table (D1/SQLite compatibility)
-- Idempotent: safe to run multiple times

-- Step 1: Create new table without seen_images
CREATE TABLE IF NOT EXISTS client_state_new (
  client_id TEXT PRIMARY KEY,
  last_index INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Step 2: Copy data from old table (if exists)
INSERT OR IGNORE INTO client_state_new (client_id, last_index, version, updated_at)
SELECT client_id, last_index, version, updated_at FROM client_state
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='client_state');

-- Step 3: Drop old table
DROP TABLE IF EXISTS client_state;

-- Step 4: Rename new table
ALTER TABLE client_state_new RENAME TO client_state;
