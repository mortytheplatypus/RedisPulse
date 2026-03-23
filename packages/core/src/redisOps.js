import { randomBytes } from "node:crypto";
import {
  QUEUE_REFRESH,
  serviceDataKey,
  serviceLockKey,
  serviceMetaKey,
} from "./keys.js";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const LOCK_TTL_SEC = Number(process.env.LOCK_TTL_SECONDS ?? 5);

function randomToken() {
  return randomBytes(16).toString("hex");
}

export async function enqueueRefreshJob(redis, job) {
  if (!redis) return;
  try {
    await redis.lpush(QUEUE_REFRESH, JSON.stringify(job));
  } catch (e) {
    console.warn("[redisOps] enqueueRefreshJob failed:", e.message);
  }
}

export async function readServiceEntry(redis, kind, query) {
  if (!redis) return null;
  const dataKey = serviceDataKey(kind, query);
  const metaKey = serviceMetaKey(kind, query);
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
    console.warn("[redisOps] readServiceEntry failed:", e.message);
    return null;
  }
}

export async function writeServiceEntry(redis, kind, query, { statusCode, body }) {
  if (!redis) return;
  const dataKey = serviceDataKey(kind, query);
  const metaKey = serviceMetaKey(kind, query);
  const storedAt = Date.now();
  const payload = JSON.stringify({ statusCode, body });
  const meta = JSON.stringify({ storedAt });
  try {
    const pipeline = redis.multi();
    pipeline.set(dataKey, payload);
    pipeline.set(metaKey, meta);
    await pipeline.exec();
  } catch (e) {
    console.warn("[redisOps] writeServiceEntry failed:", e.message);
  }
}

export async function deleteServiceEntry(redis, kind, query) {
  if (!redis) return;
  const dataKey = serviceDataKey(kind, query);
  const metaKey = serviceMetaKey(kind, query);
  try {
    await redis.del(dataKey, metaKey);
  } catch (e) {
    console.warn("[redisOps] deleteServiceEntry failed:", e.message);
  }
}

export async function acquireServiceLock(redis, kind, query, ttlSec = LOCK_TTL_SEC) {
  if (!redis) return null;
  const lockKey = serviceLockKey(kind, query);
  const token = randomToken();
  try {
    const ok = await redis.set(lockKey, token, "NX", "EX", ttlSec);
    return ok === "OK" ? token : null;
  } catch (e) {
    console.warn("[redisOps] acquireServiceLock failed:", e.message);
    return null;
  }
}

export async function releaseServiceLock(redis, kind, query, token) {
  if (!redis || !token) return;
  const lockKey = serviceLockKey(kind, query);
  try {
    const cur = await redis.get(lockKey);
    if (cur === token) {
      await redis.del(lockKey);
    }
  } catch (e) {
    console.warn("[redisOps] releaseServiceLock failed:", e.message);
  }
}

export async function pollUntilServicePresent(redis, kind, query, maxWaitMs, pollMs, maxCacheSeconds) {
  if (!redis) return null;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const e = await readServiceEntry(redis, kind, query);
    if (e) {
      const ageSec = (Date.now() - e.storedAt) / 1000;
      if (ageSec <= maxCacheSeconds) return e;
    }
    await sleep(pollMs);
  }
  const last = await readServiceEntry(redis, kind, query);
  if (!last) return null;
  const ageSec = (Date.now() - last.storedAt) / 1000;
  return ageSec <= maxCacheSeconds ? last : null;
}
