import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import {
  getFirestore,
  FieldValue,
  Timestamp,
  type Firestore,
} from 'firebase-admin/firestore'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import nodemailer from 'nodemailer'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'

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
  // 7-day trial): use literal day arithmetic, which is what the
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
  /** When set, `amount` becomes the RECURRING price and this is the
   *  one-cycle introductory (paid-trial) price — a "first period only"
   *  coupon. The buyer pays introAmount for cycle 1, then `amount`
   *  every cycle after. */
  introAmount?: number
}): Promise<string> {
  const frequency =
    args.interval === 'monthly'
      ? { interval_unit: 'MONTH', interval_count: 1 }
      : { interval_unit: 'YEAR', interval_count: 1 }
  // Intro plans get TWO cycles: a paid TRIAL cycle (1×, discounted)
  // then the standard REGULAR cycle (∞, full price). Plain plans keep
  // the single REGULAR cycle.
  const billing_cycles =
    args.introAmount != null
      ? [
          {
            frequency,
            tenure_type: 'TRIAL',
            sequence: 1,
            total_cycles: 1,
            pricing_scheme: {
              fixed_price: {
                value: args.introAmount.toFixed(2),
                currency_code: args.currency,
              },
            },
          },
          {
            frequency,
            tenure_type: 'REGULAR',
            sequence: 2,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: args.amount.toFixed(2),
                currency_code: args.currency,
              },
            },
          },
        ]
      : [
          {
            frequency,
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: args.amount.toFixed(2),
                currency_code: args.currency,
              },
            },
          },
        ]
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
      billing_cycles,
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
 *  Kill switch (maintenance mode)
 *
 *  A master switch stored in appConfig/global.killSwitch. When ON,
 *  the user-facing data actions below return 503 ("under maintenance")
 *  while EVERY admin / auth / passkey / webhook action stays alive so
 *  the operator can always turn it back off and PayPal events are not
 *  lost.
 *
 *  Cost discipline: the flag is cached in-memory per serverless
 *  instance for KILL_TTL_MS, so checking it costs at most ~1 Firestore
 *  read per instance per 30s — NOT one read per request. It also fails
 *  OPEN: any read error is treated as "not killed" so a transient
 *  Firestore hiccup can never brick the live site.
 * ───────────────────────────────────────────────────────────── */
let killCache: { value: boolean; ts: number } | null = null
const KILL_TTL_MS = 30_000
/** Public actions blocked while maintenance mode is ON. Admin, auth,
 *  passkey, gate, webhook and the static get-* config reads are NOT
 *  here — they must keep working so the operator can recover and the
 *  marketing pages still render. */
const KILL_BLOCKED_ACTIONS = new Set<string>([
  'create-subscription',
  'session',
  'restore-session',
  'sso',
  'status',
  'cancel',
  'billing-history',
  'signup-request-code',
  'signup-verify-code',
  'verify-existing-request-code',
  'verify-existing-confirm-code',
  'mint-renew-token',
  'update-marketing-opt-in',
  'partner-login',
  'partner-stats',
])
async function isSiteKilled(): Promise<boolean> {
  const now = Date.now()
  if (killCache && now - killCache.ts < KILL_TTL_MS) return killCache.value
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    const v =
      snap.exists && (snap.data() as { killSwitch?: boolean }).killSwitch === true
    killCache = { value: v, ts: now }
    return v
  } catch {
    return false // fail open — never brick the site on a read error
  }
}
/** Let a config write update the cache immediately (so the operator
 *  sees the switch take effect without waiting out the TTL). */
function primeKillCache(value: boolean): void {
  killCache = { value, ts: Date.now() }
}

/* ── Telegram alerts (operational push to the owner) ───────────────
 *  Uses a DEDICATED alert bot + chat, separate from the feedback bot,
 *  so operational alerts (failed webhook, failed customer payment,
 *  dispute, kill-switch, server errors) land in their own group.
 *  Configure TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID; if
 *  either is missing, alerts are simply skipped. Best-effort: any error
 *  is swallowed — an alert can NEVER break the main flow. */
async function sendTelegramAlert(
  text: string,
  opts?: { replyMarkup?: unknown },
): Promise<void> {
  try {
    const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
    if (!token || !chatId) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
    })
  } catch (e) {
    console.error('[telegram-alert] failed:', e)
  }
}

/** De-dupe burst alerts: at most one alert per key per window, so an
 *  incident that throws repeatedly doesn't flood the chat. */
const recentAlerts = new Map<string, number>()
function alertNotThrottled(key: string, windowMs = 60_000): boolean {
  const now = Date.now()
  const last = recentAlerts.get(key) || 0
  if (now - last < windowMs) return false
  recentAlerts.set(key, now)
  return true
}

/* ─────────────────────────────────────────────────────────────
 *  Backups — full logical snapshot of Firestore → Cloudflare R2
 *
 *  One JSON object per backup under the `backups/` prefix in the same
 *  R2 bucket used for revision media (free up to 10GB). Every document
 *  is captured by its FULL PATH (via collectionGroup) so nested
 *  subcollections (e.g. notes) are included and a restore is exact.
 *  Firestore Timestamps are tagged so they survive the JSON round-trip.
 *
 *  Cost: R2 storage is tiny (KBs–MBs); the only Firestore cost is the
 *  reads to build a backup (~1 read/doc), well within the free daily
 *  allowance at this scale. Same R2 creds as api/revisions.ts.
 * ───────────────────────────────────────────────────────────── */
const BACKUP_BUCKET = process.env.R2_BUCKET || ''
const BACKUP_PREFIX = 'backups/'
/** Collections captured in a backup. collectionGroup() matches each by
 *  name at ANY depth, so this covers both top-level collections and
 *  nested subcollections like `notes`. Transient/regenerable data
 *  (rate limits, login codes, webhook-dedupe log, etc.) is excluded. */
const BACKUP_COLLECTIONS = [
  'productKeys',
  'users',
  'appConfig',
  // Admin-only persistent config (sibling of appConfig): logs password,
  // Pro/trial storage quotas, and the עוסק identity + signature for the
  // 8356 PDF. Set manually by the admin and not derivable from anything
  // else, so it MUST be in the backup — appConfig alone isn't enough.
  'adminConfig',
  'referralPartners',
  'receipts',
  // Permanent, key-independent tax ledger behind the עסקת אקראי
  // report — must survive even if a key is deleted, so it has to be in
  // the backup alongside receipts (both are tax records).
  'casualLedger',
  'trialFingerprints',
  'usageStats',
  // Aggregate counters (email sends, etc.) — durable, cheap to store.
  'metrics',
  'feedback',
  'integrations',
  'pendingSubscriptions',
  'adminCredentials',
  'adminSecurity',
  'revisionProjects',
  'revisionGroups',
  'notes',
  // Client deliveries ("מסירה ללקוח") — the metadata + share tokens +
  // password hashes for every active delivery. The R2 video bytes live
  // outside Firestore (and are TTL-deleted), but this list/metadata is
  // user data and belongs in the backup.
  'deliveries',
  // App-update catalog (latest + draft release: version, download URLs,
  // release notes, exempt versions). Admin-managed config; losing it
  // would break auto-update until re-entered.
  'appReleases',
  // NOTE: audio-sync telemetry is NOT here — it lives in Cloudflare R2 under
  // `sync-telemetry/` (fingerprints are heavy), not Firestore, so the Firestore
  // backup doesn't touch it. See handleAdminSyncTelemetryExport.
]
let _backupR2: S3Client | null = null
function getBackupR2(): S3Client {
  if (_backupR2) return _backupR2
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey || !BACKUP_BUCKET) {
    throw new Error(
      'R2 env vars missing (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)',
    )
  }
  _backupR2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return _backupR2
}

/** Firestore Timestamp → tagged JSON (and back) so date fields survive
 *  a JSON round-trip. Everything else is plain JSON (their docs mostly
 *  use ISO strings already). */
function serializeForBackup(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  const t = v as { toDate?: () => Date; seconds?: number }
  if (typeof t.toDate === 'function' && typeof t.seconds === 'number') {
    return { __t: 'ts', v: t.toDate().toISOString() }
  }
  if (Array.isArray(v)) return v.map(serializeForBackup)
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = serializeForBackup(val)
  }
  return out
}
function reviveFromBackup(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(reviveFromBackup)
  const rec = v as Record<string, unknown>
  if (rec.__t === 'ts' && typeof rec.v === 'string') {
    return Timestamp.fromDate(new Date(rec.v))
  }
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(rec)) out[k] = reviveFromBackup(val)
  return out
}

interface BackupPayload {
  version: number
  createdAt: string
  type: string
  collections: string[]
  docCount: number
  docs: Array<{ path: string; data: unknown }>
}

/** Read every backed-up collection (including nested) into a payload. */
async function buildBackupPayload(type: string): Promise<BackupPayload> {
  const db = getDb()
  const docs: Array<{ path: string; data: unknown }> = []
  for (const name of BACKUP_COLLECTIONS) {
    const snap = await db.collectionGroup(name).get()
    for (const d of snap.docs) {
      docs.push({ path: d.ref.path, data: serializeForBackup(d.data()) })
    }
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    type,
    collections: BACKUP_COLLECTIONS,
    docCount: docs.length,
    docs,
  }
}

/** Build a backup and upload it to R2. Returns its key + size. */
async function createBackup(
  type: 'manual' | 'auto' | 'prerestore',
): Promise<{ key: string; sizeBytes: number; docCount: number; createdAt: string }> {
  const payload = await buildBackupPayload(type)
  const body = JSON.stringify(payload)
  const sizeBytes = Buffer.byteLength(body, 'utf8')
  const stamp = payload.createdAt.replace(/[:.]/g, '-')
  const key = `${BACKUP_PREFIX}${type}-${stamp}.json`
  await getBackupR2().send(
    new PutObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    }),
  )
  return { key, sizeBytes, docCount: payload.docCount, createdAt: payload.createdAt }
}

/** Turn a cadence-in-minutes into a cron expression for the Cloudflare
 *  backup worker, so it fires ONLY at the needed times (one request
 *  each) instead of knocking every minute. Sub-hour / hour / day cases
 *  map cleanly; awkward cases (e.g. every 90 min, or multi-day, whose
 *  day-of-month stepping resets monthly) fall back to a more frequent
 *  base — the server-side due-check then guarantees a snapshot is only
 *  actually written when the real interval has elapsed. */
function minutesToCron(m: number): string {
  if (!Number.isFinite(m) || m < 1) return '0 3 * * *' // daily 03:00
  m = Math.round(m)
  if (m < 60) return `*/${Math.max(1, m)} * * * *`
  if (m === 60) return '0 * * * *'
  if (m % 60 === 0) {
    const h = m / 60
    if (h < 24 && 24 % h === 0) return `0 */${h} * * *`
  }
  if (m % 1440 === 0) {
    const d = m / 1440
    if (d === 1) return '0 3 * * *'
    if (d <= 28) return `0 3 */${d} * *` // approximate; due-check is the guard
    return '0 3 1 * *' // ~monthly
  }
  // Awkward interval → knock hourly; due-check enforces the real cadence.
  return '0 * * * *'
}

/** Push the computed schedule to the Cloudflare backup worker via the
 *  CF API, so the panel is the single source of truth for cadence.
 *  Optional + best-effort: if the CF env vars aren't set we just skip
 *  (the worker keeps whatever cron it was deployed with). Requires
 *  CF_ACCOUNT_ID + CF_API_TOKEN (token scope: "Workers Scripts:Edit");
 *  worker name defaults to dmplus-backup-cron. */
