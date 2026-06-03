import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'

// ─── Inlined PayPal + Firebase helpers ──────────────────────────
//
// IMPORTANT — DO NOT REFACTOR THESE INTO A SHARED HELPER MODULE.
// Earlier versions imported them from `./_paypal` and then from
// `../api-lib/paypal` (outside api/). Both setups built cleanly and
// type-checked, but at runtime caused FUNCTION_INVOCATION_FAILED.
// Vercel's per-function bundler doesn't reliably include helper
// modules imported via relative paths from api/ in every shape.
// Keeping them inline here is the only configuration we've
// confirmed works in production. capture.ts and pricing.ts each
// keep their own copy of loadCurrentPricing for the same reason.
//
// If you change anything below, also update the corresponding copy
// in capture.ts (loadCurrentPricing only).

const PAYPAL_BASE =
  (process.env.PAYPAL_ENV || 'live') === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'

let firebaseApp: App | null = null
function getFirebase(): App {
  if (firebaseApp) return firebaseApp
  const existing = getApps()[0]
  if (existing) {
    firebaseApp = existing
    return firebaseApp
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set')
  firebaseApp = initializeApp({ credential: cert(JSON.parse(raw)) })
  return firebaseApp
}
function getDb(): Firestore {
  return getFirestore(getFirebase())
}

let cachedToken: { value: string; expiresAt: number } | null = null
async function paypalAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value
  }
  const clientId = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !secret) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set')
  }
  const auth = Buffer.from(`${clientId.trim()}:${secret.trim()}`).toString('base64')
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
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 }
  return json.access_token
}

async function paypalCall<T = unknown>(
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
  if (r.status === 204) return undefined as T
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!r.ok) {
    // PayPal error responses for v1/v2 follow:
    //   { name, message, details: [{ issue, description }, ...], debug_id }
    // The `message` is human-readable but generic ("could not be
    // performed"); the SPECIFIC error code lives in `details[].issue`
    // (e.g. SUBSCRIPTION_STATUS_INVALID, RESOURCE_NOT_FOUND). We
    // surface both — the issue codes are what callers grep for to
    // distinguish recoverable errors (e.g. "already cancelled") from
    // genuine failures.
    let summary: string = text.slice(0, 200)
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as {
        message?: string
        name?: string
        details?: Array<{ issue?: string; description?: string }>
      }
      const issues = (obj.details || [])
        .map((d) => d.issue)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
      const parts: string[] = []
      if (obj.message) parts.push(obj.message)
      if (issues.length > 0) parts.push(`[${issues.join(',')}]`)
      else if (obj.name) parts.push(`[${obj.name}]`)
      if (parts.length > 0) summary = parts.join(' ')
    }
    throw new Error(`PayPal ${method} ${path} failed: ${r.status} — ${summary}`)
  }
  return parsed as T
}

/* ─────────────────────────────────────────────────────────────
 *  Subscription expiry math — calendar-aware
 *
 *  Earlier the code used `+ planDays * 86_400_000` (i.e. 30 or 365
 *  literal days) to compute the next expiry. PayPal, however, bills
 *  by CALENDAR month — same day next month — which is 30 OR 31
 *  days depending on the month (and 28/29 for February). The day-
 *  count math drifted: a subscription that started May 21 would
 *  expire June 20 in our system but PayPal would only charge it on
 *  June 21. That 1-day gap is when the user has no Pro access even
 *  though their subscription is still active in PayPal — a real
 *  bug.
 *
 *  These helpers do the calendar-correct addition:
 *    - planDays === 30  → addMonths(date, 1)
 *    - planDays === 365 → addMonths(date, 12)
 *    - any other value  → fall back to literal days (admin-grant
 *                         path uses arbitrary day counts and
 *                         genuinely means "X calendar days").
 *
 *  Native Date.setMonth wraps month overflow safely (Aug 31 +
 *  1 month → Oct 1, not "Sep 31"), which matches PayPal's edge-
 *  case behaviour for subscriptions started on the 31st.
 * ───────────────────────────────────────────────────────────── */
function addCalendarSubscriptionPeriod(from: Date, planDays: number): Date {
  const result = new Date(from)
  if (planDays === 30) {
    result.setMonth(result.getMonth() + 1)
    return result
  }
  if (planDays === 365) {
    result.setMonth(result.getMonth() + 12)
    return result
  }
  // Fallback for non-subscription day counts (e.g. 7-day admin grant,
  // 14-day trial): use literal day arithmetic, which is what the
  // caller actually means in those cases.
  result.setTime(result.getTime() + planDays * 86_400_000)
  return result
}

/** Grace window for the "is this key still valid right now" check.
 *  Lets a key remain functional for this many hours past its
 *  expiresAt — but ONLY when subscriptionStatus is 'active' (so
 *  PayPal still believes the subscription is live and intends to
 *  charge or retry).
 *
 *  Covers two real-world scenarios:
 *    1. Webhook delay — PayPal charged on time but their webhook
 *       hasn't reached us yet (usually seconds, but can be hours
 *       under load on PayPal's side).
 *    2. PayPal retry window — initial recurring charge failed, but
 *       PayPal will retry over the next 1-3 days. Subscription
 *       status stays 'active' during retries; we don't want to
 *       lock the buyer out while they have a real chance of the
 *       charge succeeding.
 *
 *  24h is generous enough to cover both without being so long it
 *  hides a genuinely-cancelled subscription (a CANCELLED webhook
 *  flips status to 'cancelled' and the grace stops applying
 *  immediately). */
const SUBSCRIPTION_GRACE_HOURS = 24
const SUBSCRIPTION_GRACE_MS = SUBSCRIPTION_GRACE_HOURS * 3_600_000

/** True when this key represents a still-usable Pro entitlement,
 *  accounting for the grace window described above. Centralises
 *  the "is the user Pro right now" decision so frontends + cron
 *  jobs + the AccountPage all agree on the answer. */
function isProEntitlementActive(args: {
  expiresAt: string | undefined | null
  subscriptionStatus: string | undefined | null
}): boolean {
  if (!args.expiresAt) return false
  const expMs = Date.parse(args.expiresAt)
  if (!Number.isFinite(expMs)) return false
  const now = Date.now()
  if (expMs > now) return true
  // Past expiry: only still valid if PayPal still considers the
  // subscription active AND we're within the grace window.
  if (args.subscriptionStatus === 'active') {
    return now - expMs <= SUBSCRIPTION_GRACE_MS
  }
  return false
}

const PRICING_DEFAULTS_LOCAL = {
  monthly: { regular: 9, sale: null as number | null },
  yearly: { regular: 60, sale: null as number | null },
  currency: 'ILS',
}
interface LivePricingLocal {
  monthly: { regular: number; sale: number | null }
  yearly: { regular: number; sale: number | null }
  currency: string
  saleLabel?: string
}
async function loadCurrentPricing(): Promise<LivePricingLocal> {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('pricing').get()
    if (!snap.exists) return { ...PRICING_DEFAULTS_LOCAL }
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
        regular: numOr(data.monthly?.regular, PRICING_DEFAULTS_LOCAL.monthly.regular),
        sale: numOrNull(data.monthly?.sale),
      },
      yearly: {
        regular: numOr(data.yearly?.regular, PRICING_DEFAULTS_LOCAL.yearly.regular),
        sale: numOrNull(data.yearly?.sale),
      },
      currency:
        typeof data.currency === 'string' && data.currency
          ? data.currency
          : PRICING_DEFAULTS_LOCAL.currency,
      saleLabel:
        typeof data.saleLabel === 'string' && data.saleLabel.trim()
          ? data.saleLabel.trim()
          : undefined,
    }
  } catch (err) {
    console.error('[paypal] loadCurrentPricing failed:', err)
    return { ...PRICING_DEFAULTS_LOCAL }
  }
}

/** STRICT pricing load for the BUY path (display + actual charge).
 *
 *  Unlike loadCurrentPricing (which falls back to PRICING_DEFAULTS_LOCAL
 *  so admin tooling never breaks), this returns null on ANY problem:
 *  the appConfig/pricing doc is missing, Firestore is unreachable, or
 *  the stored numbers aren't valid positive prices. The /buy page and
 *  create-subscription use this so we NEVER show or charge a hardcoded
 *  price — the amount comes net from the database, and if we can't
 *  confirm it, checkout is blocked instead of falling back to 9/60. */
async function loadCurrentPricingStrict(): Promise<LivePricingLocal | null> {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('pricing').get()
    if (!snap.exists) return null
    const data = snap.data() as {
      monthly?: { regular?: unknown; sale?: unknown }
      yearly?: { regular?: unknown; sale?: unknown }
      currency?: unknown
      saleLabel?: unknown
    }
    const pos = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
    const monthlyRegular = pos(data.monthly?.regular)
    const yearlyRegular = pos(data.yearly?.regular)
    const currency =
      typeof data.currency === 'string' && data.currency ? data.currency : null
    // A real, sellable price requires both regular prices + a currency.
    if (monthlyRegular === null || yearlyRegular === null || !currency) {
      return null
    }
    return {
      monthly: { regular: monthlyRegular, sale: pos(data.monthly?.sale) },
      yearly: { regular: yearlyRegular, sale: pos(data.yearly?.sale) },
      currency,
      saleLabel:
        typeof data.saleLabel === 'string' && data.saleLabel.trim()
          ? data.saleLabel.trim()
          : undefined,
    }
  } catch (err) {
    console.error('[paypal] loadCurrentPricingStrict failed:', err)
    return null
  }
}

const PAYPAL_PRODUCT_DOC = 'paypal'
const PAYPAL_PRODUCT_NAME = 'ניהול הורדות פלוס Pro'
const PAYPAL_PRODUCT_DESCRIPTION =
  'Subscription to the Pro tier of Download Manager Plus desktop application'

async function getOrCreateProduct(): Promise<string> {
  const db = getDb()
  const ref = db.collection('appConfig').doc(PAYPAL_PRODUCT_DOC)
  const snap = await ref.get()
  if (snap.exists) {
    const data = snap.data() as { productId?: string }
    if (data.productId) return data.productId
  }
  const created = await paypalCall<{ id: string }>('POST', '/v1/catalogs/products', {
    name: PAYPAL_PRODUCT_NAME,
    description: PAYPAL_PRODUCT_DESCRIPTION,
    type: 'SERVICE',
    category: 'SOFTWARE',
  })
  await ref.set({ productId: created.id }, { merge: true })
  return created.id
}

async function createPaypalPlan(args: {
  productId: string
  label: string
  amount: number
  currency: string
  interval: 'monthly' | 'yearly'
}): Promise<string> {
  const frequency =
    args.interval === 'monthly'
      ? { interval_unit: 'MONTH', interval_count: 1 }
      : { interval_unit: 'YEAR', interval_count: 1 }
  const created = await paypalCall<{ id: string; status?: string }>(
    'POST',
    '/v1/billing/plans',
    {
      product_id: args.productId,
      name: `${PAYPAL_PRODUCT_NAME} — ${args.label}`,
      description: `${args.amount} ${args.currency} ${args.interval === 'monthly' ? 'per month' : 'per year'}`,
      // Explicitly create in ACTIVE state so the plan is ready for
      // subscriptions immediately. Without this PayPal's default
      // varies (sometimes ACTIVE, sometimes CREATED depending on
      // account settings) — and then calling /activate on an
      // already-ACTIVE plan returns 422 ("semantically incorrect").
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency,
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: args.amount.toFixed(2), currency_code: args.currency },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 1,
        setup_fee_failure_action: 'CANCEL',
      },
      taxes: undefined,
    },
  )
  // Belt-and-suspenders: if the plan came back in CREATED state
  // anyway (some PayPal accounts ignore the status field on create),
  // try to activate it. 422 here = already ACTIVE = we're done.
  if (created.status !== 'ACTIVE') {
    await activatePaypalPlan(created.id)
  }
  return created.id
}

/**
 * Flip a plan to ACTIVE. Idempotent — a 422 from PayPal means the
 * plan is already active, which is success from our perspective.
 *
 * Used in two places:
 *   1. As a belt-and-suspenders step after createPaypalPlan, for
 *      accounts where the create-with-status=ACTIVE field is
 *      silently ignored.
 *   2. When reusing a previously-deactivated plan from the catalog
 *      (e.g. price oscillated back to a value we already minted a
 *      plan for in the past). The plan still exists on PayPal in
 *      INACTIVE state; we just toggle it back on.
 *
 * Any error other than 422 propagates — including 404 / RESOURCE_NOT_FOUND
 * when the plan was deleted from PayPal manually. The catalog-reuse
 * code uses that signal to drop a stale entry and recreate.
 */
