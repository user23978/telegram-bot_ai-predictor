const cache = new Map();

export function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCached(key, value, ttlMs) {
  if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) return value;
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  return value;
}

export async function cached(key, ttlMs, factory) {
  const existing = getCached(key);
  if (existing !== null) return existing;
  const value = await factory();
  setCached(key, value, ttlMs);
  return value;
}

export function getCacheStats() {
  const now = Date.now();
  let active = 0;
  let expired = 0;
  for (const entry of cache.values()) {
    if (entry.expiresAt > now) active += 1;
    else expired += 1;
  }
  return {
    active,
    expired,
    total: cache.size,
    keys: [...cache.keys()].slice(0, 30)
  };
}

export function clearExpiredCache() {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}
