import type { VercelRequest, VercelResponse } from '@vercel/node'
import { loadCurrentPricing } from './_paypal'

/**
 * GET /api/pricing
 *
 * Public read of the current monthly+yearly pricing. The website's
 * BuyPage and Hero CTA fetch from here. The actual fetch logic +
 * fallback live in `_paypal.ts`'s `loadCurrentPricing` so other
 * server endpoints can share it without one serverless function
 * file importing from another (which broke the runtime with
 * FUNCTION_INVOCATION_FAILED — Vercel doesn't bundle cross-
 * function imports cleanly).
 *
 * Cached at the Vercel edge for 60s with stale-while-revalidate
 * for an hour so admin price changes propagate within a minute
 * and the buy page never blocks on a backend round-trip.
 */

// Re-export so existing imports `from './pricing'` keep working
// for any code paths I haven't migrated. (Cleaner long-term: every
// caller imports straight from `./_paypal`, but the re-export
// stops anything from breaking during the migration window.)
export { loadCurrentPricing }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const pricing = await loadCurrentPricing()
  res.setHeader(
    'Cache-Control',
    'public, max-age=0, s-maxage=60, stale-while-revalidate=3600',
  )
  return res.status(200).json({ ok: true, ...pricing })
}