async function syncBackupCron(
  intervalMinutes: number,
): Promise<{ synced: boolean; cron: string; error?: string }> {
  const cron = minutesToCron(intervalMinutes)
  const accountId = process.env.CF_ACCOUNT_ID
  const token = process.env.CF_API_TOKEN
  const script = process.env.CF_BACKUP_WORKER_NAME || 'dmplus-backup-cron'
  if (!accountId || !token) return { synced: false, cron, error: 'cf-not-configured' }
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/schedules`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify([{ cron }]),
      },
    )
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      return { synced: false, cron, error: `cf-${r.status}: ${t.slice(0, 180)}` }
    }
    return { synced: true, cron }
  } catch (e) {
    return { synced: false, cron, error: (e as Error)?.message || 'cf-failed' }
  }
}

/* ── Outgoing-email counter ────────────────────────────────────────
 *  Gmail SMTP caps a free account at ~500 emails/day. We count every
 *  send into metrics/emailSends (UTC hourly buckets) so the dashboard
 *  can show "sent in the last 24h" vs that cap. Email volume is low
 *  (≤500/day by definition), so one increment per send is negligible.
 *  Fire-and-forget — counting must never affect the email itself. */
function recordEmailSent(): void {
  try {
    const bucket = new Date().toISOString().slice(0, 13) // YYYY-MM-DDTHH
    void getDb()
      .collection('metrics')
      .doc('emailSends')
      .set(
        {
          hours: { [bucket]: FieldValue.increment(1) },
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      )
      .catch(() => {})
  } catch {
    /* never let counting break email sending */
  }
}
/** nodemailer transporter that counts every sendMail. A Proxy keeps all
 *  other methods + the original types intact, so call sites are
 *  unchanged. Replaces direct nodemailer.createTransport() calls. */
function makeCountedTransport(
  config: Record<string, unknown>,
): ReturnType<typeof nodemailer.createTransport> {
  const t = nodemailer.createTransport(
    config as unknown as Parameters<typeof nodemailer.createTransport>[0],
  )
  return new Proxy(t, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv)
      if (prop === 'sendMail' && typeof val === 'function') {
        return (...args: unknown[]) => {
          recordEmailSent()
          return (val as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof val === 'function'
        ? (val as (...a: unknown[]) => unknown).bind(target)
        : val
    },
  }) as ReturnType<typeof nodemailer.createTransport>
}

/* ── Page-view counter (self-metered) ──────────────────────────────
 *  Counts visits to the marketing / buy / account pages. Accumulated
 *  IN MEMORY and flushed to metrics/pageViews (per-day, per-page) in
 *  batches, so even heavy landing-page traffic costs only a few writes
 *  per day. The client de-dupes once per page per browser session, and
 *  a slight under-count on cold starts is fine (it's a rough gauge). */
const pvPending: Record<string, number> = {} // "YYYY-MM-DD|page" -> count
let pvLastFlushTs = Date.now()
const PV_FLUSH_THRESHOLD = 50
const PV_FLUSH_WINDOW_MS = 30 * 60 * 1000
function pvTotalPending(): number {
  let s = 0
  for (const k in pvPending) s += pvPending[k]
  return s
}
function recordPageView(page: string): void {
  try {
    const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
    const key = `${day}|${page}`
    pvPending[key] = (pvPending[key] || 0) + 1
    const now = Date.now()
    if (
      pvTotalPending() < PV_FLUSH_THRESHOLD &&
      now - pvLastFlushTs < PV_FLUSH_WINDOW_MS
    )
      return
    void flushPageViews()
  } catch {
    /* counting must never throw */
  }
}
async function flushPageViews(): Promise<void> {
  const snapshot = { ...pvPending }
  for (const k in pvPending) delete pvPending[k]
  pvLastFlushTs = Date.now()
  if (Object.keys(snapshot).length === 0) return
  try {
    const days: Record<string, Record<string, FirebaseFirestore.FieldValue>> = {}
    for (const [k, n] of Object.entries(snapshot)) {
      const [day, page] = k.split('|')
      days[day] = days[day] || {}
      days[day][page] = FieldValue.increment(n)
    }
    await getDb()
      .collection('metrics')
      .doc('pageViews')
      .set(
        { days, updatedAt: new Date().toISOString() } as Record<string, unknown>,
        { merge: true },
      )
  } catch {
    // Restore the counts so the next flush retries them.
    for (const [k, n] of Object.entries(snapshot)) {
      pvPending[k] = (pvPending[k] || 0) + n
    }
  }
}

/** Public: record a page view (home / buy / account). No auth — the
 *  client de-dupes per session; the server only accepts the 3 pages. */
function handleTrackPageview(req: VercelRequest, res: VercelResponse) {
  const page = String((req.body as { page?: string })?.page || '')
  if (page === 'home' || page === 'buy' || page === 'account') {
    recordPageView(page)
  }
  return res.status(200).json({ ok: true })
}
/** Admin: return the per-day, per-page visit counts. */
async function handleAdminPageViews(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  await flushPageViews().catch(() => {}) // include the in-memory tail
  const snap = await getDb().collection('metrics').doc('pageViews').get()
  const days =
    (snap.exists
      ? (snap.data() as { days?: Record<string, Record<string, number>> }).days
      : {}) || {}
  return res.status(200).json({ ok: true, days })
}

/* ── Vercel invocation counter (self-metered) ──────────────────────
 *  Vercel's Hobby plan exposes no usage API, so we count function
 *  invocations ourselves: every call to this endpoint is exactly one
 *  invocation. To keep this practically free we accumulate IN MEMORY
 *  and flush to Firestore (metrics/vercelUsage, keyed by month) only
 *  once a batch fills OR the window elapses — a few writes/day, never
 *  one per request, and reads only happen when the dashboard opens.
 *  Best-effort: never blocks or fails a request; a failed flush is
 *  restored so the next request retries. Slightly under-counts (the
 *  unflushed in-memory tail), which is fine for a rough gauge.
 *  See the twin copy in api/revisions.ts. */
let vcPending = 0
let vcLastFlushTs = Date.now()
const VC_FLUSH_THRESHOLD = 200
const VC_FLUSH_WINDOW_MS = 2 * 60 * 60 * 1000
function recordVercelInvocation(): void {
  vcPending += 1
  const now = Date.now()
  if (vcPending < VC_FLUSH_THRESHOLD && now - vcLastFlushTs < VC_FLUSH_WINDOW_MS)
    return
  const n = vcPending
  vcPending = 0
  vcLastFlushTs = now
  const month = new Date().toISOString().slice(0, 7)
  getDb()
    .collection('metrics')
    .doc('vercelUsage')
    .set(
      { counts: { [month]: FieldValue.increment(n) }, updatedAt: now },
      { merge: true },
    )
    .catch(() => {
      vcPending += n
    })
}

/* ─────────────────────────────────────────────────────────────
 *  Dispatcher
 * ───────────────────────────────────────────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  recordVercelInvocation()
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
  // GET is allowed for `unsubscribe` (email link) and `telegram-setup`
  // (one-time webhook registration the operator opens in a browser).
  const getAllowed =
    action === 'unsubscribe' ||
    action === 'telegram-setup' ||
    action === 'get-latest-release'
  if (req.method !== 'POST' && !(req.method === 'GET' && getAllowed)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  // Maintenance mode: short-circuit user-facing data actions while the
  // kill switch is ON. Admin/auth/webhook actions are never in the set,
  // so the operator can always turn it back off.
  if (KILL_BLOCKED_ACTIONS.has(action) && (await isSiteKilled())) {
    return res.status(503).json({
      ok: false,
      maintenance: true,
      error: 'המערכת בתחזוקה זמנית. נסה שוב בעוד כמה דקות.',
    })
  }

  try {
    switch (action) {
      // Trusted server clock — the desktop app calls this to correct a
      // skewed local clock before stamping lastSeenAt (a wrong clock
      // otherwise made the admin panel show "just now" forever).
      case 'now':
        return res.status(200).json({ ok: true, now: new Date().toISOString() })
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
      case 'admin-set-pricing':
        return await handleAdminSetPricing(req, res)
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
      case 'admin-test-sumit':
        return await handleAdminTestSumit(req, res)
      case 'admin-list-receipts':
        return await handleAdminListReceipts(req, res)
      case 'admin-get-receipts-settings':
        return await handleAdminGetReceiptsSettings(req, res)
      case 'admin-set-receipts-settings':
        return await handleAdminSetReceiptsSettings(req, res)
      case 'admin-casual-report':
        return await handleAdminCasualReport(req, res)
      case 'admin-mark-casual-reported':
        return await handleAdminMarkCasualReported(req, res)
      case 'admin-send-marketing-email':
        return await handleAdminSendMarketingEmail(req, res)
      case 'admin-list-marketing-recipients':
        return await handleAdminListMarketingRecipients(req, res)
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
      case 'admin-revenue-report':
        return await handleAdminRevenueReport(req, res)
      case 'admin-overview-stats':
        return await handleAdminOverviewStats(req, res)
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
      case 'admin-attribute-referral':
        return await handleAdminAttributeReferral(req, res)
      case 'partner-login':
        return await handlePartnerLogin(req, res)
      case 'partner-stats':
        return await handlePartnerStats(req, res)
      case 'partner-change-password':
        return await handlePartnerChangePassword(req, res)
      case 'partner-accept-terms':
        return await handlePartnerAcceptTerms(req, res)
      case 'admin-grant-pro':
        return await handleAdminGrantPro(req, res)
      case 'admin-2fa-request':
        return await handleAdmin2faRequest(req, res)
      case 'admin-2fa-verify':
        return await handleAdmin2faVerify(req, res)
      case 'admin-passkey-reg-options':
        return await handleAdminPasskeyRegOptions(req, res)
      case 'admin-passkey-reg-verify':
        return await handleAdminPasskeyRegVerify(req, res)
      case 'admin-passkey-auth-options':
        return await handleAdminPasskeyAuthOptions(req, res)
      case 'admin-passkey-auth-verify':
        return await handleAdminPasskeyAuthVerify(req, res)
      case 'admin-passkey-list':
        return await handleAdminPasskeyList(req, res)
      case 'admin-passkey-delete':
        return await handleAdminPasskeyDelete(req, res)
      case 'admin-stepup-options':
        return await handleAdminStepUpOptions(req, res)
      case 'admin-stepup-verify':
        return await handleAdminStepUpVerify(req, res)
      case 'admin-gate-check':
        return await handleAdminGateCheck(req, res)
      case 'admin-gate-status':
        return await handleAdminGateStatus(req, res)
      case 'admin-set-gate-key':
        return await handleAdminSetGateKey(req, res)
      case 'admin-list-users':
        return await handleAdminListUsers(req, res)
      case 'admin-set-user-blocked':
        return await handleAdminSetUserBlocked(req, res)
      case 'admin-set-user-role':
        return await handleAdminSetUserRole(req, res)
      case 'admin-set-user-storage':
        return await handleAdminSetUserStorage(req, res)
      case 'admin-set-user-subscription':
        return await handleAdminSetUserSubscription(req, res)
      case 'admin-clear-user-device':
        return await handleAdminClearUserDevice(req, res)
      case 'admin-delete-user':
        return await handleAdminDeleteUser(req, res)
      case 'admin-approve-trial':
        return await handleAdminApproveTrial(req, res)
      case 'admin-revoke-trial':
        return await handleAdminRevokeTrial(req, res)
      case 'admin-reset-trial':
        return await handleAdminResetTrial(req, res)
      case 'admin-device-check-create':
        return await handleAdminDeviceCheckCreate(req, res)
      case 'admin-device-check-get':
        return await handleAdminDeviceCheckGet(req, res)
      case 'device-check-report':
        return await handleDeviceCheckReport(req, res)
      case 'admin-list-keys':
        return await handleAdminListKeys(req, res)
      case 'admin-list-subscriptions':
        return await handleAdminListSubscriptions(req, res)
      case 'admin-cancel-subscription':
        return await handleAdminCancelSubscription(req, res)
      case 'admin-refund-subscription':
        return await handleAdminRefundSubscription(req, res)
      case 'admin-link-subscription':
        return await handleAdminLinkSubscription(req, res)
      case 'admin-create-key':
        return await handleAdminCreateKey(req, res)
      case 'admin-delete-key':
        return await handleAdminDeleteKey(req, res)
      case 'admin-set-key-expiry':
        return await handleAdminSetKeyExpiry(req, res)
      case 'admin-list-usage-stats':
        return await handleAdminListUsageStats(req, res)
      case 'admin-issue-usage-pull':
        return await handleAdminIssueUsagePull(req, res)
      case 'admin-get-app-config':
        return await handleAdminGetAppConfig(req, res)
      case 'admin-set-app-config':
        return await handleAdminSetAppConfig(req, res)
      case 'admin-create-backup':
        return await handleAdminCreateBackup(req, res)
      case 'admin-run-auto-backup':
        return await handleAdminRunAutoBackup(req, res)
      case 'admin-list-backups':
        return await handleAdminListBackups(req, res)
      case 'admin-delete-backup':
        return await handleAdminDeleteBackup(req, res)
      case 'admin-download-backup':
        return await handleAdminDownloadBackup(req, res)
      case 'admin-upload-backup':
        return await handleAdminUploadBackup(req, res)
      case 'admin-backup-summary':
        return await handleAdminBackupSummary(req, res)
      // One-time: register the alert bot's webhook (admin-gated).
      case 'admin-telegram-setup-webhook':
        return await handleAdminTelegramSetupWebhook(req, res)
      // Same, but self-service via a browser link guarded by the env
      // secret (?secret=…) — no curl/2FA needed for first setup.
      case 'telegram-setup':
        return await handleTelegramSetup(req, res)
      // Telegram inline-button presses land here (self-verified via the
      // secret-token header — NOT admin-gated, Telegram can't carry our
      // session). Powers the backup "📊 פירוט" drill-in.
      case 'telegram-webhook':
        return await handleTelegramWebhook(req, res)
      case 'admin-restore-backup':
        return await handleAdminRestoreBackup(req, res)
      case 'admin-list-client-errors':
        return await handleAdminListClientErrors(req, res)
      case 'admin-get-client-error':
        return await handleAdminGetClientError(req, res)
      case 'admin-resolve-client-error':
        return await handleAdminResolveClientError(req, res)
      case 'admin-delete-client-error':
        return await handleAdminDeleteClientError(req, res)
      case 'admin-clear-client-errors':
        return await handleAdminClearClientErrors(req, res)
      case 'admin-sync-telemetry-export':
        return await handleAdminSyncTelemetryExport(req, res)
      case 'admin-sync-telemetry-clear':
        return await handleAdminSyncTelemetryClear(req, res)
      case 'admin-storage-cleanup':
        return await handleAdminStorageCleanup(req, res)
      case 'admin-users-storage':
        return await handleAdminUsersStorage(req, res)
      case 'admin-list-user-storage':
        return await handleAdminListUserStorage(req, res)
      case 'admin-delete-user-object':
        return await handleAdminDeleteUserObject(req, res)
      case 'admin-list-coupons':
        return await handleAdminListCoupons(req, res)
      case 'admin-create-coupon':
        return await handleAdminCreateCoupon(req, res)
      case 'admin-set-coupon-active':
        return await handleAdminSetCouponActive(req, res)
      case 'admin-delete-coupon':
        return await handleAdminDeleteCoupon(req, res)
      case 'admin-set-terms':
        return await handleAdminSetTerms(req, res)
      case 'admin-set-privacy':
        return await handleAdminSetPrivacy(req, res)
      case 'admin-set-accessibility':
        return await handleAdminSetAccessibility(req, res)
      case 'admin-set-partner-terms':
        return await handleAdminSetPartnerTerms(req, res)
      case 'admin-list-feedback':
        return await handleAdminListFeedback(req, res)
      case 'admin-set-feedback-resolved':
        return await handleAdminSetFeedbackResolved(req, res)
      case 'admin-delete-feedback':
        return await handleAdminDeleteFeedback(req, res)
      case 'admin-reply-feedback':
        return await handleAdminReplyFeedback(req, res)
      case 'track-pageview':
        return handleTrackPageview(req, res)
      case 'admin-pageviews':
        return await handleAdminPageViews(req, res)
      case 'get-popup':
        return await handleGetPopup(req, res)
      case 'admin-upload-popup-image':
        return await handleAdminUploadPopupImage(req, res)
      case 'admin-set-popup':
        return await handleAdminSetPopup(req, res)
      case 'get-pricing':
        return await handleGetPricing(req, res)
      case 'coupon-check':
        return await handleCouponCheck(req, res)
      case 'submit-contact':
        return await handleSubmitContact(req, res)
      case 'get-terms':
        return await handleGetTerms(req, res)
      case 'get-privacy':
        return await handleGetPrivacy(req, res)
      case 'get-latest-release':
        return await handleGetLatestRelease(req, res)
      case 'get-partner-terms':
        return await handleGetPartnerTerms(req, res)
      default:
        return res
          .status(400)
          .json({ ok: false, error: `unknown action: ${action || '(empty)'}` })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error(`[paypal/${action}] failed:`, err)
    // Push a (throttled) alert so a server-side 500 isn't silent.
    if (alertNotThrottled(`err:${action}`)) {
      await sendTelegramAlert(
        `🔴 שגיאת שרת ב-API\nפעולה: ${action || '(empty)'}\n${message}`,
      )
    }
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

  // ── Operational alerts to the owner's Telegram ──────────────────
  // One concise push per meaningful outcome. Awaited (not fire-and-
  // forget) so it isn't truncated when the serverless function returns.
  try {
    if (!result.ok) {
      await sendTelegramAlert(
        `🔴 Webhook נכשל (${event.event_type})\n${result.error || result.summary}\nאירוע: ${event.id}`,
      )
    } else if (event.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      await sendTelegramAlert(`⚠️ חיוב נכשל ללקוח\n${result.summary}`)
    } else if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') {
      await sendTelegramAlert(
        `🚨 נפתחה מחלוקת (dispute) ב-PayPal — דורש טיפול ידני\nאירוע: ${event.id}`,
      )
    } else if (
      event.event_type === 'PAYMENT.SALE.COMPLETED' &&
      !/ignored|without/i.test(result.summary)
    ) {
      await sendTelegramAlert(`💰 תשלום התקבל\n${result.summary}`)
    } else if (
      event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' &&
      !/ignored/i.test(result.summary)
    ) {
      await sendTelegramAlert(`🎉 מנוי חדש הופעל\n${result.summary}`)
    }
  } catch {
    /* alerts are best-effort — never fail the webhook over them */
  }

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
        /** PayPal's actual fee for THIS transaction — exact, not an
         *  estimate. Present on PAYMENT.SALE.COMPLETED. */
        transaction_fee?: { value?: string; currency?: string }
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
    // The key isn't created yet (this SALE.COMPLETED arrived before
    // BILLING.SUBSCRIPTION.ACTIVATED). The charge STILL happened, so we
    // must issue a receipt here — otherwise the FIRST payment would
    // never get one. The webhook is deduped per event.id, so this fires
    // exactly once for this charge. We don't touch the key/period here
    // (ACTIVATED creates it).
    if (sumitConfigured() && (await receiptsEnabled())) {
      try {
        const sub = await paypalCall<{
          subscriber?: { email_address?: string }
        }>('GET', `/v1/billing/subscriptions/${subscriptionId}`)
        const recipient = (sub.subscriber?.email_address || '').trim()
        if (recipient) {
          const amount = parseFloat(resource.amount.total)
          await issueAndDeliverReceipt({
            recipient,
            amount,
            currency: resource.amount.currency,
            description: 'ניהול הורדות פלוס — מנוי',
            subscriptionId,
          })
        }
      } catch (err) {
        console.warn('[sumit] deferred receipt step threw (ignored):', err)
      }
    }
    return {
      ok: true,
      summary: `sale for ${subscriptionId} — key deferred; receipt handled`,
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
      // Exact PayPal fee for this charge (0 if PayPal omitted it).
      fee: parseFloat(resource.transaction_fee?.value || '0') || 0,
      at: new Date().toISOString(),
    }),
  })

  // Durable tax ledger — this recurring charge (mirrors the
  // billingHistory entry above, same event.id).
  await recordCasualCharge({
    id: event.id,
    at: new Date().toISOString(),
    email:
      key.buyerEmail ||
      (key as { redeemedByEmail?: string }).redeemedByEmail ||
      '',
    name: (key as { buyerName?: string }).buyerName || '',
    amount: paidAmount,
    currency: resource.amount.currency,
    fee: parseFloat(resource.transaction_fee?.value || '0') || 0,
    subscriptionId,
    kind: 'renewal',
    referredBy: (key as { referredBy?: string }).referredBy || null,
  })

  // Issue + email + log a SUMIT tax receipt for this charge. Fully
  // best-effort: any failure is logged and ignored so it can never
  // affect the subscription/payment flow.
  if (sumitConfigured() && (await receiptsEnabled())) {
    try {
      const recipient = key.buyerEmail || key.redeemedByEmail || ''
      if (recipient) {
        const planLabel = days >= 360 ? 'מנוי שנתי' : 'מנוי חודשי'
        const url = await issueAndDeliverReceipt({
          recipient,
          amount: paidAmount,
          currency: resource.amount.currency,
          description: `ניהול הורדות פלוס — ${planLabel}`,
          subscriptionId,
        })
        if (url) {
          await keyDoc.ref
            .update({ lastReceiptUrl: url, lastReceiptAt: new Date().toISOString() })
            .catch(() => undefined)
        }
      }
    } catch (err) {
      console.warn('[sumit] receipt step threw (ignored):', err)
    }
  }

  // Tell the customer their subscription just auto-renewed — the charge
  // went through and access was extended. This branch only runs for a
  // renewal (the first charge is handled in the "key deferred" branch
  // above, and the welcome email fires on activation), and the webhook
  // is deduped per event.id, so exactly one renewal email goes out per
  // charge. Fully best-effort: an email failure never affects the
  // renewal itself.
  try {
    const recipient = key.buyerEmail || key.redeemedByEmail || ''
    if (recipient) {
      await sendRenewalEmail({
        to: recipient,
        key: keyDoc.id,
        planDays: days,
        price: paidAmount,
        currency: resource.amount.currency,
        newExpiresAt,
        subscriptionId,
      })
    }
  } catch (err) {
    console.error('[webhook] renewal email failed for', keyDoc.id, err)
  }

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
    subscriber: {
      email_address: string
      name?: { given_name?: string; surname?: string }
    }
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
      tenure_type?: string
      sequence?: number
      frequency: { interval_unit: string; interval_count: number }
      pricing_scheme: {
        fixed_price: { value: string; currency_code: string }
      }
    }>
  }>('GET', `/v1/billing/plans/${sub.plan_id}`)
  const cycle = plan.billing_cycles[0]
  // The RECURRING cycle (tenure REGULAR) carries the price PayPal will
  // charge on every renewal. For an intro/"first period" plan that's the
  // 2nd cycle at full price; for a normal plan it IS cycle[0]. The key's
  // subscriptionPrice must be this recurring price so the renewal amount-
  // guard passes when PayPal bills full price after the intro period.
  const recurringCycle =
    plan.billing_cycles.find((c) => c.tenure_type === 'REGULAR') || cycle
  const planDays = cycle.frequency.interval_unit === 'YEAR' ? 365 : 30
  // Price CHARGED NOW (the initial activation) = the first cycle's price
  // (intro price for a "first" coupon). Seeds billingHistory truthfully.
  const initialChargePrice = parseFloat(cycle.pricing_scheme.fixed_price.value)
  // Price that RECURS (drives subscriptionPrice + the renewal guard).
  const planPrice = parseFloat(
    recurringCycle.pricing_scheme.fixed_price.value,
  )
  const planCurrency = cycle.pricing_scheme.fixed_price.currency_code
  const buyerEmail = sub.subscriber.email_address
  // Full name for the casual-transaction ledger / receipts (PayPal
  // returns the payer's name on the subscription). Best-effort.
  const buyerName = [
    sub.subscriber.name?.given_name,
    sub.subscriber.name?.surname,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
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
  let pendingCoupon: { code: string; pct: number } | null = null
  try {
    const pendingDoc = await db
      .collection('pendingSubscriptions')
      .doc(subscriptionId)
      .get()
    if (pendingDoc.exists) {
      const data = pendingDoc.data() as {
        linkToUid?: string | null
        renewKeyId?: string | null
        couponCode?: string | null
        couponPct?: number | null
      }
      if (typeof data.linkToUid === 'string' && data.linkToUid) {
        linkToUid = data.linkToUid
      }
      if (typeof data.renewKeyId === 'string' && data.renewKeyId) {
        renewKeyId = data.renewKeyId
      }
      if (typeof data.couponCode === 'string' && data.couponCode) {
        pendingCoupon = {
          code: data.couponCode,
          pct: Number(data.couponPct) || 0,
        }
      }
    }
  } catch (err) {
    console.warn(
      '[webhook/sale-completed] pendingSubscriptions lookup failed:',
      err,
    )
  }

  // Coupon consumption — the activation is PayPal-confirmed at this
  // point, so this is the moment one "use" is burned. Idempotent per
  // (coupon, email): a webhook redelivery won't double-count.
  if (pendingCoupon && !renewKeyId && buyerEmail) {
    try {
      await consumeCoupon(
        pendingCoupon.code,
        buyerEmail.trim().toLowerCase(),
        subscriptionId,
      )
    } catch (err) {
      console.warn('[webhook] coupon consume failed:', err)
    }
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
        buyerEmail?: string
        buyerName?: string
        redeemedByEmail?: string
        billingHistory?: Array<{
          at: string
          amount: number
          currency: string
          eventId?: string
        }>
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
      // A renewal via the renew/switch flow always mints a NEW
      // subscriptionId, so `renew-<subId>` is unique per renewal charge
      // — a stable id for both billingHistory dedup and the durable
      // ledger below.
      const renewChargeAt = new Date().toISOString()
      const renewChargeId = `renew-${subscriptionId}`
      billingHistory.push({
        at: renewChargeAt,
        amount: planPrice,
        currency: planCurrency,
        eventId: renewChargeId,
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
        buyerName: buyerName || existing.buyerName || '',
        // Clear reminder stamps so the next cycle's cron emails
        // fire fresh.
        reminder10dSentAt: null,
        reminder2dSentAt: null,
        reminderSentAt: null,
      })

      // Durable tax ledger — this renewal charge (mirrors the
      // billingHistory push above, same `renew-<subId>` id).
      await recordCasualCharge({
        id: renewChargeId,
        at: renewChargeAt,
        email: buyerEmail || existing.buyerEmail || existing.redeemedByEmail || '',
        name: buyerName || existing.buyerName || '',
        amount: planPrice,
        currency: planCurrency,
        subscriptionId,
        kind: 'renewal',
        referredBy: (existing as { referredBy?: string }).referredBy || null,
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
    buyerName,
    ...(keyReferredBy ? { referredBy: keyReferredBy } : {}),
    subscriptionId,
    planId: sub.plan_id,
    subscriptionPrice: planPrice,
    subscriptionCurrency: planCurrency,
    subscriptionPlanDays: planDays,
    planDays,
    subscriptionStatus: 'active',
    subscriptionStartedAt: new Date().toISOString(),
    ...(pendingCoupon
      ? { couponCode: pendingCoupon.code, couponPct: pendingCoupon.pct }
      : {}),
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
      amount: initialChargePrice,
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
  // Durable tax ledger — the initial activation charge. Mirrors the
  // billingHistory seed above (same `initial-<subId>` id), but in a
  // standalone collection that survives key deletion so past-month
  // עסקת אקראי reports are always reproducible.
  await recordCasualCharge({
    id: `initial-${subscriptionId}`,
    at: baseKeyDoc.billingHistory[0].at,
    email: buyerEmail,
    name: buyerName,
    amount: planPrice,
    currency: planCurrency,
    subscriptionId,
    kind: 'initial',
    referredBy: keyReferredBy || null,
  })
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
      price: planPrice, // recurring
      firstChargePrice: initialChargePrice, // what was billed now
      coupon: pendingCoupon
        ? {
            code: pendingCoupon.code,
            pct: pendingCoupon.pct,
            // A two-cycle (intro) plan means it was a "first period" coupon;
            // otherwise the discount is forever.
            duration:
              initialChargePrice < planPrice ? 'first' : 'forever',
          }
        : null,
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

/* ── Coupons ─────────────────────────────────────────────────────
 *  SECURITY MODEL: the client only ever sends the coupon CODE. The
 *  discount %, the resulting price, and the PayPal plan are all
 *  resolved server-side, with a hard cap (COUPON_MAX_PCT) and a price
 *  floor — so a forged request can never buy Pro at 0. Free Pro stays
 *  where it belongs: the admin product-keys system, not the payment
 *  path. Usage is CONSUMED only when PayPal confirms the activation
 *  (webhook), so parallel checkouts can't overdraw maxUses, and a
 *  per-email uses/ doc makes consumption idempotent + once-per-buyer.
 *  Coupons never stack with a sale price: the buyer gets the cheaper
 *  of the two. Renewals/plan-switches ignore coupons entirely (the
 *  renewal amount-guard compares against the key's locked price).
 * ──────────────────────────────────────────────────────────────── */
// Discount cap. Kept just under 100 so a coupon can never reach a FREE
// subscription — even at the cap, couponPriceFrom()'s Math.max(1, …) floor
// guarantees at least 1 unit is charged. Free Pro belongs to the admin
// product-keys system, never the payment path.
const COUPON_MAX_PCT = 99

interface CouponDoc {
  code: string
  pct: number
  plans: 'monthly' | 'yearly' | 'both'
  /** 'forever' = every charge discounted; 'first' = only the first
   *  month/year, then the standard price recurs. */
  duration: 'forever' | 'first'
  active: boolean
  expiresAt: number | null
  maxUses: number | null
  usedCount: number
  note?: string
  createdAt: string
}

function normCouponCode(raw: string): string | null {
  const c = String(raw || '')
    .trim()
    .toUpperCase()
  return /^[A-Z0-9-]{3,32}$/.test(c) ? c : null
}

function couponPriceFrom(base: number, pct: number): number {
  return Math.max(1, Math.round((base * (100 - pct)) / 100))
}

/* Per-instance guessing throttle for the public check endpoint. Serverless
 * instances are short-lived so this is best-effort — combined with the
 * generic error message and the 3-32-char charset it makes scanning codes
 * impractical without ever risking a lockout for a legit buyer. */
const couponMisses = new Map<string, { n: number; at: number }>()
function couponThrottled(ip: string): boolean {
  const m = couponMisses.get(ip)
  if (!m) return false
  if (Date.now() - m.at > 10 * 60_000) {
    couponMisses.delete(ip)
    return false
  }
  return m.n >= 15
}
function couponRegisterMiss(ip: string): void {
  const m = couponMisses.get(ip)
  if (m && Date.now() - m.at <= 10 * 60_000) m.n += 1
  else couponMisses.set(ip, { n: 1, at: Date.now() })
}

/** Validate a coupon for a purchase. `email` empty = pre-check (no
 *  per-buyer test yet). Returns the SERVER-side pct, never trusts input. */
async function resolveCoupon(
  codeRaw: string,
  plan: 'monthly' | 'yearly',
  email: string,
): Promise<
  | { ok: true; code: string; pct: number; duration: 'forever' | 'first' }
  | { ok: false; error: string }
> {
  const code = normCouponCode(codeRaw)
  if (!code) return { ok: false, error: 'קוד לא תקין' }
  const snap = await getDb().collection('coupons').doc(code).get()
  if (!snap.exists) return { ok: false, error: 'קוד לא תקין' }
  const c = snap.data() as CouponDoc
  if (!c.active) return { ok: false, error: 'קוד לא תקין' }
  if (c.expiresAt && Date.now() > c.expiresAt) {
    return { ok: false, error: 'פג תוקף הקופון' }
  }
  if (c.plans && c.plans !== 'both' && c.plans !== plan) {
    return { ok: false, error: 'הקופון לא תקף לתוכנית שנבחרה' }
  }
  if (
    typeof c.maxUses === 'number' &&
    c.maxUses > 0 &&
    (c.usedCount || 0) >= c.maxUses
  ) {
    return { ok: false, error: 'הקופון נוצל במלואו' }
  }
  // HARD server-side bounds — even a mis-written admin doc can't produce
  // a free subscription.
  const pct = Math.min(COUPON_MAX_PCT, Math.max(1, Math.round(c.pct || 0)))
  const duration = c.duration === 'first' ? 'first' : 'forever'
  if (email) {
    const use = await snap.ref.collection('uses').doc(email).get()
    if (use.exists) return { ok: false, error: 'הקופון כבר נוצל עם המייל הזה' }
  }
  return { ok: true, code, pct, duration }
}

/** Consume one use — called ONLY from the webhook after PayPal confirmed
 *  the activation. Idempotent per (coupon, email). */
async function consumeCoupon(
  code: string,
  email: string,
  subscriptionId: string,
): Promise<void> {
  const db = getDb()
  const ref = db.collection('coupons').doc(code)
  await db.runTransaction(async (tx) => {
    const useRef = ref.collection('uses').doc(email)
    const [cSnap, useSnap] = await Promise.all([tx.get(ref), tx.get(useRef)])
    if (!cSnap.exists || useSnap.exists) return
    tx.set(useRef, { email, subscriptionId, at: new Date().toISOString() })
    tx.update(ref, {
      usedCount: ((cSnap.data() as CouponDoc).usedCount || 0) + 1,
    })
  })
}

/** Plan for an arbitrary (interval, amount) — reuses the same PayPal plan
 *  catalog as the regular/sale slots, so coupon prices never litter PayPal
 *  with duplicates. */
async function ensurePlanForAmount(
  interval: 'monthly' | 'yearly',
  amount: number,
  currency: string,
): Promise<string> {
  const db = getDb()
  const ref = db.collection('appConfig').doc('pricing')
  const snap = await ref.get()
  const existing = snap.exists
    ? (snap.data() as unknown as Record<string, unknown>)
    : {}
  const catalog =
    ((existing.paypalPlansCatalog as Record<string, CatalogEntry> | undefined) ?? {})
  const k = catalogKey(interval, amount, currency)
  const hit = catalog[k]
  if (hit) {
    try {
      await activatePaypalPlan(hit.planId)
      return hit.planId
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stale = msg.includes('404') || msg.includes('RESOURCE_NOT_FOUND')
      if (!stale) throw err
      delete catalog[k]
    }
  }
  const productId = await getOrCreateProduct()
  const planId = await createPaypalPlan({
    productId,
    label: `קופון — ${interval === 'monthly' ? 'חודשי' : 'שנתי'} ${amount}`,
    amount,
    currency,
    interval,
  })
  catalog[k] = { planId, amount, interval, currency }
  await ref.set({ paypalPlansCatalog: catalog }, { merge: true })
  return planId
}

/** Plan for a "first period only" coupon: intro price for one cycle,
 *  then `recurring` forever. Keyed in the catalog by BOTH prices so an
 *  intro plan never collides with a plain plan at the same recurring
 *  price. */
async function ensureIntroPlan(
  interval: 'monthly' | 'yearly',
  introAmount: number,
  recurringAmount: number,
  currency: string,
): Promise<string> {
  const db = getDb()
  const ref = db.collection('appConfig').doc('pricing')
  const snap = await ref.get()
  const existing = snap.exists
    ? (snap.data() as unknown as Record<string, unknown>)
    : {}
  const catalog =
    ((existing.paypalPlansCatalog as Record<string, CatalogEntry> | undefined) ?? {})
  const k = `${interval}:${recurringAmount.toFixed(2)}:intro${introAmount.toFixed(2)}:${currency}`
  const hit = catalog[k]
  if (hit) {
    try {
      await activatePaypalPlan(hit.planId)
      return hit.planId
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stale = msg.includes('404') || msg.includes('RESOURCE_NOT_FOUND')
      if (!stale) throw err
      delete catalog[k]
    }
  }
  const productId = await getOrCreateProduct()
  const planId = await createPaypalPlan({
    productId,
    label: `קופון היכרות — ${interval === 'monthly' ? 'חודשי' : 'שנתי'} ${introAmount}→${recurringAmount}`,
    amount: recurringAmount,
    introAmount,
    currency,
    interval,
  })
  catalog[k] = { planId, amount: recurringAmount, interval, currency }
  await ref.set({ paypalPlansCatalog: catalog }, { merge: true })
  return planId
}

/** Public: validate a code + preview the price. Never reveals WHY an
 *  unknown code failed (anti-scanning), throttled per IP. */
async function handleCouponCheck(req: VercelRequest, res: VercelResponse) {
  const b = (req.body || {}) as { code?: string; plan?: string }
  const plan: 'monthly' | 'yearly' = b.plan === 'yearly' ? 'yearly' : 'monthly'
  const ip = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  if (couponThrottled(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: 'יותר מדי ניסיונות — נסו שוב בעוד כמה דקות' })
  }
  const pricing = await loadCurrentPricingStrict()
  if (!pricing) {
    return res.status(503).json({ ok: false, error: 'המחיר אינו זמין כרגע' })
  }
  const r = await resolveCoupon(b.code || '', plan, '')
  if (!r.ok) {
    couponRegisterMiss(ip)
    return res.status(200).json({ ok: true, valid: false, error: r.error })
  }
  const regular = pricing[plan].regular
  const sale = pricing[plan].sale
  const effective = sale != null ? sale : regular
  if (r.duration === 'first') {
    // First period discounted off the CURRENT effective price; then the
    // effective price recurs. Always a strict win — no sale-vs-coupon race.
    const introPrice = couponPriceFrom(effective, r.pct)
    return res.status(200).json({
      ok: true,
      valid: true,
      pct: r.pct,
      duration: 'first',
      introPrice,
      recurringPrice: effective,
      finalPrice: introPrice,
      saleCheaper: false,
      currency: pricing.currency,
    })
  }
  // 'forever': discount off regular; buyer gets the cheaper of coupon/sale.
  const couponPrice = couponPriceFrom(regular, r.pct)
  const saleCheaper = sale != null && sale <= couponPrice
  return res.status(200).json({
    ok: true,
    valid: true,
    pct: r.pct,
    duration: 'forever',
    couponPrice,
    finalPrice: saleCheaper ? sale : couponPrice,
    saleCheaper,
    currency: pricing.currency,
  })
}

async function handleCreateSubscription(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    plan?: 'monthly' | 'yearly'
    email?: string
    sessionToken?: string
    renewToken?: string
    coupon?: string
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
  let lockedPrice = usingSale ? pricing[plan].sale! : pricing[plan].regular
  const plans = await syncPlansForPricing(pricing)
  let planId =
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

  // ── Coupon (server-side ONLY: the client sent just a code) ──
  // Not on renewals: the renewal amount-guard compares against the key's
  // locked price, and a discounted renewal would (correctly) be refused.
  // No stacking with a sale: the buyer gets the cheaper of the two.
  let couponApplied: { code: string; pct: number } | null = null
  if (body.coupon && !renewKeyId) {
    const r = await resolveCoupon(String(body.coupon), plan, email)
    if (!r.ok) {
      return res.status(400).json({ ok: false, error: r.error })
    }
    if (r.duration === 'first') {
      // First period discounted off the current effective price; the
      // effective price recurs. Two-cycle PayPal plan.
      const effective = usingSale ? pricing[plan].sale! : pricing[plan].regular
      const introPrice = couponPriceFrom(effective, r.pct)
      if (introPrice < effective) {
        planId = await ensureIntroPlan(plan, introPrice, effective, pricing.currency)
        lockedPrice = introPrice // first charge; recurring stays `effective`
        couponApplied = { code: r.code, pct: r.pct }
      }
    } else {
      // 'forever': discount off regular, no stacking with sale.
      const couponPrice = couponPriceFrom(pricing[plan].regular, r.pct)
      if (couponPrice < lockedPrice) {
        lockedPrice = couponPrice
        planId = await ensurePlanForAmount(plan, couponPrice, pricing.currency)
        couponApplied = { code: r.code, pct: r.pct }
      }
      // else: the active sale is already cheaper — proceed without the
      // coupon (nothing consumed).
    }
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
    // Coupon that produced lockedPrice (null = none). Consumed by the
    // webhook only after PayPal confirms the activation.
    couponCode: couponApplied ? couponApplied.code : null,
    couponPct: couponApplied ? couponApplied.pct : null,
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

/** Admin → write the pricing doc (appConfig/pricing). Mirrors the
 *  desktop's savePricing(): validates the shape, writes regular/sale
 *  for both plans, currency + optional saleLabel, and stamps audit
 *  fields. After this, the client calls sync-plans to push the new
 *  prices to PayPal. Gated by full 2FA (idToken + email-code). */
async function handleAdminSetPricing(req: VercelRequest, res: VercelResponse) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as {
    monthly?: { regular?: unknown; sale?: unknown }
    yearly?: { regular?: unknown; sale?: unknown }
    currency?: unknown
    saleLabel?: unknown
  }
  const posNum = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  const monthlyRegular = posNum(body.monthly?.regular)
  const yearlyRegular = posNum(body.yearly?.regular)
  if (monthlyRegular == null || yearlyRegular == null) {
    return res
      .status(400)
      .json({ ok: false, error: 'monthly/yearly regular price required' })
  }
  const monthlySale = posNum(body.monthly?.sale)
  const yearlySale = posNum(body.yearly?.sale)
  // Sale must be strictly below regular, else ignore it.
  const doc = {
    monthly: {
      regular: monthlyRegular,
      sale: monthlySale != null && monthlySale < monthlyRegular ? monthlySale : null,
    },
    yearly: {
      regular: yearlyRegular,
      sale: yearlySale != null && yearlySale < yearlyRegular ? yearlySale : null,
    },
    currency:
      typeof body.currency === 'string' && body.currency.trim()
        ? body.currency.trim()
        : 'ILS',
    saleLabel:
      typeof body.saleLabel === 'string' && body.saleLabel.trim()
        ? body.saleLabel.trim()
        : null,
    updatedAt: new Date().toISOString(),
    updatedBy: admin,
  }
  await getDb().collection('appConfig').doc('pricing').set(doc, { merge: true })
  return res.status(200).json({ ok: true, pricing: doc })
}

async function handleSyncPlans(req: VercelRequest, res: VercelResponse) {
  // Step-up gate: gateKey + idToken + adminToken + fresh passkey
  // step-up token. Syncing PayPal plans is a sensitive catalog
  // mutation; it runs right after admin-set-pricing (also step-up) so
  // the same 2-minute step-up token covers both — no second prompt.
  const admin = await verifyAdminStepUp(req)
  if (!admin) {
    return res.status(403).json({ ok: false, error: 'admin only' })
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

/* ──────────────────────────────────────────────────────────────
 *  SUMIT (סאמיט) — issue a tax receipt for a paid charge
 *
 *  We collect payment via PayPal, so SUMIT is used only to ISSUE +
 *  REGISTER the legal document (חשבונית מס/קבלה). The server creates
 *  the document via SUMIT's API and we email it from OUR mailbox.
 *
 *  Draft vs real: while the SUMIT account isn't configured for a real
 *  business it can only make DRAFTS — so we default to Draft. Once the
 *  business is set up there, set env SUMIT_LIVE=true to issue real
 *  documents. Fully fail-safe: if anything errors the caller ignores
 *  it (payment flow is never affected).
 * ────────────────────────────────────────────────────────────── */
const SUMIT_API_BASE = 'https://api.sumit.co.il'

function sumitConfigured(): boolean {
  return Boolean(process.env.SUMIT_COMPANY_ID && process.env.SUMIT_API_KEY)
}

/** Master ON/OFF switch for automatic SUMIT receipts, toggled from the
 *  admin Receipts tab and stored in appConfig/global.receiptsEnabled.
 *  DEFAULT OFF: when off we never call SUMIT and send them no customer
 *  data at all — the whole receipts pipeline is bypassed. Turning it on
 *  restores the exact behaviour that was here before. This lets the
 *  operator run on the "עסקת אקראי" model (report VAT manually) without
 *  any data leaving to a third party. */
async function receiptsEnabled(): Promise<boolean> {
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    return (
      snap.exists &&
      (snap.data() as { receiptsEnabled?: boolean }).receiptsEnabled === true
    )
  } catch {
    return false
  }
}

/** The current statutory Israeli VAT rate. Single source of truth for
 *  "auto" mode — update this one constant if the law changes. */
const CURRENT_IL_VAT_PERCENT = 18

/** VAT rate (percent) used by the casual-transaction report + revenue.
 *  Two modes (appConfig/global):
 *    - AUTO (default, vatAuto !== false): always the current statutory
 *      Israeli rate, so it stays correct without the operator touching
 *      anything.
 *    - MANUAL (vatAuto === false): the admin-set vatRate. */
async function casualVatRatePercent(): Promise<number> {
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    const d = (snap.exists ? snap.data() : {}) as {
      vatRate?: number
      vatAuto?: boolean
    }
    if (d.vatAuto !== false) return CURRENT_IL_VAT_PERCENT
    return typeof d.vatRate === 'number' && d.vatRate > 0 && d.vatRate < 100
      ? d.vatRate
      : CURRENT_IL_VAT_PERCENT
  } catch {
    return CURRENT_IL_VAT_PERCENT
  }
}

/** Break a single charge into gross / VAT / PayPal-fee / net.
 *  - VAT applies only to domestic (ILS) sales; foreign-currency charges
 *    are treated as zero-rated export. When SUMIT receipts are ON, VAT
 *    is handled through that pipeline, so it is NOT deducted from the
 *    owner's take here (only in the עסקת אקראי mode, receipts OFF).
 *  - net = gross − PayPal fee − VAT: the money actually kept. This is
 *    the base used for partner commissions so a partner is never paid a
 *    % of money that went to PayPal or to the state. */
function chargeNetBreakdown(args: {
  amount: number
  currency: string
  fee: number
  vatPercent: number
  receiptsEnabled: boolean
}): { gross: number; vat: number; fee: number; net: number } {
  const gross = args.amount > 0 ? args.amount : 0
  const fee = args.fee > 0 ? args.fee : 0
  const r = args.vatPercent / 100
  const vat =
    !args.receiptsEnabled &&
    (args.currency || '').toUpperCase() === 'ILS' &&
    r > 0
      ? gross - gross / (1 + r)
      : 0
  const net = Math.max(0, gross - fee - vat)
  return { gross, vat, fee, net }
}

/** Append a charge to the durable `casualLedger` collection — the
 *  permanent, key-independent tax ledger behind the עסקת אקראי report.
 *  Because it lives in its own collection (not inside the key), a
 *  deleted/expired key never erases its charges, so past-month reports
 *  stay reproducible "no matter what". Idempotent: keyed by the charge
 *  id (same id as the matching billingHistory eventId), so a webhook
 *  retry can't double-count. Best-effort — never throws into the
 *  payment flow. */
async function recordCasualCharge(args: {
  id: string
  at: string
  email: string
  name?: string
  amount: number
  currency: string
  fee?: number
  subscriptionId?: string | null
  kind: 'initial' | 'renewal'
  /** Partner code this charge is attributed to. Stored on the ledger so
   *  commission survives even after the key is cancelled/deleted. */
  referredBy?: string | null
}): Promise<void> {
  try {
    if (!args.id || !(args.amount > 0)) return
    await getDb()
      .collection('casualLedger')
      .doc(args.id)
      .set(
        {
          eventId: args.id,
          at: args.at || new Date().toISOString(),
          email: args.email || '',
          name: args.name || '',
          amount: args.amount,
          currency: (args.currency || 'ILS').toUpperCase(),
          fee: typeof args.fee === 'number' ? args.fee : 0,
          subscriptionId: args.subscriptionId || null,
          kind: args.kind,
          referredBy: args.referredBy || null,
        },
        { merge: true },
      )
  } catch (err) {
    console.warn('[casualLedger] write failed (ignored):', err)
  }
}

/** A single charge, normalised from the durable `casualLedger` (source
 *  of truth) unioned with any charge still living only in a key's
 *  `billingHistory`. Deduped by eventId — the ledger wins because it
 *  survives key cancellation/deletion. This is what the revenue and
 *  referral reports aggregate, so the numbers reflect money that
 *  ACTUALLY came in, regardless of whether the subscription is still
 *  active (a cancelled/deleted key must not erase past revenue or the
 *  commission a partner already earned). */
interface MergedCharge {
  eventId: string
  at: string
  email: string
  name: string
  currency: string
  gross: number
  fee: number
  referredBy: string
  subscriptionId: string
  /** 'initial' = the first payment (activation); 'renewal' = a recurring
   *  charge. Used by the "first purchase only" commission rule. */
  kind: 'initial' | 'renewal'
}

async function loadAllChargesMerged(): Promise<MergedCharge[]> {
  const db = getDb()
  const [ledgerSnap, keysSnap] = await Promise.all([
    db.collection('casualLedger').get(),
    db.collection('productKeys').get(),
  ])
  const byId = new Map<string, MergedCharge>()
  // Ledger entries (by id) that arrived WITHOUT a referredBy. If we later
  // recover one (from a live key or the buyer's account), we write it back
  // to the ledger doc so the attribution becomes permanent — see step 5.
  const ledgerMissingRef = new Set<string>()

  // 1) Durable ledger first — the canonical record of money charged.
  for (const doc of ledgerSnap.docs) {
    const d = doc.data() as {
      eventId?: string
      at?: string
      email?: string
      name?: string
      amount?: number
      currency?: string
      fee?: number
      referredBy?: string
      subscriptionId?: string
      kind?: string
    }
    const gross = typeof d.amount === 'number' ? d.amount : 0
    if (!(gross > 0) || !d.at) continue
    const id = d.eventId || doc.id
    byId.set(id, {
      eventId: id,
      at: d.at,
      email: (d.email || '').trim(),
      name: (d.name || '').trim(),
      currency: (d.currency || 'ILS').toUpperCase(),
      gross,
      fee: typeof d.fee === 'number' && d.fee > 0 ? d.fee : 0,
      referredBy: typeof d.referredBy === 'string' ? d.referredBy : '',
      subscriptionId: typeof d.subscriptionId === 'string' ? d.subscriptionId : '',
      kind:
        d.kind === 'initial' || d.kind === 'renewal'
          ? d.kind
          : id.startsWith('initial-')
            ? 'initial'
            : 'renewal',
    })
    if (!(typeof d.referredBy === 'string' && d.referredBy)) {
      ledgerMissingRef.add(id)
    }
  }

  // 2) Live keys — recover attribution for ledger rows that predate the
  //    referredBy stamp, and fold in any charge that only exists in a
  //    key's billingHistory (pre-ledger history). nonPaidGrant (comp)
  //    keys never represent real money, so skip them.
  const subToRef = new Map<string, string>()
  for (const doc of keysSnap.docs) {
    const kd = doc.data() as {
      nonPaidGrant?: boolean
      referredBy?: string
      subscriptionId?: string
      buyerEmail?: string
      redeemedByEmail?: string
      buyerName?: string
      billingHistory?: Array<{
        at?: string
        amount?: number
        currency?: string
        fee?: number
        eventId?: string
      }>
    }
    if (kd.nonPaidGrant) continue
    const ref = typeof kd.referredBy === 'string' ? kd.referredBy : ''
    if (kd.subscriptionId && ref) subToRef.set(kd.subscriptionId, ref)
    const email = (kd.buyerEmail || kd.redeemedByEmail || '').trim()
    const name = (kd.buyerName || '').trim()
    const hist = Array.isArray(kd.billingHistory) ? kd.billingHistory : []
    for (const h of hist) {
      const gross = typeof h.amount === 'number' ? h.amount : 0
      if (!(gross > 0) || !h.at) continue
      const id = h.eventId || `${doc.id}:${h.at}:${gross}`
      const existing = byId.get(id)
      if (existing) {
        if (!existing.referredBy && ref) existing.referredBy = ref
        if (!existing.email && email) existing.email = email
        if (!existing.name && name) existing.name = name
        if (!existing.subscriptionId && kd.subscriptionId)
          existing.subscriptionId = kd.subscriptionId
      } else {
        byId.set(id, {
          eventId: id,
          at: h.at,
          email,
          name,
          currency: (h.currency || 'ILS').toUpperCase(),
          gross,
          fee: typeof h.fee === 'number' && h.fee > 0 ? h.fee : 0,
          referredBy: ref,
          subscriptionId: kd.subscriptionId || '',
          kind: id.startsWith('initial-') ? 'initial' : 'renewal',
        })
      }
    }
  }

  // 3) Backfill attribution for ledger-only charges whose key still
  //    exists (cancelled but not deleted) via the subscriptionId map.
  for (const c of byId.values()) {
    if (!c.referredBy && c.subscriptionId && subToRef.has(c.subscriptionId)) {
      c.referredBy = subToRef.get(c.subscriptionId) || ''
    }
  }

  // 4) Last-resort attribution recovery for OLD charges (recorded before
  //    the ledger carried referredBy) whose KEY is gone: the buyer's
  //    user account still carries the referral stamp from signup. Map
  //    the charge's email → users.referredBy. Only query the emails we
  //    still couldn't attribute, in `in`-chunks of 30.
  const needEmails = [
    ...new Set(
      [...byId.values()]
        .filter((c) => !c.referredBy && c.email)
        .map((c) => c.email.toLowerCase()),
    ),
  ]
  if (needEmails.length > 0) {
    const emailToRef = new Map<string, string>()
    for (let i = 0; i < needEmails.length; i += 30) {
      const chunk = needEmails.slice(i, i + 30)
      try {
        const snap = await db
          .collection('users')
          .where('email', 'in', chunk)
          .get()
        for (const u of snap.docs) {
          const ud = u.data() as { email?: string; referredBy?: string }
          if (ud.email && typeof ud.referredBy === 'string' && ud.referredBy)
            emailToRef.set(ud.email.toLowerCase(), ud.referredBy)
        }
      } catch (err) {
        console.warn('[loadAllChargesMerged] user email lookup failed:', err)
      }
    }
    if (emailToRef.size > 0) {
      for (const c of byId.values()) {
        if (!c.referredBy && c.email) {
          const ref = emailToRef.get(c.email.toLowerCase())
          if (ref) c.referredBy = ref
        }
      }
    }
  }

  // 5) DURABILITY — persist recovered attribution back to the ledger.
  //    A ledger charge that originally had no referredBy but which we
  //    just recovered (from the still-live key in step 3, or the buyer's
  //    account in step 4) gets the attribution WRITTEN BACK to its
  //    casualLedger doc. This is the fix for the "partner sale showed up
  //    then vanished" bug: once a key is deleted (cancellation cleanup)
  //    the subscriptionId→key recovery would fail forever, silently
  //    dropping the partner's commission. Writing it back makes the
  //    attribution permanent. Only ADDS referredBy (merge) — never
  //    changes or clears an existing one. Self-healing: once written,
  //    later loads find it already set and skip the write entirely, so
  //    this is a one-time cost that converges to zero.
  const toPersist: { id: string; referredBy: string }[] = []
  for (const id of ledgerMissingRef) {
    const c = byId.get(id)
    if (c && c.referredBy) toPersist.push({ id, referredBy: c.referredBy })
  }
  if (toPersist.length > 0) {
    try {
      for (let i = 0; i < toPersist.length; i += 400) {
        const batch = db.batch()
        for (const t of toPersist.slice(i, i + 400)) {
          batch.set(
            db.collection('casualLedger').doc(t.id),
            { referredBy: t.referredBy },
            { merge: true },
          )
        }
        await batch.commit()
      }
    } catch (err) {
      console.warn(
        '[loadAllChargesMerged] referredBy persist-back failed (non-fatal):',
        err,
      )
    }
  }

  return [...byId.values()]
}

async function issueSumitReceipt(args: {
  customerName: string
  customerEmail: string
  description: string
  amount: number
  currency: string
}): Promise<{
  ok: boolean
  url?: string
  documentNumber?: number | string
  draft: boolean
  raw?: unknown
  error?: string
}> {
  const companyId = Number(process.env.SUMIT_COMPANY_ID)
  const apiKey = process.env.SUMIT_API_KEY || ''
  const draft = process.env.SUMIT_LIVE !== 'true'
  if (!companyId || !apiKey) {
    return { ok: false, draft, error: 'SUMIT not configured' }
  }
  // SUMIT create-document. Schema verified against the OfficeGuy/SUMIT
  // model (AccountingDocumentsCreateRequest): Items + Payments + VAT
  // are TOP-LEVEL siblings of Details; the draft flag is Details.IsDraft;
  // a payment carries an Amount + one Details_* object. Omitting
  // SendByEmail means SUMIT does NOT email — we deliver from our mailbox.
  const payload = {
    Credentials: { CompanyID: companyId, APIKey: apiKey },
    Details: {
      IsDraft: draft,
      // Document type. An עוסק פטור may only issue a קבלה (Receipt),
      // not a חשבונית מס. Default to Receipt; an עוסק מורשה can switch
      // to "InvoiceReceipt" (חשבונית מס/קבלה) via env SUMIT_DOC_TYPE.
      Type: process.env.SUMIT_DOC_TYPE || 'Receipt',
      Customer: {
        Name: args.customerName || args.customerEmail,
        EmailAddress: args.customerEmail,
      },
      Description: args.description,
    },
    Items: [
      {
        Quantity: 1,
        UnitPrice: args.amount,
        Description: args.description,
        // SUMIT requires each line to carry an Item with a Name.
        Item: { Name: args.description, Price: args.amount },
      },
    ],
    Payments: [
      {
        Amount: args.amount,
        Details_Other: { Description: 'PayPal' },
      },
    ],
    VATIncluded: true,
  }
  try {
    const r = await fetch(`${SUMIT_API_BASE}/accounting/documents/create/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = (await r.json().catch(() => null)) as {
      Status?: number
      UserErrorMessage?: string
      TechnicalErrorDetails?: string
      Data?: Record<string, unknown>
    } | null
    if (!r.ok || !json || json.Status !== 0) {
      return {
        ok: false,
        draft,
        raw: json,
        error:
          json?.UserErrorMessage ||
          json?.TechnicalErrorDetails ||
          `HTTP ${r.status}`,
      }
    }
    const data = (json.Data || {}) as Record<string, unknown>
    // Collect every URL SUMIT returned and prefer a direct PDF over the
    // customer-portal page: '.pdf' first, then an "original" download,
    // then DocumentDownloadURL, then any URL.
    const urls = Object.values(data).filter(
      (v): v is string => typeof v === 'string' && /^https?:\/\//.test(v),
    )
    const pickUrl =
      urls.find((u) => /\.pdf(\?|$)/i.test(u)) ||
      urls.find((u) => /original=true/i.test(u)) ||
      (typeof data.DocumentDownloadURL === 'string'
        ? data.DocumentDownloadURL
        : undefined) ||
      urls[0]
    const docNum =
      (data.DocumentNumber as number | string | undefined) ?? undefined
    return {
      ok: true,
      draft,
      url: pickUrl,
      documentNumber: docNum,
      raw: json,
    }
  } catch (err) {
    return {
      ok: false,
      draft,
      error: err instanceof Error ? err.message : 'sumit request failed',
    }
  }
}

