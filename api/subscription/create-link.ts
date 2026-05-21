import type { VercelRequest, VercelResponse } from '@vercel/node'
import { syncPlansForPricing, paypalCall, getDb } from '../_paypal'
import { loadCurrentPricing } from '../pricing'

/**
 * POST /api/subscription/create-link
 *
 * Server-side subscription creator. This is the security-critical
 * piece — the client tells us WHICH PLAN ("monthly" | "yearly")
 * they want, NOTHING ELSE. The server picks the correct plan_id
 * based on the current pricing doc (regular or sale), creates the
 * subscription via PayPal API, and returns the approval URL.
 *
 * What we DON'T accept from the client:
 *   - plan_id     — could be substituted with an old/cheaper plan
 *   - amount      — Subscriptions API ignores this anyway, but extra
 *                   defence-in-depth
 *   - any other PayPal field that affects price
 *
 * Result: the price the user actually pays is 100% determined by
 * what's in `appConfig/pricing` right now. A tampered client can't
 * subscribe at a stale sale price after the sale ends, or at a
 * fraction of the real price.
 *
 * Body shape:
 *   { plan: "monthly" | "yearly", email: string }
 *
 * The `email` is the buyer's email — used as the PayPal subscriber
 * email AND to link the resulting subscription to the user's account
 * (the webhook will create a productKey for them and mail it to
 * this address).
 *
 * Returns:
 *   { ok: true, approvalUrl: string, subscriptionId: string }
 *
 * The renderer redirects the user to approvalUrl. After they
 * approve, PayPal sends BILLING.SUBSCRIPTION.CREATED to our
 * webhook, which mints the productKey and emails it.
 */

export const config = {
  maxDuration: 30,
}

const WEBSITE_BASE = 'https://dm-plus.vercel.app'

interface Body {
  plan?: 'monthly' | 'yearly'
  email?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = (req.body || {}) as Body
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

  try {
    // ─── Pick the right plan_id ────────────────────────────
    // Pricing is the single source of truth. If a sale price exists
    // for the requested plan, that's the locked-in price the buyer
    // gets for the lifetime of their subscription (grandfathered
    // pricing — see docs/comments in BuyPage / pricing.ts).
    const pricing = await loadCurrentPricing()
    const usingSale = pricing[plan].sale != null
    const lockedPrice = usingSale ? pricing[plan].sale! : pricing[plan].regular

    // syncPlansForPricing is idempotent — if Plans already exist
    // for these prices, they're reused; otherwise new ones are
    // created in PayPal and persisted to Firestore. This lazy
    // bootstrap means the very first subscription request after a
    // deploy doesn't fail because Plans haven't been pre-set up.
    const plans = await syncPlansForPricing(pricing)
    const planId = pickPlanId(plans, plan, usingSale)
    if (!planId) {
      return res
        .status(500)
        .json({ ok: false, error: 'תצורת תוכנית לא תקינה — נסה שוב' })
    }

    // ─── Create the subscription in PayPal ─────────────────
    const subscription = await paypalCall<{
      id: string
      status: string
      links: Array<{ rel: string; href: string; method: string }>
    }>('POST', '/v1/billing/subscriptions', {
      plan_id: planId,
      subscriber: {
        email_address: email,
      },
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

    // Log the pending subscription so we have an audit trail even
    // before the webhook fires. Used by /manage to show "your
    // subscription is pending PayPal confirmation" if the user
    // hits manage immediately.
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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('[subscription/create-link] failed:', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

function pickPlanId(
  plans: {
    monthlyRegularPlanId: string
    monthlySalePlanId: string | null
    yearlyRegularPlanId: string
    yearlySalePlanId: string | null
  },
  plan: 'monthly' | 'yearly',
  usingSale: boolean,
): string | null {
  if (plan === 'monthly') {
    return usingSale ? plans.monthlySalePlanId : plans.monthlyRegularPlanId
  }
  return usingSale ? plans.yearlySalePlanId : plans.yearlyRegularPlanId
}
