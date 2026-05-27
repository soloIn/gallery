CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT UNIQUE NOT NULL,
  pick_code TEXT NOT NULL,
  name TEXT NOT NULL,
  dir_id TEXT NOT NULL,
  root_dir_id TEXT NOT NULL DEFAULT '',
  sha1 TEXT NOT NULL,
  size INTEGER NOT NULL,
  suffix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_images_dir_id ON images(dir_id);
CREATE INDEX IF NOT EXISTS idx_images_file_id ON images(file_id);

CREATE TABLE IF NOT EXISTS client_state (
  client_id TEXT PRIMARY KEY,
  last_index INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  include_subdirs INTEGER NOT NULL DEFAULT 0,
  last_synced TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
