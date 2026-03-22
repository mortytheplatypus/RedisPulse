const norm = (location, topic, base) => {
  const l = String(location).toLowerCase().trim();
  const t = String(topic).toLowerCase().trim();
  const b = String(base).toUpperCase().trim();
  return { l, t, b };
};

/** data:{resource}:{params} */
export function aggregateDataKey(location, topic, base) {
  const { l, t, b } = norm(location, topic, base);
  return `data:aggregate:${l}:${t}:${b}`;
}

/** Alias for older call sites / README */
export const aggregateCacheKey = aggregateDataKey;

/** meta:{resource}:{params} */
export function aggregateMetaKey(location, topic, base) {
  const { l, t, b } = norm(location, topic, base);
  return `meta:aggregate:${l}:${t}:${b}`;
}

/** lock:{resource}:{params} */
export function aggregateLockKey(location, topic, base) {
  const { l, t, b } = norm(location, topic, base);
  return `lock:aggregate:${l}:${t}:${b}`;
}

export const QUEUE_REFRESH = "queue:refresh";
