import { describe, it, expect } from "vitest";
import {
  CloudflareLimitError,
  isCloudflareLimitError,
  toCloudflareLimitError,
} from "../../src/utils/cloudflare-errors";

describe("cloudflare-errors", () => {
  describe("isCloudflareLimitError", () => {
    it("returns true for CloudflareLimitError instances", () => {
      const err = new CloudflareLimitError("d1_read", "limit exceeded");
      expect(isCloudflareLimitError(err)).toBe(true);
    });

    it("returns true for KV put limit errors", () => {
      const err = new Error("KV put() limit exceeded");
      expect(isCloudflareLimitError(err)).toBe(true);
    });

    it("returns true for SQL storage limit errors", () => {
      const err = new Error("SQL_STORAGE_LIMIT reached");
      expect(isCloudflareLimitError(err)).toBe(true);
    });

    it("returns true for too many requests errors", () => {
      const err = new Error("too many requests");
      expect(isCloudflareLimitError(err)).toBe(true);
    });

    it("returns false for regular errors", () => {
      const err = new Error("something else");
      expect(isCloudflareLimitError(err)).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isCloudflareLimitError("string")).toBe(false);
      expect(isCloudflareLimitError(null)).toBe(false);
    });
  });

  describe("toCloudflareLimitError", () => {
    it("passes through CloudflareLimitError instances", () => {
      const original = new CloudflareLimitError("kv_write", "test", 120);
      const result = toCloudflareLimitError(original);
      expect(result).toBe(original);
    });

    it("detects type from error message", () => {
      const err = new Error("KV put() limit exceeded");
      const result = toCloudflareLimitError(err);
      expect(result.type).toBe("kv_write");
      expect(result.retryAfter).toBe(60);
    });

    it("uses default type for unrecognized errors", () => {
      const err = new Error("unknown");
      const result = toCloudflareLimitError(err, "d1_write");
      expect(result.type).toBe("d1_write");
    });
  });
});
