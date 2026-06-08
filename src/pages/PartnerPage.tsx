import { useEffect, useState } from 'react'
import { Copy, Check, LogOut, X } from 'lucide-react'
import { AuthButton, AuthError, AuthHeader, AuthInput } from '../components/authUi'

/**
 * Partner dashboard (/partner) — a self-serve login where a referral
 * partner sees AGGREGATE stats for their own code: signups, paying
 * accounts, revenue total + by month, and their share link.
 *
 * Privacy: deliberately NO individual customer emails — only counts
 * and sums. The full per-user detail stays in the admin panel.
 *
 * Auth is separate from the customer session: a partner token (signed
 * server-side) lives in sessionStorage and is replayed to
 * partner-stats. Credentials are set by the admin per partner.
 */

const TOKEN_KEY = 'dmplus.partner.v1'

interface PartnerStats {
  code: string
  name: string
  link: string
  visibility: { revenue: boolean; earnings: boolean; counts: boolean }
  signups: number | null
  paidAccounts: number | null
  commission: {
    commissionType: 'percent' | 'fixed'
    commissionValue: number
    commissionCurrency: string
  } | null
  earningsByCurrency: Record<string, number> | null
  earningsByMonth: Record<string, Record<string, number>> | null
  /** What the earnings would have been WITHOUT any fee/VAT. */
  earningsGrossByCurrency?: Record<string, number> | null
  /** Total shaved off the partner's earnings (PayPal fee + VAT). */
  earningsFeeByCurrency?: Record<string, number> | null
  /** PayPal-fee portion of the deduction. */
  earningsPaypalFeeByCurrency?: Record<string, number> | null
  /** VAT portion of the deduction (only when receipts are OFF). */
  earningsVatByCurrency?: Record<string, number> | null
  /** Whether SUMIT receipts are on — when off, VAT is deducted too. */
  receiptsEnabled?: boolean
  revenueByCurrency: Record<string, number> | null
  revenueByMonth: Record<string, Record<string, number>> | null
}

const CUR_SYMBOL: Record<string, string> = { ILS: '₪', USD: '$', EUR: '€' }
function curSym(c: string): string {
  return CUR_SYMBOL[c] || c
}
function fmtMoney(m: Record<string, number>): string {
  const parts = Object.entries(m || {})
    .filter(([, v]) => v > 0)
    .map(([c, v]) => `${v.toFixed(2)} ${curSym(c)}`)
  return parts.length ? parts.join(' · ') : '—'
}
function commissionLabel(c: PartnerStats['commission']): string {
  if (!c) return 'ההסכם טרם הוגדר'
  return c.commissionType === 'percent'
    ? `${c.commissionValue}% מכל קנייה / חידוש`
    : `${c.commissionValue} ${curSym(c.commissionCurrency)} לכל קנייה / חידוש`
}

async function api<T>(action: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/paypal?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await r.json()) as T
}

