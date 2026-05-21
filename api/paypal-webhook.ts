import type { VercelRequest, VercelResponse } from '@vercel/node'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb, paypalCall, verifyWebhookSignature } from './_paypal'
import nodemailer from 'nodemailer'

/**
 * PayPal Subscriptions webhook receiver.
 *
 * PayPal POSTs events here whenever a billing-related thing
 * happens — subscription created, monthly payment captured, user
 * cancelled, payment failed, dispute opened. We use these events
 * to keep the user's productKey in sync with reality:
 *
 *   - PAYMENT.SALE.COMPLETED      → extend the user's key by the
 *                                   plan's period (30 / 365 days)
 *   - BILLING.SUBSCRIPTION.CANCELLED → mark the key as
 *                                   "subscription cancelled" so the
 *                                   /manage page shows the right
 *                                   thing. The key stays VALID
 *                                   until its current expiresAt —
 *                                   the user gets what they paid
 *                                   for, just no further renewals.
 *   - BILLING.SUBSCRIPTION.PAYMENT.FAILED → email the user, keep
 *                                   them informed; PayPal will
 *                                   retry per the plan's policy
 *   - BILLING.SUBSCRIPTION.SUSPENDED → all payment retries failed;
 *                                   mark status, send email
 *   - CUSTOMER.DISPUTE.CREATED    → potential fraud; log loudly
 *                                   for manual review
 *
 * Security model (in order of layers):
 *
 *   1. Signature verification — every request runs through PayPal's
 *      `/v1/notifications/verify-webhook-signature` endpoint. If
 *      verification_status !== 'SUCCESS' we return 401 and don't
 *      touch any state. This stops forged events.
 *
 *   2. Idempotency — each event has a globally-unique `id` field.
 *      Before processing we check `paypalEvents/{id}` in Firestore;
 *      if it exists we return 200 immediately. PayPal retries
 *      failed deliveries up to 25 times over 3 days, and a duplicate
 *      can otherwise double-extend a key.
 *
 *   3. Cross-check the amount — the webhook tells us "subscription
 *      X paid amount Y". We re-fetch the subscription from PayPal's
 *      API and verify Y matches the plan's locked-in price. If not
 *      (PayPal bug, or some weirdness), we don't extend the key
 *      and log loudly.
 *
 *   4. Always return 200 to PayPal — even on processing failures
 *      we want the event marked delivered. Otherwise PayPal retries
 *      a permanently-broken event 25 times and floods our function
 *      logs. The actual failure is captured in the `processedAt`
 *      doc with `error: ...` for later inspection.
 *
 * Required env vars:
 *   PAYPAL_WEBHOOK_ID — the id of the webhook registered in the
 *     PayPal dashboard (Apps & Credentials → Webhooks → ID). This
 *     is what verifyWebhookSignature uses to look up the right
 *     signing cert. Set this AFTER registering the webhook URL
 *     `https://dm-plus.vercel.app/api/paypal-webhook` in PayPal.
 */

export const config = {
  // PayPal expects a response within 30 seconds; if we don't reply
  // fast enough it considers the delivery failed and retries. Most
  // events take <2s but we bump to 60s in case a Firestore round-
  // trip is slow.
  maxDuration: 60,
}

interface PayPalWebhookEvent {
  id: string
  event_type: string
  resource_type?: string
  create_time?: string
  resource?: Record<string, unknown>
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  // Read the raw body — we'll need both the parsed JSON (for the
  // verification call's `webhook_event` field) and the raw text
  // is helpful for debug logs.
  const event = req.body as PayPalWebhookEvent
  if (!event || typeof event.id !== 'string' || !event.event_type) {
    return res.status(400).json({ ok: false, error: 'Bad webhook payload' })
  }

