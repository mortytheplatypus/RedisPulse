/**
 * Fixed-window rate limit per client IP using INCR + EXPIRE.
 */
import { DEFAULTS } from "../../default.js";

export function createApiRateLimiter(redis, options) {
  const limit = Number(options.limit ?? process.env.RATE_LIMIT_MAX ?? DEFAULTS.RATE_LIMIT_MAX);
  const windowSec = Number(options.windowSec ?? process.env.RATE_LIMIT_WINDOW_SEC ?? DEFAULTS.RATE_LIMIT_WINDOW_SEC);
  const prefix = options.keyPrefix ?? "rate";

  return async function apiRateLimit(req, res, next) {
    if (!redis) {
      return next();
    }
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const window = Math.floor(Date.now() / (windowSec * 1000));
    const key = `${prefix}:api:${ip}:${window}`;
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
