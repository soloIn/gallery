const CACHE_PREFIX = "cache:"

// In-flight fetcher deduplication to prevent cache stampedes
const inflight = new Map<string, Promise<unknown>>();

export async function cacheFetch<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number
): Promise<T> {
  const cacheKey = `${CACHE_PREFIX}${key}`;
  const cached = await kv.get<T>(cacheKey, "json");
  if (cached !== null) return cached;

  // Deduplicate concurrent fetches for the same key
  const existing = inflight.get(cacheKey) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fetcher().then(async (result) => {
    await kv.put(cacheKey, JSON.stringify(result), {
      expirationTtl: ttlSeconds,
    });
    inflight.delete(cacheKey);
    return result;
  }).catch((err) => {
    inflight.delete(cacheKey);
    throw err;
  });

  inflight.set(cacheKey, promise);
  return promise;
}

export async function invalidateCache(
  kv: KVNamespace,
  key: string
): Promise<void> {
  await kv.delete(`${CACHE_PREFIX}${key}`);
}

export async function invalidateCachePattern(
  kv: KVNamespace,
  pattern: string
): Promise<void> {
  // Paginate through all matching keys
  let cursor: string | undefined;
  do {
    const listOptions: KVNamespaceListOptions = {
      prefix: `${CACHE_PREFIX}${pattern}`,
    };
    if (cursor) listOptions.cursor = cursor;

    const result = await kv.list(listOptions);
    for (const key of result.keys) {
      await kv.delete(key.name);
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}
