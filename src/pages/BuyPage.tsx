import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  ArrowRight,
  CircleCheck,
  Crown,
  KeyRound,
  Lock,
  LogIn,
  RefreshCw,
  Repeat,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  currencySymbol,
  fetchLivePricingStrict,
  writePricingCache,
  type LivePricing,
} from '../lib/pricing'
import TierComparison from '../components/TierComparison'
import { FlPage } from '../components/site/FlPage'
import { useDownload } from '../components/site/DownloadGate'
import {
  Amt,
  DateText,
  GateCard,
  OrderSummary,
  PayArea,
  PurchaseBlocked,
  RenewConsent,
  ReturnScreen,
  TermsDialog,
  type ReturnFlow,
} from '../components/buy/CheckoutParts'
import {
  DEFAULT_TIER_CONFIG,
  TIER_LABEL,
  tierPrice,
  tierRank,
  normalizeTier,
  type Tier,
  type TierConfig,
} from '@/lib/tiers'
import '../styles/pages/buy.css'

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

// (The trust strip under the card button — "תשלום מאובטח, מעובד על־ידי
// PayPal" — lives in components/buy/CheckoutParts.tsx with the other
// presentational checkout pieces.)

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

/** sessionStorage note written in PayPal's onApprove, right before the
 *  redirect to /buy?subscribed=1, saying which flow just finished (guest
 *  purchase, signed-in purchase, renewal / plan change). It only picks the
 *  wording of the success screen — nothing is sent anywhere. Read once and
 *  removed; without it the success screen uses wording that fits every case. */
const RETURN_FLOW_KEY = 'dmplus.buyReturn.v1'

function rememberReturnFlow(flow: NonNullable<ReturnFlow>) {
  try {
    window.sessionStorage.setItem(RETURN_FLOW_KEY, JSON.stringify({ ...flow, at: Date.now() }))
  } catch {
    // storage off — the success screen falls back to the generic wording.
  }
}

