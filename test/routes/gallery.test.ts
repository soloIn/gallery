import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { galleryRoutes } from "../../src/routes/gallery";
import { upsertImage, setClientState } from "../../src/db/queries";
import type { Env, ContextVars } from "../../src/utils/types";
import { Hono } from "hono";

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();
  app.route("/api", galleryRoutes);
  return app;
}

describe("gallery routes", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    app = createTestApp();
    const db = (env as Env).DB;
    // Create tables
    await db.prepare("CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT UNIQUE NOT NULL, pick_code TEXT NOT NULL, name TEXT NOT NULL, dir_id TEXT NOT NULL, root_dir_id TEXT NOT NULL DEFAULT '', sha1 TEXT NOT NULL, size INTEGER NOT NULL, suffix TEXT NOT NULL, sync_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS client_state (client_id TEXT PRIMARY KEY, last_index INTEGER NOT NULL DEFAULT 0, last_id INTEGER NOT NULL DEFAULT 0, recent_ranges TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    // Clean
    await db.prepare("DELETE FROM images").run();
    await db.prepare("DELETE FROM client_state").run();

    // Mock getDownloadURL
    vi.mock("../../src/services/eleven5", () => ({
      getDownloadURL: vi.fn().mockResolvedValue("https://example.com/image.jpg"),
    }));
  });

  describe("GET /api/image/next", () => {
    it("returns 400 without client parameter", async () => {
      const res = await app.request("/api/image/next", undefined, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("client");
    });

    it("returns 404 when no images", async () => {
      const res = await app.request("/api/image/next?client=test", undefined, env);
      expect(res.status).toBe(404);
    });

    it("returns first image for new client", async () => {
      const db = (env as Env).DB;
      await upsertImage(db, {
        file_id: "f1",
        pick_code: "p1",
        name: "test.jpg",
        dir_id: "d1",
        sha1: "abc",
        size: 100,
        suffix: "jpg",
        root_dir_id: "d1",
      });

      const res = await app.request("/api/image/next?client=test", undefined, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; name: string; index: number; total: number };
      expect(body.url).toBe("https://example.com/image.jpg");
      expect(body.name).toBe("test.jpg");
      expect(body.index).toBe(0);
      expect(body.total).toBe(1);
    });

    it("increments index across calls", async () => {
      const db = (env as Env).DB;
      await upsertImage(db, {
        file_id: "f1",
        pick_code: "p1",
        name: "img1.jpg",
        dir_id: "d1",
        sha1: "a",
        size: 100,
        suffix: "jpg",
        root_dir_id: "d1",
      });
      await upsertImage(db, {
        file_id: "f2",
        pick_code: "p2",
        name: "img2.jpg",
        dir_id: "d1",
        sha1: "b",
        size: 200,
        suffix: "jpg",
        root_dir_id: "d1",
      });

      const res1 = await app.request("/api/image/next?client=test", undefined, env);
      const body1 = (await res1.json()) as { name: string };
      expect(body1.name).toBe("img1.jpg");

      const res2 = await app.request("/api/image/next?client=test", undefined, env);
      const body2 = (await res2.json()) as { name: string };
      expect(body2.name).toBe("img2.jpg");
    });
  });

  describe("GET /api/image/random", () => {
    it("returns 400 without client parameter", async () => {
      const res = await app.request("/api/image/random", undefined, env);
      expect(res.status).toBe(400);
    });

    it("returns 404 when no images", async () => {
      const res = await app.request("/api/image/random?client=test", undefined, env);
      expect(res.status).toBe(404);
    });

    it("returns an image for valid request", async () => {
      const db = (env as Env).DB;
      await upsertImage(db, {
        file_id: "f1",
        pick_code: "p1",
        name: "random.jpg",
        dir_id: "d1",
        sha1: "abc",
        size: 100,
        suffix: "jpg",
        root_dir_id: "d1",
      });

      const res = await app.request("/api/image/random?client=test", undefined, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; name: string; index: number; total: number };
      expect(body.url).toBe("https://example.com/image.jpg");
      expect(body.name).toBe("random.jpg");
      expect(body.index).toBe(0);
      expect(body.total).toBe(1);
    });

    it("maintains independent state per client", async () => {
      const db = (env as Env).DB;
      await upsertImage(db, {
        file_id: "f1",
        pick_code: "p1",
        name: "shared.jpg",
        dir_id: "d1",
        sha1: "abc",
        size: 100,
        suffix: "jpg",
        root_dir_id: "d1",
      });

      // Client A gets the image
      const resA = await app.request("/api/image/random?client=clientA", undefined, env);
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as { name: string; index: number };
      expect(bodyA.name).toBe("shared.jpg");

      // Client B should also get the image (independent state)
      const resB = await app.request("/api/image/random?client=clientB", undefined, env);
      expect(resB.status).toBe(200);
      const bodyB = (await resB.json()) as { name: string; index: number };
      expect(bodyB.name).toBe("shared.jpg");
    });
  });

  describe("GET /api/image/meta", () => {
    it("returns 400 without client parameter", async () => {
      const res = await app.request("/api/image/meta", undefined, env);
      expect(res.status).toBe(400);
    });

    it("returns correct metadata", async () => {
      const db = (env as Env).DB;
      await upsertImage(db, {
        file_id: "f1",
        pick_code: "p1",
        name: "test.jpg",
        dir_id: "d1",
        sha1: "abc",
        size: 100,
        suffix: "jpg",
        root_dir_id: "d1",
      });
      await upsertImage(db, {
        file_id: "f2",
        pick_code: "p2",
        name: "test2.jpg",
        dir_id: "d1",
        sha1: "def",
        size: 200,
        suffix: "jpg",
        root_dir_id: "d1",
      });

      const res = await app.request("/api/image/meta?client=test", undefined, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number; currentIndex: number; seenCount: number };
      expect(body.total).toBe(2);
      expect(body.currentIndex).toBe(0);
      expect(body.seenCount).toBe(0);
    });
  });
});
