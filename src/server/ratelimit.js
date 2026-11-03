// Token bucket limiter kept in memory. Keys are things like "join:<address>".
// Addresses stay in memory only, they are never logged or stored.
export function createLimiter({ now = Date.now } = {}) {
  const buckets = new Map();

  function allow(key, { capacity, perSecond }) {
    const t = now();
    const b = buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  }

  function sweep(maxAgeMs = 10 * 60 * 1000) {
    const t = now();
    for (const [key, b] of buckets) if (t - b.at > maxAgeMs) buckets.delete(key);
  }

  return { allow, sweep, size: () => buckets.size };
}

export const LIMITS = {
  create: { capacity: 5, perSecond: 5 / 600 },
  join: { capacity: 20, perSecond: 20 / 60 },
  api: { capacity: 60, perSecond: 30 },
  chat: { capacity: 5, perSecond: 1 },
  report: { capacity: 5, perSecond: 5 / 300 },
};
