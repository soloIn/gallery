import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  getAuthorizeURL,
  createState,
  validateState,
  exchangeCode,
  ensureToken,
  refreshAccessToken,
  getStoredToken,
  clearToken,
} from "../../src/services/eleven5";
import type { Env, TokenStore } from "../../src/utils/types";

const kv = (env as Env).KV_TOKEN;

describe("eleven5 OAuth service", () => {
  beforeEach(async () => {
    // Clear KV
    const keys = await kv.list();
    for (const key of keys.keys) {
      await kv.delete(key.name);
    }
    // Seed config with 115 credentials
    const kvConfig = (env as Env).KV_CONFIG;
    await kvConfig.put("app:config", JSON.stringify({
      eleven5_client_id: "test_client_id",
      eleven5_client_secret: "test_client_secret",
    }));
    // Create oauth_states table
    const db = (env as Env).DB;
    await db.prepare("CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, created_at INTEGER NOT NULL)").run();
    await db.prepare("DELETE FROM oauth_states").run();
  });

  describe("getAuthorizeURL", () => {
    it("returns correct URL with all params", () => {
      const url = getAuthorizeURL("my_client_id", "https://example.com/callback", "my_state");
      expect(url).toContain("qrcodeapi.115.com/open/authorize");
      expect(url).toContain("client_id=my_client_id");
      expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcallback");
      expect(url).toContain("response_type=code");
      expect(url).toContain("state=my_state");
    });
  });

  describe("state management", () => {
    it("creates and validates state", async () => {
      const state = await createState(env as Env);
      expect(state).toHaveLength(64); // 32 bytes = 64 hex chars

      const valid = await validateState(env as Env, state);
      expect(valid).toBe(true);

      // Second validation should fail (consumed)
      const valid2 = await validateState(env as Env, state);
      expect(valid2).toBe(false);
    });

    it("rejects invalid state", async () => {
      const valid = await validateState(env as Env, "nonexistent");
      expect(valid).toBe(false);
    });
  });

  describe("token exchange", () => {
    it("stores tokens on successful exchange", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errno: 0,
            data: {
              access_token: "test_access",
              refresh_token: "test_refresh",
              expires_in: 7200,
            },
          }),
          { status: 200 }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      const token = await exchangeCode(env as Env, "test_code");
      expect(token.access_token).toBe("test_access");
      expect(token.refresh_token).toBe("test_refresh");
      expect(token.expires_at).toBeGreaterThan(Date.now());

      // Verify stored in KV
      const stored = await getStoredToken(env as Env);
      expect(stored).not.toBeNull();
      expect(stored!.access_token).toBe("test_access");

      vi.unstubAllGlobals();
    });

    it("throws on failed exchange", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ errno: 40140122, error: "exceeded app auth limit" }),
          { status: 200 }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      await expect(exchangeCode(env as Env, "bad_code")).rejects.toThrow(
        "Token exchange failed"
      );

      vi.unstubAllGlobals();
    });

    it("throws when credentials not configured", async () => {
      const kvConfig = (env as Env).KV_CONFIG;
      await kvConfig.put("app:config", JSON.stringify({}));

      await expect(exchangeCode(env as Env, "test_code")).rejects.toThrow(
        "115 client credentials not configured"
      );
    });
  });

  describe("ensureToken", () => {
    it("returns cached token when not expired", async () => {
      const tokenStore: TokenStore = {
        access_token: "cached_access",
        refresh_token: "cached_refresh",
        expires_at: Date.now() + 7200 * 1000,
      };
      await kv.put("oauth:token", JSON.stringify(tokenStore));

      const token = await ensureToken(env as Env);
      expect(token).toBe("cached_access");
    });

    it("refreshes token when expired", async () => {
      const expiredToken: TokenStore = {
        access_token: "old_access",
        refresh_token: "old_refresh",
        expires_at: Date.now() - 1000, // Already expired
      };
      await kv.put("oauth:token", JSON.stringify(expiredToken));

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errno: 0,
            data: {
              access_token: "new_access",
              refresh_token: "new_refresh",
              expires_in: 7200,
            },
          }),
          { status: 200 }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      const token = await ensureToken(env as Env);
      expect(token).toBe("new_access");

      vi.unstubAllGlobals();
    });

    it("throws when no token stored", async () => {
      await expect(ensureToken(env as Env)).rejects.toThrow("Not authenticated");
    });
  });

  describe("refreshAccessToken", () => {
    it("clears KV and throws on refresh failure", async () => {
      const tokenStore: TokenStore = {
        access_token: "expired",
        refresh_token: "expired_refresh",
        expires_at: Date.now() - 1000,
      };
      await kv.put("oauth:token", JSON.stringify(tokenStore));

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ errno: 40140123, error: "invalid refresh token" }),
          { status: 200 }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      await expect(refreshAccessToken(env as Env)).rejects.toThrow(
        "Token refresh failed"
      );

      // Verify KV cleared
      const stored = await getStoredToken(env as Env);
      expect(stored).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  describe("clearToken", () => {
    it("removes stored token", async () => {
      const tokenStore: TokenStore = {
        access_token: "test",
        refresh_token: "test",
        expires_at: Date.now() + 7200 * 1000,
      };
      await kv.put("oauth:token", JSON.stringify(tokenStore));

      await clearToken(env as Env);
      const stored = await getStoredToken(env as Env);
      expect(stored).toBeNull();
    });
  });
});
