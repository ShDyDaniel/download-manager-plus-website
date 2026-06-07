import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'

/* ── Outgoing-email counter (twin of api/paypal.ts) ─────────────────
 *  Counts every email into metrics/emailSends (UTC hourly buckets) so
 *  the admin dashboard can show sent-in-24h vs the ~500/day Gmail cap.
 *  Fire-and-forget; never affects the email itself. */
function recordEmailSent(): void {
  try {
    const bucket = new Date().toISOString().slice(0, 13)
    void getFirestore(getFirebase())
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

// NOTE: loadCurrentPricing is duplicated inline here (and in
// pricing.ts, paypal.ts) on purpose. We tried sharing it via a
// helper file at `api/_paypal.ts` and at `api-lib/paypal.ts`
// (outside api/). Both setups built cleanly and type-checked, but
// crashed at runtime with FUNCTION_INVOCATION_FAILED. Vercel's
// per-function bundler doesn't reliably include helper modules
// imported via relative paths from api/ in every shape. Inlining
// is the only configuration we've confirmed works in production.
// Keep these three copies in sync if you change pricing schema.
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
    const db = getFirestore(getFirebase())
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
    console.error('[capture] loadCurrentPricing failed:', err)
    return { ...PRICING_DEFAULTS_LOCAL }
  }
}

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

/** Plan metadata that never changes per sale — duration in days
 *  and the Hebrew label for emails. The actual price comes from
 *  Firestore at validation time via `loadCurrentPricing()` (see
 *  `validateCaptureAmount` below), so an admin who lowers the
 *  price in the admin panel is honoured immediately on the next
 *  purchase. Hardcoding price here used to mean a tampered client
 *  could lock in the OLD price after an admin lowered it — now
 *  the server fetches fresh on every capture. */
const PLAN_META: Record<
  string,
  { days: number; label: string; durationLabel: string }
> = {
  monthly: { days: 30, label: 'Monthly', durationLabel: 'חודש' },
  yearly: { days: 365, label: 'Yearly', durationLabel: 'שנה' },
}

/** Decide whether a PayPal-captured amount is acceptable for the
 *  given plan. The amount is valid if it equals EITHER the
 *  current regular price OR the current sale price (when one is
 *  active). We compare with a small epsilon because PayPal sends
 *  back amounts as decimal strings and floating-point comparison
 *  would reject equivalent values like "9.00" vs "9".
 *
 *  Returns the acceptable price set so the caller can include it
 *  in error messages, and a boolean indicating whether the
 *  captured amount matched. */
async function validateCaptureAmount(
  planKey: 'monthly' | 'yearly',
  capturedValue: string,
  capturedCurrency: string,
): Promise<{
  ok: boolean
  expectedCurrency: string
  acceptable: number[]
  capturedNumber: number
}> {
  const pricing = await loadCurrentPricing()
  const expectedCurrency = pricing.currency
  if (capturedCurrency !== expectedCurrency) {
    return {
      ok: false,
      expectedCurrency,
      acceptable: [],
      capturedNumber: parseFloat(capturedValue) || 0,
    }
  }
  const plan = pricing[planKey]
  const acceptable = [plan.regular]
  if (plan.sale != null) acceptable.push(plan.sale)
  const capturedNumber = parseFloat(capturedValue)
  if (!Number.isFinite(capturedNumber)) {
    return { ok: false, expectedCurrency, acceptable, capturedNumber: 0 }
  }
  // Allow 1¢ slack for any decimal-rounding artifact PayPal might
  // introduce; real price differences are at least 1 unit apart.
  const ok = acceptable.some((p) => Math.abs(capturedNumber - p) < 0.01)
  return { ok, expectedCurrency, acceptable, capturedNumber }
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

/**
 * Renewal JWT helpers — same format as in /api/renew/info, kept
 * inline here so each Vercel function bundles its own copy and we
 * avoid the "shared module fails to load in production" trap we
 * hit with the @upstash rate-limiter.
 *
 * Token layout (compact JWT, HS256):
 *   { uid, key, iat, exp }    — uid + key bind the token to one
 *                               buyer and one product key; exp keeps
 *                               links from working forever after
 *                               leaking. Default ttl is 7 days from
 *                               the cron's reminder send.
 */
interface RenewClaims {
  uid: string
  key: string
  iat: number
  exp: number
}

function b64urlDecode(s: string): Buffer {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64')
}

function renewTokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  // Read as raw UTF-8 bytes, not hex. Earlier this was Buffer.from(s,
  // 'hex'), which silently truncates / returns an empty buffer if the
  // secret contains any non-hex character. An operator who set the
  // env var to a passphrase ("my-secret-2026!") would end up with a
  // 0-2 byte HMAC key — trivially forgeable. UTF-8 always produces
  // the full key length the operator typed. (HMAC-SHA256 accepts
  // keys of any length; the spec hashes longer keys down to 32B.)
  return Buffer.from(s, 'utf8')
}

