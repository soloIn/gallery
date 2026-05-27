// Cloudflare resource limit error handling

export class CloudflareLimitError extends Error {
  readonly type: "d1_read" | "d1_write" | "kv_read" | "kv_write";
  readonly retryAfter: number;

  constructor(
    type: CloudflareLimitError["type"],
    message: string,
    retryAfter: number = 60
  ) {
    super(message);
    this.name = "CloudflareLimitError";
    this.type = type;
    this.retryAfter = retryAfter;
  }
}

const LIMIT_PATTERNS = [
  { pattern: /KV put\(\) limit/i, type: "kv_write" as const },
  { pattern: /KV get\(\) limit/i, type: "kv_read" as const },
  { pattern: /SQL_STORAGE_LIMIT/i, type: "d1_write" as const },
  { pattern: /too many requests/i, type: "d1_read" as const },
  { pattern: /daily.*limit/i, type: "d1_write" as const },
  { pattern: /exceeded.*quota/i, type: "kv_write" as const },
  { pattern: /request.*limit.*exceeded/i, type: "d1_read" as const },
];

export function isCloudflareLimitError(err: unknown): boolean {
  if (err instanceof CloudflareLimitError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return LIMIT_PATTERNS.some(({ pattern }) => pattern.test(msg));
}

export function toCloudflareLimitError(
  err: unknown,
  defaultType: CloudflareLimitError["type"] = "d1_read"
): CloudflareLimitError {
  if (err instanceof CloudflareLimitError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const matched = LIMIT_PATTERNS.find(({ pattern }) => pattern.test(msg));
  return new CloudflareLimitError(
    matched?.type ?? defaultType,
    msg,
    60
  );
}

export async function withD1ErrorHandling<T>(
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isCloudflareLimitError(err)) {
      throw toCloudflareLimitError(err, "d1_read");
    }
    throw err;
  }
}

export async function withKVErrorHandling<T>(
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isCloudflareLimitError(err)) {
      throw toCloudflareLimitError(err, "kv_read");
    }
    throw err;
  }
}