async function activatePaypalPlan(planId: string): Promise<void> {
  try {
    await paypalCall('POST', `/v1/billing/plans/${planId}/activate`, {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('422')) {
      // Already ACTIVE — that's the desired state, so success.
      return
    }
    throw err
  }
}

async function deactivatePaypalPlan(planId: string): Promise<void> {
  try {
    await paypalCall('POST', `/v1/billing/plans/${planId}/deactivate`, {})
  } catch (err) {
    console.warn(
      `[paypal] deactivatePlan ${planId} failed (ignoring):`,
      err instanceof Error ? err.message : err,
    )
  }
}

async function verifyWebhookSignature(args: {
  webhookId: string
  transmissionId: string
  transmissionTime: string
  certUrl: string
  authAlgo: string
  transmissionSig: string
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

interface PlanSetForPricing {
  monthlyRegularPlanId: string
  monthlySalePlanId: string | null
  yearlyRegularPlanId: string
  yearlySalePlanId: string | null
}

/**
 *  Sync the four pricing "slots" (monthly regular/sale, yearly
 *  regular/sale) to PayPal Plans.
 *
 *  Two-layer storage in `appConfig/pricing`:
 *
 *    - `paypalPlans`: which planId is currently bound to each slot.
 *      The fast-path lookup the admin save flow + buy flow consult.
 *
 *    - `paypalPlansCatalog`: a price index — every plan we've ever
 *      created, keyed by `"interval:amount:currency"` (e.g.
 *      "monthly:9.00:ILS"). On a price change, instead of always
 *      minting a fresh plan, we check the catalog first. If we've
 *      previously created a plan at that exact (interval, amount,
 *      currency) combo we re-activate it (PayPal allows toggling)
 *      and reuse — avoiding the case where oscillating 9 → 5 → 9
 *      leaves three plans on PayPal when two would suffice.
 *
 *  Why a catalog and not a query against PayPal's list-plans:
 *    list-plans is paginated and rate-limited; the catalog is a
 *    single Firestore read. PayPal stays source-of-truth for plan
 *    *status* — if a catalog entry points to a plan PayPal no
 *    longer knows about (manually deleted from the dashboard), the
 *    activate call returns 404 and we drop the stale entry and
 *    recreate.
 */
type CatalogEntry = {
  planId: string
  amount: number
  interval: 'monthly' | 'yearly'
  currency: string
}

function catalogKey(interval: 'monthly' | 'yearly', amount: number, currency: string): string {
  return `${interval}:${amount.toFixed(2)}:${currency}`
}

/**
 *  Crawl PayPal's billing-plans list for our product and merge any
 *  plans we don't already track into the in-memory catalog.
 *
 *  Why this exists: when the catalog field was introduced, the
 *  account already had a bunch of historical plans (deactivated
 *  9 ILS, 5 ILS, etc.). Those plans don't appear in any current
 *  `paypalPlans` slot, so the catalog backfill-from-slots step
 *  misses them — and `reuseOrCreate` ends up minting a third 9 ILS
 *  plan when the price oscillates back. This crawl plugs the gap
 *  by asking PayPal "what do you actually have?" once per sync.
 *
 *  The crawl is bounded (5 pages × 20 = 100 plans max) so a runaway
 *  account doesn't blow the 60 s function budget. For each candidate
 *  we first try to extract price + interval from the plan's
 *  description string (which createPaypalPlan writes in a known
 *  format) — that avoids a GET per plan when our own plans
 *  dominate. Only if description parsing fails do we GET the full
 *  plan to read billing_cycles.
 */
function parsePlanFromDescription(
  desc: string | undefined,
  currency: string,
): { interval: 'monthly' | 'yearly'; amount: number } | null {
  if (!desc) return null
  // Format we write in createPaypalPlan: "9 ILS per month" /
  // "100 ILS per year" (with optional decimals).
  const m = desc.match(/^(\d+(?:\.\d+)?)\s+([A-Z]{3})\s+per\s+(month|year)$/i)
  if (!m) return null
  if (m[2].toUpperCase() !== currency) return null
  const amount = parseFloat(m[1])
  if (!Number.isFinite(amount)) return null
  return {
    interval: m[3].toLowerCase() === 'month' ? 'monthly' : 'yearly',
    amount,
  }
}

async function backfillCatalogFromPayPal(
  catalog: Record<string, CatalogEntry>,
  productId: string,
  currency: string,
): Promise<void> {
  // Discover every plan PayPal has for this product. We need the
  // full set (not just first match) so we can identify duplicates
  // and deactivate the extras.
  type Discovered = {
    id: string
    interval: 'monthly' | 'yearly'
    amount: number
    status: string | undefined
  }
  const discovered: Discovered[] = []

  for (let page = 1; page <= 5; page++) {
    let listResp: {
      plans?: Array<{
        id: string
        status?: string
        description?: string
      }>
      total_pages?: number
    } = {}
    try {
      listResp = await paypalCall<typeof listResp>(
        'GET',
        `/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20&page=${page}&total_required=true`,
      )
    } catch (err) {
      console.warn(`[paypal/backfill] list page ${page} failed (continuing):`, err)
      return
    }
    const plans = listResp.plans ?? []
    if (plans.length === 0) break

    for (const plan of plans) {
      // Fast path: parse from description.
      let parsed = parsePlanFromDescription(plan.description, currency)

      // Slow path: GET full plan for billing_cycles.
      if (!parsed) {
        let detail: {
          billing_cycles?: Array<{
            frequency?: { interval_unit?: string; interval_count?: number }
            pricing_scheme?: {
              fixed_price?: { value?: string; currency_code?: string }
            }
          }>
        } = {}
        try {
          detail = await paypalCall<typeof detail>(
            'GET',
            `/v1/billing/plans/${plan.id}`,
          )
        } catch (err) {
          console.warn(`[paypal/backfill] get plan ${plan.id} failed (skipping):`, err)
          continue
        }
        const cycle = detail.billing_cycles?.[0]
        if (!cycle) continue
        const intervalUnit = cycle.frequency?.interval_unit
        const intervalCount = cycle.frequency?.interval_count ?? 1
        const priceValue = cycle.pricing_scheme?.fixed_price?.value
        const priceCurrency = cycle.pricing_scheme?.fixed_price?.currency_code
        if (intervalCount !== 1) continue
        if (priceCurrency !== currency) continue
        const interval: 'monthly' | 'yearly' | null =
          intervalUnit === 'MONTH'
            ? 'monthly'
            : intervalUnit === 'YEAR'
              ? 'yearly'
              : null
        if (!interval || !priceValue) continue
        const amount = parseFloat(priceValue)
        if (!Number.isFinite(amount)) continue
        parsed = { interval, amount }
      }

      discovered.push({
        id: plan.id,
        interval: parsed.interval,
        amount: parsed.amount,
        status: plan.status,
      })
    }

    if (plans.length < 20) break
    if (listResp.total_pages && page >= listResp.total_pages) break
  }

  // Group by (interval, amount, currency). For each group:
  //  - canonical = plan currently in catalog (stable references for
  //    existing subscribers), else the first discovered.
  //  - everyone else in the group is a duplicate → deactivate.
  //  - update catalog to point to canonical.
  const groups = new Map<string, Discovered[]>()
  for (const p of discovered) {
    const k = catalogKey(p.interval, p.amount, currency)
    const arr = groups.get(k) ?? []
    arr.push(p)
    groups.set(k, arr)
  }
  for (const [k, members] of groups) {
    const inCatalog = catalog[k]?.planId
    const canonical =
      (inCatalog && members.some((m) => m.id === inCatalog))
        ? inCatalog
        : members[0].id
    // Always (re-)set catalog so the field reflects the canonical
    // choice for this key, even if it was already there.
    const first = members[0]
    catalog[k] = {
      planId: canonical,
      amount: first.amount,
      interval: first.interval,
      currency,
    }
    if (members.length > 1) {
      console.warn(
        `[paypal/backfill] ${members.length} duplicate plans for ${k} — keeping ${canonical}, deactivating ${members.length - 1}`,
      )
    }
    for (const m of members) {
      if (m.id === canonical) continue
      // Best-effort — already-INACTIVE returns an error PayPal-side
      // but deactivatePaypalPlan swallows it.
      await deactivatePaypalPlan(m.id)
    }
  }
}

async function syncPlansForPricing(
  pricing: {
    monthly: { regular: number; sale: number | null }
    yearly: { regular: number; sale: number | null }
    currency: string
  },
  opts: {
    /**
     * Force a full PayPal list+dedupe pass even when no slot
     * appears to need a new plan. Set true from the admin "save
     * prices" flow so each save also opportunistically cleans up
     * any historical duplicates. Leave false from the buy flow so
     * a customer click doesn't pay for a ~5s list crawl when
     * prices are unchanged.
     */
    forceBackfill?: boolean
  } = {},
): Promise<PlanSetForPricing> {
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

  // Mutable working copy of the catalog. Backfilled below from the
  // current slot state so legacy data (deployed before the catalog
  // existed) gets indexed on its next sync.
  const catalog: Record<string, CatalogEntry> =
    ((existing.paypalPlansCatalog as Record<string, CatalogEntry> | undefined) ?? {})

  function backfillCatalogFromSlot(
    slot: { planId: string; amount: number } | null | undefined,
    interval: 'monthly' | 'yearly',
  ) {
    if (!slot) return
    const k = catalogKey(interval, slot.amount, pricing.currency)
    if (!catalog[k]) {
      catalog[k] = {
        planId: slot.planId,
        amount: slot.amount,
        interval,
        currency: pricing.currency,
      }
    }
  }
  backfillCatalogFromSlot(existingPlans.monthlyRegular, 'monthly')
  backfillCatalogFromSlot(existingPlans.monthlySale, 'monthly')
  backfillCatalogFromSlot(existingPlans.yearlyRegular, 'yearly')
  backfillCatalogFromSlot(existingPlans.yearlySale, 'yearly')

  const productId = await getOrCreateProduct()

  // Decide whether we need to ask PayPal about its actual plan
  // inventory. We only crawl when at least one slot is going to
  // create or change its plan AND the target (interval, amount,
  // currency) isn't already in our catalog. For an admin save that
  // doesn't actually change anything, we stay in fast paths and
  // never hit PayPal's list endpoint.
  type SlotSpec = readonly [
    'monthlyRegular' | 'monthlySale' | 'yearlyRegular' | 'yearlySale',
    number | null,
    'monthly' | 'yearly',
  ]
  const slotSpecs: readonly SlotSpec[] = [
    ['monthlyRegular', pricing.monthly.regular, 'monthly'],
    ['monthlySale', pricing.monthly.sale, 'monthly'],
    ['yearlyRegular', pricing.yearly.regular, 'yearly'],
    ['yearlySale', pricing.yearly.sale, 'yearly'],
  ]
  const needsPayPalBackfill =
    opts.forceBackfill ||
    slotSpecs.some(([slot, amount, interval]) => {
      if (amount == null) return false
      const persisted = existingPlans[slot]
      if (persisted && persisted.amount === amount) return false  // fast path
      const k = catalogKey(interval, amount, pricing.currency)
      return !catalog[k]
    })
  if (needsPayPalBackfill) {
    await backfillCatalogFromPayPal(catalog, productId, pricing.currency)
    // After backfill + dedupe, a slot may still point to a planId
    // we just deactivated (because it was a duplicate). Redirect
    // each slot to the canonical plan for its (interval, amount,
    // currency) so reuseOrCreate's fast path uses the live plan.
    function redirectSlotToCanonical(
      slot: 'monthlyRegular' | 'monthlySale' | 'yearlyRegular' | 'yearlySale',
      interval: 'monthly' | 'yearly',
    ) {
      const persisted = existingPlans[slot]
      if (!persisted) return
      const k = catalogKey(interval, persisted.amount, pricing.currency)
      const canonical = catalog[k]?.planId
      if (canonical && canonical !== persisted.planId) {
        existingPlans[slot] = { planId: canonical, amount: persisted.amount }
      }
    }
    redirectSlotToCanonical('monthlyRegular', 'monthly')
    redirectSlotToCanonical('monthlySale', 'monthly')
    redirectSlotToCanonical('yearlyRegular', 'yearly')
    redirectSlotToCanonical('yearlySale', 'yearly')
  }

  async function reuseOrCreate(
    slot: 'monthlyRegular' | 'monthlySale' | 'yearlyRegular' | 'yearlySale',
    amount: number | null,
    interval: 'monthly' | 'yearly',
    label: string,
  ): Promise<{ planId: string; amount: number } | null> {
    const persisted = existingPlans[slot]

    // Slot now empty (e.g. sale removed). Deactivate the old plan
    // for tidiness, but KEEP its catalog entry — we may want to
    // resurrect it if the price comes back.
    if (amount === null) {
      if (persisted) await deactivatePaypalPlan(persisted.planId)
      return null
    }

    // Fast path: slot already at this price → nothing to do.
    if (persisted && persisted.amount === amount) return persisted

    // The slot's plan needs to change. Check the catalog first —
    // if we've ever minted a plan at this exact (interval, amount,
    // currency) combo, reuse it.
    const k = catalogKey(interval, amount, pricing.currency)
    const catalogHit = catalog[k]
    if (catalogHit) {
      try {
        // Re-activate in case the plan was deactivated in a prior
        // swap. activatePaypalPlan handles the "already active" 422
        // as success.
        await activatePaypalPlan(catalogHit.planId)
        // Deactivate the slot's previous plan (different plan_id)
        // so PayPal's plan list isn't littered with stale ACTIVE
        // entries that nobody is subscribing to.
        if (persisted && persisted.planId !== catalogHit.planId) {
          await deactivatePaypalPlan(persisted.planId)
        }
        return { planId: catalogHit.planId, amount }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Only treat "plan no longer exists" (404 / RESOURCE_NOT_FOUND)
        // as catalog-stale. Transient errors (auth, rate-limit,
        // network) propagate so we don't silently mint duplicates
        // on a flake.
        const stale =
          msg.includes('404') || msg.includes('RESOURCE_NOT_FOUND')
        if (!stale) throw err
        console.warn(
          `[paypal] catalog entry ${k} (${catalogHit.planId}) no longer exists on PayPal, recreating:`,
          msg,
        )
        delete catalog[k]
        // Fall through to create branch below.
      }
    }

    // Catalog miss (or stale hit) — deactivate the slot's old plan,
    // create a new one, and add it to the catalog for next time.
    if (persisted) await deactivatePaypalPlan(persisted.planId)
    const newId = await createPaypalPlan({
      productId,
      label,
      amount,
      currency: pricing.currency,
      interval,
    })
    catalog[k] = {
      planId: newId,
      amount,
      interval,
      currency: pricing.currency,
    }
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
  await ref.set(
    {
      paypalPlans: {
        monthlyRegular,
        monthlySale,
        yearlyRegular,
        yearlySale,
      },
      paypalPlansCatalog: catalog,
    },
    { merge: true },
  )
  return {
    monthlyRegularPlanId: monthlyRegular.planId,
    monthlySalePlanId: monthlySale?.planId ?? null,
    yearlyRegularPlanId: yearlyRegular.planId,
    yearlySalePlanId: yearlySale?.planId ?? null,
  }
}

/**
 * Unified PayPal endpoint. ONE serverless function handles every
 * PayPal-related operation in the system, dispatched on
 * `?action=...` query parameter:
 *
 *   - webhook              PayPal callbacks (subscription events)
 *   - create-subscription  User clicks "subscribe" on /buy
 *   - session              User logs in on /manage
 *   - status               /manage refreshes subscription list
 *   - cancel               User cancels subscription
 *   - sync-plans           Admin saves new pricing → sync PayPal Plans
 *
 * Why one big file: the Vercel Hobby plan caps a deployment at 12
 * serverless functions. The original split (one file per action)
 * pushed the project over the limit. Consolidating into a single
 * dispatcher is the standard workaround on Vercel — same pattern
 * Stripe, GitHub Apps, etc. use when bundling related actions.
 *
 * Per-action auth model:
 *   - webhook              PayPal signature header (cryptographic)
 *   - create-subscription  Public (anyone with email can subscribe)
 *   - session              Email+password via Firebase Identity Toolkit
 *   - status               Session JWT (1-hour, scoped to subscription ids)
 *   - cancel               Session JWT + Firestore ownership check
 *   - sync-plans           Firebase ID token + admin email allowlist
 *
 * No action is shared with another — each has its own gate. Mixing
 * them in one file doesn't weaken security, just routing.
 */

export const config = {
  // Webhook + sync-plans can be slow (multiple PayPal API
  // round-trips). 60s is the Hobby plan max and matches what the
  // previous split files used.
  maxDuration: 60,
}

const ADMIN_EMAILS = ['dyshalts@gmail.com']
// Bumped from 1h to 24h after the /revisions workspace launched —
// editors spend MUCH longer in a workspace than they do on /account
// (which is a quick "check status, manage subscription, leave"
// flow). A 1h session meant a user uploading a long video round
// could hit a hard logout mid-task with no warning. 24h matches
// the desktop's Firebase ID-token refresh cadence so /account
// users see a similar lifetime regardless of which surface they
// signed in on.
const SESSION_TTL_SECONDS = 24 * 60 * 60
const MAX_REASON_LENGTH = 500
const WEBSITE_BASE = 'https://dmplus.net'

/**
 *  Email-provider whitelist for signup.
 *
 *  Mirror of src/lib/emailDomains.ts in the desktop repo — they
 *  must stay in sync. The client enforces this for immediate UX
 *  feedback; we enforce it again here because a hostile client
 *  could bypass the JS check and call the API directly.
 *
 *  Why a whitelist: throwaway-mail providers spin up new domains
 *  constantly; a blocklist would need constant maintenance. The
 *  finite set of major consumer providers below covers ~95% of
 *  real users and is stable for years.
 */
const ALLOWED_EMAIL_DOMAINS = new Set<string>([
  // 1. Google
  'gmail.com', 'googlemail.com',
  // 2. Microsoft (Outlook / Hotmail / Live / MSN)
  'outlook.com', 'outlook.co.il', 'hotmail.com', 'hotmail.co.il',
  'live.com', 'live.co.il', 'msn.com',
  // 3. Yahoo
  'yahoo.com', 'yahoo.co.il', 'ymail.com', 'rocketmail.com',
  // 4. Apple iCloud
  'icloud.com', 'me.com', 'mac.com',
  // 5. Proton
  'proton.me', 'protonmail.com', 'pm.me',
  // 6. AOL
  'aol.com',
  // 7. GMX
  'gmx.com', 'gmx.net', 'gmx.de',
  // 8. Yandex
  'yandex.com', 'yandex.ru', 'ya.ru',
  // + Walla (Israeli — primary audience)
  'walla.co.il', 'walla.com',
])

function isAllowedEmailDomain(rawEmail: string): boolean {
  const at = rawEmail.lastIndexOf('@')
  if (at < 0 || at === rawEmail.length - 1) return false
  const domain = rawEmail.slice(at + 1).trim().toLowerCase()
  return ALLOWED_EMAIL_DOMAINS.has(domain)
}

const EMAIL_DOMAIN_REJECTION_MESSAGE =
  'ניתן להירשם רק עם כתובת מייל מספק מוכר (Gmail, Outlook, Yahoo, iCloud וכו׳)'

/** Feature flag — if set to "true" the SSO/session/trial/redeem
 *  endpoints enforce that the Firebase ID token's email_verified
 *  claim is true. Default OFF so the deploy doesn't lock out
 *  existing users (whose accounts were created before we required
 *  verification). Flow:
 *    1. Deploy with the flag off.
 *    2. Operator calls action=admin-migrate-email-verified once
 *       to flip emailVerified=true on every existing user.
 *    3. Operator sets ENFORCE_EMAIL_VERIFIED="true" in Vercel.
 *    4. Enforcement begins on next request.
 *  Without the flag, users with email_verified=false would lose
 *  access between (1) and (2) — including the operator who needs
 *  to perform the migration. */
function emailVerificationEnforced(): boolean {
  return process.env.ENFORCE_EMAIL_VERIFIED === 'true'
}

/**
 * Sliding-window rate limit backed by Firestore. Returns true if
 * the action is allowed, false if the caller has exceeded `max`
 * actions in the last `windowSecs` seconds.
 *
 * Why Firestore and not Upstash/Redis: Upstash is already in
 * package.json but never configured (no env vars, no working
 * client). Adding a second infra dependency just for rate-limiting
 * would require the operator to provision Upstash. Firestore is
 * already running, can do this for free, and the per-action cost
 * (one get + one set) is well under the daily quota for any
 * realistic load on a SaaS this size.
 *
 * The window is "naive sliding" — we store windowStart + count and
 * reset both when the window expires. A more sophisticated leaky
 * bucket would be marginally more accurate near the edge but
 * isn't worth the extra complexity for this kind of soft DOS
 * protection.
 */
async function tryRateLimit(
  key: string,
  max: number,
  windowSecs: number,
): Promise<boolean> {
  const db = getDb()
  const ref = db.collection('rateLimits').doc(key)
  const now = Date.now()
  const windowMs = windowSecs * 1000
  return await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref)
    const data = snap.exists
      ? (snap.data() as { windowStart?: number; count?: number })
      : {}
    const windowStart = typeof data.windowStart === 'number' ? data.windowStart : 0
    const count = typeof data.count === 'number' ? data.count : 0
    if (now - windowStart > windowMs) {
      // New window — reset.
      txn.set(ref, { windowStart: now, count: 1 })
      return true
    }
    if (count >= max) {
      return false
    }
    txn.set(ref, { windowStart, count: count + 1 })
    return true
  })
}

interface IdentityResponse {
  localId?: string
  email?: string
  users?: Array<{ email?: string; localId?: string }>
  error?: { code?: number; message?: string }
}

interface SessionClaims {
  uid: string
  email: string
  subscriptionIds: string[]
  iat: number
  exp: number
}

interface KeyDoc {
  key?: string
  redeemedBy?: string
  buyerEmail?: string
  redeemedByEmail?: string
  expiresAt?: string
  subscriptionId?: string
  subscriptionStatus?: string
  subscriptionStartedAt?: string
  subscriptionCancelledAt?: string
  subscriptionPrice?: number
  subscriptionCurrency?: string
  subscriptionPlanDays?: number
  planDays?: number
  // Stamped by handlePaymentFailed when PayPal's PAYMENT.FAILED
  // webhook fires; lets the admin panel surface at-risk
  // subscriptions and lets us debug retry behaviour after the fact.
  paymentFailedAt?: string
  paymentFailureCount?: number
}

/* ─────────────────────────────────────────────────────────────
 *  Dispatcher
 * ───────────────────────────────────────────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Action can come from query string or body; both work so the
  // PayPal Dashboard webhook URL can use ?action=webhook in the URL
  // without needing custom body params.
  const action =
    (typeof req.query.action === 'string' ? req.query.action : '') ||
    (typeof (req.body as { action?: string })?.action === 'string'
      ? (req.body as { action: string }).action
      : '')
  // Most actions are POST. `unsubscribe` is the lone exception —
  // it's hit by a GET link inside a marketing email so the
  // recipient can click straight from their inbox. We still reject
  // GETs for anything else to keep the surface area tight.
  if (req.method !== 'POST' && !(req.method === 'GET' && action === 'unsubscribe')) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  try {
    switch (action) {
      case 'webhook':
        return await handleWebhook(req, res)
      case 'create-subscription':
        return await handleCreateSubscription(req, res)
      case 'session':
        return await handleSession(req, res)
      case 'restore-session':
        return await handleRestoreSession(req, res)
      case 'sso':
        return await handleSso(req, res)
      case 'status':
        return await handleStatus(req, res)
      case 'cancel':
        return await handleCancel(req, res)
      case 'billing-history':
        return await handleBillingHistory(req, res)
      case 'sync-plans':
        return await handleSyncPlans(req, res)
      case 'signup-request-code':
        return await handleSignupRequestCode(req, res)
      case 'signup-verify-code':
        return await handleSignupVerifyCode(req, res)
      case 'verify-existing-request-code':
        return await handleVerifyExistingRequestCode(req, res)
      case 'verify-existing-confirm-code':
        return await handleVerifyExistingConfirmCode(req, res)
      case 'admin-migrate-email-verified':
        return await handleAdminMigrateEmailVerified(req, res)
      case 'admin-send-test-email':
        return await handleAdminSendTestEmail(req, res)
      case 'admin-send-marketing-email':
        return await handleAdminSendMarketingEmail(req, res)
      case 'unsubscribe':
        return await handleUnsubscribe(req, res)
      case 'update-marketing-opt-in':
        return await handleUpdateMarketingOptIn(req, res)
      case 'mint-renew-token':
        return await handleMintRenewToken(req, res)
      case 'admin-create-referral':
        return await handleAdminCreateReferral(req, res)
      case 'admin-list-referrals':
        return await handleAdminListReferrals(req, res)
      case 'admin-delete-referral':
        return await handleAdminDeleteReferral(req, res)
      case 'admin-referral-report':
        return await handleAdminReferralReport(req, res)
      case 'admin-referral-detail':
        return await handleAdminReferralDetail(req, res)
      case 'admin-referral-export':
        return await handleAdminReferralExport(req, res)
      case 'admin-set-referral-credentials':
        return await handleAdminSetReferralCredentials(req, res)
      case 'admin-set-referral-commission':
        return await handleAdminSetReferralCommission(req, res)
      case 'admin-set-referral-visibility':
        return await handleAdminSetReferralVisibility(req, res)
      case 'partner-login':
        return await handlePartnerLogin(req, res)
      case 'partner-stats':
        return await handlePartnerStats(req, res)
      case 'admin-grant-pro':
        return await handleAdminGrantPro(req, res)
      case 'admin-2fa-request':
        return await handleAdmin2faRequest(req, res)
      case 'admin-2fa-verify':
        return await handleAdmin2faVerify(req, res)
      case 'admin-ip-allowed':
        return await handleAdminIpAllowed(req, res)
      case 'admin-get-ip-allowlist':
        return await handleAdminGetIpAllowlist(req, res)
      case 'admin-set-ip-allowlist':
        return await handleAdminSetIpAllowlist(req, res)
      case 'admin-list-users':
        return await handleAdminListUsers(req, res)
      case 'admin-set-user-blocked':
        return await handleAdminSetUserBlocked(req, res)
      case 'admin-set-user-role':
        return await handleAdminSetUserRole(req, res)
      case 'admin-set-user-subscription':
        return await handleAdminSetUserSubscription(req, res)
      case 'admin-clear-user-device':
        return await handleAdminClearUserDevice(req, res)
      case 'admin-approve-trial':
        return await handleAdminApproveTrial(req, res)
      case 'get-pricing':
        return await handleGetPricing(req, res)
      case 'get-terms':
        return await handleGetTerms(req, res)
      case 'get-privacy':
        return await handleGetPrivacy(req, res)
      default:
        return res
          .status(400)
          .json({ ok: false, error: `unknown action: ${action || '(empty)'}` })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error(`[paypal/${action}] failed:`, err)
    return res.status(500).json({ ok: false, error: message })
  }
}

/* ─────────────────────────────────────────────────────────────
 *  Webhook (action=webhook)
 *
 *  See the original /api/paypal-webhook.ts (pre-consolidation)
 *  for the full design notes. Identical behaviour: PayPal POSTs
 *  signed events; we verify with PayPal's verify endpoint, dedupe
 *  by event id in Firestore, and update the productKey for the
 *  subscription accordingly.
 * ───────────────────────────────────────────────────────────── */

interface PayPalWebhookEvent {
  id: string
  event_type: string
  resource_type?: string
  create_time?: string
  resource?: Record<string, unknown>
}

async function handleWebhook(req: VercelRequest, res: VercelResponse) {
  const event = req.body as PayPalWebhookEvent
  if (!event || typeof event.id !== 'string' || !event.event_type) {
    return res.status(400).json({ ok: false, error: 'Bad webhook payload' })
  }

  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!webhookId) {
    console.error('[webhook] PAYPAL_WEBHOOK_ID not set — rejecting all events')
    return res.status(500).json({ ok: false, error: 'Webhook not configured' })
  }
  const transmissionId = String(req.headers['paypal-transmission-id'] || '')
  const transmissionTime = String(req.headers['paypal-transmission-time'] || '')
  const certUrl = String(req.headers['paypal-cert-url'] || '')
  const authAlgo = String(req.headers['paypal-auth-algo'] || '')
  const transmissionSig = String(req.headers['paypal-transmission-sig'] || '')
  if (!transmissionId || !transmissionTime || !certUrl || !transmissionSig) {
    return res.status(401).json({ ok: false, error: 'Missing signature headers' })
  }
  const isValid = await verifyWebhookSignature({
    webhookId,
    transmissionId,
    transmissionTime,
    certUrl,
    authAlgo,
    transmissionSig,
    body: event,
  })
  if (!isValid) {
    return res.status(401).json({ ok: false, error: 'Invalid signature' })
  }

  const db = getDb()
  const eventRef = db.collection('paypalEvents').doc(event.id)
  const existing = await eventRef.get()
  if (existing.exists && existing.data()?.processed === true) {
    return res.status(200).json({ ok: true, status: 'already_processed' })
  }
  await eventRef.set(
    {
      eventId: event.id,
      eventType: event.event_type,
      receivedAt: new Date().toISOString(),
      processed: false,
      rawResource: event.resource ?? null,
    },
    { merge: true },
  )

  let result: { ok: boolean; summary: string; error?: string }
  try {
    switch (event.event_type) {
      case 'PAYMENT.SALE.COMPLETED':
        result = await handleSaleCompleted(event)
        break
      case 'BILLING.SUBSCRIPTION.CREATED':
        // SECURITY: do NOT mint a key here. CREATED fires the
        // moment we POST /v1/billing/subscriptions — BEFORE the
        // buyer has approved or paid. Treating it the same as
        // ACTIVATED let anyone who called create-subscription
        // receive a free key (the vulnerability the test
        // account exposed on 2026-05-21). Log + ignore;
        // ACTIVATED + SALE.COMPLETED handle the real activation.
        result = {
          ok: true,
          summary: `ignored CREATED (not paid yet) for ${(event.resource as { id?: string } | undefined)?.id || '?'}`,
        }
        break
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        result = await ensureKeyForSubscription(
          (event.resource as { id?: string } | undefined)?.id || '',
        )
        break
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        result = await handleSubscriptionEnded(event)
        break
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        result = await handleSubscriptionSuspended(event)
        break
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        result = await handlePaymentFailed(event)
        break
      case 'CUSTOMER.DISPUTE.CREATED':
        console.error('[webhook] DISPUTE — manual review needed:', event.id)
        result = { ok: true, summary: `dispute logged for event ${event.id}` }
        break
      default:
        result = { ok: true, summary: `ignored event type ${event.event_type}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[webhook] processing failed for', event.id, message)
    result = { ok: false, summary: 'processing failed', error: message }
  }

  await eventRef.set(
    {
      processed: result.ok,
      processedAt: new Date().toISOString(),
      summary: result.summary,
      error: result.error ?? null,
    },
    { merge: true },
  )

  return res.status(200).json({ ok: true, status: result.summary })
}

async function handleSaleCompleted(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as
    | {
        id: string
        amount: { total: string; currency: string }
        billing_agreement_id?: string
      }
    | undefined
  if (!resource?.billing_agreement_id) {
    return { ok: true, summary: 'sale without billing_agreement_id — ignored' }
  }
  const subscriptionId = resource.billing_agreement_id
  const db = getDb()
  const keys = await db
    .collection('productKeys')
    .where('subscriptionId', '==', subscriptionId)
    .limit(1)
    .get()
  if (keys.empty) {
    return {
      ok: true,
      summary: `sale for ${subscriptionId} — key not yet created (deferred)`,
    }
  }
  const keyDoc = keys.docs[0]
  const key = keyDoc.data() as KeyDoc
  const paidAmount = parseFloat(resource.amount.total)
  if (
    typeof key.subscriptionPrice === 'number' &&
    Math.abs(paidAmount - key.subscriptionPrice) > 0.01
  ) {
    return {
      ok: false,
      summary: `amount mismatch ${paidAmount} vs ${key.subscriptionPrice}`,
      error: `Refusing to extend key ${keyDoc.id} — paid amount doesn't match grandfathered price`,
    }
  }
  const days = key.planDays || 30
  const baseTime = Math.max(
    key.expiresAt ? new Date(key.expiresAt).getTime() : 0,
    Date.now(),
  )
  // Calendar-aware extension — matches PayPal's same-day-next-month
  // billing rhythm. See addCalendarSubscriptionPeriod for the
  // rationale.
  const newExpiresAt = addCalendarSubscriptionPeriod(new Date(baseTime), days)
  await keyDoc.ref.update({
    expiresAt: newExpiresAt.toISOString(),
    lastRenewalAt: new Date().toISOString(),
    subscriptionStatus: 'active',
    reminder10dSentAt: null,
    reminder2dSentAt: null,
    // Clear payment-failure stamps — a successful charge means the
    // buyer either updated their card or the prior failure was a
    // transient blip that PayPal retried through. Without this
    // reset, paymentFailureCount would accumulate forever and the
    // admin panel's "at risk" filter would surface customers who
    // are actually fine.
    paymentFailedAt: null,
    paymentFailureCount: 0,
    billingHistory: FieldValue.arrayUnion({
      eventId: event.id,
      amount: paidAmount,
      currency: resource.amount.currency,
      at: new Date().toISOString(),
    }),
  })
  return {
    ok: true,
    summary: `extended ${keyDoc.id} by ${days}d → ${newExpiresAt.toISOString()}`,
  }
}

async function ensureKeyForSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  if (!subscriptionId) return { ok: false, summary: 'no subscription id' }
  const db = getDb()
  const existing = await db
    .collection('productKeys')
    .where('subscriptionId', '==', subscriptionId)
    .limit(1)
    .get()
  if (!existing.empty) {
    return { ok: true, summary: `key already exists for ${subscriptionId}` }
  }
  const sub = await paypalCall<{
    id: string
    plan_id: string
    status: string
    subscriber: { email_address: string }
  }>('GET', `/v1/billing/subscriptions/${subscriptionId}`)
  // SECURITY belt-and-suspenders: only mint a key for genuinely
  // ACTIVE subscriptions. If a webhook for a different event ever
  // lands here with an un-paid subscription (CREATED, APPROVAL_
  // PENDING, APPROVED-not-yet-billed, etc.), refuse. The dispatch
  // above filters CREATED out, but this query against PayPal's
  // current state is the load-bearing check.
  if (sub.status !== 'ACTIVE') {
    return {
      ok: true,
      summary: `subscription ${subscriptionId} is ${sub.status} — not minting key`,
    }
  }
  const plan = await paypalCall<{
    id: string
    billing_cycles: Array<{
      frequency: { interval_unit: string; interval_count: number }
      pricing_scheme: {
        fixed_price: { value: string; currency_code: string }
      }
    }>
  }>('GET', `/v1/billing/plans/${sub.plan_id}`)
  const cycle = plan.billing_cycles[0]
  const planDays = cycle.frequency.interval_unit === 'YEAR' ? 365 : 30
  const planPrice = parseFloat(cycle.pricing_scheme.fixed_price.value)
  const planCurrency = cycle.pricing_scheme.fixed_price.currency_code
  const buyerEmail = sub.subscriber.email_address
  const key = generateKeyString()
  // Calendar-aware initial expiry — first cycle ends on the same
  // calendar day next month/year, matching PayPal's next-charge
  // date. Using literal planDays (30/365) would put us 1 day off
  // in 31-day months, leaving the buyer expired while PayPal still
  // hasn't billed them again.
  const initialExpiresAt = addCalendarSubscriptionPeriod(new Date(), planDays)

  // Read the pendingSubscriptions context for this subscription
  // — linkToUid (auto-redeem hint) and renewKeyId (extend-existing
  // -key hint). Guests have neither; signed-in buyers from
  // /account have linkToUid; renewals (email link OR /account
  // "renew" button) have renewKeyId AND linkToUid.
  let linkToUid: string | null = null
  let renewKeyId: string | null = null
  try {
    const pendingDoc = await db
      .collection('pendingSubscriptions')
      .doc(subscriptionId)
      .get()
    if (pendingDoc.exists) {
      const data = pendingDoc.data() as {
        linkToUid?: string | null
        renewKeyId?: string | null
      }
      if (typeof data.linkToUid === 'string' && data.linkToUid) {
        linkToUid = data.linkToUid
      }
      if (typeof data.renewKeyId === 'string' && data.renewKeyId) {
        renewKeyId = data.renewKeyId
      }
    }
  } catch (err) {
    console.warn(
      '[webhook/sale-completed] pendingSubscriptions lookup failed:',
      err,
    )
  }

  // ── RENEWAL BRANCH: extend the existing key in-place ──
  //
  // The renewToken pointed at this key. Don't create a new one —
  // bump its expiresAt forward by planDays (anchored to the LATER
  // of "now" and the key's current expiresAt so an early renewal
  // adds to the remaining time instead of throwing it away), swap
  // in the new subscriptionId, append to billingHistory if present,
  // and clear any reminder-sent stamps so the next cron cycle
  // works fresh.
  if (renewKeyId) {
    const existingRef = db.collection('productKeys').doc(renewKeyId)
    const existingSnap = await existingRef.get()
    if (!existingSnap.exists) {
      // The key vanished between the renewToken being minted and
      // the payment landing. Fall through to "create new key"
      // (logged for forensics).
      console.warn(
        `[webhook/sale-completed] renewKeyId ${renewKeyId} not found, falling back to create-new`,
      )
      renewKeyId = null
    } else {
      const existing = existingSnap.data() as {
        expiresAt?: string
        subscriptionId?: string
        subscriptionPlanDays?: number
        planDays?: number
        billingHistory?: Array<{ at: string; amount: number; currency: string }>
      }
      // Plan-switch detection: if the existing key was bound to a
      // DIFFERENT subscription, this is either a regular renewal
      // (same plan, new sub created by the renew flow because the
      // old one was cancelled/expired) or a PLAN SWITCH (monthly
      // ↔ yearly). We distinguish by comparing planDays. Both
      // paths still extend the same key in-place; only the email
      // and the old-sub-cancellation behaviour differ.
      const previousSubId = existing.subscriptionId || null
      const previousPlanDays =
        existing.planDays || existing.subscriptionPlanDays || 0
      const isPlanSwitch =
        previousPlanDays > 0 && previousPlanDays !== planDays

      const currentExpMs = existing.expiresAt
        ? Date.parse(existing.expiresAt)
        : 0
      const anchorMs = Math.max(currentExpMs, Date.now())
      // Calendar-aware extension. The anchor is still MAX(current,
      // now) so an early renewal preserves remaining days, but the
      // delta is now a calendar month/year not a 30/365-day literal.
      const newExpiresAt = addCalendarSubscriptionPeriod(
        new Date(anchorMs),
        planDays,
      )
      const billingHistory = Array.isArray(existing.billingHistory)
        ? existing.billingHistory.slice()
        : []
      billingHistory.push({
        at: new Date().toISOString(),
        amount: planPrice,
        currency: planCurrency,
      })

      // ── ORDER MATTERS: update key BEFORE cancelling old sub ──
      //
      // The cancel triggers PayPal to fire a CANCELLED webhook for
      // the previous subscriptionId. handleSubscriptionEnded looks
      // up the key by subscriptionId — and as long as we've already
      // overwritten it with the NEW one, the lookup returns empty
      // and the handler ignores the event (good — we don't want to
      // mark this key as 'cancelled' or send a cancellation email
      // for a sub the buyer didn't choose to cancel).
      //
      // If we cancelled FIRST, the CANCELLED webhook could race in
      // before this update lands and the buyer would receive an
      // unwanted "your subscription was cancelled" email even
      // though they actually just switched plans. Update-first
      // closes that window because by the time PayPal can deliver
      // the cancellation webhook (~hundreds of ms minimum), the
      // key has already been moved off the old subscriptionId.
      await existingRef.update({
        expiresAt: newExpiresAt.toISOString(),
        subscriptionId,
        planId: sub.plan_id,
        subscriptionPrice: planPrice,
        subscriptionCurrency: planCurrency,
        subscriptionPlanDays: planDays,
        planDays,
        subscriptionStatus: 'active',
        subscriptionStartedAt: new Date().toISOString(),
        subscriptionCancelledAt: null,
        // Reset payment-failure stamps. If the buyer was being
        // dunned on the old sub for a card decline, a fresh paid
        // subscription wipes the slate.
        paymentFailedAt: null,
        paymentFailureCount: 0,
        billingHistory,
        // Clear reminder stamps so the next cycle's cron emails
        // fire fresh.
        reminder10dSentAt: null,
        reminder2dSentAt: null,
        reminderSentAt: null,
      })

      // ── Cancel the OLD PayPal subscription, if any ──
      //
      // When a buyer upgrades/downgrades via the in-account
      // "שינוי תוכנית" flow (or re-subscribes while their old
      // sub is somehow still active), the old PayPal subscription
      // would otherwise keep billing them. Without this guard the
      // buyer is double-charged until they manually cancel inside
      // PayPal — bad UX and an unambiguous bug.
      //
      // We only cancel when the IDs differ (a literal renewal that
      // happened to mint the same sub id is a no-op) and we
      // swallow SUBSCRIPTION_STATUS_INVALID, which means the old
      // sub is already cancelled/expired/suspended — exactly the
      // states where cancel-again would error. Any other failure
      // is logged loudly so it shows up in Vercel logs and the
      // operator can manually clean up.
      if (previousSubId && previousSubId !== subscriptionId) {
        try {
          await paypalCall(
            'POST',
            `/v1/billing/subscriptions/${previousSubId}/cancel`,
            {
              reason: isPlanSwitch
                ? `Replaced by plan switch to ${planDays === 30 ? 'monthly' : 'yearly'}`
                : 'Replaced by new subscription via renewal',
            },
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // SUBSCRIPTION_STATUS_INVALID = already cancelled / expired
          // / suspended — exactly the states we WANT (we just want
          // the old sub to stop billing). RESOURCE_NOT_FOUND = the
          // old sub id doesn't exist on PayPal's side, probably a
          // legacy data issue. Both are harmless; everything else
          // is a real failure worth surfacing in logs.
          if (
            msg.includes('SUBSCRIPTION_STATUS_INVALID') ||
            msg.includes('RESOURCE_NOT_FOUND')
          ) {
            // Old sub already not-active or doesn't exist. Nothing
            // to do.
          } else {
            console.error(
              `[upgrade] failed to cancel prior sub ${previousSubId} (key ${renewKeyId}):`,
              err,
            )
          }
        }
      }
      try {
        if (isPlanSwitch) {
          // Plan-switch path — dedicated email explaining the
          // transition (old → new plan, days carried forward,
          // next charge date) so the buyer doesn't think we
          // double-charged them.
          await sendPlanSwitchEmail({
            to: buyerEmail,
            key: renewKeyId,
            oldPlanDays: previousPlanDays,
            newPlanDays: planDays,
            previousExpiresAt: existing.expiresAt
              ? new Date(existing.expiresAt)
              : null,
            newExpiresAt,
            price: planPrice,
            currency: planCurrency,
            subscriptionId,
          })
        } else {
          await sendSubscriptionWelcomeEmail({
            to: buyerEmail,
            key: renewKeyId,
            planLabel: planDays === 30 ? 'חודש' : 'שנה',
            price: planPrice,
            currency: planCurrency,
            nextBillingAt: newExpiresAt,
            subscriptionId,
          })
        }
      } catch (err) {
        console.error('[webhook] renewal email failed for', renewKeyId, err)
      }
      return {
        ok: true,
        summary: isPlanSwitch
          ? `switched plan for key ${renewKeyId} (${previousPlanDays}d→${planDays}d) via subscription ${subscriptionId} until ${newExpiresAt.toISOString()}`
          : `renewed key ${renewKeyId} via subscription ${subscriptionId} until ${newExpiresAt.toISOString()}`,
      }
    }
  }

  // Referral attribution: copy the buyer's account-level referredBy
  // onto the key so the partner revenue report can sum payments by
  // partner. Resolve the buyer's uid from the auto-redeem hint, or by
  // their email (download-gating means referred buyers have an
  // account). Best-effort — never blocks key creation.
  let keyReferredBy: string | null = null
  try {
    let buyerUid: string | null = linkToUid
    if (!buyerUid && buyerEmail) {
      try {
        const { getAuth } = await import('firebase-admin/auth')
        const rec = await getAuth(getFirebase()).getUserByEmail(buyerEmail)
        buyerUid = rec.uid
      } catch {
        /* no account for this email (guest) — leave unattributed */
      }
    }
    if (buyerUid) {
      const uSnap = await db.collection('users').doc(buyerUid).get()
      const rb = (uSnap.data() as { referredBy?: string } | undefined)
        ?.referredBy
      if (rb) keyReferredBy = rb
    }
  } catch (err) {
    console.warn('[webhook/sale-completed] referral lookup failed:', err)
  }

  const baseKeyDoc = {
    key,
    tier: 'pro',
    expiresAt: initialExpiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    createdBy: `paypal-subscription-${planDays === 30 ? 'monthly' : 'yearly'}`,
    buyerEmail,
    ...(keyReferredBy ? { referredBy: keyReferredBy } : {}),
    subscriptionId,
    planId: sub.plan_id,
    subscriptionPrice: planPrice,
    subscriptionCurrency: planCurrency,
    subscriptionPlanDays: planDays,
    planDays,
    subscriptionStatus: 'active',
    subscriptionStartedAt: new Date().toISOString(),
    // Seed billingHistory with the initial activation payment.
    // PayPal V1 Subscriptions does NOT fire PAYMENT.SALE.COMPLETED
    // for the initial activation charge (only for recurring charges
    // in subsequent cycles), so handleSaleCompleted never runs for
    // this first payment. Without this seed, the annual billing
    // report (sec. 13ב(ב1)) would be short by exactly one charge
    // per subscription. The synthetic `initial-<subId>` eventId is
    // chosen so it can never collide with a real PayPal webhook id
    // (which always start with `WH-`), making this entry safely
    // distinguishable in audits.
    billingHistory: [{
      eventId: `initial-${subscriptionId}`,
      amount: planPrice,
      currency: planCurrency,
      at: new Date().toISOString(),
    }],
  }

  if (linkToUid) {
    // Account-lock: find any other keys this uid has redeemed and
    // null out their redemption pointer. The doc is kept for audit
    // (replacedAt + replacedByKey).
    const priorKeys = await db
      .collection('productKeys')
      .where('redeemedBy', '==', linkToUid)
      .get()
    const replacedAt = new Date().toISOString()
    const replacedPriorKeys: string[] = []
    for (const d of priorKeys.docs) {
      if (d.id === key) continue
      replacedPriorKeys.push(d.id)
      try {
        await d.ref.update({
          redeemedBy: null,
          redeemedByEmail: null,
          replacedAt,
          replacedByKey: key,
        })
      } catch (err) {
        console.warn(
          `[webhook/sale-completed] failed to unlink prior key ${d.id}:`,
          err,
        )
      }
    }
    await db.collection('productKeys').doc(key).set({
      ...baseKeyDoc,
      redeemedBy: linkToUid,
      redeemedByEmail: buyerEmail,
      redeemedAt: new Date().toISOString(),
      autoRedeemedFromWebhook: true,
      replacedPriorKeys,
    })
  } else {
    await db.collection('productKeys').doc(key).set({
      ...baseKeyDoc,
      redeemedBy: null,
      redeemedByEmail: null,
      redeemedAt: null,
    })
  }
  // Welcome email — always sent, even when the key was auto-
  // redeemed in the linkToUid branch above. Backup safety net so
  // the buyer has the key value in their inbox if anything goes
  // wrong with the auto-bind (or if they want to add the same
  // license to a second machine some day).
  try {
    await sendSubscriptionWelcomeEmail({
      to: buyerEmail,
      key,
      planLabel: planDays === 30 ? 'חודש' : 'שנה',
      price: planPrice,
      currency: planCurrency,
      nextBillingAt: initialExpiresAt,
      subscriptionId,
    })
  } catch (err) {
    console.error('[webhook] welcome email failed for', key, err)
  }
  // Pro-activation email — only when the key was actually bound
  // to an account (linkToUid path). Guest purchases don't fire it
  // here; the manual redemption in /api/keys/redeem will send it
  // when the user pastes the key inside the app.
  if (linkToUid) {
    try {
      await sendProActivatedEmail({
        to: buyerEmail,
        key,
        validUntil: initialExpiresAt,
      })
    } catch (err) {
      console.error('[webhook] pro-activated email failed for', key, err)
    }
  }
  return {
    ok: true,
    summary: `created key ${key} for subscription ${subscriptionId}`,
  }
}

async function handleSubscriptionEnded(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id: string } | undefined
  if (!resource?.id) return { ok: false, summary: 'no subscription id' }
  const db = getDb()
  const keys = await db
    .collection('productKeys')
    .where('subscriptionId', '==', resource.id)
    .limit(1)
    .get()
  if (keys.empty) {
    return { ok: true, summary: `no key for ${resource.id} — ignored` }
  }
  const keyDocSnap = keys.docs[0]
  const keyData = keyDocSnap.data() as KeyDoc
  await keyDocSnap.ref.update({
    subscriptionStatus:
      event.event_type === 'BILLING.SUBSCRIPTION.EXPIRED'
        ? 'expired'
        : 'cancelled',
    subscriptionCancelledAt: new Date().toISOString(),
  })

  // Confirmation email ONLY for genuine PayPal-direct cancellations
  // — EXPIRED means the subscription's natural end-of-life (e.g. a
  // one-year sub completed its term), where we either already sent
  // expiry reminders or the user explicitly chose not to renew.
  // CANCELLED is the "user pulled the plug from inside PayPal
  // directly" path; they didn't see our /account UI fire, so we owe
  // them an acknowledgement just like the in-account cancel flow.
  //
  // Dedup guard: when the cancellation came through OUR /account UI,
  // handleCancel has already marked the key as `cancelled` AND sent
  // the email synchronously, then PayPal fires this webhook a few
  // seconds later. Without this guard, the buyer receives the same
  // legal-acknowledgement email twice (once from handleCancel, once
  // from here). We read keyData BEFORE the status update above is
  // visible to subsequent reads — so if status was already
  // `cancelled` at the time of this snapshot, the in-account path
  // already handled the email and we must NOT re-send.
  if (
    event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' &&
    keyData.subscriptionStatus !== 'cancelled'
  ) {
    const recipient =
      keyData.buyerEmail || keyData.redeemedByEmail || null
    if (recipient) {
      const validUntilDate = keyData.expiresAt
        ? new Date(keyData.expiresAt)
        : null
      void sendCancellationEmail({
        to: recipient,
        validUntil: validUntilDate,
        reason: null,
        cancelledFrom: 'paypal-direct',
      }).catch((err) => {
        console.error(
          '[webhook] cancellation email failed for',
          keyDocSnap.id,
          err,
        )
      })
    }
  }

  return {
    ok: true,
    summary: `marked ${keyDocSnap.id} as ${event.event_type}`,
  }
}

