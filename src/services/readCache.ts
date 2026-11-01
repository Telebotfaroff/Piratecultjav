/**
 * Small bounded in-process cache for read-mostly configuration.
 *
 * This is deliberately not used for user entitlements, quota reservations,
 * payment state, blocked-user checks, or Telegram membership decisions.
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 500;
const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();

export async function getCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;
  if (cached) entries.delete(key);

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const generation = generations.get(key) || 0;
  let request: Promise<T>;
  request = loader().then((value) => {
    // Do not let a pre-invalidation request repopulate stale configuration.
    if ((generations.get(key) || 0) === generation) {
      for (const [entryKey, entry] of entries) {
        if (entry.expiresAt <= Date.now()) entries.delete(entryKey);
      }
      while (entries.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
      entries.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) });
    }
    return value;
  }).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });

  inFlight.set(key, request);
  return request;
}

export function invalidateCached(key: string): void {
  entries.delete(key);
  generations.set(key, (generations.get(key) || 0) + 1);
  inFlight.delete(key);
}

export function invalidateCachedPrefix(prefix: string): void {
  const keys = new Set<string>([
    ...Array.from(entries.keys()).filter((key) => key.startsWith(prefix)),
    ...Array.from(inFlight.keys()).filter((key) => key.startsWith(prefix)),
  ]);
  for (const key of keys) invalidateCached(key);
}
