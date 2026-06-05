import { useEffect, useState } from 'react'
import { RefreshCw, Loader2, AlertTriangle, Coins } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

type Money = Record<string, number>
interface PartnerRow {
  code: string
  name: string
  amount: Money
}
interface MonthRow {
  month: string
  gross: Money
  fee: Money
  net: Money
  partners: PartnerRow[]
  ownerFinal: Money
}
interface RevenueReport {
  months: MonthRow[]
  totals: {
    gross: Money
    fee: Money
    net: Money
    partners: PartnerRow[]
    ownerFinal: Money
  }
  cloudflare?: {
    costUsd: number
    costIls: number
    fxRate: number
  }
}

const SYM: Record<string, string> = { ILS: '₪', USD: '$', EUR: '€' }
function fmt(m?: Money): string {
  const parts = Object.entries(m || {})
    .filter(([, v]) => Math.abs(v) > 0.001)
    .map(([c, v]) => `${v.toFixed(2)} ${SYM[c] || c}`)
  return parts.length ? parts.join(' · ') : '—'
}
function fmtMonth(m: string): string {
  if (m === 'unknown') return 'ללא תאריך'
  return `${m.slice(5, 7)}/${m.slice(0, 4)}`
}
/** Subtract a ₪ amount (the converted Cloudflare cost) from the ILS
 *  bucket of a multi-currency Money, leaving other currencies intact. */
function subtractIls(m: Money | undefined, ils: number): Money {
  const out: Money = { ...(m || {}) }
  if (ils) out.ILS = (out.ILS || 0) - ils
  return out
}
/** Sum a list of multi-currency Money objects into one. */
function sumMoney(list: Money[]): Money {
  const out: Money = {}
  for (const m of list)
    for (const [c, v] of Object.entries(m || {})) out[c] = (out[c] || 0) + v
  return out
}

