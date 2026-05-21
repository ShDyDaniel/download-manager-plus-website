import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'
import {
  getDb,
  loadCurrentPricing,
  paypalCall,
  syncPlansForPricing,
  verifyWebhookSignature,
} from '../api-lib/paypal'

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
      case 'status':
        return await handleStatus(req, res)
      case 'cancel':
        return await handleCancel(req, res)
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
  const db = getDb()
  const snap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', uid)
    .get()
  const subs = snap.docs
    .map((d) => d.data() as KeyDoc)
    .filter((k) => k.subscriptionId)
    .map((k) => ({
      key: k.key || '',
      subscriptionId: k.subscriptionId!,
      status: k.subscriptionStatus || 'unknown',
      expiresAt: k.expiresAt || null,
      startedAt: k.subscriptionStartedAt || null,
      cancelledAt: k.subscriptionCancelledAt || null,
      price: k.subscriptionPrice ?? null,
      currency: k.subscriptionCurrency || 'ILS',
      planDays: k.subscriptionPlanDays || 30,
      cycleLabel: (k.subscriptionPlanDays || 30) === 30 ? 'חודשי' : 'שנתי',
    }))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))

  // Also pick up unredeemed buyer-only subscriptions (user subscribed
  // but hasn't redeemed the key in the app yet) so they can still
  // cancel.
  const buyerSnap = await db
    .collection('productKeys')
    .where('buyerEmail', '==', email)
    .where('redeemedBy', '==', null)
    .get()
  for (const doc of buyerSnap.docs) {
    const k = doc.data() as KeyDoc
    if (!k.subscriptionId) continue
    if (subs.some((s) => s.subscriptionId === k.subscriptionId)) continue
    subs.push({
      key: k.key || '',
      subscriptionId: k.subscriptionId,
      status: k.subscriptionStatus || 'unknown',
      expiresAt: k.expiresAt || null,
      startedAt: k.subscriptionStartedAt || null,
      cancelledAt: k.subscriptionCancelledAt || null,
      price: k.subscriptionPrice ?? null,
      currency: k.subscriptionCurrency || 'ILS',
      planDays: k.subscriptionPlanDays || 30,
      cycleLabel: (k.subscriptionPlanDays || 30) === 30 ? 'חודשי' : 'שנתי',
    })
  }
  const token = signSessionToken({
    uid,
    email,
    subscriptionIds: subs.map((s) => s.subscriptionId),
  })
  return res.status(200).json({ ok: true, token, email, subscriptions: subs })
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
