import type { Env } from "../utils/types";

// --- Token Bucket (in-memory, resets on cold start) ---

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

export function getTokenBucket(key: string, rps: number, burst: number): TokenBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: burst, lastRefill: Date.now() };
    buckets.set(key, bucket);
  }
  return bucket;
}

export function consumeToken(key: string, rps: number = 3, burst: number = 5): boolean {
  const bucket = getTokenBucket(key, rps, burst);
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rps);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

export function waitForToken(key: string, rps: number = 3, burst: number = 5): Promise<void> {
  if (consumeToken(key, rps, burst)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (consumeToken(key, rps, burst)) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

// --- Concurrency Pool (semaphore) ---

const semaphoreQueues = new Map<string, { active: number; queue: Array<() => void> }>();

export async function withConcurrency<T>(
  key: string,
  maxConcurrent: number,
  fn: () => Promise<T>
): Promise<T> {
  let pool = semaphoreQueues.get(key);
  if (!pool) {
    pool = { active: 0, queue: [] };
    semaphoreQueues.set(key, pool);
  }

  // Wait for a slot
  if (pool.active >= maxConcurrent) {
    await new Promise<void>((resolve) => {
      pool!.queue.push(resolve);
    });
  }

  pool.active++;
  try {
    return await fn();
  } finally {
    pool.active--;
    const next = pool.queue.shift();
    if (next) next();
  }
}

// --- Circuit Breaker ---

interface CircuitState {
  failures: number;
  lastFailure: number;
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();

const RATE_LIMIT_ERRORS = [590075, 990005, 990009];

export function isRateLimitError(errno: number): boolean {
  return RATE_LIMIT_ERRORS.includes(errno);
}

export function recordCircuitFailure(
  key: string,
  threshold: number = 3,
  windowMs: number = 60000,
  cooldownMs: number = 60000
): void {
  let circuit = circuits.get(key);
  if (!circuit) {
    circuit = { failures: 0, lastFailure: 0, openUntil: 0 };
    circuits.set(key, circuit);
  }

  const now = Date.now();
  // Reset failure count if outside window
  if (now - circuit.lastFailure > windowMs) {
    circuit.failures = 0;
  }

  circuit.failures++;
  circuit.lastFailure = now;

  if (circuit.failures >= threshold) {
    circuit.openUntil = now + cooldownMs;
  }
}

export function isCircuitOpen(key: string): boolean {
  const circuit = circuits.get(key);
  if (!circuit) return false;
  return Date.now() < circuit.openUntil;
}

export function getCircuitStatus(key: string): { open: boolean; failures: number; openUntil: number } {
  const circuit = circuits.get(key);
  if (!circuit) return { open: false, failures: 0, openUntil: 0 };
  return {
    open: Date.now() < circuit.openUntil,
    failures: circuit.failures,
    openUntil: circuit.openUntil,
  };
}

// --- Exponential Backoff ---

export async function withBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    isRetryable?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    isRetryable = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// --- Rate-Limited Fetch ---

export async function rateLimitedFetch<T>(
  env: Env,
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  // Check circuit breaker
  if (isCircuitOpen(key)) {
    throw new Error(`Circuit breaker open for ${key}`);
  }

  // Wait for rate limit token
  await waitForToken("api", 3, 5);

  // Execute with concurrency limit
  return withConcurrency("api", 10, async () => {
    try {
      return await withBackoff(fetcher, {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        isRetryable: (err) => {
          if (err instanceof Error && err.message.includes("115 API error")) {
            // Check if it's a rate limit error
            const match = err.message.match(/errno[:\s]+(\d+)/i);
            if (match && isRateLimitError(parseInt(match[1]))) {
              return true;
            }
          }
          return false;
        },
      });
    } catch (err) {
      // Record circuit failure on rate limit errors
      if (err instanceof Error && err.message.includes("115 API error")) {
        const match = err.message.match(/errno[:\s]+(\d+)/i);
        if (match && isRateLimitError(parseInt(match[1]))) {
          recordCircuitFailure(
            key,
            env.ADMIN_PASS ? 3 : 3,
            60000,
            60000
          );
        }
      }
      throw err;
    }
  });
}
