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
  Lock,
  X,
} from 'lucide-react'
import {
  currencySymbol,
  DEFAULT_PRICING,
  effectivePrice,
  fetchLivePricingStrict,
  formatPrice,
  readPricingCache,
  writePricingCache,
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
  /** The current plan's cycle length (30 for monthly, 365 for
   *  yearly). Null only for legacy keys created before the field
   *  was added — those will skip the auto-lock logic and let the
   *  buyer pick any plan. */
  planDays: number | null
  /** PayPal lifecycle state ('active' | 'cancelled' | 'past_due' |
   *  'suspended' | 'expired' | null). Used together with
   *  isExpired to decide if the current plan should be auto-
   *  locked: only locked when status is 'active' AND not expired. */
  subscriptionStatus: string | null
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
  planDays: number | null
  subscriptionStatus: string | null
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
        // 'card' renders ONLY the credit-card funding source; omit
        // (default) to let PayPal stack every eligible funding source
        // vertically (PayPal account + card + paylater + ...).
        // We use 'card' to keep the checkout focused on direct card
        // entry without the dominant yellow PayPal upsell button.
        fundingSource?: string
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

/**
 *  Trust strip rendered directly under each card-payment button.
 *
 *  The old vertical-stack layout included PayPal's own yellow
 *  branded button, which doubled as the "this is a PayPal flow"
 *  trust signal — buyers visually understood who's handling their
 *  card. After moving to fundingSource:'card' the dark button no
 *  longer carries that branding, so without an explicit strip the
 *  page looks like an un-attributed card form (which is exactly
 *  the kind of UI that makes buyers nervous about typing their
 *  card details into).
 *
 *  Two lines:
 *    1. "תשלום מאובטח, מעובד על־ידי PayPal" — names the processor
 *       + adds a lock icon for the universal "secure" affordance.
 *    2. "פרטי הכרטיס מועברים ישירות ל-PayPal ולא נשמרים אצלנו"
 *       — addresses the specific worry a security-aware buyer has
 *       on a small Israeli site: "am I trusting a homemade
 *       payment form?". Answer: no, you're trusting PayPal.
 *
 *  The PayPal wordmark uses #0070ba (PayPal's accessible
 *  medium-blue). The darker brand blue (#003087) doesn't pass
 *  contrast on the espresso background.
 */
function PaymentTrustStrip() {
  return (
    <div className="flex flex-col items-center gap-0.5 pt-2">
      <p className="flex items-center justify-center gap-1.5 text-[11px] text-fg-muted">
        <Lock className="h-3 w-3" aria-hidden />
        <span>תשלום מאובטח, מעובד על־ידי</span>
        <span className="font-semibold text-[#0070ba]">PayPal</span>
      </p>
      <p className="text-center text-[10px] text-fg-muted/70">
        פרטי הכרטיס מועברים ישירות ל-PayPal ולא נשמרים אצלנו
      </p>
    </div>
  )
}

/**
 *  Pick a user-facing error message for a PayPal flow failure.
 *
 *  The createSubscription callback re-throws errors as
 *  `new Error(json.error)`, so when our backend rejects (rate
 *  limit, invalid plan, invalid email, etc.) the actual Hebrew
 *  reason rides in err.message. PayPal's SDK also calls onError
 *  for client-side problems (popup blocked, network blip in the
 *  PayPal-hosted iframe, etc.) — those messages are English /
 *  technical and we replace them with the generic Hebrew copy.
 *
 *  Heuristic: if err.message contains any Hebrew character we
 *  trust it as already-localized text and show it as-is.
 */
function pickPayPalErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message && /[֐-׿]/.test(err.message)) {
    return err.message
  }
  return fallback
}

/** sessionStorage key AccountPage uses to hand off the "I'm a
 *  signed-in account upgrading" context. Mirrored from
 *  AccountPage — keep both in sync if you rename. */
const PURCHASE_CONTEXT_KEY = 'dmplus.purchaseContext.v1'

/** Cross-page session token key. Mirrors AccountPage's constant of
 *  the same name. After the buyer logs in via the "כבר יש לי מנוי"
 *  signin modal here, we mint a /account session and stash the
 *  token here so navigating to /account doesn't re-prompt for a
 *  password. Must stay in sync with AccountPage. */
