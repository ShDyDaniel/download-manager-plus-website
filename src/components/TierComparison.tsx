import { useEffect, useState, type ReactNode } from 'react'
import { Check, Download } from 'lucide-react'
import { Seg } from './site/Seg'
import { useDownload } from './site/DownloadGate'
import { formatPrice } from '@/lib/pricing'
import {
  PAID_TIERS,
  TIER_LABEL,
  DEFAULT_TIER_CONFIG,
  tierAllows,
  tierPrice,
  TIER_DEVICE_SEATS,
  type Tier,
  type TierConfig,
} from '@/lib/tiers'

/**
 * The public tier comparison for the /buy page — Free / Basic / Pro / Ultra:
 * the monthly/yearly toggle, the four tier cards (#plans) and the full table
 * (#compare). Styles: .pg-buy in src/styles/pages/buy.css.
 *
 * Prices + storage + quotas are the ADMIN-CONFIGURED live values (read from
 * the public `get-tiers` endpoint, falling back to code defaults, which carry
 * price 0 and so show "בקרוב"). The feature bullets are built from the matrix
 * so the page always matches what each tier actually unlocks.
 *
 * The cycle can be controlled by the host (`cycle` + `onCycleChange`) so the
 * toggle also drives the host's checkout. Selecting a paid tier calls
 * `onChoose(tier, cycle)`; the Free card starts the site-wide download flow.
 */

type Cfg = Record<Tier, TierConfig>
type Cycle = 'monthly' | 'yearly'

/** What a cycle costs per month, to the agora.
 *
 *  Exact rather than rounded: the checkout breaks the same figure back down
 *  into 12 payments, and a card that says ₪25 leading to a checkout that says
 *  ₪24.92 looks like a bait-and-switch over eight agorot. */