function takeReturnFlow(): ReturnFlow {
  try {
    const raw = window.sessionStorage.getItem(RETURN_FLOW_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(RETURN_FLOW_KEY)
    const v = JSON.parse(raw) as { flow?: string; plan?: unknown; startsAt?: unknown; at?: unknown }
    // A note older than an hour belongs to some other visit.
    if (typeof v.at !== 'number' || Date.now() - v.at > 60 * 60 * 1000) return null
    if (v.flow === 'new' || v.flow === 'new-in') return { flow: v.flow }
    if (v.flow === 'renew' && typeof v.plan === 'string') {
      return {
        flow: 'renew',
        plan: v.plan,
        startsAt: typeof v.startsAt === 'string' ? v.startsAt : undefined,
      }
    }
  } catch {
    // ignore — generic wording
  }
  return null
}

/** Scroll a section of this page into view. */
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function BuyPage() {
  const [plan, setPlan] = useState<Plan>('yearly')
  // Which tier the buyer selected in the comparison cards. Drives the
  // per-tier price on the server; 'pro' keeps the legacy checkout behavior.
  const [tier, setTier] = useState<Tier>('pro')
  // Live per-tier config (prices) for the checkout display — same public
  // source the comparison cards read. Falls back to code defaults.
  const [tierCfg, setTierCfg] = useState<Record<Tier, TierConfig>>(DEFAULT_TIER_CONFIG)
  // The code defaults carry price 0, so until the live prices arrive the
  // checkout must not render at all — otherwise it has no honest number to show.
  const [tiersState, setTiersState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=get-tiers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const j = (await r.json().catch(() => null)) as
          | { ok?: boolean; tiers?: Record<Tier, TierConfig> }
          | null
        if (!alive) return
        if (j?.ok && j.tiers) {
          setTierCfg(j.tiers)
          setTiersState('ready')
        } else {
          setTiersState('failed')
        }
      } catch {
        if (alive) setTiersState('failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  const selectedTierPrice = tierPrice(tierCfg[tier], plan).effective
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
  // ── Tier-change summary (upgrade/downgrade) ──
  // Populated only when the buyer arrived via ?renew=<token>&tier=<t> and the
  // target tier differs from the key's current tier. Mirrors the server's
  // pricing: an UPGRADE charges the prorated difference NOW (and the same key
  // is kept); a DOWNGRADE charges nothing now and takes effect at period end.
  const tierChange = (() => {
    if (!renewInfo) return null
    const currentTier = normalizeTier(renewInfo.tier)
    const targetTier = tier
    if (currentTier === targetTier) return null
    const currentEff = tierPrice(tierCfg[currentTier], plan).effective
    const newEff = tierPrice(tierCfg[targetTier], plan).effective
    const isUpgrade = tierRank(targetTier) > tierRank(currentTier)
    if (isUpgrade) {
      // Pay the FULL price difference (new − old), not prorated — "as if you'd
      // bought the bigger plan from the start". Matches the server charge.
      const payNow = Math.max(0, Math.round(newEff - currentEff))
      return {
        kind: 'upgrade' as const,
        currentTier,
        targetTier,
        payNow,
        recurring: newEff,
      }
    }
    return {
      kind: 'downgrade' as const,
      currentTier,
      targetTier,
      payNow: 0,
      recurring: newEff,
      effectiveDate: renewInfo.expiresAt,
    }
  })()
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
  // Start null — we do NOT seed from any cache or hardcoded default.
  // The price shown on the buy page must come net from the database
  // (a fresh strict fetch); until it resolves we render a loading
  // state, and if it fails we block checkout entirely.
  const [pricing, setPricing] = useState<LivePricing | null>(null)
  // Hard-block flag. Set true when the STRICT pricing fetch fails
  // (server/Firestore down) — the page then refuses to show any
  // checkout button and renders a "service unavailable" notice
  // instead. Critical because a purchase made while the backend is
  // down would charge real money (PayPal LIVE) but the webhook
  // couldn't mint a product key — money in, nothing out. See
  // fetchLivePricingStrict() for the full rationale.
  const [pricingUnavailable, setPricingUnavailable] = useState(false)

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
  // Existing-subscriber flows (renewal / monthly↔yearly switch / tier change)
  // get the same separate, never pre-ticked auto-renew consent as a new
  // purchase; their PayPal button only appears once it's ticked. UI gating
  // only — the request to the server is unchanged.
  const [renewConsent, setRenewConsent] = useState(false)
  const [renewTermsOpen, setRenewTermsOpen] = useState(false)
  // Consent is given to one amount and one cycle. When the buyer changes the
  // tier or the cycle after ticking, the box clears so they confirm the new
  // amount.
  useEffect(() => {
    setAutoRenewAccepted(false)
    setRenewConsent(false)
  }, [tier, plan])
  // Which flow the ?subscribed=1 return belongs to (see RETURN_FLOW_KEY).
  const [returnFlow, setReturnFlow] = useState<ReturnFlow>(null)
  const returnFlowTaken = useRef<ReturnFlow | undefined>(undefined)
  // After ?subscribed=1 the checkout is hidden; picking a plan again shows it.
  const [checkoutAfterSuccess, setCheckoutAfterSuccess] = useState(false)
  // Bumped to scroll to the checkout after it (re)renders.
  const [checkoutScroll, setCheckoutScroll] = useState(0)
  const siId = useId()
  useEffect(() => {
    if (checkoutScroll) scrollToId('checkout')
  }, [checkoutScroll])
  const { requestDownload } = useDownload()

  const planRef = useRef(plan)
  planRef.current = plan
  const emailRef = useRef(email)
  emailRef.current = email
  const renewTokenRef = useRef<string | null>(renewToken)
  renewTokenRef.current = renewToken
  const tierRef = useRef(tier)
  tierRef.current = tier
  // Read by the renewal onApprove to word the success screen.
  const tierChangeRef = useRef(tierChange)
  tierChangeRef.current = tierChange
  const buttonContainer = useRef<HTMLDivElement>(null)

  // Detect ?subscribed=1 / ?cancelled=1 returned by PayPal after
  // the user finishes (or backs out of) the approval flow. We do
  // this once on mount — same place we already parse ?renew=token.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('subscribed') === '1') {
      setPostReturn('subscribed')
      // Read-once note; the ref keeps it across StrictMode's second run.
      if (returnFlowTaken.current === undefined) returnFlowTaken.current = takeReturnFlow()
      setReturnFlow(returnFlowTaken.current)
    } else if (params.get('cancelled') === '1') setPostReturn('cancelled')
  }, [])

  // (Previously: submitSubscription redirect-to-PayPal handler.
  // Removed — the new embedded PayPal Smart Buttons inside
  // SubscriptionFlow call /api/paypal?action=create-subscription
  // themselves from inside their createSubscription callback, and
  // get the subscriptionId back inline so PayPal opens its own
  // popup/inline-card UI rather than navigating away.)


  // Fetch the price once on mount — NET FROM THE DATABASE, with no
  // cache seed and no hardcoded fallback. While the strict fetch is in
  // flight `pricing` stays null and the page shows a loading state; on
  // success we show the real price; on failure we block checkout with
  // a "try again later" notice. A stale cache can never enable a sale.
  useEffect(() => {
    let alive = true
    void fetchLivePricingStrict().then((p) => {
      if (!alive) return
      if (p) {
        // Server confirmed a real DB price — safe to sell.
        setPricing(p)
        setPricingUnavailable(false)
        writePricingCache(p)
      } else {
        // Could NOT confirm the price (doc missing / Firestore down).
        // Block checkout — a buy button now risks a charge with no key
        // minted, and we refuse to show a hardcoded default.
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
    // ?tier=<t> — a TIER change on the existing key. Pre-select it so the
    // checkout prices + explains the upgrade/downgrade against this target.
    const tierParam = params.get('tier')
    if (tierParam === 'basic' || tierParam === 'pro' || tierParam === 'ultra') {
      setTier(tierParam)
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
        // No ?tier= (e.g. the renewal email link): renew at the KEY's own
        // tier. Leaving the 'pro' default would price a Basic key's renewal
        // as an upgrade to Pro and charge the difference.
        if (!tierParam) setTier(normalizeTier(json.tier))
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
        setRenewError('לא הצלחנו לטעון את פרטי החידוש. רעננו את העמוד ונסו שוב.')
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
    // Wait for the real DB price before loading the SDK — its currency
    // param must be the live one, never a hardcoded default.
    if (!pricing) return
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
              'טעינת PayPal נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.',
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
      currency: pricing.currency,
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
          'טעינת PayPal נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.',
        ),
      { once: true },
    )
    document.head.appendChild(s)
    // Depends on `pricing` so the SDK loads once the live price (and
    // its currency) is confirmed — never before, never with a default.
  }, [pricing])

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
              // On a TIER change (?tier=), the server prices the first charge
              // as the prorated difference and stamps the new tier on the SAME
              // key. Omitted/same tier = a plain renewal.
              tier: tierRef.current,
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
          // Word the success screen for a renewal / plan change (the key
          // stays the same). A downgrade starts at the current expiry.
          const tc = tierChangeRef.current
          rememberReturnFlow({
            flow: 'renew',
            plan: `${TIER_LABEL[tierRef.current]} · ${planRef.current === 'yearly' ? 'שנתי' : 'חודשי'}`,
            startsAt:
              tc?.kind === 'downgrade' ? formatExpiry(tc.effectiveDate) : undefined,
          })
          window.location.href = '/buy?subscribed=1'
        },
        onError: (err) => {
          console.error('PayPal subscribe error', err)
          setStatus({
            kind: 'error',
            message: pickPayPalErrorMessage(
              err,
              'התרחשה שגיאה בתהליך התשלום. נסו שוב.',
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
    // `renewConsent` likewise: the container only mounts once the
    // auto-renew consent is ticked, so the button renders then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailLocked, sdkReady, renewLoading, renewConsent])

  function confirmEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus({ kind: 'error', message: 'הזינו כתובת מייל תקינה' })
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
      setResetError(
        err instanceof Error && /[֐-׿]/.test(err.message) ? err.message : 'שגיאת רשת',
      )
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
      <FlPage name="buy" title="מחירים">
        <div className="app-ov" role="status">
          <div className="app-in">
            <span className="spin lg" aria-hidden />
            <p className="h3">מתחבר לחשבון שלכם…</p>
            <p className="muted">שנייה אחת.</p>
          </div>
        </div>
      </FlPage>
    )
  }

  const curSym = currencySymbol(pricing?.currency ?? 'ILS')
  const cycleWord = plan === 'yearly' ? 'שנה' : 'חודש'
  const cycleAdj = plan === 'yearly' ? 'שנתי' : 'חודשי'

  // Key + owner line shared by the existing-subscriber banners.
  const keyLine = renewInfo ? (
    <p className="keyl">
      מפתח{' '}
      <bdi dir="ltr" className="mono">
        {renewInfo.keyMasked}
      </bdi>{' '}
      · משויך ל-
      <bdi dir="ltr" className="mono">
        {renewInfo.emailMasked}
      </bdi>
    </p>
  ) : null

  // Plan-switch banner — shown when ?switchTo=... is on the URL (user
  // came in via /account "שינוי תוכנית"), or auto-enabled for a key whose
  // subscription is still active. A full explanation of what's about to
  // happen: payment, auto-cancellation of the old sub, carried-forward
  // days, new expiry. Heavy on detail by design — the buyer needs to
  // understand they won't be double-charged before they hit pay.
  const switchBanner =
    renewInfo && switchTo
      ? (() => {
          const oldExpMs = Math.max(new Date(renewInfo.expiresAt).getTime(), Date.now())
          const newExpMs = oldExpMs + PLAN_META[switchTo].days * 86_400_000
          const carriedDays = renewInfo.isExpired
            ? 0
            : Math.max(
                0,
                Math.ceil(
                  (new Date(renewInfo.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
                ),
              )
          const toYearly = switchTo === 'yearly'
          const fromLabel = toYearly ? 'חודשי' : 'שנתי'
          const toLabel = toYearly ? 'שנתי' : 'חודשי'
          return (
            <div className="ban">
              <div className="ban-h">
                <Repeat className="ic" aria-hidden />
                <span>
                  מעבר ממסלול {fromLabel} למסלול {toLabel}
                </span>
              </div>
              {keyLine}
              <ul className="checks">
                <li>
                  תחויבו היום עבור{' '}
                  <b>
                    {toYearly ? 'השנה הבאה' : 'החודש הבא'} (לפי המסלול ה{toLabel})
                  </b>
                </li>
                <li>
                  המנוי ה{fromLabel} הקיים <b>יבוטל אוטומטית</b>, לא תחויבו עליו שוב
                </li>
                {carriedDays > 0 && (
                  <li>
                    <b>{carriedDays} הימים</b> שנותרו לכם מהמסלול ה{fromLabel} <b>יישמרו</b>{' '}
                    ויתווספו על גבי {toYearly ? 'השנה החדשה' : 'החודש החדש'}
                  </li>
                )}
              </ul>
              <div className="until">
                <span>הגישה תהיה בתוקף עד</span>
                <b>
                  <DateText>{formatExpiry(new Date(newExpMs).toISOString())}</DateText>
                </b>
              </div>
              <p>המפתח עצמו לא משתנה, אין צורך להזין שום דבר חדש בתוכנה.</p>
            </div>
          )
        })()
      : null

  // Renewal banner — renewal mode (?renew=<token>) without a plan switch or
  // a tier change. The actual extension math (adds plan days to whichever
  // is later: current expiry or now) happens server-side.
  const renewalBanner =
    renewInfo && !switchTo && !tierChange ? (
      <div className="ban">
        <div className="ban-h">
          <RefreshCw className="ic" aria-hidden />
          <span>חידוש מנוי קיים</span>
        </div>
        {keyLine}
        <p>
          תוקף נוכחי: <DateText>{formatExpiry(renewInfo.expiresAt)}</DateText>
          {renewInfo.isExpired && <span className="chip err exp">פג</span>}
        </p>
        <p>
          אחרי החידוש המנוי יהיה בתוקף עד{' '}
          <DateText>
            {formatExpiry(
              new Date(
                Math.max(new Date(renewInfo.expiresAt).getTime(), Date.now()) +
                  PLAN_META[plan].days * 86_400_000,
              ).toISOString(),
            )}
          </DateText>
          . המפתח עצמו לא משתנה.
        </p>
      </div>
    ) : null

  // Tier change (upgrade/downgrade) on the same key. Upgrade = the price
  // difference now; downgrade = nothing now, the new price from period end.
  const tierChangeBanner = tierChange ? (
    <div className="ban">
      <div className="ban-h">
        {tierChange.kind === 'upgrade' ? (
          <TrendingUp className="ic" aria-hidden />
        ) : (
          <TrendingDown className="ic" aria-hidden />
        )}
        <span>{tierChange.kind === 'upgrade' ? 'שדרוג מסלול' : 'הורדת מסלול'}</span>
      </div>
      <p className="ban-t">
        <bdi>{TIER_LABEL[tierChange.currentTier]}</bdi> ←{' '}
        <bdi>{TIER_LABEL[tierChange.targetTier]}</bdi>
      </p>
      {!switchTo && keyLine}
      <p>
        {tierChange.kind === 'upgrade' ? (
          <>
            השדרוג נכנס לתוקף מיד. משלמים עכשיו את ההפרש בין המסלולים (
            <Amt n={tierChange.payNow} sym={curSym} />) — כאילו קניתם את המסלול הגבוה
            מלכתחילה. המפתח נשאר אותו מפתח, והתוספת (נפח אחסון, דקות תמלול ועוד) נזקפת
            מיד. מהחיוב הבא ואילך תחויבו <Amt n={tierChange.recurring} sym={curSym} /> כל{' '}
            {cycleWord}.
          </>
        ) : (
          <>
            אין תשלום עכשיו. עד <DateText>{formatExpiry(tierChange.effectiveDate)}</DateText>{' '}
            תישארו במסלול {TIER_LABEL[tierChange.currentTier]} ששילמתם עליו במלואו. מ-
            <DateText>{formatExpiry(tierChange.effectiveDate)}</DateText> תעברו אוטומטית
            למסלול {TIER_LABEL[tierChange.targetTier]} ותחויבו{' '}
            <Amt n={tierChange.recurring} sym={curSym} /> כל {cycleWord}.
          </>
        )}
      </p>
    </div>
  ) : null

  // Existing subscriber (renewal / switch / tier change): what recurs is the
  // selected tier's price for the selected cycle (== tierChange.recurring).
  const recurring = selectedTierPrice
  const payNow = tierChange ? tierChange.payNow : selectedTierPrice
  const downgradeFrom =
    tierChange?.kind === 'downgrade' ? formatExpiry(tierChange.effectiveDate) : null

  const existingCheckout = (
    <div className="card co-st">
      {status.kind === 'success' ? (
        <div className="done" role="status">
          <span className="ret-ic">
            <CircleCheck className="ic" aria-hidden />
          </span>
          <h3 className="h3">התשלום הושלם בהצלחה</h3>
          <p>
            שלחנו לכם מייל ל-
            <bdi dir="ltr" className="mono">
              {status.email}
            </bdi>{' '}
            עם מפתח המוצר.
          </p>
        </div>
      ) : (
        <>
          {switchBanner}
          {renewalBanner}
          {tierChangeBanner}
          {status.kind === 'processing' ? (
            <div className="pp-load" role="status">
              <span className="spin sm" aria-hidden />
              מאריכים את המפתח שלכם…
            </div>
          ) : selectedTierPrice <= 0 ? (
            // No confirmed price for this tier + cycle → no amount to consent
            // to, so no way to pay.
            <div className="pp-load" role="status">
              {tiersState === 'loading' ? (
                <>
                  <span className="spin sm" aria-hidden />
                  טוען את המחיר…
                </>
              ) : (
                'המחיר למסלול הזה אינו זמין כרגע. נסו שוב בעוד כמה דקות.'
              )}
            </div>
          ) : !emailLocked ? (
            <form onSubmit={confirmEmail}>
              <button type="submit" className="btn btn-p btn-lg btn-block">
                <Crown className="ic" aria-hidden />
                {tierChange ? (
                  tierChange.kind === 'upgrade' ? (
                    <>
                      המשך לשדרוג: <Amt n={tierChange.payNow} sym={curSym} />
                    </>
                  ) : (
                    'אישור הורדת המסלול'
                  )
                ) : (
                  <>
                    המשך לחידוש: <Amt n={selectedTierPrice} sym={curSym} />
                  </>
                )}
              </button>
            </form>
          ) : (
            <>
              <OrderSummary
                label={tierChange ? 'המסלול החדש' : 'המסלול'}
                title={`מסלול ${TIER_LABEL[tier]}`}
                sub={cycleAdj}
                amount={recurring}
                sym={curSym}
                cycleWord={cycleWord}
                yearly={plan === 'yearly'}
                rows={[
                  ['לתשלום עכשיו', <Amt n={payNow} sym={curSym} />],
                  [
                    downgradeFrom ? (
                      <>
                        מתחדש מ-<DateText>{downgradeFrom}</DateText>
                      </>
                    ) : (
                      'מתחדש אוטומטית'
                    ),
                    <>
                      <Amt n={recurring} sym={curSym} /> / {cycleWord}
                    </>,
                  ],
                ]}
              />
              <RenewConsent
                checked={renewConsent}
                onChange={setRenewConsent}
                amount={<Amt n={recurring} sym={curSym} />}
                cycleWord={cycleWord}
                extra={
                  tierChange?.kind === 'upgrade' ? (
                    <>
                      {' '}
                      (<Amt n={tierChange.payNow} sym={curSym} /> עכשיו, ההפרש בין המסלולים)
                    </>
                  ) : downgradeFrom ? (
                    <>
                      {' '}
                      החל מ-<DateText>{downgradeFrom}</DateText>, בלי תשלום עכשיו
                    </>
                  ) : null
                }
                onOpenTerms={() => setRenewTermsOpen(true)}
              />
              <PayArea
                gate={renewConsent ? null : '↑ אשרו את החיוב המתחדש כדי להמשיך לתשלום'}
                error={status.kind === 'error' ? status.message : null}
                sdkError={sdkError}
                sdkReady={sdkReady}
                containerRef={buttonContainer}
                containerId="paypal-button-container"
                amount={recurring}
                sym={curSym}
                cycleWord={cycleWord}
              />
              <TermsDialog
                open={renewTermsOpen}
                onClose={() => setRenewTermsOpen(false)}
                planLine={`מנוי ${TIER_LABEL[tier]} ${cycleAdj}.`}
                amountLine={
                  tierChange?.kind === 'upgrade' ? (
                    <>
                      <Amt n={recurring} sym={curSym} /> לכל {cycleWord}, ועכשיו{' '}
                      <Amt n={tierChange.payNow} sym={curSym} /> עבור ההפרש בין המסלולים
                    </>
                  ) : downgradeFrom ? (
                    <>
                      <Amt n={recurring} sym={curSym} /> לכל {cycleWord}, החל מ-
                      <DateText>{downgradeFrom}</DateText>
                    </>
                  ) : (
                    <>
                      <Amt n={recurring} sym={curSym} /> לכל {cycleWord}
                    </>
                  )
                }
                cycleWord={cycleWord}
              />
            </>
          )}
        </>
      )}
    </div>
  )

  // After a completed payment the checkout stays hidden (the success screen
  // is at the top) until the buyer picks a plan again.
  const showCheckout = postReturn !== 'subscribed' || checkoutAfterSuccess

  return (
    <FlPage name="buy" title="מחירים">
      <div className="wrap">
        <header className="phero">
          <span className="eyebrow">מחירים</span>
          <h1 className="display">בחירת התוכנית שמתאימה לך</h1>
          <p className="lead">בחרו את המסלול שמתאים לכם — כל מסלול פותח עוד.</p>
        </header>

        {/* Back from PayPal: ?subscribed=1 / ?cancelled=1. */}
        {postReturn && (
          <div id="result" className="result">
            <ReturnScreen
              kind={postReturn}
              flow={returnFlow}
              onBackToCheckout={() => scrollToId('checkout')}
              onDownload={() => requestDownload()}
            />
          </div>
        )}

        {/* Tier comparison (Free/Basic/Pro/Ultra) — live admin-configured
            prices + the feature matrix. The cycle toggle drives the
            checkout's cycle; "בחירת המסלול" selects the tier (with the
            cycle shown) and scrolls to the checkout. The one selector for
            every flow, renewals included. */}
        <TierComparison
          cycle={plan}
          onCycleChange={setPlan}
          onChoose={(chosenTier, cycle) => {
            setTier(chosenTier)
            setPlan(cycle)
            setCheckoutAfterSuccess(true)
            setCheckoutScroll((n) => n + 1)
          }}
        />

        {showCheckout && (
          <section id="checkout" className="sec" aria-labelledby="checkout-title">
            <div className="sec-head">
              <h2 className="h2" id="checkout-title">
                השלמת הרכישה
              </h2>
            </div>
            <div className="co">
              {/* Pricing-unavailable HARD BLOCK. When the strict pricing
                  fetch failed (server / Firestore down) we refuse to show
                  ANY checkout UI — a purchase right now would charge real
                  money (PayPal LIVE) but the post-payment webhook couldn't
                  mint a product key, leaving the buyer paid-but-keyless.
                  See fetchLivePricingStrict(). */}
              {pricingUnavailable ? (
                <PurchaseBlocked />
              ) : pricing === null ? (
                /* Loading — the strict DB price fetch hasn't resolved yet.
                   We show NO price until the real database price arrives. */
                <GateCard loading>טוען את פרטי המנוי…</GateCard>
              ) : (
                <>
                  {renewError && (
                    <div className="note err" role="alert">
                      <TriangleAlert className="ic" aria-hidden />
                      <span>{renewError}</span>
                    </div>
                  )}
                  {/* Two flows live here:
                      - Renewal mode (?renew=<token> in URL): renewal /
                        plan switch / tier change on the existing key.
                      - Subscription mode (no renew token): a new
                        auto-renewing subscription.
                      The discriminator is `renewToken`. */}
                  {renewLoading ? (
                    <GateCard loading>טוען את פרטי החידוש…</GateCard>
                  ) : status.kind === 'renewed' ? (
                    <div className="card co-st">
                      <div className="done" role="status">
                        <span className="ret-ic">
                          <CircleCheck className="ic" aria-hidden />
                        </span>
                        <h3 className="h3">המנוי הוארך בהצלחה</h3>
                        <p>
                          התוקף החדש שלכם:{' '}
                          <b>
                            <DateText>{formatExpiry(status.newExpiresAt)}</DateText>
                          </b>
                        </p>
                        <p className="small muted">
                          המפתח נשאר אותו מפתח, אין צורך לעדכן שום דבר בתוכנה. שלחנו לכם
                          גם מייל אישור.
                        </p>
                      </div>
                    </div>
                  ) : renewToken ? (
                    existingCheckout
                  ) : selectedTierPrice <= 0 ? (
                    tiersState === 'loading' ? (
                      <GateCard loading>טוען את המחיר…</GateCard>
                    ) : (
                      <GateCard>המחיר למסלול הזה אינו זמין כרגע. נסו שוב בעוד כמה דקות.</GateCard>
                    )
                  ) : (
                    <SubscriptionFlow
                      email={email}
                      setEmail={setEmail}
                      plan={plan}
                      tier={tier}
                      tierPrice={selectedTierPrice}
                      tierLabel={TIER_LABEL[tier]}
                      pricing={pricing}
                      autoRenewAccepted={autoRenewAccepted}
                      setAutoRenewAccepted={setAutoRenewAccepted}
                      error={subError}
                      setError={setSubError}
                      sdkReady={sdkReady}
                      sdkError={sdkError}
                      purchaseContext={purchaseContext}
                    />
                  )}
                </>
              )}
            </div>
          </section>
        )}
      </div>

      {/* Renewal sign-in modal (nothing opens it today — kept working).
          Fixed overlay with backdrop blur; AnimatePresence handles the
          fade/scale on enter+exit. */}
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
            className="si-ov"
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
              className="dialog si-card"
            >
              <div className="dlg-h">
                <span className="crown">
                  <LogIn className="ic" aria-hidden />
                </span>
                <h2 id="renew-modal-title">חידוש מנוי קיים</h2>
                <button
                  type="button"
                  className="dlg-x"
                  onClick={closeSigninPanel}
                  disabled={signinSubmitting}
                  aria-label="סגירה"
                >
                  <X className="ic" aria-hidden />
                </button>
              </div>

              {/* Picker mode: API returned >1 key for this account.
                  Each row is a button — click to drop into the
                  renewal flow with that key. */}
              {renewableKeys ? (
                <div className="stack">
                  <p className="small muted">בחרו את המפתח לחידוש:</p>
                  {renewableKeys.map((k) => (
                    <button
                      key={k.key}
                      type="button"
                      onClick={() => pickRenewableKey(k)}
                      className="si-key"
                    >
                      <span className="si-key-t">
                        <bdi dir="ltr" className="mono">
                          {k.keyMasked}
                        </bdi>
                        <span className="small muted">
                          תוקף נוכחי: <DateText>{formatExpiry(k.expiresAt)}</DateText>
                          {k.isExpired && <span className="chip err exp">פג</span>}
                        </span>
                      </span>
                      <KeyRound className="ic" aria-hidden />
                    </button>
                  ))}
                </div>
              ) : forgotPasswordMode ? (
                /* Forgot-password sub-mode — replaces the sign-in form;
                   shares signinEmail so a typed address carries over. */
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void handleResetPasswordFromModal()
                  }}
                  className="stack"
                >
                  {resetSent ? (
                    <>
                      <div className="note ok" role="status">
                        <span>
                          ✓ אם החשבון קיים, נשלח אליו מייל איפוס סיסמה
                          {signinEmail.trim() && (
                            <>
                              {' '}
                              לכתובת <b>{signinEmail.trim()}</b>
                            </>
                          )}
                          . בדקו את תיבת הדואר (כולל ספאם).
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-s btn-block"
                        onClick={() => {
                          setForgotPasswordMode(false)
                          setResetSent(false)
                          setResetError(null)
                        }}
                      >
                        <ArrowRight className="ic" aria-hidden />
                        חזרה להתחברות
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="small muted">
                        הזינו את האימייל שאיתו נרשמתם, ונשלח אליו קישור לאיפוס הסיסמה.
                      </p>
                      <div className="field">
                        <label htmlFor={`${siId}-reset`}>אימייל</label>
                        <input
                          id={`${siId}-reset`}
                          className="input"
                          type="email"
                          required
                          autoComplete="email"
                          value={signinEmail}
                          onChange={(e) => setSigninEmail(e.target.value)}
                          placeholder="you@example.com"
                          dir="ltr"
                          disabled={resetSending}
                          autoFocus
                        />
                      </div>
                      {resetError && (
                        <div className="note err" role="alert">
                          <span>{resetError}</span>
                        </div>
                      )}
                      <button type="submit" className="btn btn-p btn-block" disabled={resetSending}>
                        {resetSending ? (
                          <span className="spin sm" aria-hidden />
                        ) : (
                          <Lock className="ic" aria-hidden />
                        )}
                        שליחת קישור איפוס
                      </button>
                      <button
                        type="button"
                        className="btn btn-g btn-sm btn-block"
                        onClick={() => {
                          setForgotPasswordMode(false)
                          setResetError(null)
                        }}
                      >
                        <ArrowRight className="ic" aria-hidden />
                        חזרה להתחברות
                      </button>
                    </>
                  )}
                </form>
              ) : (
                <form onSubmit={submitSignin} className="stack">
                  <p className="small muted">
                    התחברו עם החשבון שאיתו מימשתם את המפתח כדי לחדש את התוקף.
                  </p>
                  <div className="field">
                    <label htmlFor={`${siId}-email`}>אימייל</label>
                    <input
                      id={`${siId}-email`}
                      className="input"
                      type="email"
                      required
                      autoComplete="email"
                      value={signinEmail}
                      onChange={(e) => setSigninEmail(e.target.value)}
                      placeholder="you@example.com"
                      dir="ltr"
                      disabled={signinSubmitting}
                      autoFocus
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`${siId}-pass`}>סיסמה</label>
                    <input
                      id={`${siId}-pass`}
                      className="input"
                      type="password"
                      required
                      autoComplete="current-password"
                      value={signinPassword}
                      onChange={(e) => setSigninPassword(e.target.value)}
                      dir="ltr"
                      disabled={signinSubmitting}
                    />
                  </div>
                  {signinError && (
                    <div className="note err" role="alert">
                      <span>{signinError}</span>
                    </div>
                  )}
                  <button type="submit" className="btn btn-p btn-block" disabled={signinSubmitting}>
                    {signinSubmitting ? (
                      <>
                        <span className="spin sm" aria-hidden />
                        מתחבר…
                      </>
                    ) : (
                      <>
                        <LogIn className="ic" aria-hidden />
                        התחברות וחידוש
                      </>
                    )}
                  </button>
                  {/* "שכחתי סיסמה" — toggles to the reset form above, inside
                      the same modal. */}
                  <button
                    type="button"
                    className="tlink si-forgot"
                    onClick={() => {
                      setSigninError(null)
                      setResetError(null)
                      setResetSent(false)
                      setForgotPasswordMode(true)
                    }}
                    disabled={signinSubmitting}
                  >
                    שכחתי סיסמה
                  </button>
                </form>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </FlPage>
  )
}

function SubscriptionFlow({
  email,
  setEmail,
  plan,
  tier,
  tierPrice,
  tierLabel,
  pricing,
  autoRenewAccepted,
  setAutoRenewAccepted,
  error,
  setError,
  sdkReady,
  sdkError,
  purchaseContext,
}: {
  email: string
  setEmail: (s: string) => void
  plan: Plan
  tier: Tier
  /** Selected tier's price for the current cycle (0/undefined = legacy Pro). */
  tierPrice?: number
  /** Hebrew label of the selected tier ("Basic"/"Pro"/"Ultra"). */
  tierLabel?: string
  pricing: LivePricing
  autoRenewAccepted: boolean
  setAutoRenewAccepted: (b: boolean) => void
  error: string | null
  setError: (s: string | null) => void
  sdkReady: boolean
  sdkError: string | null
  purchaseContext: PurchaseContext | null
}) {
  // (The ?subscribed=1 / ?cancelled=1 return screens used to live here; they
  // now render at the top of the page — see ReturnScreen.)
  const fieldId = useId()

  // Per-tier price (Basic/Ultra, or Pro once its per-tier price is set) —
  // when present it drives the whole display, and the legacy sale/coupon UI
  // (which is Pro-single-product only) is suppressed. The charge itself is
  // priced per-tier server-side regardless.
  const perTierPrice = typeof tierPrice === 'number' && tierPrice > 0 ? tierPrice : null
  const isPerTier = perTierPrice != null
  const planLabelText = tierLabel ?? 'Pro'
  // Tier price only. The caller renders this flow solely once a real tier
  // price is known, so there is no second price list to fall back to.
  const eff = perTierPrice ?? 0
  const sym = currencySymbol(pricing.currency)
  const cycleLabel = plan === 'monthly' ? 'חודש' : 'שנה'
  const onSale = false // legacy single-product sale slots no longer apply
  // Terms modal — replaces the previously-inline "סיכום העסקה"
  // block. The legal requirement (sec. 13ג) is that the user has
  // ACCESS to the disclosures before paying, not that they're
  // permanently visible on screen. A click-to-expand link below
  // the consent checkbox satisfies that as long as the checkbox
  // text makes the auto-renew commitment explicit.
  const [termsOpen, setTermsOpen] = useState(false)

  // ── Coupon (server-validated; we only ever hold the CODE) ──
  const [couponOpen, setCouponOpen] = useState(false)
  const [couponInput, setCouponInput] = useState('')
  const [couponBusy, setCouponBusy] = useState(false)
  const [couponErr, setCouponErr] = useState<string | null>(null)
  const [couponOk, setCouponOk] = useState<{
    code: string
    pct: number
    duration: 'forever' | 'first'
    finalPrice: number
    recurringPrice: number | null
    saleCheaper: boolean
  } | null>(null)
  const couponCodeRef = useRef<string | null>(null)
  couponCodeRef.current = couponOk && !couponOk.saleCheaper ? couponOk.code : null

  const applyCoupon = useCallback(
    async (codeRaw: string, planNow: Plan) => {
      const code = codeRaw.trim().toUpperCase()
      if (!code) return
      setCouponBusy(true)
      setCouponErr(null)
      try {
        const r = await fetch('/api/paypal?action=coupon-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The tier matters: the preview is priced per tier, like the charge.
          body: JSON.stringify({ code, plan: planNow, tier }),
        })
        const j = (await r.json()) as {
          ok: boolean
          valid?: boolean
          pct?: number
          duration?: 'forever' | 'first'
          finalPrice?: number
          recurringPrice?: number
          saleCheaper?: boolean
          error?: string
        }
        if (!r.ok || !j.ok) {
          setCouponErr(j.error || 'בדיקת הקופון נכשלה. נסו שוב')
          setCouponOk(null)
        } else if (!j.valid) {
          setCouponErr(j.error || 'קוד לא תקין')
          setCouponOk(null)
        } else {
          setCouponOk({
            code,
            pct: j.pct || 0,
            duration: j.duration === 'first' ? 'first' : 'forever',
            finalPrice: j.finalPrice || 0,
            recurringPrice: j.recurringPrice ?? null,
            saleCheaper: !!j.saleCheaper,
          })
        }
      } catch {
        setCouponErr('בדיקת הקופון נכשלה. נסו שוב')
      } finally {
        setCouponBusy(false)
      }
    },
    [],
  )

  // Plan switch re-validates the applied coupon (a code can be valid for
  // yearly only, and the % is applied to the OTHER plan's base price).
  useEffect(() => {
    if (couponOk) void applyCoupon(couponOk.code, plan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

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
  const tierLatestRef = useRef(tier)
  emailLatestRef.current = trimmedEmail
  planLatestRef.current = plan
  tierLatestRef.current = tier

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
                // The selected tier — the server prices it per-tier and the
                // webhook stamps it on the minted key.
                tier: tierLatestRef.current,
                email: emailLatestRef.current,
                // Pass-through the signed-in session token so the
                // backend webhook can auto-redeem the new key to
                // this account. Guests don't have one and fall
                // through to the normal "redeem manually in the
                // app" flow.
                sessionToken: purchaseContext?.sessionToken,
                coupon: couponCodeRef.current,
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
            // Hebrew server reasons are shown as-is; anything else
            // (browser / network errors in English) gets the Hebrew line.
            setError(pickPayPalErrorMessage(err, 'שגיאת רשת'))
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
          // Word the success screen: signed-in buyers get the key attached
          // to their account; guests redeem it from the email.
          rememberReturnFlow({ flow: purchaseContext ? 'new-in' : 'new' })
          window.location.href = '/buy?subscribed=1'
        },
        onError: (err) => {
          console.error('PayPal subscription error', err)
          setError(
            pickPayPalErrorMessage(
              err,
              'התרחשה שגיאה בתהליך התשלום. נסו שוב.',
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

  // What the consent states: the recurring amount, plus the first-period
  // price when a first-period coupon applies.
  const consentAmount =
    couponOk && !couponOk.saleCheaper
      ? couponOk.duration === 'first'
        ? couponOk.recurringPrice ?? eff
        : couponOk.finalPrice
      : eff

  return (
    <form onSubmit={(e) => e.preventDefault()} className="card co-st">
      {/* Order summary — ties the payment box to the tier the buyer picked,
          and spells out exactly what's charged NOW vs every cycle, plus how
          upgrades/downgrades are timed, so there's zero billing surprise.
          The ×12 breakdown explains the yearly figure (the cards quote a
          monthly price for both cycles). */}
      <OrderSummary
        label="המסלול שנבחר"
        title={`מסלול ${planLabelText}`}
        sub={
          <>
            {plan === 'monthly' ? 'חודשי' : 'שנתי'} ·{' '}
            <a
              className="link"
              href="#plans"
              onClick={(e) => {
                e.preventDefault()
                scrollToId('plans')
              }}
            >
              שינוי המסלול
            </a>
          </>
        }
        amount={eff}
        sym={sym}
        cycleWord={cycleLabel}
        yearly={plan === 'yearly'}
        rows={[
          ['לתשלום עכשיו', <Amt n={eff} sym={sym} />],
          [
            'מתחדש אוטומטית',
            <>
              <Amt n={eff} sym={sym} /> / {cycleLabel}
            </>,
          ],
        ]}
      />
      <p className="fine">
        החיוב הראשון עכשיו, ואז <Amt n={eff} sym={sym} /> כל {cycleLabel} עד לביטול.
        <span className="vat"> המחירים כוללים מע״מ.</span> שדרוג מסלול נכנס לתוקף מיד
        (משלמים רק את ההפרש); הורדת מסלול נכנסת לתוקף בסוף התקופה ששולמה — עד אז נשארים
        במסלול הנוכחי.
      </p>

      {/* Email locked when the buyer is upgrading from their account —
          typing a different address would orphan the subscription off
          their account. */}
      <div className="field">
        <label htmlFor={`${fieldId}-mail`}>כתובת מייל לקבלת מפתח המנוי</label>
        {purchaseContext ? (
          <>
            <div className="locked">
              <input
                id={`${fieldId}-mail`}
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                dir="ltr"
                disabled
                aria-describedby={`${fieldId}-mail-h`}
              />
              <Lock className="ic" aria-hidden />
            </div>
            <span className="hint" id={`${fieldId}-mail-h`}>
              זה המייל של החשבון שאיתו התחברתם. המנוי יירשם עליו, והמפתח ישויך לחשבון
              אוטומטית, בלי להזין אותו בתוכנה.
            </span>
          </>
        ) : (
          <input
            id={`${fieldId}-mail`}
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            dir="ltr"
            autoComplete="email"
          />
        )}
      </div>

      {/* Coupon — only the CODE travels to the server; price + validity
          are decided there. Hidden on the per-tier path (coupon price
          preview is Pro-single-product only for now), which today is
          always. */}
      <div className="coupon" hidden={isPerTier}>
        {!couponOpen && !couponOk ? (
          <button type="button" className="tlink" onClick={() => setCouponOpen(true)}>
            יש לי קוד קופון
          </button>
        ) : (
          <div className="stack">
            {!couponOk && (
              <div className="row">
                <input
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void applyCoupon(couponInput, plan)
                    }
                  }}
                  placeholder="קוד קופון"
                  aria-label="קוד קופון"
                  dir="ltr"
                  className="input coupon-in"
                />
                <button
                  type="button"
                  className="btn btn-s btn-sm"
                  disabled={couponBusy || !couponInput.trim()}
                  onClick={() => void applyCoupon(couponInput, plan)}
                >
                  {couponBusy ? 'בודק…' : 'החלה'}
                </button>
              </div>
            )}
            {couponOk && !couponOk.saleCheaper && (
              <div className="note ok">
                <span>
                  קופון {couponOk.pct}% הופעל:{' '}
                  {couponOk.duration === 'first' ? (
                    <>
                      <Amt n={couponOk.finalPrice} sym={sym} /> ל{cycleLabel} הראשון, אחר
                      כך <Amt n={couponOk.recurringPrice ?? eff} sym={sym} /> ל{cycleLabel}
                    </>
                  ) : (
                    <>
                      <Amt n={couponOk.finalPrice} sym={sym} /> ל{cycleLabel}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="dlg-x"
                  onClick={() => {
                    setCouponOk(null)
                    setCouponInput('')
                    setCouponOpen(false)
                  }}
                  title="הסרת הקופון"
                  aria-label="הסרת הקופון"
                >
                  ×
                </button>
              </div>
            )}
            {couponOk && couponOk.saleCheaper && (
              <div className="note">
                <span>
                  המבצע הנוכחי זול יותר מהקופון. המחיר נשאר <Amt n={eff} sym={sym} />.
                  הקופון לא ינוצל.
                </span>
              </div>
            )}
            {couponErr && <p className="coupon-err">{couponErr}</p>}
          </div>
        )}
      </div>

      {/* Separate explicit auto-renew consent. Israeli consumer-protection
          law (sec. 13ג) requires the auto-renew terms disclosed up-front:
          the checkbox text states amount + cycle, and "לתנאי המנוי" opens
          the full terms. NOT pre-ticked (also a legal requirement). */}
      <RenewConsent
        checked={autoRenewAccepted}
        onChange={setAutoRenewAccepted}
        amount={<Amt n={consentAmount} sym={sym} />}
        cycleWord={cycleLabel}
        extra={
          couponOk && !couponOk.saleCheaper && couponOk.duration === 'first' ? (
            <>
              {' '}
              (<Amt n={couponOk.finalPrice} sym={sym} /> ל{cycleLabel} הראשון)
            </>
          ) : null
        }
        onOpenTerms={() => setTermsOpen(true)}
      />

      {/* Embedded PayPal card button. It only renders once the form is
          valid (`canPay`) — PayPal buttons have no disabled state — so
          until then a hint says what's missing. The render itself is
          wired in the useEffect above. */}
      <PayArea
        gate={
          !emailValid
            ? '↑ הזינו כתובת מייל תקינה כדי להמשיך לתשלום'
            : !autoRenewAccepted
              ? '↑ אשרו את החיוב המתחדש כדי להמשיך לתשלום'
              : null
        }
        error={error}
        sdkError={sdkError}
        sdkReady={sdkReady}
        containerRef={paypalContainerRef}
        amount={eff}
        sym={sym}
        cycleWord={cycleLabel}
      />

      {/* Terms dialog — full disclosure of every term required by law
          (sec. 13ג). Opens from the consent's "לתנאי המנוי" link. */}
      <TermsDialog
        open={termsOpen}
        onClose={() => setTermsOpen(false)}
        planLine={`מנוי ${planLabelText} ${cycleLabel === 'חודש' ? 'חודשי' : 'שנתי'}.`}
        amountLine={
          onSale ? (
            <>
              <s>
                <Amt n={pricing[plan].regular} sym={sym} />
              </s>{' '}
              <b>
                <Amt n={eff} sym={sym} />
              </b>{' '}
              לכל {cycleLabel}
              {pricing.saleLabel && <> ({pricing.saleLabel})</>}
            </>
          ) : (
            <>
              <Amt n={eff} sym={sym} /> לכל {cycleLabel}
            </>
          )
        }
        cycleWord={cycleLabel}
        saleNote={
          onSale ? (
            <>
              {' '}
              המחיר ה<b>מוזל</b> שלכם נשמר לכל אורך תקופת המנוי. גם אם המבצע יסתיים,
              תמשיכו לשלם <Amt n={eff} sym={sym} /> עד שתבטלו.
            </>
          ) : undefined
        }
      />
    </form>
  )
}