const SESSION_TOKEN_KEY = 'dmplus.session.v1'

interface PurchaseContext {
  sessionToken: string
  email: string
  hasExpiredKey: boolean
}

export function BuyPage() {
  const [plan, setPlan] = useState<Plan>('yearly')
  const [email, setEmail] = useState('')
  const [emailLocked, setEmailLocked] = useState(false)
  // Populated on mount from sessionStorage if the buyer arrived
  // from /account (logged in). When set, the email is pre-filled
  // and locked, and the session token is forwarded to create-
  // subscription so the backend webhook can auto-redeem the new
  // key to this account.
  const [purchaseContext, setPurchaseContext] =
    useState<PurchaseContext | null>(null)
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
  // Plan-switch mode — populated when the URL carries
  // ?switchTo=monthly|yearly alongside ?renew=<token>. The /account
  // "שינוי תוכנית" link sends users here. When set:
  //   - The target plan (the one they're switching TO) is
  //     pre-selected on mount.
  //   - The OTHER plan card shows a "המנוי הנוכחי" badge and is
  //     non-clickable (no logic to "switch" to the plan you're
  //     already on).
  //   - A dedicated switch banner replaces the generic renewal
  //     banner with a full explanation of what's about to happen.
  const [switchTo, setSwitchTo] = useState<Plan | null>(null)
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
  // Forgot-password state inside the renewal sign-in modal. Same
  // pattern as the /account login form — clicking "שכחתי סיסמה"
  // toggles the modal contents from a signin form to a reset-
  // password form so users don't have to leave /buy to recover
  // their password. The email state (signinEmail) is shared
  // across both modes so an address typed in one pre-fills the
  // other on toggle.
  const [forgotPasswordMode, setForgotPasswordMode] = useState(false)
  const [resetSending, setResetSending] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  // Live pricing — fetched from /api/pricing on mount and refreshed
  // on focus. `null` while loading; once loaded, falls back to
  // DEFAULT_PRICING if the request fails so the page never breaks.
  // Refs of the pricing alongside the state value so the PayPal
  // createOrder callback (which runs much later than the render
  // that registered it) sees the latest prices, not a snapshot.
  // Lazy initial state seeded from the localStorage pricing cache.
  // Returning visitors (anyone who hit the site once before in this
  // browser) get the right prices on the very first paint — no
  // flash of the hardcoded DEFAULT_PRICING that the user saw under
  // the old "always start with null" approach. First-ever visitors
  // still get null + skeleton until the fetch resolves.
  const [pricing, setPricing] = useState<LivePricing | null>(() =>
    readPricingCache(),
  )
  // Hard-block flag. Set true when the STRICT pricing fetch fails
  // (server/Firestore down) — the page then refuses to show any
  // checkout button and renders a "service unavailable" notice
  // instead. Critical because a purchase made while the backend is
  // down would charge real money (PayPal LIVE) but the webhook
  // couldn't mint a product key — money in, nothing out. See
  // fetchLivePricingStrict() for the full rationale.
  const [pricingUnavailable, setPricingUnavailable] = useState(false)
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


  // Fetch pricing once on mount. The shared `fetchLivePricing` +
  // localStorage cache is in src/lib/pricing.ts; using it directly
  // here (instead of inline fetch) means returning visitors get the
  // cached value rendered on the FIRST PAINT — no flash of the
  // hardcoded DEFAULT_PRICING. First-ever visitors with no cache
  // still see the skeleton state in the plan cards (`pricing=null`)
  // until the network response lands.
  useEffect(() => {
    let alive = true
    // Synchronous cache read for first-paint freshness — lets a
    // returning visitor see plausible prices instantly. But the
    // cache is NOT trusted for the actual sale: the strict fetch
    // below must confirm a live price before checkout is allowed,
    // so a stale cache can't enable a purchase during an outage.
    const cached = readPricingCache()
    if (cached) setPricing(cached)
    void fetchLivePricingStrict().then((p) => {
      if (!alive) return
      if (p) {
        // Server confirmed a real price — safe to sell.
        setPricing(p)
        setPricingUnavailable(false)
        writePricingCache(p)
      } else {
        // Could NOT confirm the price (server/Firestore down).
        // Block checkout. We deliberately do NOT fall back to the
        // cached value or DEFAULT_PRICING for the SALE — showing a
        // buy button now risks a charge with no key minted.
        setPricingUnavailable(true)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // Pick up the "purchase context" sessionStorage handoff from
  // /account, if any. We DON'T delete the entry immediately — the
  // user might refresh the page before completing payment and we
  // want them to stay in the "logged-in" flow. We clear it after
  // PayPal's onApprove fires successfully, AND on unmount, so a
  // stale token from a previous session doesn't bleed into a
  // future guest visit.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.sessionStorage.getItem(PURCHASE_CONTEXT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<PurchaseContext>
      if (
        typeof parsed.sessionToken !== 'string' ||
        typeof parsed.email !== 'string'
      ) {
        window.sessionStorage.removeItem(PURCHASE_CONTEXT_KEY)
        return
      }
      const ctx: PurchaseContext = {
        sessionToken: parsed.sessionToken,
        email: parsed.email,
        hasExpiredKey: parsed.hasExpiredKey === true,
      }
      setPurchaseContext(ctx)
      setEmail(ctx.email)
    } catch {
      try {
        window.sessionStorage.removeItem(PURCHASE_CONTEXT_KEY)
      } catch {
        // ignore — storage might be off in some browsers
      }
    }
  }, [])

  // ── SSO bootstrap from the desktop "לקניית רישיון" button ──
  //
  // The Electron app opens this page with a Firebase ID token in
  // the URL fragment (#t=…). Same scheme /account uses. We exchange
  // the token for our session JWT, then route the user to the
  // right purchase flow:
  //
  //   - Has a primary key → mint a renewToken + redirect to
  //     /buy?renew=<token>, lighting up the existing yellow renewal
  //     panel. The webhook will EXTEND their key.
  //   - No primary key   → set purchaseContext (sessionStorage +
  //     React state) so the webhook AUTO-REDEEMS the new key to
  //     this account.
  //
  // Token is stripped from the URL immediately — back/forward nav
  // shouldn't expose it, and screenshots shouldn't capture it.
  // While the SSO round-trip is in flight we show a small overlay
  // so the user doesn't see a half-rendered guest-purchase form
  // for a frame.
  const [ssoBootstrapping, setSsoBootstrapping] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return /[#&]t=[^&]+/.test(window.location.hash)
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const match = window.location.hash.match(/[#&]t=([^&]+)/)
    if (!match) return
    const idToken = decodeURIComponent(match[1])
    try {
      const cleanUrl =
        window.location.pathname +
        window.location.search +
        (window.location.hash.replace(/[#&]t=[^&]+/, '').replace(/^#$/, '') || '')
      window.history.replaceState(null, '', cleanUrl)
    } catch {
      // ignore — replaceState rejection is rare and we still
      // proceed (the token will get used immediately, short-lived).
    }

    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        const json = (await r.json()) as {
          ok: boolean
          token?: string
          email?: string
          profile?: { email: string; keyLast8: string | null }
          error?: string
        }
        if (!r.ok || !json.ok || !json.token || !json.profile) {
          // SSO failed — silently fall back to guest purchase
          // flow. Better than blocking the user; they can still
          // type their email manually and buy.
          console.warn('[BuyPage] SSO failed, continuing as guest', json.error)
          return
        }
        const sessionToken = json.token
        const profile = json.profile

        if (profile.keyLast8) {
          // Has key → mint a renewToken + redirect. The new page
          // load will pick up ?renew=<token> and show the yellow
          // renewal panel.
          const r2 = await fetch('/api/paypal?action=mint-renew-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: sessionToken }),
          })
          const json2 = (await r2.json()) as {
            ok: boolean
            renewToken?: string
            error?: string
          }
          if (r2.ok && json2.ok && json2.renewToken) {
            window.location.href = `/buy?renew=${encodeURIComponent(json2.renewToken)}`
            return
          }
          // mint-renew-token failed — fall through to no-key path
          console.warn(
            '[BuyPage] mint-renew-token failed, falling back to purchaseContext',
            json2.error,
          )
        }

        // No key (or mint failed) → wire up auto-redeem via
        // purchaseContext. Sets both sessionStorage (so a refresh
        // keeps the state) and the in-memory state (so the user
        // sees the locked-email UI immediately).
        const ctx: PurchaseContext = {
          sessionToken,
          email: profile.email,
          hasExpiredKey: false,
        }
        setPurchaseContext(ctx)
        setEmail(profile.email)
        try {
          window.sessionStorage.setItem(
            PURCHASE_CONTEXT_KEY,
            JSON.stringify(ctx),
          )
        } catch {
          // storage off — purchaseContext stays in memory only,
          // which works fine until the user refreshes.
        }
      } catch (err) {
        console.error('[BuyPage] SSO bootstrap threw', err)
      } finally {
        setSsoBootstrapping(false)
      }
    })()
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
    // Also parse ?switchTo=monthly|yearly — passed by the /account
    // "שינוי תוכנית" link. Pre-selects the target plan so the
    // buyer doesn't have to find it; the OPPOSITE card will get
    // locked + badged as "המנוי הנוכחי" further down. Setting it
    // before the fetch resolves means the plan picker reflects
    // the right choice on first paint, no flash of the default.
    const switchToParam = params.get('switchTo')
    if (switchToParam === 'monthly' || switchToParam === 'yearly') {
      setSwitchTo(switchToParam)
      setPlan(switchToParam)
    }
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
        // Auto-lock current plan when the buyer arrived via an
        // email-link renewal AND still has an active sub. Same
        // logic as pickRenewableKey above — the explicit URL
        // ?switchTo= already short-circuited this earlier in the
        // effect, so we only apply auto-lock if the URL didn't
        // supply one.
        if (
          !switchToParam &&
          !json.isExpired &&
          json.subscriptionStatus === 'active' &&
          (json.planDays === 30 || json.planDays === 365)
        ) {
          const opp: Plan = json.planDays === 30 ? 'yearly' : 'monthly'
          setSwitchTo(opp)
          setPlan(opp)
        }
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
        // Card-only — see the comment on Window.paypal.Buttons.
        fundingSource: 'card',
        style: {
          shape: 'rect',
          color: 'black',
          label: 'pay',
          height: 48,
        },
        createSubscription: async () => {
          const r = await fetch('/api/paypal?action=create-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              plan: planRef.current,
              email: emailRef.current,
              // Renewal-mode buttons run on /buy?renew=<token>.
              // Passing the renewToken makes the backend webhook
              // EXTEND the existing key instead of creating a new
              // one — what the user wants on the renewal panel.
              renewToken: renewTokenRef.current,
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
            message: pickPayPalErrorMessage(
              err,
              'התרחשה שגיאה בתהליך התשלום. נסה שוב.',
            ),
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
      planDays: item.planDays,
      subscriptionStatus: item.subscriptionStatus,
    })
    // Auto-lock: if the user signed in to a still-active
    // subscription, treat it as a plan-switch (lock current plan,
    // pre-select the other). Same UX as the /account "שינוי
    // תוכנית" link — there's no logical reason for someone with
    // an active monthly to "renew" to monthly again from /buy
    // (PayPal already auto-charges them); the only useful action
    // is switching. Expired / cancelled / past-due subs still
    // show both plans freely because they really might want the
    // same plan to restart.
    if (
      !item.isExpired &&
      item.subscriptionStatus === 'active' &&
      (item.planDays === 30 || item.planDays === 365)
    ) {
      const opp: Plan = item.planDays === 30 ? 'yearly' : 'monthly'
      setSwitchTo(opp)
      setPlan(opp)
    }
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
      // The buyer just proved they know the password. Mint a
      // /account session in parallel and persist it in
      // sessionStorage so when they navigate away from /buy (e.g.
      // click "החשבון שלי" in the top corner) the next page
      // restores the session via /api/paypal?action=restore-session
      // instead of asking for the password again.
      //
      // This is a second Firebase Auth call but it's cheap (Auth
      // REST is fast and we just verified the same credentials
      // succeed). Errors are swallowed — the renewal flow itself
      // still works even if the session-token mint fails.
      try {
        const sessR = await fetch('/api/paypal?action=session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            password: signinPassword,
          }),
        })
        const sessJson = (await sessR.json()) as {
          ok?: boolean
          token?: string
        }
        if (sessR.ok && sessJson.ok && sessJson.token) {
          try {
            window.sessionStorage.setItem(
              SESSION_TOKEN_KEY,
              sessJson.token,
            )
          } catch {
            // sessionStorage disabled — degrade gracefully.
          }
        }
      } catch {
        // Don't break the renew flow if the session call has a
        // network blip. The user will just need to log in again
        // if they navigate to /account.
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
    // Reset the forgot-password sub-state so opening the modal
    // again starts on the signin form, not on a stale reset view.
    setForgotPasswordMode(false)
    setResetSent(false)
    setResetError(null)
  }

  /** Send a password reset email from the in-modal forgot flow.
   *  Wires to the same /api/reset-password endpoint /account uses.
   *  Backend deliberately returns 200 even for unknown emails to
   *  prevent account enumeration, so the success copy is hedged
   *  ("if the account exists"). */
  async function handleResetPasswordFromModal() {
    const trimmedEmail = signinEmail.trim().toLowerCase()
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setResetError('הזינו כתובת מייל תקינה')
      return
    }
    setResetError(null)
    setResetSending(true)
    try {
      const r = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
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

  // While the SSO from the desktop "buy" button is in flight, show
  // a full-screen overlay so the user doesn't see a half-rendered
  // guest-mode form for the ~200ms round-trip. The bootstrap
  // resolves to one of three states: redirect to /buy?renew=…,
  // fall back to guest, or set purchaseContext. The overlay hides
  // all of that.
  if (ssoBootstrapping) {
    return (
      <div
        dir="rtl"
        className="flex min-h-screen items-center justify-center px-6"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <div className="text-sm font-medium text-fg">
            מתחבר לחשבון שלך…
          </div>
          <div className="text-xs text-fg-muted">
            שניה אחת.
          </div>
        </div>
      </div>
    )
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

        {/* Pricing-unavailable HARD BLOCK. When the strict pricing
            fetch failed (server / Firestore down) we refuse to show
            ANY checkout UI below — a purchase right now would charge
            real money (PayPal LIVE) but the post-payment webhook
            couldn't mint a product key, leaving the buyer paid-but-
            keyless. Showing this notice INSTEAD of the plan cards +
            flow closes that window. See fetchLivePricingStrict(). */}
        {pricingUnavailable ? (
          <div className="mb-6 rounded-2xl border border-destructive/30 bg-destructive/10 px-6 py-8 text-center">
            <h2 className="text-lg font-semibold text-fg">
              הרכישה אינה זמינה כרגע
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-fg-muted">
              לא הצלחנו לטעון את פרטי המנוי מהשרת כרגע, כנראה עקב
              עומס זמני. כדי לא לחייב אתכם לפני שהכול מוכן, חסמנו
              את הרכישה לרגע. אנא נסו שוב בעוד מספר דקות.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm text-fg transition-colors hover:bg-bg-elevated"
            >
              נסו שוב
            </button>
          </div>
        ) : (
        <>
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
            // Plan-switch flow: when user is switching TO monthly,
            // their current plan is yearly — this card needs the
            // "המנוי הנוכחי" badge + non-clickable styling so they
            // can only pick the other one.
            currentPlanBadge={switchTo === 'monthly'}
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
            // Mirror of the yearly card: switching TO yearly =
            // current is monthly = this card locks.
            currentPlanBadge={switchTo === 'yearly'}
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
              'פתיחת תיקייה אחרי העברה באופן אוטומטי',
              'מערכת AI למיון מוזיקה וסאונד אפקט',
              'שינוי כללי מיון',
              'דחיסת וידאו למשקל מדויק',
              'מערכת הצעות מחיר מלאה',
              'ניהול תשלומים והכנסות',
              'עדכונים אוטומטיים ותמיכה מועדפת',
            ].map((t) => (
              <li key={t} className="flex items-start gap-2 text-fg-secondary">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span>{t}</span>
              </li>
            ))}
          </ul>

          {/* Plan-switch banner — shown when ?switchTo=... is on
              the URL (user came in via /account "שינוי תוכנית").
              Replaces the generic renewal banner with a full
              explanation of what's about to happen: payment amount,
              auto-cancellation of the old sub, carried-forward
              days, new expiry. Heavy on detail by design — the
              buyer needs to understand they won't be double-charged
              before they hit pay. */}
          {renewInfo &&
            switchTo &&
            status.kind !== 'success' &&
            status.kind !== 'renewed' &&
            (() => {
              const oldExpMs = Math.max(
                new Date(renewInfo.expiresAt).getTime(),
                Date.now(),
              )
              const newExpMs = oldExpMs + PLAN_META[switchTo].days * 86_400_000
              const carriedDays = renewInfo.isExpired
                ? 0
                : Math.max(
                    0,
                    Math.ceil(
                      (new Date(renewInfo.expiresAt).getTime() - Date.now()) /
                        (24 * 60 * 60 * 1000),
                    ),
                  )
              const fromLabel = switchTo === 'yearly' ? 'חודשי' : 'שנתי'
              const toLabel = switchTo === 'yearly' ? 'שנתי' : 'חודשי'
              const newCycleWord = switchTo === 'yearly' ? 'שנה' : 'חודש'
              return (
                <div className="mb-4 rounded-2xl border border-primary/40 bg-primary/[0.06] p-4">
                  <div className="flex items-start gap-3">
                    <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="flex-1 text-right text-sm">
                      <div className="text-base font-semibold text-primary">
                        מעבר ממסלול {fromLabel} למסלול {toLabel}
                      </div>
                      <div className="mt-2 text-xs text-fg-secondary">
                        מפתח{' '}
                        <span className="font-mono text-fg" dir="ltr">
                          {renewInfo.keyMasked}
                        </span>{' '}
                        · משויך ל-
                        <span className="font-mono text-fg" dir="ltr">
                          {renewInfo.emailMasked}
                        </span>
                      </div>

                      <div className="mt-3 space-y-1.5 text-xs text-fg-secondary">
                        <div className="flex items-start gap-2">
                          <span className="text-primary">✓</span>
                          <span>
                            תחויב היום עבור ה{newCycleWord} הבא{' '}
                            <strong className="text-fg">
                              (לפי המסלול ה{toLabel})
                            </strong>
                          </span>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="text-primary">✓</span>
                          <span>
                            המנוי ה{fromLabel} הקיים{' '}
                            <strong className="text-fg">יבוטל אוטומטית</strong>{' '}
                            — לא תחויב עליו שוב
                          </span>
                        </div>
                        {carriedDays > 0 && (
                          <div className="flex items-start gap-2">
                            <span className="text-primary">✓</span>
                            <span>
                              <strong className="text-fg">
                                {carriedDays} הימים
                              </strong>{' '}
                              שנותרו לך מהמסלול ה{fromLabel}{' '}
                              <strong className="text-fg">יישמרו</strong>{' '}
                              ויתווספו על גבי ה{newCycleWord} החדש
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="mt-3 rounded-lg border border-accent/30 bg-accent/[0.05] px-3 py-2.5">
                        <div className="text-[11px] text-fg-muted">
                          הגישה תהיה בתוקף עד
                        </div>
                        <div className="text-base font-semibold text-accent">
                          {formatExpiry(new Date(newExpMs).toISOString())}
                        </div>
                      </div>

                      <div className="mt-2 text-[11px] text-fg-muted">
                        המפתח עצמו לא משתנה — אין צורך להזין שום דבר חדש בתוכנה.
                      </div>
                    </div>
                  </div>
                </div>
              )
            })()}

          {/* Renewal banner — shown whenever we're in renewal mode
              (URL had ?renew=<token>) but NOT in plan-switch mode
              (?switchTo=...). The two banners are mutually exclusive:
              switch has its own explainer above, regular renewal
              keeps the simpler banner below. Sits above the
              email/PayPal area so the user sees what they're
              extending before they hit pay. The actual extension
              math (adds plan days to whichever is later: current
              expiry or now) happens server-side in the renewal
              branch. */}
          {renewInfo && !switchTo && status.kind !== 'success' && status.kind !== 'renewed' && (
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
                <PaymentTrustStrip />
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
              purchaseContext={purchaseContext}
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
              ) : forgotPasswordMode ? (
                /* ── Forgot-password sub-mode ──
                 *
                 * Replaces the signin form when the user clicks
                 * "שכחתי סיסמה" below. Shares the same signinEmail
                 * state so an address typed in the signin form is
                 * pre-filled here on toggle. Mirrors the /account
                 * forgot-password block so users get the same
                 * experience whether they recover from /account or
                 * from inside this renewal modal. */
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void handleResetPasswordFromModal()
                  }}
                  className="space-y-3"
                >
                  {resetSent ? (
                    <>
                      <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-xs text-success">
                        ✓ אם החשבון קיים, נשלח אליו מייל איפוס סיסמה
                        {signinEmail.trim() && (
                          <>
                            {' '}לכתובת <strong>{signinEmail.trim()}</strong>
                          </>
                        )}
                        . בדקו את תיבת הדואר (כולל ספאם).
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setForgotPasswordMode(false)
                          setResetSent(false)
                          setResetError(null)
                        }}
                        className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg-faint"
                      >
                        <ArrowRight className="h-4 w-4" />
                        חזרה להתחברות
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-fg-muted">
                        הזינו את האימייל שאיתו נרשמתם — נשלח אליו קישור
                        לאיפוס הסיסמה.
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
                          disabled={resetSending}
                          autoFocus
                          className="w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
                        />
                      </label>
                      {resetError && (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          {resetError}
                        </div>
                      )}
                      <button
                        type="submit"
                        disabled={resetSending}
                        className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {resetSending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Lock className="h-4 w-4" />
                        )}
                        שלח לי קישור איפוס
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setForgotPasswordMode(false)
                          setResetError(null)
                        }}
                        className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-transparent px-4 py-2 text-xs text-fg-muted transition-colors hover:bg-bg-elevated hover:text-fg"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                        חזרה להתחברות
                      </button>
                    </>
                  )}
                </form>
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
                      disabled={signinSubmitting}
                      autoFocus
                      // No explicit dir — inherits dir="rtl" from
                      // <html lang="he"> so the placeholder and
                      // typed content align right under the
                      // right-aligned "אימייל" label, matching the
                      // /account login form. The latin email
                      // characters still render LTR via Unicode
                      // bidi.
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
                  {/* "שכחתי סיסמה" — toggle to the inline reset form
                      above. Stays inside the same modal so the user
                      never has to leave /buy to recover access. */}
                  <div className="pt-1 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setSigninError(null)
                        setResetError(null)
                        setResetSent(false)
                        setForgotPasswordMode(true)
                      }}
                      disabled={signinSubmitting}
                      className="text-[11px] text-fg-muted underline-offset-4 transition-colors hover:text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      שכחתי סיסמה
                    </button>
                  </div>
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
  currentPlanBadge,
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
  /** When true, this card represents the buyer's CURRENT plan in a
   *  plan-switch flow (?switchTo=... on the URL). The card becomes
   *  non-interactive (no onSelect) and shows a "המנוי הנוכחי" pill
   *  so the user understands why they can't pick it. Used by /buy
   *  when the user arrives via the /account "שינוי תוכנית" link. */
  currentPlanBadge?: boolean
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
      onClick={currentPlanBadge ? undefined : onSelect}
      disabled={currentPlanBadge}
      aria-disabled={currentPlanBadge || undefined}
      dir="rtl"
      className={`relative flex h-full flex-col rounded-2xl border p-5 text-right transition-all ${
        currentPlanBadge
          ? 'cursor-not-allowed border-border bg-bg-elevated/30 opacity-55'
          : active
            ? 'border-primary bg-primary/[0.06] shadow-lg'
            : 'border-border bg-bg-elevated/50 hover:border-border-strong hover:bg-bg-elevated'
      } ${loading ? 'opacity-70' : ''}`}
    >
      {/* "המנוי הנוכחי" — sticker on plan-switch flow. Anchored
          top-left so it sits opposite the 'מומלץ' ribbon (which
          floats top-right in RTL). The two never collide because
          you can't be BOTH "currently on this plan" AND "the
          recommended one to switch to" at the same time — switchTo
          locks the current card and disables 'מומלץ'-driven styling. */}
      {currentPlanBadge && (
        <div className="absolute -top-3 right-4 z-10 rounded-full border border-fg-muted/30 bg-bg px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted shadow">
          המנוי הנוכחי
        </div>
      )}
      {/* 'מומלץ' flag — floats above the card edge like a ribbon. */}
      {recommended && !currentPlanBadge && (
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

      {/* Price row. When pricing is still loading (no cache + no
          response yet) we render a shimmer skeleton instead of the
          numbers — the previous version flashed the hardcoded
          DEFAULT_PRICING for ~200ms which read as "the price just
          changed" when it actually didn't. Skeleton is sized to
          match the real price block so the layout doesn't jump
          when the data arrives. */}
      {loading ? (
        <div className="mb-1" dir="ltr">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="h-9 w-16 animate-pulse rounded bg-fg-muted/20" />
            <span className="h-5 w-3 animate-pulse rounded bg-fg-muted/15" />
            <span className="h-3 w-10 animate-pulse rounded bg-fg-muted/10" />
          </div>
        </div>
      ) : onSale ? (
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
          stale "5 ₪/חודש" when it's actually less. While loading,
          render a skeleton placeholder of similar visual weight so
          the card's vertical rhythm doesn't shift. */}
      <div className="mt-auto text-[11px] text-fg-muted">
        {loading ? (
          <span className="inline-block h-3 w-32 animate-pulse rounded bg-fg-muted/15" />
        ) : monthlyEquivalent ? (
          `שווה ערך ל-${formatPrice(
            Math.round((effective / 12) * 100) / 100,
          )} ${sym}/חודש`
        ) : (
          note
        )}
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
  purchaseContext,
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
  purchaseContext: PurchaseContext | null
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
        // Card-only — see the comment on Window.paypal.Buttons.
        fundingSource: 'card',
        style: {
          shape: 'rect',
          color: 'black',
          label: 'pay',
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
                // Pass-through the signed-in session token so the
                // backend webhook can auto-redeem the new key to
                // this account. Guests don't have one and fall
                // through to the normal "redeem manually in the
                // app" flow.
                sessionToken: purchaseContext?.sessionToken,
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
          // Also clear the one-shot purchase context — the
          // sessionStorage token has done its job.
          if (typeof window !== 'undefined') {
            try {
              window.sessionStorage.removeItem(PURCHASE_CONTEXT_KEY)
            } catch {
              // ignore
            }
          }
          window.location.href = '/buy?subscribed=1'
        },
        onError: (err) => {
          console.error('PayPal subscription error', err)
          setError(
            pickPayPalErrorMessage(
              err,
              'התרחשה שגיאה בתהליך התשלום. נסה שוב.',
            ),
          )
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
    // purchaseContext is in the dep array so the Buttons re-render
    // when the user becomes signed-in mid-session (very unlikely
    // in practice, but cheap to handle correctly).
  }, [sdkReady, canPay, plan, setError, purchaseContext])

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
          className="w-full rounded-xl border border-border bg-bg-elevated px-4 py-3 text-right text-base text-fg placeholder:text-fg-faint focus:border-primary focus:outline-none disabled:opacity-60"
          // Email locked when the buyer is upgrading from their
          // account — typing a different address would orphan the
          // subscription off their account.
          disabled={Boolean(purchaseContext)}
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
               number / exp / CVV without leaving dmplus.net.
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
          <PaymentTrustStrip />
          <p className="text-center text-[11px] text-fg-muted">
            {formatPrice(eff)} {sym} / {cycleLabel} · מתחדש אוטומטית · ביטול בכל
            עת
          </p>
        </>
      )}
    </form>
  )
}