async function handleSubscriptionSuspended(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id: string } | undefined
  if (!resource?.id) return { ok: false, summary: 'no subscription id' }
  const db = getDb()
  const keys = await db
    .collection('productKeys')
    .where('subscriptionId', '==', resource.id)
    .limit(1)
    .get()
  if (keys.empty) return { ok: true, summary: `no key for ${resource.id}` }
  await keys.docs[0].ref.update({ subscriptionStatus: 'past_due' })
  return { ok: true, summary: `marked ${keys.docs[0].id} as past_due` }
}

/**
 * BILLING.SUBSCRIPTION.PAYMENT.FAILED — fired by PayPal when an
 * attempted recurring charge fails (declined card, insufficient
 * funds, expired card, etc.). PayPal will retry on its own retry
 * schedule (typically 3 attempts over ~5 days) before transitioning
 * the subscription to SUSPENDED.
 *
 * We notify the buyer immediately so they have time to update their
 * payment method before PayPal exhausts retries — losing access is
 * a bad customer experience, especially when fixable. Also stamp
 * the key with paymentFailedAt + paymentFailureCount so the admin
 * panel can surface "at risk" subscriptions, and emit a loud
 * console.error so Vercel logs are searchable for forensics.
 *
 * Best-effort email — a Gmail failure shouldn't fail the webhook
 * (PayPal would retry, double-noting the failure in our event log).
 */
async function handlePaymentFailed(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id?: string } | undefined
  const subscriptionId = resource?.id
  if (!subscriptionId) {
    return { ok: true, summary: 'payment-failed without subscription id — ignored' }
  }
  const db = getDb()
  const keys = await db
    .collection('productKeys')
    .where('subscriptionId', '==', subscriptionId)
    .limit(1)
    .get()
  if (keys.empty) {
    console.error(
      '[webhook] PAYMENT.FAILED for unknown subscription',
      subscriptionId,
    )
    return {
      ok: true,
      summary: `payment-failed for unknown subscription ${subscriptionId} — logged only`,
    }
  }
  const keyDoc = keys.docs[0]
  const keyData = keyDoc.data() as KeyDoc
  const recipient =
    keyData.buyerEmail || keyData.redeemedByEmail || null

  // Stamp the key for admin visibility. paymentFailureCount lets
  // the admin distinguish "blip" (1 attempt) from "they're really
  // not coming back" (3+). FieldValue.increment handles concurrent
  // updates cleanly if PayPal fires multiple FAILED events in
  // sequence before we can process them.
  await keyDoc.ref.update({
    paymentFailedAt: new Date().toISOString(),
    paymentFailureCount: FieldValue.increment(1),
  })

  console.error(
    '[webhook] PAYMENT.FAILED — buyer should update card —',
    'sub:', subscriptionId,
    'key:', keyDoc.id,
    'buyer:', recipient,
  )

  if (recipient) {
    void sendPaymentFailedEmail({
      to: recipient,
      validUntil: keyData.expiresAt ? new Date(keyData.expiresAt) : null,
      subscriptionId,
    }).catch((err) => {
      console.error(
        '[webhook] payment-failed email failed for',
        keyDoc.id,
        err,
      )
    })
  }

  return {
    ok: true,
    summary: `notified buyer about payment failure on ${subscriptionId}`,
  }
}

/* ─────────────────────────────────────────────────────────────
 *  Create subscription (action=create-subscription)
 *
 *  Server picks the locked-in plan_id based on live pricing.
 *  Client sends ONLY `plan` and `email` — never a price or plan_id.
 * ───────────────────────────────────────────────────────────── */

async function handleCreateSubscription(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    plan?: 'monthly' | 'yearly'
    email?: string
    sessionToken?: string
    renewToken?: string
  }
  const plan = body.plan
  let email = (body.email || '').trim().toLowerCase()
  // Optional: the buyer arrived from /account already signed-in.
  // - sessionToken: webhook auto-redeems the NEW key to this uid
  //   (used for fresh-purchase-from-account, where user has no
  //    prior key).
  // - renewToken: webhook EXTENDS the existing key referenced by
  //   the token instead of creating a new one (used by both the
  //   /account "חידוש המנוי שלי" button and the email-link
  //   renewal flow).
  // Either may be present (renewToken implies a uid via its
  // claims), neither, or both. Both invalid → guest purchase.
  //
  // On the renewal/switch path the client only knows the *masked*
  // email (we deliberately don't expose the real one to JS via the
  // renew-info endpoint). So if the client didn't send an email
  // but a valid token is present, we recover the real email
  // server-side from session claims or the productKey document.
  let linkToUid: string | null = null
  let renewKeyId: string | null = null
  if (body.sessionToken) {
    const claims = verifySessionToken(body.sessionToken.trim())
    if (claims) {
      if (!email || claims.email.toLowerCase() === email) {
        linkToUid = claims.uid
        if (!email) email = claims.email.toLowerCase()
      }
    }
  }
  if (body.renewToken) {
    // The renew token is JWT-shaped; verify in-line rather than
    // importing the helper from renew.ts (cross-function imports
    // have been flaky in this codebase). Same HMAC scheme + the
    // shared RENEW_TOKEN_SECRET means tokens minted by either
    // file verify identically.
    const claims = verifyRenewTokenLocal(body.renewToken.trim())
    if (claims) {
      renewKeyId = claims.key
      // The renew token's uid also implies the linkToUid — useful
      // for the email-link renewal flow where there's no session
      // (user clicked from inbox without logging into /account).
      if (!linkToUid) linkToUid = claims.uid
      // Recover the buyer email from the key document if the
      // client didn't supply one (renewal panel never has it). The
      // key's redeemedByEmail was set when the original buyer
      // bound this key — it IS the correct email for billing.
      if (!email) {
        try {
          const keySnap = await getDb()
            .collection('productKeys')
            .doc(claims.key)
            .get()
          const keyData = keySnap.data() as
            | { redeemedByEmail?: string; buyerEmail?: string }
            | undefined
          const recovered =
            keyData?.redeemedByEmail || keyData?.buyerEmail || ''
          if (recovered) email = recovered.trim().toLowerCase()
        } catch (err) {
          console.warn(
            '[paypal/create-subscription] renewToken email lookup failed:',
            err,
          )
        }
      }
    }
  }
  if (plan !== 'monthly' && plan !== 'yearly') {
    return res
      .status(400)
      .json({ ok: false, error: `תוכנית לא חוקית: ${plan || '(ריק)'}` })
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }
  // No rate-limit on this endpoint by design.
  //
  // Earlier versions throttled per-IP (10/h) and per-email (5/h)
  // to defend against subscription-spam attacks. In practice that
  // protection blocked real customers more than it blocked
  // attackers:
  //   - A buyer who fat-fingers their card details + retries a
  //     few times can trip the 5/h email cap and then be told to
  //     "come back in an hour" mid-purchase — guaranteed lost sale.
  //   - Real spam would still create real PayPal subscriptions
  //     (we'd see them as billable activity and could refund),
  //     while every legit buyer the throttle dropped is gone for
  //     good.
  // PayPal themselves throttle subscription creation at the
  // account level and fraud-score risky cards, so the unbounded
  // path here is fenced by their infrastructure too.
  // STRICT: never charge a hardcoded fallback price. The amount must
  // come net from the DB; if we can't confirm it (doc missing /
  // Firestore down), refuse the purchase rather than create a PayPal
  // plan at the default 9/60 — a charge at the wrong price is worse
  // than a blocked sale the buyer can retry later.
  const pricing = await loadCurrentPricingStrict()
  if (!pricing) {
    return res
      .status(503)
      .json({ ok: false, error: 'המחיר אינו זמין כרגע, נסו שוב מאוחר יותר' })
  }
  const usingSale = pricing[plan].sale != null
  const lockedPrice = usingSale ? pricing[plan].sale! : pricing[plan].regular
  const plans = await syncPlansForPricing(pricing)
  const planId =
    plan === 'monthly'
      ? usingSale
        ? plans.monthlySalePlanId
        : plans.monthlyRegularPlanId
      : usingSale
        ? plans.yearlySalePlanId
        : plans.yearlyRegularPlanId
  if (!planId) {
    return res
      .status(500)
      .json({ ok: false, error: 'תצורת תוכנית לא תקינה — נסה שוב' })
  }
  const subscription = await paypalCall<{
    id: string
    status: string
    links: Array<{ rel: string; href: string; method: string }>
  }>('POST', '/v1/billing/subscriptions', {
    plan_id: planId,
    subscriber: { email_address: email },
    application_context: {
      brand_name: 'ניהול הורדות פלוס',
      locale: 'he-IL',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'SUBSCRIBE_NOW',
      payment_method: {
        // Tried 'UNRESTRICTED' here to see if it would soften the
        // "create PayPal account" toggle on the hosted checkout
        // page. PayPal rejected the value as INVALID_PARAMETER_VALUE
        // (the field's enum is documented as PAYPAL | PAYPAL_CREDIT
        // only for v1 subscriptions). Reverted. The account-upsell
        // toggle is PayPal-controlled with no SDK escape hatch on
        // the subscription path — see the conversation log.
        payer_selected: 'PAYPAL',
        payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED',
      },
      return_url: `${WEBSITE_BASE}/buy?subscribed=1`,
      cancel_url: `${WEBSITE_BASE}/buy?cancelled=1`,
    },
  })
  const approval = subscription.links.find((l) => l.rel === 'approve')
  if (!approval) {
    return res
      .status(500)
      .json({ ok: false, error: 'PayPal לא החזיר קישור אישור' })
  }
  const db = getDb()
  await db.collection('pendingSubscriptions').doc(subscription.id).set({
    subscriptionId: subscription.id,
    plan,
    email,
    planId,
    lockedPrice,
    currency: pricing.currency,
    createdAt: new Date().toISOString(),
    status: subscription.status,
    // null = guest purchase, redeem manually inside the app.
    // string = signed-in buyer; webhook auto-redeems to this uid.
    linkToUid,
    // null = create a new key. string = extend this existing key
    // instead. Used by the /account "חידוש המנוי שלי" button + the
    // email-link renewal flow so the SAME key's expiry rolls
    // forward (instead of the user ending up with two keys, an
    // expired one and a fresh one).
    renewKeyId,
  })
  return res.status(200).json({
    ok: true,
    approvalUrl: approval.href,
    subscriptionId: subscription.id,
  })
}

/* ─────────────────────────────────────────────────────────────
 *  Session (action=session) — login + initial subscription list
 * ───────────────────────────────────────────────────────────── */

async function handleSession(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { email?: string; password?: string }
  const email = (body.email || '').trim().toLowerCase()
  const password = body.password || ''
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'יש להזין אימייל וסיסמה' })
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY
  if (!apiKey) {
    return res
      .status(500)
      .json({ ok: false, error: 'שירות ההתחברות לא מוגדר. פנו לתמיכה.' })
  }
  let uid: string
  try {
    const authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: false }),
      },
    )
    const auth = (await authRes.json()) as IdentityResponse
    if (!authRes.ok || !auth.localId) {
      return res
        .status(401)
        .json({ ok: false, error: mapAuthError(auth.error?.message) })
    }
    uid = auth.localId
  } catch (err) {
    console.error('session auth failed', err)
    return res
      .status(502)
      .json({ ok: false, error: 'שירות ההתחברות אינו זמין כרגע. נסו שוב.' })
  }
  // Email-verified gate. Otherwise an attacker who registered
  // victim@example.com directly via Firebase REST (with their own
  // password) could log in here and SSO-in to all of victim's
  // subscriptions tied to that buyerEmail. signInWithPassword
  // doesn't return emailVerified in the response, so we look it
  // up with the Admin SDK.
  if (emailVerificationEnforced()) {
    try {
      const { getAuth } = await import('firebase-admin/auth')
      const userRecord = await getAuth(getFirebase()).getUser(uid)
      if (!userRecord.emailVerified) {
        return res.status(403).json({
          ok: false,
          error: 'יש לאמת את כתובת המייל לפני התחברות. הירשם מחדש בתוכנה.',
        })
      }
    } catch (err) {
      console.error('[paypal/session] email-verified lookup failed', err)
      return res
        .status(502)
        .json({ ok: false, error: 'שירות ההתחברות אינו זמין כרגע. נסו שוב.' })
    }
  }
  return await respondWithSession(res, { uid, email })
}

/* ─────────────────────────────────────────────────────────────
 *  Restore-session (action=restore-session) — sessionStorage rehydrate
 *
 *  After a buyer signs in on /account OR on /buy ("כבר יש לי
 *  מנוי"), the frontend stashes the session token in
 *  sessionStorage so subsequent page loads within the same tab
 *  don't have to re-prompt for a password. On mount, the page
 *  calls THIS endpoint with the stored token: we verify the JWT
 *  (HMAC + exp claim), and if it's still valid we replay the
 *  same {profile, subscriptions, token} response that handleSession
 *  produces. If the token is expired or signature-invalid, we
 *  401 — the frontend clears its sessionStorage and falls through
 *  to the login form.
 *
 *  Why a separate endpoint (vs reusing handleSession): handleSession
 *  requires email+password and re-authenticates against Firebase.
 *  We don't have the password here (deliberately — we never store
 *  it client-side), only the previously-issued session token. And
 *  there's no reason to re-hit Firebase Auth — the token alone
 *  proves the user authenticated successfully within the last
 *  SESSION_TTL_SECONDS, which is all the trust we need.
 *
 *  Response: identical shape to action=session for client symmetry
 *  (the AccountPage uses the same setToken/setProfile/setSubs
 *  setters whether the session came from a fresh login or a
 *  restore).
 * ───────────────────────────────────────────────────────────── */
async function handleRestoreSession(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { token?: string }
  const token = (body.token || '').trim()
  if (!token) {
    return res.status(400).json({ ok: false, error: 'missing token' })
  }
  const claims = verifySessionToken(token)
  if (!claims) {
    // Expired or tampered. Frontend interprets 401 as "clear
    // sessionStorage and show login form" — no error message
    // needed because the user didn't actively do anything.
    return res.status(401).json({ ok: false, error: 'session expired' })
  }
  return await respondWithSession(res, {
    uid: claims.uid,
    email: claims.email,
  })
}

