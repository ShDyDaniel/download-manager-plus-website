import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { VercelRequest } from '@vercel/node'

/**
 * Shared rate-limit primitives for /api endpoints.
 *
 * Vercel doesn't route files under `api/_lib/` because the underscore
 * prefix opts them out of function registration — safe place for
 * shared helpers.
 *
 * Backed by Upstash Redis (free tier handles >10k requests/day,
 * which is well past anything this app will see). `Redis.fromEnv()`
 * reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN; if
 * either is missing, we fall back to "no rate limiting" rather than
 * crashing the endpoint — so a misconfigured deploy still works,
 * just without abuse protection. The endpoint should log when this
 * happens so we notice.
 *
 * `Ratelimit.slidingWindow(N, '1 h')` allows N requests per rolling
 * one-hour window per key, which is a better fit than fixed windows
 * (no "burst at the boundary" effect).
 */

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN

const redis = url && token ? new Redis({ url, token }) : null

if (!redis) {
  console.warn(
    'rate-limit: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — endpoints will run WITHOUT rate limiting',
  )
}

/** Build a rate limiter with a given budget. Returns `null` when
 *  Redis isn't configured so callers can short-circuit. */
function buildLimiter(
  budget: number,
  window: '1 h' | '15 m' | '1 m',
  prefix: string,
): Ratelimit | null {
  if (!redis) return null
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(budget, window),
    prefix,
    analytics: false,
  })
}

// Pre-built limiters per endpoint. Keep the budgets aggressive
// enough that real users never hit them; the goal is to slow down
// scripts, not to ration the API.
//
// reset-password:
//   - 5 per email per hour → prevents email bombing a single victim
//   - 20 per IP per hour   → prevents one attacker spraying many
//                            emails from the same connection
// capture:
//   - 30 per IP per hour   → an honest buyer hits this once per
//                            purchase; 30 leaves room for retries
//                            and shared-IP edge cases
export const resetPasswordEmailLimit = buildLimiter(
  5,
  '1 h',
  'reset-pwd:email',
)
export const resetPasswordIpLimit = buildLimiter(20, '1 h', 'reset-pwd:ip')
export const captureIpLimit = buildLimiter(30, '1 h', 'capture:ip')

/** Extract a stable client identifier from the request. Vercel
 *  proxies set `x-forwarded-for` to the real client IP (followed by
 *  proxy hops); the first comma-separated value is the source. */
export function clientIp(req: VercelRequest): string {
  const xff = req.headers['x-forwarded-for']
  const header = Array.isArray(xff) ? xff[0] : xff
  if (header) {
    const first = header.split(',')[0]?.trim()
    if (first) return first
  }
  // Vercel also exposes a more direct header in some environments.
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real) return real
  return 'unknown'
}

/** Run a limiter and return whether the request is allowed. When
 *  the limiter is null (Redis not configured) we allow — better to
 *  serve traffic than to fail closed on a missing env var. */
export async function check(
  limiter: Ratelimit | null,
  key: string,
): Promise<{ allowed: boolean; remaining: number; reset: number }> {
  if (!limiter) return { allowed: true, remaining: Infinity, reset: 0 }
  const result = await limiter.limit(key)
  return {
    allowed: result.success,
    remaining: result.remaining,
    reset: result.reset,
  }
}
