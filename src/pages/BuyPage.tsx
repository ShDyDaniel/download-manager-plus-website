import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Check,
  Crown,
  Loader2,
  RefreshCw,
  CheckCircle2,
} from 'lucide-react'

/**
 * Dedicated purchase page at `/buy`. The buyer picks a plan
 * (monthly vs yearly), types their email, and pays via PayPal
 * Smart Buttons that render inline — the popup PayPal opens stays
 * on top of our page so the customer never feels they've left.
 *
 * Pricing decision:
 *   - Yearly: 60 ₪ → 365 days. Equivalent to 5 ₪/month.
 *   - Monthly: 9 ₪ → 30 days. The 9-vs-5 gap is the discount that
 *     pushes most buyers toward yearly.
 *
 * The "monthly" plan is technically a one-shot 30-day pass, not a
 * recurring PayPal Subscription — auto-renewing subs need a PayPal
 * Business account, which we're explicitly avoiding for the MVP.
 * The buyer comes back and re-pays each month if they want to
 * extend. The UI calls this out under the monthly card so nobody
 * is surprised.
 */

type Plan = 'monthly' | 'yearly'

const PLANS: Record<Plan, { price: string; days: number; label: string }> = {
  monthly: { price: '9.00', days: 30, label: 'חודשי' },
  yearly: { price: '60.00', days: 365, label: 'שנתי' },
}
const CURRENCY = 'ILS'

type Status =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'success'; email: string }
  | { kind: 'renewed'; newExpiresAt: string }
  | { kind: 'error'; message: string }

/** Result of POST /api/renew/info — populated when the URL carries
 *  ?renew=<token>. Drives the renewal-specific UI: hides the email
 *  form (we already know the buyer), shows a "you're renewing X"
 *  banner, and switches the capture payload to renewal mode. */
interface RenewInfo {
  key: string
  keyMasked: string
  emailMasked: string
  tier: string
  expiresAt: string
  isExpired: boolean
}

function formatExpiry(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return d.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
}

type PayPalActions = {
  order: {
    create: (config: {
      purchase_units: { amount: { value: string; currency_code: string }; description: string }[]
      application_context: { brand_name: string; user_action: string; shipping_preference: string }
    }) => Promise<string>
    capture: () => Promise<{ id: string }>
  }
}
type PayPalButton = { render: (selector: string) => Promise<void> }
declare global {
  interface Window {
    paypal?: {
      Buttons: (opts: {
        style?: { layout?: string; color?: string; shape?: string; label?: string; height?: number }
        createOrder: (data: unknown, actions: PayPalActions) => Promise<string>
        onApprove: (data: { orderID: string }, actions: PayPalActions) => Promise<void>
        onError: (err: unknown) => void
        onCancel: () => void
      }) => PayPalButton
    }
  }
}

