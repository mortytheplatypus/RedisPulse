import { randomBytes } from "node:crypto";
import {
  aggregateDataKey,
  aggregateLockKey,
  aggregateMetaKey,
  QUEUE_REFRESH,
} from "./keys.js";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @returns {Promise<{ statusCode: number, body: object, storedAt: number } | null>}
 */
export async function readAggregateEntry(redis, location, topic, base) {
  if (!redis) return null;
  const dataKey = aggregateDataKey(location, topic, base);
  const metaKey = aggregateMetaKey(location, topic, base);
  try {
    const [rawData, rawMeta] = await redis.mget(dataKey, metaKey);
    if (rawData == null || rawMeta == null) return null;
    const payload = JSON.parse(rawData);
    const meta = JSON.parse(rawMeta);
    const storedAt = Number(meta.storedAt);
    if (!Number.isFinite(storedAt)) return null;
    if (!payload || typeof payload.statusCode !== "number" || !payload.body) return null;
    return { ...payload, storedAt };
  } catch (e) {
    console.warn("[redisOps] readAggregateEntry failed:", e.message);
    return null;
  }
}

export async function deleteAggregateEntry(redis, location, topic, base) {
  if (!redis) return;
  const dataKey = aggregateDataKey(location, topic, base);
  const metaKey = aggregateMetaKey(location, topic, base);
  try {
    await redis.del(dataKey, metaKey);
  } catch (e) {
    console.warn("[redisOps] deleteAggregateEntry failed:", e.message);
  }
}

/**
 * Writes data + meta (no TTL on keys; hard expiry enforced in application using storedAt).
 */
export async function writeAggregateEntry(redis, location, topic, base, { statusCode, body }) {
  if (!redis) return;
  const dataKey = aggregateDataKey(location, topic, base);
  const metaKey = aggregateMetaKey(location, topic, base);
  const storedAt = Date.now();
  const payload = JSON.stringify({ statusCode, body });
  const meta = JSON.stringify({ storedAt });
  try {
    const pipeline = redis.multi();
    pipeline.set(dataKey, payload);
    pipeline.set(metaKey, meta);
    await pipeline.exec();
  } catch (e) {
    console.warn("[redisOps] writeAggregateEntry failed:", e.message);
  }
}

const LOCK_TTL_SEC = Number(process.env.LOCK_TTL_SECONDS ?? 5);

function randomToken() {
  return randomBytes(16).toString("hex");
}

/** @returns {Promise<string | null>} token if lock acquired */
export async function acquireLock(redis, location, topic, base, ttlSec = LOCK_TTL_SEC) {
  if (!redis) return null;
  const lockKey = aggregateLockKey(location, topic, base);
  const token = randomToken();
  try {
    const ok = await redis.set(lockKey, token, "NX", "EX", ttlSec);
    return ok === "OK" ? token : null;
  } catch (e) {
    console.warn("[redisOps] acquireLock failed:", e.message);
    return null;
  }
}

export async function releaseLock(redis, location, topic, base, token) {
  if (!redis || !token) return;
  const lockKey = aggregateLockKey(location, topic, base);
  try {
    const cur = await redis.get(lockKey);
    if (cur === token) {
      await redis.del(lockKey);
    }
  } catch (e) {
    console.warn("[redisOps] releaseLock failed:", e.message);
  }
}

export async function enqueueRefreshJob(redis, job) {
  if (!redis) return;
  try {
    await redis.lpush(QUEUE_REFRESH, JSON.stringify(job));
  } catch (e) {
    console.warn("[redisOps] enqueueRefreshJob failed:", e.message);
  }
}

/**
 * Polls until another request fills the cache or timeout (stampede waiters).
 */
export async function pollUntilAggregatePresent(
  redis,
  location,
  topic,
  base,
  maxWaitMs,
  pollMs,
  maxCacheSeconds
) {
  if (!redis) return null;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const e = await readAggregateEntry(redis, location, topic, base);
    if (e) {
      const ageSec = (Date.now() - e.storedAt) / 1000;
      if (ageSec <= maxCacheSeconds) return e;
    }
    await sleep(pollMs);
  }
  const last = await readAggregateEntry(redis, location, topic, base);
  if (!last) return null;
  const ageSec = (Date.now() - last.storedAt) / 1000;
  return ageSec <= maxCacheSeconds ? last : null;
}
