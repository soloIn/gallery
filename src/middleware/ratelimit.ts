import type { Env } from "../utils/types";

// --- Token Bucket (in-memory, self-healing on cold start) ---

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

export function waitForToken(
  key: string,
  rps: number = 3,
  burst: number = 5,
  timeoutMs: number = 10000
): Promise<void> {
  if (consumeToken(key, rps, burst)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Rate limit timeout: could not acquire token within ${timeoutMs}ms`));
    }, timeoutMs);

    const interval = setInterval(() => {
      if (consumeToken(key, rps, burst)) {
        clearInterval(interval);
        clearTimeout(timeout);
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

// --- Circuit Breaker (KV-backed for cross-isolate persistence) ---

interface CircuitState {
  failures: number;
  lastFailure: number;
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_KV_PREFIX = "circuit:";

const RATE_LIMIT_ERRORS = [590075, 990005, 990009];

export function isRateLimitError(errno: number): boolean {
  return RATE_LIMIT_ERRORS.includes(errno);
}

async function loadCircuit(kv: KVNamespace, key: string): Promise<CircuitState> {
  let circuit = circuits.get(key);
  if (circuit) return circuit;

  const stored = await kv.get<CircuitState>(`${CIRCUIT_KV_PREFIX}${key}`, "json");
  if (stored) {
    circuits.set(key, stored);
    return stored;
  }

  circuit = { failures: 0, lastFailure: 0, openUntil: 0 };
  circuits.set(key, circuit);
  return circuit;
}

async function saveCircuit(kv: KVNamespace, key: string, circuit: CircuitState): Promise<void> {
  circuits.set(key, circuit);
  // Persist to KV with 5-min TTL (auto-cleanup)
  await kv.put(`${CIRCUIT_KV_PREFIX}${key}`, JSON.stringify(circuit), {
    expirationTtl: 300,
  });
}

export async function recordCircuitFailure(
  kv: KVNamespace,
  key: string,
  threshold: number = 3,
  windowMs: number = 60000,
  cooldownMs: number = 60000
): Promise<void> {
  const circuit = await loadCircuit(kv, key);
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

  await saveCircuit(kv, key, circuit);
}

export async function isCircuitOpen(kv: KVNamespace, key: string): Promise<boolean> {
  const circuit = await loadCircuit(kv, key);
  return Date.now() < circuit.openUntil;
}

export async function getCircuitStatus(kv: KVNamespace, key: string): Promise<{ open: boolean; failures: number; openUntil: number }> {
  const circuit = await loadCircuit(kv, key);
  return {
    open: Date.now() < circuit.openUntil,
    failures: circuit.failures,
    openUntil: circuit.openUntil,
  };
}

// --- Exponential Backoff with Jitter ---

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
      const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      // Add jitter: 50%-150% of computed delay to prevent thundering herd
      const jitter = exponentialDelay * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, jitter));
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
  // Check circuit breaker (KV-backed)
  if (await isCircuitOpen(env.KV_CONFIG, key)) {
    throw new Error(`Circuit breaker open for ${key}`);
  }

  // Wait for rate limit token
  await waitForToken("api", 3, 5, 10000);

  // Execute with concurrency limit
  return withConcurrency("api", 10, async () => {
    try {
      return await withBackoff(fetcher, {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        isRetryable: (err) => {
          // Retry rate-limit errors
          if (err instanceof Error && err.message.includes("115 API error")) {
            const match = err.message.match(/errno[:\s]+(\d+)/i);
            if (match && isRateLimitError(parseInt(match[1]))) {
              return true;
            }
            // Retry 5xx server errors
            const statusMatch = err.message.match(/115 API error: (\d+)/);
            if (statusMatch) {
              const status = parseInt(statusMatch[1]);
              if (status >= 500) return true;
            }
          }
          // Retry network errors
          if (err instanceof TypeError && err.message.includes("fetch")) {
            return true;
          }
          return false;
        },
      });
    } catch (err) {
      // Record circuit failure on rate limit errors
      if (err instanceof Error && err.message.includes("115 API error")) {
        const match = err.message.match(/errno[:\s]+(\d+)/i);
        if (match && isRateLimitError(parseInt(match[1]))) {
          await recordCircuitFailure(env.KV_CONFIG, key, 3, 60000, 60000);
        }
      }
      throw err;
    }
  });
}