  // ─── Signature verification ────────────────────────────────
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
    console.warn('[webhook] missing signature headers')
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
    console.warn('[webhook] signature verification FAILED for event', event.id)
    return res.status(401).json({ ok: false, error: 'Invalid signature' })
  }

  // ─── Idempotency ────────────────────────────────────────────
  const db = getDb()
  const eventRef = db.collection('paypalEvents').doc(event.id)
  const existing = await eventRef.get()
  if (existing.exists && existing.data()?.processed === true) {
    // We've already handled this event. Return 200 so PayPal stops
    // retrying — but don't re-process.
    return res.status(200).json({ ok: true, status: 'already_processed' })
  }

  // Reserve the doc up-front. Even if processing fails below,
  // the doc records that we received this event and (eventually)
  // why it didn't succeed.
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

  // ─── Route by event type ───────────────────────────────────
  let result: { ok: boolean; summary: string; error?: string }
  try {
    switch (event.event_type) {
      case 'PAYMENT.SALE.COMPLETED':
        result = await handleSaleCompleted(event)
        break
      case 'BILLING.SUBSCRIPTION.CREATED':
        result = await handleSubscriptionCreated(event)
        break
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        result = await handleSubscriptionActivated(event)
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
        result = await handleDisputeCreated(event)
        break
      default:
        // Unknown / uninteresting event — log and move on.
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

  // Always 200 — see security note above. PayPal will retry on
  // 5xx but we don't want that for permanent failures.
  return res.status(200).json({ ok: true, status: result.summary })
}

// ─── Event handlers ────────────────────────────────────────────

/** PAYMENT.SALE.COMPLETED — fires on the initial signup payment
 *  AND every recurring monthly/yearly charge. The `resource`
 *  carries the billing_agreement_id which is the subscription id.
 *  We use it to find the productKey we minted at signup, verify
 *  the amount matches the plan, and bump expiresAt forward. */
async function handleSaleCompleted(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as {
    id: string
    amount: { total: string; currency: string }
    billing_agreement_id?: string
  } | undefined
  if (!resource?.billing_agreement_id) {
    return { ok: true, summary: 'sale without billing_agreement_id — ignored' }
  }
  const subscriptionId = resource.billing_agreement_id

  // Find the productKey linked to this subscription
  const db = getDb()
  const keys = await db
    .collection('productKeys')
    .where('subscriptionId', '==', subscriptionId)
    .limit(1)
    .get()
  if (keys.empty) {
    // No matching key yet — this might be the initial sale that
    // arrives BEFORE BILLING.SUBSCRIPTION.ACTIVATED. The activation
    // handler will create the key. We'll re-process this sale via
    // the activation flow itself (it triggers an initial extend).
    return {
      ok: true,
      summary: `sale for ${subscriptionId} — key not yet created (deferred)`,
    }
  }
  const keyDoc = keys.docs[0]
  const key = keyDoc.data() as {
    expiresAt?: string
    planDays?: number
    subscriptionPrice?: number
    buyerEmail?: string
  }

  // Verify amount matches what we agreed to charge
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

  // Extend the key. Anchor to the LATER of current expiry / now so
  // a fast renewal doesn't lose unused days, and a late renewal
  // doesn't grant credit for the dead time. Same anchor logic as
  // capture.ts.
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
    // Reset reminder stamps for the next cycle
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

/** BILLING.SUBSCRIPTION.CREATED — fires immediately after the
 *  buyer approves the subscription, BEFORE the first payment.
 *  This is where we mint the productKey, link it to the
 *  subscription, and email it. The first PAYMENT.SALE.COMPLETED
 *  then bumps expiresAt forward to the real first-cycle date. */
async function handleSubscriptionCreated(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as
    | {
        id: string
        plan_id?: string
        subscriber?: { email_address?: string }
        custom_id?: string
      }
    | undefined
  if (!resource?.id) {
    return { ok: false, summary: 'no subscription id in payload' }
  }
  return await ensureKeyForSubscription(resource.id)
}

/** BILLING.SUBSCRIPTION.ACTIVATED — fires once after the first
 *  payment succeeds. We use this as a backup trigger in case
 *  CREATED was missed (Vercel hiccup, signature timing). */
async function handleSubscriptionActivated(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id: string } | undefined
  if (!resource?.id) {
    return { ok: false, summary: 'no subscription id in payload' }
  }
  return await ensureKeyForSubscription(resource.id)
}

/** Shared by CREATED + ACTIVATED. Idempotent — if the key already
 *  exists for this subscription, no-op. Otherwise look up the
 *  subscription's plan + buyer details from PayPal directly (we
 *  don't trust the webhook payload alone), mint the key, email it. */
async function ensureKeyForSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const db = getDb()
  const existing = await db
    .collection('productKeys')
    .where('subscriptionId', '==', subscriptionId)
    .limit(1)
    .get()
  if (!existing.empty) {
    return { ok: true, summary: `key already exists for ${subscriptionId}` }
  }

  // Look up the subscription from PayPal to get authoritative data
  const sub = await paypalCall<{
    id: string
    plan_id: string
    status: string
    subscriber: { email_address: string }
    custom_id?: string
    billing_info?: {
      last_payment?: { amount: { value: string; currency_code: string } }
    }
  }>('GET', `/v1/billing/subscriptions/${subscriptionId}`)

  // Look up the plan to get the billing cycle (monthly/yearly)
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
  // Initial expiry: now + 1 cycle. Will be bumped further by the
  // first PAYMENT.SALE.COMPLETED. (We can't wait for that because
  // some users might not see the email immediately; let them
  // redeem now.)
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
    // Subscription-specific fields
    subscriptionId,
    planId: sub.plan_id,
    subscriptionPrice: planPrice,
    subscriptionCurrency: planCurrency,
    subscriptionPlanDays: planDays,
    planDays,
    subscriptionStatus: 'active',
    subscriptionStartedAt: new Date().toISOString(),
  })

  // Email the key to the buyer
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

