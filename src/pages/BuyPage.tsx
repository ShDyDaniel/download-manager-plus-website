import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Check,
  Crown,
  Loader2,
  RefreshCw,
  CheckCircle2,
  LogIn,
  KeyRound,
  X,
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

/** One entry in the response from POST /api/renew/signin — the
 *  server signs a renewToken per redeemed key so we can drop into
 *  the existing renewal flow without re-authenticating. */
interface RenewableKey {
  key: string
  keyMasked: string
  tier: string
  expiresAt: string
  isExpired: boolean
  renewToken: string
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

/** Hide all but the first char and the domain — mirrors what the
 *  /api/renew/info endpoint returns. We mask client-side here because
 *  the signin flow already knows the plaintext email (the user just
 *  typed it), and round-tripping it through the API just to mask it
 *  would be silly. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return email
  if (local.length <= 1) return `${local}@${domain}`
  return `${local[0]}${'•'.repeat(Math.min(local.length - 1, 5))}@${domain}`
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
  // Self-service renewal (no email link): the buyer opens the panel,
  // types their account credentials, we authenticate via
  // /api/renew/signin, and either auto-select their one key or show
  // a picker if they have several. On success we shove the chosen
  // key into renewToken/renewInfo, which then drives the exact same
  // renewal UI the email-link flow uses.
  const [signinOpen, setSigninOpen] = useState(false)
  const [signinEmail, setSigninEmail] = useState('')
  const [signinPassword, setSigninPassword] = useState('')
  const [signinSubmitting, setSigninSubmitting] = useState(false)
  const [signinError, setSigninError] = useState<string | null>(null)
  const [renewableKeys, setRenewableKeys] = useState<RenewableKey[] | null>(
    null,
  )
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
    // `renewLoading` is in deps even though we don't read it
    // inside the effect: it gates whether the PayPal container is
    // actually mounted in the DOM. When the renewal-info fetch
    // settles, renewLoading flips false → the container mounts →
    // we need to re-run this effect so it can find
    // buttonContainer.current and render the button. Without this
    // dep the button never appears on /buy?renew=... pages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailLocked, sdkReady, renewLoading])

  function confirmEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus({ kind: 'error', message: 'הזן כתובת מייל תקינה' })
      return
    }
    setStatus({ kind: 'idle' })
    setEmailLocked(true)
  }

  /** Drop the picked key into the existing renewal state so the rest
   *  of the page (banner, PayPal button, capture payload) handles it
   *  identically to the email-link flow. The user's typed email
   *  becomes the masked label in the banner — they just authenticated
   *  with it, so there's no privacy gain in re-masking server-side. */
  function pickRenewableKey(item: RenewableKey) {
    setRenewToken(item.renewToken)
    setRenewInfo({
      key: item.key,
      keyMasked: item.keyMasked,
      emailMasked: maskEmail(signinEmail),
      tier: item.tier,
      expiresAt: item.expiresAt,
      isExpired: item.isExpired,
    })
    setRenewableKeys(null)
    setSigninOpen(false)
    setSigninPassword('')
    setSigninError(null)
    setEmailLocked(true)
    setStatus({ kind: 'idle' })
  }