/** Email the SUMIT receipt to the customer from OUR mailbox. The
 *  document is the legal receipt SUMIT issued; we're just the
 *  delivery channel. Best-effort. */
async function sendReceiptEmail(args: {
  to: string
  url: string
  amount: number
  currency: string
  description: string
  draft: boolean
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const sym = args.currency === 'USD' ? '$' : '₪'
  const draftNote = args.draft
    ? `<p style="font-size:11px;margin:0 0 14px;color:#8B8170;">[מסמך טיוטה — לבדיקה בלבד]</p>`
    : ''

  // Try to fetch the actual receipt PDF and attach it, so the customer
  // gets the real document in OUR email — not a link to SUMIT's portal.
  // SUMIT serves a finalized document's PDF from the download URL; a
  // DRAFT has no official PDF (the URL returns the portal HTML), so we
  // fall back to a link in that case.
  let pdf: Buffer | null = null
  try {
    const r = await fetch(args.url)
    const ct = (r.headers.get('content-type') || '').toLowerCase()
    const buf = Buffer.from(await r.arrayBuffer())
    const looksPdf = ct.includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-'
    if (r.ok && looksPdf && buf.length > 0) pdf = buf
  } catch {
    /* fall back to link */
  }

  const ctaHtml = pdf
    ? `<p style="font-size:13px;line-height:1.7;margin:0 0 8px;color:#C9BFA8;">הקבלה הרשמית מצורפת למייל זה כקובץ PDF.</p>`
    : `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0 24px;">
        <tr><td align="center">
          <a href="${args.url}" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">צפייה / הורדת הקבלה</a>
        </td></tr>
      </table>`

  const html = renderEmail({
    heading: 'הקבלה שלך 🧾',
    contentHtml: `
      ${draftNote}
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        תודה על התשלום ל-<strong>ניהול הורדות פלוס</strong>. הקבלה הרשמית עבור: ${args.description} — <strong dir="ltr">${args.amount} ${sym}</strong>.
      </p>
      ${ctaHtml}
      <p style="font-size:11px;margin:0;color:#5C5444;">הקבלה הופקה דרך מערכת SUMIT.</p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: 'הקבלה שלך — ניהול הורדות פלוס',
    html,
    attachments: pdf
      ? [{ filename: 'קבלה.pdf', content: pdf, contentType: 'application/pdf' }]
      : undefined,
  })
}

/** Hebrew one-line commission description for partner emails — includes
 *  whether the commission is on every charge or the first purchase only,
 *  for full transparency with the partner. */
function commissionLabelHe(
  type: 'percent' | 'fixed' | null | undefined,
  value: number | null | undefined,
  currency: string | null | undefined,
  firstOnly: boolean,
): string {
  if (!type || !value) return 'ההסכם ייקבע בהמשך'
  const scope = firstOnly ? 'על קנייה ראשונה בלבד' : 'על כל קנייה / חידוש'
  return type === 'percent'
    ? `${value}% ${scope}`
    : `${value} ${(currency || 'ILS').toUpperCase()} ${scope}`
}

/** Welcome email for a newly-set-up partner: the dashboard link, their
 *  login email, the TEMPORARY password, their referral link + agreement,
 *  and a note that on first login they must change the password and
 *  accept the partnership terms. */
async function sendPartnerWelcomeEmail(args: {
  to: string
  name: string
  code: string
  password: string
  commissionLabel: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const dashUrl = `${REFERRAL_LINK_BASE}/partner`
  const refLink = `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(args.code)}`
  const esc = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#8B8170;font-size:12px;">${label}</td><td style="padding:6px 0;color:#F5EFE6;font-size:13px;font-weight:600;" dir="ltr" align="left">${value}</td></tr>`
  const html = renderEmail({
    heading: 'ברוכים הבאים לתוכנית השותפים 🤝',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        שלום ${esc(args.name)}, צירפנו אתכם כשותפים של <strong>ניהול הורדות פלוס</strong>.
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;border-top:1px solid #2a2520;border-bottom:1px solid #2a2520;">
        ${row('קוד שותף', esc(args.code))}
        ${row('קישור ההפניה שלכם', esc(refLink))}
        ${row('ההסכם', esc(args.commissionLabel))}
      </table>
      <p style="font-size:13px;line-height:1.7;margin:0 0 8px;color:#C9BFA8;"><strong>פרטי הכניסה לדשבורד:</strong></p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;border-top:1px solid #2a2520;border-bottom:1px solid #2a2520;">
        ${row('כתובת הדשבורד', esc(dashUrl))}
        ${row('אימייל', esc(args.to))}
        ${row('סיסמה זמנית', esc(args.password))}
      </table>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0 22px;">
        <tr><td align="center">
          <a href="${dashUrl}" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">כניסה לדשבורד השותפים</a>
        </td></tr>
      </table>
      <p style="font-size:12px;line-height:1.7;margin:0;color:#8B8170;">
        בכניסה הראשונה תתבקשו להחליף את הסיסמה הזמנית בסיסמה קבועה משלכם,
        ולאשר את תקנון השותפות. שמרו על פרטי הכניסה בסוד.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: 'הצטרפתם כשותפים — ניהול הורדות פלוס',
    html,
  })
}

/** Notify a partner when the admin changes their commission terms —
 *  shows the BEFORE and AFTER so the change is fully transparent. */
async function sendPartnerCommissionChangeEmail(args: {
  to: string
  name: string
  oldLabel: string
  newLabel: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const esc = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const dashUrl = `${REFERRAL_LINK_BASE}/partner`
  const row = (label: string, value: string, strike: boolean) =>
    `<tr><td style="padding:6px 0;color:#8B8170;font-size:12px;">${label}</td><td style="padding:6px 0;color:${strike ? '#8B8170' : '#F5EFE6'};font-size:13px;font-weight:600;${strike ? 'text-decoration:line-through;' : ''}">${esc(value)}</td></tr>`
  const html = renderEmail({
    heading: 'עודכן הסכם העמלה שלכם',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        שלום ${esc(args.name)}, עדכנו את תנאי התגמול שלכם בתוכנית השותפים. הנה הפירוט:
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;border-top:1px solid #2a2520;border-bottom:1px solid #2a2520;">
        ${row('הסכם קודם', args.oldLabel, true)}
        ${row('הסכם חדש', args.newLabel, false)}
      </table>
      <p style="font-size:13px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        התנאים החדשים חלים מעכשיו. כל הנתונים והרווחים שצברתם עד כה נשמרים במלואם בדשבורד.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:6px 0 18px;">
        <tr><td align="center">
          <a href="${dashUrl}" target="_blank" style="display:inline-block;padding:12px 32px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:14px;">לדשבורד השותפים</a>
        </td></tr>
      </table>
      <p style="font-size:12px;line-height:1.7;margin:0;color:#8B8170;">
        אם יש שאלה לגבי השינוי — השיבו למייל הזה ונשמח להבהיר.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: 'עודכן הסכם העמלה שלכם — ניהול הורדות פלוס',
    html,
  })
}

/** Issue a SUMIT receipt, email it to the customer, and log it to the
 *  `receipts` collection (for the admin receipts log). One call covers
 *  every paid path. Fully best-effort — returns the URL when it
 *  succeeded, undefined otherwise; never throws. */
async function issueAndDeliverReceipt(args: {
  recipient: string
  amount: number
  currency: string
  description: string
  subscriptionId?: string | null
}): Promise<string | undefined> {
  try {
    const receipt = await issueSumitReceipt({
      customerName: args.recipient,
      customerEmail: args.recipient,
      description: args.description,
      amount: args.amount,
      currency: args.currency,
    })
    if (!receipt.ok || !receipt.url) {
      console.warn('[sumit] receipt issue failed:', receipt.error, receipt.raw)
      return undefined
    }
    await sendReceiptEmail({
      to: args.recipient,
      url: receipt.url,
      amount: args.amount,
      currency: args.currency,
      description: args.description,
      draft: receipt.draft,
    }).catch((e) => console.warn('[sumit] receipt email failed:', e))
    // Log to the receipts collection for the admin panel. Best-effort.
    try {
      await getDb()
        .collection('receipts')
        .add({
          at: new Date().toISOString(),
          email: args.recipient,
          amount: args.amount,
          currency: args.currency,
          description: args.description,
          documentNumber: receipt.documentNumber ?? null,
          url: receipt.url,
          draft: receipt.draft,
          subscriptionId: args.subscriptionId || null,
        })
    } catch (e) {
      console.warn('[sumit] receipt log write failed:', e)
    }
    return receipt.url
  } catch (err) {
    console.warn('[sumit] issueAndDeliverReceipt threw (ignored):', err)
    return undefined
  }
}

async function sendSubscriptionWelcomeEmail(args: {
  to: string
  key: string
  planLabel: string
  /** The RECURRING price — what auto-renews every cycle. */
  price: number
  /** What was actually charged NOW. Differs from `price` only for a
   *  "first period only" coupon (intro price < recurring). Omit/equal
   *  for everything else. */
  firstChargePrice?: number
  /** Applied coupon, if any — surfaced in the receipt block. */
  coupon?: { code: string; pct: number; duration: 'forever' | 'first' } | null
  currency: string
  nextBillingAt: Date
  subscriptionId: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
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
  const couponCode = args.coupon
    ? args.coupon.code.replace(/[<>&]/g, '')
    : ''
  const isFirstPeriodCoupon = !!args.coupon && args.coupon.duration === 'first'
  // Did the buyer actually pay LESS now than the recurring price?
  const firstIsDiscounted =
    typeof args.firstChargePrice === 'number' &&
    args.firstChargePrice < args.price
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
        <div>• תוכנית: ${args.planLabel}</div>
        ${
          args.coupon && firstIsDiscounted
            ? `<div>• שולם עכשיו: <strong>${args.firstChargePrice} ${symbol}</strong> (קופון ${couponCode} — ${args.coupon.pct}% הנחה)</div>`
            : args.coupon
              ? `<div>• מחיר: ${args.price} ${symbol} (קופון ${couponCode} — ${args.coupon.pct}% הנחה)</div>`
              : `<div>• מחיר: ${args.price} ${symbol}</div>`
        }
        ${
          isFirstPeriodCoupon
            ? `<div style="color:#D4A574;">• מהחיוב הבא ואילך: <strong>${args.price} ${symbol}</strong> ל${args.planLabel} (המחיר המלא)</div>`
            : ``
        }
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
  const transporter = makeCountedTransport({
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
  const transporter = makeCountedTransport({
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
  cancelledFrom: 'account' | 'paypal-direct' | 'admin'
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
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
      : args.cancelledFrom === 'admin'
        ? 'הביטול בוצע על ידי צוות התמיכה של ניהול הורדות פלוס.'
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
  const transporter = makeCountedTransport({
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

/**
 * Confirmation email for an AUTOMATIC subscription renewal — sent from
 * handleSaleCompleted when PayPal's recurring PAYMENT.SALE.COMPLETED
 * lands for an existing key (i.e. a renewal, not the first charge).
 * Reassures the buyer that the periodic charge went through and their
 * access was extended, so a silent card-charge never surprises them.
 * Best-effort; the renewal itself never depends on this.
 */
async function sendRenewalEmail(args: {
  to: string
  key: string
  planDays: number
  price: number
  currency: string
  newExpiresAt: Date
  subscriptionId: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const symbol =
    args.currency === 'ILS' ? '₪' : args.currency === 'USD' ? '$' : args.currency
  const isYearly = args.planDays >= 360
  const planLabel = isYearly ? 'שנתי' : 'חודשי'
  const cycleWord = isYearly ? 'שנה' : 'חודש'
  const newExpiresStr = args.newExpiresAt.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
  const html = renderEmail({
    heading: '✓ המנוי שלך חודש',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 18px;color:#C9BFA8;">
        החיוב התקופתי עבור <strong>ניהול הורדות פלוס Pro</strong> בוצע בהצלחה, והמנוי ה${planLabel} שלך חודש אוטומטית. אין צורך לעשות דבר — הגישה ממשיכה ברצף מלא.
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:18px;margin:0 0 22px;">
        <div style="font-size:13px;line-height:1.85;color:#C9BFA8;">
          <div style="margin-bottom:8px;">
            ✓ <strong>חויבת ב-${args.price} ${symbol}</strong> עבור ה${cycleWord} הקרוב
          </div>
          <div>
            ✓ <strong>המנוי ה${planLabel} חודש</strong> — הגישה נמשכת ללא הפסקה
          </div>
        </div>
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">הגישה תקפה עד</h3>
      <div style="background:#2A211A;border:1px solid rgba(212,165,116,0.35);border-radius:8px;padding:16px;margin:0 0 22px;">
        <div style="font-size:20px;color:#D4A574;font-weight:700;">${newExpiresStr}</div>
        <div style="margin-top:6px;font-size:11px;color:#8B8170;">החיוב ה${planLabel} הבא יתבצע אוטומטית בסמוך לתאריך זה.</div>
      </div>
      <h3 style="font-size:14px;margin:0 0 8px;color:#F5EFE6;font-weight:600;">המפתח שלך</h3>
      <p style="font-size:12px;line-height:1.6;margin:0 0 10px;color:#8B8170;">
        אותו מפתח נשאר — אין צורך להזין משהו חדש בתוכנה.
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:16px;margin:0 0 22px;">
        <div dir="ltr" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:18px;color:#D4A574;letter-spacing:0.08em;font-weight:700;">${args.key}</div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:0 0 12px;color:#8B8170;">
        אפשר לנהל או לבטל את המנוי בכל עת מ-<a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a>.
      </p>
      <p style="margin:0;font-size:11px;color:#5C5444;">
        מנוי ID: <span dir="ltr">${args.subscriptionId}</span>
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: `✓ המנוי ה${planLabel} שלך חודש — ניהול הורדות פלוס`,
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
  const transporter = makeCountedTransport({
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
  const transporter = makeCountedTransport({
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
  // Full admin gate (gateKey + idToken + 12h adminToken). This bulk
  // mutation marks EVERY user as email-verified — a bare idToken is
  // not enough.
  const admin = await verifyAdminStepUp(req)
  if (!admin) {
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
  | 'payment-failed'
  | 'plan-switch'
  | 'purge-warning-subscription'
  | 'purge-warning-trial'

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
    case 'payment-failed':
      return {
        subject: '[בדיקה] ⚠️ חיוב המנוי נכשל — נדרשת פעולה',
        html: renderEmail({
          heading: '⚠️ לא הצלחנו לחייב את המנוי',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              [תצוגת בדיקה] ניסינו לחדש את המנוי שלך ל-<strong>ניהול הורדות פלוס Pro</strong>, אבל החיוב נכשל (כרטיס שפג תוקף / אין כיסוי).
            </p>
            <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
              PayPal ינסה שוב בימים הקרובים. כדי לא לאבד את הגישה, מומלץ לעדכן את אמצעי התשלום עכשיו.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
              <tr><td align="center">
                <a href="${WEBSITE_BASE}/account" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">עדכון אמצעי תשלום</a>
              </td></tr>
            </table>
          `,
        }),
      }
    case 'plan-switch':
      return {
        subject: '[בדיקה] ⬆️ עברת למסלול שנתי — ניהול הורדות פלוס',
        html: renderEmail({
          heading: '⬆️ עברת למסלול שנתי',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
              [תצוגת בדיקה] המנוי שלך עודכן בהצלחה ממסלול חודשי למסלול שנתי. הימים שנותרו במסלול הקודם נשמרו והתווספו.
            </p>
            <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;font-size:13px;line-height:1.9;color:#C9BFA8;">
              <div>• מסלול חדש: שנתי</div>
              <div>• בתוקף עד: ${mockExpiry}</div>
              <div>• חיוב הבא: ${mockExpiry}</div>
              <div>• מתחדש אוטומטית עד שתבטל</div>
            </div>
            <p style="font-size:12px;line-height:1.7;margin:0;color:#8B8170;">
              ניהול המנוי: <a href="${WEBSITE_BASE}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE}/account</a>
            </p>
          `,
        }),
      }
    case 'purge-warning-subscription':
      return {
        subject: '[בדיקה] ⚠️ הגישה הסתיימה — סבבי התיקונים יימחקו בעוד 14 ימים',
        html: renderEmail({
          heading: '⚠️ הגישה הסתיימה — סבבי התיקונים יימחקו בקרוב',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              [תצוגת בדיקה] המנוי שלך ל-<strong>ניהול הורדות פלוס</strong> הסתיים, ואין יותר גישה לסבבי התיקונים שהעלית.
            </p>
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              סבבי התיקונים שלך (הסרטונים, התמונות וההקלטות) יימחקו לצמיתות בעוד <strong>14 ימים</strong> (${mockExpiry}). חידוש המנוי לפני התאריך הזה ישמור את כל הסבבים.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0 24px;">
              <tr><td align="center">
                <a href="${WEBSITE_BASE}/buy" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">חידוש ושמירת הסבבים 👑</a>
              </td></tr>
            </table>
            <p style="font-size:12px;margin:0;color:#5C5444;">
              לא רוצים להמשיך? אין צורך לעשות דבר — סבבי התיקונים יימחקו אוטומטית בתאריך הנ"ל.
            </p>
          `,
        }),
      }
    case 'purge-warning-trial':
      return {
        subject: '[בדיקה] ⚠️ הניסיון הסתיים — סבבי התיקונים יימחקו בעוד 14 ימים',
        html: renderEmail({
          heading: '⚠️ הגישה הסתיימה — סבבי התיקונים יימחקו בקרוב',
          contentHtml: `
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              [תצוגת בדיקה] תקופת הניסיון שלך ל-<strong>ניהול הורדות פלוס</strong> הסתיימה, ואין יותר גישה לסבבי התיקונים שהעלית.
            </p>
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
              סבבי התיקונים שלך (הסרטונים, התמונות וההקלטות) יימחקו לצמיתות בעוד <strong>14 ימים</strong> (${mockExpiry}). שדרוג למנוי לפני התאריך הזה ישמור את כל הסבבים.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0 24px;">
              <tr><td align="center">
                <a href="${WEBSITE_BASE}/buy" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">שדרוג ושמירת הסבבים 👑</a>
              </td></tr>
            </table>
            <p style="font-size:12px;margin:0;color:#5C5444;">
              לא רוצים להמשיך? אין צורך לעשות דבר — סבבי התיקונים יימחקו אוטומטית בתאריך הנ"ל.
            </p>
          `,
        }),
      }
  }
}

async function handleAdminSendTestEmail(req: VercelRequest, res: VercelResponse) {
  // Full admin gate (gateKey + idToken + 12h adminToken). Sending mail
  // on the brand's behalf is a sensitive action — bare idToken is not
  // enough.
  const admin = await verifyAdminStepUp(req)
  if (!admin) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }
  const body = req.body as { targetEmail?: string; kind?: string }
  const targetEmail = (body.targetEmail || '').trim().toLowerCase()
  const kind = (body.kind || '').trim() as TestEmailKind
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
    'payment-failed',
    'plan-switch',
    'purge-warning-subscription',
    'purge-warning-trial',
  ]
  if (!allowed.includes(kind)) {
    return res.status(400).json({ ok: false, error: `unknown template: ${kind}` })
  }

  const { subject, html } = buildTestEmail(kind)
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    return res.status(500).json({ ok: false, error: 'GMAIL credentials not set' })
  }
  const transporter = makeCountedTransport({
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

/** Admin-only: create a SUMIT test document (draft) and optionally
 *  email it. Returns the RAW SUMIT response so we can confirm the API
 *  contract + see the document URL / any error message. */
async function handleAdminTestSumit(req: VercelRequest, res: VercelResponse) {
  // Full admin gate (gateKey + idToken + 12h adminToken).
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const email = admin
  const body = req.body as { targetEmail?: string }
  const targetEmail = (body.targetEmail || '').trim().toLowerCase()
  if (!sumitConfigured()) {
    return res.status(400).json({
      ok: false,
      error: 'SUMIT לא מוגדר — חסר SUMIT_COMPANY_ID / SUMIT_API_KEY ב-env',
    })
  }

  const recipient = targetEmail || email
  const receipt = await issueSumitReceipt({
    customerName: 'בדיקה — לקוח לדוגמה',
    customerEmail: recipient,
    description: 'ניהול הורדות פלוס — מנוי חודשי (בדיקה)',
    amount: 9,
    currency: 'ILS',
  })

  // If a document URL came back, also email it so the admin sees the
  // full end-to-end flow (issue → our mailbox).
  let emailed = false
  if (receipt.ok && receipt.url) {
    try {
      await sendReceiptEmail({
        to: recipient,
        url: receipt.url,
        amount: 9,
        currency: 'ILS',
        description: 'ניהול הורדות פלוס — מנוי חודשי (בדיקה)',
        draft: receipt.draft,
      })
      emailed = true
    } catch (err) {
      console.warn('[sumit-test] email failed:', err)
    }
    // Log the test receipt too, so the admin sees the receipts list
    // update live after a test. Flagged test:true so it's clearly
    // distinguishable from real payment receipts.
    try {
      await getDb()
        .collection('receipts')
        .add({
          at: new Date().toISOString(),
          email: recipient,
          amount: 9,
          currency: 'ILS',
          description: 'ניהול הורדות פלוס — מנוי חודשי (בדיקה)',
          documentNumber: receipt.documentNumber ?? null,
          url: receipt.url,
          draft: receipt.draft,
          subscriptionId: null,
          test: true,
        })
    } catch (e) {
      console.warn('[sumit-test] receipt log write failed:', e)
    }
  }

  return res.status(200).json({
    ok: receipt.ok,
    draft: receipt.draft,
    url: receipt.url || null,
    documentNumber: receipt.documentNumber ?? null,
    emailed,
    error: receipt.error || null,
    // RAW response from SUMIT — lets us confirm field names live.
    raw: receipt.raw ?? null,
  })
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

/* ─────────────────────────────────────────────────────────────
 *  Admin: list every user currently on the newsletter (marketing)
 *  list — the actual email addresses, not just a count. Powers the
 *  "ניוזלטר" tab so the operator can see who's subscribed, copy the
 *  addresses, or export them.
 *
 *  Same full step-up gate as the broadcast itself: exposing the raw
 *  opted-in email list is as sensitive as mailing it.
 * ───────────────────────────────────────────────────────────── */
async function handleAdminListMarketingRecipients(
  req: VercelRequest,
  res: VercelResponse,
) {
  const adminEmail = await verifyAdminStepUp(req)
  if (!adminEmail) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }

  const db = getDb()
  const snap = await db
    .collection('users')
    .where('marketingOptIn', '==', true)
    .get()

  const recipients: Array<{
    uid: string
    email: string
    optInAt: string | null
  }> = []
  for (const d of snap.docs) {
    const data = d.data() as { email?: string; marketingOptInAt?: unknown }
    const e = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
    if (!e) continue
    const optInAt =
      typeof data.marketingOptInAt === 'string' ? data.marketingOptInAt : null
    recipients.push({ uid: d.id, email: e, optInAt })
  }

  // Newest opt-ins first; entries without a timestamp sink to the bottom.
  recipients.sort((a, b) => (b.optInAt ?? '').localeCompare(a.optInAt ?? ''))

  return res.status(200).json({
    ok: true,
    count: recipients.length,
    recipients,
  })
}

async function handleAdminSendMarketingEmail(
  req: VercelRequest,
  res: VercelResponse,
) {
  // Full admin gate (gateKey + idToken + 12h adminToken). Mass-mailing
  // the entire opted-in user base is one of the most sensitive actions
  // in the panel — a bare idToken is not enough.
  const adminEmail = await verifyAdminStepUp(req)
  if (!adminEmail) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }
  const body = req.body as {
    subject?: string
    heading?: string
    contentHtml?: string
    dryRun?: boolean
  }
  const subject = (body.subject || '').trim().slice(0, 200)
  const heading = (body.heading || '').trim().slice(0, 100)
  const contentHtml = (body.contentHtml || '').trim()
  const dryRun = body.dryRun === true
  if (!subject || !heading || !contentHtml) {
    return res
      .status(400)
      .json({ ok: false, error: 'יש למלא subject + heading + contentHtml' })
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
  const transporter = makeCountedTransport({
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
/* ─────────────────────────────────────────────────────────────
 *  get-latest-release — public read of appReleases/latest so the
 *  marketing site's "הורדה בחינם" button always serves the newest
 *  published version (the same doc the desktop update-feed reads and
 *  the admin Updates tab publishes). Public by design — a download
 *  link isn't a secret. Cached at the edge for a minute.
 * ───────────────────────────────────────────────────────────── */
async function handleGetLatestRelease(_req: VercelRequest, res: VercelResponse) {
  try {
    const db = getDb()
    const snap = await db.collection('appReleases').doc('latest').get()
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
    if (!snap.exists) {
      return res.status(200).json({ ok: true, release: null })
    }
    const d = snap.data() as {
      version?: string
      macUrl?: string
      winUrl?: string
      macUrlBackup?: string
      winUrlBackup?: string
    }
    return res.status(200).json({
      ok: true,
      release: {
        version: typeof d.version === 'string' ? d.version : '',
        macUrl: typeof d.macUrl === 'string' ? d.macUrl : '',
        winUrl: typeof d.winUrl === 'string' ? d.winUrl : '',
        macUrlBackup: typeof d.macUrlBackup === 'string' ? d.macUrlBackup : '',
        winUrlBackup: typeof d.winUrlBackup === 'string' ? d.winUrlBackup : '',
      },
    })
  } catch (err) {
    console.error('[paypal/get-latest-release] failed:', err)
    // Non-fatal — the client falls back to its hardcoded URLs.
    return res.status(200).json({ ok: false, release: null })
  }
}

/* Current published partner-terms version. Returns null when the admin
 * hasn't published a partner-terms doc yet — in that case the acceptance
 * gate keeps its legacy behavior (accepted = has a timestamp). Once a doc
 * exists, the partner's accepted version must match it or they re-accept. */
async function partnerTermsVersion(): Promise<number | null> {
  try {
    const snap = await getDb().collection('appConfig').doc('partnerTerms').get()
    if (!snap.exists) return null
    const v = (snap.data() as { version?: number }).version
    return typeof v === 'number' ? v : 0
  } catch {
    return null
  }
}

/* get-partner-terms — public read of appConfig/partnerTerms. Same shape as
 * the other legal docs; the partner dashboard's accept screen renders it
 * (falling back to its built-in copy when nothing's published yet). */
async function handleGetPartnerTerms(_req: VercelRequest, res: VercelResponse) {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('partnerTerms').get()
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
    if (!snap.exists) {
      return res.status(200).json({ ok: true, version: 0, lastUpdated: '', sections: [] })
    }
    const data = snap.data() as {
      version?: number
      lastUpdated?: string
      sections?: Array<{ title: string; paragraphs: string[] }>
    }
    return res.status(200).json({
      ok: true,
      version: typeof data.version === 'number' ? data.version : 0,
      lastUpdated: typeof data.lastUpdated === 'string' ? data.lastUpdated : '',
      sections: Array.isArray(data.sections) ? data.sections : [],
    })
  } catch (err) {
    console.error('[paypal/get-partner-terms] failed:', err)
    return res.status(500).json({ ok: false, error: 'לא הצלחנו לטעון את תקנון השותפים.' })
  }
}

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

/* ─────────────────────────────────────────────────────────────
 *  get-accessibility — public read of appConfig/accessibility.
 *  Same shape as terms/privacy. When the doc is missing we return
 *  EMPTY sections (not a stub): the public AccessibilityModal falls
 *  back to its built-in legally-complete statement in that case, so
 *  there's always something correct to show even before the admin
 *  customizes it.
 * ───────────────────────────────────────────────────────────── */
async function handleGetAccessibility(
  _req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const db = getDb()
    const snap = await db.collection('appConfig').doc('accessibility').get()
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600')
    if (!snap.exists) {
      return res.status(200).json({ ok: true, version: 0, lastUpdated: '', sections: [] })
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
    console.error('[paypal/get-accessibility] failed:', err)
    return res.status(500).json({
      ok: false,
      error: 'לא הצלחנו לטעון את הצהרת הנגישות כרגע. נסו שוב.',
    })
  }
}

async function handleAdminGrantPro(req: VercelRequest, res: VercelResponse) {
  // Full admin gate (gateKey + idToken + 12h adminToken). Granting Pro
  // mutates a user's entitlement — a bare idToken is not enough.
  const adminEmail = await verifyAdminStepUp(req)
  if (!adminEmail) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }
  const body = req.body as {
    targetEmail?: string
    days?: number
    reason?: string
  }
  const targetEmail = (body.targetEmail || '').trim().toLowerCase()
  const days = typeof body.days === 'number' ? Math.floor(body.days) : 30
  const reason = (body.reason || '').slice(0, 200) || 'admin grant'

  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל יעד לא תקינה' })
  }
  if (days <= 0 || days > 365 * 5) {
    return res
      .status(400)
      .json({ ok: false, error: 'מספר ימים לא תקין (1–1825)' })
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
  // When true, commission is earned on the FIRST purchase only (the
  // initial charge / first payment) — not on renewals. Applies to both
  // percent and fixed.
  commissionFirstOnly?: boolean
  // What the partner sees on their dashboard (modular). Positive
  // flags — if both money flags are off, the partner sees no money.
  visibility?: { revenue?: boolean; earnings?: boolean; counts?: boolean }
  // Dashboard login + onboarding.
  loginEmail?: string
  passwordHash?: string
  /** True after the admin sets a TEMP password — partner must change it
   *  on first login before reaching the dashboard. */
  mustChangePassword?: boolean
  /** ISO timestamp the partner accepted the partnership terms (null /
   *  absent = not yet accepted). */
  termsAcceptedAt?: string | null
  termsVersion?: string
  /** Bumped on every (temp) password issue → invalidates old tokens. */
  credEpoch?: number
}

/** Bump this when the partnership terms change to force re-acceptance. */
const PARTNER_TERMS_VERSION = '1'

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

/* ──────────────────────────────────────────────────────────────
 *  Admin → Revenue report. Every paid charge, aggregated by month:
 *  gross, PayPal fees, net (gross−fee), each partner's payout (net for
 *  percent, flat for fixed — matching what the partner sees), and the
 *  owner's final take (net − all payouts). idToken-gated so BOTH the
 *  website and desktop admin panels can call it.
 * ────────────────────────────────────────────────────────────── */
type RevMoney = Record<string, number>
function revAdd(obj: RevMoney, cur: string, v: number): void {
  if (!v) return
  obj[cur] = (obj[cur] || 0) + v
}
function revSub(a: RevMoney, b: RevMoney): RevMoney {
  const out: RevMoney = { ...a }
  for (const [c, v] of Object.entries(b)) out[c] = (out[c] || 0) - v
  return out
}

/** Current projected MONTHLY Cloudflare R2 cost (USD). Account is on
 *  "R2 Paid" ($0 base + usage): only storage beyond the free 10 GB is
 *  billed, at $0.015/GB-month (egress + typical ops are free). Summed
 *  from our own DB so it needs no R2-analytics permission. Mirrors
 *  fetchR2Usage() in revisions.ts — keep the rates in sync. */
async function computeCloudflareMonthlyUsd(): Promise<number> {
  try {
    const GB = 1024 * 1024 * 1024
    let bytes = 0
    const snap = await getDb().collection('revisionProjects').get()
    for (const d of snap.docs) {
      const r = d.data() as {
        r2Key?: string
        videoSizeBytes?: number
        status?: string
      }
      if (r.r2Key && r.status !== 'archived') bytes += Number(r.videoSizeBytes) || 0
    }
    const gb = bytes / GB
    return Math.max(0, gb - 10) * 0.015
  } catch (e) {
    console.warn('[revenue] cloudflare cost calc failed:', e)
    return 0
  }
}

/** Live USD→ILS rate (best-effort; falls back to ~3.7 on any error) so
 *  the Cloudflare USD cost can be folded into the ₪ bottom line. */
async function usdToIls(): Promise<number> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD')
    const j = (await r.json()) as { rates?: { ILS?: number } }
    const rate = j?.rates?.ILS
    if (typeof rate === 'number' && rate > 0) return rate
  } catch {
    /* ignore — use fallback */
  }
  return 3.7
}

/** Lightweight overview counters for the admin "נתונים כלליים" landing
 *  tab. Uses Firestore count() AGGREGATIONS — each query costs ~1 read
 *  per 1000 matched docs, not 1 per doc — so the whole tab is a handful
 *  of reads regardless of how many users exist. Numbers only, zero PII. */
async function handleAdminOverviewStats(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const db = getDb()
  const users = db.collection('users')
  const now = Date.now()
  const weekAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Cheap count() aggregation — no document scan, no fields pulled.
  // null on any failure so one bad metric never blanks the whole tab.
  const cnt = async (q: FirebaseFirestore.Query): Promise<number | null> => {
    try {
      const s = await q.count().get()
      return s.data().count
    } catch {
      return null
    }
  }

  // Does a redeemed product key currently grant Pro? Mirrors the
  // client isKeyActive logic exactly: perpetual (no expiresAt) →
  // active; future expiry → active; past expiry → active only inside
  // the 24h grace while the subscription is still 'active'.
  const keyGrantsPro = (k: {
    redeemedBy?: string | null
    expiresAt?: string | null
    subscriptionStatus?: string | null
  }): boolean => {
    if (!k.redeemedBy) return false
    if (!k.expiresAt) return true
    const ms = Date.parse(k.expiresAt)
    if (!Number.isFinite(ms)) return true
    if (ms > now) return true
    if (k.subscriptionStatus === 'active') return now - ms <= 24 * 60 * 60 * 1000
    return false
  }

  // ── Pro entitlement ──────────────────────────────────────────
  // Pro lives in productKeys (one tiny doc per key — far smaller than
  // the users collection, and we pull only the 3 fields we need via
  // select), PLUS the rare admin-set users.subscription === 'pro'. We
  // collect the owning uids into a Set so nobody is counted twice.
  const proUids = new Set<string>()
  try {
    const keysSnap = await db
      .collection('productKeys')
      .select('redeemedBy', 'expiresAt', 'subscriptionStatus')
      .get()
    for (const d of keysSnap.docs) {
      const k = d.data() as {
        redeemedBy?: string | null
        expiresAt?: string | null
        subscriptionStatus?: string | null
      }
      if (keyGrantsPro(k) && k.redeemedBy) proUids.add(k.redeemedBy)
    }
  } catch (e) {
    console.warn('[overview] productKeys read failed:', e)
  }
  try {
    const proFlag = await users.where('subscription', '==', 'pro').select().get()
    for (const d of proFlag.docs) proUids.add(d.id)
  } catch (e) {
    console.warn('[overview] subscription==pro read failed:', e)
  }
  const proUsers = proUids.size

  // ── Trials ───────────────────────────────────────────────────
  // Read ONLY the approved-trial docs (a small set), single-field
  // filter so NO composite index is needed, pulling only the expiry
  // field. A user who later converted to Pro keeps trialStatus
  // 'approved', so we exclude any uid already in proUids — that person
  // is a Pro subscriber now, not a trialist.
  let trialsActive: number | null = null
  let trialsExpired: number | null = null
  try {
    const tSnap = await users
      .where('trialStatus', '==', 'approved')
      .select('trialExpiresAt')
      .get()
    let active = 0
    let expired = 0
    for (const d of tSnap.docs) {
      if (proUids.has(d.id)) continue // converted to Pro — not a trial
      const exp = (d.data() as { trialExpiresAt?: string }).trialExpiresAt
      const ms = exp ? Date.parse(exp) : NaN
      if (Number.isFinite(ms) && ms > now) active++
      else expired++
    }
    trialsActive = active
    trialsExpired = expired
  } catch (e) {
    console.warn('[overview] trials read failed:', e)
  }

  const [usersTotal, newThisWeek] = await Promise.all([
    cnt(users),
    cnt(users.where('createdAt', '>=', weekAgoIso)),
  ])

  return res.status(200).json({
    ok: true,
    usersTotal,
    proUsers,
    trialsActive,
    trialsExpired,
    newThisWeek,
  })
}

async function handleAdminRevenueReport(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string }
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })

  // When SUMIT receipts are OFF (עסקת אקראי mode) the owner remits the
  // VAT himself, so it's a real deduction from his take and from the
  // partner-commission base. When ON, VAT flows through SUMIT and isn't
  // deducted here.
  const [receiptsOn, vatPercent] = await Promise.all([
    receiptsEnabled(),
    casualVatRatePercent(),
  ])

  const db = getDb()
  // Revenue is driven by the durable casualLedger (money that ACTUALLY
  // came in), unioned with any live billingHistory — NOT by whether the
  // subscription is still active. A cancelled/deleted key must never
  // erase past revenue. loadAllChargesMerged() encapsulates that union.
  const [charges, partnersSnap] = await Promise.all([
    loadAllChargesMerged(),
    db.collection('referralPartners').get(),
  ])

  const partners = new Map<
    string,
    {
      name: string
      type?: 'percent' | 'fixed'
      value?: number
      currency: string
    }
  >()
  for (const p of partnersSnap.docs) {
    const d = p.data() as ReferralPartnerDoc
    partners.set(p.id, {
      name: d.name || p.id,
      type: d.commissionType || undefined,
      value: typeof d.commissionValue === 'number' ? d.commissionValue : undefined,
      currency: (d.commissionCurrency || 'ILS').toUpperCase(),
    })
  }

  interface MonthAgg {
    gross: RevMoney
    fee: RevMoney
    vat: RevMoney
    net: RevMoney
    payouts: Record<string, RevMoney> // partner code → money
  }
  const months = new Map<string, MonthAgg>()
  const ensureMonth = (m: string): MonthAgg => {
    let cur = months.get(m)
    if (!cur) {
      cur = { gross: {}, fee: {}, vat: {}, net: {}, payouts: {} }
      months.set(m, cur)
    }
    return cur
  }

  for (const c of charges) {
    const cur = c.currency
    const b = chargeNetBreakdown({
      amount: c.gross,
      currency: cur,
      fee: c.fee,
      vatPercent,
      receiptsEnabled: receiptsOn,
    })
    const net = b.net
    const m = c.at ? String(c.at).slice(0, 7) : 'unknown'
    const M = ensureMonth(m)
    revAdd(M.gross, cur, b.gross)
    revAdd(M.fee, cur, b.fee)
    revAdd(M.vat, cur, b.vat)
    revAdd(M.net, cur, net)
    const refCode = c.referredBy
    const partner = refCode ? partners.get(refCode) : undefined
    if (partner && partner.type && (partner.value || 0) > 0) {
      M.payouts[refCode] = M.payouts[refCode] || {}
      if (partner.type === 'percent') {
        revAdd(M.payouts[refCode], cur, net * ((partner.value || 0) / 100))
      } else {
        // fixed: a flat amount per charge, in the partner's currency.
        revAdd(M.payouts[refCode], partner.currency, partner.value || 0)
      }
    }
  }

  // Shape output, newest month first, with per-partner payouts +
  // owner's final take (net − all payouts).
  const totalGross: RevMoney = {}
  const totalFee: RevMoney = {}
  const totalVat: RevMoney = {}
  const totalNet: RevMoney = {}
  const totalPayoutByPartner: Record<string, RevMoney> = {}

  const monthsOut = [...months.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, M]) => {
      const payoutTotal: RevMoney = {}
      const partnerRows = Object.entries(M.payouts).map(([code, money]) => {
        for (const [c, v] of Object.entries(money)) revAdd(payoutTotal, c, v)
        totalPayoutByPartner[code] = totalPayoutByPartner[code] || {}
        for (const [c, v] of Object.entries(money))
          revAdd(totalPayoutByPartner[code], c, v)
        return {
          code,
          name: partners.get(code)?.name || code,
          amount: money,
        }
      })
      for (const [c, v] of Object.entries(M.gross)) revAdd(totalGross, c, v)
      for (const [c, v] of Object.entries(M.fee)) revAdd(totalFee, c, v)
      for (const [c, v] of Object.entries(M.vat)) revAdd(totalVat, c, v)
      for (const [c, v] of Object.entries(M.net)) revAdd(totalNet, c, v)
      return {
        month,
        gross: M.gross,
        fee: M.fee,
        vat: M.vat,
        net: M.net,
        partners: partnerRows.sort((a, b) => a.name.localeCompare(b.name)),
        ownerFinal: revSub(M.net, payoutTotal),
      }
    })

  const totalPayoutAll: RevMoney = {}
  const partnerTotals = Object.entries(totalPayoutByPartner).map(
    ([code, money]) => {
      for (const [c, v] of Object.entries(money)) revAdd(totalPayoutAll, c, v)
      return { code, name: partners.get(code)?.name || code, amount: money }
    },
  )

  // Cloudflare R2 monthly infra cost — the last deduction in the chain
  // (gross → −PayPal → −partners → −Cloudflare = real bottom line).
  const [cfUsd, fxRate] = await Promise.all([
    computeCloudflareMonthlyUsd(),
    usdToIls(),
  ])
  const cfIls = cfUsd * fxRate

  return res.status(200).json({
    ok: true,
    receiptsEnabled: receiptsOn,
    vatPercent,
    months: monthsOut,
    totals: {
      gross: totalGross,
      fee: totalFee,
      vat: totalVat,
      net: totalNet,
      partners: partnerTotals.sort((a, b) => a.name.localeCompare(b.name)),
      ownerFinal: revSub(totalNet, totalPayoutAll),
    },
    cloudflare: {
      costUsd: cfUsd,
      costIls: cfIls,
      fxRate,
    },
  })
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
    if (!claims.exp || claims.exp < now) return null
    return claims
  } catch {
    return null
  }
}

/** Gate for all NEW web-admin data endpoints. Requires BOTH a valid
 *  Firebase admin idToken AND a valid 2FA admin token for the SAME
 *  email. Returns the admin email, or null (caller should 403). */
async function verifyAdmin2FA(req: VercelRequest): Promise<string | null> {
  const body = (req.body || {}) as {
    idToken?: string
    adminToken?: string
    gateKey?: string
  }
  // Secret access key is the OUTERMOST gate for the web admin surface.
  if (!(await isAdminGateOpen(body.gateKey))) return null
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return null
  const claims = verifyAdminToken((body.adminToken || '').trim())
  if (!claims) return null
  if (claims.email.toLowerCase() !== email.toLowerCase()) return null
  return email
}

/* ──────────────────────────────────────────────────────────────
 *  STEP-UP authentication (per-action re-verification).
 *
 *  The 12h adminToken proves "this person logged in with a second
 *  factor at some point in the last 12h". That's enough to LOOK at
 *  data, but every MUTATION additionally requires a STEP-UP token:
 *  a short-lived (2 min) token minted ONLY by a fresh passkey
 *  (biometric) assertion. So even if an attacker somehow obtained a
 *  live adminToken, they could not change anything without also
 *  producing a fresh Face-ID / Touch-ID / Windows-Hello signature on
 *  one of the operator's registered devices. This is exactly the
 *  requirement: every admin action is "signed" by proof of a real,
 *  present admin — not just a one-time check at login.
 *
 *  Reusable within its 2-minute window (so a single logical save that
 *  fans out into two API calls doesn't prompt twice), then it expires
 *  and the next mutation prompts for a fresh biometric.
 * ────────────────────────────────────────────────────────────── */

const ADMIN_STEPUP_TTL_SECONDS = 2 * 60

interface AdminStepUpClaims {
  email: string
  use: 'admin-stepup'
  iat: number
  exp: number
}

function signStepUpToken(email: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ADMIN_STEPUP_TTL_SECONDS
  const claims: AdminStepUpClaims = { email, use: 'admin-stepup', iat, exp }
  const header = b64urlEncode(
    Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', use: 'admin-stepup' }),
    ),
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

function verifyStepUpToken(token: string): AdminStepUpClaims | null {
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
    const claims = JSON.parse(
      b64urlDecode(p).toString('utf8'),
    ) as AdminStepUpClaims
    if (claims.use !== 'admin-stepup') return null
    if (!claims.email || !ADMIN_EMAILS.includes(claims.email.toLowerCase())) {
      return null
    }
    const now = Math.floor(Date.now() / 1000)
    if (!claims.exp || claims.exp < now) return null
    return claims
  } catch {
    return null
  }
}

/** Gate for every admin MUTATION. Requires the full 2FA gate AND a
 *  fresh step-up token (≤2 min old, minted by a passkey assertion) for
 *  the SAME admin email. Returns the email, or null (caller 403s with
 *  error code 'stepup-required' so the client knows to re-prompt). */
async function verifyAdminStepUp(req: VercelRequest): Promise<string | null> {
  const email = await verifyAdmin2FA(req)
  if (!email) return null
  if (!hasFreshStepUp(req, email)) return null
  return email
}

/** True iff the request carries a fresh, valid step-up token bound to
 *  `email`. Assumes the caller already proved the full 2FA gate — this
 *  only checks the extra biometric factor. Used by verifyAdminStepUp
 *  and by passkey registration (gating ADDITIONAL enrollments). */
function hasFreshStepUp(req: VercelRequest, email: string): boolean {
  const body = (req.body || {}) as { stepUpToken?: string }
  const claims = verifyStepUpToken((body.stepUpToken || '').trim())
  return !!claims && claims.email.toLowerCase() === email.toLowerCase()
}

/* ──────────────────────────────────────────────────────────────
 *  Admin secret access key — the location-independent gate that
 *  replaced the IP allowlist (consumer IPs are dynamic, so an IP
 *  allowlist couldn't work for mobile/home).
 *
 *  - A high-entropy key is generated in the browser and handed to the
 *    operator as a link `…/admin#k=<key>`. The fragment never reaches
 *    the server (no logs / no Referer).
 *  - The server stores ONLY the key's HMAC hash (adminSecurity/config
 *    .gateKeyHash) — never the plaintext. A leaked DB reveals nothing.
 *  - Every web-admin call carries the key; isAdminGateOpen() compares
 *    its hash. Wrong/absent key → the whole surface is dark.
 *  - NO key set ⇒ gate OPEN (so the operator can log in once and set
 *    a key). The login still requires password + email code, so this
 *    bootstrap window is auth-protected, not a breach. Set a key to
 *    make the page vanish for anyone who doesn't hold the link.
 * ────────────────────────────────────────────────────────────── */

function hashGateKey(key: string): string {
  return crypto
    .createHmac('sha256', tokenSecret())
    .update(key)
    .digest('hex')
}

async function getGateKeyHash(): Promise<string | null> {
  try {
    const snap = await getDb().collection('adminSecurity').doc('config').get()
    if (!snap.exists) return null
    const h = (snap.data() as { gateKeyHash?: unknown }).gateKeyHash
    return typeof h === 'string' && h.length > 0 ? h : null
  } catch {
    // Fail CLOSED on read error — but distinguish from "no key set":
    // return a sentinel so isAdminGateOpen treats it as blocked.
    return '__read_error__'
  }
}

async function isAdminGateOpen(providedKey?: string): Promise<boolean> {
  const stored = await getGateKeyHash()
  if (stored === '__read_error__') return false
  if (!stored) return true // no key configured → open (bootstrap)
  const key = (providedKey || '').trim()
  if (!key) return false
  const a = Buffer.from(hashGateKey(key), 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** Public probe — the /admin page renders nothing unless this says
 *  the gate is open for the supplied key. Reveals only a boolean. */
async function handleAdminGateCheck(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { gateKey?: string }
  return res
    .status(200)
    .json({ ok: true, open: await isAdminGateOpen(body.gateKey) })
}

/** Whether a gate key is currently configured. Admin-only. */
async function handleAdminGateStatus(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const h = await getGateKeyHash()
  return res
    .status(200)
    .json({ ok: true, hasKey: !!h && h !== '__read_error__' })
}

/** Set/rotate (or clear) the gate key. Stores only the hash. Admin-
 *  only. Passing an empty newKey clears the gate (page becomes
 *  open again). */
async function handleAdminSetGateKey(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { newKey?: string }
  const newKey = (body.newKey || '').trim()
  const ref = getDb().collection('adminSecurity').doc('config')
  if (!newKey) {
    await ref.set({ gateKeyHash: null, updatedAt: Date.now() }, { merge: true })
    return res.status(200).json({ ok: true, hasKey: false })
  }
  if (newKey.length < 16) {
    return res.status(400).json({ ok: false, error: 'מפתח קצר מדי' })
  }
  await ref.set(
    { gateKeyHash: hashGateKey(newKey), updatedAt: Date.now() },
    { merge: true },
  )
  return res.status(200).json({ ok: true, hasKey: true })
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

/**
 *  HARD-DELETE a user and everything tied to them, across every system:
 *  their R2 files, revision projects/rounds (+ notes), product keys (with
 *  best-effort PayPal cancellation), trial fingerprints, pending
 *  subscriptions, feedback, Drive integration, the user doc, and the
 *  Firebase Auth account.
 *
 *  DELIBERATELY KEPT: receipts + casualLedger. Those are tax records the
 *  business is legally required to retain — wiping them would break the
 *  עסקת אקראי / VAT reports. They're reported back as keptForTax.
 *
 *  Step-up gated (biometric) — irreversible + destructive. Each section is
 *  isolated so one failure can't abort the rest; a per-section error log
 *  comes back in the response.
 */
async function handleAdminDeleteUser(req: VercelRequest, res: VercelResponse) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as { uid?: string }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })

  const db = getDb()
  const summary: Record<string, number> = {}
  const errors: string[] = []

  // Look up email + deviceId (needed to find trial fingerprints) and role.
  let email = ''
  let deviceId = ''
  let role = ''
  try {
    const snap = await db.collection('users').doc(uid).get()
    const d = (snap.exists ? snap.data() : {}) as {
      email?: string
      deviceId?: string
      role?: string
    }
    email = String(d.email || '')
    deviceId = String(d.deviceId || '')
    role = String(d.role || '')
  } catch (e) {
    errors.push('user-read: ' + (e as Error).message)
  }

  // Never delete an admin/operator account, or yourself.
  if (role === 'admin' || (email && email.toLowerCase() === admin.toLowerCase())) {
    return res
      .status(400)
      .json({ ok: false, error: 'אי אפשר למחוק חשבון אדמין' })
  }

  // ── R2: everything under the user's prefix (videos + note media) ──
  try {
    const r2 = getBackupR2()
    let token: string | undefined
    let deleted = 0
    do {
      const listed = await r2.send(
        new ListObjectsV2Command({
          Bucket: BACKUP_BUCKET,
          Prefix: `${uid}/`,
          ContinuationToken: token,
        }),
      )
      for (const o of listed.Contents || []) {
        if (!o.Key) continue
        try {
          await r2.send(
            new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: o.Key }),
          )
          deleted += 1
        } catch {
          /* best effort */
        }
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (token)
    summary.r2ObjectsDeleted = deleted
  } catch (e) {
    errors.push('r2: ' + (e as Error).message)
  }

  // ── Revision rounds (+ their notes subcollection) ──
  try {
    const rounds = await db
      .collection('revisionProjects')
      .where('ownerUid', '==', uid)
      .get()
    let n = 0
    for (const doc of rounds.docs) {
      try {
        const notes = await doc.ref.collection('notes').get()
        for (const note of notes.docs) await note.ref.delete()
      } catch {
        /* ignore */
      }
      await doc.ref.delete()
      n += 1
    }
    summary.revisionRoundsDeleted = n
  } catch (e) {
    errors.push('revisionProjects: ' + (e as Error).message)
  }

  // ── Revision groups ──
  try {
    const groups = await db
      .collection('revisionGroups')
      .where('ownerUid', '==', uid)
      .get()
    let n = 0
    for (const doc of groups.docs) {
      await doc.ref.delete()
      n += 1
    }
    summary.revisionGroupsDeleted = n
  } catch (e) {
    errors.push('revisionGroups: ' + (e as Error).message)
  }

  // ── Product keys — cancel active PayPal subs, then delete the keys ──
  try {
    const keys = await db
      .collection('productKeys')
      .where('redeemedBy', '==', uid)
      .get()
    let n = 0
    let cancelled = 0
    for (const doc of keys.docs) {
      const k = doc.data() as {
        subscriptionId?: string
        subscriptionStatus?: string
      }
      if (k.subscriptionId && k.subscriptionStatus === 'active') {
        try {
          await paypalCall(
            'POST',
            `/v1/billing/subscriptions/${k.subscriptionId}/cancel`,
            { reason: 'account deleted by admin' },
          )
          cancelled += 1
        } catch {
          /* already cancelled / not found — fine */
        }
      }
      await doc.ref.delete()
      n += 1
    }
    summary.productKeysDeleted = n
    summary.paypalSubsCancelled = cancelled
  } catch (e) {
    errors.push('productKeys: ' + (e as Error).message)
  }

  // ── Trial fingerprints — by uid field, plus the reconstructed ids ──
  try {
    let n = 0
    try {
      const byUid = await db
        .collection('trialFingerprints')
        .where('uid', '==', uid)
        .get()
      for (const doc of byUid.docs) {
        await doc.ref.delete()
        n += 1
      }
    } catch {
      /* ignore */
    }
    const san = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
    const ids: string[] = []
    if (email) ids.push(`email_${san(email)}`)
    if (deviceId) ids.push(`device_${san(deviceId)}`)
    for (const id of ids) {
      try {
        const d = await db.collection('trialFingerprints').doc(id).get()
        if (d.exists) {
          await d.ref.delete()
          n += 1
        }
      } catch {
        /* ignore */
      }
    }
    summary.trialFingerprintsDeleted = n
  } catch (e) {
    errors.push('trialFingerprints: ' + (e as Error).message)
  }

  // ── Pending subscriptions linked to this user ──
  try {
    const pend = await db
      .collection('pendingSubscriptions')
      .where('linkToUid', '==', uid)
      .get()
    let n = 0
    for (const doc of pend.docs) {
      await doc.ref.delete()
      n += 1
    }
    summary.pendingSubscriptionsDeleted = n
  } catch (e) {
    errors.push('pendingSubscriptions: ' + (e as Error).message)
  }

  // ── Feedback / reports submitted by this user ──
  try {
    const fb = await db.collection('feedback').where('userId', '==', uid).get()
    let n = 0
    for (const doc of fb.docs) {
      await doc.ref.delete()
      n += 1
    }
    summary.feedbackDeleted = n
  } catch (e) {
    errors.push('feedback: ' + (e as Error).message)
  }

  // ── Google Drive integration (users/{uid}/integrations/*) ──
  try {
    const integ = await db
      .collection('users')
      .doc(uid)
      .collection('integrations')
      .get()
    let n = 0
    for (const doc of integ.docs) {
      await doc.ref.delete()
      n += 1
    }
    summary.integrationsDeleted = n
  } catch (e) {
    errors.push('integrations: ' + (e as Error).message)
  }

  // ── The user document itself ──
  try {
    await db.collection('users').doc(uid).delete()
    summary.userDocDeleted = 1
  } catch (e) {
    errors.push('userDoc: ' + (e as Error).message)
  }

  // ── Firebase Auth account ──
  try {
    const { getAuth } = await import('firebase-admin/auth')
    await getAuth(getFirebase()).deleteUser(uid)
    summary.authUserDeleted = 1
  } catch (e) {
    const msg = (e as Error).message || ''
    if (/no user record|not-found|user-not-found/i.test(msg)) {
      summary.authUserDeleted = 0
    } else {
      errors.push('auth: ' + msg)
    }
  }

  return res.status(200).json({
    ok: true,
    uid,
    email,
    summary,
    keptForTax: ['receipts', 'casualLedger'],
    errors,
  })
}

async function handleAdminSetUserBlocked(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
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
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string; role?: string }
  const uid = String(body.uid || '').trim()
  const role = body.role === 'admin' ? 'admin' : 'user'
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  await getDb().collection('users').doc(uid).update({ role })
  return res.status(200).json({ ok: true })
}

/** Storage backend for the Revisions feature, per user:
 *    'r2'    → our Cloudflare R2 (the new system; default)
 *    'drive' → Google Drive (the original system)
 *  Controls which upload path the user's client takes; existing rounds
 *  keep working either way (each round knows its own backend). */
async function handleAdminSetUserStorage(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string; storageBackend?: string }
  const uid = String(body.uid || '').trim()
  const storageBackend = body.storageBackend === 'drive' ? 'drive' : 'r2'
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  await getDb().collection('users').doc(uid).update({ storageBackend })
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
  if (!(await verifyAdminStepUp(req))) {
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
  if (!(await verifyAdminStepUp(req))) {
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
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as {
    uid?: string
    days?: number
    demoteFirst?: boolean
  }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  const days = Math.max(1, Math.min(365, Math.floor(Number(body.days) || 7)))
  const db = getDb()

  if (body.demoteFirst) {
    await db
      .collection('users')
      .doc(uid)
      .update({ subscription: 'free' })
      .catch(() => undefined)
    // Also release any redeemed product keys — otherwise a user who is
    // Pro via a key (not via subscription:'pro') would keep Pro access
    // and the trial would be silently masked.
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
      console.warn('[admin] release keys on trial-demote failed:', err)
    }
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

async function handleAdminRevokeTrial(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  // Keep trialExpiresAt for the audit trail, just flip the status.
  await getDb().collection('users').doc(uid).update({ trialStatus: 'rejected' })
  return res.status(200).json({ ok: true })
}

/**
 * Admin → "ניסיון 7 יום" tab. FULL reset of a user's trial eligibility so
 * they can take a fresh 7-day trial again. Unlike revoke (which only flips the
 * status), this also DELETES the user's trial fingerprints — both the
 * email_* doc AND the device_* doc tied to this uid — because start-trial
 * blocks on either fingerprint existing. Used when support clears a trial for
 * a user (e.g. they got blocked by an old account on the same machine).
 */
async function handleAdminResetTrial(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { uid?: string }
  const uid = String(body.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid' })
  const db = getDb()

  // Delete every trial fingerprint owned by this uid (email_* + device_*).
  const fpSnap = await db
    .collection('trialFingerprints')
    .where('uid', '==', uid)
    .get()
  const batch = db.batch()
  fpSnap.docs.forEach((d) => batch.delete(d.ref))
  // Clear the user's trial state so the on-trial / already-used gates pass.
  batch.update(db.collection('users').doc(uid), {
    trialStatus: 'none',
    trialExpiresAt: null,
    trialRequestedAt: null,
    trialApprovedAt: null,
  })
  await batch.commit()

  return res
    .status(200)
    .json({ ok: true, fingerprintsDeleted: fpSnap.size })
}

/* ──────────────────────────────────────────────────────────────
 *  Device-check (support tool). Lets support figure out whether a
 *  machine already has an account that took a trial — for users who
 *  forgot they made an account on the same computer and can't
 *  understand why they get no free trial on a new account.
 *
 *  Flow: admin generates a one-time code (admin-device-check-create),
 *  sends the link https://dmplus.net/device-check/<code> to the user.
 *  The link opens the desktop app (dmplus:// protocol) OR the user
 *  pastes the code into the app manually. The app reports its device
 *  signature (device-check-report, public). The server looks up the
 *  device fingerprint and records which account (if any) already took
 *  a trial on that machine. Admin polls admin-device-check-get.
 * ────────────────────────────────────────────────────────────── */

/** Human-typeable one-time code, e.g. "K7Q2M-9XPRT". Avoids
 *  ambiguous chars (no I/O/0/1). Valid as a Firestore doc id. */
function genDeviceCheckCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(10)
  let s = ''
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length]
  return `${s.slice(0, 5)}-${s.slice(5)}`
}

async function handleAdminDeviceCheckCreate(
  req: VercelRequest,
  res: VercelResponse,
) {
  const adminEmail = await verifyAdminStepUp(req)
  if (!adminEmail) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const code = genDeviceCheckCode()
  const now = new Date()
  // 60-minute window — long enough to email the user and have them act.
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
  await getDb()
    .collection('deviceChecks')
    .doc(code)
    .set({
      code,
      createdAt: now.toISOString(),
      createdBy: adminEmail,
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
    })
  return res.status(200).json({
    ok: true,
    code,
    url: `https://dmplus.net/device-check/${code}`,
    expiresAt: expiresAt.toISOString(),
  })
}

async function handleAdminDeviceCheckGet(
  req: VercelRequest,
  res: VercelResponse,
) {
  // Read-only poll (every few seconds) — gate with the normal admin
  // 2FA session, NOT step-up, so it doesn't re-prompt a passkey on
  // every poll. The create action above is the step-up'd mutation.
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { code?: string }
  const code = String(body.code || (req.query.code as string) || '')
    .trim()
    .toUpperCase()
  if (!code) return res.status(400).json({ ok: false, error: 'code' })
  const snap = await getDb().collection('deviceChecks').doc(code).get()
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: 'not-found' })
  }
  return res.status(200).json({ ok: true, check: { id: snap.id, ...snap.data() } })
}

/**
 * PUBLIC — the desktop app calls this (it is NOT an admin). It is
 * gated by possession of a valid, unexpired code (admin-issued,
 * single-purpose, 60-min TTL). It records the reporting machine's
 * device signature and resolves whether any account already took a
 * trial on that machine. The matched account is NEVER returned to
 * the caller — only stored for the admin to read.
 */
async function handleDeviceCheckReport(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    code?: string
    deviceId?: string
    idToken?: string
  }
  const code = String(body.code || '').trim().toUpperCase()
  const deviceId = String(body.deviceId || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'קוד חסר' })
  if (!deviceId || deviceId.length < 16) {
    return res
      .status(400)
      .json({ ok: false, error: 'לא ניתן לזהות את המחשב' })
  }

  const db = getDb()
  const ref = db.collection('deviceChecks').doc(code)
  const snap = await ref.get()
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: 'קוד לא תקין' })
  }
  const data = snap.data() as { expiresAt?: string } | undefined
  if (data?.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
    return res.status(410).json({ ok: false, error: 'הקוד פג תוקף' })
  }

  // Optional logged-in context — which account is on this machine RIGHT
  // NOW (usually the confused "new" account). Best-effort; never required.
  let reportedByUid: string | null = null
  let reportedByEmail: string | null = null
  if (body.idToken) {
    try {
      const { getAuth } = await import('firebase-admin/auth')
      const dec = await getAuth(getFirebase()).verifyIdToken(String(body.idToken))
      reportedByUid = dec.uid
      reportedByEmail = (dec.email || '').toLowerCase() || null
    } catch {
      /* ignore — context only */
    }
  }

  // Resolve the device fingerprint → which account took a trial here.
  const san = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
  const fpSnap = await db
    .collection('trialFingerprints')
    .doc(`device_${san(deviceId)}`)
    .get()
  let matched = false
  let matchedUid: string | null = null
  let matchedEmail: string | null = null
  let matchedName: string | null = null
  let matchedTrialAt: string | null = null
  if (fpSnap.exists) {
    const fp = fpSnap.data() as
      | { uid?: string; email?: string; requestedAt?: string }
      | undefined
    matched = true
    matchedUid = fp?.uid || null
    matchedEmail = fp?.email || null
    matchedTrialAt = fp?.requestedAt || null
    if (matchedUid) {
      try {
        const us = await db.collection('users').doc(matchedUid).get()
        const ud = us.data() as
          | { name?: string; email?: string }
          | undefined
        matchedName = ud?.name || null
        if (!matchedEmail) matchedEmail = ud?.email || null
      } catch {
        /* ignore */
      }
    }
  }

  await ref.update({
    status: 'reported',
    deviceId,
    reportedAt: new Date().toISOString(),
    reportedByUid,
    reportedByEmail,
    matched,
    matchedUid,
    matchedEmail,
    matchedName,
    matchedTrialAt,
  })

  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Admin → Keys tab. Mirrors the desktop createKeys / deleteKey /
 *  setKeyExpiry helpers, server-side via the Admin SDK.
 * ────────────────────────────────────────────────────────────── */

async function handleAdminListKeys(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb().collection('productKeys').get()
  const keys = snap.docs.map((d) => ({
    ...(d.data() as Record<string, unknown>),
    id: d.id,
  }))
  return res.status(200).json({ ok: true, keys })
}

// ── Active subscriptions (admin "עסקאות וקבלות" tab) ──────────────────
// Lists every productKey with a live PayPal subscription + the account
// it's linked to, so the admin can stop auto-renewal for a user who was
// charged but didn't receive what they paid for.
async function handleAdminListSubscriptions(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb()
    .collection('productKeys')
    .where('subscriptionStatus', '==', 'active')
    .get()
  const subs = snap.docs
    .map((d) => {
      const k = d.data() as KeyDoc & { subscriptionCancelReason?: string }
      return {
        id: d.id,
        key: k.key || '',
        subscriptionId: k.subscriptionId || '',
        subscriptionStatus: k.subscriptionStatus || '',
        subscriptionPrice: k.subscriptionPrice ?? null,
        subscriptionCurrency: k.subscriptionCurrency ?? null,
        subscriptionPlanDays: k.subscriptionPlanDays ?? k.planDays ?? null,
        subscriptionStartedAt: k.subscriptionStartedAt ?? null,
        expiresAt: k.expiresAt ?? null,
        redeemedBy: k.redeemedBy ?? null,
        redeemedByEmail: k.redeemedByEmail ?? null,
        buyerEmail: k.buyerEmail ?? null,
        paymentFailedAt: k.paymentFailedAt ?? null,
      }
    })
    .filter((s) => s.subscriptionId)
  // Most recently started first.
  subs.sort((a, b) =>
    String(b.subscriptionStartedAt || '').localeCompare(
      String(a.subscriptionStartedAt || ''),
    ),
  )
  return res.status(200).json({ ok: true, subscriptions: subs })
}

// Admin-initiated cancellation: stops PayPal auto-renewal. The user keeps
// access until the current period's expiresAt (no future charges), matching
// the self-service /account cancel. Step-up gated (it touches billing).
async function handleAdminCancelSubscription(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { subscriptionId?: string; reason?: string }
  const subscriptionId = String(body.subscriptionId || '').trim()
  if (!subscriptionId) {
    return res.status(400).json({ ok: false, error: 'subscriptionId required' })
  }
  const reason =
    (body.reason || '').slice(0, MAX_REASON_LENGTH).trim() ||
    `Cancelled by admin (${admin}) via panel`

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
    // Already-cancelled on PayPal's side → reconcile our record and succeed.
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
  // Confirm to the customer that their subscription really was stopped.
  const recipient = key.buyerEmail || key.redeemedByEmail
  if (recipient) {
    void sendCancellationEmail({
      to: recipient,
      validUntil: key.expiresAt ? new Date(key.expiresAt) : null,
      reason,
      cancelledFrom: 'admin',
    }).catch((err) =>
      console.error('[admin-cancel-subscription] email failed:', err),
    )
  }
  return res.status(200).json({ ok: true, alreadyCancelled: false })
}

// ── Admin refund ─────────────────────────────────────────────────────
// Refunds the most recent completed charge on a subscription (full by
// default, or a specified partial amount). Uses PayPal's subscription
// transactions endpoint to find the capture id, then refunds it.
async function handleAdminRefundSubscription(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as {
    subscriptionId?: string
    amount?: number | string
    note?: string
  }
  const subscriptionId = String(body.subscriptionId || '').trim()
  if (!subscriptionId) {
    return res.status(400).json({ ok: false, error: 'subscriptionId required' })
  }

  // Find the latest COMPLETED transaction to refund.
  const end = new Date()
  const start = new Date(end.getTime() - 730 * 24 * 60 * 60 * 1000)
  let latest: {
    id: string
    value: string
    currency: string
    time: string
  } | null = null
  try {
    const payload = await paypalCall<PaypalTransactionPayload>(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(
        subscriptionId,
      )}/transactions?start_time=${encodeURIComponent(
        start.toISOString(),
      )}&end_time=${encodeURIComponent(end.toISOString())}`,
    )
    for (const t of payload.transactions ?? []) {
      if ((t.status || '').toUpperCase() !== 'COMPLETED') continue
      const g = t.amount_with_breakdown?.gross_amount
      if (!t.id || !g?.value) continue
      if (!latest || String(t.time || '') > latest.time) {
        latest = {
          id: t.id,
          value: g.value,
          currency: g.currency_code || 'ILS',
          time: String(t.time || ''),
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה'
    return res
      .status(502)
      .json({ ok: false, error: `שליפת העסקאות מ-PayPal נכשלה: ${message}` })
  }
  if (!latest) {
    return res
      .status(404)
      .json({ ok: false, error: 'לא נמצאה עסקה שניתן להחזיר עליה כסף' })
  }

  // Optional partial amount; default = full refund of the last charge.
  let refundBody: unknown = undefined
  const reqAmount =
    typeof body.amount === 'number'
      ? body.amount
      : body.amount != null && String(body.amount).trim() !== ''
        ? Number(body.amount)
        : NaN
  if (Number.isFinite(reqAmount) && reqAmount > 0) {
    if (reqAmount > Number(latest.value) + 0.001) {
      return res.status(400).json({
        ok: false,
        error: `הסכום גדול מהחיוב האחרון (${latest.value} ${latest.currency})`,
      })
    }
    refundBody = {
      amount: { value: reqAmount.toFixed(2), currency_code: latest.currency },
      note_to_payer: (body.note || 'Refund issued by support').slice(0, 250),
    }
  } else if (body.note) {
    refundBody = { note_to_payer: String(body.note).slice(0, 250) }
  }

  try {
    await paypalCall(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(latest.id)}/refund`,
      refundBody,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה'
    return res
      .status(502)
      .json({ ok: false, error: `החזר דרך PayPal נכשל: ${message}` })
  }

  // A refund always also STOPS the subscription — no point refunding a
  // charge and then letting it bill again. Best-effort: the refund
  // already succeeded, so a cancel hiccup must not fail the request.
  try {
    const db = getDb()
    const snap = await db
      .collection('productKeys')
      .where('subscriptionId', '==', subscriptionId)
      .limit(1)
      .get()
    if (!snap.empty) {
      const keyDoc = snap.docs[0]
      const key = keyDoc.data() as KeyDoc
      if (
        key.subscriptionStatus !== 'cancelled' &&
        key.subscriptionStatus !== 'expired'
      ) {
        await paypalCall(
          'POST',
          `/v1/billing/subscriptions/${subscriptionId}/cancel`,
          { reason: 'Refund issued by support' },
        ).catch((e) =>
          console.warn('[admin-refund] auto-cancel warn:', e),
        )
        await keyDoc.ref.update({
          subscriptionStatus: 'cancelled',
          subscriptionCancelledAt: new Date().toISOString(),
          subscriptionCancelReason: `Refunded by admin (${admin})`,
        })
        const recipient = key.buyerEmail || key.redeemedByEmail
        if (recipient) {
          void sendCancellationEmail({
            to: recipient,
            validUntil: key.expiresAt ? new Date(key.expiresAt) : null,
            reason: 'Refund issued by support',
            cancelledFrom: 'admin',
          }).catch((e) =>
            console.error('[admin-refund] email failed:', e),
          )
        }
      }
    }
  } catch (e) {
    console.warn('[admin-refund] reconcile warn:', e)
  }

  const refundedValue =
    Number.isFinite(reqAmount) && reqAmount > 0
      ? reqAmount.toFixed(2)
      : latest.value
  return res.status(200).json({
    ok: true,
    cancelled: true,
    refunded: { value: refundedValue, currency: latest.currency },
  })
}

// ── Admin link subscription → account ────────────────────────────────
// Re-binds a subscription's product key to a chosen account so the user
// gets (and keeps) Pro — including on future renewals — even if the
// original redemption never happened / went to the wrong account.
async function handleAdminLinkSubscription(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { subscriptionId?: string; email?: string }
  const subscriptionId = String(body.subscriptionId || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  if (!subscriptionId || !email) {
    return res
      .status(400)
      .json({ ok: false, error: 'subscriptionId + email required' })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }

  // Resolve the target account.
  let targetUid: string
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const rec = await getAuth(getFirebase()).getUserByEmail(email)
    targetUid = rec.uid
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') {
      return res
        .status(404)
        .json({ ok: false, error: 'משתמש עם המייל הזה לא קיים' })
    }
    console.error('[admin-link-subscription] getUserByEmail failed:', err)
    return res.status(500).json({ ok: false, error: 'lookup failed' })
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

  // Account-lock: unlink any OTHER keys currently bound to this account so
  // the linked subscription becomes their single active key (mirrors
  // /api/keys/redeem + admin-grant-pro).
  const priorSnap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', targetUid)
    .get()
  const replacedAt = new Date().toISOString()
  for (const d of priorSnap.docs) {
    if (d.id === keyDoc.id) continue
    await d.ref
      .update({ redeemedBy: null, redeemedByEmail: null, replacedAt })
      .catch(() => undefined)
  }

  const cur = keyDoc.data() as KeyDoc & { redeemedAt?: string }
  await keyDoc.ref.update({
    redeemedBy: targetUid,
    redeemedByEmail: email,
    buyerEmail: cur.buyerEmail || email,
    redeemedAt: cur.redeemedAt || new Date().toISOString(),
    linkedByAdmin: admin,
    linkedAt: new Date().toISOString(),
  })
  return res.status(200).json({ ok: true, uid: targetUid })
}

async function handleAdminCreateKey(req: VercelRequest, res: VercelResponse) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as { expiresAt?: string | null }
  // Validate expiry: null (perpetual) or a future ISO string.
  let expiresAt: string | null = null
  if (body.expiresAt) {
    const ms = new Date(body.expiresAt).getTime()
    if (!Number.isFinite(ms) || ms <= Date.now()) {
      return res.status(400).json({ ok: false, error: 'תוקף לא תקין' })
    }
    expiresAt = new Date(body.expiresAt).toISOString()
  }
  const db = getDb()
  // Retry on the astronomically-unlikely collision.
  let keyString = generateKeyString()
  for (let i = 0; i < 5; i++) {
    const exists = await db.collection('productKeys').doc(keyString).get()
    if (!exists.exists) break
    keyString = generateKeyString()
  }
  const data = {
    key: keyString,
    tier: 'pro' as const,
    redeemedBy: null,
    redeemedByEmail: null,
    redeemedAt: null,
    expiresAt,
    createdAt: new Date().toISOString(),
    createdBy: `admin-web:${admin}`,
  }
  await db.collection('productKeys').doc(keyString).set(data)
  return res.status(200).json({ ok: true, key: { ...data, id: keyString } })
}

async function handleAdminDeleteKey(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { keyId?: string }
  const keyId = String(body.keyId || '').trim()
  if (!keyId) return res.status(400).json({ ok: false, error: 'keyId' })
  await getDb().collection('productKeys').doc(keyId).delete()
  return res.status(200).json({ ok: true })
}

async function handleAdminSetKeyExpiry(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { keyId?: string; expiresAt?: string | null }
  const keyId = String(body.keyId || '').trim()
  if (!keyId) return res.status(400).json({ ok: false, error: 'keyId' })
  let expiresAt: string | null = null
  if (body.expiresAt) {
    const ms = new Date(body.expiresAt).getTime()
    if (!Number.isFinite(ms) || ms <= Date.now()) {
      return res.status(400).json({ ok: false, error: 'תאריך לא תקין' })
    }
    expiresAt = new Date(body.expiresAt).toISOString()
  }
  await getDb().collection('productKeys').doc(keyId).update({ expiresAt })
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Admin → Data tab. Per-user feature-usage analytics.
 * ────────────────────────────────────────────────────────────── */

async function handleAdminListUsageStats(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb()
    .collection('usageStats')
    .orderBy('date', 'desc')
    .limit(2000)
    .get()
  const stats = snap.docs.map((d) => d.data() as Record<string, unknown>)
  return res.status(200).json({ ok: true, stats })
}

/** Broadcast a "flush your local usage now" command to online
 *  clients (they listen on appConfig/usagePullCommand). */
async function handleAdminIssueUsagePull(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  await getDb()
    .collection('appConfig')
    .doc('usagePullCommand')
    .set({ issuedAt: new Date().toISOString(), issuedBy: admin })
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Admin → Feedback tab. (Screenshot images are served separately by
 *  /api/feedback?fileId=… which proxies Telegram.)
 * ────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────
 *  Admin → Settings. App config (beta/plan mode) + terms/privacy.
 *  (Pricing edits stay desktop-only — they touch PayPal plan sync.)
 * ────────────────────────────────────────────────────────────── */

async function handleAdminGetAppConfig(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb().collection('appConfig').doc('global').get()
  const d = (snap.exists ? snap.data() : {}) as {
    betaMode?: boolean
    planMode?: string
    logsPassword?: string
    proStorageGb?: number
    trialStorageGb?: number
    killSwitch?: boolean
    autoKill?: boolean
    dailyReadCeiling?: number
    dailyWriteCeiling?: number
    backupIntervalDays?: number
    backupIntervalMinutes?: number
    backupNotify?: boolean
    syncTelemetryDisabled?: boolean
    clientLogsDisabled?: boolean
  }
  // Sensitive fields (logs password + storage quotas) now live in the
  // admin-only adminConfig/global (clients can't read it). Prefer those;
  // fall back to the legacy appConfig copy during the transition.
  const adminSnap = await getDb().collection('adminConfig').doc('global').get()
  const ad = (adminSnap.exists ? adminSnap.data() : {}) as {
    logsPassword?: string
    proStorageGb?: number
    trialStorageGb?: number
  }
  if (typeof ad.logsPassword === 'string') d.logsPassword = ad.logsPassword
  if (typeof ad.proStorageGb === 'number') d.proStorageGb = ad.proStorageGb
  if (typeof ad.trialStorageGb === 'number') d.trialStorageGb = ad.trialStorageGb
  // Canonical backup cadence is now in MINUTES (lets the schedule go
  // below a day for testing / multiple-per-day). Older configs only
  // stored days — migrate on read so nothing breaks.
  const backupIntervalMinutes =
    typeof d.backupIntervalMinutes === 'number' && d.backupIntervalMinutes >= 1
      ? Math.round(d.backupIntervalMinutes)
      : typeof d.backupIntervalDays === 'number' && d.backupIntervalDays >= 1
        ? Math.round(d.backupIntervalDays) * 1440
        : 1440
  return res.status(200).json({
    ok: true,
    betaMode: d.betaMode === true,
    planMode: d.planMode === 'subscription' ? 'subscription' : 'hybrid',
    logsPassword: typeof d.logsPassword === 'string' ? d.logsPassword : '',
    // Storage quotas (GB). Defaults mirror the constants in
    // revisions.ts so the UI shows the real value before any override.
    proStorageGb:
      typeof d.proStorageGb === 'number' && d.proStorageGb > 0
        ? d.proStorageGb
        : 100,
    trialStorageGb:
      typeof d.trialStorageGb === 'number' && d.trialStorageGb > 0
        ? d.trialStorageGb
        : 1.5,
    // Cost protection / kill switch. 0 = off (no ceiling).
    killSwitch: d.killSwitch === true,
    autoKill: d.autoKill === true,
    dailyReadCeiling:
      typeof d.dailyReadCeiling === 'number' && d.dailyReadCeiling > 0
        ? d.dailyReadCeiling
        : 0,
    dailyWriteCeiling:
      typeof d.dailyWriteCeiling === 'number' && d.dailyWriteCeiling > 0
        ? d.dailyWriteCeiling
        : 0,
    // Backups: how often the daily cron actually creates a snapshot
    // (1 = every day) and whether to ping Telegram when it does.
    backupIntervalDays:
      typeof d.backupIntervalDays === 'number' && d.backupIntervalDays >= 1
        ? d.backupIntervalDays
        : 1,
    backupIntervalMinutes,
    backupNotify: d.backupNotify === true,
    syncTelemetryDisabled: d.syncTelemetryDisabled === true,
    clientLogsDisabled: d.clientLogsDisabled === true,
  })
}

async function handleAdminSetAppConfig(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as {
    betaMode?: boolean
    planMode?: string
    logsPassword?: string
    proStorageGb?: number
    trialStorageGb?: number
    killSwitch?: boolean
    autoKill?: boolean
    dailyReadCeiling?: number
    dailyWriteCeiling?: number
    backupIntervalDays?: number
    backupIntervalMinutes?: number
    backupNotify?: boolean
    syncTelemetryDisabled?: boolean
    clientLogsDisabled?: boolean
  }
  const patch: Record<string, unknown> = {}
  // Sensitive fields go to the admin-only adminConfig/global, NOT the
  // client-readable appConfig/global.
  const adminPatch: Record<string, unknown> = {}
  if (typeof body.betaMode === 'boolean') patch.betaMode = body.betaMode
  // Global pause for audio-sync telemetry ingestion — when true the
  // presign endpoint refuses, so users upload NOTHING new.
  if (typeof body.syncTelemetryDisabled === 'boolean') {
    patch.syncTelemetryDisabled = body.syncTelemetryDisabled
  }
  if (typeof body.clientLogsDisabled === 'boolean') {
    patch.clientLogsDisabled = body.clientLogsDisabled
  }
  if (body.planMode === 'hybrid' || body.planMode === 'subscription') {
    patch.planMode = body.planMode
  }
  // Logs/DevTools password for the desktop Ctrl+Shift+1 shortcut —
  // admin-only (verified server-side via verify-logs-password).
  if (typeof body.logsPassword === 'string') {
    adminPatch.logsPassword = body.logsPassword.trim()
  }
  // Per-tier R2 storage quotas in GB (fractional allowed, e.g. 1.5).
  // Bounded to a sane range so a typo can't hand out petabytes.
  const validGb = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100000
  if (body.proStorageGb !== undefined) {
    if (!validGb(body.proStorageGb)) {
      return res
        .status(400)
        .json({ ok: false, error: 'proStorageGb לא תקין (0–100000)' })
    }
    adminPatch.proStorageGb = body.proStorageGb
  }
  if (body.trialStorageGb !== undefined) {
    if (!validGb(body.trialStorageGb)) {
      return res
        .status(400)
        .json({ ok: false, error: 'trialStorageGb לא תקין (0–100000)' })
    }
    adminPatch.trialStorageGb = body.trialStorageGb
  }
  // ── Cost protection / kill switch ──────────────────────────────
  if (typeof body.killSwitch === 'boolean') patch.killSwitch = body.killSwitch
  if (typeof body.autoKill === 'boolean') patch.autoKill = body.autoKill
  // Ceilings: 0 (or any non-positive) means "off". Bound to a sane max
  // so a typo can't set an absurd value. Daily read/write counts.
  const validCeiling = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000_000
  if (body.dailyReadCeiling !== undefined) {
    if (!validCeiling(body.dailyReadCeiling)) {
      return res
        .status(400)
        .json({ ok: false, error: 'תקרת קריאות לא תקינה' })
    }
    patch.dailyReadCeiling = Math.round(body.dailyReadCeiling)
  }
  if (body.dailyWriteCeiling !== undefined) {
    if (!validCeiling(body.dailyWriteCeiling)) {
      return res
        .status(400)
        .json({ ok: false, error: 'תקרת כתיבות לא תקינה' })
    }
    patch.dailyWriteCeiling = Math.round(body.dailyWriteCeiling)
  }
  // ── Backups ────────────────────────────────────────────────────
  // Canonical unit is MINUTES (1 minute … 365 days). We keep
  // backupIntervalDays in sync for any legacy reader, but the cron +
  // the in-panel scheduler both read minutes.
  if (body.backupIntervalMinutes !== undefined) {
    const m = Number(body.backupIntervalMinutes)
    if (!Number.isFinite(m) || m < 1 || m > 365 * 1440) {
      return res
        .status(400)
        .json({ ok: false, error: 'תדירות גיבוי לא תקינה' })
    }
    patch.backupIntervalMinutes = Math.round(m)
    patch.backupIntervalDays = Math.max(1, Math.round(m / 1440))
  } else if (body.backupIntervalDays !== undefined) {
    const n = Number(body.backupIntervalDays)
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      return res
        .status(400)
        .json({ ok: false, error: 'תדירות גיבוי לא תקינה (1–365 ימים)' })
    }
    patch.backupIntervalDays = Math.round(n)
    patch.backupIntervalMinutes = Math.round(n) * 1440
  }
  if (typeof body.backupNotify === 'boolean') {
    patch.backupNotify = body.backupNotify
  }
  if (Object.keys(patch).length === 0 && Object.keys(adminPatch).length === 0) {
    return res.status(400).json({ ok: false, error: 'no fields' })
  }
  if (Object.keys(patch).length > 0) {
    await getDb()
      .collection('appConfig')
      .doc('global')
      .set(patch, { merge: true })
  }
  // Sensitive fields → admin-only doc, and DELETE any legacy copies left
  // in the client-readable appConfig/global so they stop being exposed.
  if (Object.keys(adminPatch).length > 0) {
    await getDb()
      .collection('adminConfig')
      .doc('global')
      .set(adminPatch, { merge: true })
    const strip: Record<string, unknown> = {}
    for (const k of Object.keys(adminPatch)) strip[k] = FieldValue.delete()
    await getDb()
      .collection('appConfig')
      .doc('global')
      .set(strip, { merge: true })
  }
  // Reflect a kill-switch change in this instance's cache immediately so
  // the operator sees maintenance mode engage/disengage without waiting
  // out the 30s TTL.
  if (typeof body.killSwitch === 'boolean') {
    primeKillCache(body.killSwitch)
    await sendTelegramAlert(
      body.killSwitch
        ? '🟠 מצב תחזוקה (Kill-switch) הופעל ידנית — האתר והתוכנה חסומים למשתמשים.'
        : '✅ מצב תחזוקה (Kill-switch) כובה — השירות חזר לפעול.',
    )
  }
  // If the backup cadence changed, push the matching schedule to the
  // Cloudflare backup worker so it fires only when needed (one request
  // per due time) instead of polling. Best-effort: surfaced to the UI
  // but never fails the save.
  let backupCron: { synced: boolean; cron: string; error?: string } | undefined
  if (patch.backupIntervalMinutes !== undefined) {
    backupCron = await syncBackupCron(patch.backupIntervalMinutes as number)
  }
  return res.status(200).json({ ok: true, ...(backupCron ? { backupCron } : {}) })
}

/* ── Backup admin actions ─────────────────────────────────────── */

/** Create a manual backup now (admin-only). */
async function handleAdminCreateBackup(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  try {
    const info = await createBackup('manual')
    return res.status(200).json({ ok: true, backup: info })
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: (e as Error)?.message || 'גיבוי נכשל' })
  }
}

const BACKUP_KEEP_AUTO = 30

/** Read the configured backup cadence in MINUTES (migrating older
 *  day-only configs). Defaults to a day. */
async function readBackupIntervalMinutes(): Promise<number> {
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    const d = (snap.exists ? snap.data() : {}) as {
      backupIntervalMinutes?: number
      backupIntervalDays?: number
    }
    if (typeof d.backupIntervalMinutes === 'number' && d.backupIntervalMinutes >= 1) {
      return Math.round(d.backupIntervalMinutes)
    }
    if (typeof d.backupIntervalDays === 'number' && d.backupIntervalDays >= 1) {
      return Math.round(d.backupIntervalDays) * 1440
    }
  } catch {
    /* fall through to default */
  }
  return 1440
}

/**
 *  Run ONE auto-backup tick: if enough time has passed since the last
 *  auto snapshot, create a new one and prune to BACKUP_KEEP_AUTO. This
 *  is the single source of truth for "is a backup due", called both by
 *  the in-panel scheduler (every minute, while the admin is logged in
 *  — enables sub-daily / minute cadences and quick testing) and as a
 *  twin of the daily Vercel cron (which covers when nobody's looking).
 *
 *  Due-check uses a skew margin so a tick that fires a hair BEFORE the
 *  exact interval boundary still counts as due — that off-by-seconds gap
 *  (snapshot is written seconds after the tick starts; the next tick can
 *  fire microseconds early) is exactly what made the daily cron skip
 *  every other day and look "stuck after the first backup".
 */
async function handleAdminRunAutoBackup(
  req: VercelRequest,
  res: VercelResponse,
) {
  // Two ways in:
  //   1) An admin in the panel (verifyAdmin2FA) — the in-panel heartbeat.
  //   2) A server-side scheduler with the shared secret — this is what
  //      makes sub-daily backups run with NO device open at all (Vercel's
  //      own cron only fires once a day on the current plan, so an
  //      external pinger hits this every N minutes with the secret).
  const auth = req.headers['authorization']
  const bodySecret = (req.body as { secret?: string })?.secret
  // Accept EITHER configured secret — CRON_SECRET (used by Vercel's own
  // cron) OR BACKUP_TRIGGER_SECRET (the dedicated backup-worker secret).
  // A plain `A || B` would only ever check CRON_SECRET when it's set, so
  // the worker's BACKUP_TRIGGER_SECRET was being ignored → 403.
  const secrets = [
    process.env.CRON_SECRET,
    process.env.BACKUP_TRIGGER_SECRET,
  ].filter((s): s is string => !!s)
  const viaSecret = secrets.some(
    (s) => auth === `Bearer ${s}` || bodySecret === s,
  )
  if (!viaSecret && !(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  try {
    const intervalMinutes = await readBackupIntervalMinutes()
    const intervalMs = intervalMinutes * 60_000
    const r2 = getBackupR2()
    const listed = await r2.send(
      new ListObjectsV2Command({
        Bucket: BACKUP_BUCKET,
        Prefix: `${BACKUP_PREFIX}auto-`,
      }),
    )
    const autos = (listed.Contents || [])
      .filter((o) => o.Key)
      .sort(
        (a, b) =>
          (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0),
      )
    const newest = autos[0]?.LastModified?.getTime() || 0
    const ageMs = newest ? Date.now() - newest : Infinity
    // Tolerate clock/scheduler jitter: due slightly before the exact mark.
    const skew = Math.max(5_000, Math.min(intervalMs * 0.1, 6 * 60 * 60 * 1000))

    if (newest && ageMs < intervalMs - skew) {
      return res.status(200).json({
        ok: true,
        created: false,
        skipped: true,
        intervalMinutes,
        lastAutoAt: new Date(newest).toISOString(),
        nextDueInMs: Math.max(0, intervalMs - ageMs),
      })
    }

    const info = await createBackup('auto')

    // Prune: keep the newest BACKUP_KEEP_AUTO (we just added one, so
    // delete everything in the OLD list beyond KEEP-1).
    let pruned = 0
    for (const o of autos.slice(BACKUP_KEEP_AUTO - 1)) {
      if (!o.Key) continue
      try {
        await r2.send(
          new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: o.Key }),
        )
        pruned += 1
      } catch {
        /* best effort */
      }
    }

    // Telegram alert on a real auto-backup, if the admin enabled it.
    try {
      const cfgSnap = await getDb().collection('appConfig').doc('global').get()
      const notify =
        (cfgSnap.exists ? cfgSnap.data() : undefined)?.backupNotify === true
      if (notify) {
        await sendTelegramAlert(
          `💾 גיבוי אוטומטי בוצע\n${info.docCount.toLocaleString()} מסמכים · ${(
            info.sizeBytes / 1024
          ).toFixed(0)} KB`,
          {
            // Inline button → expands the message into a per-collection
            // breakdown when pressed (handled by the telegram-webhook
            // action). callback_data carries the backup key (well under
            // Telegram's 64-byte cap).
            replyMarkup: {
              inline_keyboard: [
                [{ text: '📊 פירוט הגיבוי', callback_data: `bksum:${info.key}` }],
              ],
            },
          },
        )
      }
    } catch {
      /* alert is best-effort; never fail the backup over it */
    }

    return res.status(200).json({
      ok: true,
      created: true,
      intervalMinutes,
      pruned,
      backup: info,
    })
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: (e as Error)?.message || 'גיבוי אוטומטי נכשל' })
  }
}

/** List every backup in R2 with date + size + type. */
async function handleAdminListBackups(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  try {
    const out = await getBackupR2().send(
      new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, Prefix: BACKUP_PREFIX }),
    )
    const backups = (out.Contents || [])
      .map((o) => {
        const key = o.Key || ''
        const fname = key.slice(BACKUP_PREFIX.length)
        const type = fname.split('-')[0] || 'auto' // manual | auto | prerestore
        return {
          key,
          type,
          sizeBytes: o.Size || 0,
          createdAt: o.LastModified
            ? new Date(o.LastModified).toISOString()
            : null,
        }
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    const totalBytes = backups.reduce((s, b) => s + b.sizeBytes, 0)
    return res
      .status(200)
      .json({ ok: true, backups, count: backups.length, totalBytes })
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: (e as Error)?.message || 'טעינה נכשלה' })
  }
}

/** Delete a single backup (step-up gated — destructive). */
async function handleAdminDeleteBackup(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const key = (req.body as { key?: string })?.key
  if (typeof key !== 'string' || !key.startsWith(BACKUP_PREFIX)) {
    return res.status(400).json({ ok: false, error: 'invalid key' })
  }
  await getBackupR2().send(
    new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }),
  )
  return res.status(200).json({ ok: true })
}

/** Short-lived presigned download URL for a backup (admin-only). */
async function handleAdminDownloadBackup(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const key = (req.body as { key?: string })?.key
  if (typeof key !== 'string' || !key.startsWith(BACKUP_PREFIX)) {
    return res.status(400).json({ ok: false, error: 'invalid key' })
  }
  // Force a real file download (not an in-browser JSON view) by setting
  // Content-Disposition on the presigned response.
  const filename = key.slice(BACKUP_PREFIX.length) || 'backup.json'
  const url = await getSignedUrl(
    getBackupR2(),
    new GetObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType: 'application/json',
    }),
    { expiresIn: 600 },
  )
  return res.status(200).json({ ok: true, url })
}

/** Upload a backup JSON file (e.g. one previously downloaded) back into
 *  R2 so it shows in the list and can be restored. Validates structure
 *  + caps size. Admin-only (2FA); restoring it still needs step-up. */
async function handleAdminUploadBackup(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const content = (req.body as { content?: string })?.content
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ ok: false, error: 'קובץ ריק' })
  }
  if (Buffer.byteLength(content, 'utf8') > 6 * 1024 * 1024) {
    return res
      .status(400)
      .json({ ok: false, error: 'הקובץ גדול מדי (מקסימום 6MB דרך ההעלאה)' })
  }
  let parsed: BackupPayload
  try {
    parsed = JSON.parse(content) as BackupPayload
  } catch {
    return res.status(400).json({ ok: false, error: 'קובץ אינו JSON תקין' })
  }
  if (!parsed || !Array.isArray(parsed.docs)) {
    return res
      .status(400)
      .json({ ok: false, error: 'הקובץ אינו גיבוי תקין (חסר docs)' })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const key = `${BACKUP_PREFIX}uploaded-${stamp}.json`
  await getBackupR2().send(
    new PutObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: key,
      Body: content,
      ContentType: 'application/json',
    }),
  )
  return res.status(200).json({ ok: true, key, docCount: parsed.docs.length })
}