export default function RevenueTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [data, setData] = useState<RevenueReport | null>(null)
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      const r = await adminApi<RevenueReport>('admin-revenue-report')
      setData(r)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'טעינה נכשלה')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">הכנסות</h2>
          <p className="mt-1 text-sm text-fg-muted">
            כל ההכנסות, עמלות PayPal, חלוקה לשותפים והשורה התחתונה — לפי חודשים.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
        >
          <RefreshCw className="h-3.5 w-3.5" /> רענן
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {data === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : (
        <>
          {/* Profit waterfall — gross → −fees → −partners → −Cloudflare
              → what's left. One clean top-to-bottom flow, no repetition. */}
          <PnLCard totals={data.totals} cloudflare={data.cloudflare} />

          {/* Per-partner totals */}
          {data.totals.partners.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-fg">
                <Coins className="h-4 w-4 text-primary" />
                מגיע לשותפים (סה״כ)
              </div>
              <div className="space-y-1.5">
                {data.totals.partners.map((p) => (
                  <div
                    key={p.code}
                    className="flex items-center justify-between rounded-lg bg-background px-3 py-2 text-sm"
                  >
                    <span className="text-fg">{p.name}</span>
                    <span className="font-medium text-fg" dir="ltr">
                      {fmt(p.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-month breakdown */}
          {data.months.length === 0 ? (
            <div className="rounded-2xl border border-border py-10 text-center text-sm text-fg-muted">
              אין עדיין הכנסות.
            </div>
          ) : (
            <div className="space-y-3">
              {data.months.map((m) => (
                <div
                  key={m.month}
                  className="rounded-2xl border border-border bg-card p-5"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-display text-lg text-fg">
                      {fmtMonth(m.month)}
                    </span>
                    <span className="text-xs text-fg-muted">
                      נשאר לך: <span className="text-fg">{fmt(m.ownerFinal)}</span>
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Mini label="ברוטו" value={fmt(m.gross)} />
                    <Mini label="עמלת PayPal" value={fmt(m.fee)} />
                    <Mini label="נטו" value={fmt(m.net)} />
                  </div>
                  {m.partners.length > 0 && (
                    <div className="mt-3 space-y-1 border-t border-border pt-3">
                      <div className="text-[11px] uppercase tracking-wide text-fg-muted">
                        חלוקה לשותפים
                      </div>
                      {m.partners.map((p) => (
                        <div
                          key={p.code}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="text-fg-muted">{p.name}</span>
                          <span className="text-fg" dir="ltr">
                            {fmt(p.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ── Profit waterfall ─────────────────────────────────────────────
 *  One coherent P&L statement read top-to-bottom: every line is a
 *  single step, deductions are marked with "−" + an arrow, subtotals
 *  get a divider, and the final take is the hero row. Replaces the old
 *  4-card grid + separate bottom-line box (which repeated "אחרי
 *  שותפים" twice). */
function PnLCard({
  totals,
  cloudflare,
}: {
  totals: RevenueReport['totals']
  cloudflare?: RevenueReport['cloudflare']
}) {
  const partnerTotal = sumMoney(totals.partners.map((p) => p.amount))
  const finalNet = subtractIls(totals.ownerFinal, cloudflare?.costIls || 0)
  const cfValue = cloudflare
    ? `${cloudflare.costUsd.toFixed(2)} $ ≈ ${cloudflare.costIls.toFixed(2)} ₪`
    : '—'
  const cfState =
    cloudflare && cloudflare.costUsd > 0
      ? 'מעל החינם'
      : '$0 — מתחת ל-10GB החינמיים'
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3.5">
        <h3 className="text-sm font-semibold text-fg">שורת רווח</h3>
        <p className="mt-0.5 text-[11px] text-fg-faint">
          מהברוטו ועד מה שנשאר לך ביד
        </p>
      </div>
      <div className="px-5 py-1.5">
        <PnLRow label="הכנסות ברוטו" value={fmt(totals.gross)} />
        <PnLRow label="עמלות PayPal" value={fmt(totals.fee)} deduct />
        <PnLRow label="נטו (אחרי PayPal)" value={fmt(totals.net)} subtotal />
        <PnLRow label="חלוקה לשותפים" value={fmt(partnerTotal)} deduct />
        <PnLRow
          label="עלות Cloudflare (חודשי)"
          value={cfValue}
          deduct
        />
        <PnLRow label="נשאר לך נטו" value={fmt(finalNet)} hero />
      </div>
      <div className="border-t border-border bg-background/40 px-5 py-2.5">
        <p className="text-[10px] leading-relaxed text-fg-faint">
          ההכנסות מצטברות מתחילת הפעילות; עלות Cloudflare היא חודשית שוטפת
          (R2 — תשלום לפי שימוש; כרגע {cfState})
          {cloudflare ? `, שער המרה ≈ ${cloudflare.fxRate.toFixed(2)} ₪/$` : ''}.
        </p>
      </div>
    </div>
  )
}

function PnLRow({
  label,
  value,
  deduct,
  subtotal,
  hero,
}: {
  label: string
  value: string
  deduct?: boolean
  subtotal?: boolean
  hero?: boolean
}) {
  return (
    <div
      className={
        'flex items-center justify-between gap-3 ' +
        (hero
          ? 'mt-1.5 rounded-xl bg-success/[0.08] px-3 py-3'
          : 'px-1 py-2.5') +
        (subtotal ? ' border-t border-border' : '')
      }
    >
      <span
        className={
          'flex items-center gap-1.5 text-sm ' +
          (hero
            ? 'font-bold text-fg'
            : subtotal
              ? 'font-medium text-fg'
              : 'text-fg-muted')
        }
      >
        {deduct && (
          <span className="text-fg-faint" aria-hidden>
            ↓
          </span>
        )}
        {label}
      </span>
      <span
        dir="ltr"
        className={
          'tabular-nums ' +
          (hero
            ? 'text-xl font-bold text-success'
            : deduct
              ? 'text-fg-muted'
              : subtotal
                ? 'text-base font-semibold text-fg'
                : 'text-base text-fg')
        }
      >
        {deduct && value !== '—' ? `− ${value}` : value}
      </span>
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background px-2 py-2">
      <div className="text-sm font-medium text-fg">{value}</div>
      <div className="text-[10px] text-fg-muted">{label}</div>
    </div>
  )
}