function perMonth(amount: number, cycle: Cycle): string {
  const v = cycle === 'yearly' ? amount / 12 : amount
  // Whole prices stay whole — "₪59" reads better than "₪59.00".
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/** What paying yearly saves against twelve monthly payments, per tier, from
 *  the live (sale-aware) prices. null when there is no honest saving to show. */
function yearlySaving(c: TierConfig): { amount: number; pct: number } | null {
  const m = tierPrice(c, 'monthly').effective
  const y = tierPrice(c, 'yearly').effective
  if (!(m > 0 && y > 0) || y >= m * 12) return null
  return {
    amount: Math.round((m * 12 - y) * 100) / 100,
    pct: Math.round((1 - y / (m * 12)) * 100),
  }
}

function fmtMinutes(sec: number | null): string {
  if (sec == null) return 'ללא הגבלה'
  const m = Math.round(sec / 60)
  if (m === 60) return 'שעה/חודש'
  if (m >= 60 && m % 60 === 0) return `${m / 60} שעות/חודש`
  return `${m} דק׳/חודש`
}
function fmtCount(n: number | null, unit: string): string {
  if (n === 1 && unit === 'פרויקטים') return 'פרויקט אחד'
  return n == null ? `${unit} ללא הגבלה` : `${n} ${unit}`
}
/** How many computers the plan covers, phrased for a buyer. */
function fmtSeats(n: number): string {
  return n === 1 ? 'מחשב אחד' : `${n} מחשבים`
}

/** GB value → "NGB" (kept LTR) / "ללא הגבלה" (null) / "—" (0). */
function gb(v: number | null): ReactNode {
  return v == null ? 'ללא הגבלה' : v > 0 ? <bdi>{v}GB</bdi> : '—'
}

/** One-line positioning per tier. */
const TAGLINE: Record<Tier, string> = {
  free: 'להתחיל לעבוד — בלי לשלם',
  basic: 'עבודת לקוחות בקנה מידה קטן',
  pro: 'ערכת העריכה המלאה',
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
function highlights(tier: Tier, c: TierConfig): ReactNode[] {
  switch (tier) {
    case 'free':
      return [
        'ניהול הורדות (עד 2 פרויקטים)',
        'הורדת קבצים מלאה — יוטיוב / דרייב',
        'המרת קבצים',
        `תמלול חכם — ${fmtMinutes(c.transcriptionMonthlySec)}`,
        'הצעת מחיר אחת בחודש',
        fmtSeats(TIER_DEVICE_SEATS.free),
      ]
    case 'basic':
      return [
        'הצעות מחיר ללא הגבלה',
        'כיווץ וידאו',
        <>סבבי תיקונים + מסירה ללקוח — {gb(c.storageGb)}</>,
        `${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
        `תמלול חכם — ${fmtMinutes(c.transcriptionMonthlySec)}`,
        'מעקב זמן עבודה',
        fmtSeats(TIER_DEVICE_SEATS.basic),
      ]
    case 'pro':
      return [
        'סנכרון אוטומטי',
        'תמלול ללא הגבלה + מתקדם (דוברים, מדויק, מילון)',
        <>{gb(c.storageGb)} אחסון</>,
        `${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
        fmtSeats(TIER_DEVICE_SEATS.pro),
      ]
    case 'ultra':
      return [
        <>{gb(c.storageGb)} אחסון — הגדול ביותר</>,
        `${fmtCount(c.maxRevisionProjects, 'פרויקטים')} במקביל`,
        fmtSeats(TIER_DEVICE_SEATS.ultra),
        'עדיפות בתמיכה',
      ]
  }
}

/* ── Full feature-comparison table ─────────────────────────────────────── */
/** A cell is a check (true), a dash (false) or a value. */
type Cell = boolean | ReactNode

const TABLE_GROUPS: {
  title: string
  rows: { label: string; render: (t: Tier, c: TierConfig) => Cell }[]
}[] = [
  {
    title: 'הורדות וקבצים',
    rows: [
      { label: 'ניהול הורדות', render: () => true },
      { label: 'הורדת קבצים (יוטיוב / דרייב)', render: () => true },
      { label: 'המרת קבצים', render: () => true },
      {
        label: 'פרויקטי הורדה במקביל',
        render: (_t, c) =>
          c.maxDownloadProjects == null ? 'ללא הגבלה' : String(c.maxDownloadProjects),
      },
      { label: 'חוקי מיון בהורדות', render: (t) => tierAllows(t, 'routingRules') },
      { label: 'כיווץ וידאו', render: (t) => tierAllows(t, 'compress') },
    ],
  },
  {
    title: 'הצעות מחיר וזמן עבודה',
    rows: [
      {
        label: 'הצעות מחיר',
        render: (_t, c) => (c.quotesPerMonth == null ? 'ללא הגבלה' : `${c.quotesPerMonth} בחודש`),
      },
      { label: 'מעקב זמן עבודה', render: (t) => tierAllows(t, 'timeTracking') },
    ],
  },
  {
    title: 'תמלול וסנכרון',
    rows: [
      { label: 'תמלול חכם', render: (_t, c) => fmtMinutes(c.transcriptionMonthlySec) },
      {
        label: 'תמלול מתקדם (דוברים, מדויק, מילון)',
        render: (t) => tierAllows(t, 'transcriptionAdvanced'),
      },
      { label: 'סנכרון אוטומטי', render: (t) => tierAllows(t, 'sync') },
    ],
  },
  {
    title: 'סבבי תיקונים ומסירה ללקוח',
    rows: [
      { label: 'סבבי תיקונים', render: (t) => tierAllows(t, 'revisions') },
      { label: 'מסירה ללקוח', render: (t) => tierAllows(t, 'deliveries') },
      {
        label: 'אחסון (תיקונים + מסירה)',
        render: (_t, c) =>
          c.storageGb == null ? 'ללא הגבלה' : c.storageGb > 0 ? <bdi>{c.storageGb}GB</bdi> : false,
      },
      {
        label: 'פרויקטים במקביל (תיקונים / מסירה)',
        render: (_t, c) =>
          c.maxRevisionProjects == null
            ? 'ללא הגבלה'
            : c.maxRevisionProjects > 0
              ? String(c.maxRevisionProjects)
              : false,
      },
    ],
  },
  {
    title: 'החשבון',
    rows: [{ label: 'מחשבים בחשבון', render: (t) => fmtSeats(TIER_DEVICE_SEATS[t]) }],
  },
]

function CellView({ v }: { v: Cell }) {
  if (v === true)
    return (
      <span className="yes">
        <Check className="ic" aria-hidden />
        <span className="sr">כלול</span>
      </span>
    )
  if (v === false)
    return (
      <>
        <span className="no" aria-hidden>
          —
        </span>
        <span className="sr">לא כלול</span>
      </>
    )
  return <>{v}</>
}

function FeatureTable({
  cfg,
  order,
  cycle,
  loading,
}: {
  cfg: Cfg
  order: Tier[]
  cycle: Cycle
  loading: boolean
}) {
  return (
    <section id="compare" className="sec">
      <div className="sec-head">
        <h2 className="h2">השוואה מלאה</h2>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <caption className="sr">השוואה מלאה בין התוכניות</caption>
          <thead>
            <tr>
              <th scope="col">תכונה</th>
              {order.map((t) => {
                const price = tierPrice(cfg[t], cycle).effective
                return (
                  <th key={t} scope="col" className={t === 'pro' ? 'pro' : undefined}>
                    {TIER_LABEL[t]}
                    <small key={cycle} data-fade="">
                      {t === 'free' ? (
                        <bdi dir="ltr" className="num">
                          ₪0
                        </bdi>
                      ) : loading ? (
                        ' '
                      ) : price > 0 ? (
                        <>
                          <bdi dir="ltr" className="num">
                            ₪{perMonth(price, cycle)}
                          </bdi>{' '}
                          לחודש
                        </>
                      ) : (
                        'בקרוב'
                      )}
                    </small>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {TABLE_GROUPS.map((g) => [
              <tr className="grp" key={g.title}>
                <td colSpan={order.length + 1}>
                  <span className="gl">{g.title}</span>
                </td>
              </tr>,
              ...g.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {order.map((t) => (
                    <td key={t} className={t === 'pro' ? 'pro' : undefined}>
                      <CellView v={row.render(t, cfg[t])} />
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <p className="foot">
        סבבי התיקונים והמסירה ללקוח משתמשים באותו נפח אחסון.
        <span className="vat"> המחירים כוללים מע״מ.</span>
      </p>
    </section>
  )
}

export default function TierComparison({
  currentTier,
  onChoose,
  buyable,
  cycle: cycleProp,
  onCycleChange,
}: {
  currentTier?: Tier
  onChoose?: (tier: Exclude<Tier, 'free'>, cycle: Cycle) => void
  /** Tiers whose checkout is live right now; others render "בקרוב".
   *  Defaults to all paid tiers. */
  buyable?: ReadonlySet<Tier>
  /** Controlled billing cycle (the host's checkout follows it). */
  cycle?: Cycle
  onCycleChange?: (c: Cycle) => void
}) {
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_TIER_CONFIG)
  const [loading, setLoading] = useState(true)
  const [ownCycle, setOwnCycle] = useState<Cycle>('yearly')
  const cycle = cycleProp ?? ownCycle
  const setCycle = (c: Cycle) => {
    setOwnCycle(c)
    onCycleChange?.(c)
  }
  const { requestDownload } = useDownload()

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

  // "Save up to X%" on the yearly option: the best saving among the paid
  // tiers, from the live prices. Shown only when it's a sane, positive number.
  const maxPct = loading
    ? 0
    : Math.max(0, ...PAID_TIERS.map((t) => yearlySaving(cfg[t])?.pct ?? 0))
  const showSavings = maxPct > 0 && maxPct <= 70

  return (
    <>
      <section id="plans" className="plans" aria-label="המסלולים">
        <div className="cyc">
          <Seg<Cycle>
            value={cycle}
            onChange={setCycle}
            label="מחזור חיוב"
            options={[
              { value: 'monthly', label: 'חודשי' },
              {
                value: 'yearly',
                label: (
                  <>
                    שנתי
                    {showSavings && (
                      <span className="save">
                        חיסכון של עד <bdi dir="ltr">{maxPct}%</bdi>
                      </span>
                    )}
                  </>
                ),
              },
            ]}
          />
        </div>

        <div className="grid g4 tiers">
          {order.map((tier) => {
            const c = cfg[tier]
            const paid = tier !== 'free'
            const pr = tierPrice(c, cycle) // { regular, sale, effective }
            const price = pr.effective
            const isCurrent = currentTier === tier
            const hot = tier === 'pro'
            const saving = paid && !loading && cycle === 'yearly' ? yearlySaving(c) : null
            const prev = PREV_TIER[tier]
            return (
              <article
                key={tier}
                className={`card tier${hot ? ' hot' : ''}`}
                aria-labelledby={`tier-${tier}`}
              >
                <div className="tier-h">
                  <h3 id={`tier-${tier}`}>{TIER_LABEL[tier]}</h3>
                  {saving && (
                    <span className="chip save-c" data-fade="">
                      חיסכון של{' '}
                      <bdi dir="ltr" className="num">
                        ₪{formatPrice(saving.amount)}
                      </bdi>{' '}
                      בשנה
                    </span>
                  )}
                </div>
                <p className="tag">{TAGLINE[tier]}</p>

                <div className="price">
                  {tier === 'free' ? (
                    <>
                      <div className="amt">
                        <bdi dir="ltr" className="num">
                          ₪0
                        </bdi>
                      </div>
                      <p className="bill">ללא חיוב</p>
                    </>
                  ) : loading ? (
                    <span className="spin" role="status" aria-label="טוען את המחיר" />
                  ) : price > 0 ? (
                    // Both cycles are quoted PER MONTH so the two are directly
                    // comparable. What is actually charged sits right under
                    // it — Israeli price rules want the full price (incl. VAT)
                    // as visible as the per-month one — and the ×12 is laid
                    // out in the order summary.
                    <div key={cycle} data-fade="">
                      <div className="amt">
                        <bdi dir="ltr" className="num">
                          ₪{perMonth(price, cycle)}
                        </bdi>
                        {pr.sale != null && (
                          <s className="was">
                            <bdi dir="ltr" className="num">
                              ₪{perMonth(pr.regular, cycle)}
                            </bdi>
                          </s>
                        )}
                        <small>/ לחודש</small>
                      </div>
                      <p className="bill">
                        {cycle === 'yearly' ? (
                          <>
                            חיוב שנתי של{' '}
                            <bdi dir="ltr" className="num">
                              ₪{formatPrice(price)}
                            </bdi>
                          </>
                        ) : (
                          'חיוב חודשי'
                        )}
                        <span className="vat"> · כולל מע״מ</span>
                      </p>
                    </div>
                  ) : (
                    <span className="pill">בקרוב</span>
                  )}
                </div>

                <p className="cum">
                  {prev ? `כולל את כל מה שב-${TIER_LABEL[prev]}, ובנוסף:` : ''}
                </p>

                <ul className="checks">
                  {highlights(tier, c).map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>

                <div className="go">
                  {isCurrent ? (
                    <span className="chip current">המנוי הנוכחי שלך</span>
                  ) : tier === 'free' ? (
                    <button
                      type="button"
                      className="btn btn-g btn-block"
                      onClick={() => requestDownload()}
                    >
                      <Download className="ic" aria-hidden />
                      הורדה חינם
                    </button>
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
                          className={`btn ${hot ? 'btn-p' : 'btn-s'} btn-block`}
                        >
                          {/* While prices load the button waits, disabled —
                              "בקרוב" is only for a tier with no price. */}
                          {canBuy || loading ? 'בחירת המסלול' : 'בקרוב'}
                        </button>
                      )
                    })()
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <FeatureTable cfg={cfg} order={order} cycle={cycle} loading={loading} />
    </>
  )
}
