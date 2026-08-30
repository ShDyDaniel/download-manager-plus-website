import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  PAID_TIERS,
  TIER_LABEL,
  DEFAULT_TIER_CONFIG,
  tierAllows,
  tierPrice,
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
/** GB value → "NGB" / "ללא הגבלה" (null) / "—" (0). */
function fmtGb(v: number | null): string {
  return v == null ? 'ללא הגבלה' : v > 0 ? `${v}GB` : '—'
}

/** One-line positioning per tier. */
const TAGLINE: Record<Tier, string> = {
  free: 'להתחיל לעבוד — בלי לשלם',
  basic: 'עבודת לקוחות בקנה מידה קטן',
  pro: 'הערכת העריכה המלאה + AI',
  ultra: 'העוצמה המלאה, בלי גבולות',
}

/** The tier just below — for the cumulative "includes everything in X" note. */
const PREV_TIER: Partial<Record<Tier, Tier>> = {
  basic: 'free',
  pro: 'basic',
  ultra: 'pro',
}

/** Feature bullets per tier (the cumulative "includes X" note is shown
 *  separately, above the bullets). */
function highlights(tier: Tier, c: TierConfig): string[] {
  switch (tier) {
    case 'free':
      return [
        'ניהול הורדות (עד 2 פרויקטים)',
        'הורדת קבצים מלאה — יוטיוב / דרייב',
        'המרת קבצים',
        `תמלול חכם — ${fmtMinutes(c.transcriptionMonthlySec)}`,
        'הצעת מחיר אחת בחודש',
      ]
    case 'basic':
      return [
        'הצעות מחיר ללא הגבלה',
        'כיווץ וידאו',
        `סבבי תיקונים + מסירה ללקוח — ${fmtGb(c.storageGb)}`,
        `${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
        `תמלול חכם — ${fmtMinutes(c.transcriptionMonthlySec)}`,
        'מעקב זמן עבודה',
      ]
    case 'pro':
      return [
        'סנכרון אוטומטי',
        'תמלול ללא הגבלה + מתקדם (דוברים, מדויק, מילון)',
        'העורך האוטומטי (AI) + AI יוצר',
        `${fmtGb(c.storageGb)} אחסון`,
        `${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
      ]
    case 'ultra':
      return [
        `${fmtGb(c.storageGb)} אחסון — הגדול ביותר`,
        'מכסת טוקני AI מוגדלת לעורך ול-AI יוצר',
        `${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
        'עדיפות בתמיכה',
      ]
  }
}

/* ── Full feature-comparison table ─────────────────────────────────────── */
function yes() {
  return <Check className="mx-auto h-4 w-4 text-primary" />
}
function no() {
  return <span className="text-fg-faint">—</span>
}

const TABLE_ROWS: { label: string; render: (t: Tier, c: TierConfig) => ReactNode }[] = [
  { label: 'ניהול הורדות', render: () => yes() },
  { label: 'הורדת קבצים (יוטיוב / דרייב)', render: () => yes() },
  { label: 'המרת קבצים', render: () => yes() },
  {
    label: 'פרויקטי הורדה במקביל',
    render: (_t, c) => (c.maxDownloadProjects == null ? 'ללא הגבלה' : String(c.maxDownloadProjects)),
  },
  {
    label: 'הצעות מחיר',
    render: (_t, c) => (c.quotesPerMonth == null ? 'ללא הגבלה' : `${c.quotesPerMonth} בחודש`),
  },
  { label: 'כיווץ וידאו', render: (t) => (tierAllows(t, 'compress') ? yes() : no()) },
  { label: 'תמלול חכם', render: (_t, c) => fmtMinutes(c.transcriptionMonthlySec) },
  {
    label: 'תמלול מתקדם (דוברים, מדויק, מילון)',
    render: (t) => (tierAllows(t, 'transcriptionAdvanced') ? yes() : no()),
  },
  { label: 'סנכרון אוטומטי', render: (t) => (tierAllows(t, 'sync') ? yes() : no()) },
  { label: 'סבבי תיקונים', render: (t) => (tierAllows(t, 'revisions') ? yes() : no()) },
  { label: 'מסירה ללקוח', render: (t) => (tierAllows(t, 'deliveries') ? yes() : no()) },
  { label: 'מעקב זמן עבודה', render: (t) => (tierAllows(t, 'timeTracking') ? yes() : no()) },
  { label: 'חוקי מיון בהורדות', render: (t) => (tierAllows(t, 'routingRules') ? yes() : no()) },
  { label: 'העורך האוטומטי (AI)', render: (t) => (tierAllows(t, 'autoEditor') ? yes() : no()) },
  { label: 'AI יוצר', render: (t) => (tierAllows(t, 'aiCreator') ? yes() : no()) },
  {
    label: 'אחסון (תיקונים + מסירה)',
    render: (_t, c) => (c.storageGb == null ? 'ללא הגבלה' : c.storageGb > 0 ? `${c.storageGb}GB` : no()),
  },
  {
    label: 'פרויקטים במקביל (תיקונים / מסירה)',
    render: (_t, c) =>
      c.maxRevisionProjects == null
        ? 'ללא הגבלה'
        : c.maxRevisionProjects > 0
          ? String(c.maxRevisionProjects)
          : no(),
  },
  {
    label: 'מכסת טוקני AI לחודש',
    render: (_t, c) =>
      c.aiMonthlyTokens == null
        ? 'ללא הגבלה'
        : c.aiMonthlyTokens > 0
          ? c.aiMonthlyTokens.toLocaleString('en-US')
          : no(),
  },
]

function FeatureTable({ cfg, order }: { cfg: Record<Tier, TierConfig>; order: Tier[] }) {
  return (
    <div className="mt-12">
      <h3 className="mb-4 text-center font-display text-xl font-bold text-fg">
        השוואה מלאה
      </h3>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[640px] border-collapse text-sm" dir="rtl">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="px-4 py-3 text-right font-semibold text-fg-muted">תכונה</th>
              {order.map((t) => (
                <th key={t} className="px-3 py-3 text-center font-bold text-fg">
                  {TIER_LABEL[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TABLE_ROWS.map((row, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-2.5 text-right text-fg-secondary">{row.label}</td>
                {order.map((t) => (
                  <td key={t} className="px-3 py-2.5 text-center text-fg">
                    {row.render(t, cfg[t])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
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
        const r = await fetch('/api/paypal?action=get-tiers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
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

  // Yearly savings vs paying monthly (from the Pro tier). Shown as a badge
  // only when it's a sane, positive number.
  const pm = cfg.pro.priceMonthly
  const py = cfg.pro.priceYearly
  const savingsPct =
    pm > 0 && py > 0 && py < pm * 12 ? Math.round((1 - py / (pm * 12)) * 100) : 0
  const showSavings = savingsPct > 0 && savingsPct <= 70

  return (
    <div className="mb-10">
      {/* monthly / yearly toggle — segmented control with slightly-squared,
          concentric corners. Outer radius (rounded-2xl = 16px) minus the 4px
          (p-1) inset equals the inner radius (rounded-xl = 12px), so the
          sliding thumb sits flush inside the track. */}
      <div className="mb-8 flex justify-center">
        <div className="relative inline-flex rounded-2xl border border-border bg-card p-1">
          {(['monthly', 'yearly'] as const).map((c) => {
            const active = cycle === c
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCycle(c)}
                className="relative z-10 inline-flex items-center justify-center gap-2.5 rounded-xl px-8 py-3 text-base font-semibold leading-none"
              >
                {active && (
                  <motion.span
                    layoutId="cyclePill"
                    className="absolute inset-0 -z-10 rounded-xl bg-primary"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
                <span
                  className={cn(
                    'transition-colors',
                    active ? 'text-white' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {c === 'monthly' ? 'חודשי' : 'שנתי'}
                </span>
                {c === 'yearly' && showSavings && (
                  <span
                    dir="ltr"
                    className={cn(
                      'inline-flex items-center rounded-md px-2.5 py-1 text-sm font-bold leading-none transition-colors',
                      active ? 'bg-white/20 text-white' : 'bg-primary/15 text-primary',
                    )}
                  >
                    -{savingsPct}%
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {order.map((tier) => {
          const c = cfg[tier]
          const paid = tier !== 'free'
          const pr = tierPrice(c, cycle) // { regular, sale, effective }
          const price = pr.effective
          const isCurrent = currentTier === tier
          return (
            <div
              key={tier}
              className="relative flex flex-col rounded-2xl border border-border bg-card p-5"
            >
              <div className="text-lg font-bold font-display text-fg">{TIER_LABEL[tier]}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-fg-muted">{TAGLINE[tier]}</div>

              <div className="mt-3 min-h-[3rem] border-b border-border/60 pb-3">
                {tier === 'free' ? (
                  <span className="text-3xl font-extrabold text-fg">חינם</span>
                ) : loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
                ) : price > 0 ? (
                  // Price FIRST, then the period. AnimatePresence fades the
                  // amount when the buyer flips monthly ↔ yearly.
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={cycle}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.18 }}
                      className="flex items-baseline gap-1.5"
                      dir="rtl"
                    >
                      <span className="text-3xl font-extrabold text-fg" dir="ltr">
                        ₪{price}
                      </span>
                      {pr.sale != null && (
                        <span className="text-sm text-fg-faint line-through" dir="ltr">
                          ₪{pr.regular}
                        </span>
                      )}
                      <span className="text-xs text-fg-muted">
                        {cycle === 'monthly' ? '/ לחודש' : '/ לשנה'}
                      </span>
                    </motion.div>
                  </AnimatePresence>
                ) : (
                  <span className="inline-flex items-center rounded-md bg-bg-elevated px-2 py-0.5 text-xs text-fg-muted">
                    בקרוב
                  </span>
                )}
              </div>

              {PREV_TIER[tier] && (
                <div className="mt-3 text-[11px] font-medium text-primary">
                  כולל את כל מה שב-{TIER_LABEL[PREV_TIER[tier] as Tier]}, ובנוסף:
                </div>
              )}

              <ul className={cn('flex-1 space-y-2', PREV_TIER[tier] ? 'mt-2' : 'mt-3')}>
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
                        className="w-full rounded-xl border border-primary/40 px-3 py-2 text-sm font-semibold text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
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

      <FeatureTable cfg={cfg} order={order} />
    </div>
  )
}
