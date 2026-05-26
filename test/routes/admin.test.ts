import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { adminRoutes } from "../../src/routes/admin";
import { createSession } from "../../src/middleware/auth";
import { updateConfig } from "../../src/config";
import { hashPassword } from "../../src/utils/crypto";
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
});
