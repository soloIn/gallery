import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { authMiddleware, createSession, deleteSession } from "../../src/middleware/auth";
import type { Env, ContextVars } from "../../src/utils/types";

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();

  app.get("/protected", authMiddleware, (c) => {
    return c.json({ message: "ok" });
  });

  return app;
}

describe("auth middleware", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    app = createTestApp();
    // Clear sessions
    const kv = (env as Env).KV_SESSION;
    const keys = await kv.list();
    for (const key of keys.keys) {
      await kv.delete(key.name);
    }
  });

  it("rejects unauthenticated request", async () => {
    const res = await app.request("/protected", undefined, env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Authentication required");
  });

  it("accepts valid session cookie", async () => {
    const token = await createSession(env as Env);
    const res = await app.request(
      "/protected",
      { headers: { Cookie: `session=${token}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("ok");
  });

  it("accepts valid Bearer token", async () => {
    const token = await createSession(env as Env);
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(200);
  });

  it("rejects expired session", async () => {
    // Create a session and immediately delete it (simulate expiry)
    const token = await createSession(env as Env);
    await deleteSession(env as Env, token);

    const res = await app.request(
      "/protected",
      { headers: { Cookie: `session=${token}` } },
      env
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid or expired");
  });
});
