import { useEffect, useState } from 'react'

/**
 * Shared pricing utilities — used by both the Hero CTA ("starting
 * from X ₪/month") and the BuyPage (plan cards + PayPal flow).
 *
 * Single source of truth for:
 *   - The wire shape we get back from /api/pricing
 *   - The default values we fall back to when the API is down
 *   - The "effective price" rule (sale if active, else regular)
 *   - The "starting from per-month" calculation used in the Hero
 *
 * Putting these in one file means a future pricing tweak (e.g.
 * adding a quarterly plan, changing the per-month rounding) lands
 * in exactly one place rather than two.
 */

export interface PlanPricing {
  regular: number
  sale: number | null
}

export interface LivePricing {
  monthly: PlanPricing
  yearly: PlanPricing
  currency: string
  saleLabel?: string
}

export const DEFAULT_PRICING: LivePricing = {
  monthly: { regular: 9, sale: null },
  yearly: { regular: 60, sale: null },
  currency: 'ILS',
}

/** Visible currency glyph for the most common cases. Unknown
 *  codes fall back to the raw ISO string so they at least render
 *  something meaningful (e.g. "GBP"). */
export function currencySymbol(code: string): string {
  if (code === 'ILS') return '₪'
  if (code === 'USD') return '$'
  if (code === 'EUR') return '€'
  return code
}

/** Format a numeric price for display. Whole-shekel prices read
 *  cleaner as "9" than as "9.00"; non-integer prices keep two
 *  decimals but trim trailing zeros ("8.50" not "8.5", but "8.99"
 *  not "8.990"). */
export function formatPrice(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2).replace(/\.?0+$/, '')
}

/** The price the buyer actually pays for a given plan. */
export function effectivePrice(plan: PlanPricing): number {
  return plan.sale != null ? plan.sale : plan.regular
}

/** Compute the lowest per-month price across all plans, for use
 *  in landing-page "מ-X ₪/חודש" copy. We compare the monthly
 *  plan's effective price against (yearly effective price / 12)
 *  and return the smaller. Two-decimal precision because typical
 *  yearly-divided-by-12 values are like 5.00 or 3.25, not whole
 *  numbers, and rounding to int hides the actual deal. */
export function minPricePerMonth(p: LivePricing): number {
  const monthlyEff = effectivePrice(p.monthly)
  const yearlyEffPerMonth = effectivePrice(p.yearly) / 12
  const min = Math.min(monthlyEff, yearlyEffPerMonth)
  return Math.round(min * 100) / 100
}

/** Fetch the live pricing from the consolidated PayPal dispatcher.
 *  Used to be a dedicated /api/pricing endpoint; folded into
 *  /api/paypal?action=get-pricing when revisions.ts was added so
 *  the Vercel Hobby 12-function cap had room. Response shape is
 *  unchanged. Never throws — on any failure (network down, server
 *  500, bad JSON) returns DEFAULT_PRICING so the page still
 *  renders something sensible. */
export async function fetchLivePricing(): Promise<LivePricing> {
  try {
    const r = await fetch('/api/paypal?action=get-pricing', { cache: 'no-store' })
    if (!r.ok) return DEFAULT_PRICING
    const json = (await r.json()) as
      | ({ ok: true } & LivePricing)
      | { ok: false; error?: string }
    if (!json.ok) return DEFAULT_PRICING
    return {
      monthly: json.monthly,
      yearly: json.yearly,
      currency: json.currency,
      saleLabel: json.saleLabel,
    }
  } catch {
    return DEFAULT_PRICING
  }
}

/** localStorage key for the cached pricing snapshot. Bumping the
 *  version forces a cache invalidation if the pricing shape ever
 *  changes — readers that get an unparseable / wrong-shape blob
 *  just ignore it and fall back to the network fetch. */
const PRICING_CACHE_KEY = 'dmplus.pricing.v1'

export function readPricingCache(): LivePricing | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PRICING_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LivePricing>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.monthly ||
      !parsed.yearly ||
      typeof parsed.monthly.regular !== 'number' ||
      typeof parsed.yearly.regular !== 'number' ||
      typeof parsed.currency !== 'string'
    ) {
      return null
    }
    return parsed as LivePricing
  } catch {
    return null
  }
}

export function writePricingCache(p: LivePricing): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PRICING_CACHE_KEY, JSON.stringify(p))
  } catch {
    // Ignore — quota exceeded / private-browsing storage off.
    // Caching is best-effort; the fetch path still works.
  }
}

/** React hook — fetches the live pricing and returns it. Strategy:
 *
 *   1. On mount, synchronously read the most recently-cached
 *      pricing from localStorage. If present, that's the initial
 *      state — returning visitors see the right prices on the very
 *      first render with zero flash.
 *   2. Regardless, fire a background `/api/pricing` fetch and update
 *      state + cache if the response differs. Catches the case where
 *      the admin changed prices since the user's last visit.
 *   3. Returns `null` only on the very-first-ever visit (no cache,
 *      no fetch yet) so callers know to show a skeleton instead of
 *      flashing the hardcoded DEFAULT_PRICING. Callers that prefer
 *      a default fallback can do `pricing ?? DEFAULT_PRICING`. */
export function useLivePricing(): LivePricing | null {
  const [pricing, setPricing] = useState<LivePricing | null>(() =>
    readPricingCache(),
  )
  useEffect(() => {
    let alive = true
    void fetchLivePricing().then((p) => {
      if (!alive) return
      setPricing(p)
      writePricingCache(p)
    })
    return () => {
      alive = false
    }
  }, [])
  return pricing
}
