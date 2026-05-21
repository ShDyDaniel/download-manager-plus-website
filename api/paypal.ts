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
    const summary =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? (parsed as { message?: string }).message
        : text.slice(0, 200)
    throw new Error(`PayPal ${method} ${path} failed: ${r.status} — ${summary}`)
  }
  return parsed as T
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
    try {
      await paypalCall('POST', `/v1/billing/plans/${created.id}/activate`, {})
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('422')) throw err
      console.warn(
        `[paypal] activate ${created.id} returned 422 — assuming already ACTIVE`,
      )
    }
  }
  return created.id
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

async function syncPlansForPricing(pricing: {
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
  async function reuseOrCreate(
    slot: 'monthlyRegular' | 'monthlySale' | 'yearlyRegular' | 'yearlySale',
    amount: number | null,
    interval: 'monthly' | 'yearly',
    label: string,
  ): Promise<{ planId: string; amount: number } | null> {
    if (amount === null) return null
    const persisted = existingPlans[slot]
    if (persisted && persisted.amount === amount) return persisted
    if (persisted) await deactivatePaypalPlan(persisted.planId)
    const newId = await createPaypalPlan({
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
  await ref.set(
    {
      paypalPlans: {
        monthlyRegular,
        monthlySale,
        yearlyRegular,
        yearlySale,
      },
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
const SESSION_TTL_SECONDS = 60 * 60 // 1 hour
const MAX_REASON_LENGTH = 500
const WEBSITE_BASE = 'https://dm-plus.vercel.app'

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
        result = {
          ok: true,
          summary: `logged payment failure for ${(event.resource as { id?: string } | undefined)?.id || '?'}`,
        }
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
  const newExpiresAt = new Date(baseTime + days * 86_400_000)
  await keyDoc.ref.update({
    expiresAt: newExpiresAt.toISOString(),
    lastRenewalAt: new Date().toISOString(),
    subscriptionStatus: 'active',
    reminder10dSentAt: null,
    reminder2dSentAt: null,
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
  const initialExpiresAt = new Date(Date.now() + planDays * 86_400_000)

  // If the buyer purchased from inside their /account page (signed
  // in), pendingSubscriptions has their uid as linkToUid. Auto-
  // redeem the new key to that account so the user doesn't need
  // to open the desktop app and paste the key — and reuse the
  // same account-lock logic that /api/keys/redeem runs so any
  // prior key on the same account gets unlinked atomically.
  // Guest purchases (linkToUid=null) keep the old behaviour:
  // unredeemed key, user redeems manually inside the app.
  let linkToUid: string | null = null
  try {
    const pendingDoc = await db
      .collection('pendingSubscriptions')
      .doc(subscriptionId)
      .get()
    if (pendingDoc.exists) {
      const data = pendingDoc.data() as { linkToUid?: string | null }
      if (typeof data.linkToUid === 'string' && data.linkToUid) {
        linkToUid = data.linkToUid
      }
    }
  } catch (err) {
    console.warn(
      '[webhook/sale-completed] pendingSubscriptions lookup failed:',
      err,
    )
  }

  const baseKeyDoc = {
    key,
    tier: 'pro',
    expiresAt: initialExpiresAt.toISOString(),
    createdAt: new Date().toISOString(),
    createdBy: `paypal-subscription-${planDays === 30 ? 'monthly' : 'yearly'}`,
    buyerEmail,
    subscriptionId,
    planId: sub.plan_id,
    subscriptionPrice: planPrice,
    subscriptionCurrency: planCurrency,
    subscriptionPlanDays: planDays,
    planDays,
    subscriptionStatus: 'active',
    subscriptionStartedAt: new Date().toISOString(),
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
  await keys.docs[0].ref.update({
    subscriptionStatus:
      event.event_type === 'BILLING.SUBSCRIPTION.EXPIRED'
        ? 'expired'
        : 'cancelled',
    subscriptionCancelledAt: new Date().toISOString(),
  })
  return {
    ok: true,
    summary: `marked ${keys.docs[0].id} as ${event.event_type}`,
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
  }
  const plan = body.plan
  const email = (body.email || '').trim().toLowerCase()
  // Optional: the buyer arrived from /account already signed-in to
  // their existing dmplus account. We stash their uid alongside the
  // pending subscription so the webhook that fires when payment
  // completes can AUTO-REDEEM the new key to that account — no
  // "open the app, paste the key" step needed, and the
  // account-lock logic in keys/redeem also runs (unlinks any prior
  // expired key the user had on the same account). When the token
  // is invalid/expired we just ignore it and fall through to the
  // guest-purchase flow.
  let linkToUid: string | null = null
  if (body.sessionToken) {
    const claims = verifySessionToken(body.sessionToken.trim())
    if (claims) {
      // Optional second guard: refuse if the typed email doesn't
      // match the account's email. Protects against a logged-in
      // user accidentally buying a sub for someone ELSE's email.
      if (!email || claims.email.toLowerCase() === email) {
        linkToUid = claims.uid
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
  // ── Rate limit ─────────────────────────────────────────────
  //
  // The /buy form is genuinely public — first-time visitors don't
  // have a Firebase account yet, so we can't gate on an idToken
  // without breaking the new-customer flow. Instead we throttle
  // per-IP and per-email so an attacker can't spam subscription
  // creation (which costs PayPal API quota + fills our
  // pendingSubscriptions collection).
  //
  // Limits are intentionally generous so a legitimate user
  // (browser back/refresh, accidental double-click) never trips
  // them. Storage is a tiny Firestore doc per IP/email with a
  // sliding 60-minute window.
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.headers['x-real-ip'] as string | undefined) ||
    'unknown'
  const ipKey = ip.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60)
  const emailKey = email.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60)
  try {
    const allowed = await Promise.all([
      tryRateLimit(`create-sub_ip_${ipKey}`, 10, 60 * 60),
      tryRateLimit(`create-sub_email_${emailKey}`, 5, 60 * 60),
    ])
    if (!allowed.every(Boolean)) {
      return res.status(429).json({
        ok: false,
        error:
          'יותר מדי ניסיונות רישום מהכתובת הזו בשעה האחרונה. נסה שוב מאוחר יותר.',
      })
    }
  } catch (err) {
    // Rate-limit infra failure (Firestore down?) shouldn't block
    // legitimate buyers. Log and proceed — the per-PayPal-account
    // limits will eventually kick in.
    console.warn('[paypal/create-subscription] rate-limit check failed:', err)
  }
  const pricing = await loadCurrentPricing()
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
    const ownedSnap = await db
      .collection('productKeys')
      .where('redeemedBy', '==', uid)
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
        status: typeof k.subscriptionStatus === 'string' ? k.subscriptionStatus : 'unknown',
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
    const now = Date.now()
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
    const primaryIsActive = primaryExpiresAt
      ? Date.parse(primaryExpiresAt) > now
      : false
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
    'User cancelled via dm-plus.vercel.app/account'
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
  const plans = await syncPlansForPricing(pricing)
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
