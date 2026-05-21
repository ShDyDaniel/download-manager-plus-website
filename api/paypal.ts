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
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  // Action can come from query string or body; both work so the
  // PayPal Dashboard webhook URL can use ?action=webhook in the URL
  // without needing custom body params.
  const action =
    (typeof req.query.action === 'string' ? req.query.action : '') ||
    (typeof (req.body as { action?: string })?.action === 'string'
      ? (req.body as { action: string }).action
      : '')

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
  await db.collection('productKeys').doc(key).set({
    key,
    tier: 'pro',
    redeemedBy: null,
    redeemedByEmail: null,
    redeemedAt: null,
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
  })
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
  const body = req.body as { plan?: 'monthly' | 'yearly'; email?: string }
  const plan = body.plan
  const email = (body.email || '').trim().toLowerCase()
  if (plan !== 'monthly' && plan !== 'yearly') {
    return res
      .status(400)
      .json({ ok: false, error: `תוכנית לא חוקית: ${plan || '(ריק)'}` })
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
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
    const profile: ProfileSummary = {
      email,
      plan: isAdmin ? 'admin' : primaryIsActive || hasActiveSub ? 'pro' : 'free',
      planLabel: isAdmin ? 'Admin' : primaryIsActive || hasActiveSub ? 'Pro' : 'חינם',
      keyLast8: primaryKeyStr ? primaryKeyStr.slice(-8) : null,
      validUntil: primaryExpiresAt,
      hasActiveSubscription: hasActiveSub,
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
    'User cancelled via dm-plus.vercel.app/manage'
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
  return Buffer.from(s, 'hex')
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
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <head><meta charset="utf-8"/><meta name="color-scheme" content="only dark"/></head>
  <body style="margin:0;padding:0;background-color:#0b0b14;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;direction:rtl;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#0b0b14;">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;background-color:#14141f;border-radius:16px;border:1px solid #2a2a3a;">
          <tr><td style="padding:32px;text-align:right;direction:rtl;">
            <h1 style="margin:0 0 16px;font-size:22px;color:#fbbf24;font-weight:700;">ברוך הבא ל-Pro 🎉</h1>
            <p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#e5e7eb;">
              המנוי שלך פעיל! מצורף מפתח Pro לתוכנה <strong>ניהול הורדות פלוס</strong>.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;">
              <tr><td align="center" style="background-color:#0b0b14;border:1px solid #6b4f0c;border-radius:12px;padding:16px;">
                <div style="font-size:11px;color:#9ca3af;margin-bottom:6px;">מפתח המוצר</div>
                <div dir="ltr" style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:18px;color:#fbbf24;letter-spacing:0.05em;font-weight:600;">${args.key}</div>
              </td></tr>
            </table>
            <h2 style="font-size:15px;margin:20px 0 8px;color:#e5e7eb;font-weight:600;">פרטי המנוי</h2>
            <div style="font-size:13px;line-height:1.85;color:#d1d5db;">
              <div>• תוכנית: ${args.planLabel} (${args.price} ${symbol})</div>
              <div>• חיוב הבא: ${nextDate}</div>
              <div>• מתחדש אוטומטית עד שתבטל</div>
              <div>• ניהול / ביטול: <a href="${WEBSITE_BASE}/manage" style="color:#fbbf24;">${WEBSITE_BASE}/manage</a></div>
            </div>
            <p style="margin:28px 0 0;font-size:11px;color:#6b7280;">
              מנוי ID: <span dir="ltr">${args.subscriptionId}</span>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: 'המנוי שלך פעיל — ניהול הורדות פלוס Pro',
    html,
  })
}
