import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

/**
 * Shared PayPal + Firebase helpers used across the subscription
 * endpoints (`/api/subscription/*`, `/api/paypal-webhook`).
 *
 * Why a shared module despite the historical "don't share modules
 * across Vercel functions" warning in capture.ts: by the time we
 * built the pricing/capture features we already started sharing
 * (`loadCurrentPricing` is imported in capture.ts), and it works.
 * The original warning was about Upstash rate-limiter specifically.
 * Plain CommonJS-ish imports of plain helpers are fine.
 *
 * Anything you add here must be:
 *   - Pure & stateless (no top-level side effects beyond memoised
 *     singletons like the Firebase app)
 *   - Compatible with the Vercel Node runtime (no DOM APIs)
 *   - Carefully typed — these helpers run in functions handling
 *     real money so silent any-types would be a footgun
 */

export const PAYPAL_BASE =
  (process.env.PAYPAL_ENV || 'live') === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'

// ─── Live pricing reader ──────────────────────────────────────
//
// Reads `appConfig/pricing` and returns the current monthly /
// yearly prices (regular + optional sale). Lives in this shared
// helper module (rather than `pricing.ts`, which is itself a
// serverless function file) because Vercel's bundler has issues
// when one serverless function imports from another. By keeping
// this in `_paypal.ts` (a non-function helper, conventionally
// underscore-prefixed), every caller — `paypal.ts`, `capture.ts`,
// and `pricing.ts` itself — bundles it cleanly without the
// cross-function-file import that was previously crashing the
// runtime with FUNCTION_INVOCATION_FAILED on capture and paypal.
//
// Always returns SOMETHING — on any failure (missing doc, network
// down, malformed data) falls back to the hard-coded defaults so
// the /buy page never breaks for a backend hiccup.

const PRICING_DEFAULTS = {
  monthly: { regular: 9, sale: null as number | null },
  yearly: { regular: 60, sale: null as number | null },
  currency: 'ILS',
}

export interface LivePricing {
  monthly: { regular: number; sale: number | null }
  yearly: { regular: number; sale: number | null }
  currency: string
  saleLabel?: string
}

export async function loadCurrentPricing(): Promise<LivePricing> {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('pricing').get()
    if (!snap.exists) return { ...PRICING_DEFAULTS }
    const data = snap.data() as {
      monthly?: { regular?: unknown; sale?: unknown }
      yearly?: { regular?: unknown; sale?: unknown }
      currency?: unknown
      saleLabel?: unknown
    }
    const numOr = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
    return {
      monthly: {
        regular: numOr(data.monthly?.regular, PRICING_DEFAULTS.monthly.regular),
        sale: numOrNull(data.monthly?.sale),
      },
      yearly: {
        regular: numOr(data.yearly?.regular, PRICING_DEFAULTS.yearly.regular),
        sale: numOrNull(data.yearly?.sale),
      },
      currency:
        typeof data.currency === 'string' && data.currency
          ? data.currency
          : PRICING_DEFAULTS.currency,
      saleLabel:
        typeof data.saleLabel === 'string' && data.saleLabel.trim()
          ? data.saleLabel.trim()
          : undefined,
    }
  } catch (err) {
    console.error('[pricing] loadCurrentPricing failed:', err)
    return { ...PRICING_DEFAULTS }
  }
}

// ─── Firebase singleton ────────────────────────────────────────

let firebaseApp: App | null = null

export function getFirebase(): App {
  if (firebaseApp) return firebaseApp
  const existing = getApps()[0]
  if (existing) {
    firebaseApp = existing
    return firebaseApp
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set')
  }
  firebaseApp = initializeApp({ credential: cert(JSON.parse(raw)) })
  return firebaseApp
}

export function getDb(): Firestore {
  return getFirestore(getFirebase())
}

// ─── PayPal API access ─────────────────────────────────────────

/** OAuth2 client-credentials token. Cached per function invocation
 *  via a simple module-level variable. PayPal tokens live ~9 hours
 *  but each Vercel function instance is short-lived, so the cache
 *  rarely survives more than a few requests — that's fine, it just
 *  saves the duplicate roundtrip when we make several PayPal calls
 *  back-to-back inside the same handler. */
let cachedToken: { value: string; expiresAt: number } | null = null

export async function paypalAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value
  }
  const clientId = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !secret) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set')
  }
  const auth = Buffer.from(`${clientId.trim()}:${secret.trim()}`).toString(
    'base64',
  )
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '<no body>')
    throw new Error(`PayPal auth failed: ${r.status} — ${text.slice(0, 200)}`)
  }
  const json = (await r.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  }
  return json.access_token
}

/** Authenticated PayPal call. Throws on non-2xx with the PayPal
 *  error body included — every PayPal endpoint returns useful JSON
 *  on errors and we want it surfaced both in logs and to whoever's
 *  reading the function output. */
