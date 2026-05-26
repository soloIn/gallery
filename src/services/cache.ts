const CACHE_PREFIX = "cache:";

export async function cacheFetch<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number
): Promise<T> {
  const cacheKey = `${CACHE_PREFIX}${key}`;
  const cached = await kv.get<T>(cacheKey, "json");
  if (cached !== null) return cached;

  const result = await fetcher();
  await kv.put(cacheKey, JSON.stringify(result), {
    expirationTtl: ttlSeconds,
  });
  return result;
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
  const keys = await kv.list({ prefix: `${CACHE_PREFIX}${pattern}` });
  for (const key of keys.keys) {
    await kv.delete(key.name);
  }
}
