export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function randomDelayMs(minMs, maxMs) {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Failure probability in [0.2, 0.3] per request (req: 20–30%). */
export function shouldFailNews() {
  const p = 0.2 + Math.random() * 0.1;
  return Math.random() < p;
}

/** Fixed window: count per UTC minute bucket */
export function createMinuteRateLimiter(maxPerMinute) {
  const buckets = new Map();
  return function allowed() {
    const bucket = Math.floor(Date.now() / 60_000);
    const n = (buckets.get(bucket) ?? 0) + 1;
    buckets.set(bucket, n);
    for (const k of buckets.keys()) {
      if (k < bucket - 1) buckets.delete(k);
    }
    return n <= maxPerMinute;
  };
}

export function pickRandomSubset(arr, count) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}