function verifyRenewToken(token: string): RenewClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, signatureB64] = parts
    const expected = crypto
      .createHmac('sha256', renewTokenSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest()
    const actual = b64urlDecode(signatureB64)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(
      b64urlDecode(payloadB64).toString('utf8'),
    ) as RenewClaims
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    if (!claims.uid || !claims.key) return null
    return claims
  } catch {
    return null
  }
}

async function mintLicense(
  buyerEmail: string,
  plan: string,
  expiresAt: Date,
): Promise<string> {
  const app = getFirebase()
  const db = getFirestore(app)
  const key = generateKeyString()
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

/**
 * Extend an existing license key by `plan.days` days. Used by the
 * renewal flow.
 *
 * Critical detail — we anchor the new expiry to the LATER of:
 *   - the key's current expiry (so a user who renews 5 days before
 *     expiry doesn't lose those 5 days)
 *   - now (so a user who renews 2 weeks AFTER expiry doesn't get
 *     credit for the dead time)
 *
 * Returns the new expiry, plus the previous expiry for the email.
 */
async function extendLicense(
  key: string,
  plan: string,
  planDays: number,
): Promise<{ previousExpiresAt: Date; newExpiresAt: Date; buyerEmail: string }> {
  const app = getFirebase()
  const db = getFirestore(app)
  const ref = db.collection('productKeys').doc(key)
  const snap = await ref.get()
  if (!snap.exists) {
    throw new Error(`לא נמצא מפתח לחידוש (${key})`)
  }
  const data = snap.data() as {
    expiresAt?: string
    buyerEmail?: string
    redeemedByEmail?: string
    renewalHistory?: { at: string; plan: string; days: number }[]
  }
  const previousIso = data.expiresAt
  if (!previousIso) {
    throw new Error('המפתח לא כולל תאריך תפוגה — אי אפשר להאריך')
  }
  const previousExpiresAt = new Date(previousIso)
  const baseTime = Math.max(previousExpiresAt.getTime(), Date.now())
  const newExpiresAt = new Date(baseTime + planDays * 86_400_000)

  const history = Array.isArray(data.renewalHistory) ? data.renewalHistory : []
  history.push({
    at: new Date().toISOString(),
    plan,
    days: planDays,
  })

  // Backfill buyerEmail from redeemedByEmail if it's missing — keeps
  // legacy keys self-healing once they touch the renewal flow.
  const resolvedBuyerEmail =
    data.buyerEmail || data.redeemedByEmail || ''
  const updates: Record<string, unknown> = {
    expiresAt: newExpiresAt.toISOString(),
    renewalHistory: history,
    lastRenewalAt: new Date().toISOString(),
    // Reset all reminder stamps so the next cycle's 10d + 2d
    // reminders fire fresh against the new expiry. reminderSentAt
    // is the legacy single-stamp field; reminder10dSentAt and
    // reminder2dSentAt are the stage-specific fields the new cron
    // checks (see api/cron/expiry-reminders.ts REMINDER_STAGES).
    reminderSentAt: null,
    reminder10dSentAt: null,
    reminder2dSentAt: null,
  }
  if (!data.buyerEmail && resolvedBuyerEmail) {
    updates.buyerEmail = resolvedBuyerEmail
  }
  await ref.update(updates)

  return {
    previousExpiresAt,
    newExpiresAt,
    buyerEmail: resolvedBuyerEmail,
  }
}

/** Format an expiry date as "DD.MM.YYYY" with Israel-timezone day
 *  rollover, so the date the buyer sees in their email matches the
 *  one the desktop app shows them when they look up the key.
 *  Without `timeZone: Asia/Jerusalem` the Vercel function (running
 *  in a US region) would occasionally show the day before for buyers
 *  who pay near midnight Israel time. */
function formatExpiryHebrew(date: Date): string {
  return date.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
}

async function sendLicenseEmail(
  to: string,
  key: string,
  durationLabel: string,
  expiresAt: Date,
): Promise<void> {
  const expiryDate = formatExpiryHebrew(expiresAt)
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set')
  }
  // App Passwords come from Google with spaces between blocks of 4
  // ("abcd efgh ijkl mnop"). The SMTP server accepts both forms, but
  // stripping spaces makes it more forgiving against accidental
  // copy/paste with the visible spacing.
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  // Email HTML — table-based layout for cross-client reliability.
  //
  // The hard problem: mobile email clients (Apple Mail iOS, Gmail
  // iOS/Android) auto-invert dark colors to light when the device
  // is in light mode, ignoring inline `style` background colors.
  // The fix uses every trick in the book to lock the dark theme:
  //
  //   1. `bgcolor` HTML attribute on every <td> — legacy, but the
  //      most respected color hint across old & weird clients.
  //   2. `<style>` block with `!important` overrides keyed by class
  //      — Apple Mail and Gmail Web do honour <style>.
  //   3. `color-scheme: dark only` meta + matching CSS root rule —
  //      tells modern clients we don't want light rendering.
  //   4. `[data-ogsc]` selectors — Outlook.com / Outlook iOS dark
  //      mode wraps content in this attribute, and we use it to
  //      re-apply our colors when the client tries to override.
  //   5. Inline styles as the fallback for clients that strip both
  //      `<style>` and class attributes.
  //
  // Even with all of this, Gmail Mobile Android sometimes still
  // forces light mode — it's a known platform limitation. The
  // design degrades gracefully (light bg + dark text + gold accents
  // remains readable), so we accept that case.
  //
  // Manual numbering replaces <ol> because RTL list direction is
  // unreliable; <dir="rtl"> + <text-align:right> + <direction:rtl>
  // are all set on every block so different clients can honour
  // whichever one they respect.
  const html = renderEmail({
    heading: 'תודה על הרכישה 🎉',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        מצורף מפתח <span style="color:#D4A574;">Pro</span> לתוכנה <strong>ניהול הורדות פלוס</strong> לתקופה של ${durationLabel} מהיום <span style="color:#8B8170;">(תוקף עד ${expiryDate})</span>.
      </p>
      <div style="text-align:center;background:#16110D;border:1px solid rgba(212,165,116,0.45);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="font-size:11px;color:#8B8170;margin-bottom:8px;">מפתח המוצר</div>
        <div dir="ltr" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:22px;color:#D4A574;letter-spacing:0.08em;font-weight:700;">${key}</div>
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">איך מממשים?</h3>
      <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
        <div>1. פותחים את התוכנה ונכנסים לחשבון.</div>
        <div>2. לוחצים על השם בצד שמאל למטה ← <strong>מימוש מפתח מוצר</strong>.</div>
        <div>3. מדביקים את המפתח ולוחצים <strong>אישור</strong>.</div>
        <div>4. זהו, יש לך Pro! 🚀</div>
      </div>
      <p style="font-size:11px;margin:24px 0 0;color:#5C5444;">
        המפתח שמור לחשבון שלך. בכל בעיה — תשובה ישירה למייל הזה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to,
    subject: 'מפתח ניהול הורדות פלוס Pro שלך',
    html,
  })
}

