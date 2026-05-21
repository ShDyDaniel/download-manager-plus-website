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
import {
  currencySymbol,
  DEFAULT_PRICING,
  effectivePrice,
  formatPrice,
  type LivePricing,
} from '../lib/pricing'

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

/** Duration metadata that never changes per sale — days for the
 *  Firestore expiry math, label for Hebrew display. Pricing
 *  itself comes from /api/pricing (see `useLivePricing` in
 *  `lib/pricing.ts`) so an admin price change propagates to all
 *  pages without a code edit. */
const PLAN_META: Record<Plan, { days: number; label: string }> = {
  monthly: { days: 30, label: 'חודשי' },
  yearly: { days: 365, label: 'שנתי' },
}

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
  subscription?: {
    create: (config: { plan_id: string }) => Promise<string>
  }
}
type PayPalButton = {
  render: (target: string | HTMLElement) => Promise<void>
}
declare global {
  interface Window {
    paypal?: {
      Buttons: (opts: {
        style?: {
          layout?: string
          color?: string
          shape?: string
          label?: string
          height?: number
        }
        // Either createOrder (one-shot, capture intent) or
        // createSubscription (subscription intent) — depends on the
        // SDK load mode. We type both as optional so a single type
        // can describe both renderer paths in this file.
        createOrder?: (data: unknown, actions: PayPalActions) => Promise<string>
        createSubscription?: (
          data: unknown,
          actions: PayPalActions,
        ) => Promise<string>
        onApprove: (
          data: { orderID?: string; subscriptionID?: string },
          actions: PayPalActions,
        ) => Promise<void> | void
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
  // Live pricing — fetched from /api/pricing on mount and refreshed
  // on focus. `null` while loading; once loaded, falls back to
  // DEFAULT_PRICING if the request fails so the page never breaks.
  // Refs of the pricing alongside the state value so the PayPal
  // createOrder callback (which runs much later than the render
  // that registered it) sees the latest prices, not a snapshot.
  const [pricing, setPricing] = useState<LivePricing | null>(null)
  const pricingRef = useRef<LivePricing>(DEFAULT_PRICING)
  pricingRef.current = pricing ?? DEFAULT_PRICING

  // ── Subscription flow state (NEW, replaces the per-purchase
  //    capture flow for non-renewal mode) ────────────────────────
  // Required by Israeli consumer-protection law: the buyer must
  // tick a separate checkbox affirming consent to auto-renewal,
  // distinct from the general terms agreement. We DO NOT pre-tick
  // it — the user has to act.
  const [autoRenewAccepted, setAutoRenewAccepted] = useState(false)
  // (subSubmitting was used by the old redirect-to-PayPal flow to
  // disable the submit button mid-request. The embedded Buttons
  // path doesn't need it — PayPal's own UI shows its spinner while
  // createSubscription resolves.)
  // Returned URL param after PayPal redirects the user back here
  // post-approval (`?subscribed=1`) or post-cancel-on-PayPal-side
  // (`?cancelled=1`). Drives the post-redirect success/cancel UI.
  const [postReturn, setPostReturn] = useState<
    'subscribed' | 'cancelled' | null
  >(null)
  const [subError, setSubError] = useState<string | null>(null)

  const planRef = useRef(plan)
  planRef.current = plan
  const emailRef = useRef(email)
  emailRef.current = email
  const renewTokenRef = useRef<string | null>(renewToken)
  renewTokenRef.current = renewToken
  const buttonContainer = useRef<HTMLDivElement>(null)

  // Detect ?subscribed=1 / ?cancelled=1 returned by PayPal after
  // the user finishes (or backs out of) the approval flow. We do
  // this once on mount — same place we already parse ?renew=token.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('subscribed') === '1') setPostReturn('subscribed')
    else if (params.get('cancelled') === '1') setPostReturn('cancelled')
  }, [])

  // (Previously: submitSubscription redirect-to-PayPal handler.
  // Removed — the new embedded PayPal Smart Buttons inside
  // SubscriptionFlow call /api/paypal?action=create-subscription
  // themselves from inside their createSubscription callback, and
  // get the subscriptionId back inline so PayPal opens its own
  // popup/inline-card UI rather than navigating away.)


  // Fetch pricing once on mount. We don't block render on this —
  // the page renders with `pricing=null` initially, the plan cards
  // show a loading skeleton, and once the fetch resolves the real
  // prices appear. Same swap-in pattern Vercel-hosted SaaS sites
  // use to avoid CLS while waiting on dynamic data.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/pricing', { cache: 'no-store' })
        const json = (await r.json()) as
          | ({ ok: true } & LivePricing)
          | { ok: false; error?: string }
        if (!alive) return
        if (json.ok) {
          setPricing({
            monthly: json.monthly,
            yearly: json.yearly,
            currency: json.currency,
            saleLabel: json.saleLabel,
          })
        } else {
          setPricing(DEFAULT_PRICING)
        }
      } catch {
        // Network down? Cached fallback so the page still works.
        if (alive) setPricing(DEFAULT_PRICING)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

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
    fetch('/api/renew?action=info', {
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
    // SDK loaded in SUBSCRIPTION mode so the embedded PayPal
    // Buttons on the new-purchase flow can call createSubscription
    // and PayPal handles the vault/billing-agreement setup. The
    // older one-shot "createOrder" renewal flow is now dead (no
    // historical one-shot customers exist after the migration to
    // subscriptions), so the change in SDK intent doesn't break
    // anything users will actually hit.
    //
    // disable-funding=credit removes the US-only "PayPal Credit"
    // line of credit option but KEEPS the embedded debit/credit
    // card section — which is exactly what the user asked for:
    // "enter card details right inside the website" without
    // leaving for paypal.com.
    const params = new URLSearchParams({
      'client-id': clientId,
      currency: pricingRef.current.currency,
      vault: 'true',
      intent: 'subscription',
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

  // Renewal-mode PayPal Buttons (createOrder, one-shot capture):
  // historically this is where we rendered a "Pay" button for users
  // arriving via the /buy?renew=<token> link. After the migration
  // to recurring subscriptions the SDK is loaded with vault=true&
  // intent=subscription, which doesn't expose `actions.order` — so
  // this createOrder path can no longer work, AND no historical
  // one-shot customers exist who could trigger it. The renewal
  // flow now sees: banner → no button (PayPal SDK won't render the
  // wrong-intent buttons), and the user can just buy a fresh
  // subscription via the new flow below.
  //
  // We render a subscription Button instead so renewal mode still
  // has SOMETHING actionable — same `createSubscription` path the
  // SubscriptionFlow uses, just bound to the renewal container.
  useEffect(() => {
    if (!emailLocked) return
    if (!sdkReady) return
    if (!window.paypal) return
    if (!buttonContainer.current) return
    if (!window.paypal.Buttons) return
    buttonContainer.current.innerHTML = ''
    window.paypal
      .Buttons({
        style: {
          layout: 'vertical',
          color: 'gold',
          shape: 'rect',
          label: 'subscribe',
          height: 48,
        },
        createSubscription: async () => {
          const r = await fetch('/api/paypal?action=create-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              plan: planRef.current,
              email: emailRef.current,
            }),
          })
          const json = (await r.json()) as {
            ok: boolean
            subscriptionId?: string
            error?: string
          }
          if (!r.ok || !json.ok || !json.subscriptionId) {
            throw new Error(json.error || 'יצירת המנוי נכשלה')
          }
          return json.subscriptionId
        },
        onApprove: () => {
          window.location.href = '/buy?subscribed=1'
        },
        onError: (err) => {
          console.error('PayPal subscribe error', err)
          setStatus({
            kind: 'error',
            message: 'התרחשה שגיאה בתהליך התשלום. נסה שוב.',
          })
        },
        onCancel: () => setStatus({ kind: 'idle' }),
      })
      .render(buttonContainer.current)
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
      const r = await fetch('/api/renew?action=signin', {
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
            regularPrice={pricingRef.current.yearly.regular}
            salePrice={pricingRef.current.yearly.sale}
            currency={pricingRef.current.currency}
            saleLabel={pricingRef.current.saleLabel}
            cycle="לשנה"
            monthlyEquivalent
            comparisonMonthly={pricingRef.current.monthly}
            recommended
            loading={pricing === null}
          />
          <PlanCard
            plan="monthly"
            active={plan === 'monthly'}
            onSelect={() => setPlan('monthly')}
            title="חודשי"
            regularPrice={pricingRef.current.monthly.regular}
            salePrice={pricingRef.current.monthly.sale}
            currency={pricingRef.current.currency}
            saleLabel={pricingRef.current.saleLabel}
            cycle="לחודש"
            note="מתחדש אוטומטית מדי 30 יום"
            loading={pricing === null}
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
                            PLAN_META[plan].days * 86_400_000,
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

          {/* Two flows live in this card:
              - Renewal mode (?renew=<token> in URL): existing flow
                that uses the embedded PayPal Smart Buttons + capture
                endpoint to extend a one-shot key. Untouched.
              - Subscription mode (no renew token): NEW auto-renewing
                subscription flow that POSTs the buyer to PayPal's
                full-page approval URL. Returns here with
                ?subscribed=1 (success) or ?cancelled=1 (backed out).

              The discriminator is `renewToken`. When it's null, we're
              in subscription mode. */}
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
          ) : renewToken ? (
            /* ─── RENEWAL MODE (existing one-shot extension flow) ─── */
            status.kind === 'success' ? (
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
                  עם מפתח המוצר.
                </p>
              </div>
            ) : status.kind === 'processing' ? (
              <div className="flex items-center justify-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 p-5 text-primary">
                <Loader2 className="h-4 w-4 animate-spin" />
                מאריך את המפתח שלך...
              </div>
            ) : !emailLocked ? (
              <form onSubmit={confirmEmail} className="space-y-4">
                {/* Renewal mode uses the email field as a confirmation
                    step — the buyer's email is already known from the
                    renew token; this is just to acknowledge it before
                    PayPal renders. */}
                <button
                  type="submit"
                  className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-primary px-6 py-4 text-base font-bold text-bg shadow-lg shadow-primary/30 transition-all hover:bg-primary-hover hover:shadow-xl hover:shadow-primary/40 active:scale-[0.98]"
                >
                  <Crown className="h-5 w-5" />
                  המשך לחידוש —{' '}
                  {formatPrice(effectivePrice(pricingRef.current[plan]))}{' '}
                  {currencySymbol(pricingRef.current.currency)}
                </button>
              </form>
            ) : (
              <>
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
              </>
            )
          ) : (
            /* ─── SUBSCRIPTION MODE (new auto-renewing flow) ─── */
            <SubscriptionFlow
              postReturn={postReturn}
              email={email}
              setEmail={setEmail}
              plan={plan}
              pricing={pricingRef.current}
              autoRenewAccepted={autoRenewAccepted}
              setAutoRenewAccepted={setAutoRenewAccepted}
              error={subError}
              setError={setSubError}
              sdkReady={sdkReady}
              sdkError={sdkError}
            />
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
  regularPrice,
  salePrice,
  currency,
  saleLabel,
  cycle,
  note,
  monthlyEquivalent,
  comparisonMonthly,
  recommended,
  loading,
}: {
  plan: Plan
  active: boolean
  onSelect: () => void
  title: string
  /** The sticker price before any discount, in the currency
   *  given. Always shown — struck-through when there's a sale. */
  regularPrice: number
  /** When set, this is what the buyer pays; the regular price
   *  gets a strike-through and a "save X%" badge appears. */
  salePrice: number | null
  currency: string
  /** Admin-controlled badge text for the sale (e.g. "מבצע חורף").
   *  When set AND a sale price is active, replaces the auto-
   *  generated "X% הנחה" label so the admin's marketing copy wins. */
  saleLabel?: string
  cycle: string
  /** Static note line at the bottom of the card. Mutually
   *  exclusive with `monthlyEquivalent` — pass one or the other. */
  note?: string
  /** When true, the bottom note is auto-generated as "שווה ערך ל-X ₪/חודש"
   *  using the effective price ÷ 12. Designed for the yearly plan to
   *  show the per-month equivalent — gives buyers an apples-to-apples
   *  comparison against the monthly card without manual math. */
  monthlyEquivalent?: boolean
  /** Used together with `monthlyEquivalent` to compute the
   *  yearly-vs-monthly savings percent for the "חיסכון X%" badge.
   *  The badge appears only when (a) there's no active sale (so the
   *  "save X%" badge isn't crowding things), and (b) the effective
   *  monthly equivalent is actually lower than buying monthly. */
  comparisonMonthly?: { regular: number; sale: number | null }
  recommended?: boolean
  loading?: boolean
}) {
  // Effective values used everywhere — these abstract away
  // "is there a sale or not" so each render block doesn't have to
  // repeat the conditional.
  const onSale = salePrice != null
  const effective = onSale ? salePrice : regularPrice
  const sym = currencySymbol(currency)

  // Save-percent computed from regular vs sale prices. We round to
  // an integer because "29% הנחה" reads cleaner than "29.41%".
  const savePct = onSale
    ? Math.round(((regularPrice - salePrice) / regularPrice) * 100)
    : 0

  // Yearly-vs-monthly badge — only relevant when `comparisonMonthly`
  // is passed (the yearly card). Compares the per-month equivalent
  // of THIS plan's effective price against the monthly plan's
  // effective price. Hidden if a sale badge is already showing.
  let yearlyVsMonthly: number | null = null
  if (monthlyEquivalent && comparisonMonthly && !onSale) {
    const monthlyEff =
      comparisonMonthly.sale ?? comparisonMonthly.regular
    const thisPerMonth = effective / 12
    if (thisPerMonth < monthlyEff) {
      yearlyVsMonthly = Math.round(
        ((monthlyEff - thisPerMonth) / monthlyEff) * 100,
      )
    }
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      dir="rtl"
      className={`relative flex h-full flex-col rounded-2xl border p-5 text-right transition-all ${
        active
          ? 'border-primary bg-primary/[0.06] shadow-lg'
          : 'border-border bg-bg-elevated/50 hover:border-border-strong hover:bg-bg-elevated'
      } ${loading ? 'opacity-70' : ''}`}
    >
      {/* 'מומלץ' flag — floats above the card edge like a ribbon. */}
      {recommended && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-bg">
          ✨ מומלץ
        </span>
      )}

      {/* Top-left badge — priority: sale label > sale percent >
          yearly-vs-monthly savings. Only one shows at a time so the
          card doesn't look like a flash-sale circular. */}
      {onSale && (saleLabel || savePct > 0) && (
        <span className="absolute left-3 top-3 rounded-full border border-success/50 bg-success/20 px-2 py-0.5 text-[10px] font-bold text-success">
          {saleLabel || `${savePct}% הנחה`}
        </span>
      )}
      {!onSale && yearlyVsMonthly != null && yearlyVsMonthly > 0 && (
        <span className="absolute left-3 top-3 rounded-full border border-success/40 bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
          חיסכון {yearlyVsMonthly}%
        </span>
      )}

      {/* Title row. */}
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

      {/* Price row — the centerpiece. When there's a sale we show
          the regular price small and struck-through above, with the
          effective (sale) price big below it. Sale price gets a
          green-ish tint to reinforce "this is cheaper". When no
          sale, the regular price renders standalone in the original
          big copper-tinged style. */}
      {onSale ? (
        <div className="mb-1" dir="ltr">
          <div className="flex items-baseline justify-end gap-1.5 text-fg-muted">
            <span className="text-base font-medium tabular-nums line-through decoration-fg-muted/60">
              {formatPrice(regularPrice)}
            </span>
            <span className="text-sm">{sym}</span>
          </div>
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="text-4xl font-bold tabular-nums text-success">
              {formatPrice(salePrice)}
            </span>
            <span className="text-lg text-success/80">{sym}</span>
            <span className="text-xs text-fg-muted">/ {cycle}</span>
          </div>
        </div>
      ) : (
        <div
          className="mb-1 flex items-baseline justify-end gap-1.5"
          dir="ltr"
        >
          <span className="text-4xl font-bold tabular-nums">
            {formatPrice(regularPrice)}
          </span>
          <span className="text-lg text-fg-secondary">{sym}</span>
          <span className="text-xs text-fg-muted">/ {cycle}</span>
        </div>
      )}

      {/* Bottom note — either the static `note` prop or the auto-
          generated monthly-equivalent calculation for the yearly
          plan. We compute the equivalent against the EFFECTIVE
          price (sale if active) so a yearly sale doesn't show a
          stale "5 ₪/חודש" when it's actually less. */}
      <div className="mt-auto text-[11px] text-fg-muted">
        {monthlyEquivalent
          ? `שווה ערך ל-${formatPrice(
              Math.round((effective / 12) * 100) / 100,
            )} ${sym}/חודש`
          : note}
      </div>
    </button>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  SubscriptionFlow — the new auto-renewing payment flow.
 *
 *  Renders ONE of three states:
 *    1. Subscribed success (returned from PayPal with ?subscribed=1)
 *    2. User cancelled at PayPal (?cancelled=1)
 *    3. Default — the email + auto-renew checkbox + submit form
 *
 *  Legal-compliance disclosures embedded directly in the form
 *  (Israeli consumer-protection law sec. 13ג, 13ד):
 *    - Plan + price + currency clearly stated
 *    - Auto-renewal disclosure with the exact billing cycle
 *    - How to cancel (link to /manage)
 *    - Separate explicit consent checkbox (NOT pre-ticked)
 *    - No-refund policy disclosure
 *
 *  The actual price comes from `pricing` so admin changes (including
 *  active sales) propagate to the form immediately.
 * ───────────────────────────────────────────────────────────── */
function SubscriptionFlow({
  postReturn,
  email,
  setEmail,
  plan,
  pricing,
  autoRenewAccepted,
  setAutoRenewAccepted,
  error,
  setError,
  sdkReady,
  sdkError,
}: {
  postReturn: 'subscribed' | 'cancelled' | null
  email: string
  setEmail: (s: string) => void
  plan: Plan
  pricing: LivePricing
  autoRenewAccepted: boolean
  setAutoRenewAccepted: (b: boolean) => void
  error: string | null
  setError: (s: string | null) => void
  sdkReady: boolean
  sdkError: string | null
}) {
  if (postReturn === 'subscribed') {
    return (
      <div className="rounded-2xl border border-success/40 bg-success/10 p-5 text-center">
        <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-success" />
        <div className="mb-2 text-base font-semibold text-success">
          המנוי נוצר בהצלחה ✓
        </div>
        <p className="text-sm text-fg-secondary">
          שלחנו לך מייל עם מפתח המוצר. פתח את התוכנה, לחץ "מימוש מפתח מוצר"
          והדבק.
        </p>
        <p className="mt-3 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2 text-xs text-primary">
          💡 <strong>לא רואה את המייל?</strong> ייקח לפעמים עד דקה. בדוק גם
          בספאם / קידום מכירות.
        </p>
        <p className="mt-3 text-xs text-fg-muted">
          המנוי מתחדש אוטומטית. לביטול בכל עת:{' '}
          <a
            href="/account"
            className="text-accent underline underline-offset-2"
          >
            החשבון שלי
          </a>
        </p>
      </div>
    )
  }

  if (postReturn === 'cancelled') {
    return (
      <div className="rounded-2xl border border-border bg-bg-elevated p-5 text-center">
        <div className="mb-2 text-base font-semibold text-fg">
          הרישום בוטל
        </div>
        <p className="text-sm text-fg-secondary">
          לא נוצר מנוי ולא חויבת. אם זה היה בטעות — פשוט נסה שוב למטה.
        </p>
        <a
          href="/buy"
          className="mt-3 inline-block text-xs text-accent underline underline-offset-2"
        >
          חזרה לטופס הרישום
        </a>
      </div>
    )
  }

  const eff = effectivePrice(pricing[plan])
  const sym = currencySymbol(pricing.currency)
  const cycleLabel = plan === 'monthly' ? 'חודש' : 'שנה'
  const onSale = pricing[plan].sale != null
  // Terms modal — replaces the previously-inline "סיכום העסקה"
  // block. The legal requirement (sec. 13ג) is that the user has
  // ACCESS to the disclosures before paying, not that they're
  // permanently visible on screen. A click-to-expand link below
  // the consent checkbox satisfies that as long as the checkbox
  // text makes the auto-renew commitment explicit.
  const [termsOpen, setTermsOpen] = useState(false)

  // Email + checkbox readiness controls whether the PayPal Buttons
  // are usable. We don't render disabled buttons (PayPal Smart
  // Buttons don't have a disabled state) — instead we render a
  // placeholder hint when not ready and swap in the real Buttons
  // once the user fills the form.
  const trimmedEmail = email.trim().toLowerCase()
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
  const canPay = emailValid && autoRenewAccepted
  const paypalContainerRef = useRef<HTMLDivElement | null>(null)
  // Refs mirror the latest values of email + plan so the
  // createSubscription callback (which closes over them at button
  // mount time) reads the user's current selection, not a stale
  // snapshot. Without these the user could change the plan after
  // the Buttons rendered and still be charged for the old plan.
  const emailLatestRef = useRef(trimmedEmail)
  const planLatestRef = useRef(plan)
  emailLatestRef.current = trimmedEmail
  planLatestRef.current = plan

  // Render the embedded PayPal Buttons once the SDK is loaded AND
  // the form (email + checkbox) is valid. The Buttons component
  // includes both the PayPal account flow AND an inline debit/
  // credit-card section by default — which is what the user asked
  // for: "enter card details right inside the website" instead of
  // bouncing to paypal.com.
  useEffect(() => {
    if (!sdkReady) return
    if (!canPay) return
    if (!window.paypal?.Buttons) return
    const container = paypalContainerRef.current
    if (!container) return
    container.innerHTML = ''
    window.paypal
      .Buttons({
        style: {
          layout: 'vertical',
          color: 'gold',
          shape: 'rect',
          label: 'subscribe',
          height: 48,
        },
        createSubscription: async () => {
          try {
            const r = await fetch('/api/paypal?action=create-subscription', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                plan: planLatestRef.current,
                email: emailLatestRef.current,
              }),
            })
            const json = (await r.json()) as {
              ok: boolean
              subscriptionId?: string
              error?: string
            }
            if (!r.ok || !json.ok || !json.subscriptionId) {
              throw new Error(json.error || 'יצירת המנוי נכשלה')
            }
            return json.subscriptionId
          } catch (err) {
            setError(err instanceof Error ? err.message : 'שגיאת רשת')
            throw err
          }
        },
        onApprove: () => {
          // The PayPal popup closed successfully. The actual
          // subscription activation + license-key minting happens
          // server-side via webhook; here we just redirect the
          // browser to the success view of /buy which polls / shows
          // the post-subscribed state.
          window.location.href = '/buy?subscribed=1'
        },
        onError: (err) => {
          console.error('PayPal subscription error', err)
          setError('התרחשה שגיאה בתהליך התשלום. נסה שוב.')
        },
        onCancel: () => {
          // User closed the popup. Don't error — they explicitly
          // chose to back out.
          setError(null)
        },
      })
      .render(container)
      .catch((err) => console.error('PayPal render failed', err))
    // Re-render on plan change so the right Plan ID is wired up to
    // the next click — even though we read planRef inside the
    // callback, PayPal caches the funding-source UI on the first
    // render so a re-render keeps things in sync.
  }, [sdkReady, canPay, plan, setError])

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs text-fg-secondary">
          כתובת מייל לקבלת מפתח המנוי
        </span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          dir="ltr"
          className="w-full rounded-xl border border-border bg-bg-elevated px-4 py-3 text-right text-base text-fg placeholder:text-fg-faint focus:border-primary focus:outline-none"
          disabled={false}
        />
      </label>

      {/* Single explicit consent checkbox. Israeli consumer-
          protection law (sec. 13ג) requires the auto-renew terms
          to be disclosed up-front; we satisfy that with the
          checkbox text + a click-to-expand "תנאי המנוי" link that
          opens the full terms modal below. The checkbox is NOT
          pre-ticked (also a legal requirement). */}
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={autoRenewAccepted}
          onChange={(e) => setAutoRenewAccepted(e.target.checked)}
          className="mt-[3px] h-4 w-4 shrink-0 cursor-pointer accent-primary"
          disabled={false}
        />
        <span className="text-xs text-fg-secondary leading-relaxed">
          אני מאשר/ת חיוב אוטומטי מתחדש בסך {formatPrice(eff)} {sym} כל{' '}
          {cycleLabel}, ושקראתי ואני מסכים{' '}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setTermsOpen(true)
            }}
            className="text-accent underline underline-offset-2 hover:text-accent/80"
          >
            לתנאי המנוי
          </button>
          .
        </span>
      </label>

      {/* Terms modal — full disclosure of every term required by
          law (sec. 13ג). Opens on demand from the consent checkbox
          link above. */}
      {termsOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTermsOpen(false)
          }}
        >
          <div className="card-elevated relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border-primary/30 bg-bg-elevated p-6 md:p-7">
            <button
              type="button"
              onClick={() => setTermsOpen(false)}
              className="absolute left-3 top-3 rounded-md p-1 text-fg-muted hover:text-fg"
              aria-label="סגור"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-primary">
              <Crown className="h-4 w-4" />
              תנאי המנוי — סיכום העסקה
            </div>
            <ul className="space-y-2.5 text-xs leading-relaxed text-fg-secondary">
              <li>
                • <strong>תוכנית:</strong> מנוי Pro {cycleLabel === 'חודש' ? 'חודשי' : 'שנתי'}.
              </li>
              <li>
                • <strong>סכום החיוב:</strong>{' '}
                {onSale ? (
                  <>
                    <span className="line-through text-fg-faint">
                      {formatPrice(pricing[plan].regular)} {sym}
                    </span>{' '}
                    <strong className="text-success">
                      {formatPrice(eff)} {sym}
                    </strong>{' '}
                    לכל {cycleLabel}
                    {pricing.saleLabel && (
                      <span className="ms-1 text-success">
                        ({pricing.saleLabel})
                      </span>
                    )}
                  </>
                ) : (
                  <strong className="text-fg">
                    {formatPrice(eff)} {sym} לכל {cycleLabel}
                  </strong>
                )}
              </li>
              <li>
                • <strong>חידוש אוטומטי:</strong> החיוב יתחדש אוטומטית כל{' '}
                {cycleLabel} עד לביטול.
                {onSale && (
                  <>
                    {' '}
                    המחיר ה<strong>מוזל</strong> שלך נשמר לכל אורך תקופת המנוי
                    — גם אם המבצע יסתיים, אתה תמשיך לשלם {formatPrice(eff)}{' '}
                    {sym} עד שתבטל.
                  </>
                )}
              </li>
              <li>
                • <strong>ביטול:</strong> ניתן לבטל בכל עת בדף{' '}
                <a
                  href="/account"
                  className="text-accent underline underline-offset-2"
                >
                  החשבון שלי
                </a>
                . הביטול נכנס לתוקף מיידית — לא תחויב על תקופות עתידיות. גישת
                ה-Pro תישאר פעילה עד סוף התקופה ששולמה.
              </li>
              <li>
                • <strong>מדיניות החזרים:</strong> מאחר שמדובר במוצר דיגיטלי
                שניתן לשימוש מיידי, אין החזר על תקופות שכבר שולמו.
              </li>
              <li>
                • <strong>אבטחה:</strong> התשלום מתבצע ישירות אצל PayPal.
                אנחנו לא מאחסנים פרטי כרטיס.
              </li>
            </ul>
            <button
              type="button"
              onClick={() => setTermsOpen(false)}
              className="mt-5 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary-hover"
            >
              הבנתי
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Embedded PayPal Smart Buttons. The default rendering
          surfaces THREE payment options stacked vertically:
            1. PayPal button (opens PayPal popup; user logs in &
               approves the subscription).
            2. Pay-later button (if eligible for the user's locale).
            3. "Debit or Credit Card" button → expands an inline
               card-fields iframe ON THIS PAGE — user types card
               number / exp / CVV without leaving dm-plus.vercel.app.
          That third option is the embedded-card experience the
          user explicitly asked for: "let them enter credit card
          details right inside the website" (as in the previous
          one-shot purchase flow before the subscription migration).

          The container only renders once the form is valid
          (`canPay`) so we don't show empty/disabled buttons. The
          actual render is wired in the useEffect above. */}
      {!canPay ? (
        <div className="rounded-xl border border-border bg-bg-elevated/40 px-4 py-3 text-center text-xs text-fg-secondary">
          {!emailValid
            ? '↑ הזן כתובת מייל תקינה כדי להמשיך לתשלום'
            : '↑ אשר את החיוב המתחדש כדי להמשיך לתשלום'}
        </div>
      ) : sdkError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {sdkError}
        </div>
      ) : !sdkReady ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-elevated/40 px-4 py-4 text-xs text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          טוען את PayPal…
        </div>
      ) : (
        <>
          <div
            ref={paypalContainerRef}
            className="min-h-[48px]"
            aria-label="אפשרויות תשלום של PayPal"
          />
          <p className="text-center text-[11px] text-fg-muted">
            {formatPrice(eff)} {sym} / {cycleLabel} · מתחדש אוטומטית · ביטול בכל
            עת
          </p>
        </>
      )}
    </form>
  )
}