/** Read a backup from R2 and tally per-collection doc counts + meta.
 *  Shared by the admin-panel summary action and the Telegram drill-in
 *  button — both want the same "what's inside this snapshot" view. */
async function computeBackupSummary(key: string): Promise<{
  createdAt: string | null
  type: string | null
  docCount: number
  sizeBytes: number
  collections: Array<{ name: string; count: number }>
}> {
  const obj = await getBackupR2().send(
    new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }),
  )
  const text = await (
    obj.Body as { transformToString: () => Promise<string> }
  ).transformToString()
  const payload = JSON.parse(text) as BackupPayload
  const counts: Record<string, number> = {}
  for (const d of payload.docs || []) {
    // The top path segment is the (top-level) collection name; nested
    // docs (e.g. notes) are grouped under their nearest collection id.
    const segs = (d.path || '').split('/')
    const col = segs.length >= 2 ? segs[segs.length - 2] : segs[0] || '—'
    counts[col] = (counts[col] || 0) + 1
  }
  const collections = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return {
    createdAt: payload.createdAt || null,
    type: payload.type || null,
    docCount: payload.docCount ?? (payload.docs || []).length,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    collections,
  }
}

/** Newest snapshot key across all backup types — fallback for the
 *  Telegram button when the callback didn't carry a usable key. */
