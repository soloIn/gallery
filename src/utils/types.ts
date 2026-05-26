// Environment bindings
export interface Env {
  KV_CONFIG: KVNamespace;
  KV_TOKEN: KVNamespace;
  KV_SESSION: KVNamespace;
  DB: D1Database;
  ASSETS?: Fetcher;
  ELEVEN5_CLIENT_ID: string;
  ELEVEN5_CLIENT_SECRET: string;
  ADMIN_PASS: string;
}

// 115 API response types
export interface Eleven5TokenResponse {
  errno: number;
  error?: string;
  data?: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

export interface Eleven5FileInfo {
  file_id: string;
  pick_code: string;
  sha1: string;
  name: string;
  size: number;
  parent_id: string;
  is_dir: number;
  category: number;
  suffix: string;
}

export interface Eleven5FilesResponse {
  errno: number;
  error?: string;
  data?: {
    count: number;
    offset: number;
    page_size: number;
    path: Array<{ name: string; cid: string }>;
    files: Eleven5FileInfo[];
  };
}

export interface Eleven5DownloadResponse {
  errno: number;
  error?: string;
  data?: {
    url: Array<{
      url: string;
    }>;
  };
}

// Stored token shape in KV_TOKEN
export interface TokenStore {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp ms
}

// Database image record
export interface ImageRecord {
  id: number;
  file_id: string;
  pick_code: string;
  name: string;
  dir_id: string;
  root_dir_id: string;
  sha1: string;
  size: number;
  suffix: string;
  created_at: string;
}

// Client state in D1
export interface ClientState {
  client_id: string;
  last_index: number;
  seen_images: string; // JSON array of file_ids
  version: number;
  updated_at: string;
}

// Gallery directory config
export interface DirectoryConfig {
  id: number;
  dir_id: string;
  name: string;
  include_subdirs: number; // 0 or 1
  last_synced: string | null;
  created_at: string;
}

// Admin config stored in KV_CONFIG
export interface AdminConfig {
  password_hash: string;
  sync_interval: string; // cron expression
  rate_limit_rps: number;
  circuit_breaker_threshold: number;
}

// Gallery API response shapes
export interface GalleryImageResponse {
  url: string;
  name: string;
  index?: number;
  total: number;
  remaining?: number;
  recycled?: boolean;
}

export interface GalleryMetaResponse {
  total: number;
  currentIndex: number;
  seenCount: number;
}

// Hono context variable extensions
export interface ContextVars {
  admin: boolean;
}