export function BuyPage() {
  const [plan, setPlan] = useState<Plan>('yearly')
  const [email, setEmail] = useState('')
  const [emailLocked, setEmailLocked] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [sdkReady, setSdkReady] = useState<boolean>(
    typeof window !== 'undefined' && Boolean(window.paypal),
  )
  const [sdkError, setSdkError] = useState<string | null>(null)
  // Renewal mode — populated when the URL carries ?renew=<token>.
  // While `renewLoading` is true the rest of the UI hides behind a
  // spinner so the user doesn't see a half-rendered "purchase" page
  // while we're still waiting on /api/renew/info.
  const [renewToken, setRenewToken] = useState<string | null>(null)
  const [renewInfo, setRenewInfo] = useState<RenewInfo | null>(null)
  const [renewLoading, setRenewLoading] = useState(false)
  const [renewError, setRenewError] = useState<string | null>(null)
  const planRef = useRef(plan)
  planRef.current = plan
  const emailRef = useRef(email)
  emailRef.current = email
  const renewTokenRef = useRef<string | null>(renewToken)
  renewTokenRef.current = renewToken
  const buttonContainer = useRef<HTMLDivElement>(null)

  // Parse ?renew=<token> from the URL on mount and look it up. If
  // the token resolves, we flip into renewal mode: the email form
  // disappears (the buyer is already on file) and a banner shows
  // the current expiry plus what it'll become after renewal.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const token = params.get('renew')
    if (!token) return
    setRenewToken(token)
    setRenewLoading(true)
    setEmailLocked(true)
    fetch('/api/renew/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const json = (await r.json()) as
          | ({ ok: true } & RenewInfo)
          | { ok: false; error: string }
        if (!json.ok) {
          setRenewError(json.error)
          setRenewToken(null)
          setEmailLocked(false)
          return
        }
        setRenewInfo(json)
      })
      .catch(() => {
        setRenewError('לא הצלחנו לטעון את פרטי החידוש. רענן ונסה שוב.')
        setRenewToken(null)
        setEmailLocked(false)
      })
      .finally(() => setRenewLoading(false))
  }, [])

  // Inject the PayPal SDK script tag at runtime instead of from
  // index.html. Vite's `%VITE_*%` substitution in HTML doesn't run
  // reliably on Vercel — production builds shipped the literal
  // `%VITE_PAYPAL_CLIENT_ID%` string and PayPal returned 400. Going
  // through `import.meta.env` here is the supported path and is
  // guaranteed to be replaced at build time.
  //
  // We dedupe by checking for an existing tag (StrictMode double-
  // invokes effects in dev, and we don't want two `<script>` elements
  // racing). Once the SDK is loaded `window.paypal` is defined and
  // we flip `sdkReady`, which unblocks the button-render effect below.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.paypal) {
      setSdkReady(true)
      return
    }
    const clientId = import.meta.env.VITE_PAYPAL_CLIENT_ID as
      | string
      | undefined
    if (!clientId) {
      setSdkError(
        'PayPal Client ID חסר. אם הגעת לדף בטעות במהלך פיתוח, הגדר VITE_PAYPAL_CLIENT_ID ב-Vercel.',
      )
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-paypal-sdk="true"]',
    )
    if (existing) {
      if (window.paypal) {
        setSdkReady(true)
      } else {
        existing.addEventListener('load', () => setSdkReady(true), {
          once: true,
        })
        existing.addEventListener(
          'error',
          () =>
            setSdkError(
              'טעינת PayPal נכשלה. בדוק את החיבור לאינטרנט ונסה שוב.',
            ),
          { once: true },
        )
      }
      return
    }
    const params = new URLSearchParams({
      'client-id': clientId,
      currency: CURRENCY,
      intent: 'capture',
      'disable-funding': 'credit',
    })
    const s = document.createElement('script')
    s.src = `https://www.paypal.com/sdk/js?${params.toString()}`
    s.async = true
    s.dataset.paypalSdk = 'true'
    s.addEventListener('load', () => setSdkReady(true), { once: true })
    s.addEventListener(
      'error',
      () =>
        setSdkError(
          'טעינת PayPal נכשלה. בדוק את החיבור לאינטרנט ונסה שוב.',
        ),
      { once: true },
    )
    document.head.appendChild(s)
  }, [])

  // Render the PayPal button once the SDK is on the page AND the
  // user has committed to a plan + email. The `sdkReady` flag is set
  // by the loader effect above once the `<script>` tag fires `load`.
  useEffect(() => {
    if (!emailLocked) return
    if (!sdkReady) return
    if (!window.paypal) return
    if (!buttonContainer.current) return
    buttonContainer.current.innerHTML = ''
    window.paypal
      .Buttons({
        style: {
          layout: 'vertical',
          color: 'gold',
          shape: 'rect',
          label: 'pay',
          height: 48,
        },
        createOrder: (_data, actions) => {
          const p = PLANS[planRef.current]
          return actions.order.create({
            purchase_units: [
              {
                amount: { value: p.price, currency_code: CURRENCY },
                description: `ניהול הורדות פלוס — Pro ${p.label} (${p.days} ימים)`,
              },
            ],
            application_context: {
              brand_name: 'ניהול הורדות פלוס',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          })
        },
        onApprove: async (data) => {
          setStatus({ kind: 'processing' })
          try {
            const payload: Record<string, string> = {
              orderID: data.orderID,
              plan: planRef.current,
            }
            // Renewal mode bypasses the email field — /api/capture
            // pulls the buyer's address off the existing key.
            if (renewTokenRef.current) {
              payload.renewToken = renewTokenRef.current
            } else {
              payload.email = emailRef.current
            }
            const r = await fetch('/api/capture', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const json = (await r.json()) as {
              ok: boolean
              error?: string
              renewed?: boolean
              newExpiresAt?: string
            }
            if (!r.ok || !json.ok) {
              throw new Error(
                json.error || 'התשלום אושר אך יצירת המפתח נכשלה',
              )
            }
            if (json.renewed && json.newExpiresAt) {
              setStatus({ kind: 'renewed', newExpiresAt: json.newExpiresAt })
            } else {
              setStatus({ kind: 'success', email: emailRef.current })
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'שגיאה לא ידועה'
            setStatus({ kind: 'error', message })
          }
        },
        onError: (err) => {
          console.error('PayPal error', err)
          setStatus({
            kind: 'error',
            message: 'התרחשה שגיאה בתהליך התשלום. נסה שוב.',
          })
        },
        onCancel: () => setStatus({ kind: 'idle' }),
      })
      .render('#paypal-button-container')
      .catch((err) => console.error('PayPal render failed', err))
  }, [emailLocked, sdkReady])

  function confirmEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus({ kind: 'error', message: 'הזן כתובת מייל תקינה' })
      return
    }
    setStatus({ kind: 'idle' })
    setEmailLocked(true)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen px-6 py-12 md:py-20"
    >
      <div className="mx-auto max-w-3xl">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-white/60 transition-colors hover:text-white"
        >
          <ArrowRight className="h-4 w-4" />
          חזרה לדף הבית
        </Link>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="mb-10 text-center"
        >
          {/* App logo — soft amber glow behind so it pops against the
              dark page background without needing a hard frame. */}
          <div className="relative mx-auto mb-5 h-20 w-20">
            <div className="absolute inset-0 rounded-2xl bg-amber-500/20 blur-2xl" />
            <img
              src="/icon.png"
              alt="ניהול הורדות פלוס"
              className="relative h-20 w-20 rounded-2xl shadow-2xl shadow-amber-900/30"
            />
          </div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-300">
            <Crown className="h-3 w-3" />
            Pro
          </div>
          <h1 className="text-3xl font-bold gradient-text md:text-4xl">
            בחירת התוכנית שמתאימה לך
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-white/60 md:text-base">
            כל הפיצ'רים פתוחים, ללא הגבלות.
          </p>
        </motion.div>

        {/* Plan toggle — two cards side by side, click to select.
            DOM order matters: in RTL, the first child renders on the
            right (where the reader's eye lands first), so the yearly
            card — the better deal we want most buyers on — goes
            first. It also carries the floating 'מומלץ' flag so the
            preference reads at a glance.
            Yearly is preselected for the same reason. */}
        <div
          dir="rtl"
          className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2"
        >
          <PlanCard
            plan="yearly"
            active={plan === 'yearly'}
            onSelect={() => setPlan('yearly')}
            title="שנתי"
            price="60"
            cycle="לשנה"
            note="שווה ערך ל-5 ₪/חודש"
            badge="חיסכון 44%"
            recommended
          />
          <PlanCard
            plan="monthly"
            active={plan === 'monthly'}
            onSelect={() => setPlan('monthly')}
            title="חודשי"
            price="9"
            cycle="לחודש"
            note="מתחדש ידנית מדי 30 יום"
          />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="glass rounded-3xl border border-white/10 p-6 md:p-8"
        >
          <h2 className="mb-4 text-sm font-semibold text-white/90">
            כל מה שתקבלו עם מנוי Pro:
          </h2>
          <ul className="mb-7 space-y-2 text-sm">
            {[
              'מיון אוטומטי + חוקי ניתוב מותאמים אישית',
              'הורדה מסרטוני וידאו ב-4K / 1080p / MP3',
              'המרת קבצים בין כל הפורמטים',
              'דחיסת וידאו לגודל יעד',
              'הצעות מחיר עם יועץ AI ופלט PDF',
              'ניהול תשלומים והכנסות',
              'עדכונים אוטומטיים ותמיכה מועדפת',
            ].map((t) => (
              <li key={t} className="flex items-start gap-2 text-white/85">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <span>{t}</span>
              </li>
            ))}
          </ul>

          {/* Renewal banner — shown whenever we're in renewal mode
              (URL had ?renew=<token>). Sits above the email/PayPal
              area so the user sees what they're extending before
              they hit pay. The actual extension math (adds plan days
              to whichever is later: current expiry or now) happens
              server-side in /api/capture's renewal branch. */}
          {renewInfo && status.kind !== 'success' && status.kind !== 'renewed' && (
            <div className="mb-4 rounded-2xl border border-cyan-400/25 bg-cyan-500/[0.06] p-4">
              <div className="flex items-start gap-3">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <div className="flex-1 text-right text-sm">
                  <div className="font-semibold text-cyan-100">
                    חידוש מנוי קיים
                  </div>
                  <div className="mt-1 text-xs text-white/70">
                    מפתח <span className="font-mono text-white/90" dir="ltr">{renewInfo.keyMasked}</span>
                    {' '}· משויך ל-
                    <span className="font-mono text-white/90" dir="ltr">{renewInfo.emailMasked}</span>
                  </div>
                  <div className="mt-2 text-xs text-white/85">
                    תוקף נוכחי: <strong>{formatExpiry(renewInfo.expiresAt)}</strong>
                    {renewInfo.isExpired && (
                      <span className="ms-2 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-300">
                        פג
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-white/55">
                    אחרי החידוש המנוי יהיה בתוקף עד{' '}
                    <strong className="text-white/85">
                      {formatExpiry(
                        new Date(
                          Math.max(
                            new Date(renewInfo.expiresAt).getTime(),
                            Date.now(),
                          ) +
                            PLANS[plan].days * 86_400_000,
                        ).toISOString(),
                      )}
                    </strong>{' '}
                    — המפתח עצמו לא משתנה.
                  </div>
                </div>
              </div>
            </div>
          )}

          {renewError && (
            <div className="mb-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">
              {renewError}
            </div>
          )}

          {renewLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-amber-200">
              <Loader2 className="h-4 w-4 animate-spin" />
              טוען את פרטי החידוש...
            </div>
          ) : status.kind === 'renewed' ? (
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-center">
              <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-300" />
              <div className="mb-2 text-base font-semibold text-emerald-200">
                המנוי הוארך בהצלחה ✓
              </div>
              <p className="text-sm text-white/80">
                התוקף החדש שלך:{' '}
                <strong className="text-white">
                  {formatExpiry(status.newExpiresAt)}
                </strong>
              </p>
              <p className="mt-2 text-xs text-white/60">
                המפתח שלך נשאר אותו דבר — אין צורך לעדכן באפליקציה. שלחנו לך גם
                מייל אישור.
              </p>
            </div>
          ) : status.kind === 'success' ? (
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-center">
              <div className="mb-2 text-base font-semibold text-emerald-200">
                התשלום הושלם בהצלחה ✓
              </div>
              <p className="text-sm text-white/75">
                שלחנו לך מייל ל-
                <span dir="ltr" className="font-mono text-white/90">
                  {' '}
                  {status.email}{' '}
                </span>
                עם מפתח המוצר. פתח את התוכנה, לחץ "מימוש מפתח מוצר" והדבק.
              </p>
              <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/85">
                💡 <strong>לא רואה את המייל?</strong> יכול להיות שהוא בספאם או
                בקידום מכירות.
              </p>
            </div>
          ) : status.kind === 'processing' ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-5 text-amber-200">
              <Loader2 className="h-4 w-4 animate-spin" />
              מייצר עבורך מפתח ושולח במייל...
            </div>
          ) : !emailLocked ? (
            <form onSubmit={confirmEmail} className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs text-white/70">
                  כתובת מייל לקבלת המפתח
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  dir="ltr"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-right text-base placeholder:text-white/30 focus:border-amber-400/50 focus:outline-none"
                />
              </label>
              <button
                type="submit"
                className="w-full rounded-xl bg-gradient-to-l from-amber-500 to-orange-500 px-6 py-3 text-base font-semibold text-white shadow-lg transition-transform hover:scale-[1.01]"
              >
                המשך לתשלום — {PLANS[plan].price.replace('.00', '')} ₪
              </button>
            </form>
          ) : (
            <>
              {/* In renewal mode the buyer + key are already shown
                  in the cyan banner above, and they can't change
                  the email (it's bound to the existing key) — so
                  skip this summary row entirely. */}
              {!renewToken && (
                <div className="mb-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-white/50">מייל: </span>
                      <span dir="ltr" className="font-mono text-white/90">
                        {email}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailLocked(false)
                        setStatus({ kind: 'idle' })
                      }}
                      className="text-xs text-amber-300/80 hover:text-amber-200"
                    >
                      שינוי
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-white/40">
                    תוכנית: {PLANS[plan].label} · {PLANS[plan].price.replace('.00', '')} ₪
                  </div>
                </div>
              )}
              {status.kind === 'error' && (
                <div className="mb-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
                  {status.message}
                </div>
              )}
              {sdkError ? (
                <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                  {sdkError}
                </div>
              ) : !sdkReady ? (
                <div className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4 text-xs text-white/60">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  טוען את PayPal...
                </div>
              ) : null}
              <div id="paypal-button-container" ref={buttonContainer} />
              <p className="mt-4 text-center text-[11px] text-white/50">
                התשלום מאובטח דרך PayPal. אתה לא מועבר לאתר חיצוני — חלון
                התשלום נפתח כאן באתר.
              </p>
            </>
          )}
        </motion.div>
      </div>
    </motion.div>
  )
}

