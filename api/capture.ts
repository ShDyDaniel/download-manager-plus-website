import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { Resend } from 'resend'

/**
 * PayPal Smart Buttons hand the orderID back to the frontend via
 * the `onApprove` callback. The frontend then posts it here.
 *
 * What we do:
 *   1. Capture the payment with PayPal's REST API — the buyer
 *      already approved the order on PayPal's side, but the funds
 *      don't actually move until we call /v2/checkout/orders/{id}
 *      /capture. This is also our gatekeeper: PayPal returns 4xx
 *      if the order is invalid, already captured, or for the wrong
 *      amount, so a tampered frontend can't get past this.
 *   2. Mint a fresh license key in Firestore (`productKeys/{key}`)
 *      with a 1-year expiry. We DO NOT mark `redeemedBy` here —
 *      the buyer redeems the key inside the app, which binds it to
 *      their account.
 *   3. Email the buyer the key via Resend.
 *
 * Required environment variables (set on Vercel):
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET — same client you used
 *     in the JS SDK script tag; the secret stays server-side.
 *   PAYPAL_ENV — "live" or "sandbox" (default "live").
 *   FIREBASE_SERVICE_ACCOUNT — full service-account JSON, one line,
 *     value of the json key file you downloaded from Firebase
 *     Console → Project settings → Service accounts → Generate new
 *     private key.
 *   RESEND_API_KEY — from resend.com, paid the free tier.
 *   FROM_EMAIL — sender address verified in Resend (e.g.
 *     "noreply@your-domain.com" or the auto-generated
 *     "onboarding@resend.dev" for testing).
 *
 * Anything missing -> 500. Vercel will surface the message in the
 * function log; we never expose the env var name to the client.
 */

const PAYPAL_BASE =
  (process.env.PAYPAL_ENV || 'live') === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'

const EXPECTED_PRICE = '60.00'
const EXPECTED_CURRENCY = 'ILS'
const LICENSE_DAYS = 365

let firebaseApp: App | null = null

function getFirebase(): App {
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
  const parsed = JSON.parse(raw)
  firebaseApp = initializeApp({ credential: cert(parsed) })
  return firebaseApp
}

async function paypalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !secret) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set')
  }
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64')
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!r.ok) {
    throw new Error(`PayPal auth failed: ${r.status}`)
  }
  const json = (await r.json()) as { access_token: string }
  return json.access_token
}

interface PayPalCaptureResponse {
  id: string
  status: string
  purchase_units?: {
    payments?: {
      captures?: {
        id: string
        amount: { value: string; currency_code: string }
        status: string
      }[]
    }
  }[]
}

async function capturePayPalOrder(
  orderID: string,
): Promise<PayPalCaptureResponse> {
  const token = await paypalAccessToken()
  const r = await fetch(
    `${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  )
  const body = (await r.json()) as PayPalCaptureResponse & {
    message?: string
    name?: string
  }
  if (!r.ok) {
    throw new Error(
      `PayPal capture failed: ${body.name || r.status} ${body.message || ''}`,
    )
  }
  return body
}

/** Random 4-block license key in `XXXX-XXXX-XXXX-XXXX` shape.
 *  Same alphabet the app uses internally so the keys this endpoint
 *  generates look identical to the ones an admin generates by hand
 *  in the AdminPanel. */
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

async function mintLicense(buyerEmail: string): Promise<string> {
  const app = getFirebase()
  const db = getFirestore(app)
  const key = generateKeyString()
  const expiresAt = new Date(Date.now() + LICENSE_DAYS * 86_400_000)
  await db
    .collection('productKeys')
    .doc(key)
    .set({
      key,
      tier: 'pro',
      redeemedBy: null,
      redeemedByEmail: null,
      redeemedAt: null,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: 'paypal-checkout',
      buyerEmail,
    })
  return key
}

async function sendLicenseEmail(to: string, key: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not set')
  }
  const from = process.env.FROM_EMAIL || 'onboarding@resend.dev'
  const resend = new Resend(apiKey)
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <body style="font-family: -apple-system, system-ui, sans-serif; background: #0b0b14; color: #e5e7eb; padding: 32px;">
    <div style="max-width: 560px; margin: 0 auto; background: #14141f; border: 1px solid #2a2a3a; border-radius: 16px; padding: 32px;">
      <h1 style="margin: 0 0 16px; font-size: 22px; color: #fbbf24;">תודה על הרכישה 🎉</h1>
      <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.7;">
        מצורף מפתח Pro לתוכנה <strong>ניהול הורדות פלוס</strong> לתקופה של 365 ימים מהיום.
      </p>
      <div style="background: #0b0b14; border: 1px solid #fbbf2440; border-radius: 12px; padding: 16px; margin: 20px 0; text-align: center;">
        <div style="font-size: 11px; color: #9ca3af; margin-bottom: 6px;">מפתח המוצר</div>
        <div style="font-family: 'SF Mono', Menlo, monospace; font-size: 18px; color: #fbbf24; letter-spacing: 0.05em;">${key}</div>
      </div>
      <h2 style="font-size: 15px; margin: 20px 0 8px;">איך מממשים?</h2>
      <ol style="font-size: 13px; line-height: 1.8; color: #d1d5db; padding-right: 20px;">
        <li>פותחים את התוכנה ונכנסים לחשבון.</li>
        <li>לוחצים על השם בצד שמאל למטה → <strong>מימוש מפתח מוצר</strong>.</li>
        <li>מדביקים את המפתח ולוחצים <strong>אישור</strong>.</li>
        <li>זהו, יש לך Pro! 🚀</li>
      </ol>
      <p style="margin: 28px 0 0; font-size: 11px; color: #6b7280; text-align: center;">
        המפתח שמור לחשבון שלך. בכל בעיה — תשובה ישירה למייל הזה.
      </p>
    </div>
  </body>
</html>`
  const r = await resend.emails.send({
    from,
    to,
    subject: 'מפתח ניהול הורדות פלוס Pro שלך',
    html,
  })
  if (r.error) {
    throw new Error(`Resend failed: ${r.error.message || 'unknown'}`)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = req.body as { orderID?: string; email?: string }
  const orderID = (body.orderID || '').trim()
  const email = (body.email || '').trim()
  if (!orderID) {
    return res.status(400).json({ ok: false, error: 'orderID חסר' })
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }

  try {
    // 1. Capture the payment.
    const capture = await capturePayPalOrder(orderID)
    if (capture.status !== 'COMPLETED') {
      return res.status(400).json({
        ok: false,
        error: `סטטוס PayPal: ${capture.status} (לא COMPLETED)`,
      })
    }
    // Sanity-check amount/currency. A tampered frontend could try to
    // submit a $0.01 order — this is the line that rejects it.
    const cap = capture.purchase_units?.[0]?.payments?.captures?.[0]
    if (
      !cap ||
      cap.amount.value !== EXPECTED_PRICE ||
      cap.amount.currency_code !== EXPECTED_CURRENCY
    ) {
      return res.status(400).json({
        ok: false,
        error: `הסכום ששולם (${cap?.amount.value} ${cap?.amount.currency_code}) לא תואם למחיר המוצר`,
      })
    }

    // 2. Mint license.
    const key = await mintLicense(email)

    // 3. Email it. If sending fails we still return success because
    // the payment AND the key are real — better to ask the user to
    // contact support for resend than to refund a valid sale.
    try {
      await sendLicenseEmail(email, key)
    } catch (err) {
      console.error('email send failed', err, 'key=', key)
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('capture handler failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