/* ─────────────────────────────────────────────────────────────
 *  SSO (action=sso) — auto-login from desktop app
 *
 *  The desktop app already has a logged-in Firebase user. Instead
 *  of forcing the user to type their password again on the web
 *  /account page, the app fetches a fresh Firebase ID token and
 *  passes it here. We verify the token against Firebase (the cheap,
 *  cryptographically-safe equivalent of a password) and mint the
 *  same session JWT the password-based handleSession would issue.
 *
 *  Why ID-token-as-auth is safe here:
 *    - Firebase ID tokens are short-lived (1h) and signed by
 *      Google's keys; only Firebase can mint a valid one for a
 *      given uid. Anyone with a fresh ID token already controls
 *      that account.
 *    - The token is transferred in the URL fragment (after `#`),
 *      which the browser NEVER sends to servers in fetch requests.
 *      The website JS reads it and immediately strips it from the
 *      URL via history.replaceState before any other navigation.
 *    - We only return a session for the matching uid — no token
 *      grants admin powers or access to other users' data.
 *
 *  Request body: { idToken: string }
 *  Response: identical shape to action=session
 * ───────────────────────────────────────────────────────────── */
async function handleSso(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { idToken?: string }
  const idToken = (body.idToken || '').trim()
  if (!idToken) {
    return res.status(400).json({ ok: false, error: 'missing id token' })
  }
  let uid: string
  let email: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken, true)
    uid = decoded.uid
    email = (decoded.email || '').toLowerCase()
    if (!email) {
      return res
        .status(400)
        .json({ ok: false, error: 'id token has no email claim' })
    }
    // Email-verified gate. Without this, anyone could register
    // `victim@example.com` directly via the Firebase REST API
    // (no need to actually own the inbox), and then SSO-in to
    // surface every subscription on the system tied to that
    // buyerEmail — including the ability to cancel them. The
    // sign-up flow goes through /api/paypal?action=signup-verify
    // -code which creates users with emailVerified=true; the
    // one-shot migration grandfathers in pre-existing accounts.
    if (emailVerificationEnforced() && !decoded.email_verified) {
      return res.status(403).json({
        ok: false,
        error: 'יש לאמת את כתובת המייל לפני התחברות. הירשם מחדש בתוכנה.',
      })
    }
  } catch (err) {
    console.error('[paypal/sso] token verification failed', err)
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }
  return await respondWithSession(res, { uid, email })
}

interface SubscriptionSummary {
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

interface ProfileSummary {
  email: string
  plan: 'admin' | 'pro' | 'free'
  planLabel: string
  keyLast8: string | null
  validUntil: string | null
  hasActiveSubscription: boolean
  /** Current state of the marketing email opt-in flag in
   *  users/{uid}. The /account page surfaces this as a toggle so
   *  the user can flip it from inside the app, satisfying the
   *  "you can unsubscribe at any time" promise in the signup
   *  checkbox text. */
  marketingOptIn: boolean
}

/**
 * Shared post-auth response for session + sso. Loads the user's
 * subscriptions, computes a profile summary (so the website can
 * render the account page without a second roundtrip), and signs
 * a session JWT.
 *
 * Wrapped in try/catch because earlier the Firestore queries here
 * were crashing the function at the Node runtime layer (escaping
 * the dispatcher try/catch); keep the defensive layer so a future
 * regression still surfaces as a JSON 500 the client can render.
 */
async function respondWithSession(
  res: VercelResponse,
  args: { uid: string; email: string },
) {
  const { uid, email } = args
  try {
    const db = getDb()
    // `.limit(50)` is a runaway guard — a real user has 1-3 keys
    // (one active + a couple of historical/replaced ones). 50 is far
    // above any legitimate count, so no real account is affected; it
    // just stops this scan from reading an unbounded number of docs
    // if something ever goes wrong. Single equality + limit → no
    // composite index needed, can't break the query.
    const ownedSnap = await db
      .collection('productKeys')
      .where('redeemedBy', '==', uid)
      .limit(50)
      .get()
    const subs: SubscriptionSummary[] = []
    const ownedKeyDocs: KeyDoc[] = []

    function pushSub(k: KeyDoc) {
      if (!k.subscriptionId) return
      if (subs.some((s) => s.subscriptionId === k.subscriptionId)) return
      const days = typeof k.subscriptionPlanDays === 'number' ? k.subscriptionPlanDays : 30
      subs.push({
        key: typeof k.key === 'string' ? k.key : '',
        subscriptionId: k.subscriptionId,
        // Normalize to UPPERCASE for the wire. Backend writes
        // 'active' / 'cancelled' / 'past_due' / 'expired' to
        // Firestore (lowercase) but PayPal's own API + the
        // frontend's status checks (sub.status === 'ACTIVE',
        // 'CANCELLED', 'SUSPENDED') expect UPPERCASE. Without
        // this the AccountPage's cancel button never appears
        // because isActive = ('active' === 'ACTIVE') = false.
        // Historical Firestore data stays as-is; only the API
        // response is normalized.
        status:
          typeof k.subscriptionStatus === 'string'
            ? k.subscriptionStatus.toUpperCase()
            : 'UNKNOWN',
        expiresAt: typeof k.expiresAt === 'string' ? k.expiresAt : null,
        startedAt: typeof k.subscriptionStartedAt === 'string' ? k.subscriptionStartedAt : null,
        cancelledAt:
          typeof k.subscriptionCancelledAt === 'string' ? k.subscriptionCancelledAt : null,
        price: typeof k.subscriptionPrice === 'number' ? k.subscriptionPrice : null,
        currency: typeof k.subscriptionCurrency === 'string' ? k.subscriptionCurrency : 'ILS',
        planDays: days,
        cycleLabel: days >= 300 ? 'שנתי' : 'חודשי',
      })
    }

    for (const doc of ownedSnap.docs) {
      const k = doc.data() as KeyDoc
      ownedKeyDocs.push(k)
      pushSub(k)
    }

    // Buyer-only subscriptions (user subscribed but hasn't redeemed
    // the key in the app yet) — query by buyerEmail and filter in
    // JS rather than using a compound `.where(..., '==', null)`
    // query (which crashed the runtime on some firebase-admin
    // versions).
    const buyerSnap = await db
      .collection('productKeys')
      .where('buyerEmail', '==', email)
      .limit(50)
      .get()
    for (const doc of buyerSnap.docs) {
      const k = doc.data() as KeyDoc
      if (k.redeemedBy && k.redeemedBy !== uid) continue
      pushSub(k)
    }

    subs.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))

    // Compute profile summary so the website /account page can
    // render the user card without a second backend roundtrip.
    const isAdmin = ADMIN_EMAILS.includes(email)
    // Pick the longest-lived owned key for the "active key" display.
    // Active = expiresAt in the future. Falls back to most-recently-
    // created if no active keys (so user sees their last key, e.g.
    // expired).
    let primaryKey: KeyDoc | null = null
    for (const k of ownedKeyDocs) {
      const expMs = typeof k.expiresAt === 'string' ? Date.parse(k.expiresAt) : 0
      if (!primaryKey) {
        primaryKey = k
        continue
      }
      const currentExpMs =
        typeof primaryKey.expiresAt === 'string' ? Date.parse(primaryKey.expiresAt) : 0
      if (expMs > currentExpMs) primaryKey = k
    }
    const primaryKeyStr =
      primaryKey && typeof primaryKey.key === 'string' ? primaryKey.key : null
    const primaryExpiresAt =
      primaryKey && typeof primaryKey.expiresAt === 'string'
        ? primaryKey.expiresAt
        : null
    // Use the grace-aware entitlement check rather than a raw
    // expiresAt > now comparison. This means a buyer whose key
    // expired in the last 24h but whose subscriptionStatus is
    // still 'active' (PayPal in retry, or webhook delayed) keeps
    // their Pro badge here — matches what the desktop app and
    // routing engine will see too.
    const primaryIsActive = isProEntitlementActive({
      expiresAt: primaryExpiresAt,
      subscriptionStatus:
        typeof primaryKey?.subscriptionStatus === 'string'
          ? primaryKey.subscriptionStatus
          : null,
    })
    const hasActiveSub = subs.some(
      (s) => s.status === 'ACTIVE' || s.status === 'APPROVAL_PENDING',
    )

    // Read marketing-opt-in from the user doc. Best-effort: if the
    // doc is missing or the field isn't there, default false (the
    // safe default per Israeli תקשורת sec. 30א — never assume opt-in).
    let marketingOptIn = false
    try {
      const userSnap = await db.collection('users').doc(uid).get()
      if (userSnap.exists) {
        const d = userSnap.data() as { marketingOptIn?: unknown }
        marketingOptIn = d.marketingOptIn === true
      }
    } catch (err) {
      console.warn('[paypal/session] marketingOptIn lookup failed:', err)
    }

    const profile: ProfileSummary = {
      email,
      plan: isAdmin ? 'admin' : primaryIsActive || hasActiveSub ? 'pro' : 'free',
      planLabel: isAdmin ? 'Admin' : primaryIsActive || hasActiveSub ? 'Pro' : 'חינם',
      keyLast8: primaryKeyStr ? primaryKeyStr.slice(-8) : null,
      validUntil: primaryExpiresAt,
      hasActiveSubscription: hasActiveSub,
      marketingOptIn,
    }

    const token = signSessionToken({
      uid,
      email,
      subscriptionIds: subs.map((s) => s.subscriptionId),
    })
    return res
      .status(200)
      .json({ ok: true, token, email, profile, subscriptions: subs })
  } catch (err) {
    console.error('[paypal/session] post-auth failure:', err)
    const message =
      err instanceof Error ? err.message : 'שגיאה בלתי צפויה בטעינת המנויים'
    return res.status(500).json({ ok: false, error: message })
  }
}

/* ─────────────────────────────────────────────────────────────
 *  Status (action=status) — refresh subscriptions for an existing session
 * ───────────────────────────────────────────────────────────── */

async function handleStatus(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { token?: string }
  const token = (body.token || '').trim()
  if (!token) return res.status(400).json({ ok: false, error: 'חסר סשן' })
  const claims = verifySessionToken(token)
  if (!claims) {
    return res
      .status(401)
      .json({ ok: false, error: 'הסשן פג. התחבר שוב מדף הניהול.' })
  }
  if (claims.subscriptionIds.length === 0) {
    return res
      .status(200)
      .json({ ok: true, email: claims.email, subscriptions: [] })
  }
  const db = getDb()
  const snap = await db
    .collection('productKeys')
    .where('subscriptionId', 'in', claims.subscriptionIds.slice(0, 30))
    .get()
  const subs = snap.docs.map((doc) => {
    const k = doc.data() as KeyDoc
    return {
      key: k.key || '',
      subscriptionId: k.subscriptionId || '',
      status: k.subscriptionStatus || 'unknown',
      expiresAt: k.expiresAt || null,
      startedAt: k.subscriptionStartedAt || null,
      cancelledAt: k.subscriptionCancelledAt || null,
      price: k.subscriptionPrice ?? null,
      currency: k.subscriptionCurrency || 'ILS',
      planDays: k.subscriptionPlanDays || 30,
      cycleLabel: (k.subscriptionPlanDays || 30) === 30 ? 'חודשי' : 'שנתי',
    }
  })
  return res
    .status(200)
    .json({ ok: true, email: claims.email, subscriptions: subs })
}

/* ─────────────────────────────────────────────────────────────
 *  Cancel (action=cancel) — user cancels their subscription
 * ───────────────────────────────────────────────────────────── */

async function handleCancel(req: VercelRequest, res: VercelResponse) {
  const body = req.body as {
    token?: string
    subscriptionId?: string
    reason?: string
  }
  const token = (body.token || '').trim()
  const subscriptionId = (body.subscriptionId || '').trim()
  const reason =
    (body.reason || '').slice(0, MAX_REASON_LENGTH).trim() ||
    'User cancelled via dmplus.net/account'
  if (!token || !subscriptionId) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטי בקשה' })
  }
  const claims = verifySessionToken(token)
  if (!claims) {
    return res
      .status(401)
      .json({ ok: false, error: 'הסשן פג. חזור לדף הניהול והתחבר שוב.' })
  }
  if (!claims.subscriptionIds.includes(subscriptionId)) {
    return res
      .status(403)
      .json({ ok: false, error: 'אין הרשאה לבטל את המנוי הזה.' })
  }
  const db = getDb()
  const snap = await db
    .collection('productKeys')
    .where('subscriptionId', '==', subscriptionId)
    .limit(1)
    .get()
  if (snap.empty) {
    return res.status(404).json({ ok: false, error: 'מנוי לא נמצא' })
  }
  const keyDoc = snap.docs[0]
  const key = keyDoc.data() as KeyDoc
  const ownerMatches =
    (key.redeemedBy && key.redeemedBy === claims.uid) ||
    (key.buyerEmail &&
      key.buyerEmail.toLowerCase() === claims.email.toLowerCase())
  if (!ownerMatches) {
    return res
      .status(403)
      .json({ ok: false, error: 'המנוי לא שייך לחשבון שלך' })
  }
  if (
    key.subscriptionStatus === 'cancelled' ||
    key.subscriptionStatus === 'expired'
  ) {
    return res.status(200).json({ ok: true, alreadyCancelled: true })
  }
  try {
    await paypalCall(
      'POST',
      `/v1/billing/subscriptions/${subscriptionId}/cancel`,
      { reason },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    if (message.includes('SUBSCRIPTION_STATUS_INVALID')) {
      await keyDoc.ref.update({
        subscriptionStatus: 'cancelled',
        subscriptionCancelledAt: new Date().toISOString(),
        subscriptionCancelReason: reason,
      })
      return res.status(200).json({ ok: true, alreadyCancelled: true })
    }
    return res
      .status(502)
      .json({ ok: false, error: `ביטול דרך PayPal נכשל: ${message}` })
  }
  await keyDoc.ref.update({
    subscriptionStatus: 'cancelled',
    subscriptionCancelledAt: new Date().toISOString(),
    subscriptionCancelReason: reason,
  })

  // Fire confirmation email (legally required per Israeli
  // consumer-protection sec. 14ט(ב)). Best-effort — a mail
  // failure shouldn't reverse the cancellation. The user already
  // got HTTP 200 + sees the cancel succeed in the UI.
  const recipient = key.buyerEmail || key.redeemedByEmail || claims.email
  const validUntilDate = key.expiresAt ? new Date(key.expiresAt) : null
  void sendCancellationEmail({
    to: recipient,
    validUntil: validUntilDate,
    reason,
    cancelledFrom: 'account',
  }).catch((err) => {
    console.error('[paypal/cancel] confirmation email failed:', err)
  })

  return res.status(200).json({ ok: true, alreadyCancelled: false })
}

/* ─────────────────────────────────────────────────────────────
 *  Billing history (action=billing-history) — session-gated
 *
 *  Returns the full PayPal transaction history (charges, refunds,
 *  payouts) for every subscription owned by the session user. The
 *  /account page renders this as a payments table.
 *
 *  Request body: { token, subscriptionId? }
 *    - token: session JWT
 *    - subscriptionId: optional — limit to one subscription. Omit
 *      to get history for ALL of the user's subscriptions.
 *
 *  Response: { ok: true, transactions: [{ subscriptionId, ... }] }
 *
 *  PayPal's /v1/billing/subscriptions/{id}/transactions endpoint
 *  is the source of truth. We default the window to the past 2
 *  years which covers every plausible "show me my history" use
 *  case for a SaaS that just shipped.
 * ───────────────────────────────────────────────────────────── */

interface BillingTransaction {
  subscriptionId: string
  transactionId: string
  status: string
  amountValue: string
  amountCurrency: string
  time: string
  payerEmail: string | null
}

interface PaypalTransactionPayload {
  transactions?: Array<{
    id?: string
    status?: string
    amount_with_breakdown?: {
      gross_amount?: { value?: string; currency_code?: string }
    }
    payer_name?: { given_name?: string; surname?: string }
    payer_email?: string
    time?: string
  }>
}

