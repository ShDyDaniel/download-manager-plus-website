import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

/**
 * GET /api/pricing
 *
 * Public read of the current monthly+yearly pricing. The website's
 * BuyPage and Hero CTA fetch from here.
 *
 * IMPORTANT — DO NOT REFACTOR THE FIREBASE INIT INTO A SHARED MODULE.
 * Earlier versions imported `loadCurrentPricing` and the firebase
 * init helpers from `./_paypal` (later `../api-lib/paypal`). Both
 * caused FUNCTION_INVOCATION_FAILED at runtime even though local
 * type-check + build succeeded. Vercel's per-function bundler
 * doesn't reliably pull in cross-file helpers that aren't directly
 * referenced from a `default export` chain in some shapes. Keeping
 * Firebase init + the pricing reader inline here is the only
 * configuration we've confirmed works in production. Same pattern
 * is duplicated in capture.ts and paypal.ts for the same reason.
 *
 * Cached at the Vercel edge for 60s with stale-while-revalidate
 * for an hour so admin price changes propagate within a minute.
 */

const PRICING_DEFAULTS = {
  monthly: { regular: 9, sale: null as number | null },
  yearly: { regular: 60, sale: null as number | null },
  currency: 'ILS',
}

export interface LivePricing {
  monthly: { regular: number; sale: number | null }
  yearly: { regular: number; sale: number | null }
  currency: string
  saleLabel?: string
}

let firebaseApp: App | null = null
function getDb(): Firestore {
  if (!firebaseApp) {
    const existing = getApps()[0]
    if (existing) {
      firebaseApp = existing
    } else {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT
      if (!raw) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set')
      }
      firebaseApp = initializeApp({ credential: cert(JSON.parse(raw)) })
    }
  }
  return getFirestore(firebaseApp)
}

export async function loadCurrentPricing(): Promise<LivePricing> {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('pricing').get()
    if (!snap.exists) return { ...PRICING_DEFAULTS }
    const data = snap.data() as {
      monthly?: { regular?: unknown; sale?: unknown }
      yearly?: { regular?: unknown; sale?: unknown }
      currency?: unknown
      saleLabel?: unknown
    }
    const numOr = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
    return {
      monthly: {
        regular: numOr(data.monthly?.regular, PRICING_DEFAULTS.monthly.regular),
        sale: numOrNull(data.monthly?.sale),
      },
      yearly: {
        regular: numOr(data.yearly?.regular, PRICING_DEFAULTS.yearly.regular),
        sale: numOrNull(data.yearly?.sale),
      },
      currency:
        typeof data.currency === 'string' && data.currency
          ? data.currency
          : PRICING_DEFAULTS.currency,
      saleLabel:
        typeof data.saleLabel === 'string' && data.saleLabel.trim()
          ? data.saleLabel.trim()
          : undefined,
    }
  } catch (err) {
    console.error('[pricing] loadCurrentPricing failed:', err)
    return { ...PRICING_DEFAULTS }
  }
}

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
