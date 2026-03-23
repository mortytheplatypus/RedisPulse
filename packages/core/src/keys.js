function normalize(kind, query) {
  const k = String(kind).toLowerCase().trim();
  const q = String(query).trim();
  if (k === "currency") return { k, q: q.toUpperCase() };
  return { k, q: q.toLowerCase() };
}

export function serviceDataKey(kind, query) {
  const { k, q } = normalize(kind, query);
  return `data:${k}:${q}`;
}

export function serviceMetaKey(kind, query) {
  const { k, q } = normalize(kind, query);
  return `meta:${k}:${q}`;
}

export function serviceLockKey(kind, query) {
  const { k, q } = normalize(kind, query);
  return `lock:${k}:${q}`;
}

export const QUEUE_REFRESH = "queue:refresh";
