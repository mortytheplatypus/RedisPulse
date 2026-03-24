import express from "express";
import { serveCurrency, serveNews, serveWeather } from "./serviceHandler.js";
import { createRedisClient } from "./cache.js";
import { createApiRateLimiter } from "./rateLimit.js";
import { DEFAULTS } from "../../default.js";

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.API_PORT ?? DEFAULTS.API_PORT);
const STALE_AFTER_SECONDS = Number(process.env.STALE_AFTER_SECONDS ?? DEFAULTS.STALE_AFTER_SECONDS);
const MAX_CACHE_SECONDS = Number(process.env.MAX_CACHE_SECONDS ?? DEFAULTS.MAX_CACHE_SECONDS);
const LOCK_WAIT_MS = Number(process.env.LOCK_WAIT_MS ?? DEFAULTS.LOCK_WAIT_MS);
const LOCK_POLL_MS = Number(process.env.LOCK_POLL_MS ?? DEFAULTS.LOCK_POLL_MS);
const shouldUseRefreshQueue = process.env.SHOULD_USE_REFRESH_QUEUE === "true" || DEFAULTS.SHOULD_USE_REFRESH_QUEUE === "1";

const redis = createRedisClient();

const serviceCtx = {
  redis,
  staleAfterSeconds: STALE_AFTER_SECONDS,
  maxCacheSeconds: MAX_CACHE_SECONDS,
  lockWaitMs: LOCK_WAIT_MS,
  lockPollMs: LOCK_POLL_MS,
  shouldUseRefreshQueue: Boolean(redis) && shouldUseRefreshQueue,
};

const rateLimitMw = createApiRateLimiter(redis, {});

app.get("/weather", rateLimitMw, async (req, res, next) => {
  try {
    await serveWeather(req, res, serviceCtx);
  } catch (e) {
    next(e);
  }
});

app.get("/news", rateLimitMw, async (req, res, next) => {
  try {
    await serveNews(req, res, serviceCtx);
  } catch (e) {
    next(e);
  }
});

app.get("/currency", rateLimitMw, async (req, res, next) => {
  try {
    await serveCurrency(req, res, serviceCtx);
  } catch (e) {
    next(e);
  }
});

app.get("/health", async (_req, res) => {
  const cache = redis ? { redis: "configured" } : { redis: "disabled" };
  let redisOk = null;
  if (redis) {
    try {
      const pong = await redis.ping();
      redisOk = pong === "PONG";
    } catch {
      redisOk = false;
    }
  }
  res.json({ ok: true, ...cache, redisReachable: redisOk });
});

app.listen(PORT, () => {
  console.log(`api listening on http://127.0.0.1:${PORT}`);
  console.log(`WEATHER_SERVICE_URL=${WEATHER_SERVICE_URL}`);
  console.log(`NEWS_SERVICE_URL=${NEWS_SERVICE_URL}`);
  console.log(`CURRENCY_SERVICE_URL=${CURRENCY_SERVICE_URL}`);
  console.log(`REDIS_URL=${redis ? (process.env.REDIS_URL ?? "(set)") : "disabled"}`);
  console.log(`STALE_AFTER_SECONDS=${STALE_AFTER_SECONDS} MAX_CACHE_SECONDS=${MAX_CACHE_SECONDS}`);
  console.log(`SHOULD_USE_REFRESH_QUEUE=${serviceCtx.shouldUseRefreshQueue}`);
});
