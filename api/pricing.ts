import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * GET /api/pricing
 *
 * Returns the current monthly+yearly pricing for /buy to display
 * and for the BuyPage's PayPal flow to feed into the order amount.
 * The doc lives at `appConfig/pricing` in Firestore and is admin-
 * controlled from the desktop app's admin panel.
 *
 * Why this exists as a Vercel endpoint instead of the website
 * reading Firestore directly:
 *   - Website visitors aren't authenticated; the Firestore rules
 *     gate `appConfig` reads on auth.
 *   - Pricing should be readable by anyone, but Firestore rules
 *     can't easily express "auth required for everything in
 *     appConfig EXCEPT pricing" cleanly. Easier to keep the rules
 *     auth-only and proxy the public read here.
 *   - Server-side caching: we set Cache-Control so Vercel serves
 *     this from its edge cache for ~60 seconds, sparing Firestore
 *     reads when the buy page gets hit a lot.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     monthly: { regular: 9, sale: null | 7 },
 *     yearly: { regular: 60, sale: null | 39 },
 *     currency: "ILS",
 *     saleLabel: "מבצע חורף" | undefined
 *   }
 *
 * On any failure (missing doc, Firebase error), we fall back to
 * the hardcoded defaults — the buy page should NEVER show "broken"
 * because of a backend hiccup. The fallback is the original
 * pre-feature pricing so a complete outage just reverts to that.
 */

const DEFAULTS = {
  monthly: { regular: 9, sale: null as number | null },
  yearly: { regular: 60, sale: null as number | null },
  currency: 'ILS',
}

let firebaseApp: App | null = null

function getFirebase(): App {
  if (firebaseApp) return firebaseApp
  const existing = getApps()[0]
  if (existing) {
    firebaseApp = existing
    return firebaseApp
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set')
  }
  firebaseApp = initializeApp({ credential: cert(JSON.parse(raw)) })
  return firebaseApp
}

/** Re-export the resolver so capture.ts can call it without
 *  duplicating the Firestore-fetch + fallback logic. Keeps the
 *  "what's the current price for plan X" answer in one place. */
export async function loadCurrentPricing(): Promise<{
  monthly: { regular: number; sale: number | null }
  yearly: { regular: number; sale: number | null }
  currency: string
  saleLabel?: string
}> {
  try {
    const db = getFirestore(getFirebase())
    const snap = await db.collection('appConfig').doc('pricing').get()
    if (!snap.exists) return { ...DEFAULTS }
    const data = snap.data() as {
      monthly?: { regular?: unknown; sale?: unknown }
      yearly?: { regular?: unknown; sale?: unknown }
      currency?: unknown
      saleLabel?: unknown
    }
    // Defensive coercion — any non-number in the regular field
    // falls back to the default so /buy never crashes. Sale falls
    // back to null (i.e. "no sale") to be conservative.
    const numOr = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
    return {
      monthly: {
        regular: numOr(data.monthly?.regular, DEFAULTS.monthly.regular),
        sale: numOrNull(data.monthly?.sale),
      },
      yearly: {
        regular: numOr(data.yearly?.regular, DEFAULTS.yearly.regular),
        sale: numOrNull(data.yearly?.sale),
      },
      currency:
        typeof data.currency === 'string' && data.currency
          ? data.currency
          : DEFAULTS.currency,
      saleLabel:
        typeof data.saleLabel === 'string' && data.saleLabel.trim()
          ? data.saleLabel.trim()
          : undefined,
    }
  } catch (err) {
    console.error('[pricing] loadCurrentPricing failed:', err)
    return { ...DEFAULTS }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const pricing = await loadCurrentPricing()
  // Cache for 60 seconds at the edge, with stale-while-revalidate
  // up to an hour so the buy page never blocks on a backend round-
  // trip. Pricing changes propagate within a minute.
  res.setHeader(
    'Cache-Control',
    'public, max-age=0, s-maxage=60, stale-while-revalidate=3600',
  )
  return res.status(200).json({ ok: true, ...pricing })
}
