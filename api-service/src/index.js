import express from "express";
import {
  aggregateCacheKey,
  createRedisClient,
  getCachedJson,
  setCachedJson,
} from "./cache.js";
import { fetchAggregate } from "./fetchAggregate.js";

const app = express();
const PORT = Number(process.env.API_PORT ?? 3000);
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 300);

function baseUrl(envName, fallback) {
  return (process.env[envName] ?? fallback).replace(/\/$/, "");
}

/** One process per mock: weather, news, currency (see mock-services package). */
const WEATHER_SERVICE_URL = baseUrl("WEATHER_SERVICE_URL", "http://127.0.0.1:4001");
const NEWS_SERVICE_URL = baseUrl("NEWS_SERVICE_URL", "http://127.0.0.1:4002");
const CURRENCY_SERVICE_URL = baseUrl("CURRENCY_SERVICE_URL", "http://127.0.0.1:4003");

const redis = createRedisClient();

/**
 * GET /aggregate — cache-aside: Redis `data:aggregate:...` JSON blob with TTL.
 * Caches only when all upstreams succeed. If Redis is down or disabled, still serves (bypass).
 */
app.get("/aggregate", async (req, res) => {
  const location = req.query.location ?? "dhaka";
  const topic = req.query.topic ?? "tech";
  const base = req.query.base ?? "USD";

  const key = aggregateCacheKey(location, topic, base);

  if (redis) {
    const cached = await getCachedJson(redis, key);
    if (cached && typeof cached.statusCode === "number" && cached.body) {
      return res
        .status(cached.statusCode)
        .set("X-Cache", "HIT")
        .json({ ...cached.body, cache: "hit" });
    }
  }

  const { statusCode, body, cacheable } = await fetchAggregate({
    location,
    topic,
    base,
    WEATHER_SERVICE_URL,
    NEWS_SERVICE_URL,
    CURRENCY_SERVICE_URL,
  });

  if (redis && cacheable) {
    await setCachedJson(redis, key, { statusCode, body }, CACHE_TTL_SECONDS);
  }

  const xCache = redis ? "MISS" : "BYPASS";
  res.status(statusCode).set("X-Cache", xCache).json({ ...body, cache: redis ? "miss" : "bypass" });
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
  console.log(`CACHE_TTL_SECONDS=${CACHE_TTL_SECONDS}`);
});