async function findNewestBackupKey(): Promise<string | null> {
  const listed = await getBackupR2().send(
    new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, Prefix: BACKUP_PREFIX }),
  )
  const items = (listed.Contents || [])
    .filter((o) => o.Key)
    .sort(
      (a, b) =>
        (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0),
    )
  return items[0]?.Key || null
}

/** Inspect a backup: per-collection document counts + metadata, so the
 *  admin can see exactly what a snapshot contains. */
async function handleAdminBackupSummary(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const key = (req.body as { key?: string })?.key
  if (typeof key !== 'string' || !key.startsWith(BACKUP_PREFIX)) {
    return res.status(400).json({ ok: false, error: 'invalid key' })
  }
  const summary = await computeBackupSummary(key)
  return res.status(200).json({ ok: true, ...summary })
}

/** Hebrew per-collection breakdown for the Telegram "פירוט" button. */
function formatBackupSummaryTelegram(s: {
  createdAt: string | null
  type: string | null
  docCount: number
  sizeBytes: number
  collections: Array<{ name: string; count: number }>
}): string {
  let when = '—'
  if (s.createdAt) {
    try {
      when = new Date(s.createdAt).toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem',
      })
    } catch {
      when = s.createdAt
    }
  }
  const kb = (s.sizeBytes / 1024).toFixed(0)
  const lines = s.collections.map(
    (c) => `• ${c.name} — ${c.count.toLocaleString()}`,
  )
  return [
    '📊 פירוט הגיבוי',
    `🕒 ${when}`,
    `📦 סה"כ ${s.docCount.toLocaleString()} מסמכים · ${kb} KB`,
    '',
    ...(lines.length ? lines : ['(אין מסמכים)']),
  ].join('\n')
}

/** Telegram webhook — handles the inline-button presses on operational
 *  alerts (currently the backup "📊 פירוט" drill-in). Public URL, but
 *  protected by Telegram's secret-token header (set via setWebhook) AND
 *  a chat-id allowlist, so only the owner's alert chat can drive it.
 *  Always answers 200 so Telegram doesn't retry. */
async function handleTelegramWebhook(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  const got = req.headers['x-telegram-bot-api-secret-token']
  // Bad/absent secret → silently no-op (200) so a probe learns nothing.
  if (!secret || got !== secret) return res.status(200).json({ ok: true })
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
  if (!token) return res.status(200).json({ ok: true })

  const update = (req.body || {}) as {
    callback_query?: {
      id: string
      data?: string
      message?: { message_id?: number; chat?: { id?: number | string } }
    }
  }
  const cq = update.callback_query
  if (!cq) return res.status(200).json({ ok: true })

  const tg = (method: string, body: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  const answer = (text?: string) =>
    tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      ...(text ? { text } : {}),
    })

  // Only the configured alert chat may use these buttons.
  const chatId = cq.message?.chat?.id
  const allowedChat = process.env.TELEGRAM_ALERT_CHAT_ID
  if (allowedChat && String(chatId) !== String(allowedChat)) {
    await answer('לא מורשה')
    return res.status(200).json({ ok: true })
  }

  const data = String(cq.data || '')
  if (data.startsWith('bksum:')) {
    try {
      let key = data.slice('bksum:'.length)
      if (!key || !key.startsWith(BACKUP_PREFIX)) {
        key = (await findNewestBackupKey()) || ''
      }
      if (!key) {
        await answer('לא נמצא גיבוי')
        return res.status(200).json({ ok: true })
      }
      const summary = await computeBackupSummary(key)
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: cq.message?.message_id,
        text: formatBackupSummaryTelegram(summary),
        disable_web_page_preview: true,
      })
      await answer()
    } catch (e) {
      console.error('[telegram-webhook] bksum failed:', e)
      await answer('שגיאה בשליפת הפירוט')
    }
  } else {
    await answer()
  }
  return res.status(200).json({ ok: true })
}

/** Build the webhook URL from the request host so it ALWAYS points at a
 *  host that actually serves (Telegram doesn't follow redirects, so a
 *  www/non-www mismatch would silently break delivery). Falls back to
 *  the canonical base if the host header is absent. */
function telegramWebhookUrl(req: VercelRequest): string {
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ||
    (req.headers.host as string | undefined)
  const base = host ? `https://${host}` : WEBSITE_BASE
  return `${base}/api/paypal?action=telegram-webhook`
}

/** Call Telegram setWebhook with our endpoint + secret token. Shared by
 *  the admin action and the browser-link setup. */
async function registerTelegramWebhook(
  req: VercelRequest,
): Promise<{ ok: boolean; url: string; telegram: unknown; error?: string }> {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!token) return { ok: false, url: '', telegram: null, error: 'TELEGRAM_ALERT_BOT_TOKEN missing' }
  if (!secret) return { ok: false, url: '', telegram: null, error: 'TELEGRAM_WEBHOOK_SECRET missing' }
  const url = telegramWebhookUrl(req)
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ['callback_query'],
    }),
  })
  const telegram = await r.json().catch(() => ({}))
  return { ok: true, url, telegram }
}

/** One-time setup: point the alert bot's webhook at this endpoint with
 *  a secret token, and subscribe ONLY to callback_query updates. Admin-
 *  gated; reads the token + secret from env so they never leave Vercel. */
async function handleAdminTelegramSetupWebhook(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const result = await registerTelegramWebhook(req)
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error })
  return res.status(200).json({ ok: true, url: result.url, telegram: result.telegram })
}

/** Browser-friendly one-time setup: open
 *    /api/paypal?action=telegram-setup&secret=<TELEGRAM_WEBHOOK_SECRET>
 *  in a browser to register the webhook — no terminal/curl needed. The
 *  query secret must match the env secret (which only the operator
 *  knows), so it's a safe self-service trigger. GET-allowed. */
async function handleTelegramSetup(req: VercelRequest, res: VercelResponse) {
  const provided =
    typeof req.query.secret === 'string' ? req.query.secret : ''
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) {
    return res
      .status(400)
      .json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET missing in env' })
  }
  if (!provided || provided !== secret) {
    return res.status(403).json({ ok: false, error: 'secret mismatch' })
  }
  const result = await registerTelegramWebhook(req)
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error })
  return res.status(200).json({
    ok: true,
    message: 'Webhook registered. הכפתור יעבוד בגיבוי הבא.',
    url: result.url,
    telegram: result.telegram,
  })
}

