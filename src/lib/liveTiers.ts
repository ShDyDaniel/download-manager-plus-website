import { useEffect, useState } from 'react'
import type { Tier, TierConfig } from './tiers'

/**
 * The admin-configured tier prices and quotas, from the public `get-tiers`
 * endpoint — the same source the /buy page charges from. Anything on the site
 * that quotes a price must read it here, never the legacy `get-pricing`
 * record (its ₪45/₪290 numbers no longer exist).
 *
 * Returns null until the first answer arrives, so callers can leave a price
 * out rather than flash a default that may be wrong.
 */
export function useLiveTiers(): Record<Tier, TierConfig> | null {
  const [cfg, setCfg] = useState<Record<Tier, TierConfig> | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=get-tiers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const j = (await r.json().catch(() => null)) as {
          ok?: boolean
          tiers?: Record<Tier, TierConfig>
        } | null
        if (alive && j?.ok && j.tiers) setCfg(j.tiers)
      } catch {
        /* no price line is better than a wrong one */
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  return cfg
}