async function handleBillingHistory(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { token?: string; subscriptionId?: string }
  const claims = body.token ? verifySessionToken(body.token) : null
  if (!claims) {
    return res.status(401).json({ ok: false, error: 'invalid or expired session' })
  }

  // Determine which subscription ids to pull history for. If the
  // caller specified one, verify they own it (claims.subscriptionIds
  // was minted at session time with the full list); otherwise pull
  // history for all owned subscriptions.
  let targetIds: string[]
  if (body.subscriptionId) {
    if (!claims.subscriptionIds.includes(body.subscriptionId)) {
      return res
        .status(403)
        .json({ ok: false, error: 'subscription not owned by session user' })
    }
    targetIds = [body.subscriptionId]
  } else {
    targetIds = claims.subscriptionIds
  }

  if (targetIds.length === 0) {
    return res.status(200).json({ ok: true, transactions: [] })
  }

  // PayPal's transactions endpoint requires explicit start/end
  // time params. Pull a 2-year window — generous enough that no
  // user will ever miss anything, narrow enough to stay fast.
  const end = new Date()
  const start = new Date(end.getTime() - 730 * 24 * 60 * 60 * 1000)
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const transactions: BillingTransaction[] = []
  for (const subId of targetIds) {
    try {
      const payload = await paypalCall<PaypalTransactionPayload>(
        'GET',
        `/v1/billing/subscriptions/${encodeURIComponent(
          subId,
        )}/transactions?start_time=${encodeURIComponent(
          startIso,
        )}&end_time=${encodeURIComponent(endIso)}`,
      )
      for (const t of payload.transactions ?? []) {
        transactions.push({
          subscriptionId: subId,
          transactionId: t.id || '',
          status: t.status || 'unknown',
          amountValue: t.amount_with_breakdown?.gross_amount?.value || '0',
          amountCurrency:
            t.amount_with_breakdown?.gross_amount?.currency_code || 'ILS',
          time: t.time || '',
          payerEmail: t.payer_email || null,
        })
      }
    } catch (err) {
      // Don't fail the whole list if one subscription's history
      // fails to fetch (e.g. PayPal returns 404 for a very old
      // cancelled sub). Log + continue with the rest.
      console.warn(
        `[paypal/billing-history] subscription ${subId} fetch failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Newest first.
  transactions.sort((a, b) => b.time.localeCompare(a.time))
  return res.status(200).json({ ok: true, transactions })
}

/* ─────────────────────────────────────────────────────────────
 *  Sync plans (action=sync-plans) — admin-only
 * ───────────────────────────────────────────────────────────── */

async function handleSyncPlans(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { idToken?: string }
  const idToken = (body.idToken || '').trim()
  if (!idToken) {
    return res.status(400).json({ ok: false, error: 'missing idToken' })
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY
  if (!apiKey) {
    return res
      .status(500)
      .json({ ok: false, error: 'FIREBASE_WEB_API_KEY not set' })
  }
  let email: string
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    )
    const json = (await r.json()) as IdentityResponse
    if (!r.ok || !json.users?.[0]?.email) {
      return res.status(401).json({ ok: false, error: 'invalid id token' })
    }
    email = json.users[0].email.toLowerCase()
  } catch (err) {
    console.error('sync-plans token verify failed', err)
    return res.status(502).json({ ok: false, error: 'token verify failed' })
  }
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ ok: false, error: 'not an admin' })
  }
  const pricing = await loadCurrentPricing()
  // Admin saves always force a backfill+dedupe pass — even when
  // the prices are unchanged. This gives the operator a manual
  // "clean up PayPal" lever: hit save in the admin panel and any
  // duplicate plans (from earlier races, manual creation, etc.)
  // get deactivated and the catalog is rebuilt to match reality.
  const plans = await syncPlansForPricing(pricing, { forceBackfill: true })
  return res.status(200).json({ ok: true, plans })
}

/* ─────────────────────────────────────────────────────────────
 *  Shared utilities
 * ───────────────────────────────────────────────────────────── */

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function b64urlDecode(s: string): Buffer {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64')
}

function tokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  // UTF-8, not hex — see capture.ts for the rationale. tldr:
  // Buffer.from(s,'hex') silently truncates non-hex chars to nothing,
  // which yields an empty HMAC key if the operator set a passphrase.
  return Buffer.from(s, 'utf8')
}

function signSessionToken(args: {
  uid: string
  email: string
  subscriptionIds: string[]
}): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + SESSION_TTL_SECONDS
  const claims: SessionClaims = {
    uid: args.uid,
    email: args.email,
    subscriptionIds: args.subscriptionIds,
    iat,
    exp,
  }
  const header = b64urlEncode(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', use: 'sub-sess' })),
  )
  const payload = b64urlEncode(Buffer.from(JSON.stringify(claims)))
  const sig = b64urlEncode(
    crypto
      .createHmac('sha256', tokenSecret())
      .update(`${header}.${payload}`)
      .digest(),
  )
  return `${header}.${payload}.${sig}`
}

function verifySessionToken(token: string): SessionClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts
    const expected = crypto
      .createHmac('sha256', tokenSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest()
    const actual = b64urlDecode(sigB64)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(
      b64urlDecode(payloadB64).toString('utf8'),
    ) as SessionClaims
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    if (!claims.uid || !claims.email) return null
    if (!Array.isArray(claims.subscriptionIds)) return null
    return claims
  } catch {
    return null
  }
}

function mapAuthError(code: string | undefined): string {
  switch (code) {
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_PASSWORD':
      return 'אימייל או סיסמה שגויים'
    case 'USER_DISABLED':
      return 'החשבון הזה הושבת. פנו לתמיכה.'
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.'
    case 'MISSING_EMAIL':
    case 'INVALID_EMAIL':
      return 'אימייל לא תקין'
    case 'MISSING_PASSWORD':
      return 'חסרה סיסמה'
    default:
      return 'התחברות נכשלה. ודאו שהאימייל והסיסמה נכונים.'
  }
}

function generateKeyString(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const block = () => {
    let s = ''
    for (let i = 0; i < 4; i++) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    return s
  }
  return `${block()}-${block()}-${block()}-${block()}`
}

async function sendSubscriptionWelcomeEmail(args: {
  to: string
  key: string
  planLabel: string
  price: number
  currency: string
  nextBillingAt: Date
  subscriptionId: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const symbol =
    args.currency === 'ILS' ? '₪' : args.currency === 'USD' ? '$' : args.currency
  const nextDate = args.nextBillingAt.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
  const html = renderEmail({
    heading: 'ברוך הבא ל-Pro 🎉',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        המנוי שלך פעיל! מצורף מפתח Pro לתוכנה <strong>ניהול הורדות פלוס</strong>.
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:11px;color:#8B8170;margin-bottom:8px;">מפתח המוצר</div>
        <div dir="ltr" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:22px;color:#D4A574;letter-spacing:0.08em;font-weight:700;">${args.key}</div>
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">פרטי המנוי</h3>
      <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
        <div>• תוכנית: ${args.planLabel} (${args.price} ${symbol})</div>
        <div>• חיוב הבא: ${nextDate}</div>
        <div>• מתחדש אוטומטית עד שתבטל</div>
        <div>• ניהול / ביטול: <a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a></div>
      </div>
      <p style="margin:24px 0 0;font-size:11px;color:#5C5444;">
        מנוי ID: <span dir="ltr">${args.subscriptionId}</span>
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: 'המנוי שלך פעיל — ניהול הורדות פלוס Pro',
    html,
  })
}

/**
 * Plan-switch confirmation email — sent when a buyer moves between
 * monthly ↔ yearly via the /account "שינוי תוכנית" flow. Different
 * from the generic welcome email because it has to address three
 * questions buyers will have:
 *
 *   1. "Was I double-charged?" — No, the old subscription was
 *      auto-cancelled. We say so explicitly.
 *   2. "Did I lose the days I already paid for?" — No, they
 *      carry forward as bonus on top of the new plan. We show the
 *      exact new expiry date so they can see it.
 *   3. "When will the new plan charge next?" — The new plan's
 *      first auto-renewal date (which is `now + planDays` per
 *      PayPal, NOT the key's expiry which has the bonus added).
 *
 * The buyer's key stays the same — they don't need to redeem
 * anything. We surface it anyway as a sanity check (some buyers
 * compare it to what they have inside the desktop app).
 */
async function sendPlanSwitchEmail(args: {
  to: string
  key: string
  oldPlanDays: number
  newPlanDays: number
  /** The key's expiry BEFORE the switch — used to compute the
   *  "carried forward" days. Null only for unusual cases where
   *  the previous key had no expiry stamp. */
  previousExpiresAt: Date | null
  /** The key's expiry AFTER the switch (= max(oldExpiry, now) +
   *  newPlanDays). This is what we show as "your access is valid
   *  until X". */
  newExpiresAt: Date
  price: number
  currency: string
  subscriptionId: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const symbol =
    args.currency === 'ILS' ? '₪' : args.currency === 'USD' ? '$' : args.currency

  const oldPlanLabel = args.oldPlanDays === 30 ? 'חודשי' : 'שנתי'
  const newPlanLabel = args.newPlanDays === 30 ? 'חודשי' : 'שנתי'
  const newPlanLabelLong =
    args.newPlanDays === 30 ? 'מסלול חודשי' : 'מסלול שנתי'
  const newCycleWord = args.newPlanDays === 30 ? 'חודש' : 'שנה'
  const isUpgrade = args.newPlanDays > args.oldPlanDays
  const titleEmoji = isUpgrade ? '⬆️' : '⬇️'

  // Carried-forward days = days that were left on the old plan
  // at switch time. Computed as (previousExpiresAt - now), clamped
  // to >=0 because a switch right after the old plan expired
  // shouldn't show negative days.
  const nowMs = Date.now()
  const carriedDays = args.previousExpiresAt
    ? Math.max(
        0,
        Math.ceil(
          (args.previousExpiresAt.getTime() - nowMs) / (24 * 60 * 60 * 1000),
        ),
      )
    : 0

  const newExpiresStr = args.newExpiresAt.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
  // Next-charge date = now + newPlanDays. PayPal's recurring
  // cycle starts from the moment the new subscription activated,
  // not from when the key happens to expire (the key's date has
  // the carried-forward bonus baked in).
  const nextChargeDate = new Date(nowMs + args.newPlanDays * 86_400_000)
  const nextChargeStr = nextChargeDate.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })

  const html = renderEmail({
    heading: `${titleEmoji} עברת ל${newPlanLabelLong}`,
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 18px;color:#C9BFA8;">
        המעבר ממסלול <strong>${oldPlanLabel}</strong> ל<strong>${newPlanLabel}</strong> בוצע בהצלחה. הנה מה שקרה:
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:18px;margin:0 0 22px;">
        <div style="font-size:13px;line-height:1.85;color:#C9BFA8;">
          <div style="margin-bottom:8px;">
            ✓ <strong>חויבת ב-${args.price} ${symbol}</strong> עבור המסלול ה${newPlanLabel}
          </div>
          <div style="margin-bottom:8px;">
            ✓ <strong>המנוי ה${oldPlanLabel} הקודם בוטל</strong> אוטומטית — לא תחויב עליו שוב
          </div>
          ${
            carriedDays > 0
              ? `<div style="margin-bottom:8px;">
                  ✓ <strong>${carriedDays} ימים</strong> שנותרו לך מהמסלול ה${oldPlanLabel} <strong>נשמרו כבונוס</strong> — נוספים על גבי ה${newCycleWord} החדש
                </div>`
              : ''
          }
        </div>
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">מה התוקף החדש?</h3>
      <div style="background:#2A211A;border:1px solid rgba(212,165,116,0.35);border-radius:8px;padding:16px;margin:0 0 22px;">
        <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">הגישה תקפה עד</div>
        <div style="font-size:20px;color:#D4A574;font-weight:700;">${newExpiresStr}</div>
      </div>
      <h3 style="font-size:14px;margin:0 0 8px;color:#F5EFE6;font-weight:600;">חיוב הבא</h3>
      <div style="font-size:13px;line-height:1.85;margin:0 0 22px;color:#C9BFA8;">
        החיוב הבא יתבצע ב-<strong>${nextChargeStr}</strong> — ${args.price} ${symbol} עבור ה${newCycleWord} הבא. תוכל לבטל בכל עת מ-<a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a>.
      </div>
      <h3 style="font-size:14px;margin:0 0 8px;color:#F5EFE6;font-weight:600;">המפתח שלך</h3>
      <p style="font-size:12px;line-height:1.6;margin:0 0 10px;color:#8B8170;">
        אותו מפתח נשאר — אין צורך להזין משהו חדש בתוכנה.
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:16px;margin:0 0 22px;">
        <div dir="ltr" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:18px;color:#D4A574;letter-spacing:0.08em;font-weight:700;">${args.key}</div>
      </div>
      <p style="margin:0;font-size:11px;color:#5C5444;">
        מנוי ID חדש: <span dir="ltr">${args.subscriptionId}</span>
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: `${titleEmoji} עברת ל${newPlanLabelLong} — ניהול הורדות פלוס`,
    html,
  })
}

/**
 * Confirmation email sent the moment a user transitions from Free
 * → Pro — i.e. the moment a key gets bound to their account for
 * the first time. Two triggers in the codebase:
 *   - Webhook auto-redeem branch (this file) when a logged-in
 *     buyer completes the PayPal flow and the key is created
 *     already-redeemed.
 *   - Manual redemption via /api/keys/redeem (mirrored helper
 *     there) when the user pastes a guest-bought key inside the
 *     desktop app.
 *
 * Different from the welcome email: this one says "your account
 * IS NOW Pro", not "here's the key". Lets the user know the
 * activation actually worked end-to-end even if they didn't open
 * the inbox to fish out a key.
 */
async function sendProActivatedEmail(args: {
  to: string
  key: string
  validUntil: Date | null
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const validUntilStr = args.validUntil
    ? args.validUntil.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Jerusalem',
      })
    : 'ללא תפוגה'
  const keyLast8 = args.key.length >= 8 ? args.key.slice(-8) : args.key
  const html = renderEmail({
    heading: '✓ החשבון שלך עכשיו Pro',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        המפתח הופעל בהצלחה, וכעת יש לך גישה מלאה לכל היכולות של מנוי Pro בתוכנה <strong>ניהול הורדות פלוס</strong>.
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;line-height:1.8;color:#C9BFA8;">
          <div>
            <div style="color:#8B8170;font-size:11px;margin-bottom:4px;">מפתח</div>
            <div dir="ltr" style="font-family:ui-monospace,'SF Mono',monospace;color:#D4A574;font-size:14px;font-weight:600;">…${keyLast8}</div>
          </div>
          <div style="text-align:left;">
            <div style="color:#8B8170;font-size:11px;margin-bottom:4px;">בתוקף עד</div>
            <div style="color:#F5EFE6;font-size:14px;font-weight:600;">${validUntilStr}</div>
          </div>
        </div>
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">מה אפשר עכשיו</h3>
      <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
        <div>• מיון אוטומטי + חוקי ניתוב מותאמים אישית</div>
        <div>• הורדה מסרטוני וידאו ב-MP3 / 1080p / 4K</div>
        <div>• המרת קבצים בין כל הפורמטים</div>
        <div>• דחיסת וידאו לגודל יעד</div>
        <div>• הצעות מחיר עם יועץ AI ופלט PDF</div>
        <div>• ניהול תשלומים והכנסות</div>
        <div>• עדכונים אוטומטיים ותמיכה מועדפת</div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:24px 0 0;color:#8B8170;">
        אפשר לראות את פרטי החשבון ולנהל את המנוי בכל עת ב-
        <a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a>.
      </p>
      <p style="font-size:11px;line-height:1.6;margin:14px 0 0;color:#5C5444;">
        בכל בעיה — תשובה ישירה למייל הזה תגיע לתמיכה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: '✓ החשבון שלך פעיל — ניהול הורדות פלוס Pro',
    html,
  })
}

/**
 * Subscription cancellation confirmation email. Sent two places:
 *   - handleCancel (action=cancel) — user clicked "ביטול המנוי"
 *     on /account.
 *   - handleSubscriptionEnded webhook — user cancelled directly
 *     inside PayPal (e.g. from PayPal account settings) and the
 *     CANCELLED event fired our way.
 *
 * Doubles as the legally-required confirmation under Israeli
 * consumer-protection law sec. 14ט(ב) (acknowledgement of
 * cancellation within 3 business days). Sending immediately on
 * the same call beats that timer comfortably.
 *
 * Best-effort — a mail failure logs but doesn't reverse the
 * cancellation itself.
 */
async function sendCancellationEmail(args: {
  to: string
  validUntil: Date | null
  reason?: string | null
  cancelledFrom: 'account' | 'paypal-direct'
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const validUntilStr = args.validUntil
    ? args.validUntil.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Jerusalem',
      })
    : '—'
  const sourceLine =
    args.cancelledFrom === 'account'
      ? 'הביטול בוצע מתוך דף החשבון באתר.'
      : 'הביטול בוצע ישירות מתוך חשבון PayPal שלך.'
  const html = renderEmail({
    heading: 'המנוי שלך בוטל',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        קיבלנו את בקשת הביטול שלך למנוי <strong>ניהול הורדות פלוס Pro</strong>. ${sourceLine} לא תחויב שוב.
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">הגישה ל-Pro תפעל עד</div>
        <div style="font-size:18px;color:#F5EFE6;font-weight:600;">${validUntilStr}</div>
        <div style="margin-top:10px;font-size:11px;line-height:1.6;color:#8B8170;">
          קיבלת את התקופה ששילמת עליה במלואה. לאחר מכן החשבון יחזור לחינם.
        </div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
        <strong>אין החזר על תקופות ששולמו</strong> — מאחר שמדובר במוצר דיגיטלי שניתן לשימוש מיידי, אין מדיניות החזרים על תקופות שכבר חויבו ושולמו (תואם תנאי השימוש שאישרת בעת הרישום).
      </p>
      <p style="font-size:12px;line-height:1.7;margin:18px 0 0;color:#C9BFA8;">
        משנים את דעתכם? אפשר להירשם מחדש בכל עת ב-
        <a href="${WEBSITE_BASE}/buy" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/buy</a>.
      </p>
      <p style="font-size:11px;line-height:1.6;margin:14px 0 0;color:#5C5444;">
        בכל בעיה — תשובה ישירה למייל הזה תגיע לתמיכה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: 'אישור ביטול מנוי — ניהול הורדות פלוס',
    html,
  })
}

/**
 * Payment-failed notification email. Sent from handlePaymentFailed
 * when PayPal's BILLING.SUBSCRIPTION.PAYMENT.FAILED webhook arrives.
 *
 * Goal: give the buyer time to update their card BEFORE PayPal
 * exhausts its retry schedule and suspends the subscription. PayPal
 * sends its own "payment failed" email too, but a branded one from
 * us is friendlier and links to /account so they can self-serve.
 *
 * We deliberately don't mention how many retries PayPal will run
 * (their schedule changes; we don't want to make a contractual
 * promise about it).
 */
async function sendPaymentFailedEmail(args: {
  to: string
  validUntil: Date | null
  subscriptionId: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const validUntilStr = args.validUntil
    ? args.validUntil.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Jerusalem',
      })
    : '—'
  const html = renderEmail({
    heading: '⚠ התשלום שלך נכשל',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        ניסינו לחייב את אמצעי התשלום שלך לחידוש המנוי ב-<strong>ניהול הורדות פלוס Pro</strong>, אבל החיוב נדחה (כרטיס פג תוקף, יתרה לא מספיקה, או חסום).
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">הגישה ל-Pro פעילה עד</div>
        <div style="font-size:18px;color:#F5EFE6;font-weight:600;">${validUntilStr}</div>
        <div style="margin-top:10px;font-size:11px;line-height:1.6;color:#8B8170;">
          PayPal ינסה שוב באופן אוטומטי. אם גם הניסיון הבא ייכשל — המנוי יושעה והגישה תיפסק.
        </div>
      </div>
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        כדי להמשיך ברצף, עדכן את אמצעי התשלום ישירות ב-PayPal:
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
        <tr><td align="center">
          <a href="https://www.paypal.com/myaccount/autopay/" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">עדכון אמצעי תשלום ב-PayPal</a>
        </td></tr>
      </table>
      <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
        אפשר גם לראות את סטטוס המנוי ולנהל אותו דרך
        <a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a>.
      </p>
      <p style="font-size:11px;line-height:1.6;margin:18px 0 0;color:#5C5444;">
        בעיה? תשובה למייל הזה תגיע ישירות לתמיכה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: '⚠ עדכון אמצעי תשלום נדרש — ניהול הורדות פלוס',
    html,
  })
}

/* ─────────────────────────────────────────────────────────────
 *  Signup verification flow (request-code / verify-code)
 *
 *  Replaces the old "create Firebase user immediately on signup"
 *  flow with a two-step email-code verification. The attacker
 *  can't register `victim@example.com` and impersonate them
 *  through the SSO / session endpoints if they can't read the
 *  verification email.
 *
 *  Flow:
 *    1. Desktop calls signup-request-code with {email}
 *       → backend generates 6-digit code, stores in
 *         emailVerifications/{email_sanitized} with 15-min TTL,
 *         sends email via Gmail SMTP.
 *    2. Desktop shows "enter code" UI to the user.
 *    3. Desktop calls signup-verify-code with {email, code, password}
 *       → backend validates code, creates Firebase Auth user via
 *         Admin SDK with emailVerified=true, deletes the code doc.
 *    4. Desktop signs in via the normal signInWithEmailAndPassword
 *       flow with the credentials the user just provided.
 *
 *  Security:
 *    - Codes are 6 random digits, single-use, 15-min TTL.
 *    - Code lookup is by email — there's no enumeration risk
 *      (the email is supplied by the same caller who got the code).
 *    - Attempts are rate-limited at 5/hour/email.
 *    - Codes are stored hashed (SHA-256) — leaking the
 *      emailVerifications collection doesn't reveal valid codes.
 * ───────────────────────────────────────────────────────────── */

function sanitizeEmailKey(email: string): string {
  return email.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '_').slice(0, 100)
}

function hashCode(code: string, salt: string): string {
  return crypto
    .createHmac('sha256', salt)
    .update(code)
    .digest('hex')
}

async function handleSignupRequestCode(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { email?: string }
  const email = (body.email || '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }

  // Provider whitelist (defense-in-depth — the desktop client
  // checks this too, but a tampered client could bypass JS). Done
  // before rate-limit so legitimate users who picked a non-allowed
  // provider get the real reason instantly, instead of being
  // throttled into a generic 429 after a few attempts.
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({
      ok: false,
      error: EMAIL_DOMAIN_REJECTION_MESSAGE,
    })
  }

  // Rate limit so an attacker can't spam Gmail SMTP quota or use
  // us as a free email-blast service. 5 codes per hour per email
  // is more than enough for a legit user who keeps mistyping their
  // address.
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    'unknown'
  const allowed = await Promise.all([
    tryRateLimit(`signup-code_email_${sanitizeEmailKey(email)}`, 5, 60 * 60),
    tryRateLimit(`signup-code_ip_${ip.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60)}`, 30, 60 * 60),
  ])
  if (!allowed.every(Boolean)) {
    return res.status(429).json({
      ok: false,
      error: 'יותר מדי בקשות. נסה שוב מאוחר יותר.',
    })
  }

  // Reject if the email is already a registered Firebase user.
  // We DO leak existence here, but only to people who provide a
  // valid email — the rate limit above caps enumeration.
  try {
    const { getAuth } = await import('firebase-admin/auth')
    await getAuth(getFirebase()).getUserByEmail(email)
    return res
      .status(409)
      .json({ ok: false, error: 'כתובת המייל כבר רשומה. התחבר עם הסיסמה שלך.' })
  } catch (err) {
    // The Admin SDK throws auth/user-not-found here — which is the
    // happy path for signup. Any OTHER error (network etc.) should
    // bubble; we don't want to send a code if we couldn't verify
    // uniqueness.
    const code = (err as { code?: string }).code
    if (code !== 'auth/user-not-found') {
      console.error('[paypal/signup-request-code] getUserByEmail failed:', err)
      return res
        .status(500)
        .json({ ok: false, error: 'שירות לא זמין כרגע. נסה שוב.' })
    }
  }

  // Generate a 6-digit code. Math.random is fine here — the
  // keyspace is intentionally narrow (10^6) so the code is easy
  // for a human to type, and the brute-force defense is the
  // single-use + 15-min TTL combination, not entropy.
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const codeId = sanitizeEmailKey(email)
  const ttlSecs = 15 * 60
  const expiresAt = Date.now() + ttlSecs * 1000
  const salt = process.env.RENEW_TOKEN_SECRET || 'unset'
  const codeHash = hashCode(code, salt)

  const db = getDb()
  await db
    .collection('emailVerifications')
    .doc(codeId)
    .set({
      email,
      codeHash,
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    })

  // Send the code via Gmail SMTP — same path /api/capture and
  // /api/reset-password use, so the operator already has the env
  // vars set up.
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    return res
      .status(500)
      .json({ ok: false, error: 'שירות שליחת המייל לא מוגדר. פנה לתמיכה.' })
  }
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  })
  const html = renderEmail({
    heading: 'קוד האימות שלך',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
        הזן את הקוד הזה בתוכנה כדי לסיים את ההרשמה:
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:36px;letter-spacing:8px;font-weight:700;font-family:ui-monospace,monospace;color:#D4A574;">${code}</div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
        הקוד תקף ל-15 דקות. אם לא ביקשת אותו, אפשר להתעלם מהמייל הזה.
      </p>
      <p style="font-size:11px;margin:0;color:#5C5444;">
        אל תשתף את הקוד הזה עם אף אחד.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: email,
    subject: `קוד אימות: ${code} — ניהול הורדות פלוס`,
    html,
    text: `קוד האימות שלך: ${code}\nתקף ל-15 דקות.`,
  })

  return res.status(200).json({ ok: true })
}

async function handleSignupVerifyCode(req: VercelRequest, res: VercelResponse) {
  const body = req.body as {
    email?: string
    code?: string
    password?: string
    name?: string
    marketingOptIn?: boolean
    ref?: string
  }
  const email = (body.email || '').trim().toLowerCase()
  const code = (body.code || '').trim()
  const password = body.password || ''
  const displayName = (body.name || '').trim().slice(0, 100) || undefined
  // OPT-IN by default false — Israeli תקשורת law sec. 30א needs
  // a clear affirmative tick to count as consent. We never default
  // this to true even if the body omits it.
  const marketingOptIn = body.marketingOptIn === true

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }
  // Provider whitelist mirror — request-code already gates this,
  // but if a hostile client somehow lands a code for a disallowed
  // domain (e.g. the rule was added after the code was minted) we
  // still refuse to materialize the Firebase user.
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({
      ok: false,
      error: EMAIL_DOMAIN_REJECTION_MESSAGE,
    })
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'קוד אימות לא תקין' })
  }
  if (!password || password.length < 6) {
    return res
      .status(400)
      .json({ ok: false, error: 'סיסמה חייבת להיות לפחות 6 תווים' })
  }

  const codeId = sanitizeEmailKey(email)
  const db = getDb()
  const ref = db.collection('emailVerifications').doc(codeId)
  const salt = process.env.RENEW_TOKEN_SECRET || 'unset'
  const submittedHash = hashCode(code, salt)

  // Validate inside a transaction so concurrent verify attempts
  // can't race past the attempts counter.
  const txnResult = await db.runTransaction<
    | { ok: true; email: string }
    | { ok: false; status: number; error: string }
  >(async (txn) => {
    const snap = await txn.get(ref)
    if (!snap.exists) {
      return { ok: false, status: 400, error: 'קוד פג תוקף — בקש קוד חדש' }
    }
    const data = snap.data() as {
      email?: string
      codeHash?: string
      expiresAt?: number
      attempts?: number
    }
    const attempts = typeof data.attempts === 'number' ? data.attempts : 0
    if (attempts >= 5) {
      txn.delete(ref)
      return {
        ok: false,
        status: 400,
        error: 'יותר מדי ניסיונות שגויים. בקש קוד חדש.',
      }
    }
    if (typeof data.expiresAt !== 'number' || data.expiresAt < Date.now()) {
      txn.delete(ref)
      return { ok: false, status: 400, error: 'קוד פג תוקף — בקש קוד חדש' }
    }
    if (data.codeHash !== submittedHash) {
      txn.update(ref, { attempts: attempts + 1 })
      return { ok: false, status: 400, error: 'קוד שגוי' }
    }
    // Match. Delete the doc to make the code single-use.
    txn.delete(ref)
    return { ok: true, email: data.email || email }
  })

  if (!txnResult.ok) {
    return res.status(txnResult.status).json({ ok: false, error: txnResult.error })
  }

  // Create the Firebase Auth user, already-verified.
  let createdUid: string | null = null
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const created = await getAuth(getFirebase()).createUser({
      email,
      password,
      displayName,
      emailVerified: true,
    })
    createdUid = created.uid
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'auth/email-already-exists') {
      // Race: someone else (or the same user from another tab)
      // verified between our code-issued and code-verified steps.
      // Return success — the account exists, the caller can sign
      // in normally.
      return res.status(200).json({ ok: true, alreadyExisted: true })
    }
    console.error('[paypal/signup-verify-code] createUser failed:', err)
    return res
      .status(500)
      .json({ ok: false, error: 'יצירת המשתמש נכשלה. נסה שוב.' })
  }

  // Persist marketing opt-in (and the email + timestamp for audit)
  // to the user doc BEFORE the desktop's first sign-in. The desktop's
  // loadOrCreateUserDoc uses merge:true so it won't clobber these
  // fields; it just adds its own (deviceId, version, etc.).
  // Best-effort: an error here doesn't fail the signup — the user
  // is already created in Firebase, we just lose their marketing
  // preference. Logged so we can backfill manually if it ever
  // happens.
  if (createdUid) {
    try {
      await db
        .collection('users')
        .doc(createdUid)
        .set(
          {
            email,
            // Persist the display name to the user doc too — the admin
            // panel + other reads use `users/{uid}.name`. Previously we
            // only set it on the Firebase Auth user, so web signups
            // showed no name. Only write when provided so we never
            // clobber an existing name with empty.
            ...(displayName ? { name: displayName } : {}),
            marketingOptIn,
            marketingOptInAt: marketingOptIn ? new Date().toISOString() : null,
            createdAt: new Date().toISOString(),
          },
          { merge: true },
        )
    } catch (err) {
      console.warn(
        '[paypal/signup-verify-code] user doc write failed (continuing):',
        err,
      )
    }
    // Attribute this new account to a referral partner if the buyer
    // arrived through a partner link (?ref=...). Best-effort — never
    // fails the signup.
    await stampReferralOnSignup(createdUid, body.ref)
  }

  return res.status(200).json({ ok: true })
}

/* ─────────────────────────────────────────────────────────────
 *  Verify-existing flow (for users who signed up BEFORE we
 *  required verification). On their next login the desktop app
 *  detects emailVerified=false and routes them through the
 *  blocking VerifyEmailScreen, which calls these two endpoints.
 *  Symmetric to the signup-* pair, but instead of creating a
 *  Firebase user it flips emailVerified=true on the existing
 *  one.
 * ───────────────────────────────────────────────────────────── */

async function handleVerifyExistingRequestCode(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string }
  const idToken = (body.idToken || '').trim()
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'missing id token' })
  }
  let uid: string
  let email: string
  let alreadyVerified = false
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken)
    uid = decoded.uid
    email = (decoded.email || '').toLowerCase().trim()
    if (!email) {
      return res.status(400).json({ ok: false, error: 'No email on account' })
    }
    alreadyVerified = !!decoded.email_verified
  } catch (err) {
    console.error('[paypal/verify-existing-request-code] token verify failed', err)
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }
  if (alreadyVerified) {
    // Nothing to do; the desktop just needs to reload its cached
    // Firebase user record.
    return res.status(200).json({ ok: true, alreadyVerified: true })
  }

  // Rate limit so the existing-user verify flow can't be turned
  // into an email blaster or used to enumerate registered users.
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    'unknown'
  const allowed = await Promise.all([
    tryRateLimit(`verify-existing_uid_${uid}`, 5, 60 * 60),
    tryRateLimit(`verify-existing_ip_${ip.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60)}`, 30, 60 * 60),
  ])
  if (!allowed.every(Boolean)) {
    return res.status(429).json({
      ok: false,
      error: 'יותר מדי בקשות. נסה שוב בעוד שעה.',
    })
  }

  // Reuse the same emailVerifications/{email} doc shape as the
  // signup flow — it's the same one-shot 6-digit code, just
  // applied to a different post-validation action.
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const codeId = sanitizeEmailKey(email)
  const ttlSecs = 15 * 60
  const expiresAt = Date.now() + ttlSecs * 1000
  const salt = process.env.RENEW_TOKEN_SECRET || 'unset'
  const codeHash = hashCode(code, salt)

  const db = getDb()
  await db
    .collection('emailVerifications')
    .doc(codeId)
    .set({
      email,
      uid,
      codeHash,
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
      purpose: 'verify-existing',
    })

  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    return res
      .status(500)
      .json({ ok: false, error: 'שירות שליחת המייל לא מוגדר. פנה לתמיכה.' })
  }
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  })
  const html = renderEmail({
    heading: 'אימות כתובת המייל',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
        הוספנו דרישה לאמת את כתובת המייל לכל המשתמשים. הזן את הקוד הבא בתוכנה כדי להמשיך:
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:36px;letter-spacing:8px;font-weight:700;font-family:ui-monospace,monospace;color:#D4A574;">${code}</div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
        הקוד תקף ל-15 דקות. אם לא ביקשת אותו, יש לפנות לתמיכה — ייתכן שמישהו מנסה להיכנס לחשבון שלך.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: email,
    subject: `קוד אימות: ${code} — ניהול הורדות פלוס`,
    html,
    text: `קוד אימות לחשבון שלך: ${code}\nתקף ל-15 דקות.`,
  })

  return res.status(200).json({ ok: true, email })
}

async function handleVerifyExistingConfirmCode(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const idToken = (body.idToken || '').trim()
  const code = (body.code || '').trim()
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'missing id token' })
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'קוד אימות לא תקין' })
  }
  let uid: string
  let email: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken)
    uid = decoded.uid
    email = (decoded.email || '').toLowerCase().trim()
    if (!email) {
      return res.status(400).json({ ok: false, error: 'No email on account' })
    }
  } catch (err) {
    console.error('[paypal/verify-existing-confirm-code] token verify failed', err)
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }

  const codeId = sanitizeEmailKey(email)
  const db = getDb()
  const ref = db.collection('emailVerifications').doc(codeId)
  const salt = process.env.RENEW_TOKEN_SECRET || 'unset'
  const submittedHash = hashCode(code, salt)

  const txnResult = await db.runTransaction<
    | { ok: true }
    | { ok: false; status: number; error: string }
  >(async (txn) => {
    const snap = await txn.get(ref)
    if (!snap.exists) {
      return { ok: false, status: 400, error: 'קוד פג תוקף — בקש קוד חדש' }
    }
    const data = snap.data() as {
      email?: string
      uid?: string
      codeHash?: string
      expiresAt?: number
      attempts?: number
      purpose?: string
    }
    // Cross-validate: the code doc must belong to the same uid +
    // email we just verified. Defends against the case where two
    // different users (different uids on the same email — shouldn't
    // happen, but) both have a code outstanding.
    if (data.uid && data.uid !== uid) {
      return {
        ok: false,
        status: 400,
        error: 'הקוד לא משוייך לחשבון הזה — בקש קוד חדש',
      }
    }
    const attempts = typeof data.attempts === 'number' ? data.attempts : 0
    if (attempts >= 5) {
      txn.delete(ref)
      return {
        ok: false,
        status: 400,
        error: 'יותר מדי ניסיונות שגויים. בקש קוד חדש.',
      }
    }
    if (typeof data.expiresAt !== 'number' || data.expiresAt < Date.now()) {
      txn.delete(ref)
      return { ok: false, status: 400, error: 'קוד פג תוקף — בקש קוד חדש' }
    }
    if (data.codeHash !== submittedHash) {
      txn.update(ref, { attempts: attempts + 1 })
      return { ok: false, status: 400, error: 'קוד שגוי' }
    }
    txn.delete(ref)
    return { ok: true }
  })

  if (!txnResult.ok) {
    return res.status(txnResult.status).json({ ok: false, error: txnResult.error })
  }

  // Flip the user's emailVerified flag. The desktop will then call
  // user.reload() to pick up the change locally.
  try {
    const { getAuth } = await import('firebase-admin/auth')
    await getAuth(getFirebase()).updateUser(uid, { emailVerified: true })
  } catch (err) {
    console.error('[paypal/verify-existing-confirm-code] updateUser failed:', err)
    return res
      .status(500)
      .json({ ok: false, error: 'עדכון הסטטוס נכשל. נסה שוב.' })
  }
  return res.status(200).json({ ok: true })
}

/* ─────────────────────────────────────────────────────────────
 *  Migration: set emailVerified=true on every existing Firebase
 *  user.
 *
 *  (No longer required for the standard rollout — the user opted
 *  to force every existing user through verify-existing-* on
 *  their next login instead. Kept as an admin tool for support
 *  cases where you need to grandfather someone in manually.)
 *
 *  Idempotent: re-running just no-ops on users already verified.
 * ───────────────────────────────────────────────────────────── */
async function handleAdminMigrateEmailVerified(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string }
  const idToken = (body.idToken || '').trim()
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'missing id token' })
  }
  let email: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken, true)
    email = (decoded.email || '').toLowerCase()
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }
  const { getAuth } = await import('firebase-admin/auth')
  const auth = getAuth(getFirebase())
  let updated = 0
  let nextPageToken: string | undefined
  try {
    do {
      const page = await auth.listUsers(1000, nextPageToken)
      for (const user of page.users) {
        if (!user.emailVerified) {
          await auth.updateUser(user.uid, { emailVerified: true })
          updated++
        }
      }
      nextPageToken = page.pageToken
    } while (nextPageToken)
  } catch (err) {
    console.error('[paypal/admin-migrate-email-verified] failed:', err)
    return res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : 'failed', updated })
  }
  return res.status(200).json({ ok: true, updated })
}

/* ─────────────────────────────────────────────────────────────
 *  Unified email-template helper. Inlined per file (NOT shared
 *  from one module) because Vercel's per-function bundler has
 *  proven flaky with helper-only imports out of api/. Every file
 *  that sends mail keeps its own copy — keep them in sync if you
 *  change the chrome.
 *
 *  Style: dark-mode-only with gold accents, matches the desktop
 *  app's UI palette. Body content goes between the brand wordmark
 *  and the closing card border. Each caller writes only its
 *  variable content (heading text + body HTML) and gets the
 *  consistent dark frame for free.
 * ───────────────────────────────────────────────────────────── */
function renderEmail(args: { heading: string; contentHtml: string }): string {
  // Brand palette mirroring src/index.css — warm espresso bg, copper
  // accent, cream foreground. Replaces the earlier "generic dark +
  // bright yellow" Material-look that didn't match the desktop app
  // or the website at all. Rubik is the website's display font; we
  // request it from Google Fonts but fall back gracefully because
  // most email clients strip remote stylesheets.
  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="color-scheme" content="only dark"/>
  <meta name="supported-color-schemes" content="only dark"/>
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#16110D;font-family:'Rubik',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:#F5EFE6;direction:rtl;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#16110D;padding:48px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;background:#2A211A;border-radius:10px;border:1px solid rgba(245,239,230,0.08);box-shadow:0 24px 48px rgba(13,8,4,0.55);">
<tr><td style="padding:40px 36px;text-align:right;direction:rtl;">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8B8170;margin:0 0 14px;font-weight:500;direction:rtl;text-align:right;">— ניהול הורדות פלוס</div>
  <h1 style="font-size:28px;margin:0 0 22px;color:#F5EFE6;font-weight:500;line-height:1.18;letter-spacing:-0.015em;direction:rtl;text-align:right;">${args.heading}</h1>
  ${args.contentHtml}
</td></tr>
</table>
<div style="margin:24px auto 0;font-size:10px;letter-spacing:0.18em;color:#5C5444;text-align:center;">— ניהול הורדות פלוס —</div>
</td></tr>
</table>
</body>
</html>`
}

/* ─────────────────────────────────────────────────────────────
 *  Admin: send a test email of any template to a target inbox.
 *
 *  Lets the operator preview how a template actually renders in
 *  Gmail / Outlook / Apple Mail without going through the real
 *  user flow (no need to actually expire a key just to see what
 *  the expiry reminder looks like). Each "template" is a tiny
 *  inline factory that produces a complete HTML + subject pair
 *  from mock data.
 *
 *  Admin-allowlist gated. The target email is whatever the
 *  caller types — the admin is trusted to type their own address.
 * ───────────────────────────────────────────────────────────── */

type TestEmailKind =
  | 'welcome-subscription'
  | 'pro-activated'
  | 'cancellation'
  | 'verify-signup'
  | 'verify-existing'
  | 'reset-password'
  | 'capture-key'
  | 'renewal-extension'
  | 'expiry-reminder'
  | 'annual-report'

function buildTestEmail(kind: TestEmailKind): { subject: string; html: string } {
  // Mock data — deliberately recognisable so the recipient can
  // tell "yep this is the test version" at a glance. All values
  // are static strings; no real PII leaks.
  const mockKey = 'TEST-XXXX-YYYY-ZZZZ'
  const mockExpiry = '01.06.2026'
  const mockSubId = 'I-TESTSUBSCRIPTION'

  switch (kind) {
    case 'welcome-subscription':
      return {
        subject: '[בדיקה] המנוי שלך פעיל — ניהול הורדות פלוס Pro',
        html: renderEmail({
          heading: 'ברוך הבא ל-Pro 🎉',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
              [תצוגת בדיקה] המנוי שלך פעיל! מצורף מפתח Pro לתוכנה <strong>ניהול הורדות פלוס</strong>.
            </p>
            <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
              <div style="font-size:11px;color:#8B8170;margin-bottom:8px;">מפתח המוצר</div>
              <div dir="ltr" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:22px;color:#D4A574;letter-spacing:0.08em;font-weight:700;">${mockKey}</div>
            </div>
            <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">פרטי המנוי</h3>
            <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
              <div>• תוכנית: חודשי (9 ₪)</div>
              <div>• חיוב הבא: ${mockExpiry}</div>
              <div>• מתחדש אוטומטית עד שתבטל</div>
              <div>• ניהול / ביטול: <a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a></div>
            </div>
            <p style="margin:24px 0 0;font-size:11px;color:#5C5444;">
              מנוי ID: <span dir="ltr">${mockSubId}</span>
            </p>
          `,
        }),
      }
    case 'pro-activated':
      return {
        subject: '[בדיקה] ✓ החשבון שלך פעיל — ניהול הורדות פלוס Pro',
        html: renderEmail({
          heading: '✓ החשבון שלך עכשיו Pro',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
              [תצוגת בדיקה] המפתח הופעל בהצלחה, וכעת יש לך גישה מלאה לכל היכולות של מנוי Pro בתוכנה <strong>ניהול הורדות פלוס</strong>.
            </p>
            <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;">
              <div style="display:flex;justify-content:space-between;font-size:13px;line-height:1.8;color:#C9BFA8;">
                <div>
                  <div style="color:#8B8170;font-size:11px;margin-bottom:4px;">מפתח</div>
                  <div dir="ltr" style="font-family:ui-monospace,'SF Mono',monospace;color:#D4A574;font-size:14px;font-weight:600;">…${mockKey.slice(-8)}</div>
                </div>
                <div style="text-align:left;">
                  <div style="color:#8B8170;font-size:11px;margin-bottom:4px;">בתוקף עד</div>
                  <div style="color:#F5EFE6;font-size:14px;font-weight:600;">${mockExpiry}</div>
                </div>
              </div>
            </div>
            <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">מה אפשר עכשיו</h3>
            <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
              <div>• מיון אוטומטי + חוקי ניתוב מותאמים אישית</div>
              <div>• הורדה מסרטוני וידאו ב-MP3 / 1080p / 4K</div>
              <div>• המרת קבצים בין כל הפורמטים</div>
              <div>• דחיסת וידאו לגודל יעד</div>
              <div>• הצעות מחיר עם יועץ AI ופלט PDF</div>
              <div>• ניהול תשלומים והכנסות</div>
              <div>• עדכונים אוטומטיים ותמיכה מועדפת</div>
            </div>
          `,
        }),
      }
    case 'cancellation':
      return {
        subject: '[בדיקה] אישור ביטול מנוי — ניהול הורדות פלוס',
        html: renderEmail({
          heading: 'המנוי שלך בוטל',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
              [תצוגת בדיקה] קיבלנו את בקשת הביטול שלך למנוי <strong>ניהול הורדות פלוס Pro</strong>. הביטול בוצע מתוך דף החשבון באתר. לא תחויב שוב.
            </p>
            <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;">
              <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">הגישה ל-Pro תפעל עד</div>
              <div style="font-size:18px;color:#F5EFE6;font-weight:600;">${mockExpiry}</div>
              <div style="margin-top:10px;font-size:11px;line-height:1.6;color:#8B8170;">
                קיבלת את התקופה ששילמת עליה במלואה. לאחר מכן החשבון יחזור לחינם.
              </div>
            </div>
            <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
              <strong>אין החזר על תקופות ששולמו</strong> — מאחר שמדובר במוצר דיגיטלי שניתן לשימוש מיידי, אין מדיניות החזרים על תקופות שכבר חויבו ושולמו.
            </p>
            <p style="font-size:12px;line-height:1.7;margin:18px 0 0;color:#C9BFA8;">
              משנים את דעתכם? אפשר להירשם מחדש בכל עת ב-
              <a href="${WEBSITE_BASE}/buy" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/buy</a>.
            </p>
          `,
        }),
      }
    case 'verify-signup':
      return {
        subject: '[בדיקה] קוד אימות: 123456 — ניהול הורדות פלוס',
        html: renderEmail({
          heading: 'קוד האימות שלך',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
              [תצוגת בדיקה] הזן את הקוד הזה בתוכנה כדי לסיים את ההרשמה:
            </p>
            <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
              <div style="font-size:36px;letter-spacing:8px;font-weight:700;font-family:ui-monospace,monospace;color:#D4A574;">123456</div>
            </div>
            <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
              הקוד תקף ל-15 דקות.
            </p>
          `,
        }),
      }
    case 'verify-existing':
      return {
        subject: '[בדיקה] קוד אימות לחשבון שלך',
        html: renderEmail({
          heading: 'אימות כתובת המייל',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
              [תצוגת בדיקה] הוספנו דרישה לאמת את כתובת המייל לכל המשתמשים. הזן את הקוד הבא:
            </p>
            <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
              <div style="font-size:36px;letter-spacing:8px;font-weight:700;font-family:ui-monospace,monospace;color:#D4A574;">654321</div>
            </div>
            <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
              הקוד תקף ל-15 דקות.
            </p>
          `,
        }),
      }
    case 'reset-password':
      return {
        subject: '[בדיקה] איפוס סיסמה — ניהול הורדות פלוס',
        html: renderEmail({
          heading: 'איפוס סיסמה',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              [תצוגת בדיקה] קיבלנו בקשה לאיפוס הסיסמה לחשבון שלך ב-<strong>ניהול הורדות פלוס</strong>.
            </p>
            <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
              לחץ על הכפתור כדי לקבוע סיסמה חדשה:
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
              <tr><td align="center">
                <a href="https://example.com/reset?token=test" target="_blank" style="display:inline-block;background:#B8794F;color:#F5EFE6;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">לאיפוס הסיסמה</a>
              </td></tr>
            </table>
            <p style="font-size:12px;line-height:1.6;margin:0 0 14px;color:#8B8170;">
              ⚠️ הקישור תקף לשעה אחת בלבד.
            </p>
          `,
        }),
      }
    case 'capture-key':
      return {
        subject: '[בדיקה] מפתח ניהול הורדות פלוס Pro שלך',
        html: renderEmail({
          heading: 'תודה על הרכישה 🎉',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
              [תצוגת בדיקה] מצורף מפתח <span style="color:#D4A574;">Pro</span> לתוכנה <strong>ניהול הורדות פלוס</strong> לתקופה של שנה מהיום (תוקף עד ${mockExpiry}).
            </p>
            <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
              <div style="font-size:11px;color:#8B8170;margin-bottom:8px;">מפתח המוצר</div>
              <div dir="ltr" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:22px;color:#D4A574;letter-spacing:0.08em;font-weight:700;">${mockKey}</div>
            </div>
            <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">איך מממשים?</h3>
            <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
              <div>1. פותחים את התוכנה ונכנסים לחשבון.</div>
              <div>2. לוחצים על השם בצד שמאל למטה ← <strong>מימוש מפתח מוצר</strong>.</div>
              <div>3. מדביקים את המפתח ולוחצים <strong>אישור</strong>.</div>
            </div>
          `,
        }),
      }
    case 'renewal-extension':
      return {
        subject: '[בדיקה] חידוש מנוי ניהול הורדות פלוס',
        html: renderEmail({
          heading: 'המנוי שלך הוארך ✓',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 20px;color:#C9BFA8;">
              [תצוגת בדיקה] הוספנו <strong>שנה</strong> נוסף למפתח Pro שלך.
            </p>
            <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:18px;margin:0 0 24px;text-align:center;">
              <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">תוקף קודם</div>
              <div style="font-size:14px;color:#5C5444;text-decoration:line-through;margin-bottom:14px;">01.06.2025</div>
              <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">תוקף חדש</div>
              <div style="font-size:20px;color:#7DAA6B;font-weight:700;">${mockExpiry}</div>
            </div>
          `,
        }),
      }
    case 'expiry-reminder':
      return {
        subject: '[בדיקה] ⏳ המנוי שלך מסתיים בעוד 2 ימים',
        html: renderEmail({
          heading: '⏳ המנוי שלך עומד להסתיים',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              [תצוגת בדיקה] המפתח שלך לתוכנה <strong>ניהול הורדות פלוס</strong> פג בעוד <strong>2 ימים</strong> (${mockExpiry}).
            </p>
            <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
              לחיצה על הכפתור למטה תעביר אותך לעמוד החידוש. המפתח שלך נשאר אותו דבר.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
              <tr><td align="center">
                <a href="https://example.com/buy?renew=test" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">חידוש המנוי 👑</a>
              </td></tr>
            </table>
          `,
        }),
      }
    case 'annual-report':
      return {
        subject: '[בדיקה] סיכום חיובים שנתי — 2025',
        html: renderEmail({
          heading: 'סיכום חיובים שנתי — 2025',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 18px;color:#C9BFA8;">
              [תצוגת בדיקה] ריכוז כל החיובים שבוצעו על המנוי שלך במהלך 2025.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;border:1px solid rgba(245,239,230,0.08);border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#16110D;">
                  <th style="padding:10px 12px;text-align:right;color:#8B8170;font-weight:500;font-size:12px;">תאריך</th>
                  <th style="padding:10px 12px;text-align:left;color:#8B8170;font-weight:500;font-size:12px;direction:ltr;">סכום</th>
                </tr>
              </thead>
              <tbody style="font-size:13px;">
                <tr><td style="padding:6px 12px;border-bottom:1px solid rgba(245,239,230,0.08);color:#F5EFE6;">15.03.2025</td><td style="padding:6px 12px;border-bottom:1px solid rgba(245,239,230,0.08);color:#D4A574;text-align:left;direction:ltr;">9 ₪</td></tr>
                <tr><td style="padding:6px 12px;border-bottom:1px solid rgba(245,239,230,0.08);color:#F5EFE6;">15.06.2025</td><td style="padding:6px 12px;border-bottom:1px solid rgba(245,239,230,0.08);color:#D4A574;text-align:left;direction:ltr;">9 ₪</td></tr>
                <tr><td style="padding:6px 12px;color:#F5EFE6;">15.09.2025</td><td style="padding:6px 12px;color:#D4A574;text-align:left;direction:ltr;">9 ₪</td></tr>
              </tbody>
            </table>
            <p style="margin:14px 0;font-size:14px;color:#F5EFE6;">
              <strong>סה״כ 2025:</strong> <strong style="color:#D4A574;">27 ₪</strong>
            </p>
          `,
        }),
      }
  }
}

async function handleAdminSendTestEmail(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { idToken?: string; targetEmail?: string; kind?: string }
  const idToken = (body.idToken || '').trim()
  const targetEmail = (body.targetEmail || '').trim().toLowerCase()
  const kind = (body.kind || '').trim() as TestEmailKind
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'missing id token' })
  }
  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל יעד לא תקינה' })
  }
  const allowed: TestEmailKind[] = [
    'welcome-subscription',
    'pro-activated',
    'cancellation',
    'verify-signup',
    'verify-existing',
    'reset-password',
    'capture-key',
    'renewal-extension',
    'expiry-reminder',
    'annual-report',
  ]
  if (!allowed.includes(kind)) {
    return res.status(400).json({ ok: false, error: `unknown template: ${kind}` })
  }
  let email: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken)
    email = (decoded.email || '').toLowerCase()
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }

  const { subject, html } = buildTestEmail(kind)
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    return res.status(500).json({ ok: false, error: 'GMAIL credentials not set' })
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  try {
    await transporter.sendMail({
      from: `"ניהול הורדות פלוס" <${user}>`,
      to: targetEmail,
      subject,
      html,
    })
  } catch (err) {
    console.error('[paypal/admin-send-test-email] sendMail failed:', err)
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'send failed',
    })
  }
  return res.status(200).json({ ok: true, sentTo: targetEmail, kind })
}

