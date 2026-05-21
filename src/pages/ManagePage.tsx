import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  LogIn,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Crown,
  X,
} from 'lucide-react'

/**
 * /manage — subscription self-service for end users.
 *
 * Legally required by Israeli consumer-protection law (sec. 14ט(א))
 * for any subscription-based service: the buyer must be able to
 * cancel through a prominent online channel that takes effect
 * within 3 business days. This page is that channel.
 *
 * Flow:
 *   1. Email + password login (re-uses the user's Firebase account
 *      credentials — same login as the desktop app).
 *   2. Page shows every PayPal subscription tied to that account:
 *      cycle, locked-in price, status, next billing date, and a
 *      "Cancel Subscription" button.
 *   3. Cancellation calls /api/subscription/cancel which hits
 *      PayPal's cancel API. The current paid period continues
 *      until its natural expiry — the user gets what they paid
 *      for; only the NEXT auto-charge is stopped.
 *
 * Reached from:
 *   - The desktop app's user profile dropdown ("ניהול תוכנית")
 *   - The website footer cancellation link
 *   - The post-subscription welcome email
 */

interface Subscription {
  key: string
  subscriptionId: string
  status: string
  expiresAt: string | null
  startedAt: string | null
  cancelledAt: string | null
  price: number | null
  currency: string
  planDays: number
  cycleLabel: string
}

interface SessionResponse {
  ok: boolean
  token?: string
  email?: string
  subscriptions?: Subscription[]
  error?: string
}

function formatExpiry(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return d.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
}

function statusLabel(status: string): {
  label: string
  color: 'success' | 'destructive' | 'muted'
} {
  switch (status) {
    case 'active':
      return { label: 'פעיל', color: 'success' }
    case 'cancelled':
      return { label: 'בוטל', color: 'muted' }
    case 'expired':
      return { label: 'הסתיים', color: 'muted' }
    case 'past_due':
      return { label: 'חיוב נכשל', color: 'destructive' }
    default:
      return { label: status, color: 'muted' }
  }
}

function currencySymbol(code: string): string {
  if (code === 'ILS') return '₪'
  if (code === 'USD') return '$'
  if (code === 'EUR') return '€'
  return code
}

