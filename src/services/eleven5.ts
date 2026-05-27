import type {
  Env,
  TokenStore,
  Eleven5TokenResponse,
  Eleven5FilesResponse,
  Eleven5DownloadResponse,
} from "../utils/types";
import { getConfig } from "../config";
import { generateRandomString } from "../utils/crypto";

const OAUTH_AUTHORIZE_URL = "https://qrcodeapi.115.com/open/authorize";
const TOKEN_URL = "https://qrcodeapi.115.com/open/authCodeToToken";
const REFRESH_URL = "https://qrcodeapi.115.com/open/refreshToken";
const API_BASE = "https://proapi.115.com";

const TOKEN_KEY = "oauth:token";

// Token refresh threshold: 5 minutes before expiry
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// --- OAuth Flow ---

export function getAuthorizeURL(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params}`;
}

export async function createState(env: Env): Promise<string> {
  const state = generateRandomString(32);
  // Store in D1 for atomic delete-then-read (prevents replay)
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_states (state, created_at) VALUES (?1, ?2)"
  ).bind(state, Date.now()).run();
  return state;
}

export async function validateState(
  env: Env,
  state: string
): Promise<boolean> {
  // Atomic delete — if the row existed, the state is valid and consumed
  const result = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state = ?1"
  ).bind(state).run();
  return result.meta.changes > 0;
}

export async function exchangeCode(
  env: Env,
  code: string
): Promise<TokenStore> {
  const config = await getConfig(env);
  if (!config.eleven5_client_id || !config.eleven5_client_secret) {
    throw new Error("115 client credentials not configured");
  }
  const body = new URLSearchParams({
    client_id: config.eleven5_client_id,
    client_secret: config.eleven5_client_secret,
    code,
    grant_type: "authorization_code",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token exchange HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as Eleven5TokenResponse;

  if (data.errno !== 0 || !data.data) {
    throw new Error(`Token exchange failed: ${data.error ?? "unknown error"}`);
  }

  const tokenStore: TokenStore = {
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token,
    expires_at: Date.now() + data.data.expires_in * 1000,
  };

  await env.KV_TOKEN.put(TOKEN_KEY, JSON.stringify(tokenStore));
  return tokenStore;
}

export async function refreshAccessToken(env: Env): Promise<TokenStore> {
  const stored = await getStoredToken(env);
  if (!stored) throw new Error("No refresh token available");

  const config = await getConfig(env);
  if (!config.eleven5_client_id || !config.eleven5_client_secret) {
    throw new Error("115 client credentials not configured");
  }
  const body = new URLSearchParams({
    client_id: config.eleven5_client_id,
    client_secret: config.eleven5_client_secret,
    refresh_token: stored.refresh_token,
    grant_type: "refresh_token",
  });

  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token refresh HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as Eleven5TokenResponse;

  if (data.errno !== 0 || !data.data) {
    // Only delete if the stored token is still the one we tried to refresh
    // (a concurrent request may have already refreshed it successfully)
    const current = await getStoredToken(env);
    if (!current || current.refresh_token === stored.refresh_token) {
      await env.KV_TOKEN.delete(TOKEN_KEY);
    }
    throw new Error(`Token refresh failed: ${data.error ?? "unknown error"}`);
  }

  const tokenStore: TokenStore = {
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token,
    expires_at: Date.now() + data.data.expires_in * 1000,
  };

  await env.KV_TOKEN.put(TOKEN_KEY, JSON.stringify(tokenStore));
  return tokenStore;
}

export async function ensureToken(env: Env): Promise<string> {
  const stored = await getStoredToken(env);
  if (!stored) throw new Error("Not authenticated with 115");

  // Refresh if within 5 minutes of expiry
  if (Date.now() > stored.expires_at - REFRESH_THRESHOLD_MS) {
    // Re-read token before refreshing — another request may have already refreshed it
    const reRead = await getStoredToken(env);
    if (reRead && reRead.expires_at > stored.expires_at) {
      // Token was refreshed by a concurrent request (expires_at advanced); use the new one
      if (Date.now() <= reRead.expires_at - REFRESH_THRESHOLD_MS) {
        return reRead.access_token;
      }
      // New token is also near expiry — fall through to refresh with the newer token
      return (await refreshAccessToken(env)).access_token;
    }

    const refreshed = await refreshAccessToken(env);
    return refreshed.access_token;
  }

  return stored.access_token;
}

export async function getStoredToken(
  env: Env
): Promise<TokenStore | null> {
  const raw = await env.KV_TOKEN.get(TOKEN_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as TokenStore;
}

export async function clearToken(env: Env): Promise<void> {
  await env.KV_TOKEN.delete(TOKEN_KEY);
}

// --- API Client ---

export async function apiRequest<T>(
  env: Env,
  method: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  let accessToken = await ensureToken(env);

  const url = new URL(path, API_BASE);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  let response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "GalleryWorker/1.0",
    },
  });

  // Auto-retry once on 401 (token may have expired between check and request)
  if (response.status === 401) {
    accessToken = (await refreshAccessToken(env)).access_token;
    response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "GalleryWorker/1.0",
      },
    });
  }

  if (!response.ok) {
    throw new Error(`115 API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

// --- Convenience wrappers with caching ---

export async function listDirectory(
  env: Env,
  cid: string,
  offset: number = 0,
  limit: number = 32
): Promise<Eleven5FilesResponse> {
  const { cacheFetch } = await import("./cache");
  const { rateLimitedFetch } = await import("../middleware/ratelimit");

  const cacheKey = `fs_files:${cid}:${offset}:${limit}`;

  return cacheFetch(env.KV_CONFIG, cacheKey, () =>
    rateLimitedFetch(env, "115:api", () =>
      apiRequest<Eleven5FilesResponse>(env, "GET", "/open/ufile/files", {
        cid,
        offset: String(offset),
        limit: String(limit),
        type: "2",
        asc: "1",
        o: "user_utime",
      })
    ),
    300 // 5 min cache
  );
}

export async function getDownloadURL(
  env: Env,
  pickCode: string
): Promise<string> {
  const { rateLimitedFetch } = await import("../middleware/ratelimit");

  const data = await rateLimitedFetch(env, "115:api", () =>
    apiRequest<Eleven5DownloadResponse>(
      env,
      "POST",
      "/open/ufile/downurl",
      { pick_code: pickCode }
    )
  );

  if (!data.data?.url?.[0]?.url) {
    throw new Error("No download URL returned");
  }

  return data.data.url[0].url;
}

export async function browseDirectory(
  env: Env,
  cid: string
): Promise<Array<{ cid: string; name: string }>> {
  const { rateLimitedFetch } = await import("../middleware/ratelimit");

  const data = await rateLimitedFetch(env, "115:api", () =>
    apiRequest<Eleven5FilesResponse>(env, "GET", "/open/ufile/files", {
      cid,
      offset: "0",
      limit: "100",
      show_dir: "1",
    })
  );

  // Extract subdirectories from path and files
  const subdirs: Array<{ cid: string; name: string }> = [];
  if (data.data?.files) {
    for (const file of data.data.files) {
      if (file.is_dir === 1) {
        subdirs.push({ cid: file.file_id, name: file.name });
      }
    }
  }
  return subdirs;
}
