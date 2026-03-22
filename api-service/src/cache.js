import Redis from "ioredis";

/** Key design: data:{resource}:{params} (see docs/requirements.md) */
export function aggregateCacheKey(location, topic, base) {
  const l = String(location).toLowerCase().trim();
  const t = String(topic).toLowerCase().trim();
  const b = String(base).toUpperCase().trim();
  return `data:aggregate:${l}:${t}:${b}`;
}

/**
 * Creates a Redis client if REDIS_URL is set; otherwise returns null (cache disabled).
 */
export function createRedisClient() {
  const url = process.env.REDIS_URL;
  if (!url || url === "false" || url === "0") {
    return null;
  }
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 100, 2000);
    },
    lazyConnect: true,
  });
}

export async function getCachedJson(redis, key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[cache] get failed:", e.message);
    return null;
  }
}

export async function setCachedJson(redis, key, value, ttlSeconds) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (e) {
    console.warn("[cache] set failed:", e.message);
  }
}