function PlanCard({
  active,
  onSelect,
  title,
  price,
  cycle,
  note,
  badge,
  recommended,
}: {
  plan: Plan
  active: boolean
  onSelect: () => void
  title: string
  price: string
  cycle: string
  note: string
  badge?: string
  recommended?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      dir="rtl"
      className={`relative rounded-2xl border p-5 text-right transition-all ${
        active
          ? 'border-amber-400/50 bg-amber-500/[0.08] shadow-lg shadow-amber-900/20'
          : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
      } ${recommended ? 'mt-3' : ''}`}
    >
      {/* 'מומלץ' flag — floats above the card edge like a ribbon.
          Uses left-1/2 + -translate-x-1/2 (centring math is identical
          in LTR and RTL, so we don't have to special-case). */}
      {recommended && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-l from-amber-500 to-orange-500 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-950 shadow-lg shadow-amber-900/40">
          ✨ מומלץ
        </span>
      )}
      {badge && (
        <span className="absolute left-3 top-3 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
          {badge}
        </span>
      )}
      {/* Title row sits flush right inside the RTL card. We rely on
          the default justify-start: in RTL, "start" is the right edge
          of the row, so the first DOM child (the title span) lands
          on the right and the radio follows to its left. Adding
          justify-end here would push the whole group to the LEFT
          edge (the END of an RTL row) — exactly the bug this used
          to have. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base font-semibold">{title}</span>
        <div
          className={`h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
            active ? 'border-amber-400 bg-amber-400' : 'border-white/30'
          }`}
        >
          {active && (
            <div className="m-auto mt-[3px] h-1.5 w-1.5 rounded-full bg-zinc-950" />
          )}
        </div>
      </div>
      {/* Price row sits flush to the right edge of the card.
          dir="ltr" on the flex keeps the digits + currency reading
          "60 ₪ / לשנה" (number first); justify-end pushes the whole
          block to the right side of the parent so it lines up under
          the title in RTL reading order. */}
      <div
        className="mb-1 flex items-baseline justify-end gap-1.5"
        dir="ltr"
      >
        <span className="text-4xl font-bold tabular-nums">{price}</span>
        <span className="text-lg text-white/70">₪</span>
        <span className="text-xs text-white/50">/ {cycle}</span>
      </div>
      <div className="text-[11px] text-white/50">{note}</div>
    </button>
  )
}
