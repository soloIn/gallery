import { describe, it, expect } from "vitest";
import {
  consumeToken,
  waitForToken,
  withConcurrency,
  withBackoff,
  isRateLimitError,
} from "../../src/middleware/ratelimit";

describe("rate limiter", () => {
  describe("token bucket", () => {
    it("consumes tokens up to burst limit", () => {
      const key = `burst-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        expect(consumeToken(key, 3, 5)).toBe(true);
      }
      expect(consumeToken(key, 3, 5)).toBe(false);
    });

    it("refills tokens over time", async () => {
      const key = `refill-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        consumeToken(key, 10, 5);
      }
      expect(consumeToken(key, 10, 5)).toBe(false);

      await new Promise((r) => setTimeout(r, 150));
      expect(consumeToken(key, 10, 5)).toBe(true);
    });
  });

  describe("waitForToken", () => {
    it("resolves immediately when tokens available", async () => {
      await expect(waitForToken(`wait-${Date.now()}`, 3, 5)).resolves.toBeUndefined();
    });

    it("waits and resolves when token becomes available", async () => {
      const key = `wait-slow-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        consumeToken(key, 10, 5);
      }

      const start = Date.now();
      await waitForToken(key, 10, 5);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(50);
    }, 5000);

    it("rejects on timeout", async () => {
      const key = `wait-timeout-${Date.now()}`;
      // Exhaust tokens with very low rps
      for (let i = 0; i < 5; i++) {
        consumeToken(key, 0.001, 5);
      }

      await expect(waitForToken(key, 0.001, 5, 200)).rejects.toThrow("Rate limit timeout");
    }, 5000);
  });

  describe("concurrency pool", () => {
    it("runs tasks up to concurrency limit", async () => {
      let active = 0;
      let maxActive = 0;

      const task = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
      };

      await Promise.all(
        Array.from({ length: 5 }, () => withConcurrency("test-pool", 3, task))
      );

      expect(maxActive).toBeLessThanOrEqual(3);
    });

    it("returns values from concurrent tasks", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          withConcurrency("test-vals", 3, async () => i * 2)
        )
      );

      expect(results).toEqual([0, 2, 4, 6, 8]);
    });
  });

  describe("withBackoff", () => {
    it("retries on failure and succeeds", async () => {
      let attempts = 0;
      const result = await withBackoff(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("temporary");
          return "success";
        },
        { maxRetries: 3, baseDelayMs: 10 }
      );

      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("throws after max retries", async () => {
      let attempts = 0;
      await expect(
        withBackoff(
          async () => {
            attempts++;
            throw new Error("permanent");
          },
          { maxRetries: 2, baseDelayMs: 10 }
        )
      ).rejects.toThrow("permanent");

      expect(attempts).toBe(3);
    });

    it("respects isRetryable", async () => {
      let attempts = 0;
      await expect(
        withBackoff(
          async () => {
            attempts++;
            throw new Error("not retryable");
          },
          { maxRetries: 3, baseDelayMs: 10, isRetryable: () => false }
        )
      ).rejects.toThrow("not retryable");

      expect(attempts).toBe(1);
    });
  });

  describe("isRateLimitError", () => {
    it("identifies 115 rate limit error codes", () => {
      expect(isRateLimitError(590075)).toBe(true);
      expect(isRateLimitError(990005)).toBe(true);
      expect(isRateLimitError(990009)).toBe(true);
      expect(isRateLimitError(0)).toBe(false);
      expect(isRateLimitError(404)).toBe(false);
    });
  });
});