/* ─────────────────────────────────────────────────────────────
 *  Admin: broadcast a marketing email to every user who opted
 *  in at signup (users/{uid}.marketingOptIn === true).
 *
 *  Each recipient gets a personalised unsubscribe link in the
 *  footer (signed token referencing their uid). Israeli תקשורת
 *  law sec. 30א requires every promotional email to include a
 *  one-click opt-out, regardless of how the opt-in was captured.
 *
 *  Throttling: Gmail SMTP caps free accounts at ~500/day. We
 *  iterate the recipient list sequentially with a tiny sleep
 *  between sends to avoid tripping the rate-limit and getting
 *  the whole account temporarily suspended. For lists > ~400
 *  the operator should split the broadcast across days OR move
 *  to a transactional provider; we'll cross that bridge when
 *  the user base actually approaches that size.
 *
 *  Failures don't abort the broadcast — we log the address that
 *  failed and continue. The response includes counts so the
 *  operator can see how many got through.
 * ───────────────────────────────────────────────────────────── */

function unsubscribeToken(uid: string): string {
  // Plain HMAC of the uid — no expiry. Recipients of old marketing
  // emails should still be able to click and unsubscribe years
  // later. The HMAC means an attacker can't unsubscribe arbitrary
  // uids by guessing their token; they'd need the secret.
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(uid)
    .digest('hex')
}

function verifyUnsubscribeToken(uid: string, token: string): boolean {
  const expected = unsubscribeToken(uid)
  if (expected.length !== token.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
  } catch {
    return false
  }
}

async function handleAdminSendMarketingEmail(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    idToken?: string
    subject?: string
    heading?: string
    contentHtml?: string
    dryRun?: boolean
  }
  const idToken = (body.idToken || '').trim()
  const subject = (body.subject || '').trim().slice(0, 200)
  const heading = (body.heading || '').trim().slice(0, 100)
  const contentHtml = (body.contentHtml || '').trim()
  const dryRun = body.dryRun === true
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'missing id token' })
  }
  if (!subject || !heading || !contentHtml) {
    return res
      .status(400)
      .json({ ok: false, error: 'יש למלא subject + heading + contentHtml' })
  }
  let adminEmail: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken)
    adminEmail = (decoded.email || '').toLowerCase()
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }
  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }

  const db = getDb()
  const snap = await db
    .collection('users')
    .where('marketingOptIn', '==', true)
    .get()
  const recipients: Array<{ uid: string; email: string }> = []
  for (const d of snap.docs) {
    const data = d.data() as { email?: string }
    const e = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
    if (!e) continue
    recipients.push({ uid: d.id, email: e })
  }

  if (dryRun) {
    return res.status(200).json({ ok: true, recipientCount: recipients.length })
  }

  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    return res.status(500).json({ ok: false, error: 'GMAIL credentials not set' })
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })

  let sent = 0
  let failed = 0
  const failures: string[] = []
  for (const r of recipients) {
    const unsubUrl = `${WEBSITE_BASE}/api/paypal?action=unsubscribe&uid=${encodeURIComponent(
      r.uid,
    )}&token=${unsubscribeToken(r.uid)}`
    const footerHtml = `
      <hr style="border:0;border-top:1px solid rgba(245,239,230,0.08);margin:28px 0 16px;"/>
      <p style="font-size:11px;color:#5C5444;line-height:1.6;margin:0;">
        אתה מקבל את המייל הזה כי בחרת לקבל עדכוני מוצר ומבצעים. <a href="${unsubUrl}" style="color:#D4A574;text-decoration:underline;">להסרה מרשימת התפוצה</a>.
      </p>
    `
    const html = renderEmail({
      heading,
      contentHtml: `${contentHtml}\n${footerHtml}`,
    })
    try {
      await transporter.sendMail({
        from: `"ניהול הורדות פלוס" <${user}>`,
        to: r.email,
        subject,
        html,
      })
      sent++
    } catch (err) {
      failed++
      failures.push(r.email)
      console.error(`[marketing] send to ${r.email} failed:`, err)
    }
    // Mild throttle so a 100-recipient broadcast doesn't get the
    // Gmail account flagged. 200ms between sends ≈ 5/sec which is
    // well under the daily quota for free Gmail (500/day).
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  return res.status(200).json({
    ok: true,
    recipientCount: recipients.length,
    sent,
    failed,
    failureSample: failures.slice(0, 10),
  })
}

/* ─────────────────────────────────────────────────────────────
 *  Unsubscribe (GET) — one-click marketing opt-out.
 *
 *  The marketing email footer links here. Token is an HMAC of
 *  the user's uid (no expiry — old emails should still work).
 *  On valid token we flip marketingOptIn=false and render a
 *  small "you've been unsubscribed" page. No JSON, no need for
 *  the user to be logged in — they click the link, the cookie
 *  jar doesn't matter, the token is the proof.
 * ───────────────────────────────────────────────────────────── */
async function handleUnsubscribe(req: VercelRequest, res: VercelResponse) {
  const uid = (req.query.uid as string | undefined)?.trim() || ''
  const token = (req.query.token as string | undefined)?.trim() || ''
  function htmlPage(message: string, ok: boolean): string {
    return `<!doctype html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet"/>
  <title>הסרה מרשימת דיוור</title>
</head>
<body style="margin:0;padding:0;background:#16110D;color:#F5EFE6;font-family:'Rubik',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;direction:rtl;min-height:100vh;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased;">
<div style="max-width:480px;width:90%;background:#2A211A;border-radius:10px;border:1px solid rgba(245,239,230,0.08);padding:48px 36px;text-align:center;box-shadow:0 24px 48px rgba(13,8,4,0.55);">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8B8170;margin:0 0 16px;font-weight:500;">— ניהול הורדות פלוס</div>
  <div style="font-size:48px;margin:0 0 16px;color:${ok ? '#7DAA6B' : '#C16B5F'};line-height:1;">${ok ? '✓' : '⚠'}</div>
  <h1 style="font-size:22px;margin:0 0 14px;color:#F5EFE6;font-weight:500;line-height:1.3;letter-spacing:-0.01em;">${message}</h1>
  <p style="font-size:13px;color:#8B8170;margin:0;line-height:1.6;">ניתן להירשם מחדש מתוך הגדרות החשבון בכל עת.</p>
</div>
</body>
</html>`
  }
  if (!uid || !token || !verifyUnsubscribeToken(uid, token)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res
      .status(400)
      .send(htmlPage('הקישור לא תקין או שפג תוקפו.', false))
  }
  try {
    const db = getDb()
    await db
      .collection('users')
      .doc(uid)
      .set(
        {
          marketingOptIn: false,
          marketingOptOutAt: new Date().toISOString(),
        },
        { merge: true },
      )
  } catch (err) {
    console.error('[paypal/unsubscribe] firestore write failed:', err)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res
      .status(500)
      .send(htmlPage('משהו השתבש. נסה שוב בעוד דקה.', false))
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res
    .status(200)
    .send(
      htmlPage(
        'הוסרת בהצלחה מרשימת התפוצה. לא תקבל יותר הודעות שיווקיות.',
        true,
      ),
    )
}

/* ─────────────────────────────────────────────────────────────
 *  Update marketing opt-in (session-gated)
 *
 *  Called from the /account page when the user flips the toggle.
 *  Auth: the same session JWT the /account page already holds
 *  (no need to re-prompt for password). Flips users/{uid}
 *  .marketingOptIn to the supplied boolean and stamps an
 *  audit timestamp.
 * ───────────────────────────────────────────────────────────── */
async function handleUpdateMarketingOptIn(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { token?: string; optIn?: boolean }
  const token = (body.token || '').trim()
  const optIn = body.optIn === true
  if (!token) {
    return res.status(401).json({ ok: false, error: 'invalid or expired session' })
  }
  const claims = verifySessionToken(token)
  if (!claims) {
    return res.status(401).json({ ok: false, error: 'invalid or expired session' })
  }
  try {
    const db = getDb()
    const update: Record<string, unknown> = { marketingOptIn: optIn }
    // Mirror the timestamps signup-verify-code uses so the audit
    // trail stays consistent regardless of where the opt-in flipped.
    if (optIn) {
      update.marketingOptInAt = new Date().toISOString()
    } else {
      update.marketingOptOutAt = new Date().toISOString()
    }
    await db.collection('users').doc(claims.uid).set(update, { merge: true })
  } catch (err) {
    console.error('[paypal/update-marketing-opt-in] write failed:', err)
    return res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : 'failed' })
  }
  return res.status(200).json({ ok: true, marketingOptIn: optIn })
}

