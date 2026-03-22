/**
 * Phase 6: fixed-window rate limit per client IP using INCR + EXPIRE.
 */
export function createAggregateRateLimiter(redis, options) {
  const limit = Number(options.limit ?? process.env.RATE_LIMIT_MAX ?? 100);
  const windowSec = Number(options.windowSec ?? process.env.RATE_LIMIT_WINDOW_SEC ?? 60);
  const prefix = options.keyPrefix ?? "rate";

  return async function aggregateRateLimit(req, res, next) {
    if (!redis) {
      return next();
    }
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const window = Math.floor(Date.now() / (windowSec * 1000));
    const key = `${prefix}:aggregate:${ip}:${window}`;
    try {
      const n = await redis.incr(key);
      if (n === 1) {
        await redis.expire(key, windowSec);
      }
      res.set("X-RateLimit-Limit", String(limit));
      res.set("X-RateLimit-Remaining", String(Math.max(0, limit - n)));
      if (n > limit) {
        res.set("Retry-After", String(windowSec));
        return res.status(429).json({ error: "rate_limit_exceeded" });
      }
    } catch (e) {
      console.warn("[rateLimit]", e.message);
    }
    next();
  };
}