export function ManagePage() {
  // ── Auth state ─────────────────────────────────────────────
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authing, setAuthing] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  // ── Session state (post-login) ─────────────────────────────
  const [token, setToken] = useState<string | null>(null)
  const [subs, setSubs] = useState<Subscription[]>([])
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)

  // ── Cancel-in-progress state (per subscription) ────────────
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // Open the "confirm cancel" dialog for a specific subscription.
  // Prevents accidental clicks — Israeli law doesn't require a
  // confirmation step but it's standard UX courtesy.
  const [confirmCancelFor, setConfirmCancelFor] = useState<Subscription | null>(
    null,
  )

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (authing) return
    setAuthError(null)
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail || !password) {
      setAuthError('הזן אימייל וסיסמה')
      return
    }
    setAuthing(true)
    try {
      const r = await fetch('/api/paypal?action=session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password }),
      })
      const json = (await r.json()) as SessionResponse
      if (!r.ok || !json.ok || !json.token) {
        setAuthError(json.error || 'התחברות נכשלה')
        return
      }
      setToken(json.token)
      setSessionEmail(json.email || cleanEmail)
      setSubs(json.subscriptions ?? [])
      // Clear password from memory after successful auth
      setPassword('')
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'שגיאת רשת. נסה שוב.',
      )
    } finally {
      setAuthing(false)
    }
  }

  /** Refresh subscriptions list (used after cancel succeeds). */
  async function refreshSubs() {
    if (!token) return
    try {
      const r = await fetch('/api/paypal?action=status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = (await r.json()) as SessionResponse
      if (r.ok && json.ok) {
        setSubs(json.subscriptions ?? [])
      }
    } catch (err) {
      console.warn('[manage] refresh failed', err)
    }
  }

  async function performCancel(sub: Subscription) {
    if (!token) return
    setCancellingId(sub.subscriptionId)
    setCancelError(null)
    try {
      const r = await fetch('/api/paypal?action=cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          subscriptionId: sub.subscriptionId,
          reason: 'User cancelled via /manage',
        }),
      })
      const json = (await r.json()) as { ok: boolean; error?: string }
      if (!r.ok || !json.ok) {
        setCancelError(json.error || 'ביטול נכשל')
      } else {
        // Refresh to show the new status
        await refreshSubs()
      }
    } catch (err) {
      setCancelError(
        err instanceof Error ? err.message : 'שגיאת רשת. נסה שוב.',
      )
    } finally {
      setCancellingId(null)
      setConfirmCancelFor(null)
    }
  }

  function signOut() {
    setToken(null)
    setSessionEmail(null)
    setSubs([])
    setEmail('')
    setPassword('')
  }

  // Clear auth error when user starts typing again
  useEffect(() => {
    if (authError) setAuthError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, password])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen px-6 py-12 md:py-20"
    >
      <div className="mx-auto max-w-2xl">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowRight className="h-4 w-4" />
          חזרה לדף הבית
        </Link>

        <header className="mb-10 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-primary">
            <Crown className="h-3 w-3" />
            ניהול תוכנית
          </div>
          <h1 className="text-3xl font-bold font-display text-fg md:text-4xl">
            המנוי שלך
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-fg-muted md:text-base">
            צפייה בפרטי המנוי שלך וביטול בכל עת. הביטול נכנס לתוקף מיידית
            ומפסיק את כל החיובים העתידיים.
          </p>
        </header>

        {!token ? (
          /* ── Login ── */
          <form
            onSubmit={handleLogin}
            className="card-elevated mx-auto max-w-md space-y-4 rounded-2xl border-border p-6 md:p-8"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <LogIn className="h-4 w-4 text-accent" />
              התחבר עם החשבון שלך
            </div>
            <p className="text-xs text-fg-muted">
              השתמש באותם פרטי גישה שאיתם נכנסת לתוכנת ניהול הורדות פלוס.
            </p>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-muted">
                אימייל
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                dir="ltr"
                autoComplete="email"
                disabled={authing}
                className="w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-muted">
                סיסמה
              </span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                autoComplete="current-password"
                disabled={authing}
                className="w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </label>
            {authError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {authError}
              </div>
            )}
            <button
              type="submit"
              disabled={authing}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {authing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  מתחבר...
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" />
                  התחברות
                </>
              )}
            </button>
            <p className="text-center text-[10px] text-fg-faint">
              שכחת סיסמה? פתח את התוכנה ולחץ "שכחתי סיסמה" במסך ההתחברות.
            </p>
          </form>
        ) : (
          /* ── Subscription list ── */
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-2.5 text-xs">
              <span className="text-fg-muted">
                מחובר בתור{' '}
                <span dir="ltr" className="font-mono text-fg">
                  {sessionEmail}
                </span>
              </span>
              <button
                type="button"
                onClick={signOut}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                התנתק
              </button>
            </div>

            {cancelError && (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{cancelError}</span>
              </div>
            )}

            {subs.length === 0 ? (
              <div className="card-elevated rounded-2xl border-border p-6 text-center text-sm text-fg-muted">
                לא נמצאו מנויים פעילים בחשבון הזה.
                <div className="mt-3">
                  <Link
                    to="/buy"
                    className="text-accent underline underline-offset-2"
                  >
                    רכישת מנוי חדש
                  </Link>
                </div>
              </div>
            ) : (
              subs.map((sub) => {
                const s = statusLabel(sub.status)
                const sym = currencySymbol(sub.currency)
                const isActive = sub.status === 'active'
                return (
                  <div
                    key={sub.subscriptionId}
                    className="card-elevated space-y-4 rounded-2xl border-border p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-fg">
                          מנוי Pro {sub.cycleLabel}
                        </div>
                        <div className="mt-0.5 text-xs text-fg-muted">
                          {sub.price != null ? (
                            <>
                              {sub.price.toLocaleString('he-IL')} {sym} ל
                              {sub.cycleLabel === 'חודשי' ? 'חודש' : 'שנה'}
                            </>
                          ) : (
                            '—'
                          )}
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                          s.color === 'success'
                            ? 'border border-success/40 bg-success/15 text-success'
                            : s.color === 'destructive'
                              ? 'border border-destructive/40 bg-destructive/15 text-destructive'
                              : 'border border-border bg-bg-elevated text-fg-muted'
                        }`}
                      >
                        {s.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-fg-muted">תחילת המנוי</div>
                        <div className="mt-0.5 text-fg tabular-nums">
                          {formatExpiry(sub.startedAt)}
                        </div>
                      </div>
                      <div>
                        <div className="text-fg-muted">
                          {isActive ? 'חיוב הבא' : 'תוקף עד'}
                        </div>
                        <div className="mt-0.5 text-fg tabular-nums">
                          {formatExpiry(sub.expiresAt)}
                        </div>
                      </div>
                      {sub.cancelledAt && (
                        <div className="col-span-2 rounded-md border border-border bg-bg-elevated px-3 py-2 text-fg-muted">
                          המנוי בוטל ב-{formatExpiry(sub.cancelledAt)}. גישת
                          ה-Pro פעילה עד {formatExpiry(sub.expiresAt)}.
                        </div>
                      )}
                    </div>

                    {isActive && (
                      <div className="flex items-center justify-between border-t border-border pt-3">
                        <p className="text-[11px] text-fg-muted">
                          הביטול מפסיק חיובים עתידיים. גישת Pro תישאר עד סוף
                          התקופה ששולמה.
                        </p>
                        <button
                          type="button"
                          onClick={() => setConfirmCancelFor(sub)}
                          disabled={cancellingId === sub.subscriptionId}
                          className="flex shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/[0.06] px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/[0.12] disabled:opacity-60"
                        >
                          {cancellingId === sub.subscriptionId ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin" />
                              מבטל...
                            </>
                          ) : (
                            'ביטול מנוי'
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Confirmation dialog for cancellation. Backdrop overlay, esc
          closes, click-outside-to-close. Doesn't block the user — UX
          courtesy more than a legal requirement. */}
      {confirmCancelFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-md"
          onClick={() => setConfirmCancelFor(null)}
        >
          <div
            className="relative w-full max-w-md rounded-lg border border-border bg-bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setConfirmCancelFor(null)}
              className="absolute left-3 top-3 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-elevated hover:text-fg"
              aria-label="סגירה"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="mb-4 flex items-center gap-2 text-base font-semibold text-fg">
              <CheckCircle2 className="h-5 w-5 text-accent" />
              לבטל את המנוי?
            </div>
            <p className="mb-4 text-sm text-fg-secondary">
              ביטול המנוי יעצור את החיוב המתחדש. ה-Pro שלך ימשיך להיות פעיל עד
              סוף התקופה ששילמת עליה (
              {formatExpiry(confirmCancelFor.expiresAt)}). אחר כך תעבור לגרסה
              החינמית.
            </p>
            <p className="mb-5 text-xs text-fg-muted">
              לא יהיו חיובים נוספים. תוכל לחזור ולהירשם בכל עת.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmCancelFor(null)}
                className="rounded-md border border-border bg-bg-elevated px-4 py-2 text-sm text-fg transition-colors hover:bg-bg-card"
              >
                חזרה
              </button>
              <button
                type="button"
                onClick={() => performCancel(confirmCancelFor)}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-destructive/90"
              >
                כן, בטל את המנוי
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}