export async function paypalCall<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const token = await paypalAccessToken()
  const r = await fetch(`${PAYPAL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  // PayPal returns 204 No Content for some operations (e.g. cancel
  // subscription). Don't try to parse that as JSON.
  if (r.status === 204) {
    return undefined as T
  }
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!r.ok) {
    const summary =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? (parsed as { message?: string }).message
        : text.slice(0, 200)
    throw new Error(`PayPal ${method} ${path} failed: ${r.status} — ${summary}`)
  }
  return parsed as T
}

// ─── PayPal Product + Plan management ──────────────────────────
//
// Every Plan in PayPal belongs to a Product. We have exactly ONE
// Product — "Download Manager Plus Pro" — and multiple Plans under
// it (monthly regular, monthly sale, yearly regular, yearly sale).
//
// The product is auto-created lazily and its id stored in
// Firestore at `appConfig/paypal` so we don't recreate it every
// time the app cold-starts.

const PAYPAL_CONFIG_DOC = 'paypal'
const PRODUCT_NAME = 'ניהול הורדות פלוס Pro'
const PRODUCT_DESCRIPTION =
  'Subscription to the Pro tier of Download Manager Plus desktop application'

interface PaypalConfigDoc {
  productId?: string
}

/** Get the merchant-wide PayPal Product id, creating it on first
 *  access. The product is just a parent — it doesn't have a price.
 *  Plans (which DO have prices) reference the product id. */
export async function getOrCreateProduct(): Promise<string> {
  const db = getDb()
  const ref = db.collection('appConfig').doc(PAYPAL_CONFIG_DOC)
  const snap = await ref.get()
  if (snap.exists) {
    const data = snap.data() as PaypalConfigDoc
    if (data.productId) return data.productId
  }
  // Create the product. PayPal requires `type: 'SERVICE'` for
  // SaaS — `DIGITAL` is for one-shot digital goods, `PHYSICAL`
  // for things you ship.
  const created = await paypalCall<{ id: string }>('POST', '/v1/catalogs/products', {
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    type: 'SERVICE',
    category: 'SOFTWARE',
  })
  await ref.set({ productId: created.id }, { merge: true })
  return created.id
}

/** Create a Plan in PayPal at a fixed price. Returns the new
 *  plan_id. Plans are IMMUTABLE re: pricing — changing a Plan's
 *  amount requires creating a brand-new Plan and migrating
 *  subscribers (which itself requires their consent and is messy).
 *  For our admin-pricing flow we just create a fresh Plan whenever
 *  the price changes; old Plans stay around for existing subscribers
 *  who are grandfathered at their original price. */
export async function createPlan(args: {
  productId: string
  /** Stable handle for this price point — used in the Plan name
   *  for human readability in the PayPal dashboard. */
  label: string
  amount: number
  currency: string
  interval: 'monthly' | 'yearly'
}): Promise<string> {
  const frequency =
    args.interval === 'monthly'
      ? { interval_unit: 'MONTH', interval_count: 1 }
      : { interval_unit: 'YEAR', interval_count: 1 }
  const created = await paypalCall<{ id: string }>('POST', '/v1/billing/plans', {
    product_id: args.productId,
    name: `${PRODUCT_NAME} — ${args.label}`,
    description: `${args.amount} ${args.currency} ${args.interval === 'monthly' ? 'per month' : 'per year'}`,
    billing_cycles: [
      {
        frequency,
        tenure_type: 'REGULAR',
        sequence: 1,
        // `0` = infinite — billing continues until cancellation.
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: {
            value: args.amount.toFixed(2),
            currency_code: args.currency,
          },
        },
      },
    ],
    payment_preferences: {
      // We don't want to keep retrying failed payments indefinitely
      // — `1` means PayPal retries once and then suspends. The
      // suspension fires a webhook we catch and turn into a
      // payment-failed email for the user.
      auto_bill_outstanding: true,
      payment_failure_threshold: 1,
      setup_fee_failure_action: 'CANCEL',
    },
    // No tax overhead — we don't collect taxes via PayPal; the
    // user handles invoicing/tax separately.
    taxes: undefined,
  })
  // Activate the plan so subscriptions can be created against it.
  // Plans default to CREATED state and need an explicit activate.
  await paypalCall('POST', `/v1/billing/plans/${created.id}/activate`, {})
  return created.id
}

/** Deactivate an existing PayPal Plan. Old subscribers on the
 *  plan continue billing at their grandfathered price — the
 *  deactivation only blocks NEW subscriptions on that plan. Used
 *  when admin changes pricing: the old price-point plan is
 *  deactivated, a new one created. */
export async function deactivatePlan(planId: string): Promise<void> {
  try {
    await paypalCall('POST', `/v1/billing/plans/${planId}/deactivate`, {})
  } catch (err) {
    // Already-deactivated plans return 422; ignore. Anything else
    // (including 404 if the plan id is stale) gets logged but
    // doesn't throw — pricing save shouldn't fail because of plan
    // cleanup hiccups.
    console.warn(
      `[paypal] deactivatePlan ${planId} failed (ignoring):`,
      err instanceof Error ? err.message : err,
    )
  }
}

// ─── Webhook signature verification ────────────────────────────
//
// PayPal signs every webhook with HMAC-RSA. We verify by calling
// PayPal's own verification endpoint, which is the only blessed
// approach (their JS / Python SDKs do the same thing under the
// hood). Manual signature verification is possible but brittle —
// PayPal's verification endpoint takes the raw headers + body and
// returns SUCCESS or FAILURE.

export async function verifyWebhookSignature(args: {
  webhookId: string
  transmissionId: string
  transmissionTime: string
  certUrl: string
  authAlgo: string
  transmissionSig: string
  /** The webhook event body, parsed JSON. PayPal expects it as an
   *  object, not a raw string. */
  body: unknown
}): Promise<boolean> {
  try {
    const r = await paypalCall<{ verification_status: string }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      {
        auth_algo: args.authAlgo,
        cert_url: args.certUrl,
        transmission_id: args.transmissionId,
        transmission_sig: args.transmissionSig,
        transmission_time: args.transmissionTime,
        webhook_id: args.webhookId,
        webhook_event: args.body,
      },
    )
    return r.verification_status === 'SUCCESS'
  } catch (err) {
    console.error('[paypal] webhook signature verify call failed:', err)
    return false
  }
}

// ─── Helpers for /api/subscription/* endpoints ─────────────────

export interface PlanSetForPricing {
  monthlyRegularPlanId: string
  monthlySalePlanId: string | null
  yearlyRegularPlanId: string
  yearlySalePlanId: string | null
}

/** Make sure every active price point in `appConfig/pricing` has
 *  a corresponding PayPal Plan id stored alongside it. Creates new
 *  Plans for any prices that don't have one yet OR that don't
 *  match the persisted plan's price (defensive — if someone
 *  manually deactivates a plan in PayPal dashboard, we re-create).
 *
 *  Called by:
 *    - savePricing (eager) — when admin saves new prices
 *    - createSubscriptionLink (lazy fallback) — first-time bootstrap
 *      or any race where pricing was saved without sync
 */
export async function syncPlansForPricing(pricing: {
  monthly: { regular: number; sale: number | null }
  yearly: { regular: number; sale: number | null }
  currency: string
}): Promise<PlanSetForPricing> {
  const db = getDb()
  const ref = db.collection('appConfig').doc('pricing')
  const snap = await ref.get()
  const existing = snap.exists
    ? (snap.data() as unknown as Record<string, unknown>)
    : {}
  const existingPlans = (existing.paypalPlans ?? {}) as {
    monthlyRegular?: { planId: string; amount: number }
    monthlySale?: { planId: string; amount: number } | null
    yearlyRegular?: { planId: string; amount: number }
    yearlySale?: { planId: string; amount: number } | null
  }

  const productId = await getOrCreateProduct()

  // For each slot, reuse the persisted plan if its price matches
  // exactly; otherwise create a new one. Old plans aren't deleted
  // (existing subscribers are grandfathered into them), they just
  // stop being referenced from Firestore.
  async function reuseOrCreate(
    slot: 'monthlyRegular' | 'monthlySale' | 'yearlyRegular' | 'yearlySale',
    amount: number | null,
    interval: 'monthly' | 'yearly',
    label: string,
  ): Promise<{ planId: string; amount: number } | null> {
    if (amount === null) return null
    const persisted = existingPlans[slot]
    if (persisted && persisted.amount === amount) {
      return persisted
    }
    // Deactivate the old plan if any — new subscribers go on the
    // fresh one; existing subscribers on the old plan continue
    // billing (deactivation only blocks NEW subscriptions).
    if (persisted) {
      await deactivatePlan(persisted.planId)
    }
    const newId = await createPlan({
      productId,
      label,
      amount,
      currency: pricing.currency,
      interval,
    })
    return { planId: newId, amount }
  }

  const monthlyRegular = await reuseOrCreate(
    'monthlyRegular',
    pricing.monthly.regular,
    'monthly',
    `Monthly Regular (${pricing.monthly.regular} ${pricing.currency})`,
  )
  const monthlySale = await reuseOrCreate(
    'monthlySale',
    pricing.monthly.sale,
    'monthly',
    `Monthly Sale (${pricing.monthly.sale} ${pricing.currency})`,
  )
  const yearlyRegular = await reuseOrCreate(
    'yearlyRegular',
    pricing.yearly.regular,
    'yearly',
    `Yearly Regular (${pricing.yearly.regular} ${pricing.currency})`,
  )
  const yearlySale = await reuseOrCreate(
    'yearlySale',
    pricing.yearly.sale,
    'yearly',
    `Yearly Sale (${pricing.yearly.sale} ${pricing.currency})`,
  )

  if (!monthlyRegular || !yearlyRegular) {
    throw new Error('Pricing missing regular monthly/yearly')
  }

  const paypalPlans = {
    monthlyRegular,
    monthlySale,
    yearlyRegular,
    yearlySale,
  }
  await ref.set({ paypalPlans }, { merge: true })

  return {
    monthlyRegularPlanId: monthlyRegular.planId,
    monthlySalePlanId: monthlySale?.planId ?? null,
    yearlyRegularPlanId: yearlyRegular.planId,
    yearlySalePlanId: yearlySale?.planId ?? null,
  }
}
