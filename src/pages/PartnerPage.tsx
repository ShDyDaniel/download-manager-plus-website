import { useEffect, useState } from 'react'
import { Copy, Check, LogOut } from 'lucide-react'
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
  signups: number
  paidAccounts: number
  revenueByCurrency: Record<string, number>
  byMonth: Record<string, Record<string, number>>
}

function fmtMoney(m: Record<string, number>): string {
  const parts = Object.entries(m || {})
    .filter(([, v]) => v > 0)
    .map(([c, v]) => `${v.toFixed(2)} ${c}`)
  return parts.length ? parts.join(' · ') : '—'
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
  const months = Object.entries(stats.byMonth)
    .filter(([m]) => m !== 'unknown')
    .sort((a, b) => b[0].localeCompare(a[0]))

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

        {/* Stats */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          <Stat value={fmtMoney(stats.revenueByCurrency)} label="סה״כ הכנסות" wide />
          <Stat value={String(stats.signups)} label="נרשמו" />
          <Stat value={String(stats.paidAccounts)} label="קנו" />
        </div>

        {/* Revenue by month */}
        <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-5">
          <div className="mb-3 text-sm font-medium text-fg">הכנסות לפי חודש</div>
          {months.length === 0 ? (
            <div className="py-6 text-center text-sm text-fg-muted">
              עדיין אין הכנסות.
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

        <p className="mt-6 text-center text-[11px] text-fg-faint">
          הנתונים מתעדכנים אוטומטית. מוצגים סכומים מצטברים בלבד.
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