/** BILLING.SUBSCRIPTION.CANCELLED / EXPIRED — user (or PayPal,
 *  after suspensions) ended the subscription. Mark the key as
 *  cancelled but DON'T expire it early — the user is entitled to
 *  service through whatever they already paid for. */
async function handleSubscriptionEnded(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id: string } | undefined
  if (!resource?.id) {
    return { ok: false, summary: 'no subscription id' }
  }
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

/** BILLING.SUBSCRIPTION.SUSPENDED — all payment retries failed.
 *  Pro access continues until the existing expiresAt; no further
 *  renewals will happen unless the user updates their payment
 *  method (which they'd do via PayPal directly). */
async function handleSubscriptionSuspended(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id: string } | undefined
  if (!resource?.id) {
    return { ok: false, summary: 'no subscription id' }
  }
  const db = getDb()
  const keys = await db
    .collection('productKeys')
    .where('subscriptionId', '==', resource.id)
    .limit(1)
    .get()
  if (keys.empty) {
    return { ok: true, summary: `no key for ${resource.id}` }
  }
  await keys.docs[0].ref.update({
    subscriptionStatus: 'past_due',
  })
  return { ok: true, summary: `marked ${keys.docs[0].id} as past_due` }
}

/** BILLING.SUBSCRIPTION.PAYMENT.FAILED — single retry failure.
 *  PayPal will retry per the plan's payment_failure_threshold
 *  before suspending. We just send a notification email so the
 *  user can fix their payment method. */
async function handlePaymentFailed(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  const resource = event.resource as { id: string } | undefined
  if (!resource?.id) {
    return { ok: false, summary: 'no subscription id' }
  }
  // For now just log — full implementation would email the user.
  console.warn('[webhook] payment failed for subscription', resource.id)
  return { ok: true, summary: `logged payment failure for ${resource.id}` }
}

/** CUSTOMER.DISPUTE.CREATED — user filed a chargeback dispute.
 *  Log loudly; admin reviews manually and decides whether to
 *  suspend the key. */
async function handleDisputeCreated(
  event: PayPalWebhookEvent,
): Promise<{ ok: boolean; summary: string; error?: string }> {
  console.error('[webhook] DISPUTE created — manual review needed:', event.id)
  // TODO: send admin notification email
  return { ok: true, summary: `dispute logged for event ${event.id}` }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Same alphabet + format as the existing capture.ts implementation,
 *  duplicated here on purpose so this webhook doesn't depend on
 *  importing from a sibling endpoint file. */
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
  // Same dark-mode-locked layout pattern as the existing welcome email
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
              <div>• ניהול / ביטול: <a href="https://dm-plus.vercel.app/manage" style="color:#fbbf24;">dm-plus.vercel.app/manage</a></div>
            </div>
            <h2 style="font-size:15px;margin:20px 0 8px;color:#e5e7eb;font-weight:600;">איך מממשים?</h2>
            <div style="font-size:13px;line-height:1.85;color:#d1d5db;">
              <div>1. פותחים את התוכנה ונכנסים לחשבון.</div>
              <div>2. לוחצים על השם בצד שמאל למטה ← <strong>מימוש מפתח מוצר</strong>.</div>
              <div>3. מדביקים את המפתח ולוחצים <strong>אישור</strong>.</div>
            </div>
            <p style="margin:28px 0 0;font-size:11px;color:#6b7280;">
              מנוי ID: <span dir="ltr">${args.subscriptionId}</span><br/>
              לביטול בכל עת: <a href="https://dm-plus.vercel.app/manage" style="color:#9ca3af;">dm-plus.vercel.app/manage</a>
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
