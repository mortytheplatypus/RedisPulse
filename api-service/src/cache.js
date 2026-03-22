import Redis from "ioredis";

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