export default function PartnerPage() {
  const [stats, setStats] = useState<PartnerStats | null>(null)
  const [booting, setBooting] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Resume an existing session.
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY)
    if (!token) {
      setBooting(false)
      return
    }
    void (async () => {
      const r = await api<
        { ok: true; partner: PartnerStats } | { ok: false; error: string }
      >('partner-stats', { token })
      if (r.ok) setStats(r.partner)
      else sessionStorage.removeItem(TOKEN_KEY)
      setBooting(false)
    })()
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await api<
      | { ok: true; token: string; partner: PartnerStats }
      | { ok: false; error: string }
    >('partner-login', { email, password })
    setBusy(false)
    if (!r.ok) {
      setError(r.error || 'ההתחברות נכשלה')
      return
    }
    sessionStorage.setItem(TOKEN_KEY, r.token)
    setStats(r.partner)
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY)
    setStats(null)
    setEmail('')
    setPassword('')
  }

  async function copyLink() {
    if (!stats) return
    try {
      await navigator.clipboard.writeText(stats.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  if (booting) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg text-sm text-fg-muted">
        טוען…
      </div>
    )
  }

  // ── Login ──
  if (!stats) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-5" dir="rtl">
        <div className="w-full max-w-sm">
          <AuthHeader label="— שותפים" title="כניסת שותפים" />
          <form onSubmit={handleLogin} className="space-y-5">
            <AuthInput
              label="אימייל"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              autoFocus
            />
            <AuthInput
              label="סיסמה"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
            {error && <AuthError message={error} />}
            <AuthButton busy={busy}>התחברות</AuthButton>
          </form>
          <p className="mt-6 text-center text-xs text-fg-muted">
            הגישה לשותפים בלבד. אם אין לכם פרטי כניסה, פנו אלינו.
          </p>
        </div>
      </div>
    )
  }

  // ── Dashboard ──
  // Which money breakdown to show by month (earnings preferred, else
  // gross revenue) — only when the partner is allowed to see it.
  const monthSource = stats.earningsByMonth || stats.revenueByMonth || null
  const monthsTitle = stats.earningsByMonth
    ? 'הרווח שלך לפי חודש'
    : 'הכנסות לפי חודש'
  const months = monthSource
    ? Object.entries(monthSource)
        .filter(([m]) => m !== 'unknown')
        .sort((a, b) => b[0].localeCompare(a[0]))
    : []
  const showMoney = stats.visibility.earnings || stats.visibility.revenue

  return (
    <div className="min-h-dvh bg-bg px-5 py-10 md:py-16" dir="rtl">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
              — דשבורד שותף
            </div>
            <h1
              className="font-display text-fg"
              style={{ fontSize: 'clamp(26px,4vw,36px)', fontWeight: 500 }}
            >
              {stats.name}
            </h1>
          </div>
          <button
            type="button"
            onClick={logout}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
          >
            <LogOut className="h-3.5 w-3.5" />
            התנתקות
          </button>
        </div>

        {/* Share link */}
        <div className="mb-6 rounded-2xl border border-border/60 bg-white/[0.015] p-4">
          <div className="mb-2 text-xs text-fg-muted">קישור ההפניה שלך</div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={stats.link}
              onFocus={(e) => e.currentTarget.select()}
              dir="ltr"
              className="flex-1 truncate rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg"
            />
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'הועתק' : 'העתק'}
            </button>
          </div>
        </div>

        {/* Commission agreement — only when earnings are shown */}
        {stats.visibility.earnings && (
          <div className="mb-6 rounded-2xl border border-border/60 bg-white/[0.015] px-4 py-3 text-sm">
            <span className="text-fg-muted">ההסכם שלך: </span>
            <span className="font-medium text-fg">
              {commissionLabel(stats.commission)}
            </span>
          </div>
        )}

        {/* Stats — RTL order (right→left): נרשמו · קנו · סך הכנסות ·
            סך הרווח שלך. In RTL the first DOM child renders on the
            right, so the DOM order below is the visual order. Each
            card shows only if the partner is allowed to see it. */}
        <div className="mb-6 grid auto-cols-fr grid-flow-col gap-3">
          {stats.signups !== null && (
            <Stat value={String(stats.signups)} label="נרשמו" />
          )}
          {stats.paidAccounts !== null && (
            <Stat value={String(stats.paidAccounts)} label="קנו" />
          )}
          {stats.visibility.revenue && stats.revenueByCurrency && (
            <Stat
              value={fmtMoney(stats.revenueByCurrency)}
              label="סך ההכנסות"
              wide
            />
          )}
          {stats.visibility.earnings && stats.earningsByCurrency && (
            <EarningsStat
              net={stats.earningsByCurrency}
              gross={stats.earningsGrossByCurrency}
              fee={stats.earningsFeeByCurrency}
              paypalFee={stats.earningsPaypalFeeByCurrency}
              vat={stats.earningsVatByCurrency}
              receiptsEnabled={stats.receiptsEnabled !== false}
            />
          )}
        </div>

        {/* Money by month — only when a money figure is visible */}
        {showMoney && (
          <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-5">
            <div className="mb-3 text-sm font-medium text-fg">{monthsTitle}</div>
            {months.length === 0 ? (
              <div className="py-6 text-center text-sm text-fg-muted">
                עדיין אין נתונים.
              </div>
            ) : (
              <div className="space-y-1.5">
                {months.map(([m, rev]) => (
                  <div
                    key={m}
                    className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-sm"
                  >
                    <span className="text-fg">{fmtMoney(rev)}</span>
                    <span className="text-fg-muted">
                      {m.slice(5, 7)}/{m.slice(0, 4)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-[11px] text-fg-faint">
          הנתונים מתעדכנים אוטומטית.
        </p>
      </div>
    </div>
  )
}

/** Earnings card — shows the NET payout (after PayPal's fee). Clicking
 *  "(אחרי עמלה של פייפאל)" opens a modal that EXPLAINS why the amount
 *  differs (PayPal's processing fee) + shows the full breakdown. */
function EarningsStat({
  net,
  gross,
  fee,
  paypalFee,
  vat,
  receiptsEnabled,
}: {
  net: Record<string, number>
  gross?: Record<string, number> | null
  fee?: Record<string, number> | null
  paypalFee?: Record<string, number> | null
  vat?: Record<string, number> | null
  receiptsEnabled: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-4 text-center">
        <div className="text-base font-semibold text-fg">{fmtMoney(net)}</div>
        <div className="mt-1 text-[11px] uppercase tracking-wide text-fg-muted">
          סך הרווח שלך
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-0.5 text-[10px] text-primary underline underline-offset-2 hover:text-accent"
        >
          {receiptsEnabled ? '(אחרי עמלה של פייפאל)' : '(אחרי עמלות)'}
        </button>
      </div>
      {open && (
        <FeeExplainModal
          net={net}
          gross={gross}
          fee={fee}
          paypalFee={paypalFee}
          vat={vat}
          receiptsEnabled={receiptsEnabled}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** A small explainer popup for the partner: why the payout is lower
 *  than the sticker price (PayPal's per-transaction processing fee). */
function FeeExplainModal({
  net,
  gross,
  fee,
  paypalFee,
  vat,
  receiptsEnabled,
  onClose,
}: {
  net: Record<string, number>
  gross?: Record<string, number> | null
  fee?: Record<string, number> | null
  paypalFee?: Record<string, number> | null
  vat?: Record<string, number> | null
  receiptsEnabled: boolean
  onClose: () => void
}) {
  // When receipts are OFF, VAT is ALWAYS part of the deduction — show
  // its own line even before any sale, so the partner knows up front
  // that both PayPal AND VAT come off the top. (Not gated on having
  // data: a brand-new partner must still see the structure.)
  const hasVat = !receiptsEnabled
  const paypalLine = paypalFee && Object.keys(paypalFee).length ? paypalFee : fee
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-bg-elevated p-6 text-right shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="סגור"
          className="absolute left-4 top-4 rounded-md p-1 text-fg-muted transition-colors hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="mb-3 font-display text-lg font-medium text-fg">
          {hasVat ? 'למה הסכום שונה? — עמלות' : 'למה הסכום שונה? — עמלת PayPal'}
        </h2>
        <p className="mb-4 text-sm leading-relaxed text-fg-secondary">
          {hasVat ? (
            <>
              על כל תשלום נגבית עמלת סליקה של PayPal, ובנוסף משולם מע"מ
              למדינה. לכן הסכום שנשאר בפועל נמוך מהמחיר שהלקוח שילם. הרווח
              שלך מחושב על הסכום שנשאר{' '}
              <span className="text-fg">אחרי כל העמלות</span> — כלומר הכסף
              ה"אמיתי" שנכנס.
            </>
          ) : (
            <>
              על כל תשלום, חברת PayPal גובה עמלת סליקה. לכן הסכום שמגיע
              בפועל לחשבון נמוך מהמחיר שהלקוח שילם. הרווח שלך מחושב על הסכום
              שנשאר <span className="text-fg">אחרי</span> עמלת PayPal —
              כלומר הכסף ה"אמיתי" שנכנס.
            </>
          )}
        </p>

        <div className="space-y-2 rounded-xl border border-border/60 bg-white/[0.015] p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">מחיר מלא (לפני עמלות)</span>
            <span className="text-fg" dir="ltr">
              {fmtMoney(gross || {})}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">עמלת PayPal</span>
            <span className="text-destructive" dir="ltr">
              −{fmtMoney(paypalLine || {})}
            </span>
          </div>
          {hasVat && (
            <div className="flex items-center justify-between">
              <span className="text-fg-muted">מע"מ</span>
              <span className="text-destructive" dir="ltr">
                −{fmtMoney(vat || {})}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border/60 pt-2 font-medium">
            <span className="text-fg">
              {hasVat ? 'הרווח שלך (אחרי עמלות)' : 'הרווח שלך (אחרי עמלה)'}
            </span>
            <span className="text-success" dir="ltr">
              {fmtMoney(net)}
            </span>
          </div>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-fg-faint">
          {hasVat
            ? 'עמלת PayPal נקבעת על ידי PayPal ומשתנה מעט בין עסקה לעסקה. המע"מ מחושב לפי השיעור הנהוג. המספרים כאן הם הסכומים האמיתיים שנגבו בפועל.'
            : 'העמלה נקבעת על ידי PayPal ומשתנה מעט בין עסקה לעסקה (מטבע, המרת מטבע ועוד). המספרים כאן הם העמלות האמיתיות שנגבו בפועל.'}
        </p>
      </div>
    </div>
  )
}

function Stat({
  value,
  label,
  wide,
}: {
  value: string
  label: string
  wide?: boolean
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-4 text-center">
      <div
        className={
          'font-semibold text-fg ' + (wide ? 'text-base' : 'text-2xl')
        }
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-fg-muted">
        {label}
      </div>
    </div>
  )
}