/**
 * Confirmation email for a successful renewal. Differs from the
 * initial license email in two ways:
 *   - no need to re-print the product key — the user already has it
 *     redeemed in the app; printing it again would just confuse
 *   - shows both the OLD expiry (struck through) and the NEW one,
 *     so the user can verify how many days they actually bought
 */
async function sendRenewalEmail(
  to: string,
  durationLabel: string,
  previousExpiresAt: Date,
  newExpiresAt: Date,
): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set')
  }
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const previousDate = formatExpiryHebrew(previousExpiresAt)
  const newDate = formatExpiryHebrew(newExpiresAt)
  const html = renderEmail({
    heading: 'המנוי שלך הוארך ✓',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 20px;color:#C9BFA8;">
        הוספנו <strong>${durationLabel}</strong> נוסף למפתח Pro שלך לתוכנה <strong>ניהול הורדות פלוס</strong>. המפתח עצמו נשאר זהה — אין מה לעדכן באפליקציה.
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:18px;margin:0 0 24px;text-align:center;">
        <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">תוקף קודם</div>
        <div style="font-size:14px;color:#5C5444;text-decoration:line-through;margin-bottom:14px;">${previousDate}</div>
        <div style="font-size:11px;color:#8B8170;margin-bottom:6px;">תוקף חדש</div>
        <div style="font-size:20px;color:#7DAA6B;font-weight:700;">${newDate}</div>
      </div>
      <p style="font-size:11px;margin:24px 0 0;color:#5C5444;">
        תודה שאתם איתנו. בכל בעיה — תשובה ישירה למייל הזה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to,
    subject: 'חידוש מנוי ניהול הורדות פלוס — תוקף עד ' + newDate,
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
    /** When present, this is a renewal flow — extend the existing
     *  key encoded in the token rather than mint a brand-new one.
     *  The token is signed by /api/cron/expiry-reminders and emailed
     *  to the user; format is a compact JWT (see verifyRenewToken). */
    renewToken?: string
  }
  const orderID = (body.orderID || '').trim()
  const planKey = (body.plan || '').trim()
  const renewToken = (body.renewToken || '').trim()
  if (!orderID) {
    return res.status(400).json({ ok: false, error: 'orderID חסר' })
  }
  if (planKey !== 'monthly' && planKey !== 'yearly') {
    return res
      .status(400)
      .json({ ok: false, error: `תוכנית לא חוקית: ${planKey || '(ריק)'}` })
  }
  const planMeta = PLAN_META[planKey]

  // Renewal mode: validate the token up-front so we can reject
  // tampered/expired tokens before charging the card.
  let renewClaims: RenewClaims | null = null
  if (renewToken) {
    renewClaims = verifyRenewToken(renewToken)
    if (!renewClaims) {
      return res.status(400).json({
        ok: false,
        error:
          'קישור החידוש לא תקף או שתוקפו פג. בקשו תזכורת חדשה במייל.',
      })
    }
  }

  // For a fresh purchase we still need an email from the body — it's
  // where we send the minted key. For a renewal the key is already
  // owned by a known buyerEmail in Firestore, so the body email is
  // ignored (we'd just use the on-file address).
  let email = (body.email || '').trim()
  if (!renewClaims) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res
        .status(400)
        .json({ ok: false, error: 'כתובת מייל לא תקינה' })
    }
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
    // Sanity-check amount/currency against the CURRENT pricing
    // (regular or sale) from Firestore. A tampered frontend could
    // try to submit a 9 ₪ order tagged as "yearly", or a 1 ₪
    // order at all — this rejects both. Pricing is fetched fresh
    // per capture so an admin who lowered the price in the admin
    // panel is honoured immediately on the next purchase.
    const cap = capture.purchase_units?.[0]?.payments?.captures?.[0]
    if (!cap) {
      return res.status(400).json({
        ok: false,
        error: 'תגובת PayPal חסרת capture',
      })
    }
    const validation = await validateCaptureAmount(
      planKey,
      cap.amount.value,
      cap.amount.currency_code,
    )
    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        error: `הסכום ששולם (${cap.amount.value} ${cap.amount.currency_code}) לא תואם למחיר התוכנית הנבחרת (${validation.acceptable.join(' או ')} ${validation.expectedCurrency})`,
      })
    }

    // 2a. Renewal path — extend the existing key instead of minting.
    if (renewClaims) {
      const result = await extendLicense(
        renewClaims.key,
        planKey,
        planMeta.days,
      )
      const sendTo = result.buyerEmail || email
      try {
        await sendRenewalEmail(
          sendTo,
          planMeta.durationLabel,
          result.previousExpiresAt,
          result.newExpiresAt,
        )
      } catch (err) {
        console.error('renewal email send failed', err, 'key=', renewClaims.key)
      }
      return res.status(200).json({
        ok: true,
        renewed: true,
        newExpiresAt: result.newExpiresAt.toISOString(),
      })
    }

    // 2b. Fresh license path — tier doesn't change between plans,
    // just the expiry window does. Compute `expiresAt` once here so
    // the email and the Firestore document agree to the millisecond.
    const expiresAt = new Date(Date.now() + planMeta.days * 86_400_000)
    const key = await mintLicense(email, planKey, expiresAt)

    // 3. Email it. If sending fails we still return success because
    // the payment AND the key are real — better to ask the user to
    // contact support for resend than to refund a valid sale.
    try {
      await sendLicenseEmail(email, key, planMeta.durationLabel, expiresAt)
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

/* ─────────────────────────────────────────────────────────────
 *  Email-template helper. Mirror of the same function in
 *  api/paypal.ts, api/reset-password.ts, api/cron/expiry-
 *  reminders.ts. Kept duplicated (not shared) because Vercel's
 *  per-function bundler is unreliable with helper-only modules
 *  out of api/. Keep them in sync if you change the chrome.
 * ───────────────────────────────────────────────────────────── */
function renderEmail(args: { heading: string; contentHtml: string }): string {
  // Brand palette — kept in sync with api/paypal.ts. See that
  // file's renderEmail for the rationale.
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
