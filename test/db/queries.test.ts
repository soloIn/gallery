import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  upsertImage,
  getImagesByDir,
  getImageCount,
  getRandomImage,
  getNextImage,
  getImageIndexById,
  getClientState,
  setClientState,
  upsertDirectory,
  getDirectories,
  deleteDirectory,
} from "../../src/db/queries";
import type { Env } from "../../src/utils/types";

const db = (env as Env).DB;

describe("queries", () => {
  beforeEach(async () => {
    await db.prepare("CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT UNIQUE NOT NULL, pick_code TEXT NOT NULL, name TEXT NOT NULL, dir_id TEXT NOT NULL, root_dir_id TEXT NOT NULL DEFAULT '', sha1 TEXT NOT NULL, size INTEGER NOT NULL, suffix TEXT NOT NULL, sync_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS client_state (client_id TEXT PRIMARY KEY, last_index INTEGER NOT NULL DEFAULT 0, last_id INTEGER NOT NULL DEFAULT 0, recent_ranges TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS directories (id INTEGER PRIMARY KEY AUTOINCREMENT, dir_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', include_subdirs INTEGER NOT NULL DEFAULT 0, last_synced TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await db.prepare("DELETE FROM images").run();
    await db.prepare("DELETE FROM client_state").run();
    await db.prepare("DELETE FROM directories").run();
  });

  const testImage = {
    file_id: "file_001",
    pick_code: "pick_001",
    name: "test.jpg",
    dir_id: "dir_001",
    root_dir_id: "dir_001",
    sha1: "abc123",
    size: 1024,
    suffix: "jpg",
  };

  describe("images", () => {
    it("upsert and retrieve by dir_id", async () => {
      await upsertImage(db, testImage);
      const images = await getImagesByDir(db, "dir_001");
      expect(images).toHaveLength(1);
      expect(images[0].file_id).toBe("file_001");
      expect(images[0].name).toBe("test.jpg");
    });

    it("upsert with duplicate file_id updates existing row", async () => {
      await upsertImage(db, testImage);
      await upsertImage(db, { ...testImage, name: "updated.jpg" });
      const images = await getImagesByDir(db, "dir_001");
      expect(images).toHaveLength(1);
      expect(images[0].name).toBe("updated.jpg");
    });

    it("getImageCount returns correct count", async () => {
      expect(await getImageCount(db)).toBe(0);
      await upsertImage(db, testImage);
      await upsertImage(db, { ...testImage, file_id: "file_002" });
      expect(await getImageCount(db)).toBe(2);
    });

    it("empty directory returns empty array", async () => {
      const images = await getImagesByDir(db, "nonexistent");
      expect(images).toHaveLength(0);
    });
  });

  describe("getRandomImage", () => {
    it("returns a random image", async () => {
      await upsertImage(db, testImage);
      await upsertImage(db, { ...testImage, file_id: "file_002" });
      const { image } = await getRandomImage(db, "[]");
      expect(image).not.toBeNull();
    });

    it("returns null for empty table", async () => {
      const { image } = await getRandomImage(db, "[]");
      expect(image).toBeNull();
    });

    it("returns updated recent ranges", async () => {
      await upsertImage(db, testImage);
      const { image, newRecentRanges } = await getRandomImage(db, "[]");
      expect(image).not.toBeNull();
      const ranges = JSON.parse(newRecentRanges);
      expect(ranges).toHaveLength(1);
      expect(typeof ranges[0]).toBe("number");
    });

    it("degrades to uniform random on invalid JSON", async () => {
      await upsertImage(db, testImage);
      const { image } = await getRandomImage(db, "not-json");
      expect(image).not.toBeNull();
    });

    it("caps recent ranges at 10 entries", async () => {
      await upsertImage(db, testImage);
      const existing = JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const { newRecentRanges } = await getRandomImage(db, existing);
      const ranges = JSON.parse(newRecentRanges);
      expect(ranges.length).toBeLessThanOrEqual(10);
    });
  });

  describe("getNextImage", () => {
    it("returns first image when lastId is 0", async () => {
      await upsertImage(db, testImage);
      await upsertImage(db, { ...testImage, file_id: "file_002" });
      const result = await getNextImage(db, 0);
      expect(result.image).not.toBeNull();
      expect(result.image!.file_id).toBe("file_001");
      expect(result.nextId).toBe(result.image!.id);
    });

    it("advances to next image by id", async () => {
      await upsertImage(db, testImage);
      await upsertImage(db, { ...testImage, file_id: "file_002" });
      const first = await getNextImage(db, 0);
      const second = await getNextImage(db, first.nextId);
      expect(second.image).not.toBeNull();
      expect(second.image!.file_id).toBe("file_002");
    });

    it("wraps around at boundary", async () => {
      await upsertImage(db, testImage);
      await upsertImage(db, { ...testImage, file_id: "file_002" });
      const first = await getNextImage(db, 0);
      const second = await getNextImage(db, first.nextId);
      const wrapped = await getNextImage(db, second.nextId);
      expect(wrapped.image).not.toBeNull();
      expect(wrapped.image!.file_id).toBe("file_001");
    });

    it("returns null for empty table", async () => {
      const result = await getNextImage(db, 0);
      expect(result.image).toBeNull();
      expect(result.nextId).toBe(0);
    });
  });

  describe("client state", () => {
    it("creates default state for new client", async () => {
      const state = await getClientState(db, "client_001");
      expect(state.client_id).toBe("client_001");
      expect(state.last_index).toBe(0);
    });

    it("updates existing state", async () => {
      await setClientState(db, "client_001", { last_index: 5 });
      const state = await getClientState(db, "client_001");
      expect(state.last_index).toBe(5);
    });

    it("partial update preserves other fields", async () => {
      await setClientState(db, "client_001", { last_index: 5 });
      await setClientState(db, "client_001", { last_index: 10 });
      const state = await getClientState(db, "client_001");
      expect(state.last_index).toBe(10);
    });
  });

  describe("directories", () => {
    it("upsert and list directories", async () => {
      await upsertDirectory(db, {
        dir_id: "dir_001",
        name: "Photos",
        include_subdirs: 1,
      });
      const dirs = await getDirectories(db);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].dir_id).toBe("dir_001");
      expect(dirs[0].name).toBe("Photos");
    });

    it("delete directory removes it and images", async () => {
      await upsertDirectory(db, {
        dir_id: "dir_001",
        name: "Photos",
        include_subdirs: 0,
      });
      await upsertImage(db, testImage);
      await deleteDirectory(db, "dir_001");
      const dirs = await getDirectories(db);
      expect(dirs).toHaveLength(0);
      const images = await getImagesByDir(db, "dir_001");
      expect(images).toHaveLength(0);
    });

    it("delete directory removes nested subdirectory images", async () => {
      await upsertDirectory(db, {
        dir_id: "dir_001",
        name: "Photos",
        include_subdirs: 1,
      });
      // Parent dir image
      await upsertImage(db, testImage);
      // Nested subdirectory image (different dir_id, same root_dir_id)
      await upsertImage(db, {
        ...testImage,
        file_id: "file_nested",
        dir_id: "subdir_001",
        root_dir_id: "dir_001",
      });
      await deleteDirectory(db, "dir_001");
      const images = await getImagesByDir(db, "dir_001");
      expect(images).toHaveLength(0);
    });
  });
});
