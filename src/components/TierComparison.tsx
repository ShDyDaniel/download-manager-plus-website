import { useEffect, useState } from 'react'
import { Check, Loader2, Crown } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  PAID_TIERS,
  TIER_LABEL,
  DEFAULT_TIER_CONFIG,
  type Tier,
  type TierConfig,
} from '@/lib/tiers'

/**
 * The public tier comparison for the /buy page — Free / Basic / Pro / Ultra.
 * Prices + storage + quotas are the ADMIN-CONFIGURED live values (read from
 * the public `get-tiers` endpoint, falling back to code defaults). The feature
 * bullets are built from the matrix so the page always matches what each tier
 * actually unlocks.
 *
 * Selecting a paid tier calls `onChoose(tier, cycle)`. NOTE: real per-tier
 * PayPal checkout is wired in a later phase; today the host page's existing
 * checkout is the live purchase path.
 */

type Cfg = Record<Tier, TierConfig>
type Cycle = 'monthly' | 'yearly'

function fmtMinutes(sec: number | null): string {
  if (sec == null) return 'ללא הגבלה'
  const m = Math.round(sec / 60)
  if (m >= 60 && m % 60 === 0) return `${m / 60} שעות/חודש`
  return `${m} דק׳/חודש`
}
function fmtCount(n: number | null, unit: string): string {
  return n == null ? `${unit} ללא הגבלה` : `${n} ${unit}`
}

/** Cumulative highlight bullets per tier (each tier is "everything below + …"). */
function highlights(tier: Tier, c: TierConfig): string[] {
  switch (tier) {
    case 'free':
      return [
        'ניהול הורדות (עד 2 פרויקטים במקביל)',
        'הורדת קבצים מלאה (יוטיוב / דרייב)',
        'המרת קבצים (ללא כיווץ וידאו)',
        `תמלול חכם — ${fmtMinutes(c.transcriptionMonthlySec)}`,
        'הצעת מחיר אחת בחודש',
      ]
    case 'basic':
      return [
        'כל מה שבחינם, וגם:',
        'הצעות מחיר ללא הגבלה + כיווץ וידאו',
        `תמלול חכם — ${fmtMinutes(c.transcriptionMonthlySec)}`,
        `סבבי תיקונים + מסירה ללקוח (${c.storageGb}GB, ${c.maxRevisionProjects} פרויקט)`,
        'מעקב זמן עבודה',
      ]
    case 'pro':
      return [
        'כל מה שב-Basic, וגם:',
        'סנכרון אוטומטי',
        'תמלול ללא הגבלה + תכונות מתקדמות (דוברים, מדויק, מילון)',
        'העורך האוטומטי (AI) + AI יוצר',
        `${c.storageGb}GB אחסון · ${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
      ]
    case 'ultra':
      return [
        'כל מה שב-Pro, וגם:',
        `${c.storageGb}GB אחסון`,
        'מכסת טוקני AI מוגדלת',
      ]
  }
}

export default function TierComparison({
  currentTier,
  onChoose,
  buyable,
}: {
  currentTier?: Tier
  onChoose?: (tier: Exclude<Tier, 'free'>, cycle: Cycle) => void
  /** Tiers whose checkout is live right now; others render "בקרוב".
   *  Defaults to all paid tiers. */
  buyable?: ReadonlySet<Tier>
}) {
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_TIER_CONFIG)
  const [loading, setLoading] = useState(true)
  const [cycle, setCycle] = useState<Cycle>('yearly')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=get-tiers')
        const j = (await r.json().catch(() => null)) as { ok?: boolean; tiers?: Cfg } | null
        if (alive && j?.ok && j.tiers) setCfg(j.tiers)
      } catch {
        /* keep defaults */
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const order: Tier[] = ['free', ...PAID_TIERS]

  return (
    <div className="mb-10">
      {/* monthly / yearly toggle */}
      <div className="mb-6 flex justify-center">
        <div className="inline-flex rounded-xl border border-border bg-card p-0.5">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCycle(c)}
              className={cn(
                'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors',
                cycle === c ? 'bg-primary text-white' : 'text-fg-muted hover:text-fg',
              )}
            >
              {c === 'monthly' ? 'חודשי' : 'שנתי'}
              {c === 'yearly' && (
                <span className="ms-1.5 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  חיסכון
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {order.map((tier) => {
          const c = cfg[tier]
          const paid = tier !== 'free'
          const price = cycle === 'monthly' ? c.priceMonthly : c.priceYearly
          const isCurrent = currentTier === tier
          const isPro = tier === 'pro'
          return (
            <div
              key={tier}
              className={cn(
                'relative flex flex-col rounded-2xl border p-5',
                isPro ? 'border-primary/50 bg-primary/[0.05]' : 'border-border bg-card',
              )}
            >
              {isPro && (
                <div className="absolute -top-2.5 right-4 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  <Crown className="h-3 w-3" /> מומלץ
                </div>
              )}
              <div className="text-lg font-bold font-display text-fg">{TIER_LABEL[tier]}</div>

              <div className="mt-2 min-h-[2.5rem]">
                {tier === 'free' ? (
                  <span className="text-2xl font-bold text-fg">חינם</span>
                ) : loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
                ) : price > 0 ? (
                  <div className="flex items-baseline gap-1" dir="ltr">
                    <span className="text-2xl font-bold text-fg">₪{price}</span>
                    <span className="text-xs text-fg-muted">
                      /{cycle === 'monthly' ? 'חודש' : 'שנה'}
                    </span>
                  </div>
                ) : (
                  <span className="text-sm text-fg-muted">בקרוב</span>
                )}
              </div>

              <ul className="mt-4 flex-1 space-y-2">
                {highlights(tier, c).map((h, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-fg-secondary">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5">
                {tier === 'free' ? (
                  <div className="rounded-xl border border-border px-3 py-2 text-center text-xs text-fg-muted">
                    ברירת המחדל
                  </div>
                ) : isCurrent ? (
                  <div className="rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-center text-xs font-semibold text-primary">
                    המנוי הנוכחי שלך
                  </div>
                ) : (
                  (() => {
                    const canBuy =
                      paid && price > 0 && !!onChoose && (buyable ? buyable.has(tier) : true)
                    return (
                      <button
                        type="button"
                        disabled={!canBuy}
                        onClick={() =>
                          canBuy && onChoose?.(tier as Exclude<Tier, 'free'>, cycle)
                        }
                        className={cn(
                          'w-full rounded-xl px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          isPro
                            ? 'bg-primary text-white hover:bg-primary/90'
                            : 'border border-primary/40 text-fg hover:bg-primary/10',
                        )}
                      >
                        {canBuy ? 'בחירת המסלול' : 'בקרוב'}
                      </button>
                    )
                  })()
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