/* ─────────────────────────────────────────────────────────────
 *  Mint a renew token for the session user's primary key
 *
 *  Called by /account's "חידוש המנוי שלי" button. We pick the
 *  user's longest-lived owned key, sign a JWT with {uid, key}
 *  using the same HMAC scheme + RENEW_TOKEN_SECRET as the cron
 *  expiry-reminder emails, and return it. The frontend then
 *  navigates to /buy?renew=<token>, which lights up the existing
 *  yellow "חידוש מנוי קיים" panel + extends THIS key (rather than
 *  creating a brand-new one) when the payment lands.
 *
 *  Returns 404 if the user has no keys at all — that flow should
 *  go through the regular guest-purchase path instead.
 * ───────────────────────────────────────────────────────────── */

const RENEW_TOKEN_TTL_DAYS_DEFAULT = 14

function b64urlEncodePaypal(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function signRenewTokenForKey(uid: string, key: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + RENEW_TOKEN_TTL_DAYS_DEFAULT * 86400
  const header = b64urlEncodePaypal(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const payload = b64urlEncodePaypal(
    Buffer.from(JSON.stringify({ uid, key, iat, exp })),
  )
  const signature = b64urlEncodePaypal(
    crypto.createHmac('sha256', tokenSecret()).update(`${header}.${payload}`).digest(),
  )
  return `${header}.${payload}.${signature}`
}

interface RenewTokenClaims {
  uid: string
  key: string
  iat?: number
  exp?: number
}

function verifyRenewTokenLocal(token: string): RenewTokenClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts
    const expected = crypto
      .createHmac('sha256', tokenSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest()
    const actual = b64urlDecode(sigB64)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(
      b64urlDecode(payloadB64).toString('utf8'),
    ) as RenewTokenClaims
    if (typeof claims.uid !== 'string' || typeof claims.key !== 'string') return null
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    return claims
  } catch {
    return null
  }
}

async function handleMintRenewToken(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { token?: string }
  const token = (body.token || '').trim()
  if (!token) {
    return res.status(401).json({ ok: false, error: 'invalid or expired session' })
  }
  const claims = verifySessionToken(token)
  if (!claims) {
    return res.status(401).json({ ok: false, error: 'invalid or expired session' })
  }
  // Find the user's primary key. Same picker logic as
  // respondWithSession's profile.keyLast8 selection — longest-
  // lived owned key (so an active key wins over an expired one,
  // and the most recently-bought wins among expired-keys).
  const db = getDb()
  const snap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', claims.uid)
    .limit(50)
    .get()
  if (snap.empty) {
    return res
      .status(404)
      .json({ ok: false, error: 'אין לך מפתח קיים לחדש. בצע רכישה חדשה.' })
  }
  let primaryKey: string | null = null
  let primaryExpMs = 0
  for (const d of snap.docs) {
    const data = d.data() as { key?: string; expiresAt?: string }
    const k = typeof data.key === 'string' ? data.key : d.id
    const expMs = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : 0
    if (!primaryKey || expMs > primaryExpMs) {
      primaryKey = k
      primaryExpMs = expMs
    }
  }
  if (!primaryKey) {
    return res.status(404).json({ ok: false, error: 'no primary key' })
  }
  const renewToken = signRenewTokenForKey(claims.uid, primaryKey)
  return res.status(200).json({ ok: true, renewToken, key: primaryKey })
}

/* ─────────────────────────────────────────────────────────────
 *  Admin: grant Pro to a user manually (bypass PayPal)
 *
 *  For support cases — complimentary access, end-to-end testing
 *  without spending money on a real PayPal payment, refund-and-
 *  reissue scenarios. Creates a productKey that's already
 *  redeemed to the target user, with expiresAt = now + days,
 *  and runs the same account-lock cleanup that real redemptions
 *  do (any prior keys on that uid get unlinked + audit-stamped).
 *  Fires the "Pro activated" email so the user knows it
 *  happened, just like a real subscription would.
 *
 *  Admin-EMAIL-allowlist gated (NOT just any session) — this
 *  bypasses payment, so it must be locked to operator hands only.
 * ───────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────
 *  Pricing read (action=get-pricing)
 *
 *  Pure read of the current live pricing — folded into this
 *  dispatcher so the Vercel Hobby plan's 12-function cap has room
 *  for the new revisions.ts. The standalone /api/pricing endpoint
 *  used to live in api/pricing.ts; this action is its replacement.
 *
 *  Public, no auth — anyone can read pricing (it's shown on the
 *  marketing site Hero + BuyPage). 60s edge cache via Cache-Control
 *  so admin price changes propagate within a minute.
 * ───────────────────────────────────────────────────────────── */
async function handleGetPricing(_req: VercelRequest, res: VercelResponse) {
  // STRICT: the price must come net from the database. If we can't
  // confirm a real DB price, return ok:false (no hardcoded fallback)
  // so the /buy page blocks checkout instead of selling at a default.
  const pricing = await loadCurrentPricingStrict()
  if (!pricing) {
    // Don't cache a failure — a transient Firestore blip shouldn't
    // pin "unavailable" for 60s at the edge.
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ok: false, error: 'pricing_unavailable' })
  }
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=3600')
  // Shape matches the legacy /api/pricing response (with `ok` flag)
  // so fetchLivePricing on the client doesn't need any branching
  // between old and new URLs.
  return res.status(200).json({ ok: true, ...pricing })
}

/* ─────────────────────────────────────────────────────────────
 *  get-terms — public read of appConfig/terms for the website
 *
 *  Mirrors what the desktop's TermsProvider already does via the
 *  Firebase Web SDK directly, but exposes the same data over HTTP
 *  so the website (which deliberately ships without Firebase
 *  Web SDK) can show the same terms in its signup modal.
 *
 *  No auth — terms of use are public-by-design. Cached for 60s
 *  at the edge so repeated modal opens don't keep hammering
 *  Firestore.
 * ───────────────────────────────────────────────────────────── */
async function handleGetTerms(_req: VercelRequest, res: VercelResponse) {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('terms').get()
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
    if (!snap.exists) {
      // Operator hasn't seeded the doc yet (or the very first
      // install). Return a clear stub the modal can render so the
      // user sees something actionable rather than "loading…"
      // forever. The desktop has the full canonical text — that's
      // what the operator typically publishes when they first
      // open the admin panel's TermsEditorCard.
      return res.status(200).json({
        ok: true,
        version: 0,
        lastUpdated: '',
        sections: [
          {
            title: 'תנאי השימוש טרם פורסמו',
            paragraphs: [
              'תנאי השימוש המלאים זמינים בתוכנת ניהול הורדות פלוס לאחר התקנה.',
              'בכל שאלה אפשר לפנות אלינו במייל: dyshalts@gmail.com',
            ],
          },
        ],
      })
    }
    const data = snap.data() as {
      version?: number
      lastUpdated?: string
      sections?: Array<{ title: string; paragraphs: string[] }>
    }
    return res.status(200).json({
      ok: true,
      version: typeof data.version === 'number' ? data.version : 0,
      lastUpdated:
        typeof data.lastUpdated === 'string' ? data.lastUpdated : '',
      sections: Array.isArray(data.sections) ? data.sections : [],
    })
  } catch (err) {
    console.error('[paypal/get-terms] failed:', err)
    return res.status(500).json({
      ok: false,
      error: 'לא הצלחנו לטעון את תנאי השימוש כרגע. נסו שוב.',
    })
  }
}

/* ─────────────────────────────────────────────────────────────
 *  get-privacy — public read of appConfig/privacy for the website
 *
 *  Direct parallel to handleGetTerms. Same caching, same stub
 *  fallback, same shape. Privacy is also public-by-design — there's
 *  no point hiding the policy that explains what we do with user
 *  data behind a login.
 * ───────────────────────────────────────────────────────────── */
async function handleGetPrivacy(_req: VercelRequest, res: VercelResponse) {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('privacy').get()
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
    if (!snap.exists) {
      return res.status(200).json({
        ok: true,
        version: 0,
        lastUpdated: '',
        sections: [
          {
            title: 'מדיניות הפרטיות טרם פורסמה',
            paragraphs: [
              'מדיניות הפרטיות המלאה זמינה בתוכנת ניהול הורדות פלוס לאחר התקנה.',
              'בכל שאלה אפשר לפנות אלינו במייל: dyshalts@gmail.com',
            ],
          },
        ],
      })
    }
    const data = snap.data() as {
      version?: number
      lastUpdated?: string
      sections?: Array<{ title: string; paragraphs: string[] }>
    }
    return res.status(200).json({
      ok: true,
      version: typeof data.version === 'number' ? data.version : 0,
      lastUpdated:
        typeof data.lastUpdated === 'string' ? data.lastUpdated : '',
      sections: Array.isArray(data.sections) ? data.sections : [],
    })
  } catch (err) {
    console.error('[paypal/get-privacy] failed:', err)
    return res.status(500).json({
      ok: false,
      error: 'לא הצלחנו לטעון את מדיניות הפרטיות כרגע. נסו שוב.',
    })
  }
}

async function handleAdminGrantPro(req: VercelRequest, res: VercelResponse) {
  const body = req.body as {
    idToken?: string
    targetEmail?: string
    days?: number
    reason?: string
  }
  const idToken = (body.idToken || '').trim()
  const targetEmail = (body.targetEmail || '').trim().toLowerCase()
  const days = typeof body.days === 'number' ? Math.floor(body.days) : 30
  const reason = (body.reason || '').slice(0, 200) || 'admin grant'

  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'missing id token' })
  }
  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל יעד לא תקינה' })
  }
  if (days <= 0 || days > 365 * 5) {
    return res
      .status(400)
      .json({ ok: false, error: 'מספר ימים לא תקין (1–1825)' })
  }
  let adminEmail: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken)
    adminEmail = (decoded.email || '').toLowerCase()
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid id token' })
  }
  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }

  // Look up the target Firebase user by email so we can bind the
  // key to their uid (and not just dangle it on an email).
  let targetUid: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const targetRecord = await getAuth(getFirebase()).getUserByEmail(targetEmail)
    targetUid = targetRecord.uid
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'auth/user-not-found') {
      return res
        .status(404)
        .json({ ok: false, error: 'משתמש עם המייל הזה לא קיים' })
    }
    console.error('[paypal/admin-grant-pro] getUserByEmail failed:', err)
    return res.status(500).json({ ok: false, error: 'lookup failed' })
  }

  const db = getDb()

  // Account-lock: unlink any prior keys the target had so the new
  // key becomes their primary. Symmetric to /api/keys/redeem and
  // the webhook auto-redeem branch.
  const priorKeysSnap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', targetUid)
    .get()
  const replacedAt = new Date().toISOString()

  const newKey = generateKeyString()
  const expiresAt = new Date(Date.now() + days * 86_400_000)
  const replacedPriorKeys: string[] = []

  for (const d of priorKeysSnap.docs) {
    replacedPriorKeys.push(d.id)
    try {
      await d.ref.update({
        redeemedBy: null,
        redeemedByEmail: null,
        replacedAt,
        replacedByKey: newKey,
      })
    } catch (err) {
      console.warn(
        `[admin-grant-pro] failed to unlink prior key ${d.id}:`,
        err,
      )
    }
  }

  await db.collection('productKeys').doc(newKey).set({
    key: newKey,
    tier: 'pro',
    redeemedBy: targetUid,
    redeemedByEmail: targetEmail,
    redeemedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    createdBy: `admin-grant:${adminEmail}`,
    buyerEmail: targetEmail,
    grantReason: reason,
    grantedByAdmin: adminEmail,
    grantedDays: days,
    replacedPriorKeys,
    // Mark as a non-paid grant so it doesn't appear in billing
    // history queries or annual-report cron sums.
    nonPaidGrant: true,
  })

  // Fire the Pro-activated email so the target knows what
  // happened. Don't fail the grant on a mail failure (it's a
  // best-effort notification, not a contract).
  try {
    await sendProActivatedEmail({
      to: targetEmail,
      key: newKey,
      validUntil: expiresAt,
    })
  } catch (err) {
    console.error('[admin-grant-pro] pro-activated email failed:', err)
  }

  return res.status(200).json({
    ok: true,
    key: newKey,
    expiresAt: expiresAt.toISOString(),
    replacedPriorKeys,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Referral partners — attribute signups to a promoter.
 *
 *  Each partner has a short URL-safe code; the share link is
 *  dmplus.net/?ref=<code>. The code is captured in the browser and
 *  stamped onto the ACCOUNT at signup (see signup-verify-code), so
 *  any later purchase by that account is attributable to the partner
 *  (the account is the anchor — not the purchase).
 * ────────────────────────────────────────────────────────────── */

const REFERRAL_LINK_BASE = 'https://dmplus.net'

interface ReferralPartnerDoc {
  name: string
  code: string
  createdAt: string
  createdBy: string
  signups: number
  // Commission agreement (optional). 'percent' = commissionValue% of
  // each charge (in the charge's currency). 'fixed' = commissionValue
  // per charge in commissionCurrency (default ILS).
  commissionType?: 'percent' | 'fixed'
  commissionValue?: number
  commissionCurrency?: string
  // What the partner sees on their dashboard (modular). Positive
  // flags — if both money flags are off, the partner sees no money.
  visibility?: { revenue?: boolean; earnings?: boolean; counts?: boolean }
}

interface PartnerVisibility {
  revenue: boolean
  earnings: boolean
  counts: boolean
}
const DEFAULT_VISIBILITY: PartnerVisibility = {
  revenue: false,
  earnings: true,
  counts: true,
}
function resolveVisibility(
  v: { revenue?: boolean; earnings?: boolean; counts?: boolean } | undefined,
): PartnerVisibility {
  if (!v) return { ...DEFAULT_VISIBILITY }
  return {
    revenue: v.revenue === true,
    earnings: v.earnings === true,
    counts: v.counts === true,
  }
}

/** Validate + normalise commission fields from a request body. Returns
 *  null when no (valid) commission was provided. */
function parseCommission(body: {
  commissionType?: unknown
  commissionValue?: unknown
  commissionCurrency?: unknown
}): { commissionType: 'percent' | 'fixed'; commissionValue: number; commissionCurrency: string } | null {
  const type = body.commissionType
  if (type !== 'percent' && type !== 'fixed') return null
  const value = Number(body.commissionValue)
  if (!isFinite(value) || value <= 0) return null
  if (type === 'percent' && value > 100) return null
  const currency = (String(body.commissionCurrency || 'ILS') || 'ILS')
    .toUpperCase()
    .slice(0, 8)
  return { commissionType: type, commissionValue: value, commissionCurrency: currency }
}

/** Compute a partner's earnings from gross figures, per their
 *  commission. percent → gross×%; fixed → count×value (single
 *  currency). Returns { byCurrency, byMonth } of EARNINGS (not gross). */
function computeEarnings(
  commission: { commissionType: 'percent' | 'fixed'; commissionValue: number; commissionCurrency: string } | null,
  grossByCurrency: Record<string, number>,
  grossByMonth: Record<string, Record<string, number>>,
  countByMonth: Record<string, number>,
): { byCurrency: Record<string, number>; byMonth: Record<string, Record<string, number>> } {
  if (!commission) return { byCurrency: {}, byMonth: {} }
  if (commission.commissionType === 'percent') {
    const f = commission.commissionValue / 100
    const byCurrency: Record<string, number> = {}
    for (const [c, v] of Object.entries(grossByCurrency)) byCurrency[c] = v * f
    const byMonth: Record<string, Record<string, number>> = {}
    for (const [m, rev] of Object.entries(grossByMonth)) {
      byMonth[m] = {}
      for (const [c, v] of Object.entries(rev)) byMonth[m][c] = v * f
    }
    return { byCurrency, byMonth }
  }
  // fixed: value per charge, in the commission currency.
  const cur = commission.commissionCurrency
  const val = commission.commissionValue
  let totalCount = 0
  const byMonth: Record<string, Record<string, number>> = {}
  for (const [m, n] of Object.entries(countByMonth)) {
    totalCount += n
    byMonth[m] = { [cur]: n * val }
  }
  return { byCurrency: { [cur]: totalCount * val }, byMonth }
}

/** Verify the caller is an admin. Returns the admin email or null. */
async function verifyAdminEmail(idToken: string): Promise<string | null> {
  if (!idToken) return null
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken.trim())
    const email = (decoded.email || '').toLowerCase()
    return ADMIN_EMAILS.includes(email) ? email : null
  } catch {
    return null
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Admin 2FA — email-code second factor for the website /admin panel
 *
 *  The desktop admin panel has no 2FA (the Firebase password is the
 *  only gate). The website surface is a PUBLIC URL, so we add a
 *  per-login email code on top:
 *
 *    1. Admin signs into Firebase (email/password) in the browser →
 *       gets a real idToken (the same token every admin endpoint
 *       already verifies).
 *    2. /admin calls admin-2fa-request {idToken} → we confirm the
 *       email is in ADMIN_EMAILS, generate a 6-digit code, store it
 *       hashed in adminLoginCodes/{emailKey} (10-min TTL), email it.
 *    3. Admin enters the code → admin-2fa-verify {idToken, code} →
 *       on success we mint a short-lived admin token (HMAC JWT,
 *       use:'admin', 12h). The panel sends BOTH idToken AND this
 *       admin token on every data call; verifyAdmin2FA() requires
 *       both, so the email code is a real server-enforced boundary
 *       (not merely a UI gate) for all the new admin data endpoints.
 * ────────────────────────────────────────────────────────────── */

const ADMIN_2FA_TTL_SECONDS = 12 * 60 * 60

interface AdminTokenClaims {
  email: string
  use: 'admin'
  iat: number
  exp: number
}

function signAdminToken(email: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ADMIN_2FA_TTL_SECONDS
  const claims: AdminTokenClaims = { email, use: 'admin', iat, exp }
  const header = b64urlEncode(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', use: 'admin' })),
  )
  const payload = b64urlEncode(Buffer.from(JSON.stringify(claims)))
  const sig = b64urlEncode(
    crypto
      .createHmac('sha256', tokenSecret())
      .update(`${header}.${payload}`)
      .digest(),
  )
  return `${header}.${payload}.${sig}`
}

function verifyAdminToken(token: string): AdminTokenClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [h, p, s] = parts
    const expected = crypto
      .createHmac('sha256', tokenSecret())
      .update(`${h}.${p}`)
      .digest()
    const actual = b64urlDecode(s)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(b64urlDecode(p).toString('utf8')) as AdminTokenClaims
    if (claims.use !== 'admin') return null
    if (!claims.email || !ADMIN_EMAILS.includes(claims.email.toLowerCase())) {
      return null
    }
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    return claims
  } catch {
    return null
  }
}

/** Gate for all NEW web-admin data endpoints. Requires BOTH a valid
 *  Firebase admin idToken AND a valid 2FA admin token for the SAME
 *  email. Returns the admin email, or null (caller should 403). */
async function verifyAdmin2FA(req: VercelRequest): Promise<string | null> {
  const body = (req.body || {}) as { idToken?: string; adminToken?: string }
  // IP allowlist is the OUTERMOST gate for the web admin surface.
  if (!(await isAdminIpAllowed(getClientIp(req)))) return null
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return null
  const claims = verifyAdminToken((body.adminToken || '').trim())
  if (!claims) return null
  if (claims.email.toLowerCase() !== email.toLowerCase()) return null
  return email
}

/* ──────────────────────────────────────────────────────────────
 *  Admin IP allowlist — restricts the website /admin surface to a
 *  set of approved public IPs, configured from the DESKTOP app.
 *
 *  Design:
 *    - Stored in adminSecurity/config { ipAllowlist: string[] }
 *      (Admin SDK only — never written from a browser client).
 *    - EMPTY list = BLOCK ALL (the operator's choice): the web
 *      /admin is dark until at least one IP is approved from the
 *      desktop. The DESKTOP management endpoints are deliberately
 *      NOT IP-gated, so the operator can never lock themselves out
 *      of the list itself.
 *    - Applied to admin-2fa-request / admin-2fa-verify and the
 *      verifyAdmin2FA() data gate — i.e. the whole web admin flow.
 * ────────────────────────────────────────────────────────────── */

function getClientIp(req: VercelRequest): string {
  const xff = (req.headers['x-forwarded-for'] as string | undefined) || ''
  const first = xff.split(',')[0]?.trim()
  if (first) return normalizeIp(first)
  const real = (req.headers['x-real-ip'] as string | undefined) || ''
  if (real) return normalizeIp(real)
  return normalizeIp((req.socket?.remoteAddress as string) || '')
}

/** Normalise for comparison: lowercase, strip an IPv4-mapped IPv6
 *  prefix (::ffff:1.2.3.4 → 1.2.3.4), drop a :port suffix on IPv4. */
function normalizeIp(ip: string): string {
  let s = (ip || '').trim().toLowerCase()
  if (s.startsWith('::ffff:')) s = s.slice(7)
  // IPv4 with port (1.2.3.4:5678) — keep only the address.
  const m = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/)
  if (m) s = m[1]
  return s
}

async function getAdminIpAllowlist(): Promise<string[]> {
  try {
    const snap = await getDb().collection('adminSecurity').doc('config').get()
    if (!snap.exists) return []
    const raw = (snap.data() as { ipAllowlist?: unknown }).ipAllowlist
    if (!Array.isArray(raw)) return []
    return raw.map((x) => normalizeIp(String(x))).filter(Boolean)
  } catch {
    // Fail CLOSED on a read error — security gate must not open on
    // infrastructure hiccups.
    return ['__read_error__']
  }
}

async function isAdminIpAllowed(ip: string): Promise<boolean> {
  const list = await getAdminIpAllowlist()
  if (list.includes('__read_error__')) return false
  // Empty = block all (operator's explicit choice).
  if (list.length === 0) return false
  return list.includes(normalizeIp(ip))
}

/** Public — lets /admin decide whether to render anything at all.
 *  Echoes the caller's own IP so the operator can see what to
 *  whitelist. Reveals only the caller's own IP + a boolean. */
async function handleAdminIpAllowed(req: VercelRequest, res: VercelResponse) {
  const ip = getClientIp(req)
  const allowed = await isAdminIpAllowed(ip)
  return res.status(200).json({ ok: true, allowed, ip })
}

/** Desktop-facing: read the current allowlist + the caller's IP.
 *  Gated by admin idToken only (NOT IP-gated) so the operator can
 *  always manage it from the trusted desktop app. */
async function handleAdminGetIpAllowlist(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })
  return res.status(200).json({
    ok: true,
    ips: await getAdminIpAllowlist().then((l) =>
      l.filter((x) => x !== '__read_error__'),
    ),
    currentIp: getClientIp(req),
  })
}

/** Desktop-facing: replace the allowlist. NOT IP-gated (see above). */
async function handleAdminSetIpAllowlist(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string; ips?: unknown }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })

  const raw = Array.isArray(body.ips) ? body.ips : []
  const cleaned: string[] = []
  for (const item of raw) {
    const ip = normalizeIp(String(item))
    if (!ip) continue
    if (!isValidIp(ip)) {
      return res
        .status(400)
        .json({ ok: false, error: `כתובת IP לא תקינה: ${item}` })
    }
    if (!cleaned.includes(ip)) cleaned.push(ip)
  }
  if (cleaned.length > 20) {
    return res.status(400).json({ ok: false, error: 'מקסימום 20 כתובות.' })
  }

  await getDb()
    .collection('adminSecurity')
    .doc('config')
    .set(
      { ipAllowlist: cleaned, updatedAt: Date.now(), updatedBy: email },
      { merge: true },
    )
  return res.status(200).json({ ok: true, ips: cleaned })
}

function isValidIp(ip: string): boolean {
  // IPv4
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) {
    return ip.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255)
  }
  // IPv6 (loose — accepts the common forms; we only string-compare).
  return /^[0-9a-f:]+$/.test(ip) && ip.includes(':')
}

/* ──────────────────────────────────────────────────────────────
 *  Admin → Users tab. All gated by verifyAdmin2FA (Firebase admin
 *  idToken + email-code 2FA token + IP allowlist). These mirror the
 *  desktop firestore.ts admin helpers, but run server-side via the
 *  Admin SDK so the browser never holds a privileged Firestore
 *  session.
 * ────────────────────────────────────────────────────────────── */

/** Read all users + a uid→redeemed-key index in one shot. */
async function handleAdminListUsers(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const db = getDb()
  const [usersSnap, keysSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('productKeys').get(),
  ])

  const users = usersSnap.docs.map((d) => ({
    ...(d.data() as Record<string, unknown>),
    uid: d.id,
  }))

  // uid → the key they've redeemed (for the Pro badge + key chip).
  const keysByUid: Record<string, unknown> = {}
  for (const k of keysSnap.docs) {
    const data = k.data() as { redeemedBy?: string | null }
    if (data.redeemedBy) {
      keysByUid[data.redeemedBy] = { ...(data as object), id: k.id }
    }
  }

  return res.status(200).json({ ok: true, users, keysByUid })
}

async function handleAdminSetUserBlocked(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string; blocked?: boolean }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  await getDb()
    .collection('users')
    .doc(uid)
    .update({ blocked: body.blocked === true })
  return res.status(200).json({ ok: true })
}