/** Collections that are restored as a UNION (never purged), to avoid
 *  locking the admin out: restoring an old backup must not delete a
 *  passkey / gate created after that backup. */
const RESTORE_NEVER_PURGE = new Set(['adminCredentials', 'adminSecurity'])

/** Restore a backup so the database EXACTLY matches the snapshot
 *  (step-up gated — DANGEROUS). For every collection the backup
 *  captured it: (a) upserts all backed-up docs, and (b) DELETES any
 *  current doc in those collections that wasn't in the backup — so
 *  items created after the backup are removed. Always snapshots the
 *  current state first ("prerestore") so the operation is reversible.
 *  admin-auth collections are union-only (never purged) to prevent a
 *  lockout. Collections the backup did NOT capture are left untouched. */
async function handleAdminRestoreBackup(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const key = (req.body as { key?: string })?.key
  if (typeof key !== 'string' || !key.startsWith(BACKUP_PREFIX)) {
    return res.status(400).json({ ok: false, error: 'invalid key' })
  }
  // 1) Safety snapshot of the current state before we touch anything.
  let safetyBackupKey = ''
  try {
    safetyBackupKey = (await createBackup('prerestore')).key
  } catch {
    /* if the safety snapshot fails, still proceed — the chosen backup
       is the user's explicit intent. */
  }
  // 2) Fetch + parse the chosen backup.
  const obj = await getBackupR2().send(
    new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }),
  )
  const text = await (obj.Body as { transformToString: () => Promise<string> }).transformToString()
  const payload = JSON.parse(text) as BackupPayload
  if (!Array.isArray(payload.docs)) {
    return res.status(400).json({ ok: false, error: 'גיבוי פגום' })
  }
  const db = getDb()
  const backupPaths = new Set(
    payload.docs.map((d) => d?.path).filter((p): p is string => typeof p === 'string'),
  )

  // Which collections does this backup own? Prefer the recorded list;
  // fall back to deriving it from the doc paths (older backups).
  const ownedCollections =
    Array.isArray(payload.collections) && payload.collections.length
      ? payload.collections
      : [...new Set(
          [...backupPaths].map((p) => {
            const segs = p.split('/')
            return segs.length >= 2 ? segs[segs.length - 2] : segs[0]
          }),
        )]

  // 3) PURGE: delete current docs (in the owned collections) that are
  //    NOT in the backup — except the admin-auth carve-out.
  let deleted = 0
  const CHUNK = 400
  for (const name of ownedCollections) {
    if (RESTORE_NEVER_PURGE.has(name)) continue
    let snap
    try {
      snap = await db.collectionGroup(name).get()
    } catch {
      continue // unknown / unqueryable collection — skip
    }
    const stale = snap.docs.filter((d) => !backupPaths.has(d.ref.path))
    for (let i = 0; i < stale.length; i += CHUNK) {
      const batch = db.batch()
      for (const d of stale.slice(i, i + CHUNK)) {
        batch.delete(d.ref)
        deleted += 1
      }
      await batch.commit()
    }
  }

  // 4) UPSERT: write every backed-up doc back (Firestore batch ≤ 500).
  let restored = 0
  for (let i = 0; i < payload.docs.length; i += CHUNK) {
    const batch = db.batch()
    for (const item of payload.docs.slice(i, i + CHUNK)) {
      if (!item || typeof item.path !== 'string') continue
      batch.set(
        db.doc(item.path),
        reviveFromBackup(item.data) as FirebaseFirestore.DocumentData,
      )
      restored += 1
    }
    await batch.commit()
  }

  await sendTelegramAlert(
    `♻️ בוצע שחזור גיבוי\n${restored} מסמכים שוחזרו, ${deleted} נמחקו (חדשים יותר)\nמ-${key}\n(גיבוי בטיחות נשמר: ${safetyBackupKey || 'לא נוצר'})`,
  )
  return res.status(200).json({
    ok: true,
    restored,
    deleted,
    total: payload.docs.length,
    safetyBackupKey,
  })
}

/* ── Client error logs (admin views of the aggregated clientErrors) ── */

/** Grouped list: one row per unique error, newest first. No samples. */
async function handleAdminListClientErrors(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb().collection('clientErrors').get()
  const errors = snap.docs
    .map((d) => {
      const x = d.data() as Record<string, unknown>
      return {
        fingerprint: d.id,
        level: x.level || 'error',
        message: x.message || '',
        count: x.count || 0,
        deviceCount: x.deviceCount || 0,
        firstSeenAt: x.firstSeenAt || null,
        lastSeenAt: x.lastSeenAt || null,
        lastVersion: x.lastVersion || '?',
        lastPlatform: x.lastPlatform || '?',
        resolved: x.resolved === true,
      }
    })
    .sort((a, b) =>
      String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')),
    )
  const open = errors.filter((e) => !e.resolved).length
  return res.status(200).json({ ok: true, errors, count: errors.length, open })
}

/** Full detail for one error group, including sample occurrences. */
async function handleAdminGetClientError(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const fp = String((req.body as { fingerprint?: string })?.fingerprint || '')
  if (!fp) return res.status(400).json({ ok: false, error: 'fingerprint' })
  const snap = await getDb().collection('clientErrors').doc(fp).get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'not found' })
  return res.status(200).json({ ok: true, error: { id: snap.id, ...snap.data() } })
}

/** Mark an error resolved / unresolved (low-risk toggle, 2FA). */
async function handleAdminResolveClientError(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { fingerprint?: string; resolved?: boolean }
  const fp = String(body.fingerprint || '')
  if (!fp) return res.status(400).json({ ok: false, error: 'fingerprint' })
  await getDb()
    .collection('clientErrors')
    .doc(fp)
    .set({ resolved: body.resolved === true }, { merge: true })
  return res.status(200).json({ ok: true })
}

/** Delete one error group (step-up). */
async function handleAdminDeleteClientError(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const fp = String((req.body as { fingerprint?: string })?.fingerprint || '')
  if (!fp) return res.status(400).json({ ok: false, error: 'fingerprint' })
  await getDb().collection('clientErrors').doc(fp).delete()
  return res.status(200).json({ ok: true })
}

/** Clear ALL error logs (step-up). Batched delete. */
async function handleAdminClearClientErrors(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const db = getDb()
  const snap = await db.collection('clientErrors').get()
  let deleted = 0
  const CHUNK = 400
  for (let i = 0; i < snap.docs.length; i += CHUNK) {
    const batch = db.batch()
    for (const d of snap.docs.slice(i, i + CHUNK)) {
      batch.delete(d.ref)
      deleted += 1
    }
    await batch.commit()
  }
  return res.status(200).json({ ok: true, deleted })
}

/* ── Audio-sync telemetry (opt-in, for engine tuning) — R2 edition ──────────
 *  The desktop app stages a full anonymized snapshot per sync (every candidate's
 *  metrics + run context + the raw acoustic fingerprints) and uploads it STRAIGHT
 *  to Cloudflare R2 under `sync-telemetry/` (see api/revisions.ts sync-telemetry-
 *  init). The admin "לוגים" tab downloads a MANIFEST: every object's key + a
 *  short-lived presigned GET URL (option ב — lightweight, no serverless memory
 *  limit even with heavy fingerprints; the files are fetched from R2 directly).
 *  Manifest = 2FA; clear (delete every object) = step-up.
 * ────────────────────────────────────────────────────────────────────────── */
const SYNC_TELE_PREFIX = 'sync-telemetry/'
const SYNC_TELE_MAX = 20_000 // safety cap on objects manifested/deleted per call

async function listSyncTelemetryObjects(): Promise<
  { key: string; size: number }[]
> {
  const out: { key: string; size: number }[] = []
  let token: string | undefined
  do {
    const r = await getBackupR2().send(
      new ListObjectsV2Command({
        Bucket: BACKUP_BUCKET,
        Prefix: SYNC_TELE_PREFIX,
        ContinuationToken: token,
      }),
    )
    for (const o of r.Contents || []) {
      if (!o.Key || o.Key.endsWith('/')) continue // skip folder markers
      out.push({ key: o.Key, size: o.Size || 0 })
      if (out.length >= SYNC_TELE_MAX) return out
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return out
}

async function handleAdminSyncTelemetryExport(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const objs = await listSyncTelemetryObjects()
  const TTL = 6 * 60 * 60 // 6h — long enough to download the whole set
  const events: { key: string; url: string; size: number }[] = []
  const fingerprints: { hash: string; url: string; size: number }[] = []
  const timelines: { key: string; url: string; size: number }[] = []
  for (const o of objs) {
    const url = await getSignedUrl(
      getBackupR2(),
      new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: o.key }),
      { expiresIn: TTL },
    )
    if (o.key.startsWith(`${SYNC_TELE_PREFIX}fingerprints/`)) {
      const hash = o.key.split('/').pop()?.replace(/\.bin\.gz$/, '') || ''
      fingerprints.push({ hash, url, size: o.size })
    } else if (o.key.startsWith(`${SYNC_TELE_PREFIX}events/`)) {
      events.push({ key: o.key, url, size: o.size })
    } else if (o.key.startsWith(`${SYNC_TELE_PREFIX}timelines/`)) {
      timelines.push({ key: o.key, url, size: o.size })
    }
  }
  events.sort((a, b) => b.key.localeCompare(a.key)) // newest date first
  return res.status(200).json({
    ok: true,
    events,
    fingerprints,
    timelines,
    count: events.length,
    fingerprintCount: fingerprints.length,
    timelineCount: timelines.length,
    truncated: objs.length >= SYNC_TELE_MAX,
    urlTtlSeconds: TTL,
    exportedAt: new Date().toISOString(),
  })
}

/* ── Admin: coupon management (step-up gated like every mutation) ── */
async function handleAdminListCoupons(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb().collection('coupons').get()
  const coupons = snap.docs
    .map((d) => {
      const c = d.data() as CouponDoc
      return {
        code: d.id,
        pct: c.pct,
        plans: c.plans || 'both',
        duration: c.duration === 'first' ? 'first' : 'forever',
        active: c.active !== false,
        expiresAt: c.expiresAt || null,
        maxUses: c.maxUses || null,
        usedCount: c.usedCount || 0,
        note: c.note || '',
        createdAt: c.createdAt || '',
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return res.status(200).json({ ok: true, coupons })
}

async function handleAdminCreateCoupon(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const b = (req.body || {}) as {
    code?: string
    pct?: number
    plans?: string
    duration?: string
    expiresAt?: number | null
    maxUses?: number | null
    note?: string
  }
  const code = normCouponCode(String(b.code || ''))
  if (!code) {
    return res
      .status(400)
      .json({ ok: false, error: 'קוד לא תקין (3–32 תווים: A-Z, 0-9, מקף)' })
  }
  const pct = Math.round(Number(b.pct) || 0)
  if (!(pct >= 1 && pct <= COUPON_MAX_PCT)) {
    return res
      .status(400)
      .json({ ok: false, error: `אחוז הנחה חייב להיות בין 1 ל-${COUPON_MAX_PCT}` })
  }
  const plans =
    b.plans === 'monthly' || b.plans === 'yearly' ? b.plans : 'both'
  const duration = b.duration === 'first' ? 'first' : 'forever'
  const doc: CouponDoc = {
    code,
    pct,
    plans,
    duration,
    active: true,
    expiresAt:
      typeof b.expiresAt === 'number' && b.expiresAt > Date.now()
        ? b.expiresAt
        : null,
    maxUses:
      typeof b.maxUses === 'number' && b.maxUses > 0
        ? Math.min(100000, Math.round(b.maxUses))
        : null,
    usedCount: 0,
    note: String(b.note || '').slice(0, 200),
    createdAt: new Date().toISOString(),
  }
  const ref = getDb().collection('coupons').doc(code)
  if ((await ref.get()).exists) {
    return res.status(400).json({ ok: false, error: 'קוד כזה כבר קיים' })
  }
  await ref.set(doc)
  return res.status(200).json({ ok: true })
}

async function handleAdminSetCouponActive(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const b = (req.body || {}) as { code?: string; active?: boolean }
  const code = normCouponCode(String(b.code || ''))
  if (!code) return res.status(400).json({ ok: false, error: 'קוד לא תקין' })
  await getDb()
    .collection('coupons')
    .doc(code)
    .set({ active: b.active === true }, { merge: true })
  return res.status(200).json({ ok: true })
}

async function handleAdminDeleteCoupon(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const b = (req.body || {}) as { code?: string }
  const code = normCouponCode(String(b.code || ''))
  if (!code) return res.status(400).json({ ok: false, error: 'קוד לא תקין' })
  const ref = getDb().collection('coupons').doc(code)
  // best-effort purge of the uses subcollection (bounded)
  const uses = await ref.collection('uses').limit(500).get()
  for (const d of uses.docs) await d.ref.delete()
  await ref.delete()
  return res.status(200).json({ ok: true })
}

/* On-demand version of the cron storage janitor (see
 * api/cron/expiry-reminders.ts runStorageJanitor): aborts incomplete
 * multipart uploads and deletes orphaned round/delivery media, both
 * older than 48h. The daily cron gives the automatic guarantee; this
 * button lets the admin clean NOW after spotting garbage on the
 * dashboard. */
async function handleAdminStorageCleanup(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const GRACE_MS = 48 * 60 * 60 * 1000
  const cutoff = Date.now() - GRACE_MS
  const r2 = getBackupR2()

  let multipartsAborted = 0
  let keyMarker: string | undefined
  let idMarker: string | undefined
  do {
    const r = await r2.send(
      new ListMultipartUploadsCommand({
        Bucket: BACKUP_BUCKET,
        KeyMarker: keyMarker,
        UploadIdMarker: idMarker,
      }),
    )
    for (const u of r.Uploads || []) {
      if (!u.Key || !u.UploadId) continue
      const t = u.Initiated ? new Date(u.Initiated).getTime() : 0
      if (t && t > cutoff) continue
      try {
        await r2.send(
          new AbortMultipartUploadCommand({
            Bucket: BACKUP_BUCKET,
            Key: u.Key,
            UploadId: u.UploadId,
          }),
        )
        multipartsAborted += 1
      } catch {
        /* keep sweeping */
      }
    }
    keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined
    idMarker = r.IsTruncated ? r.NextUploadIdMarker : undefined
  } while (keyMarker || idMarker)

  const referenced = new Set<string>()
  const projSnap = await getDb().collection('revisionProjects').get()
  for (const d of projSnap.docs) {
    const k = (d.data() as { r2Key?: string }).r2Key
    if (k) referenced.add(k)
  }
  const delivSnap = await getDb().collection('deliveries').get()
  for (const d of delivSnap.docs) {
    const videos = (d.data() as { videos?: Array<{ r2Key?: string }> }).videos
    for (const v of videos || []) if (v?.r2Key) referenced.add(v.r2Key)
  }

  let orphansDeleted = 0
  let orphanBytes = 0
  let token: string | undefined
  do {
    const r = await r2.send(
      new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, ContinuationToken: token }),
    )
    for (const o of r.Contents || []) {
      const key = o.Key || ''
      const isMedia = /^([^/]+\/(videos|finals)\/|videos\/)/.test(key)
      if (!isMedia || referenced.has(key)) continue
      const t = o.LastModified ? new Date(o.LastModified).getTime() : 0
      if (t && t > cutoff) continue
      try {
        await r2.send(
          new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }),
        )
        orphansDeleted += 1
        orphanBytes += o.Size || 0
      } catch {
        /* keep sweeping */
      }
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)

  return res
    .status(200)
    .json({ ok: true, multipartsAborted, orphansDeleted, orphanBytes })
}

// ─────────────────────────────────────────────────────────────────────
// Per-user storage manager (admin Users tab)
//
// Three actions:
//   admin-users-storage      — one full-bucket scan; used bytes+count per
//                              user (keyed by the first path segment = uid)
//                              plus the pro/trial quota so the client can
//                              show "used / allocated" next to every user.
//   admin-list-user-storage  — list every object under a single user's
//                              {uid}/ prefix: name, folder, size, time.
//   admin-delete-user-object — delete one object from R2 (step-up gated)
//                              AND reconcile the referencing Firestore doc
//                              so quota + the app stay consistent.
// ─────────────────────────────────────────────────────────────────────

const STORAGE_GB_PP = 1024 * 1024 * 1024

/** Pro / trial storage allotment in bytes (admin-config override → default). */
async function getProTrialQuotaBytes(): Promise<{
  proBytes: number
  trialBytes: number
}> {
  let proGb = 100
  let trialGb = 1.5
  try {
    const [adminSnap, legacySnap] = await Promise.all([
      getDb().collection('adminConfig').doc('global').get(),
      getDb().collection('appConfig').doc('global').get(),
    ])
    const ad = (adminSnap.exists ? adminSnap.data() : {}) as {
      proStorageGb?: number
      trialStorageGb?: number
    }
    const lg = (legacySnap.exists ? legacySnap.data() : {}) as {
      proStorageGb?: number
      trialStorageGb?: number
    }
    const p = ad.proStorageGb ?? lg.proStorageGb
    const t = ad.trialStorageGb ?? lg.trialStorageGb
    if (typeof p === 'number' && p > 0) proGb = p
    if (typeof t === 'number' && t > 0) trialGb = t
  } catch {
    /* defaults */
  }
  return {
    proBytes: Math.round(proGb * STORAGE_GB_PP),
    trialBytes: Math.round(trialGb * STORAGE_GB_PP),
  }
}

/** The uid that "owns" an R2 key. Current layout is `{uid}/...`; the
 *  legacy `videos/{uid}/` and `notes/{uid}/` shapes keep the uid in the
 *  SECOND segment. Returns '' for anything unrecognizable. */
function uidFromStorageKey(key: string): string {
  const parts = (key || '').split('/')
  if (parts.length < 2) return ''
  if ((parts[0] === 'videos' || parts[0] === 'notes') && parts[1]) {
    return parts[1]
  }
  return parts[0] || ''
}

/** Strip the `{ts}-{rand}-` prefix our key builders prepend, leaving the
 *  original (sanitized) file name the user uploaded. */
function humanNameFromStorageKey(key: string): string {
  const base = (key || '').split('/').pop() || key || ''
  return base.replace(/^\d{10,}-[0-9a-f]{8,}-?/i, '') || base
}

async function handleAdminUsersStorage(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const r2 = getBackupR2()
  const usageByUid: Record<string, { usedBytes: number; count: number }> = {}
  let scanned = 0
  let token: string | undefined
  do {
    const r = await r2.send(
      new ListObjectsV2Command({
        Bucket: BACKUP_BUCKET,
        ContinuationToken: token,
      }),
    )
    for (const o of r.Contents || []) {
      const key = o.Key || ''
      const uid = uidFromStorageKey(key)
      if (!uid) continue
      // Backups + telemetry live under their own top-level prefixes and
      // aren't user media — skip them so they don't inflate a "user".
      if (uid === 'backups' || uid === 'sync-telemetry') continue
      const cur = usageByUid[uid] || { usedBytes: 0, count: 0 }
      cur.usedBytes += o.Size || 0
      cur.count += 1
      usageByUid[uid] = cur
      scanned += 1
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token && scanned < 200_000)

  const { proBytes, trialBytes } = await getProTrialQuotaBytes()
  // Beta mode grants free users the full quota; when it's OFF a free
  // (non-trial, non-Pro) account is allotted 0. The client decides each
  // user's limit from its own plan state + this flag.
  let betaMode = false
  try {
    const cfg = await getDb().collection('appConfig').doc('global').get()
    betaMode = (cfg.exists ? cfg.data() : {})?.betaMode === true
  } catch {
    /* default false */
  }
  return res
    .status(200)
    .json({ ok: true, usageByUid, proBytes, trialBytes, betaMode })
}

interface UserStorageItem {
  id: string
  kind: 'round' | 'delivery' | 'other'
  name: string
  size: number
  lastModified: number
  count: number
  folder?: string
  roundId?: string
  deliveryId?: string
  key?: string
}

async function handleAdminListUserStorage(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const uid = String((req.body as { uid?: string })?.uid || '').trim()
  if (!uid) return res.status(400).json({ ok: false, error: 'uid required' })

  // 1) Ground truth: every real object under the user's prefix.
  const r2 = getBackupR2()
  const objMap = new Map<
    string,
    { size: number; lastModified: number; folder: string }
  >()
  let token: string | undefined
  do {
    const r = await r2.send(
      new ListObjectsV2Command({
        Bucket: BACKUP_BUCKET,
        Prefix: `${uid}/`,
        ContinuationToken: token,
      }),
    )
    for (const o of r.Contents || []) {
      const key = o.Key || ''
      if (!key) continue
      objMap.set(key, {
        size: o.Size || 0,
        lastModified: o.LastModified ? new Date(o.LastModified).getTime() : 0,
        folder: key.split('/')[1] || '',
      })
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token && objMap.size < 10_000)

  const db = getDb()
  const items: UserStorageItem[] = []
  const consumed = new Set<string>()

  // 2) Revision rounds — one item per round, folding in the round's own
  //    note media (reviewer screenshots + voice recordings) so a round
  //    reads as a single file, not a scatter of loose attachments.
  try {
    const roundsSnap = await db
      .collection('revisionProjects')
      .where('ownerUid', '==', uid)
      .limit(1000)
      .get()
    for (const d of roundsSnap.docs) {
      const r = d.data() as { r2Key?: string; status?: string }
      const noteKeys: string[] = []
      try {
        const notesSnap = await d.ref.collection('notes').get()
        for (const n of notesSnap.docs) {
          const nd = n.data() as {
            screenshotR2Key?: string
            audioR2Key?: string
          }
          if (nd.screenshotR2Key) noteKeys.push(nd.screenshotR2Key)
          if (nd.audioR2Key) noteKeys.push(nd.audioR2Key)
        }
      } catch {
        /* no notes */
      }
      const videoPresent = r.r2Key && objMap.has(r.r2Key)
      const presentNotes = noteKeys.filter((k) => objMap.has(k))
      if (!videoPresent && presentNotes.length === 0) continue

      let size = 0
      let lastModified = 0
      let count = 0
      let name = ''
      if (videoPresent && r.r2Key) {
        const info = objMap.get(r.r2Key)!
        size += info.size
        lastModified = Math.max(lastModified, info.lastModified)
        count += 1
        name = humanNameFromStorageKey(r.r2Key)
        consumed.add(r.r2Key)
      }
      for (const k of presentNotes) {
        const info = objMap.get(k)!
        size += info.size
        lastModified = Math.max(lastModified, info.lastModified)
        count += 1
        consumed.add(k)
      }
      items.push({
        id: `round:${d.id}`,
        kind: 'round',
        roundId: d.id,
        name: name || 'סבב תיקונים',
        size,
        lastModified,
        count,
      })
    }
  } catch (e) {
    console.warn('[admin-list-user-storage] rounds read warn:', e)
  }

  // 3) Deliveries — one item per final video (each is a standalone file).
  try {
    const delivSnap = await db
      .collection('deliveries')
      .where('ownerUid', '==', uid)
      .get()
    for (const d of delivSnap.docs) {
      const del = d.data() as {
        videos?: Array<{ r2Key?: string; name?: string }>
        status?: string
      }
      if (del.status === 'deleted') continue
      for (const v of del.videos || []) {
        if (!v.r2Key || !objMap.has(v.r2Key) || consumed.has(v.r2Key)) continue
        const info = objMap.get(v.r2Key)!
        items.push({
          id: `key:${v.r2Key}`,
          kind: 'delivery',
          key: v.r2Key,
          deliveryId: d.id,
          name: v.name || humanNameFromStorageKey(v.r2Key),
          size: info.size,
          lastModified: info.lastModified,
          count: 1,
        })
        consumed.add(v.r2Key)
      }
    }
  } catch (e) {
    console.warn('[admin-list-user-storage] deliveries read warn:', e)
  }

  // 4) Anything left in R2 that no doc references → loose object.
  for (const [key, info] of objMap) {
    if (consumed.has(key)) continue
    items.push({
      id: `key:${key}`,
      kind: 'other',
      key,
      name: humanNameFromStorageKey(key),
      folder: info.folder,
      size: info.size,
      lastModified: info.lastModified,
      count: 1,
    })
  }

  items.sort((a, b) => b.lastModified - a.lastModified)
  const usedBytes = items.reduce((s, i) => s + i.size, 0)
  return res
    .status(200)
    .json({ ok: true, items, usedBytes, count: items.length })
}

async function handleAdminDeleteUserObject(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as {
    uid?: string
    key?: string
    roundId?: string
    deliveryId?: string
    /** true → also remove the Firestore doc so it disappears from the
     *  user's app (not just freed from storage / archived). */
    purge?: boolean
  }
  const uid = String(body.uid || '').trim()
  const key = String(body.key || '').trim()
  const roundId = String(body.roundId || '').trim()
  const deliveryId = String(body.deliveryId || '').trim()
  const purge = body.purge === true
  if (!uid || (!key && !roundId && !deliveryId)) {
    return res
      .status(400)
      .json({ ok: false, error: 'uid + (key / roundId / deliveryId) required' })
  }

  const r2 = getBackupR2()
  const db = getDb()
  const delFromR2 = async (k: string) => {
    if (!k || uidFromStorageKey(k) !== uid) return
    await r2
      .send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: k }))
      .catch((e) =>
        console.warn('[admin-delete-user-object] r2 delete warn:', k, e),
      )
  }

  // ── Whole revision round: video + all its note media. ──
  //    purge → delete the round doc (+ notes) so it's gone from the app.
  //    else  → free storage but archive the round (keeps the record).
  if (roundId) {
    const ref = db.collection('revisionProjects').doc(roundId)
    const snap = await ref.get()
    const r = (snap.exists ? snap.data() : {}) as {
      ownerUid?: string
      r2Key?: string
    }
    if (snap.exists && r.ownerUid && r.ownerUid !== uid) {
      return res
        .status(400)
        .json({ ok: false, error: 'round does not belong to user' })
    }
    if (r.r2Key) await delFromR2(r.r2Key)
    try {
      const notesSnap = await ref.collection('notes').get()
      for (const n of notesSnap.docs) {
        const nd = n.data() as { screenshotR2Key?: string; audioR2Key?: string }
        if (nd.screenshotR2Key) await delFromR2(nd.screenshotR2Key)
        if (nd.audioR2Key) await delFromR2(nd.audioR2Key)
        if (purge) await n.ref.delete().catch(() => undefined)
      }
    } catch {
      /* no notes */
    }
    if (purge) {
      await ref.delete().catch(() => undefined)
    } else {
      await ref
        .update({
          status: 'archived',
          driveDeleted: true,
          updatedAt: Date.now(),
        })
        .catch(() => undefined)
    }
    return res.status(200).json({ ok: true })
  }

  // ── Delivery. purge → delete the whole delivery doc + every video's
  //    bytes (gone from the user's app). else → drop just this one video. ──
  if (deliveryId) {
    const ref = db.collection('deliveries').doc(deliveryId)
    const snap = await ref.get()
    const del = (snap.exists ? snap.data() : {}) as {
      ownerUid?: string
      videos?: Array<{ r2Key?: string }>
    }
    if (snap.exists && del.ownerUid && del.ownerUid !== uid) {
      return res
        .status(400)
        .json({ ok: false, error: 'delivery does not belong to user' })
    }
    if (purge) {
      for (const v of del.videos || []) if (v?.r2Key) await delFromR2(v.r2Key)
      await ref.delete().catch(() => undefined)
    } else {
      if (key) await delFromR2(key)
      const next = (del.videos || []).filter((v) => v?.r2Key !== key)
      await ref
        .update({ videos: next, updatedAt: Date.now() })
        .catch(() => undefined)
    }
    return res.status(200).json({ ok: true })
  }

  // ── Loose object (no owning doc). ──
  if (uidFromStorageKey(key) !== uid) {
    return res
      .status(400)
      .json({ ok: false, error: 'key does not belong to user' })
  }
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }))
  } catch (e) {
    console.error('[admin-delete-user-object] r2 delete failed:', key, e)
    return res.status(502).json({ ok: false, error: 'storage delete failed' })
  }
  return res.status(200).json({ ok: true })
}

async function handleAdminSyncTelemetryClear(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const objs = await listSyncTelemetryObjects()
  let deleted = 0
  for (const o of objs) {
    await getBackupR2().send(
      new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: o.key }),
    )
    deleted += 1
  }
  return res.status(200).json({ ok: true, deleted })
}

/* ── Announcement popup (site + app) ───────────────────────────────
 *  Config lives in appConfig/popup. The image is EITHER uploaded to R2
 *  (stored; served via a short-lived presigned URL straight from
 *  Cloudflare, so zero Vercel egress) OR a Drive link (not stored at
 *  all — we just convert it to a direct image URL and the client loads
 *  it from Google). get-popup is public; clients apply the frequency
 *  rule locally. */
