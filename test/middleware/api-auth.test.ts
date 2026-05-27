import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { apiAuthMiddleware } from "../../src/middleware/api-auth";
import { updateConfig } from "../../src/config";
import { hashToken, timingSafeEqual } from "../../src/utils/crypto";
import type { Env, ContextVars } from "../../src/utils/types";

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();
  app.use("/api/*", apiAuthMiddleware);
  app.get("/api/test", (c) => c.json({ message: "ok" }));
  return app;
}

describe("apiAuthMiddleware", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    app = createTestApp();
    const e = env as Env;
    const keys = await e.KV_CONFIG.list();
    for (const key of keys.keys) {
      await e.KV_CONFIG.delete(key.name);
    }
  });

  it("rejects request with no Authorization header", async () => {
    const res = await app.request("/api/test", undefined, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing or invalid Authorization header");
  });

  it("rejects request with Basic auth", async () => {
    const res = await app.request(
      "/api/test",
      { headers: { Authorization: "Basic dXNlcjpwYXNz" } },
      env
    );
    expect(res.status).toBe(401);
  });

  it("rejects request with invalid token", async () => {
    const hash = await hashToken("valid_token");
    await updateConfig(env as Env, { api_tokens: [hash] });

    const res = await app.request(
      "/api/test",
      { headers: { Authorization: "Bearer wrong_token" } },
      env
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid API token");
  });

  it("accepts request with valid token", async () => {
    const hash = await hashToken("valid_token");
    await updateConfig(env as Env, { api_tokens: [hash] });

    const res = await app.request(
      "/api/test",
      { headers: { Authorization: "Bearer valid_token" } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("ok");
  });

  it("rejects when api_tokens is empty", async () => {
    await updateConfig(env as Env, { api_tokens: [] });

    const res = await app.request(
      "/api/test",
      { headers: { Authorization: "Bearer any_token" } },
      env
    );
    expect(res.status).toBe(401);
  });

  it("accepts when token matches one of multiple stored hashes", async () => {
    const hash1 = await hashToken("token_one");
    const hash2 = await hashToken("token_two");
    await updateConfig(env as Env, { api_tokens: [hash1, hash2] });

    const res = await app.request(
      "/api/test",
      { headers: { Authorization: "Bearer token_two" } },
      env
    );
    expect(res.status).toBe(200);
  });
});
