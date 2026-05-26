import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { adminRoutes } from "../../src/routes/admin";
import { createSession } from "../../src/middleware/auth";
import { updateConfig } from "../../src/config";
import { hashPassword } from "../../src/utils/crypto";
import {
  upsertDirectory,
  getDirectories,
} from "../../src/db/queries";
import type { Env, ContextVars } from "../../src/utils/types";
import { Hono } from "hono";

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();
  app.route("/admin", adminRoutes);
  return app;
}

describe("admin routes", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    app = createTestApp();
    const e = env as Env;
    // Clear KV stores
    for (const kv of [e.KV_CONFIG, e.KV_SESSION]) {
      const keys = await kv.list();
      for (const key of keys.keys) {
        await kv.delete(key.name);
      }
    }
    // Create D1 tables if not exist
    await e.DB.prepare("CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT UNIQUE NOT NULL, pick_code TEXT NOT NULL, name TEXT NOT NULL, dir_id TEXT NOT NULL, sha1 TEXT NOT NULL, size INTEGER NOT NULL, suffix TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await e.DB.prepare("CREATE TABLE IF NOT EXISTS client_state (client_id TEXT PRIMARY KEY, last_index INTEGER NOT NULL DEFAULT 0, seen_images TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await e.DB.prepare("CREATE TABLE IF NOT EXISTS directories (id INTEGER PRIMARY KEY AUTOINCREMENT, dir_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', include_subdirs INTEGER NOT NULL DEFAULT 0, last_synced TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    // Clear D1 tables
    await e.DB.prepare("DELETE FROM directories").run();
    await e.DB.prepare("DELETE FROM images").run();
    await e.DB.prepare("DELETE FROM client_state").run();
    // Set up password hash
    const hash = await hashPassword("testpassword");
    await updateConfig(e, { password_hash: hash });
  });

  describe("POST /admin/login", () => {
    it("creates session on valid credentials", async () => {
      const res = await app.request(
        "/admin/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "testpassword" }),
        },
        env
      );
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toContain("session=");
      expect(setCookie).toContain("HttpOnly");
    });

    it("rejects wrong password", async () => {
      const res = await app.request(
        "/admin/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "wrong" }),
        },
        env
      );
      expect(res.status).toBe(401);
    });

    it("rejects non-admin username", async () => {
      const res = await app.request(
        "/admin/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "other", password: "testpassword" }),
        },
        env
      );
      expect(res.status).toBe(401);
    });

    it("rejects missing fields", async () => {
      const res = await app.request(
        "/admin/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        env
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /admin/logout", () => {
    it("clears session", async () => {
      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/logout",
        {
          method: "POST",
          headers: { Cookie: `session=${token}` },
        },
        env
      );
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toContain("Max-Age=0");
    });
  });

  describe("GET /admin/me", () => {
    it("returns 401 without session", async () => {
      const res = await app.request("/admin/me", undefined, env);
      expect(res.status).toBe(401);
    });

    it("returns 200 with valid session", async () => {
      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/me",
        { headers: { Cookie: `session=${token}` } },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean };
      expect(body.authenticated).toBe(true);
    });
  });

  describe("GET /admin/directories", () => {
    it("returns empty list when no directories", async () => {
      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/directories",
        { headers: { Cookie: `session=${token}` } },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it("returns configured directories", async () => {
      await upsertDirectory((env as Env).DB, {
        dir_id: "dir_001",
        name: "Photos",
        include_subdirs: 1,
      });

      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/directories",
        { headers: { Cookie: `session=${token}` } },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ dir_id: string }>;
      expect(body).toHaveLength(1);
      expect(body[0].dir_id).toBe("dir_001");
    });

    it("rejects unauthenticated request", async () => {
      const res = await app.request("/admin/directories", undefined, env);
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /admin/directories/:id", () => {
    it("removes directory and associated images", async () => {
      const db = (env as Env).DB;
      await upsertDirectory(db, {
        dir_id: "dir_to_delete",
        name: "Delete Me",
        include_subdirs: 0,
      });

      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/directories/dir_to_delete",
        { method: "DELETE", headers: { Cookie: `session=${token}` } },
        env
      );
      expect(res.status).toBe(200);

      const dirs = await getDirectories(db);
      expect(dirs).toHaveLength(0);
    });

    it("returns 404 for non-existent directory", async () => {
      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/directories/nonexistent",
        { method: "DELETE", headers: { Cookie: `session=${token}` } },
        env
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /admin/settings", () => {
    it("returns current settings", async () => {
      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/settings",
        { headers: { Cookie: `session=${token}` } },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sync_interval: string; rate_limit_rps: number };
      expect(body.sync_interval).toBe("0 */6 * * *");
      expect(body.rate_limit_rps).toBe(3);
    });
  });

  describe("PUT /admin/settings", () => {
    it("updates settings", async () => {
      const token = await createSession(env as Env);
      const res = await app.request(
        "/admin/settings",
        {
          method: "PUT",
          headers: {
            Cookie: `session=${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rate_limit_rps: 5 }),
        },
        env
      );
      expect(res.status).toBe(200);

      // Verify setting persisted
      const getRes = await app.request(
        "/admin/settings",
        { headers: { Cookie: `session=${token}` } },
        env
      );
      const body = (await getRes.json()) as { rate_limit_rps: number };
      expect(body.rate_limit_rps).toBe(5);
    });
  });
});