const POPUP_DOC = 'popup'
function driveDirectImageUrl(url: string): string {
  const u = String(url || '').trim()
  if (!u) return ''
  const m =
    u.match(/\/d\/([a-zA-Z0-9_-]{10,})/) ||
    u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1600`
  return u // assume already a direct image URL
}
async function popupImageUrl(cfg: {
  imageSource?: string
  imageKey?: string
  driveUrl?: string
}): Promise<string> {
  try {
    if (cfg.imageSource === 'drive' && cfg.driveUrl) {
      return driveDirectImageUrl(cfg.driveUrl)
    }
    if (cfg.imageSource === 'r2' && cfg.imageKey) {
      return await getSignedUrl(
        getBackupR2(),
        new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: cfg.imageKey }),
        { expiresIn: 3600 },
      )
    }
  } catch {
    /* ignore */
  }
  return ''
}

/** Public: the active popup config for the website + desktop. */
async function handleGetPopup(req: VercelRequest, res: VercelResponse) {
  try {
    const snap = await getDb().collection('appConfig').doc(POPUP_DOC).get()
    const d = (snap.exists ? snap.data() : {}) as Record<string, unknown>
    const imageSource = String(d.imageSource || 'none')
    let title = String(d.title || '')
    let driveUrl = String(d.driveUrl || '')
    // Forgive a Drive image link pasted into the TITLE field: if the
    // Drive source is selected, the URL field is empty, and the title is
    // clearly a Drive link, treat the title AS the image and drop it from
    // the title so the popup shows the picture, not the raw URL text.
    const looksLikeDrive = /drive\.google\.com|\/d\/[a-zA-Z0-9_-]{10,}|[?&]id=[a-zA-Z0-9_-]{10,}/.test(
      title,
    )
    if (imageSource === 'drive' && !driveUrl && looksLikeDrive) {
      driveUrl = title
      title = ''
    }
    const imageUrl = await popupImageUrl({
      imageSource,
      imageKey: String(d.imageKey || ''),
      driveUrl,
    })
    const freq = String(d.frequency || 'daily')
    const target = String(d.target || 'both')
    const size = String(d.size || 'medium')
    return res.status(200).json({
      ok: true,
      popup: {
        enabled: d.enabled === true,
        id: String(d.id || ''),
        title,
        body: String(d.body || ''),
        imageUrl,
        imageSource,
        driveUrl,
        hasImage: Boolean(imageUrl),
        frequency: ['always', 'daily', 'once'].includes(freq) ? freq : 'daily',
        target: ['web', 'desktop', 'both'].includes(target) ? target : 'both',
        size: ['small', 'medium', 'large'].includes(size) ? size : 'medium',
        linkUrl: String(d.linkUrl || ''),
      },
    })
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: (e as Error)?.message || 'failed' })
  }
}

/** Admin (2FA): upload a popup image to R2, return its key. */
async function handleAdminUploadPopupImage(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const content = (req.body as { content?: string })?.content
  if (typeof content !== 'string' || !content) {
    return res.status(400).json({ ok: false, error: 'קובץ ריק' })
  }
  const m = content.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/)
  const b64 = m ? m[2] : content
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return res.status(400).json({ ok: false, error: 'קובץ לא תקין' })
  }
  if (buf.length === 0) {
    return res.status(400).json({ ok: false, error: 'קובץ ריק' })
  }
  if (buf.length > 4 * 1024 * 1024) {
    return res
      .status(400)
      .json({ ok: false, error: 'התמונה גדולה מדי — מקסימום 4MB' })
  }
  const contentType = m ? m[1] : 'image/png'
  const ext = (contentType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
  const key = `popup/${Date.now()}.${ext}`
  await getBackupR2().send(
    new PutObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType,
    }),
  )
  return res.status(200).json({ ok: true, imageKey: key })
}

/** Admin (step-up): save the popup config. Bumps id so clients re-show. */
async function handleAdminSetPopup(req: VercelRequest, res: VercelResponse) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const b = (req.body || {}) as {
    enabled?: boolean
    title?: string
    body?: string
    imageSource?: string
    imageKey?: string
    driveUrl?: string
    frequency?: string
    target?: string
    size?: string
    linkUrl?: string
  }
  const patch = {
    enabled: b.enabled === true,
    title: String(b.title || '').slice(0, 300),
    body: String(b.body || '').slice(0, 3000),
    imageSource: ['none', 'r2', 'drive'].includes(String(b.imageSource))
      ? b.imageSource
      : 'none',
    imageKey: String(b.imageKey || '').slice(0, 200),
    driveUrl: String(b.driveUrl || '').slice(0, 1000),
    frequency: ['always', 'daily', 'once'].includes(String(b.frequency))
      ? b.frequency
      : 'daily',
    target: ['web', 'desktop', 'both'].includes(String(b.target))
      ? b.target
      : 'both',
    size: ['small', 'medium', 'large'].includes(String(b.size))
      ? b.size
      : 'medium',
    linkUrl: String(b.linkUrl || '').slice(0, 1000),
    id: `${Date.now()}`,
    updatedAt: new Date().toISOString(),
  }
  await getDb().collection('appConfig').doc(POPUP_DOC).set(patch, { merge: true })
  return res.status(200).json({ ok: true, id: patch.id })
}

interface LegalSection {
  title: string
  paragraphs: string[]
}
function cleanSections(input: unknown): LegalSection[] {
  if (!Array.isArray(input)) return []
  return input
    .map((s) => {
      const sec = (s || {}) as { title?: unknown; paragraphs?: unknown }
      return {
        title: String(sec.title || '').slice(0, 300),
        paragraphs: Array.isArray(sec.paragraphs)
          ? sec.paragraphs.map((p) => String(p || '').slice(0, 5000))
          : [],
      }
    })
    .filter((s) => s.title || s.paragraphs.length)
}

async function handleAdminSetTerms(req: VercelRequest, res: VercelResponse) {
  return setLegalDoc(req, res, 'terms')
}
async function handleAdminSetPrivacy(req: VercelRequest, res: VercelResponse) {
  return setLegalDoc(req, res, 'privacy')
}
async function handleAdminSetAccessibility(
  req: VercelRequest,
  res: VercelResponse,
) {
  return setLegalDoc(req, res, 'accessibility')
}
async function handleAdminSetPartnerTerms(
  req: VercelRequest,
  res: VercelResponse,
) {
  return setLegalDoc(req, res, 'partnerTerms')
}
async function setLegalDoc(
  req: VercelRequest,
  res: VercelResponse,
  doc: 'terms' | 'privacy' | 'accessibility' | 'partnerTerms',
) {
  // Publishing legal docs bumps the version → forces EVERY user to
  // re-accept on next login. Step-up required.
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as {
    version?: number
    sections?: unknown
    lastUpdated?: unknown
  }
  const sections = cleanSections(body.sections)
  if (!sections.length) {
    return res.status(400).json({ ok: false, error: 'אין תוכן' })
  }
  const version = Math.max(0, Math.floor(Number(body.version) || 0))
  const payload: Record<string, unknown> = {
    version,
    sections,
    // machine timestamp for our own auditing
    updatedAt: new Date().toISOString(),
  }
  // `lastUpdated` is the HUMAN-READABLE date shown to end users in the
  // legal modal (e.g. "20 במאי 2026"). Persist it verbatim when the
  // admin provided one — never clobber it with a raw ISO string.
  if (typeof body.lastUpdated === 'string' && body.lastUpdated.trim()) {
    payload.lastUpdated = body.lastUpdated.trim()
  }
  await getDb().collection('appConfig').doc(doc).set(payload, { merge: true })
  return res.status(200).json({ ok: true })
}

/* ── Contact form (public) ───────────────────────────────────────
 *  A website visitor submits name + email + message. Stored in the
 *  SAME `feedback` collection the desktop bug/feature reports use, with
 *  kind:'contact' + source:'website', so it surfaces in the admin
 *  "פניות" tab alongside everything else. Light per-instance IP throttle
 *  + strict validation keeps spam down without blocking real people. */
const contactMisses = new Map<string, { n: number; at: number }>()
function contactThrottled(ip: string): boolean {
  const m = contactMisses.get(ip)
  if (!m) return false
  if (Date.now() - m.at > 60 * 60_000) {
    contactMisses.delete(ip)
    return false
  }
  return m.n >= 8
}
function contactRegister(ip: string): void {
  const m = contactMisses.get(ip)
  if (m && Date.now() - m.at <= 60 * 60_000) m.n += 1
  else contactMisses.set(ip, { n: 1, at: Date.now() })
}

async function handleSubmitContact(req: VercelRequest, res: VercelResponse) {
  const b = (req.body || {}) as {
    name?: string
    email?: string
    message?: string
    subject?: string
    hp?: string // honeypot — real users leave it empty
  }
  // Bots love to fill hidden fields. Pretend success, save nothing.
  if (b.hp && String(b.hp).trim()) {
    return res.status(200).json({ ok: true })
  }
  const ip = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  if (contactThrottled(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: 'יותר מדי פניות — נסו שוב מאוחר יותר' })
  }
  const name = String(b.name || '').trim().slice(0, 120)
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200)
  const subject = String(b.subject || '').trim().slice(0, 200)
  const message = String(b.message || '').trim().slice(0, 5000)
  if (!name || name.length < 2) {
    return res.status(400).json({ ok: false, error: 'נא למלא שם' })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }
  if (!message || message.length < 5) {
    return res.status(400).json({ ok: false, error: 'נא לכתוב את הפנייה' })
  }
  contactRegister(ip)
  try {
    const ref = await getDb()
      .collection('feedback')
      .add({
        kind: 'contact',
        source: 'website',
        subject: subject || null,
        message,
        userName: name,
        userEmail: email,
        resolved: false,
        createdAt: new Date().toISOString(),
      })
    // Ping the operator so a website inquiry isn't missed.
    await sendTelegramAlert(
      `📨 פנייה חדשה מהאתר\nמאת: ${name} (${email})\n${subject ? subject + '\n' : ''}${message.slice(0, 300)}`,
    ).catch(() => {})
    return res.status(200).json({ ok: true, id: ref.id })
  } catch (err) {
    console.error('[submit-contact] save failed:', err)
    return res.status(500).json({ ok: false, error: 'שמירת הפנייה נכשלה' })
  }
}

/* Admin replies to an inquiry → emails the customer from the system
 *  address, appends the reply to the doc, and marks it handled. */
async function handleAdminReplyFeedback(
  req: VercelRequest,
  res: VercelResponse,
) {
  const adminEmail = await verifyAdminStepUp(req)
  if (!adminEmail) return res.status(403).json({ ok: false, error: 'forbidden' })
  const b = (req.body || {}) as { id?: string; reply?: string }
  const id = String(b.id || '').trim()
  const reply = String(b.reply || '').trim().slice(0, 8000)
  if (!id) return res.status(400).json({ ok: false, error: 'id' })
  if (reply.length < 2) return res.status(400).json({ ok: false, error: 'התשובה ריקה' })
  const ref = getDb().collection('feedback').doc(id)
  const snap = await ref.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'הפנייה לא נמצאה' })
  const fb = snap.data() as {
    userEmail?: string
    userName?: string
    subject?: string
    message?: string
  }
  const to = String(fb.userEmail || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res
      .status(400)
      .json({ ok: false, error: 'לפנייה אין כתובת מייל תקינה להשיב אליה' })
  }
  try {
    await sendContactReplyEmail({
      to,
      name: fb.userName || '',
      originalSubject: fb.subject || '',
      originalMessage: fb.message || '',
      reply,
    })
  } catch (err) {
    console.error('[admin-reply-feedback] email failed:', err)
    return res.status(502).json({ ok: false, error: 'שליחת המייל נכשלה' })
  }
  const entry = { reply, at: new Date().toISOString(), by: adminEmail }
  await ref.set(
    {
      resolved: true,
      replies: FieldValue.arrayUnion(entry),
      lastRepliedAt: entry.at,
    },
    { merge: true },
  )
  return res.status(200).json({ ok: true })
}

async function sendContactReplyEmail(args: {
  to: string
  name: string
  originalSubject: string
  originalMessage: string
  reply: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const replyHtml = esc(args.reply).replace(/\n/g, '<br>')
  const origHtml = esc(args.originalMessage).replace(/\n/g, '<br>')
  const html = renderEmail({
    heading: 'תשובה לפנייה שלך',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        ${args.name ? esc(args.name) + ', ' : ''}תודה שפנית אלינו. הנה התשובה שלנו:
      </p>
      <div style="background:#16110D;border-right:3px solid #D4A574;border-radius:8px;padding:16px 18px;margin:0 0 24px;font-size:14px;line-height:1.8;color:#F5EFE6;">
        ${replyHtml}
      </div>
      ${
        args.originalMessage
          ? `<div style="font-size:12px;color:#8B8170;border-top:1px solid rgba(139,129,112,0.25);padding-top:14px;">
               <div style="margin-bottom:6px;">הפנייה המקורית שלך${args.originalSubject ? ' — ' + esc(args.originalSubject) : ''}:</div>
               <div style="color:#9A8F7A;line-height:1.7;">${origHtml}</div>
             </div>`
          : ''
      }
      <p style="margin:24px 0 0;font-size:12px;color:#8B8170;">
        אפשר להשיב ישירות למייל הזה אם יש עוד שאלה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    replyTo: user,
    subject: `תשובה לפנייתך — ניהול הורדות פלוס${args.originalSubject ? ' · ' + args.originalSubject : ''}`,
    html,
  })
}

async function handleAdminListFeedback(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdmin2FA(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const snap = await getDb()
    .collection('feedback')
    .orderBy('createdAt', 'desc')
    .limit(1000)
    .get()
  const items = snap.docs.map((d) => ({
    ...(d.data() as Record<string, unknown>),
    id: d.id,
  }))
  return res.status(200).json({ ok: true, items })
}

async function handleAdminSetFeedbackResolved(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { id?: string; resolved?: boolean }
  const id = String(body.id || '').trim()
  if (!id) return res.status(400).json({ ok: false, error: 'id' })
  await getDb()
    .collection('feedback')
    .doc(id)
    .update({ resolved: body.resolved === true })
  return res.status(200).json({ ok: true })
}

async function handleAdminDeleteFeedback(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const body = (req.body || {}) as { id?: string }
  const id = String(body.id || '').trim()
  if (!id) return res.status(400).json({ ok: false, error: 'id' })
  await getDb().collection('feedback').doc(id).delete()
  return res.status(200).json({ ok: true })
}

async function handleAdmin2faRequest(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string; gateKey?: string }
  if (!(await isAdminGateOpen(body.gateKey))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })

  // No rate limit here: this is the single, already-authenticated
  // operator (admin password + secret gate key). Locking them out of
  // their own login over a request cap is unacceptable; the email
  // code's TTL + single-use is the abuse control. A 60s resend timer
  // in the UI keeps casual re-sends sane.

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
  const transporter = makeCountedTransport({
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
  const body = (req.body || {}) as {
    idToken?: string
    code?: string
    gateKey?: string
  }
  if (!(await isAdminGateOpen(body.gateKey))) {
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

/* ──────────────────────────────────────────────────────────────
 *  Passkeys (WebAuthn) — biometric second factor for the admin.
 *
 *  Replaces the email code on every login: register a passkey once
 *  per device (Touch ID on Mac, Face ID on iPhone, Windows Hello),
 *  then unlock with a fingerprint/face instead of typing a mailed
 *  code. A successful assertion mints the SAME 12h adminToken the
 *  email code does, so every downstream gate (verifyAdmin2FA) is
 *  unchanged. The email code stays as a fallback for registering a
 *  new device / recovery.
 *
 *  Storage:
 *    adminCredentials/{credId}      { email, publicKey(b64url),
 *                                     counter, transports[], deviceName, createdAt }
 *    adminWebauthnChallenges/{emailKey} { challenge, kind, exp }  (temp)
 * ────────────────────────────────────────────────────────────── */

const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'dmplus.net'
const WEBAUTHN_RP_NAME = 'ניהול הורדות פלוס'
const WEBAUTHN_ORIGINS = [
  'https://dmplus.net',
  'https://www.dmplus.net',
]

interface AdminCredentialDoc {
  email: string
  publicKey: string // base64url
  counter: number
  transports?: string[]
  deviceName?: string
  createdAt: number
}

async function listAdminCredentials(
  email: string,
): Promise<Array<{ id: string } & AdminCredentialDoc>> {
  const snap = await getDb()
    .collection('adminCredentials')
    .where('email', '==', email.toLowerCase())
    .get()
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as AdminCredentialDoc) }))
}

async function saveWebauthnChallenge(
  email: string,
  challenge: string,
  kind: 'reg' | 'auth' | 'stepup',
) {
  await getDb()
    .collection('adminWebauthnChallenges')
    .doc(sanitizeEmailKey(email))
    .set({ challenge, kind, exp: Date.now() + 5 * 60 * 1000 })
}

async function takeWebauthnChallenge(
  email: string,
  kind: 'reg' | 'auth' | 'stepup',
): Promise<string | null> {
  const ref = getDb()
    .collection('adminWebauthnChallenges')
    .doc(sanitizeEmailKey(email))
  const snap = await ref.get()
  if (!snap.exists) return null
  const d = snap.data() as { challenge?: string; kind?: string; exp?: number }
  await ref.delete().catch(() => undefined)
  if (d.kind !== kind) return null
  if (!d.exp || d.exp < Date.now()) return null
  return d.challenge || null
}

/** Registration step 1 — options.
 *
 *  Bootstrap (FIRST passkey, when none exist): gated by full 2FA only —
 *  otherwise you could never enroll the first one.
 *
 *  Adding an ADDITIONAL passkey (≥1 already exists): ALSO requires a
 *  fresh step-up token. This closes the hole where a stolen 12h
 *  adminToken could enroll an attacker's own device and thereby mint
 *  step-up tokens — i.e. adding a credential is itself treated as a
 *  sensitive mutation once the account is past bootstrap. */
async function handleAdminPasskeyRegOptions(
  req: VercelRequest,
  res: VercelResponse,
) {
  const email = await verifyAdmin2FA(req)
  if (!email) return res.status(403).json({ ok: false, error: 'forbidden' })
  const existing = await listAdminCredentials(email)
  if (existing.length > 0 && !hasFreshStepUp(req, email)) {
    return res.status(403).json({
      ok: false,
      error: 'נדרש אימות ביומטרי כדי להוסיף Passkey נוסף',
      code: 'stepup-required',
    })
  }
  const options = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID: WEBAUTHN_RP_ID,
    userID: new TextEncoder().encode(email),
    userName: email,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })
  await saveWebauthnChallenge(email, options.challenge, 'reg')
  return res.status(200).json({ ok: true, options })
}

/** Registration step 2 — verify + store the new credential. Same
 *  bootstrap-vs-additional step-up rule as step 1 (re-checked here so
 *  the actual write is never reachable with a bare adminToken). */
async function handleAdminPasskeyRegVerify(
  req: VercelRequest,
  res: VercelResponse,
) {
  const email = await verifyAdmin2FA(req)
  if (!email) return res.status(403).json({ ok: false, error: 'forbidden' })
  const existing = await listAdminCredentials(email)
  if (existing.length > 0 && !hasFreshStepUp(req, email)) {
    return res.status(403).json({
      ok: false,
      error: 'נדרש אימות ביומטרי כדי להוסיף Passkey נוסף',
      code: 'stepup-required',
    })
  }
  const body = (req.body || {}) as { response?: unknown; deviceName?: string }
  const expectedChallenge = await takeWebauthnChallenge(email, 'reg')
  if (!expectedChallenge) {
    return res.status(400).json({ ok: false, error: 'אין אתגר תקף' })
  }
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as never,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
    })
  } catch (err) {
    return res
      .status(400)
      .json({ ok: false, error: (err as Error).message || 'אימות נכשל' })
  }
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ ok: false, error: 'רישום נכשל' })
  }
  const cred = verification.registrationInfo.credential
  const doc: AdminCredentialDoc = {
    email: email.toLowerCase(),
    publicKey: Buffer.from(cred.publicKey).toString('base64url'),
    counter: cred.counter,
    transports: cred.transports || [],
    deviceName: (body.deviceName || '').toString().slice(0, 60) || 'מכשיר',
    createdAt: Date.now(),
  }
  await getDb().collection('adminCredentials').doc(cred.id).set(doc)
  return res.status(200).json({ ok: true })
}

/** Login step 1 — options. Gated only by gate-key + Firebase admin
 *  password (NO adminToken — that's what we're trying to obtain). */
async function handleAdminPasskeyAuthOptions(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string; gateKey?: string }
  if (!(await isAdminGateOpen(body.gateKey))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })
  const creds = await listAdminCredentials(email)
  if (creds.length === 0) {
    return res.status(200).json({ ok: true, hasPasskeys: false })
  }
  const options = await generateAuthenticationOptions({
    rpID: WEBAUTHN_RP_ID,
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: c.transports as never,
    })),
    userVerification: 'preferred',
  })
  await saveWebauthnChallenge(email, options.challenge, 'auth')
  return res.status(200).json({ ok: true, hasPasskeys: true, options })
}

/** Login step 2 — verify assertion → mint the 12h admin token. */
async function handleAdminPasskeyAuthVerify(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    idToken?: string
    gateKey?: string
    response?: { id?: string }
  }
  if (!(await isAdminGateOpen(body.gateKey))) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const email = await verifyAdminEmail(body.idToken || '')
  if (!email) return res.status(403).json({ ok: false, error: 'admin only' })
  const credId = body.response?.id || ''
  if (!credId) return res.status(400).json({ ok: false, error: 'חסר מזהה' })
  const ref = getDb().collection('adminCredentials').doc(credId)
  const snap = await ref.get()
  if (!snap.exists) {
    return res.status(400).json({ ok: false, error: 'מפתח לא מוכר' })
  }
  const credDoc = snap.data() as AdminCredentialDoc
  if (credDoc.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const expectedChallenge = await takeWebauthnChallenge(email, 'auth')
  if (!expectedChallenge) {
    return res.status(400).json({ ok: false, error: 'אין אתגר תקף' })
  }
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as never,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: credId,
        publicKey: new Uint8Array(Buffer.from(credDoc.publicKey, 'base64url')),
        counter: credDoc.counter,
        transports: credDoc.transports as never,
      },
    })
  } catch (err) {
    return res
      .status(400)
      .json({ ok: false, error: (err as Error).message || 'אימות נכשל' })
  }
  if (!verification.verified) {
    return res.status(400).json({ ok: false, error: 'האימות נכשל' })
  }
  await ref
    .update({ counter: verification.authenticationInfo.newCounter })
    .catch(() => undefined)
  return res.status(200).json({ ok: true, adminToken: signAdminToken(email) })
}

/** List the admin's registered passkeys (for the management UI). */
async function handleAdminPasskeyList(req: VercelRequest, res: VercelResponse) {
  const email = await verifyAdmin2FA(req)
  if (!email) return res.status(403).json({ ok: false, error: 'forbidden' })
  const creds = await listAdminCredentials(email)
  return res.status(200).json({
    ok: true,
    passkeys: creds.map((c) => ({
      id: c.id,
      deviceName: c.deviceName || 'מכשיר',
      createdAt: c.createdAt,
    })),
  })
}

/** Remove a registered passkey (only if it belongs to the caller). */
async function handleAdminPasskeyDelete(
  req: VercelRequest,
  res: VercelResponse,
) {
  const email = await verifyAdminStepUp(req)
  if (!email) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as { id?: string }
  const id = (body.id || '').trim()
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' })
  const ref = getDb().collection('adminCredentials').doc(id)
  const snap = await ref.get()
  if (snap.exists) {
    const d = snap.data() as AdminCredentialDoc
    if (d.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'forbidden' })
    }
    await ref.delete().catch(() => undefined)
  }
  return res.status(200).json({ ok: true })
}

/* ── Step-up (per-action re-verification) endpoints ──────────────
 *  Both require the full 2FA gate first (you must already be logged
 *  in). They drive a FRESH passkey assertion whose only product is a
 *  2-minute step-up token, which the mutation endpoints then demand.
 */

/** Step-up step 1 — issue a fresh authentication challenge for the
 *  admin's registered passkeys. Returns {hasPasskeys:false} if none
 *  are registered (the client then tells the operator to add one). */
async function handleAdminStepUpOptions(
  req: VercelRequest,
  res: VercelResponse,
) {
  const email = await verifyAdmin2FA(req)
  if (!email) return res.status(403).json({ ok: false, error: 'forbidden' })
  const creds = await listAdminCredentials(email)
  if (creds.length === 0) {
    return res.status(200).json({ ok: true, hasPasskeys: false })
  }
  const options = await generateAuthenticationOptions({
    rpID: WEBAUTHN_RP_ID,
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: c.transports as never,
    })),
    // Require user verification (biometric / PIN), not just presence —
    // this is the whole point of step-up.
    userVerification: 'required',
  })
  await saveWebauthnChallenge(email, options.challenge, 'stepup')
  return res.status(200).json({ ok: true, hasPasskeys: true, options })
}

/** Step-up step 2 — verify the assertion → mint a 2-min step-up
 *  token. The token is what unlocks mutations for the next 2 min. */
async function handleAdminStepUpVerify(
  req: VercelRequest,
  res: VercelResponse,
) {
  const email = await verifyAdmin2FA(req)
  if (!email) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as { response?: { id?: string } }
  const credId = body.response?.id || ''
  if (!credId) return res.status(400).json({ ok: false, error: 'חסר מזהה' })
  const ref = getDb().collection('adminCredentials').doc(credId)
  const snap = await ref.get()
  if (!snap.exists) {
    return res.status(400).json({ ok: false, error: 'מפתח לא מוכר' })
  }
  const credDoc = snap.data() as AdminCredentialDoc
  if (credDoc.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const expectedChallenge = await takeWebauthnChallenge(email, 'stepup')
  if (!expectedChallenge) {
    return res.status(400).json({ ok: false, error: 'אין אתגר תקף' })
  }
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as never,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      // Enforce that the authenticator actually verified the user.
      requireUserVerification: true,
      credential: {
        id: credId,
        publicKey: new Uint8Array(Buffer.from(credDoc.publicKey, 'base64url')),
        counter: credDoc.counter,
        transports: credDoc.transports as never,
      },
    })
  } catch (err) {
    return res
      .status(400)
      .json({ ok: false, error: (err as Error).message || 'אימות נכשל' })
  }
  if (!verification.verified) {
    return res.status(400).json({ ok: false, error: 'האימות נכשל' })
  }
  await ref
    .update({ counter: verification.authenticationInfo.newCounter })
    .catch(() => undefined)
  return res.status(200).json({
    ok: true,
    stepUpToken: signStepUpToken(email),
    expiresInSeconds: ADMIN_STEPUP_TTL_SECONDS,
  })
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
  }
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const name = (body.name || '').trim().slice(0, 80)
  if (!name) return res.status(400).json({ ok: false, error: 'יש להזין שם' })
  const loginEmail = (body.loginEmail || '').trim().toLowerCase()
  if (loginEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל כניסה לא תקין' })
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
  // When a login email is given, AUTO-GENERATE a temporary password and
  // email it — the admin never types one. The partner is forced to
  // replace it + accept the terms on first login.
  let tempPassword = ''
  if (loginEmail) {
    tempPassword = generatePartnerTempPassword()
    doc.loginEmail = loginEmail
    doc.passwordHash = hashPartnerPassword(tempPassword)
    doc.mustChangePassword = true
    doc.termsAcceptedAt = null
    doc.credEpoch = Date.now()
  }
  const commission = parseCommission(
    req.body as { commissionType?: unknown; commissionValue?: unknown; commissionCurrency?: unknown },
  )
  const createFirstOnly =
    (req.body as { commissionFirstOnly?: unknown }).commissionFirstOnly === true
  if (commission) {
    doc.commissionType = commission.commissionType
    doc.commissionValue = commission.commissionValue
    doc.commissionCurrency = commission.commissionCurrency
    doc.commissionFirstOnly = createFirstOnly
  }
  await db.collection('referralPartners').doc(code).set(doc)

  // Welcome email with the generated temp password + dashboard link.
  let emailSent = false
  if (loginEmail) {
    const commissionLabel = commission
      ? commissionLabelHe(
          commission.commissionType,
          commission.commissionValue,
          commission.commissionCurrency,
          createFirstOnly,
        )
      : 'ההסכם ייקבע בהמשך'
    try {
      await sendPartnerWelcomeEmail({
        to: loginEmail,
        name,
        code,
        password: tempPassword,
        commissionLabel,
      })
      emailSent = true
    } catch (e) {
      console.warn('[partner] welcome email failed (ignored):', e)
    }
  }
  return res.status(200).json({
    ok: true,
    code,
    name,
    link: `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(code)}`,
    // Returned once so the admin can copy it if the email fails. The
    // hash is what's stored; this plaintext is not persisted.
    tempPassword: tempPassword || undefined,
    emailSent,
  })
}

async function handleAdminListReferrals(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string }
  const admin = await verifyAdmin2FA(req)
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

/** Admin → receipts log. Returns the most recent SUMIT receipts that
 *  were issued for payments (newest first). Best-effort: an empty or
 *  missing collection simply returns []. */
async function handleAdminListReceipts(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string }
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  try {
    const snap = await getDb()
      .collection('receipts')
      .orderBy('at', 'desc')
      .limit(100)
      .get()
    const receipts = snap.docs.map((d) => {
      const data = d.data() as {
        at?: string
        email?: string
        amount?: number
        currency?: string
        description?: string
        documentNumber?: string | number | null
        url?: string
        draft?: boolean
        subscriptionId?: string | null
        test?: boolean
      }
      return {
        at: data.at || '',
        email: data.email || '',
        amount: typeof data.amount === 'number' ? data.amount : null,
        currency: data.currency || 'ILS',
        description: data.description || '',
        documentNumber: data.documentNumber ?? null,
        url: data.url || '',
        draft: Boolean(data.draft),
        subscriptionId: data.subscriptionId || null,
        test: Boolean(data.test),
      }
    })
    return res.status(200).json({ ok: true, receipts })
  } catch (err) {
    console.warn('[sumit] list receipts failed:', err)
    return res.status(200).json({ ok: true, receipts: [] })
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Receipts settings + casual-transaction (עסקת אקראי) report.
 *
 *  receiptsEnabled is the master switch for the SUMIT pipeline. When
 *  OFF (default) the operator runs on the "עסקת אקראי" model: nothing
 *  is sent to SUMIT, and the monthly report below gives the numbers to
 *  report to מע"מ by hand. The report is built from each key's
 *  billingHistory — the canonical charge log, written on every charge
 *  regardless of SUMIT — so it's complete even when SUMIT is off.
 * ────────────────────────────────────────────────────────────── */

/** Reporter ("עוסק") identity for the עסקת-אקראי report (form 8356).
 *  These are the exact fields the form asks for about the seller/
 *  service-provider. Stored in the admin-only adminConfig/global —
 *  NOT appConfig (which clients can read) — because the ID number and
 *  home address are personal data that must never leak to the app. */
interface CasualBusiness {
  firstName?: string
  lastName?: string
  idNumber?: string
  city?: string
  street?: string
  houseNumber?: string
  zip?: string
  phone?: string
  /** One-time signature as a PNG data URL, stamped onto every PDF. */
  signature?: string
}

/** Read the reporter identity from adminConfig/global.casualBusiness. */
async function readCasualBusiness(): Promise<CasualBusiness> {
  const snap = await getDb().collection('adminConfig').doc('global').get()
  const d = (snap.exists ? snap.data() : {}) as {
    casualBusiness?: CasualBusiness
  }
  return d.casualBusiness && typeof d.casualBusiness === 'object'
    ? d.casualBusiness
    : {}
}

async function handleAdminGetReceiptsSettings(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const snap = await getDb().collection('appConfig').doc('global').get()
  const d = (snap.exists ? snap.data() : {}) as {
    receiptsEnabled?: boolean
    vatRate?: number
    vatAuto?: boolean
  }
  const vatAuto = d.vatAuto !== false
  return res.status(200).json({
    ok: true,
    receiptsEnabled: d.receiptsEnabled === true,
    vatAuto,
    // The effective rate the system will actually use right now.
    vatRate: vatAuto
      ? CURRENT_IL_VAT_PERCENT
      : typeof d.vatRate === 'number' && d.vatRate > 0 && d.vatRate < 100
        ? d.vatRate
        : CURRENT_IL_VAT_PERCENT,
    currentIlVat: CURRENT_IL_VAT_PERCENT,
    sumitConfigured: sumitConfigured(),
    // Reporter identity for the 8356 PDF (admin-only data).
    business: await readCasualBusiness(),
  })
}

async function handleAdminSetReceiptsSettings(
  req: VercelRequest,
  res: VercelResponse,
) {
  // Sensitive: this controls whether customer data flows to a third
  // party (SUMIT), so require step-up just like the other money/config
  // toggles.
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as {
    receiptsEnabled?: boolean
    vatRate?: number
    vatAuto?: boolean
    business?: Record<string, unknown>
  }
  const patch: Record<string, unknown> = {}
  if (typeof body.receiptsEnabled === 'boolean')
    patch.receiptsEnabled = body.receiptsEnabled
  if (typeof body.vatAuto === 'boolean') patch.vatAuto = body.vatAuto
  if (
    typeof body.vatRate === 'number' &&
    body.vatRate > 0 &&
    body.vatRate < 100
  )
    patch.vatRate = Math.round(body.vatRate * 100) / 100

  // Reporter identity → admin-only adminConfig/global.casualBusiness.
  // Kept out of appConfig so the ID number + home address never reach
  // any client. Each field is trimmed and length-capped defensively.
  let businessPatched = false
  if (body.business && typeof body.business === 'object') {
    const b = body.business
    const str = (v: unknown, max = 120) =>
      typeof v === 'string' ? v.trim().slice(0, max) : ''
    const business: CasualBusiness = {
      firstName: str(b.firstName, 60),
      lastName: str(b.lastName, 60),
      idNumber: str(b.idNumber, 20),
      city: str(b.city, 60),
      street: str(b.street, 80),
      houseNumber: str(b.houseNumber, 12),
      zip: str(b.zip, 12),
      phone: str(b.phone, 25),
      // Signature is a PNG data URL — allow it to be long, but only if
      // it's an image data URL, and cap at ~400KB so the doc stays well
      // under Firestore's 1MB limit.
      signature:
        typeof b.signature === 'string' &&
        b.signature.startsWith('data:image/') &&
        b.signature.length <= 400_000
          ? b.signature
          : '',
    }
    await getDb()
      .collection('adminConfig')
      .doc('global')
      .set({ casualBusiness: business }, { merge: true })
    businessPatched = true
  }

  if (Object.keys(patch).length === 0 && !businessPatched)
    return res.status(400).json({ ok: false, error: 'nothing to update' })
  if (Object.keys(patch).length > 0)
    await getDb()
      .collection('appConfig')
      .doc('global')
      .set(patch, { merge: true })
  return res.status(200).json({ ok: true, ...patch })
}

async function handleAdminCasualReport(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const body = (req.body || {}) as { year?: number; month?: number }
  const now = new Date()
  const year = Number.isInteger(body.year) ? (body.year as number) : now.getUTCFullYear()
  // month is 1-12 from the client; default to the current month.
  const month = Number.isInteger(body.month)
    ? Math.min(12, Math.max(1, body.month as number))
    : now.getUTCMonth() + 1
  // Calendar-month window. We use UTC boundaries for a stable cut; for
  // a draft the operator reviews before filing this is plenty precise.
  const start = Date.UTC(year, month - 1, 1)
  const end = Date.UTC(year, month, 1)
  const vatPercent = await casualVatRatePercent()
  const frac = vatPercent / 100
  const round2 = (n: number) => Math.round(n * 100) / 100
  const db = getDb()

  type Raw = {
    eventId: string
    at: string
    email: string
    name: string
    currency: string
    gross: number
    reported: boolean
  }
  // De-dupe by eventId: a charge can appear both in the durable ledger
  // AND in a live key's billingHistory (same id). The ledger wins
  // because it also carries the customer name and survives key
  // deletion.
  const byId = new Map<string, Raw>()

  // 1) Durable ledger — the source of truth. A single-field range
  //    query needs no composite index.
  const ledgerSnap = await db
    .collection('casualLedger')
    .where('at', '>=', new Date(start).toISOString())
    .where('at', '<', new Date(end).toISOString())
    .get()
  for (const doc of ledgerSnap.docs) {
    const d = doc.data() as {
      eventId?: string
      at?: string
      email?: string
      name?: string
      amount?: number
      currency?: string
      reported?: boolean
    }
    const gross = typeof d.amount === 'number' ? d.amount : 0
    if (gross <= 0 || !d.at) continue
    const id = d.eventId || doc.id
    byId.set(id, {
      eventId: id,
      at: d.at,
      email: (d.email || '').trim(),
      name: (d.name || '').trim(),
      currency: (d.currency || 'ILS').toUpperCase(),
      gross,
      reported: d.reported === true,
    })
  }

  // 2) Merge any charges still only in a live key's billingHistory
  //    (e.g. pre-ledger history). Scan is admin-only + monthly, so a
  //    full read is fine at this scale.
  const keysSnap = await db.collection('productKeys').get()
  for (const doc of keysSnap.docs) {
    const d = doc.data() as {
      buyerEmail?: string
      redeemedByEmail?: string
      buyerName?: string
      billingHistory?: Array<{
        at?: string
        amount?: number
        currency?: string
        eventId?: string
      }>
    }
    const email = (d.buyerEmail || d.redeemedByEmail || '').trim()
    const name = (d.buyerName || '').trim()
    const hist = Array.isArray(d.billingHistory) ? d.billingHistory : []
    for (const h of hist) {
      const t = h.at ? new Date(h.at).getTime() : NaN
      if (!Number.isFinite(t) || t < start || t >= end) continue
      const gross = typeof h.amount === 'number' ? h.amount : 0
      if (gross <= 0) continue
      // Fall back to a natural key when an old entry has no eventId.
      const id = h.eventId || `${doc.id}:${h.at}:${gross}`
      if (byId.has(id)) continue
      byId.set(id, {
        eventId: id,
        at: h.at as string,
        email,
        name,
        currency: (h.currency || 'ILS').toUpperCase(),
        gross,
        reported: false,
      })
    }
  }

  type Row = {
    seq: number
    eventId: string
    at: string
    email: string
    name: string
    description: string
    currency: string
    gross: number
    vat: number
    net: number
    reported: boolean
  }
  const sorted = Array.from(byId.values()).sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  )
  const rows: Row[] = sorted.map((r, i) => {
    const net = r.gross / (1 + frac)
    return {
      seq: i + 1,
      eventId: r.eventId,
      at: r.at,
      email: r.email,
      name: r.name,
      description: 'ניהול הורדות פלוס — מנוי',
      currency: r.currency,
      gross: round2(r.gross),
      vat: round2(r.gross - net),
      net: round2(net),
      reported: r.reported,
    }
  })

  // Totals per currency.
  const totals: Record<
    string,
    { count: number; gross: number; vat: number; net: number }
  > = {}
  for (const r of rows) {
    const t = (totals[r.currency] ||= { count: 0, gross: 0, vat: 0, net: 0 })
    t.count += 1
    t.gross = round2(t.gross + r.gross)
    t.vat = round2(t.vat + r.vat)
    t.net = round2(t.net + r.net)
  }

  return res
    .status(200)
    .json({ ok: true, year, month, vatPercent, rows, totals })
}

/** Mark a single casual charge as reported to מע"מ (or undo it). Writes
 *  a durable flag onto the casualLedger entry so the עסקת אקראי tab can
 *  track what's been filed (Form 8356) and what still needs filing.
 *  The client sends the row's identifying fields so a legacy charge
 *  that only existed in billingHistory becomes a proper ledger entry
 *  the first time it's marked. */
async function handleAdminMarkCasualReported(
  req: VercelRequest,
  res: VercelResponse,
) {
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'forbidden' })
  const body = (req.body || {}) as {
    eventId?: string
    reported?: boolean
    at?: string
    amount?: number
    currency?: string
    email?: string
    name?: string
  }
  const id = (body.eventId || '').trim()
  if (!id) return res.status(400).json({ ok: false, error: 'missing eventId' })
  const reported = body.reported === true
  const patch: Record<string, unknown> = {
    reported,
    reportedAt: reported ? new Date().toISOString() : null,
    reportedBy: reported ? admin : null,
  }
  // Backfill identity for legacy/billingHistory-only rows so the entry
  // is complete and keeps showing in the report after it's marked.
  if (typeof body.at === 'string' && body.at) patch.at = body.at
  if (typeof body.amount === 'number' && body.amount > 0)
    patch.amount = body.amount
  if (typeof body.currency === 'string' && body.currency)
    patch.currency = body.currency.toUpperCase()
  if (typeof body.email === 'string') patch.email = body.email
  if (typeof body.name === 'string') patch.name = body.name
  patch.eventId = id
  await getDb().collection('casualLedger').doc(id).set(patch, { merge: true })
  return res.status(200).json({ ok: true, reported })
}

async function handleAdminDeleteReferral(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const admin = await verifyAdminStepUp(req)
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
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const db = getDb()
  // Commissions are paid on the money actually kept — gross minus
  // PayPal fee minus VAT (VAT only when receipts are OFF). Fetch the
  // settings once for the whole report.
  const [receiptsOn, vatPercent] = await Promise.all([
    receiptsEnabled(),
    casualVatRatePercent(),
  ])
  const partnersSnap = await db
    .collection('referralPartners')
    .orderBy('createdAt', 'desc')
    .get()

  // Attribute by ACTUAL charges (durable casualLedger ∪ live billing),
  // not by live keys — so a partner keeps the commission they earned
  // even after the buyer cancelled and the key was removed. Aggregate
  // once, then look each partner up by code.
  const charges = await loadAllChargesMerged()
  interface PartnerAgg {
    paymentCount: number
    accounts: Set<string>
    revenueByCurrency: Record<string, number>
    netByCurrency: Record<string, number>
    // Initial-charge-only base, for partners on a "first purchase only"
    // commission.
    initialPaymentCount: number
    initialNetByCurrency: Record<string, number>
  }
  const byPartner = new Map<string, PartnerAgg>()
  for (const c of charges) {
    if (!c.referredBy) continue
    let agg = byPartner.get(c.referredBy)
    if (!agg) {
      agg = {
        paymentCount: 0,
        accounts: new Set(),
        revenueByCurrency: {},
        netByCurrency: {},
        initialPaymentCount: 0,
        initialNetByCurrency: {},
      }
      byPartner.set(c.referredBy, agg)
    }
    const b = chargeNetBreakdown({
      amount: c.gross,
      currency: c.currency,
      fee: c.fee,
      vatPercent,
      receiptsEnabled: receiptsOn,
    })
    agg.revenueByCurrency[c.currency] =
      (agg.revenueByCurrency[c.currency] || 0) + b.gross
    agg.netByCurrency[c.currency] = (agg.netByCurrency[c.currency] || 0) + b.net
    agg.paymentCount++
    if (c.kind === 'initial') {
      agg.initialNetByCurrency[c.currency] =
        (agg.initialNetByCurrency[c.currency] || 0) + b.net
      agg.initialPaymentCount++
    }
    if (c.email) agg.accounts.add(c.email.toLowerCase())
    else if (c.subscriptionId) agg.accounts.add(`sub:${c.subscriptionId}`)
  }

  const rows = []
  for (const d of partnersSnap.docs) {
    const data = d.data() as ReferralPartnerDoc & { loginEmail?: string }
    const agg = byPartner.get(data.code)
    const paidAccounts = agg ? agg.accounts.size : 0
    const paymentCount = agg ? agg.paymentCount : 0
    const revenueByCurrency: Record<string, number> = agg
      ? agg.revenueByCurrency
      : {}
    // Net after PayPal fee + VAT — the real base for the commission.
    const netByCurrency: Record<string, number> = agg ? agg.netByCurrency : {}
    const commission =
      data.commissionType && data.commissionValue
        ? {
            commissionType: data.commissionType,
            commissionValue: data.commissionValue,
            commissionCurrency: data.commissionCurrency || 'ILS',
          }
        : null
    // Commission owed (what the admin pays the partner) — percentage is
    // taken on the NET (after PayPal fee + VAT), not the gross. When the
    // partner is on "first purchase only", the base is the initial
    // charges alone (net + count), not renewals.
    const firstOnly = data.commissionFirstOnly === true
    const earnNet = firstOnly && agg ? agg.initialNetByCurrency : netByCurrency
    const earnCount =
      firstOnly && agg ? agg.initialPaymentCount : paymentCount
    const earningsByCurrency: Record<string, number> = {}
    if (commission?.commissionType === 'percent') {
      const f = commission.commissionValue / 100
      for (const [c, v] of Object.entries(earnNet)) {
        earningsByCurrency[c] = v * f
      }
    } else if (commission?.commissionType === 'fixed') {
      earningsByCurrency[commission.commissionCurrency] =
        earnCount * commission.commissionValue
    }
    rows.push({
      code: data.code,
      name: data.name,
      signups: typeof data.signups === 'number' ? data.signups : 0,
      paidAccounts,
      revenueByCurrency,
      netByCurrency,
      loginEmail: data.loginEmail || '',
      hasLogin: Boolean(data.loginEmail),
      commissionType: commission?.commissionType || null,
      commissionValue: commission?.commissionValue || null,
      commissionCurrency: commission?.commissionCurrency || null,
      commissionFirstOnly: firstOnly,
      earningsByCurrency,
      visibility: resolveVisibility(data.visibility),
    })
  }
  return res
    .status(200)
    .json({ ok: true, partners: rows, receiptsEnabled: receiptsOn, vatPercent })
}

/** Full drill-down for one partner: every attributed account + the
 *  revenue broken down by calendar month. */
async function handleAdminReferralDetail(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const db = getDb()

  // Charges come from the durable ledger (∪ live keys) filtered to this
  // partner, so a buyer whose key was deleted or whose subscription
  // ended STILL shows up with the revenue they generated. keysSnap is
  // read alongside only to label each account's CURRENT subscription
  // status.
  const [usersSnap, keysSnap, allCharges] = await Promise.all([
    db.collection('users').where('referredBy', '==', code).get(),
    db.collection('productKeys').where('referredBy', '==', code).get(),
    loadAllChargesMerged(),
  ])
  const charges = allCharges.filter((c) => c.referredBy === code)

  // email → current subscription status, from the live key (if any).
  const nowMs = Date.now()
  const emailToStatus = new Map<
    string,
    'active' | 'cancelled' | 'expired' | 'suspended'
  >()
  for (const k of keysSnap.docs) {
    const kd = k.data() as {
      nonPaidGrant?: boolean
      buyerEmail?: string
      redeemedByEmail?: string
      subscriptionStatus?: string
      expiresAt?: string
    }
    if (kd.nonPaidGrant) continue
    const email = (kd.buyerEmail || kd.redeemedByEmail || '').toLowerCase()
    if (!email) continue
    const expired = kd.expiresAt ? Date.parse(kd.expiresAt) < nowMs : false
    let st: 'active' | 'cancelled' | 'expired' | 'suspended'
    if (kd.subscriptionStatus === 'cancelled') st = 'cancelled'
    else if (kd.subscriptionStatus === 'suspended') st = 'suspended'
    else if (kd.subscriptionStatus === 'expired' || expired) st = 'expired'
    else st = 'active'
    emailToStatus.set(email, st)
  }

  const paidEmails = new Set<string>()
  const revenueByMonth: Record<string, Record<string, number>> = {}
  // First-seen info per paying email, so buyers with no user/key record
  // can still be listed as accounts below.
  const payerFirst = new Map<string, { email: string; at: string }>()
  for (const c of charges) {
    const email = c.email.toLowerCase()
    if (email) {
      paidEmails.add(email)
      const ex = payerFirst.get(email)
      if (!ex || (c.at && c.at < ex.at))
        payerFirst.set(email, { email: c.email, at: c.at || '' })
    }
    const d = c.at ? new Date(c.at) : null
    const month =
      d && !isNaN(d.getTime())
        ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
        : 'לא ידוע'
    revenueByMonth[month] = revenueByMonth[month] || {}
    revenueByMonth[month][c.currency] =
      (revenueByMonth[month][c.currency] || 0) + c.gross
  }

  // status: the subscription state shown next to each account.
  //   active/cancelled/expired/suspended — from a live key.
  //   ended  — paid in the past but the key is gone (deleted / removed).
  //   none   — signed up but never paid.
  const statusFor = (
    email: string,
    paid: boolean,
  ): 'active' | 'cancelled' | 'expired' | 'suspended' | 'ended' | 'none' => {
    const live = emailToStatus.get(email)
    if (live) return live
    return paid ? 'ended' : 'none'
  }

  const seen = new Set<string>()
  const accounts: Array<{
    email: string
    createdAt: string
    paid: boolean
    status: string
    keyless?: boolean
  }> = []
  for (const d of usersSnap.docs) {
    const u = d.data() as {
      email?: string
      createdAt?: string
      referredAt?: string
    }
    const email = (u.email || '').toLowerCase()
    if (email) seen.add(email)
    const paid = paidEmails.has(email)
    accounts.push({
      email: u.email || '',
      createdAt: u.createdAt || u.referredAt || '',
      paid,
      status: statusFor(email, paid),
    })
  }
  // Paying buyers no longer present as users/keys (deleted / ended) —
  // surface them so their revenue isn't invisible. keyless flags them.
  for (const [email, info] of payerFirst) {
    if (seen.has(email)) continue
    accounts.push({
      email: info.email,
      createdAt: info.at,
      paid: true,
      status: statusFor(email.toLowerCase(), true),
      keyless: true,
    })
  }
  accounts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

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
  const admin = await verifyAdmin2FA(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const fromMs = typeof body.fromMs === 'number' ? body.fromMs : null
  const toMs = typeof body.toMs === 'number' ? body.toMs : null
  const db = getDb()
  // Same net basis (after PayPal fee + VAT) as every other surface, so
  // the export stays in sync with the dashboard + revenue tab.
  const [receiptsOn, vatPercent] = await Promise.all([
    receiptsEnabled(),
    casualVatRatePercent(),
  ])

  const [partnerSnap, usersSnap, keysSnap, allCharges] = await Promise.all([
    db.collection('referralPartners').doc(code).get(),
    db.collection('users').where('referredBy', '==', code).get(),
    db.collection('productKeys').where('referredBy', '==', code).get(),
    loadAllChargesMerged(),
  ])
  const charges = allCharges.filter((c) => c.referredBy === code)

  const emailToName: Record<string, string> = {}
  for (const u of usersSnap.docs) {
    const d = u.data() as { email?: string; name?: string }
    if (d.email) emailToName[d.email.toLowerCase()] = d.name || ''
  }

  // Plan-type lookup (monthly/yearly) from live keys — used as a
  // best-effort label for charges; ledger-only charges (deleted key)
  // fall back to 'monthly'.
  const emailToPlan: Record<string, 'monthly' | 'yearly'> = {}
  const subToPlan: Record<string, 'monthly' | 'yearly'> = {}
  for (const k of keysSnap.docs) {
    const kd = k.data() as {
      nonPaidGrant?: boolean
      buyerEmail?: string
      redeemedByEmail?: string
      subscriptionId?: string
      subscriptionPlanDays?: number
      planDays?: number
    }
    if (kd.nonPaidGrant) continue
    const email = (kd.buyerEmail || kd.redeemedByEmail || '').toLowerCase()
    const days = kd.subscriptionPlanDays || kd.planDays || 30
    const planType: 'monthly' | 'yearly' = days >= 365 ? 'yearly' : 'monthly'
    if (email) emailToPlan[email] = planType
    if (kd.subscriptionId) subToPlan[kd.subscriptionId] = planType
  }

  const planFor = (c: MergedCharge): 'monthly' | 'yearly' =>
    subToPlan[c.subscriptionId] ||
    emailToPlan[c.email.toLowerCase()] ||
    'monthly'

  const payments: Array<{
    at: string
    email: string
    name: string
    planType: 'monthly' | 'yearly'
    amount: number
    fee: number
    vat: number
    net: number
    currency: string
  }> = []
  for (const c of charges) {
    const ms = Date.parse(c.at)
    if (isNaN(ms)) continue
    if (fromMs !== null && ms < fromMs) continue
    if (toMs !== null && ms > toMs) continue
    const b = chargeNetBreakdown({
      amount: c.gross,
      currency: c.currency,
      fee: c.fee,
      vatPercent,
      receiptsEnabled: receiptsOn,
    })
    const email = c.email.toLowerCase()
    payments.push({
      at: c.at,
      email: c.email,
      name: emailToName[email] || c.name || '',
      planType: planFor(c),
      amount: b.gross,
      fee: b.fee,
      vat: b.vat,
      net: b.net,
      currency: c.currency,
    })
  }

  payments.sort((a, b) => a.at.localeCompare(b.at))

  // Full roster: every referred account, plus any paying buyer whose
  // user/key record is gone (deleted / ended) so the CSV still lists
  // them. The CSV lists referred accounts even with zero revenue.
  const seen = new Set<string>()
  const accounts: Array<{
    email: string
    name: string
    createdAt: string
    planType: 'monthly' | 'yearly' | null
  }> = []
  for (const u of usersSnap.docs) {
    const d = u.data() as {
      email?: string
      name?: string
      createdAt?: string
      referredAt?: string
    }
    const email = (d.email || '').toLowerCase()
    if (email) seen.add(email)
    accounts.push({
      email: d.email || '',
      name: d.name || '',
      createdAt: d.createdAt || d.referredAt || '',
      planType: emailToPlan[email] || null,
    })
  }
  const payerFirst = new Map<
    string,
    { email: string; name: string; at: string; plan: 'monthly' | 'yearly' }
  >()
  for (const c of charges) {
    const email = c.email.toLowerCase()
    if (!email) continue
    const ex = payerFirst.get(email)
    if (!ex || (c.at && c.at < ex.at))
      payerFirst.set(email, {
        email: c.email,
        name: c.name,
        at: c.at || '',
        plan: planFor(c),
      })
  }
  for (const [email, info] of payerFirst) {
    if (seen.has(email)) continue
    accounts.push({
      email: info.email,
      name: emailToName[email] || info.name || '',
      createdAt: info.at,
      planType: info.plan,
    })
  }
  accounts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

  const partnerName =
    (partnerSnap.data() as { name?: string } | undefined)?.name || code
  return res.status(200).json({
    ok: true,
    partner: { code, name: partnerName },
    payments,
    accounts,
    receiptsEnabled: receiptsOn,
    vatPercent,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Partner self-serve dashboard auth.
 *
 *  A partner logs in at /partner with an email + password the admin
 *  set on their referralPartners doc. They see ONLY aggregate stats
 *  for their own code — never individual customer emails (privacy).
 * ────────────────────────────────────────────────────────────── */

/** Auto-generate a readable temporary partner password (no ambiguous
 *  characters). The partner is forced to replace it on first login. */
function generatePartnerTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(10)
  let out = ''
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

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
  /** Credential epoch — must match the partner doc's credEpoch. Bumped
   *  whenever a (temp) password is (re)issued, which invalidates every
   *  existing session and forces a fresh login. */
  ep?: number
}
function signPartnerToken(code: string, ep = 0): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + 30 * 24 * 60 * 60 // 30 days
  const header = b64urlEncode(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', use: 'partner' })),
  )
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ code, use: 'partner', iat, exp, ep })),
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

/** Verify a partner token AND that its credential epoch still matches
 *  the partner doc — i.e. the session wasn't invalidated by a password
 *  reset. Returns the code, or null (caller responds 401). */
async function requirePartner(token: string): Promise<{ code: string } | null> {
  const claims = verifyPartnerToken(token)
  if (!claims) return null
  const snap = await getDb().collection('referralPartners').doc(claims.code).get()
  if (!snap.exists) return null
  const ep = (snap.data() as { credEpoch?: number }).credEpoch || 0
  if ((claims.ep || 0) !== ep) return null
  return { code: claims.code }
}

/** Aggregate stats for one partner code (no customer PII). */
async function computePartnerStats(code: string) {
  const db = getDb()
  // NET is computed after PayPal fee AND after VAT (VAT only when SUMIT
  // receipts are OFF) — see chargeNetBreakdown.
  const [receiptsOn, vatPercent] = await Promise.all([
    receiptsEnabled(),
    casualVatRatePercent(),
  ])
  // Earnings come from the durable ledger (∪ live billing) filtered to
  // this partner — so the partner keeps the commission they earned even
  // after the buyer cancelled and the key was removed.
  const [partnerSnap, usersSnap, allCharges, curTermsVersion] = await Promise.all([
    db.collection('referralPartners').doc(code).get(),
    db.collection('users').where('referredBy', '==', code).get(),
    loadAllChargesMerged(),
    partnerTermsVersion(),
  ])
  const charges = allCharges.filter((c) => c.referredBy === code)
  const data = partnerSnap.data() as ReferralPartnerDoc | undefined
  // "מקנייה ראשונה בלבד": commission is earned on the initial charge (the
  // first payment) only — NOT on renewals.
  const firstOnly = data?.commissionFirstOnly === true

  // Aggregate a charge list into by-currency / by-month buckets.
  // chargeNetBreakdown applies the PayPal fee and (receipts OFF) VAT, so
  // NET is what actually landed.
  function buildAgg(list: MergedCharge[]) {
    const grossByCurrency: Record<string, number> = {}
    const grossByMonth: Record<string, Record<string, number>> = {}
    const countByMonth: Record<string, number> = {}
    const netByCurrency: Record<string, number> = {}
    const netByMonth: Record<string, Record<string, number>> = {}
    const feeByCurrency: Record<string, number> = {}
    const vatByCurrency: Record<string, number> = {}
    for (const c of list) {
      const cur = c.currency
      const b = chargeNetBreakdown({
        amount: c.gross,
        currency: cur,
        fee: c.fee,
        vatPercent,
        receiptsEnabled: receiptsOn,
      })
      const m = c.at ? c.at.slice(0, 7) : 'unknown'
      grossByCurrency[cur] = (grossByCurrency[cur] || 0) + b.gross
      grossByMonth[m] = grossByMonth[m] || {}
      grossByMonth[m][cur] = (grossByMonth[m][cur] || 0) + b.gross
      netByCurrency[cur] = (netByCurrency[cur] || 0) + b.net
      netByMonth[m] = netByMonth[m] || {}
      netByMonth[m][cur] = (netByMonth[m][cur] || 0) + b.net
      feeByCurrency[cur] = (feeByCurrency[cur] || 0) + b.fee
      vatByCurrency[cur] = (vatByCurrency[cur] || 0) + b.vat
      countByMonth[m] = (countByMonth[m] || 0) + 1
    }
    return {
      grossByCurrency,
      grossByMonth,
      countByMonth,
      netByCurrency,
      netByMonth,
      feeByCurrency,
      vatByCurrency,
    }
  }

  // Paying-account count = all attributed charges (the revenue view shows
  // every sale regardless of the first-only commission rule).
  const paidEmails = new Set<string>()
  for (const c of charges) if (c.email) paidEmails.add(c.email.toLowerCase())

  // FULL drives the revenue display; EARN drives the commission — when
  // "first purchase only" is set, the commission is computed over the
  // initial charges alone, not renewals.
  const full = buildAgg(charges)
  const earn = buildAgg(
    firstOnly ? charges.filter((c) => c.kind === 'initial') : charges,
  )

  const commission =
    data?.commissionType && data?.commissionValue
      ? {
          commissionType: data.commissionType,
          commissionValue: data.commissionValue,
          commissionCurrency: data.commissionCurrency || 'ILS',
          firstOnly,
        }
      : null
  // Gross earnings (before PayPal fee) + NET earnings (after fee).
  // For fixed commissions both are identical (a flat per-charge payout
  // isn't reduced by the sale fee); for percent, net rides on the
  // post-fee revenue.
  const grossEarnings = computeEarnings(
    commission,
    earn.grossByCurrency,
    earn.grossByMonth,
    earn.countByMonth,
  )
  const netEarnings = computeEarnings(
    commission,
    earn.netByCurrency,
    earn.netByMonth,
    earn.countByMonth,
  )
  // Split the deduction from the partner's earnings into its two parts:
  // the PayPal-fee portion and the VAT portion (VAT only when receipts
  // are OFF). For a percent commission each portion is commission% of
  // the underlying fee/VAT; a fixed commission isn't reduced at all.
  const f =
    commission?.commissionType === 'percent'
      ? commission.commissionValue / 100
      : 0
  const earningsPaypalFeeByCurrency: Record<string, number> = {}
  const earningsVatByCurrency: Record<string, number> = {}
  if (f > 0) {
    for (const [c, v] of Object.entries(earn.feeByCurrency)) {
      const x = v * f
      if (x > 0.0001) earningsPaypalFeeByCurrency[c] = x
    }
    for (const [c, v] of Object.entries(earn.vatByCurrency)) {
      const x = v * f
      if (x > 0.0001) earningsVatByCurrency[c] = x
    }
  }
  // Combined (fee + VAT) — kept for any consumer that wants the total
  // shaved off; equals gross earnings − net earnings.
  const earningsFeeByCurrency: Record<string, number> = {}
  for (const c of Object.keys(grossEarnings.byCurrency)) {
    const diff =
      (grossEarnings.byCurrency[c] || 0) - (netEarnings.byCurrency[c] || 0)
    if (diff > 0.0001) earningsFeeByCurrency[c] = diff
  }
  const vis = resolveVisibility(data?.visibility)

  // MODULAR + PARTNER-SAFE: only the fields the admin allows this
  // partner to see are returned. Gross revenue is included ONLY when
  // visibility.revenue is on.
  return {
    code,
    name: data?.name || code,
    // When the partnership was created — shown on the dashboard so the
    // partner knows the history below spans the whole partnership.
    since: typeof data?.createdAt === 'string' ? data.createdAt : null,
    link: `${REFERRAL_LINK_BASE}/?ref=${encodeURIComponent(code)}`,
    visibility: vis,
    // Onboarding gates — always returned (not visibility-gated): the
    // partner must clear these before reaching the dashboard.
    mustChangePassword: data?.mustChangePassword === true,
    // Version-aware: once the admin publishes a partner-terms doc, the
    // partner's accepted version must match the current one — otherwise
    // they're shown the accept screen again. Before any doc is published,
    // keep the legacy behavior (accepted = has a timestamp).
    termsAccepted:
      curTermsVersion === null
        ? Boolean(data?.termsAcceptedAt)
        : Boolean(data?.termsAcceptedAt) &&
          String(data?.termsVersion ?? '') === String(curTermsVersion),
    signups: vis.counts ? usersSnap.size : null,
    paidAccounts: vis.counts ? paidEmails.size : null,
    commission: vis.earnings ? commission : null,
    // Main figure shown to the partner = NET (after PayPal fee).
    earningsByCurrency: vis.earnings ? netEarnings.byCurrency : null,
    earningsByMonth: vis.earnings ? netEarnings.byMonth : null,
    // For the "אחרי עמלה" breakdown: what it would've been with no
    // fee, and how much the fee shaved off the partner's earnings.
    earningsGrossByCurrency: vis.earnings ? grossEarnings.byCurrency : null,
    earningsFeeByCurrency: vis.earnings ? earningsFeeByCurrency : null,
    // Split deduction: PayPal fee vs VAT (VAT only when receipts OFF).
    earningsPaypalFeeByCurrency: vis.earnings
      ? earningsPaypalFeeByCurrency
      : null,
    earningsVatByCurrency: vis.earnings ? earningsVatByCurrency : null,
    receiptsEnabled: receiptsOn,
    revenueByCurrency: vis.revenue ? full.grossByCurrency : null,
    revenueByMonth: vis.revenue ? full.grossByMonth : null,
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
  const data = doc.data() as { passwordHash?: string; credEpoch?: number }
  if (!data.passwordHash || !verifyPartnerPassword(password, data.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'מייל או סיסמה שגויים' })
  }
  const token = signPartnerToken(doc.id, data.credEpoch || 0)
  const stats = await computePartnerStats(doc.id)
  return res.status(200).json({ ok: true, token, partner: stats })
}

/** POST { token } → { ok, partner } (fresh aggregates) */
async function handlePartnerStats(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { token?: string }
  const claims = await requirePartner(body.token || '')
  if (!claims) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const stats = await computePartnerStats(claims.code)
  return res.status(200).json({ ok: true, partner: stats })
}

/** POST { token, newPassword } — partner sets their own (permanent)
 *  password on first login, replacing the admin-issued temp one and
 *  clearing the must-change flag. Returns a fresh token + stats. */
async function handlePartnerChangePassword(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { token?: string; newPassword?: string }
  const claims = await requirePartner(body.token || '')
  if (!claims) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const newPassword = body.newPassword || ''
  if (newPassword.length < 6) {
    return res
      .status(400)
      .json({ ok: false, error: 'סיסמה חייבת להיות לפחות 6 תווים' })
  }
  const ref = getDb().collection('referralPartners').doc(claims.code)
  const snap = await ref.get()
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  await ref.update({
    passwordHash: hashPartnerPassword(newPassword),
    mustChangePassword: false,
  })
  // Keep the same epoch — the partner is changing their OWN password, so
  // their current session should stay valid.
  const ep = (snap.data() as { credEpoch?: number }).credEpoch || 0
  const token = signPartnerToken(claims.code, ep)
  const stats = await computePartnerStats(claims.code)
  return res.status(200).json({ ok: true, token, partner: stats })
}

/** POST { token } — partner accepts the partnership terms. */
async function handlePartnerAcceptTerms(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { token?: string }
  const claims = await requirePartner(body.token || '')
  if (!claims) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const ref = getDb().collection('referralPartners').doc(claims.code)
  if (!(await ref.get()).exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  // Stamp the CURRENT published partner-terms version (from the DB) so a
  // later admin edit that bumps the version forces this partner to
  // re-accept on next login. Falls back to the legacy constant when the
  // admin hasn't published a doc yet.
  const ver = await partnerTermsVersion()
  await ref.update({
    termsAcceptedAt: new Date().toISOString(),
    termsVersion: ver === null ? PARTNER_TERMS_VERSION : String(ver),
  })
  const stats = await computePartnerStats(claims.code)
  return res.status(200).json({ ok: true, partner: stats })
}

/** POST { idToken, code, loginEmail?, regenerate? } — admin updates a
 *  partner's dashboard login email and/or RE-ISSUES credentials. The
 *  password is never typed by the admin: `regenerate:true` auto-creates
 *  a fresh temp password, forces the first-login flow again, and emails
 *  it. Passing only loginEmail just changes the address. */
async function handleAdminSetReferralCredentials(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as {
    idToken?: string
    code?: string
    loginEmail?: string
    regenerate?: boolean
  }
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  const loginEmail = (body.loginEmail || '').trim().toLowerCase()
  const regenerate = body.regenerate === true
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  if (loginEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל לא תקין' })
  }
  const db = getDb()
  const ref = db.collection('referralPartners').doc(code)
  const existingSnap = await ref.get()
  if (!existingSnap.exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  const existingData = existingSnap.data() as ReferralPartnerDoc & {
    loginEmail?: string
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
  const recipient = loginEmail || existingData.loginEmail || ''
  if (regenerate && !recipient) {
    return res
      .status(400)
      .json({ ok: false, error: 'צריך מייל כניסה כדי לשלוח סיסמה' })
  }
  const update: Record<string, unknown> = {}
  if (loginEmail) update.loginEmail = loginEmail
  let tempPassword = ''
  if (regenerate) {
    tempPassword = generatePartnerTempPassword()
    update.passwordHash = hashPartnerPassword(tempPassword)
    // Re-issued credentials → force change + re-accept terms again, and
    // bump the epoch so any existing partner session is logged out and
    // must re-login with the new temp password (and hit the gate).
    update.mustChangePassword = true
    update.termsAcceptedAt = null
    update.credEpoch = Date.now()
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ ok: false, error: 'אין מה לעדכן' })
  }
  await ref.update(update)

  let emailSent = false
  if (regenerate && recipient) {
    const commissionLabel = commissionLabelHe(
      existingData.commissionType,
      existingData.commissionValue,
      existingData.commissionCurrency,
      existingData.commissionFirstOnly === true,
    )
    try {
      await sendPartnerWelcomeEmail({
        to: recipient,
        name: existingData.name || code,
        code,
        password: tempPassword,
        commissionLabel,
      })
      emailSent = true
    } catch (e) {
      console.warn('[partner] welcome email failed (ignored):', e)
    }
  }
  return res
    .status(200)
    .json({ ok: true, tempPassword: tempPassword || undefined, emailSent })
}

/** POST { idToken, code, commissionType, commissionValue, commissionCurrency? }
 *  — admin sets/updates a partner's commission agreement. Send
 *  commissionType:'none' (or invalid) to clear it. */
async function handleAdminSetReferralCommission(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = req.body as { idToken?: string; code?: string }
  const admin = await verifyAdminStepUp(req)
  if (!admin) return res.status(403).json({ ok: false, error: 'admin only' })
  const code = (body.code || '').trim()
  if (!code) return res.status(400).json({ ok: false, error: 'missing code' })
  const db = getDb()
  const ref = db.collection('referralPartners').doc(code)
  const snap = await ref.get()
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }
  const existing = snap.data() as ReferralPartnerDoc & { loginEmail?: string }
  // 'ללא עמלה' (not the "to be decided" wording) when there's no agreement
  // — clearer for the before/after change email.
  const labelFor = (
    t: 'percent' | 'fixed' | undefined | null,
    v: number | undefined | null,
    c: string | undefined | null,
    f: boolean,
  ): string => (!t || !v ? 'ללא עמלה' : commissionLabelHe(t, v, c, f))
  const oldLabel = labelFor(
    existing.commissionType,
    existing.commissionValue,
    existing.commissionCurrency,
    existing.commissionFirstOnly === true,
  )

  const commission = parseCommission(
    req.body as {
      commissionType?: unknown
      commissionValue?: unknown
      commissionCurrency?: unknown
    },
  )
  const firstOnly =
    (req.body as { commissionFirstOnly?: unknown }).commissionFirstOnly === true
  if (commission) {
    await ref.update({
      commissionType: commission.commissionType,
      commissionValue: commission.commissionValue,
      commissionCurrency: commission.commissionCurrency,
      commissionFirstOnly: firstOnly,
    })
  } else {
    // Clear the agreement.
    await ref.update({
      commissionType: FieldValue.delete(),
      commissionValue: FieldValue.delete(),
      commissionCurrency: FieldValue.delete(),
      commissionFirstOnly: FieldValue.delete(),
    })
  }
  const newLabel = commission
    ? commissionLabelHe(
        commission.commissionType,
        commission.commissionValue,
        commission.commissionCurrency,
        firstOnly,
      )
    : 'ללא עמלה'

  // Transparency: email the partner the before/after when their reward
  // terms actually change (and they have a dashboard login). Best-effort.
  if (existing.loginEmail && oldLabel !== newLabel) {
    try {
      await sendPartnerCommissionChangeEmail({
        to: existing.loginEmail,
        name: existing.name || code,
        oldLabel,
        newLabel,
      })
    } catch (e) {
      console.warn('[partner] commission-change email failed (ignored):', e)
    }
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
  const admin = await verifyAdminStepUp(req)
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

/** ADMIN manual attribution — durably assign a buyer's past charges to a
 *  partner by the buyer's email. The fix for "a partner sale was lost
 *  because the buyer was never ref-bound, or the account/key was later
 *  deleted": writes `referredBy` straight onto the durable casualLedger
 *  entries (which survive account/key deletion), and best-effort onto the
 *  live key + user account if they still exist. Step-up required. Money
 *  operation — only ADDS attribution, idempotent (re-running is a no-op).
 *  POST { idToken, code, email } → { ok, ledgerCount, keyCount, userUpdated } */
async function handleAdminAttributeReferral(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (!(await verifyAdminStepUp(req))) {
    return res.status(403).json({ ok: false, error: 'admin only' })
  }
  const body = (req.body || {}) as { code?: string; email?: string }
  const code = (body.code || '').trim()
  const email = (body.email || '').trim()
  const target = email.toLowerCase()
  if (!code || !target) {
    return res.status(400).json({ ok: false, error: 'חסר קוד שותף או אימייל' })
  }
  const db = getDb()
  if (!(await db.collection('referralPartners').doc(code).get()).exists) {
    return res.status(404).json({ ok: false, error: 'שותף לא קיים' })
  }

  let ledgerCount = 0
  let keyCount = 0
  let userUpdated = false

  // 1) The durable record — stamp referredBy on every casualLedger charge
  //    for this email. casualLedger is one small doc per charge.
  try {
    const snap = await db.collection('casualLedger').get()
    let batch = db.batch()
    let ops = 0
    for (const doc of snap.docs) {
      const d = doc.data() as { email?: string; referredBy?: string }
      if ((d.email || '').toLowerCase() === target && d.referredBy !== code) {
        batch.set(doc.ref, { referredBy: code }, { merge: true })
        ledgerCount += 1
        ops += 1
        if (ops === 400) {
          await batch.commit()
          batch = db.batch()
          ops = 0
        }
      }
    }
    if (ops > 0) await batch.commit()
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ledger: ' + (e as Error).message })
  }

  // 2) Best-effort: live keys for this buyer (so the live view + future
  //    renewals attribute too). Keys may be gone — that's fine.
  try {
    for (const field of ['buyerEmail', 'redeemedByEmail'] as const) {
      const ks = await db.collection('productKeys').where(field, '==', email).get()
      for (const doc of ks.docs) {
        const kd = doc.data() as { referredBy?: string }
        if (kd.referredBy !== code) {
          await doc.ref.set({ referredBy: code }, { merge: true })
          keyCount += 1
        }
      }
    }
  } catch {
    /* best-effort */
  }

  // 3) Best-effort: the user account, if it still exists, so it counts as
  //    a referred signup and any future charge attributes automatically.
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const rec = await getAuth(getFirebase()).getUserByEmail(email)
    const uref = db.collection('users').doc(rec.uid)
    const usnap = await uref.get()
    const had = (usnap.data() as { referredBy?: string } | undefined)?.referredBy
    if (had !== code) {
      await uref.set(
        { referredBy: code, referredAt: new Date().toISOString() },
        { merge: true },
      )
      userUpdated = true
    }
  } catch {
    /* no account (deleted/guest) — the ledger stamp above is what counts */
  }

  return res.status(200).json({ ok: true, ledgerCount, keyCount, userUpdated })
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
