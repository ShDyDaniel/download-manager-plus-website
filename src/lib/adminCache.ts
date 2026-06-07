import { adminApi } from './adminApi'

/**
 * Tiny in-memory cache for admin-panel READ calls.
 *
 * The admin tabs unmount/remount on every tab switch, so each visit
 * re-ran its `adminApi(...)` read — and a single read like
 * `admin-list-users` is billed PER DOCUMENT (every user + key row), so
 * bouncing between tabs burned thousands of Firestore reads a day.
 *
 * This wrapper keeps the last result per action in module scope (so it
 * survives unmounts within the session). Re-entering a tab within the
 * TTL returns the cached snapshot — ZERO reads. The refresh button (and
 * any post-mutation reload) passes { force: true } to bypass it.
 *
 * Cache is per page-load only (cleared on refresh / sign-out). Nothing
 * sensitive is persisted to disk.
 */
type Entry = { at: number; data: unknown }

const cache = new Map<string, Entry>()

// How long a cached snapshot is considered fresh. Within this window a
// tab re-entry costs nothing; after it, the next load re-reads once.
const DEFAULT_TTL_MS = 5 * 60 * 1000

function keyFor(action: string, body?: Record<string, unknown>): string {
  return body && Object.keys(body).length
    ? `${action}:${JSON.stringify(body)}`
    : action
}

/**
 * adminApi with a short-lived cache. Use for READ actions only (lists,
 * reports, usage) — never for mutations. Pass { force: true } to skip
 * the cache (refresh button, or reloading right after a mutation).
 */
export async function cachedAdminApi<T>(
  action: string,
  body: Record<string, unknown> = {},
  opts: { ttlMs?: number; force?: boolean } = {},
): Promise<T> {
  const key = keyFor(action, body)
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const hit = cache.get(key)
  if (!opts.force && hit && Date.now() - hit.at < ttl) {
    return hit.data as T
  }
  const data = await adminApi<T>(action, body)
  cache.set(key, { at: Date.now(), data })
  return data
}

/**
 * Synchronous peek — returns the cached snapshot immediately (any age),
 * or undefined if we've never loaded it this session. Use it to seed a
 * tab's initial state so re-entering shows the data instantly with NO
 * loading flash; then call cachedAdminApi() to refresh in the
 * background (which is free if still within the TTL).
 */
export function peekAdminCache<T>(
  action: string,
  body: Record<string, unknown> = {},
): T | undefined {
  const hit = cache.get(keyFor(action, body))
  return hit ? (hit.data as T) : undefined
}

/**
 * Drop cached snapshots so the next load re-reads. Call after a mutation
 * that changes what a read returns. With no argument, clears everything
 * (e.g. on sign-out).
 */
export function invalidateAdminCache(action?: string): void {
  if (!action) {
    cache.clear()
    return
  }
  for (const k of Array.from(cache.keys())) {
    if (k === action || k.startsWith(`${action}:`)) cache.delete(k)
  }
}