  async function submitSignin(e: React.FormEvent) {
    e.preventDefault()
    const trimmedEmail = signinEmail.trim().toLowerCase()
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setSigninError('הזינו כתובת מייל תקינה')
      return
    }
    if (!signinPassword) {
      setSigninError('הזינו סיסמה')
      return
    }
    setSigninError(null)
    setSigninSubmitting(true)
    try {
      const r = await fetch('/api/renew/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password: signinPassword }),
      })
      const json = (await r.json()) as
        | { ok: true; keys: RenewableKey[] }
        | { ok: false; error: string }
      if (!json.ok) {
        setSigninError(json.error)
        return
      }
      if (json.keys.length === 0) {
        setSigninError(
          'לא נמצאו מנויים פעילים לחשבון הזה. אפשר לרכוש מנוי חדש למטה.',
        )
        return
      }
      // Most buyers have exactly one key — skip the picker for them.
      if (json.keys.length === 1) {
        pickRenewableKey(json.keys[0])
        return
      }
      setRenewableKeys(json.keys)
    } catch (err) {
      console.error('renew/signin failed', err)
      setSigninError('שגיאת רשת. בדקו את החיבור ונסו שוב.')
    } finally {
      setSigninSubmitting(false)
    }
  }

  function closeSigninPanel() {
    setSigninOpen(false)
    setSigninPassword('')
    setSigninError(null)
    setRenewableKeys(null)
  }

  // Close the renewal modal on Escape — standard modal affordance,
  // and avoids the user feeling trapped if they opened it by accident.
  // Also locks body scroll while open so the page underneath doesn't
  // scroll when the user spins their mousewheel inside the modal.
  useEffect(() => {
    if (!signinOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !signinSubmitting) closeSigninPanel()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [signinOpen, signinSubmitting])

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
          className="mb-8 inline-flex items-center gap-2 text-sm text-fg-muted transition-colors hover:text-fg"
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
            <div className="absolute inset-0 rounded-2xl blur-2xl" />
            <img
              src="/icon.png"
              alt="ניהול הורדות פלוס"
              className="relative h-20 w-20 rounded-2xl shadow-2xl shadow-lg"
            />
          </div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-primary">
            <Crown className="h-3 w-3" />
            Pro
          </div>
          <h1 className="text-3xl font-bold font-display text-fg md:text-4xl">
            בחירת התוכנית שמתאימה לך
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-fg-muted md:text-base">
            כל הפיצ'רים פתוחים, ללא הגבלות.
          </p>
        </motion.div>

        {/* Self-service renewal entry point. Only shown when:
            - we're NOT already in renewal mode from an email link
              (no point offering it twice), and
            - the buyer hasn't already paid / renewed in this session.
            The actual sign-in form lives in the <RenewSigninModal/>
            at the bottom of the page — this button just opens it. */}
        {!renewInfo &&
          !renewLoading &&
          status.kind !== 'success' &&
          status.kind !== 'renewed' && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.08 }}
              className="mb-6"
            >
              <button
                type="button"
                onClick={() => {
                  setSigninOpen(true)
                  setSigninError(null)
                }}
                className="group flex w-full items-center justify-center gap-2 rounded-2xl border border-accent/30 bg-accent/[0.06] px-4 py-3 text-sm font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent/[0.1]"
              >
                <RefreshCw className="h-4 w-4 text-accent transition-transform group-hover:rotate-180" />
                כבר יש לכם מנוי? לחידוש לחצו כאן
              </button>
            </motion.div>
          )}

        {/* Plan toggle — two cards side by side, click to select.
            DOM order matters: in RTL, the first child renders on the
            right (where the reader's eye lands first), so the yearly
            card — the better deal we want most buyers on — goes
            first. It also carries the floating 'מומלץ' flag so the
            preference reads at a glance.
            Yearly is preselected for the same reason.
            `items-stretch` + `h-full` on the cards guarantees both
            cards render at the same height regardless of how much
            content each one carries — the recommended card has the
            extra floating flag overhead and the discount badge, but
            the monthly card now stretches to match it instead of
            sitting visibly shorter beside it. The shared `mt-3` on
            the grid reserves space for the floating 'מומלץ' ribbon
            so it doesn't visually overlap with anything above. */}
        <div
          dir="rtl"
          className="mb-6 mt-3 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2"
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
          className="card-elevated rounded-lg border-border p-6 md:p-8"
        >
          <h2 className="mb-4 text-sm font-medium text-fg">
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
              <li key={t} className="flex items-start gap-2 text-fg-secondary">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
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
            <div className="mb-4 rounded-2xl border border-accent/30 bg-accent/[0.05] p-4">
              <div className="flex items-start gap-3">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                <div className="flex-1 text-right text-sm">
                  <div className="font-semibold text-accent">
                    חידוש מנוי קיים
                  </div>
                  <div className="mt-1 text-xs text-fg-secondary">
                    מפתח <span className="font-mono text-fg" dir="ltr">{renewInfo.keyMasked}</span>
                    {' '}· משויך ל-
                    <span className="font-mono text-fg" dir="ltr">{renewInfo.emailMasked}</span>
                  </div>
                  <div className="mt-2 text-xs text-fg-secondary">
                    תוקף נוכחי: <strong>{formatExpiry(renewInfo.expiresAt)}</strong>
                    {renewInfo.isExpired && (
                      <span className="ms-2 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                        פג
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-fg-muted">
                    אחרי החידוש המנוי יהיה בתוקף עד{' '}
                    <strong className="text-fg-secondary">
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
            <div className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {renewError}
            </div>
          )}

          {renewLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-bg-elevated p-5 text-primary">
              <Loader2 className="h-4 w-4 animate-spin" />
              טוען את פרטי החידוש...
            </div>
          ) : status.kind === 'renewed' ? (
            <div className="rounded-2xl border border-success/40 bg-success/10 p-5 text-center">
              <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-success" />
              <div className="mb-2 text-base font-semibold text-success">
                המנוי הוארך בהצלחה ✓
              </div>
              <p className="text-sm text-fg-secondary">
                התוקף החדש שלך:{' '}
                <strong className="text-fg">
                  {formatExpiry(status.newExpiresAt)}
                </strong>
              </p>
              <p className="mt-2 text-xs text-fg-muted">
                המפתח שלך נשאר אותו דבר — אין צורך לעדכן באפליקציה. שלחנו לך גם
                מייל אישור.
              </p>
            </div>
          ) : status.kind === 'success' ? (
            <div className="rounded-2xl border border-success/40 bg-success/10 p-5 text-center">
              <div className="mb-2 text-base font-semibold text-success">
                התשלום הושלם בהצלחה ✓
              </div>
              <p className="text-sm text-fg-secondary">
                שלחנו לך מייל ל-
                <span dir="ltr" className="font-mono text-fg">
                  {' '}
                  {status.email}{' '}
                </span>
                עם מפתח המוצר. פתח את התוכנה, לחץ "מימוש מפתח מוצר" והדבק.
              </p>
              <p className="mt-3 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2 text-xs text-primary">
                💡 <strong>לא רואה את המייל?</strong> יכול להיות שהוא בספאם או
                בקידום מכירות.
              </p>
            </div>
          ) : status.kind === 'processing' ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 p-5 text-primary">
              <Loader2 className="h-4 w-4 animate-spin" />
              מייצר עבורך מפתח ושולח במייל...
            </div>
          ) : !emailLocked ? (
            <form onSubmit={confirmEmail} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs text-fg-secondary">
                  כתובת מייל לקבלת המפתח
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  dir="ltr"
                  className="w-full rounded-xl border border-border bg-bg-elevated px-4 py-3 text-right text-base text-fg placeholder:text-fg-faint focus:border-primary focus:outline-none"
                />
              </label>
              {/* Primary purchase CTA. Bigger, bolder, with a Crown
                  glyph anchoring it as the unmistakable "buy Pro"
                  action on the page. Copper glow + scale-on-hover
                  give it the visual weight the previous flat button
                  was missing — buyers were getting lost between the
                  features list and the PayPal block, unsure where to
                  click. The plan + price are spelled out on a second
                  line so the commitment is fully transparent before
                  PayPal even renders. */}
              <button
                type="submit"
                className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-primary px-6 py-4 text-base font-bold text-bg shadow-lg shadow-primary/30 transition-all hover:bg-primary-hover hover:shadow-xl hover:shadow-primary/40 active:scale-[0.98]"
              >
                <Crown className="h-5 w-5" />
                <span className="flex flex-col items-center leading-tight">
                  <span className="text-base md:text-lg">
                    רכישת מנוי Pro
                  </span>
                  <span className="text-[11px] font-medium opacity-80">
                    {PLANS[plan].label} · {PLANS[plan].price.replace('.00', '')} ₪
                    {plan === 'yearly' && ' לשנה'}
                    {plan === 'monthly' && ' לחודש'}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 rotate-180 transition-transform group-hover:-translate-x-1" />
              </button>
              <p className="text-center text-[11px] text-fg-muted">
                תשלום מאובטח דרך PayPal · אין אחסון של פרטי כרטיס אצלנו
              </p>
            </form>
          ) : (
            <>
              {/* In renewal mode the buyer + key are already shown
                  in the cyan banner above, and they can't change
                  the email (it's bound to the existing key) — so
                  skip this summary row entirely. */}
              {!renewToken && (
                <div className="mb-3 rounded-xl border border-border bg-bg-elevated px-4 py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="text-fg-muted">מייל: </span>
                      <span dir="ltr" className="font-mono text-fg">
                        {email}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailLocked(false)
                        setStatus({ kind: 'idle' })
                      }}
                      className="text-xs text-primary hover:text-accent"
                    >
                      שינוי
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-fg-faint">
                    תוכנית: {PLANS[plan].label} · {PLANS[plan].price.replace('.00', '')} ₪
                  </div>
                </div>
              )}
              {status.kind === 'error' && (
                <div className="mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
                  {status.message}
                </div>
              )}
              {sdkError ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
                  {sdkError}
                </div>
              ) : !sdkReady ? (
                <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-elevated px-4 py-4 text-xs text-fg-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  טוען את PayPal...
                </div>
              ) : null}
              <div id="paypal-button-container" ref={buttonContainer} />
              <p className="mt-4 text-center text-[11px] text-fg-muted">
                התשלום מאובטח דרך PayPal. אתה לא מועבר לאתר חיצוני — חלון
                התשלום נפתח כאן באתר.
              </p>
            </>
          )}
        </motion.div>
      </div>

      {/* Renewal sign-in modal — full-screen overlay with backdrop
          blur, dialog centred via flex. Lives at the root of the
          page (not inside the max-w-3xl wrapper) so the backdrop
          covers the whole viewport regardless of where the page
          has scrolled to. AnimatePresence handles the fade/scale
          on enter+exit. */}
      <AnimatePresence>
        {signinOpen && (
          <motion.div
            key="signin-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => {
              if (!signinSubmitting) closeSigninPanel()
            }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-labelledby="renew-modal-title"
          >
            <motion.div
              key="signin-card"
              initial={{ opacity: 0, scale: 0.94, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 4 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md rounded-lg border border-border bg-bg-card p-6 shadow-lg"
            >
              <button
                type="button"
                onClick={closeSigninPanel}
                disabled={signinSubmitting}
                className="absolute left-3 top-3 rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-elevated hover:text-fg disabled:opacity-40"
                aria-label="סגירה"
              >
                <X className="h-4 w-4" />
              </button>

              <div className="mb-4 flex items-center gap-2 pe-8 text-base font-semibold text-accent">
                <LogIn className="h-4 w-4 text-accent" />
                <span id="renew-modal-title">חידוש מנוי קיים</span>
              </div>

              {/* Picker mode: API returned >1 key for this account.
                  Each row is a button — click to drop into the
                  renewal flow with that key. */}
              {renewableKeys ? (
                <div className="space-y-2">
                  <p className="mb-1 text-xs text-fg-muted">
                    בחרו את המפתח לחידוש:
                  </p>
                  {renewableKeys.map((k) => (
                    <button
                      key={k.key}
                      type="button"
                      onClick={() => pickRenewableKey(k)}
                      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-bg-elevated px-4 py-3 text-right transition-colors hover:border-accent/40 hover:bg-accent/[0.05]"
                    >
                      <div className="min-w-0 flex-1">
                        <div
                          className="font-mono text-sm text-fg"
                          dir="ltr"
                        >
                          {k.keyMasked}
                        </div>
                        <div className="mt-0.5 text-[11px] text-fg-muted">
                          תוקף נוכחי: {formatExpiry(k.expiresAt)}
                          {k.isExpired && (
                            <span className="ms-2 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                              פג
                            </span>
                          )}
                        </div>
                      </div>
                      <KeyRound className="h-4 w-4 shrink-0 text-accent" />
                    </button>
                  ))}
                </div>
              ) : (
                <form onSubmit={submitSignin} className="space-y-3">
                  <p className="text-xs text-fg-muted">
                    התחברו עם החשבון שאיתו מימשתם את המפתח כדי לחדש את התוקף.
                  </p>
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-fg-muted">
                      אימייל
                    </span>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={signinEmail}
                      onChange={(e) => setSigninEmail(e.target.value)}
                      placeholder="you@example.com"
                      dir="ltr"
                      disabled={signinSubmitting}
                      autoFocus
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
                      autoComplete="current-password"
                      value={signinPassword}
                      onChange={(e) => setSigninPassword(e.target.value)}
                      dir="ltr"
                      disabled={signinSubmitting}
                      className="w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
                    />
                  </label>
                  {signinError && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {signinError}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={signinSubmitting}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {signinSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        מתחבר...
                      </>
                    ) : (
                      <>
                        <LogIn className="h-4 w-4" />
                        התחברות וחידוש
                      </>
                    )}
                  </button>
                  <p className="text-center text-[10px] text-fg-faint">
                    שכחתם סיסמה? פתחו את התוכנה ולחצו &quot;שכחתי סיסמה&quot;
                    בחלון ההתחברות.
                  </p>
                </form>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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
      className={`relative flex h-full flex-col rounded-2xl border p-5 text-right transition-all ${
        active
          ? 'border-primary bg-primary/[0.06] shadow-lg'
          : 'border-border bg-bg-elevated/50 hover:border-border-strong hover:bg-bg-elevated'
      }`}
    >
      {/* 'מומלץ' flag — floats above the card edge like a ribbon.
          Uses left-1/2 + -translate-x-1/2 (centring math is identical
          in LTR and RTL, so we don't have to special-case). */}
      {recommended && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-bg">
          ✨ מומלץ
        </span>
      )}
      {badge && (
        <span className="absolute left-3 top-3 rounded-full border border-success/40 bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
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
            active ? 'border-primary bg-primary' : 'border-fg-faint'
          }`}
        >
          {active && (
            <div className="m-auto mt-[3px] h-1.5 w-1.5 rounded-full bg-bg" />
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
        <span className="text-lg text-fg-secondary">₪</span>
        <span className="text-xs text-fg-muted">/ {cycle}</span>
      </div>
      <div className="mt-auto text-[11px] text-fg-muted">{note}</div>
    </button>
  )
}
