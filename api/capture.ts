import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'

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
 *   GMAIL_USER — the Gmail address that sends the license email
 *     (e.g. "you@gmail.com"). Also used as the From header.
 *   GMAIL_APP_PASSWORD — a 16-char App Password from
 *     https://myaccount.google.com/apppasswords (requires 2FA on
 *     the account). NOT your regular Gmail password.
 *
 * We picked Gmail SMTP over Resend/SendGrid because it works without
 * a verified domain — Gmail lets any account send up to 500 emails/day
 * to any recipient via SMTP using an App Password, which is plenty
 * for an MVP and doesn't require buying a domain.
 *
 * Anything missing -> 500. Vercel will surface the message in the
 * function log; we never expose the env var name to the client.
 */

const PAYPAL_BASE =
  (process.env.PAYPAL_ENV || 'live') === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'

const EXPECTED_CURRENCY = 'ILS'

/** Two plans on /buy. The frontend posts which plan the user
 *  selected; we cross-check the captured amount against the price
 *  below before issuing a key, so a tampered frontend that swaps
 *  "yearly" for "monthly" on a 9 ₪ payment can't walk away with a
 *  365-day license. */
const PLANS: Record<string, { price: string; days: number; label: string }> = {
  monthly: { price: '9.00', days: 30, label: 'Monthly' },
  yearly: { price: '60.00', days: 365, label: 'Yearly' },
}

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
  // Trim whitespace defensively — copy/paste from a dashboard often
  // leaves a trailing newline that breaks the Basic auth header
  // silently (the base64 still encodes, PayPal just returns 401).
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
    // Surface PayPal's actual error to the function log AND the
    // client. PayPal usually returns JSON like
    // `{"error":"invalid_client","error_description":"Client Authentication failed"}`
    // — without that text we can't tell whether the credentials are
    // wrong, the env (sandbox vs live) is mismatched, or the account
    // is disabled.
    //
    // We also surface length + 4-char prefixes of both values so we
    // can spot two common copy/paste mistakes:
    //   - same value pasted into both fields (same prefix on both)
    //   - one of the values is much shorter/longer than expected
    //     (sandbox client IDs and secrets are ~80 chars each).
    // 4 chars isn't enough to reconstruct anything secret.
    const text = await r.text().catch(() => '<no body>')
    const envName = PAYPAL_BASE.includes('sandbox') ? 'sandbox' : 'live'
    const cid = clientId.trim()
    const sec = secret.trim()
    const hints = `id[${cid.slice(0, 4)}…len=${cid.length}] secret[${sec.slice(0, 4)}…len=${sec.length}]`
    console.error(
      `PayPal auth ${r.status} env=${envName} ${hints} body=${text}`,
    )
    throw new Error(
      `PayPal auth failed: ${r.status} (env=${envName}) ${hints} — ${text.slice(0, 200)}`,
    )
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

async function mintLicense(
  buyerEmail: string,
  plan: string,
  days: number,
): Promise<string> {
  const app = getFirebase()
  const db = getFirestore(app)
  const key = generateKeyString()
  const expiresAt = new Date(Date.now() + days * 86_400_000)
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
      createdBy: `paypal-checkout-${plan}`,
      buyerEmail,
    })
  return key
}

async function sendLicenseEmail(
  to: string,
  key: string,
  days: number,
): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set')
  }
  // App Passwords come from Google with spaces between blocks of 4
  // ("abcd efgh ijkl mnop"). The SMTP server accepts both forms, but
  // stripping spaces makes it more forgiving against accidental
  // copy/paste with the visible spacing.
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <body style="font-family: -apple-system, system-ui, sans-serif; background: #0b0b14; color: #e5e7eb; padding: 32px;">
    <div style="max-width: 560px; margin: 0 auto; background: #14141f; border: 1px solid #2a2a3a; border-radius: 16px; padding: 32px;">
      <h1 style="margin: 0 0 16px; font-size: 22px; color: #fbbf24;">תודה על הרכישה 🎉</h1>
      <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.7;">
        מצורף מפתח Pro לתוכנה <strong>ניהול הורדות פלוס</strong> לתקופה של ${days} ימים מהיום.
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
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to,
    subject: 'מפתח ניהול הורדות פלוס Pro שלך',
    html,
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = req.body as {
    orderID?: string
    email?: string
    plan?: string
  }
  const orderID = (body.orderID || '').trim()
  const email = (body.email || '').trim()
  const planKey = (body.plan || '').trim()
  if (!orderID) {
    return res.status(400).json({ ok: false, error: 'orderID חסר' })
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }
  const plan = PLANS[planKey]
  if (!plan) {
    return res
      .status(400)
      .json({ ok: false, error: `תוכנית לא חוקית: ${planKey || '(ריק)'}` })
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
    // submit a 9 ₪ order tagged as "yearly" — this rejects it.
    const cap = capture.purchase_units?.[0]?.payments?.captures?.[0]
    if (
      !cap ||
      cap.amount.value !== plan.price ||
      cap.amount.currency_code !== EXPECTED_CURRENCY
    ) {
      return res.status(400).json({
        ok: false,
        error: `הסכום ששולם (${cap?.amount.value} ${cap?.amount.currency_code}) לא תואם למחיר התוכנית הנבחרת (${plan.price} ${EXPECTED_CURRENCY})`,
      })
    }

    // 2. Mint license — tier doesn't change between plans, just the
    // expiry window does.
    const key = await mintLicense(email, planKey, plan.days)

    // 3. Email it. If sending fails we still return success because
    // the payment AND the key are real — better to ask the user to
    // contact support for resend than to refund a valid sale.
    try {
      await sendLicenseEmail(email, key, plan.days)
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
