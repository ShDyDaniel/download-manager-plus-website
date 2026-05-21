import { useEffect, useState, useCallback } from 'react'
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
  Mail,
  Key as KeyIcon,
  Calendar,
  Lock,
  Receipt,
  Shield,
  RefreshCw,
  LogOut,
} from 'lucide-react'

/**
 * /account — full account dashboard.
 *
 * Replaces the in-app "הפרופיל שלי" popup. The Electron app sends
 * the user here with a fresh Firebase ID token in the URL fragment
 * (`#t=<idToken>`); this page exchanges it for a session JWT via
 * /api/paypal?action=sso and renders:
 *
 *   - Profile card  email, plan badge, product key (last 8), valid
 *                   until, change-password trigger.
 *   - Subscription  active subscriptions w/ cycle, locked price,
 *                   status, next renewal, cancel button. Same data
 *                   the /manage page surfaces — /account is a
 *                   superset.
 *   - Billing       payments table (PayPal transaction history)
 *                   loaded on demand via /api/paypal?action=billing
 *                   -history. Avoids the upfront fetch cost when
 *                   the user just wants to peek at their profile.
 *
 * Token security:
 *   - The Firebase ID token arrives in the URL fragment (`#`),
 *     which the browser NEVER sends to servers in fetch requests.
 *   - First thing on mount: strip the fragment from the URL via
 *     history.replaceState so a back/forward navigation or a
 *     screenshot doesn't expose it.
 *   - Exchange for our session JWT immediately; the Firebase
 *     token's job ends within the first ~1s of page load.
 *
 * Direct-navigation fallback: if a user navigates here without an
 * SSO token (typed URL, bookmark, footer link), the page shows
 * the same email+password login form as /manage so they can still
 * get in.
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

interface Profile {
  email: string
  plan: 'admin' | 'pro' | 'free'
  planLabel: string
  keyLast8: string | null
  validUntil: string | null
  hasActiveSubscription: boolean
  marketingOptIn: boolean
}

interface SessionResponse {
  ok: boolean
  token?: string
  email?: string
  profile?: Profile
  subscriptions?: Subscription[]
  error?: string
}

interface BillingTransaction {
  subscriptionId: string
  transactionId: string
  status: string
  amountValue: string
  amountCurrency: string
  time: string
  payerEmail: string | null
}

interface BillingResponse {
  ok: boolean
  transactions?: BillingTransaction[]
  error?: string
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function formatDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AccountPage() {
  // SSO-bootstrap state. `ssoState` distinguishes:
  //   - 'idle' before any work
  //   - 'exchanging' while we POST the Firebase token
  //   - 'success' got a session JWT back
  //   - 'failed' fall through to the login form
  //   - 'none' no token in URL → show login form straight away
  const [ssoState, setSsoState] = useState<
    'idle' | 'exchanging' | 'success' | 'failed' | 'none'
  >('idle')
  const [ssoError, setSsoError] = useState<string | null>(null)

  // Authenticated state
  const [token, setToken] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [subs, setSubs] = useState<Subscription[]>([])
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)

  // Login form state (used when SSO not available)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authing, setAuthing] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  // Cancel-subscription modal
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  // Reset-password state
  const [resetSending, setResetSending] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  // Marketing opt-in toggle state. `marketingSaving` is true while
  // the PATCH is in flight so the toggle UI can show a spinner +
  // disable double-clicks. `marketingError` surfaces any failure
  // inline below the row.
  const [marketingSaving, setMarketingSaving] = useState(false)
  const [marketingError, setMarketingError] = useState<string | null>(null)

  // Billing state (lazy)
  const [billingOpen, setBillingOpen] = useState(false)
  const [billingLoading, setBillingLoading] = useState(false)
  const [billingError, setBillingError] = useState<string | null>(null)
  const [transactions, setTransactions] = useState<BillingTransaction[] | null>(null)

  /** On mount: try SSO bootstrap if `#t=...` is present in URL. */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const fragment = window.location.hash
    const match = fragment.match(/[#&]t=([^&]+)/)
    if (!match) {
      setSsoState('none')
      return
    }
    const idToken = decodeURIComponent(match[1])
    // Strip the token from the URL immediately — back/forward nav
    // shouldn't expose it, and screenshots / browser history
    // shouldn't capture it. replaceState preserves the user's
    // current URL minus the fragment.
    try {
      const cleanUrl =
        window.location.pathname +
        window.location.search +
        (window.location.hash.replace(/[#&]t=[^&]+/, '').replace(/^#$/, '') || '')
      window.history.replaceState(null, '', cleanUrl)
    } catch {
      // history.replaceState can throw in some sandboxed environments;
      // if it does we still proceed with SSO — the token is short-
      // lived and gets used immediately.
    }

    setSsoState('exchanging')
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        const json = (await r.json()) as SessionResponse
        if (!r.ok || !json.ok || !json.token) {
          setSsoError(json.error || 'התחברות אוטומטית נכשלה')
          setSsoState('failed')
          return
        }
        setToken(json.token)
        setSessionEmail(json.email || null)
        setProfile(json.profile || null)
        setSubs(json.subscriptions ?? [])
        setSsoState('success')
      } catch (err) {
        setSsoError(err instanceof Error ? err.message : 'שגיאת רשת')
        setSsoState('failed')
      }
    })()
  }, [])

  /** Login form submit — email + password fallback. */
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail || !password) {
      setAuthError('הזן אימייל וסיסמה')
      return
    }
    setAuthing(true)
    setAuthError(null)
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
      setProfile(json.profile || null)
      setSubs(json.subscriptions ?? [])
      setPassword('')
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'שגיאת רשת. נסה שוב.')
    } finally {
      setAuthing(false)
    }
  }

  async function refreshStatus() {
    if (!token) return
    try {
      const r = await fetch('/api/paypal?action=status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = (await r.json()) as SessionResponse
      if (json.ok && json.subscriptions) setSubs(json.subscriptions)
    } catch {
      // Silent; the user already has stale-but-usable data.
    }
  }

  async function handleCancel() {
    if (!token || !pendingCancelId) return
    setCancelling(true)
    setCancelError(null)
    try {
      const r = await fetch('/api/paypal?action=cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          subscriptionId: pendingCancelId,
          reason: cancelReason.trim() || 'user requested',
        }),
      })
      const json = (await r.json()) as { ok: boolean; error?: string }
      if (!r.ok || !json.ok) {
        setCancelError(json.error || 'ביטול נכשל')
        return
      }
      setPendingCancelId(null)
      setCancelReason('')
      await refreshStatus()
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'שגיאת רשת')
    } finally {
      setCancelling(false)
    }
  }

  async function handleSendResetEmail() {
    const target = sessionEmail || profile?.email
    if (!target) return
    setResetSending(true)
    setResetError(null)
    try {
      const r = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      setResetSent(true)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'שגיאת רשת')
    } finally {
      setResetSending(false)
    }
  }

  async function handleMarketingToggle(next: boolean) {
    if (!token || !profile) return
    // Optimistic update — flip the UI immediately so the toggle
    // feels snappy. Roll back if the backend rejects.
    const prev = profile.marketingOptIn
    setProfile({ ...profile, marketingOptIn: next })
    setMarketingSaving(true)
    setMarketingError(null)
    try {
      const r = await fetch('/api/paypal?action=update-marketing-opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, optIn: next }),
      })
      const json = (await r.json()) as { ok: boolean; error?: string }
      if (!r.ok || !json.ok) {
        throw new Error(json.error || 'עדכון העדפת ההתראות נכשל')
      }
    } catch (err) {
      setMarketingError(err instanceof Error ? err.message : 'שגיאת רשת')
      // Roll back the optimistic flip.
      setProfile({ ...profile, marketingOptIn: prev })
    } finally {
      setMarketingSaving(false)
    }
  }

  const loadBilling = useCallback(async () => {
    if (!token) return
    setBillingLoading(true)
    setBillingError(null)
    try {
      const r = await fetch('/api/paypal?action=billing-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = (await r.json()) as BillingResponse
      if (!r.ok || !json.ok) {
        setBillingError(json.error || 'טעינת היסטוריית התשלומים נכשלה')
        return
      }
      setTransactions(json.transactions ?? [])
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : 'שגיאת רשת')
    } finally {
      setBillingLoading(false)
    }
  }, [token])

  function toggleBilling() {
    const next = !billingOpen
    setBillingOpen(next)
    if (next && transactions === null) void loadBilling()
  }

  function signOut() {
    setToken(null)
    setProfile(null)
    setSubs([])
    setSessionEmail(null)
    setEmail('')
    setPassword('')
    setTransactions(null)
    setBillingOpen(false)
    setSsoState('none')
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen px-6 py-12 md:py-20"
      dir="rtl"
    >
      <div className="mx-auto max-w-3xl">
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
            החשבון שלי
          </div>
          <h1 className="text-3xl font-bold font-display text-fg md:text-4xl">
            {profile?.email ? 'הפרופיל שלך' : 'התחבר לחשבון שלך'}
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-fg-muted md:text-base">
            פרטי החשבון, המנוי, וההיסטוריית התשלומים שלך — במקום אחד.
          </p>
        </header>

        {ssoState === 'exchanging' ? (
          /* ── SSO bootstrap in progress ── */
          <div className="card-elevated mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border-border p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <div className="text-sm font-medium text-fg">
              מתחבר אוטומטית לחשבון שלך…
            </div>
            <div className="text-xs text-fg-muted">
              שניה אחת, מקבלים את הפרטים שלך משרת PayPal.
            </div>
          </div>
        ) : !token ? (
          /* ── Login form (SSO failed or never present) ── */
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
            {ssoState === 'failed' && ssoError && (
              <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent">
                התחברות אוטומטית נכשלה ({ssoError}) — התחבר עם סיסמה.
              </div>
            )}
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-muted">אימייל</span>
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
              <span className="mb-1 block text-[11px] text-fg-muted">סיסמה</span>
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
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              התחברות
            </button>
            <p className="pt-2 text-center text-[11px] text-fg-muted">
              שכחת סיסמה? פתח את התוכנה ולחץ "שכחתי סיסמה" במסך ההתחברות.
            </p>
          </form>
        ) : (
          /* ── Authenticated dashboard ── */
          <div className="space-y-6">
            {/* Profile card */}
            <section className="card-elevated rounded-2xl border-border p-6 md:p-8">
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-lg font-bold text-fg">
                  <Crown className="h-4 w-4 text-accent" />
                  פרטי החשבון
                </h2>
                <button
                  onClick={signOut}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-destructive/40 hover:text-destructive"
                >
                  <LogOut className="h-3 w-3" />
                  התנתק
                </button>
              </div>

              <div className="space-y-2.5">
                <ProfileRow
                  icon={<Mail className="h-3.5 w-3.5 text-accent" />}
                  label="כתובת מייל"
                >
                  <span dir="ltr" className="font-mono text-sm text-fg">
                    {profile?.email || sessionEmail || '—'}
                  </span>
                </ProfileRow>

                <ProfileRow
                  icon={<Crown className="h-3.5 w-3.5 text-accent" />}
                  label="תוכנית"
                >
                  <PlanBadge plan={profile?.plan || 'free'} label={profile?.planLabel || 'חינם'} />
                </ProfileRow>

                <ProfileRow
                  icon={<KeyIcon className="h-3.5 w-3.5 text-accent" />}
                  label="מפתח מוצר"
                >
                  {profile?.keyLast8 ? (
                    <span dir="ltr" className="font-mono text-sm tracking-wide text-fg">
                      …{profile.keyLast8}
                    </span>
                  ) : (
                    <span className="text-xs text-fg-muted">לא מומש מפתח</span>
                  )}
                </ProfileRow>

                <ValidityRow profile={profile ?? null} />

                {/* Marketing opt-in toggle. Sits inside the
                    profile rows so the user reads it as part of
                    "my account settings", not a buried preference.
                    Visually matches a ProfileRow but the right-hand
                    slot holds an interactive switch. Optimistically
                    updates the UI on flip + rolls back if the
                    backend rejects. */}
                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-elevated px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-3.5 w-3.5 text-accent" />
                    <span className="text-fg-muted">התראות במייל</span>
                  </div>
                  <MarketingToggle
                    enabled={profile?.marketingOptIn ?? false}
                    saving={marketingSaving}
                    onChange={(v) => void handleMarketingToggle(v)}
                  />
                </div>
                <p className="-mt-1 px-1 text-[11px] text-fg-muted">
                  קבלת הצעות מיוחדות, מבצעים ועדכוני מוצר. ניתן לשנות בכל עת.
                </p>
                {marketingError && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {marketingError}
                  </div>
                )}
              </div>

              {/* Change password */}
              <div className="mt-5 border-t border-border pt-5">
                {resetSent ? (
                  <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-xs text-success">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      קישור לאיפוס סיסמה נשלח ל-
                      <span dir="ltr" className="font-mono">
                        {sessionEmail || profile?.email}
                      </span>
                      . בדוק את תיבת הדואר שלך (כולל ספאם).
                    </span>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={resetSending}
                      onClick={handleSendResetEmail}
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg-faint disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {resetSending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Lock className="h-3.5 w-3.5" />
                      )}
                      שנה סיסמה (שלח קישור איפוס למייל)
                    </button>
                    {resetError && (
                      <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {resetError}
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>

            {/* Subscriptions */}
            <section className="card-elevated rounded-2xl border-border p-6 md:p-8">
              <h2 className="mb-5 flex items-center gap-2 text-lg font-bold text-fg">
                <Shield className="h-4 w-4 text-accent" />
                המנוי שלך
              </h2>
              {subs.length === 0 ? (
                <div className="rounded-md border border-border bg-bg-elevated px-4 py-6 text-center text-sm text-fg-muted">
                  אין לך מנוי פעיל כרגע.
                  <div className="mt-3">
                    <Link
                      to="/buy"
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-bg transition-colors hover:bg-primary-hover"
                    >
                      <Crown className="h-3 w-3" />
                      לקניית רישיון
                    </Link>
                  </div>
                </div>
              ) : (
                <ul className="space-y-3">
                  {subs.map((s) => (
                    <SubscriptionCard
                      key={s.subscriptionId}
                      sub={s}
                      onCancel={() => setPendingCancelId(s.subscriptionId)}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Billing history (collapsed by default) */}
            <section className="card-elevated rounded-2xl border-border p-6 md:p-8">
              <button
                onClick={toggleBilling}
                className="flex w-full items-center justify-between gap-3 text-right"
              >
                <h2 className="flex items-center gap-2 text-lg font-bold text-fg">
                  <Receipt className="h-4 w-4 text-accent" />
                  היסטוריית תשלומים
                </h2>
                <span className="text-xs text-fg-muted">
                  {billingOpen ? 'הסתר' : 'הצג'}
                </span>
              </button>

              {billingOpen && (
                <div className="mt-5">
                  {billingLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      טוען נתונים מ-PayPal…
                    </div>
                  ) : billingError ? (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                      <div className="flex-1">
                        {billingError}
                        <button
                          onClick={() => void loadBilling()}
                          className="mr-2 underline hover:no-underline"
                        >
                          נסה שוב
                        </button>
                      </div>
                    </div>
                  ) : transactions && transactions.length > 0 ? (
                    <>
                      <div className="overflow-hidden rounded-md border border-border">
                        <table className="w-full text-right text-xs">
                          <thead className="bg-bg-elevated text-fg-muted">
                            <tr>
                              <th className="px-3 py-2 font-medium">תאריך</th>
                              <th className="px-3 py-2 font-medium">סכום</th>
                              <th className="px-3 py-2 font-medium">סטטוס</th>
                              <th className="px-3 py-2 font-medium">מס׳ עסקה</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {transactions.map((t) => (
                              <tr key={t.transactionId}>
                                <td className="px-3 py-2 text-fg">
                                  {formatDateTime(t.time)}
                                </td>
                                <td className="px-3 py-2 font-medium text-fg" dir="ltr">
                                  {t.amountValue} {t.amountCurrency}
                                </td>
                                <td className="px-3 py-2">
                                  <TxStatusBadge status={t.status} />
                                </td>
                                <td
                                  className="px-3 py-2 text-fg-muted"
                                  dir="ltr"
                                  title={t.transactionId}
                                >
                                  {t.transactionId.slice(-10)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-[11px] text-fg-muted">
                        <span>הנתונים נמשכים ישירות מ-PayPal בזמן אמת.</span>
                        <button
                          onClick={() => void loadBilling()}
                          className="inline-flex items-center gap-1 hover:text-fg"
                        >
                          <RefreshCw className="h-3 w-3" />
                          רענן
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-md border border-border bg-bg-elevated px-4 py-6 text-center text-sm text-fg-muted">
                      אין עדיין חיובים להציג.
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Cancel-subscription confirm modal */}
      {pendingCancelId && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget && !cancelling) {
              setPendingCancelId(null)
              setCancelReason('')
              setCancelError(null)
            }
          }}
        >
          <div className="card-elevated relative w-full max-w-md rounded-2xl border-border p-6 md:p-7">
            <button
              onClick={() => {
                if (cancelling) return
                setPendingCancelId(null)
                setCancelReason('')
                setCancelError(null)
              }}
              className="absolute left-3 top-3 rounded-md p-1 text-fg-muted hover:text-fg"
              aria-label="סגור"
            >
              <X className="h-4 w-4" />
            </button>
            <h3 className="mb-3 flex items-center gap-2 text-base font-bold text-fg">
              <AlertTriangle className="h-4 w-4 text-accent" />
              ביטול המנוי
            </h3>
            <p className="mb-3 text-sm leading-relaxed text-fg-muted">
              לאחר ביטול לא תחויב יותר. הגישה ל-Pro תישאר פעילה עד סוף התקופה
              ששולמה. <strong className="text-fg">אין החזר על תקופות ששולמו.</strong>
            </p>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-muted">
                סיבה לביטול (לא חובה)
              </span>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value.slice(0, 500))}
                rows={3}
                disabled={cancelling}
                className="w-full resize-none rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
                placeholder="לדוגמה: לא משתמש מספיק, יקר, חסרה תכונה…"
              />
            </label>
            {cancelError && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {cancelError}
              </div>
            )}
            <div className="mt-5 flex gap-2">
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cancelling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                כן, בטל את המנוי
              </button>
              <button
                onClick={() => {
                  setPendingCancelId(null)
                  setCancelReason('')
                  setCancelError(null)
                }}
                disabled={cancelling}
                className="flex-1 rounded-md border border-border px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg-elevated disabled:opacity-60"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}

function ProfileRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-elevated px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span className="text-fg-muted">{label}</span>
      </div>
      <div>{children}</div>
    </div>
  )
}

/**
 * "בתוקף עד" row with state-aware rendering. Four cases:
 *   1. Admin           → "ללא הגבלה" (admins don't expire)
 *   2. No key at all   → "—" with muted text (user never redeemed)
 *   3. Key expired     → "פג תוקף" in destructive color, red calendar
 *   4. Key valid       → formatted date in normal text, green calendar
 *
 * Earlier this just printed the raw date even when it was in the
 * past, which confused users into thinking their key was still
 * good — the user explicitly asked to surface "פג תוקף" in that
 * case so there's no ambiguity.
 */
function ValidityRow({ profile }: { profile: Profile | null }) {
  const isAdmin = profile?.plan === 'admin'
  const validUntil = profile?.validUntil ?? null
  const expired = validUntil
    ? Date.parse(validUntil) <= Date.now()
    : false

  let iconColor: string
  let content: React.ReactNode

  if (isAdmin) {
    iconColor = 'text-success'
    content = <span className="text-sm text-fg">ללא הגבלה</span>
  } else if (!validUntil) {
    iconColor = 'text-fg-muted'
    content = <span className="text-xs text-fg-muted">—</span>
  } else if (expired) {
    iconColor = 'text-destructive'
    content = (
      <span className="text-sm font-semibold text-destructive">
        פג תוקף ({formatDate(validUntil)})
      </span>
    )
  } else {
    iconColor = 'text-success'
    content = <span className="text-sm text-fg">{formatDate(validUntil)}</span>
  }

  return (
    <ProfileRow
      icon={<Calendar className={`h-3.5 w-3.5 ${iconColor}`} />}
      label="בתוקף עד"
    >
      {content}
    </ProfileRow>
  )
}

function PlanBadge({ plan, label }: { plan: Profile['plan']; label: string }) {
  const cls =
    plan === 'admin'
      ? 'border-primary/40 bg-primary/15 text-primary'
      : plan === 'pro'
        ? 'border-success/40 bg-success/15 text-success'
        : 'border-border bg-bg-elevated text-fg-muted'
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {label}
    </span>
  )
}

function SubscriptionCard({
  sub,
  onCancel,
}: {
  sub: Subscription
  onCancel: () => void
}) {
  const isActive = sub.status === 'ACTIVE'
  const isCancelled = sub.status === 'CANCELLED' || sub.cancelledAt
  const statusLabel = isCancelled
    ? 'בוטל'
    : isActive
      ? 'פעיל'
      : sub.status === 'SUSPENDED'
        ? 'מושעה'
        : sub.status
  const statusColor = isCancelled
    ? 'text-fg-muted'
    : isActive
      ? 'text-success'
      : 'text-accent'

  return (
    <li className="rounded-md border border-border bg-bg-elevated p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-fg">{sub.cycleLabel}</div>
          <div className="mt-0.5 text-xs text-fg-muted">
            {sub.price !== null
              ? `${sub.price} ${sub.currency} ${sub.cycleLabel === 'שנתי' ? 'לשנה' : 'לחודש'}`
              : '—'}
          </div>
        </div>
        <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
        <div>
          <div className="text-fg-muted">התחיל ב-</div>
          <div className="mt-0.5 text-fg">{formatDate(sub.startedAt)}</div>
        </div>
        <div>
          <div className="text-fg-muted">
            {isCancelled ? 'מסתיים ב-' : 'מתחדש ב-'}
          </div>
          <div className="mt-0.5 text-fg">{formatDate(sub.expiresAt)}</div>
        </div>
      </div>

      {isActive && !isCancelled && (
        <button
          onClick={onCancel}
          className="mt-4 w-full rounded-md border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          ביטול המנוי
        </button>
      )}
    </li>
  )
}

/**
 * Pill-style toggle (NOT a native checkbox) so the marketing-opt-in
 * row reads as a settings control, not a form field. Animates the
 * thumb across; while `saving` is true the row dims slightly and
 * pointer events are disabled so the user can't spam-click during
 * the round-trip.
 */
function MarketingToggle({
  enabled,
  saving,
  onChange,
}: {
  enabled: boolean
  saving: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={saving}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        enabled
          ? 'border-success/60 bg-success/30'
          : 'border-border bg-bg-elevated'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-fg shadow-md transition-transform ${
          enabled ? '-translate-x-1' : '-translate-x-6'
        }`}
        aria-hidden
      />
      <span className="sr-only">
        {enabled ? 'מקבל התראות במייל' : 'לא מקבל התראות במייל'}
      </span>
    </button>
  )
}

function TxStatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase()
  const good = s === 'COMPLETED' || s === 'CAPTURED'
  const pending = s === 'PENDING' || s === 'PARTIALLY_REFUNDED'
  const cls = good
    ? 'border-success/40 bg-success/15 text-success'
    : pending
      ? 'border-accent/40 bg-accent/15 text-accent'
      : 'border-destructive/40 bg-destructive/15 text-destructive'
  const label = good
    ? 'הושלם'
    : pending
      ? 'בהמתנה'
      : s === 'REFUNDED'
        ? 'הוחזר'
        : s === 'DECLINED'
          ? 'נדחה'
          : s
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  )
}