async function handleAdminSetUserRole(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string; role?: string }
  const uid = String(body.uid || '').trim()
  const role = body.role === 'admin' ? 'admin' : 'user'
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  await getDb().collection('users').doc(uid).update({ role })
  return res.status(200).json({ ok: true })
}

/** Free/Pro flip. On demote to free we ALSO release every product
 *  key this user redeemed + reject any active trial — otherwise the
 *  demotion is cosmetic (key/trial would still grant Pro). Mirrors
 *  setUserSubscription in the desktop firestore.ts. */
async function handleAdminSetUserSubscription(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string; subscription?: string }
  const uid = String(body.uid || '').trim()
  const sub = body.subscription === 'pro' ? 'pro' : 'free'
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  const db = getDb()

  if (sub === 'free') {
    try {
      const keysSnap = await db
        .collection('productKeys')
        .where('redeemedBy', '==', uid)
        .get()
      await Promise.all(
        keysSnap.docs.map((k) =>
          k.ref.update({
            redeemedBy: null,
            redeemedByEmail: null,
            redeemedAt: null,
          }),
        ),
      )
    } catch (err) {
      console.warn('[admin] release keys on demote failed:', err)
    }
  }

  const patch: Record<string, unknown> = { subscription: sub }
  if (sub === 'free') patch.trialStatus = 'rejected'
  await db.collection('users').doc(uid).update(patch)
  return res.status(200).json({ ok: true })
}

async function handleAdminClearUserDevice(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  await getDb()
    .collection('users')
    .doc(uid)
    .update({ deviceId: null, deviceLockedAt: null })
  return res.status(200).json({ ok: true })
}

/** Manually grant a trial (the "ניסיון" plan chip). Demote a Pro
 *  user to free first so the trial state is actually visible. */
async function handleAdminApproveTrial(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as {
    uid?: string
    days?: number
    demoteFirst?: boolean
  }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  const days = Math.max(1, Math.min(365, Math.floor(Number(body.days) || 14)))
  const db = getDb()

  if (body.demoteFirst) {
    await db
      .collection('users')
      .doc(uid)
      .update({ subscription: 'free' })
      .catch(() => undefined)
  }

  const now = new Date()
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  await db.collection('users').doc(uid).update({
    trialStatus: 'approved',
    trialApprovedAt: now.toISOString(),
    trialExpiresAt: expires.toISOString(),
    trialApprovedBy: admin,
  })
  return res.status(200).json({ ok: true })
}

async function handleAdmin2faRequest(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  if (!(await isAdminIpAllowed(getClientIp(req)))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })

  // Rate-limit: a logged-in admin shouldn't need many codes.
  const allowed = await tryRateLimit(
    `admin-2fa_${sanitizeEmailKey(email)}`,
    8,
    60 * 60,
  )
  if (!allowed) {
    return res
      .status(429)
      .json({ ok: false, error: 'יותר מדי בקשות. נסה שוב מאוחר יותר.' })
  }

  const code = String(Math.floor(100000 + Math.random() * 900000))
  const ttlSecs = 10 * 60
  const salt = process.env.RENEW_TOKEN_SECRET || 'unset'
  await getDb()
    .collection('adminLoginCodes')
    .doc(sanitizeEmailKey(email))
    .set({
      email,
      codeHash: hashCode(code, salt),
      expiresAt: Date.now() + ttlSecs * 1000,
      attempts: 0,
      createdAt: Date.now(),
    })

  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    return res
      .status(500)
      .json({ ok: false, error: 'שירות שליחת המייל לא מוגדר.' })
  }
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  })
  const html = renderEmail({
    heading: 'קוד כניסה לפאנל הניהול',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
        מישהו מנסה להיכנס לפאנל הניהול. הזן את הקוד הזה כדי לאשר את הכניסה:
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:36px;letter-spacing:8px;font-weight:700;font-family:ui-monospace,monospace;color:#D4A574;">${code}</div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
        הקוד תקף ל-10 דקות. אם זה לא אתה — מישהו יודע את הסיסמה שלך; החלף אותה מיד.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: email,
    subject: `קוד כניסה לאדמין: ${code} — ניהול הורדות פלוס`,
    html,
    text: `קוד הכניסה לפאנל הניהול: ${code}\nתקף ל-10 דקות.`,
  })

  return res.status(200).json({ ok: true })
}

async function handleAdmin2faVerify(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string; code?: string }
  if (!(await isAdminIpAllowed(getClientIp(req)))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'קוד לא תקין' })
  }

  const db = getDb()
  const ref = db.collection('adminLoginCodes').doc(sanitizeEmailKey(email))
  const snap = await ref.get()
  if (!snap.exists) {
    return res.status(400).json({ ok: false, error: 'לא נמצא קוד. בקש קוד חדש.' })
  }
  const data = snap.data() as {
    codeHash: string
    expiresAt: number
    attempts: number
  }
  if (Date.now() > data.expiresAt) {
    await ref.delete().catch(() => undefined)
    return res.status(400).json({ ok: false, error: 'הקוד פג תוקף. בקש קוד חדש.' })
  }
  if ((data.attempts || 0) >= 6) {
    await ref.delete().catch(() => undefined)
    return res
      .status(429)
      .json({ ok: false, error: 'יותר מדי ניסיונות. בקש קוד חדש.' })
  }
  const salt = process.env.RENEW_TOKEN_SECRET || 'unset'
  if (hashCode(code, salt) !== data.codeHash) {
    await ref.update({ attempts: (data.attempts || 0) + 1 }).catch(() => undefined)
    return res.status(400).json({ ok: false, error: 'קוד שגוי.' })
  }

  // Success — burn the code, mint the 12h admin token.
  await ref.delete().catch(() => undefined)
  return res.status(200).json({ ok: true, adminToken: signAdminToken(email) })
}

/** Latin slug from a partner name (non-latin → empty → random base). */
function slugifyRefCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

async function handleAdminCreateReferral(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    idToken?: string
    name?: string
    code?: string
    loginEmail?: string
    password?: string
  }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const name = (body.name || '').trim().slice(0, 80)
  if (!name) return res.status(400).json({ ok: false, error: 'יש להזין שם' })
  const loginEmail = (body.loginEmail || '').trim().toLowerCase()
  const password = body.password || ''
  if (loginEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל כניסה לא תקין' })
  }
  if (password && password.length < 6) {
    return res
      .status(400)
      .json({ ok: false, error: 'סיסמה חייבת להיות לפחות 6 תווים' })
  }

  const db = getDb()
  // Explicit code (admin-chosen) takes precedence; otherwise derive a
  // slug from the name. The code is what appears in the share link.
  const requestedCode = slugifyRefCode(body.code || '')
  let code: string
  if (requestedCode) {
    if (requestedCode.length < 2) {
      return res
        .status(400)
        .json({ ok: false, error: 'הקוד חייב להכיל לפחות 2 תווים (אותיות/ספרות)' })
    }
    const taken = (await db.collection('referralPartners').doc(requestedCode).get())
      .exists
    if (taken) {
      return res
        .status(409)
        .json({ ok: false, error: 'הקוד הזה כבר תפוס — בחרו קוד אחר' })
    }
    code = requestedCode
  } else {
    const base =
      slugifyRefCode(name) || `ref-${crypto.randomBytes(3).toString('hex')}`
    code = base
    for (let i = 0; i < 5; i++) {
      const exists = (await db.collection('referralPartners').doc(code).get())
        .exists
      if (!exists) break
      code = `${base}-${crypto.randomBytes(2).toString('hex')}`
    }
  }
  const doc: ReferralPartnerDoc & {
    loginEmail?: string
    passwordHash?: string
  } = {
    name,
    code,
    createdAt: new Date().toISOString(),
    createdBy: admin,
    signups: 0,
  }
  if (loginEmail) doc.loginEmail = loginEmail
  if (loginEmail && password) doc.passwordHash = hashPartnerPassword(password)
  const commission = parseCommission(
    req.body as { commissionType?: unknown; commissionValue?: unknown; commissionCurrency?: unknown },
  )
  if (commission) {
    doc.commissionType = commission.commissionType
    doc.commissionValue = commission.commissionValue
    doc.commissionCurrency = commission.commissionCurrency
  }
  await db.collection('referralPartners').doc(code).set(doc)
  return res.status(200).json({
    ok: true,
    code,
    name,
    link: `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(code)}`,
  })
}

async function handleAdminListReferrals(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const db = getDb()
  const snap = await db
    .collection('referralPartners')
    .orderBy('createdAt', 'desc')
    .get()
  const partners = snap.docs.map((d) => {
    const data = d.data() as ReferralPartnerDoc
    return {
      code: data.code,
      name: data.name,
      signups: typeof data.signups === 'number' ? data.signups : 0,
      createdAt: data.createdAt,
      link: `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(data.code)}`,
    }
  })
  return res.status(200).json({ ok: true, partners })
}

async function handleAdminDeleteReferral(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  // Delete only the partner record. Existing users/keys keep their
  // referredBy stamp for historical accuracy — the report still shows
  // the code even if the partner was removed.
  await getDb().collection('referralPartners').doc(code).delete()
  return res.status(200).json({ ok: true })
}

/** Per-partner report: signups, paying accounts, and total revenue
 *  (summed from each attributed key's billingHistory). */
async function handleAdminReferralReport(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const db = getDb()
  const partnersSnap = await db
    .collection('referralPartners')
    .orderBy('createdAt', 'desc')
    .get()

  const rows = []
  for (const d of partnersSnap.docs) {
    const data = d.data() as ReferralPartnerDoc & { loginEmail?: string }
    // Keys attributed to this partner (revenue source).
    const keysSnap = await db
      .collection('productKeys')
      .where('referredBy', '==', data.code)
      .get()
    let paidAccounts = 0
    let paymentCount = 0
    const revenueByCurrency: Record<string, number> = {}
    for (const k of keysSnap.docs) {
      const kd = k.data() as {
        nonPaidGrant?: boolean
        billingHistory?: Array<{ amount?: number; currency?: string }>
      }
      if (kd.nonPaidGrant) continue
      const hist = Array.isArray(kd.billingHistory) ? kd.billingHistory : []
      if (hist.length > 0) paidAccounts++
      for (const h of hist) {
        const amt = typeof h.amount === 'number' ? h.amount : 0
        const cur = (h.currency || 'ILS').toUpperCase()
        revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt
        paymentCount++
      }
    }
    const commission =
      data.commissionType && data.commissionValue
        ? {
            commissionType: data.commissionType,
            commissionValue: data.commissionValue,
            commissionCurrency: data.commissionCurrency || 'ILS',
          }
        : null
    // Commission owed (what the admin pays the partner).
    const earningsByCurrency: Record<string, number> = {}
    if (commission?.commissionType === 'percent') {
      const f = commission.commissionValue / 100
      for (const [c, v] of Object.entries(revenueByCurrency)) {
        earningsByCurrency[c] = v * f
      }
    } else if (commission?.commissionType === 'fixed') {
      earningsByCurrency[commission.commissionCurrency] =
        paymentCount * commission.commissionValue
    }
    rows.push({
      code: data.code,
      name: data.name,
      signups: typeof data.signups === 'number' ? data.signups : 0,
      paidAccounts,
      revenueByCurrency,
      loginEmail: data.loginEmail || '',
      hasLogin: Boolean(data.loginEmail),
      commissionType: commission?.commissionType || null,
      commissionValue: commission?.commissionValue || null,
      commissionCurrency: commission?.commissionCurrency || null,
      earningsByCurrency,
      visibility: resolveVisibility(data.visibility),
    })
  }
  return res.status(200).json({ ok: true, partners: rows })
}

/** Full drill-down for one partner: every attributed account + the
 *  revenue broken down by calendar month. */
async function handleAdminReferralDetail(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const db = getDb()

  const [usersSnap, keysSnap] = await Promise.all([
    db.collection('users').where('referredBy', '==', code).get(),
    db.collection('productKeys').where('referredBy', '==', code).get(),
  ])

  const paidEmails = new Set<string>()
  const revenueByMonth: Record<string, Record<string, number>> = {}
  for (const k of keysSnap.docs) {
    const kd = k.data() as {
      nonPaidGrant?: boolean
      buyerEmail?: string
      redeemedByEmail?: string
      billingHistory?: Array<{ at?: string; amount?: number; currency?: string }>
    }
    if (kd.nonPaidGrant) continue
    const email = (kd.buyerEmail || kd.redeemedByEmail || '').toLowerCase()
    const hist = Array.isArray(kd.billingHistory) ? kd.billingHistory : []
    if (hist.length > 0 && email) paidEmails.add(email)
    for (const h of hist) {
      const d = h.at ? new Date(h.at) : null
      const month =
        d && !isNaN(d.getTime())
          ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
          : 'לא ידוע'
      const cur = (h.currency || 'ILS').toUpperCase()
      const amt = typeof h.amount === 'number' ? h.amount : 0
      revenueByMonth[month] = revenueByMonth[month] || {}
      revenueByMonth[month][cur] = (revenueByMonth[month][cur] || 0) + amt
    }
  }

  const accounts = usersSnap.docs
    .map((d) => {
      const u = d.data() as {
        email?: string
        createdAt?: string
        referredAt?: string
      }
      const email = (u.email || '').toLowerCase()
      return {
        email: u.email || '',
        createdAt: u.createdAt || u.referredAt || '',
        paid: paidEmails.has(email),
      }
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

  return res.status(200).json({ ok: true, accounts, revenueByMonth })
}

/** Payment-level export for one partner — every individual charge
 *  (initial + each recurring renewal) within an optional date range,
 *  with the buyer, their plan type, amount and timestamp. The desktop
 *  turns this into a CSV. */
async function handleAdminReferralExport(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    idToken?: string
    code?: string
    fromMs?: number
    toMs?: number
  }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const fromMs = typeof body.fromMs === 'number' ? body.fromMs : null
  const toMs = typeof body.toMs === 'number' ? body.toMs : null
  const db = getDb()

  const [partnerSnap, usersSnap, keysSnap] = await Promise.all([
    db.collection('referralPartners').doc(code).get(),
    db.collection('users').where('referredBy', '==', code).get(),
    db.collection('productKeys').where('referredBy', '==', code).get(),
  ])

  const emailToName: Record<string, string> = {}
  for (const u of usersSnap.docs) {
    const d = u.data() as { email?: string; name?: string }
    if (d.email) emailToName[d.email.toLowerCase()] = d.name || ''
  }

  const payments: Array<{
    at: string
    email: string
    name: string
    planType: 'monthly' | 'yearly'
    amount: number
    currency: string
  }> = []
  // Map each buyer email → their plan type (from their key) so the
  // accounts roster can show "חודשי/שנתי" even for users whose
  // payments fall outside the selected date range.
  const emailToPlan: Record<string, 'monthly' | 'yearly'> = {}

  for (const k of keysSnap.docs) {
    const kd = k.data() as {
      nonPaidGrant?: boolean
      buyerEmail?: string
      redeemedByEmail?: string
      subscriptionPlanDays?: number
      planDays?: number
      billingHistory?: Array<{ at?: string; amount?: number; currency?: string }>
    }
    if (kd.nonPaidGrant) continue
    const email = (kd.buyerEmail || kd.redeemedByEmail || '').toLowerCase()
    const days = kd.subscriptionPlanDays || kd.planDays || 30
    const planType: 'monthly' | 'yearly' = days >= 365 ? 'yearly' : 'monthly'
    if (email) emailToPlan[email] = planType
    for (const h of kd.billingHistory || []) {
      if (!h.at) continue
      const ms = Date.parse(h.at)
      if (isNaN(ms)) continue
      if (fromMs !== null && ms < fromMs) continue
      if (toMs !== null && ms > toMs) continue
      payments.push({
        at: h.at,
        email,
        name: emailToName[email] || '',
        planType,
        amount: typeof h.amount === 'number' ? h.amount : 0,
        currency: (h.currency || 'ILS').toUpperCase(),
      })
    }
  }

  payments.sort((a, b) => a.at.localeCompare(b.at))

  // Full roster: every account that came from this partner, paid or
  // not. The CSV lists these even with zero revenue.
  const accounts = usersSnap.docs
    .map((u) => {
      const d = u.data() as {
        email?: string
        name?: string
        createdAt?: string
        referredAt?: string
      }
      const email = (d.email || '').toLowerCase()
      return {
        email: d.email || '',
        name: d.name || '',
        createdAt: d.createdAt || d.referredAt || '',
        planType: emailToPlan[email] || null,
      }
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

  const partnerName =
    (partnerSnap.data() as { name?: string } | undefined)?.name || code
  return res
    .status(200)
    .json({ ok: true, partner: { code, name: partnerName }, payments, accounts })
}

/* ──────────────────────────────────────────────────────────────
 *  Partner self-serve dashboard auth.
 *
 *  A partner logs in at /partner with an email + password the admin
 *  set on their referralPartners doc. They see ONLY aggregate stats
 *  for their own code — never individual customer emails (privacy).
 * ────────────────────────────────────────────────────────────── */

/** scrypt password hash → "scrypt:<salt>:<hash>". */
function hashPartnerPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 32).toString('hex')
  return `scrypt:${salt}:${hash}`
}
function verifyPartnerPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = (stored || '').split(':')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const calc = crypto.scryptSync(password, salt, 32)
    const want = Buffer.from(hash, 'hex')
    return calc.length === want.length && crypto.timingSafeEqual(calc, want)
  } catch {
    return false
  }
}

interface PartnerClaims {
  code: string
  use: 'partner'
  iat: number
  exp: number
}
function signPartnerToken(code: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + 30 * 24 * 60 * 60 // 30 days
  const header = b64urlEncode(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', use: 'partner' })),
  )
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ code, use: 'partner', iat, exp })),
  )
  const sig = b64urlEncode(
    crypto.createHmac('sha256', tokenSecret()).update(`${header}.${payload}`).digest(),
  )
  return `${header}.${payload}.${sig}`
}
function verifyPartnerToken(token: string): PartnerClaims | null {
  try {
    const parts = (token || '').split('.')
    if (parts.length !== 3) return null
    const [h, p, s] = parts
    const expected = crypto
      .createHmac('sha256', tokenSecret())
      .update(`${h}.${p}`)
      .digest()
    const actual = b64urlDecode(s)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(b64urlDecode(p).toString('utf8')) as PartnerClaims
    if (claims.use !== 'partner' || !claims.code) return null
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

/** Aggregate stats for one partner code (no customer PII). */
async function computePartnerStats(code: string) {
  const db = getDb()
  const [partnerSnap, usersSnap, keysSnap] = await Promise.all([
    db.collection('referralPartners').doc(code).get(),
    db.collection('users').where('referredBy', '==', code).get(),
    db.collection('productKeys').where('referredBy', '==', code).get(),
  ])
  const paidEmails = new Set<string>()
  const grossByCurrency: Record<string, number> = {}
  const grossByMonth: Record<string, Record<string, number>> = {}
  const countByMonth: Record<string, number> = {}
  for (const k of keysSnap.docs) {
    const kd = k.data() as {
      nonPaidGrant?: boolean
      buyerEmail?: string
      redeemedByEmail?: string
      billingHistory?: Array<{ at?: string; amount?: number; currency?: string }>
    }
    if (kd.nonPaidGrant) continue
    const email = (kd.buyerEmail || kd.redeemedByEmail || '').toLowerCase()
    const hist = Array.isArray(kd.billingHistory) ? kd.billingHistory : []
    if (hist.length > 0 && email) paidEmails.add(email)
    for (const h of hist) {
      const cur = (h.currency || 'ILS').toUpperCase()
      const amt = typeof h.amount === 'number' ? h.amount : 0
      grossByCurrency[cur] = (grossByCurrency[cur] || 0) + amt
      const m = h.at ? h.at.slice(0, 7) : 'unknown'
      grossByMonth[m] = grossByMonth[m] || {}
      grossByMonth[m][cur] = (grossByMonth[m][cur] || 0) + amt
      countByMonth[m] = (countByMonth[m] || 0) + 1
    }
  }
  const data = partnerSnap.data() as ReferralPartnerDoc | undefined
  const commission =
    data?.commissionType && data?.commissionValue
      ? {
          commissionType: data.commissionType,
          commissionValue: data.commissionValue,
          commissionCurrency: data.commissionCurrency || 'ILS',
        }
      : null
  const earnings = computeEarnings(
    commission,
    grossByCurrency,
    grossByMonth,
    countByMonth,
  )
  const vis = resolveVisibility(data?.visibility)

  // MODULAR + PARTNER-SAFE: only the fields the admin allows this
  // partner to see are returned. Gross revenue is included ONLY when
  // visibility.revenue is on.
  return {
    code,
    name: data?.name || code,
    link: `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(code)}`,
    visibility: vis,
    signups: vis.counts ? usersSnap.size : null,
    paidAccounts: vis.counts ? paidEmails.size : null,
    commission: vis.earnings ? commission : null,
    earningsByCurrency: vis.earnings ? earnings.byCurrency : null,
    earningsByMonth: vis.earnings ? earnings.byMonth : null,
    revenueByCurrency: vis.revenue ? grossByCurrency : null,
    revenueByMonth: vis.revenue ? grossByMonth : null,
  }
}

/** POST { email, password } → { ok, token, partner } */
async function handlePartnerLogin(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { email?: string; password?: string }
  const email = (body.email || '').trim().toLowerCase()
  const password = body.password || ''
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'יש להזין מייל וסיסמה' })
  }
  const snap = await getDb()
    .collection('referralPartners')
    .where('loginEmail', '==', email)
    .limit(1)
    .get()
  if (snap.empty) {
    return res.status(401).json({ ok: false, error: 'מייל או סיסמה שגויים' })
  }
  const doc = snap.docs[0]
  const data = doc.data() as { passwordHash?: string }
  if (!data.passwordHash || !verifyPartnerPassword(password, data.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'מייל או סיסמה שגויים' })
  }
  const token = signPartnerToken(doc.id)
  const stats = await computePartnerStats(doc.id)
  return res.status(200).json({ ok: true, token, partner: stats })
}

/** POST { token } → { ok, partner } (fresh aggregates) */
async function handlePartnerStats(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { token?: string }
  const claims = verifyPartnerToken(body.token || '')
  if (!claims) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const stats = await computePartnerStats(claims.code)
  return res.status(200).json({ ok: true, partner: stats })
}

/** POST { idToken, code, loginEmail, password? } — admin sets/updates a
 *  partner's dashboard credentials. Empty password keeps the existing
 *  one (lets the admin change just the email). */
async function handleAdminSetReferralCredentials(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    idToken?: string
    code?: string
    loginEmail?: string
    password?: string
  }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  const loginEmail = (body.loginEmail || '').trim().toLowerCase()
  const password = body.password || ''
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  if (loginEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל לא תקין' })
  }
  const db = getDb()
  const ref = db.collection('referralPartners').doc(code)
  if (!(await ref.get()).exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  // Email must be unique across partners (login looks up by it).
  if (loginEmail) {
    const dup = await db
      .collection('referralPartners')
      .where('loginEmail', '==', loginEmail)
      .get()
    if (dup.docs.some((d) => d.id !== code)) {
      return res
        .status(409)
        .json({ ok: false, error: 'המייל הזה כבר משויך לשותף אחר' })
    }
  }
  const update: Record<string, unknown> = {}
  if (loginEmail) update.loginEmail = loginEmail
  if (password) {
    if (password.length < 6) {
      return res
        .status(400)
        .json({ ok: false, error: 'סיסמה חייבת להיות לפחות 6 תווים' })
    }
    update.passwordHash = hashPartnerPassword(password)
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ ok: false, error: 'אין מה לעדכן' })
  }
  await ref.update(update)
  return res.status(200).json({ ok: true })
}

/** POST { idToken, code, commissionType, commissionValue, commissionCurrency? }
 *  — admin sets/updates a partner's commission agreement. Send
 *  commissionType:'none' (or invalid) to clear it. */
async function handleAdminSetReferralCommission(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const db = getDb()
  const ref = db.collection('referralPartners').doc(code)
  if (!(await ref.get()).exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  const commission = parseCommission(
    req.body as {
      commissionType?: unknown
      commissionValue?: unknown
      commissionCurrency?: unknown
    },
  )
  if (commission) {
    await ref.update({
      commissionType: commission.commissionType,
      commissionValue: commission.commissionValue,
      commissionCurrency: commission.commissionCurrency,
    })
  } else {
    // Clear the agreement.
    await ref.update({
      commissionType: FieldValue.delete(),
      commissionValue: FieldValue.delete(),
      commissionCurrency: FieldValue.delete(),
    })
  }
  return res.status(200).json({ ok: true })
}

/** POST { idToken, code, visibility:{revenue,earnings,counts} } — admin
 *  sets what the partner sees on their dashboard. */
async function handleAdminSetReferralVisibility(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    idToken?: string
    code?: string
    visibility?: { revenue?: boolean; earnings?: boolean; counts?: boolean }
  }
  const admin = await verifyAdminEmail(body.idToken || '')
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const ref = getDb().collection('referralPartners').doc(code)
  if (!(await ref.get()).exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  await ref.update({ visibility: resolveVisibility(body.visibility) })
  return res.status(200).json({ ok: true })
}

/** Stamp a referral onto a freshly-created account. Best-effort —
 *  an unknown code is silently ignored, and any error never fails
 *  the signup. */
async function stampReferralOnSignup(
  uid: string,
  rawRef: string | undefined,
): Promise<void> {
  const code = (rawRef || '').trim().slice(0, 40)
  if (!code) return
  try {
    const db = getDb()
    const partnerRef = db.collection('referralPartners').doc(code)
    if (!(await partnerRef.get()).exists) return // unknown code → ignore
    await db
      .collection('users')
      .doc(uid)
      .set(
        { referredBy: code, referredAt: new Date().toISOString() },
        { merge: true },
      )
    await partnerRef
      .update({ signups: FieldValue.increment(1) })
      .catch(() => undefined)
  } catch (err) {
    console.warn('[referral] stamp on signup failed (continuing):', err)
  }
}
