import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { getDb, paypalCall } from '../_paypal'

/**
 * POST /api/subscription/session
 *
 * Login + initial-data endpoint for /manage. The buyer types their
 * Firebase account email + password; we authenticate against
 * Identity Toolkit (same pattern as /api/renew/signin) and, on
 * success, return:
 *
 *   - A short-lived session token (HS256, 1 hour, signed with the
 *     existing RENEW_TOKEN_SECRET — re-used to avoid managing
 *     another secret) that subsequent /manage actions (cancel, etc.)
 *     present back to authorise their request.
 *   - The list of the user's active or recently-active subscriptions,
 *     each with status / next billing date / locked-in price /
 *     PayPal subscription id (needed for cancel).
 *
 * Why not require the password again on every action: typing the
 * password to look at the page and then RE-typing to click "cancel"
 * is awful UX. The token model is the industry standard.
 *
 * Why not Firebase Auth's own ID tokens: those would work, but
 * they're 1-hour JWTs scoped to the whole Firebase project (any
 * other endpoint on our backend would also accept them). The
 * scoped HS256 token is narrower — it's only valid for the
 * subscription endpoints, and only for cancel actions, and only
 * for an hour. Defence in depth.
 */

export const config = {
  maxDuration: 30,
}

const SESSION_TTL_SECONDS = 60 * 60 // 1 hour

interface Body {
  email?: string
  password?: string
}

interface IdentityResponse {
  localId?: string
  email?: string
  error?: { code?: number; message?: string }
}

interface KeyDoc {
  key?: string
  tier?: string
  expiresAt?: string
  redeemedBy?: string
  redeemedByEmail?: string
  buyerEmail?: string
  blocked?: boolean
  subscriptionId?: string
  subscriptionStatus?: string
  subscriptionStartedAt?: string
  subscriptionCancelledAt?: string
  subscriptionPrice?: number
  subscriptionCurrency?: string
  subscriptionPlanDays?: number
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = (req.body || {}) as Body
  const email = (body.email || '').trim().toLowerCase()
  const password = body.password || ''
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'יש להזין אימייל וסיסמה' })
  }

  const apiKey = process.env.FIREBASE_WEB_API_KEY
  if (!apiKey) {
    console.error('FIREBASE_WEB_API_KEY not set')
    return res
      .status(500)
      .json({ ok: false, error: 'שירות ההתחברות לא מוגדר. פנו לתמיכה.' })
  }

  // 1) Authenticate against Identity Toolkit (same as /renew/signin)
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
      return res.status(401).json({
        ok: false,
        error: mapAuthError(auth.error?.message),
      })
    }
    uid = auth.localId
  } catch (err) {
    console.error('subscription/session auth failed', err)
    return res
      .status(502)
      .json({ ok: false, error: 'שירות ההתחברות אינו זמין כרגע. נסו שוב.' })
  }

  // 2) Look up the user's productKeys. We return only those
  //    linked to a subscription — one-shot purchases aren't
  //    "manageable" (nothing to cancel).
  try {
    const db = getDb()
    const snap = await db
      .collection('productKeys')
      .where('redeemedBy', '==', uid)
      .get()
    const subs = snap.docs
      .map((doc) => doc.data() as KeyDoc)
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
        cycleLabel:
          (k.subscriptionPlanDays || 30) === 30 ? 'חודשי' : 'שנתי',
      }))
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))

    // Also pull in unredeemed keys that match this email's buyer
    // — these are subscriptions where PayPal completed but the user
    // hasn't yet redeemed in the app. They CAN still cancel them
    // (e.g. they regret subscribing before even using it).
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

    // 3) Issue a session token covering ALL the listed subscription
    //    ids. The cancel endpoint verifies the requested
    //    subscriptionId is in the token's allow-list — prevents a
    //    user with one token from cancelling someone else's sub
    //    by guessing the subscription id.
    const token = signSessionToken({
      uid,
      email,
      subscriptionIds: subs.map((s) => s.subscriptionId),
    })

    return res.status(200).json({
      ok: true,
      token,
      email,
      subscriptions: subs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('subscription/session lookup failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

// ─── Token utilities (shared with cancel.ts via duplication ─────
// to keep each Vercel function self-contained — see capture.ts
// for the same pattern and rationale.)

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function tokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  return Buffer.from(s, 'hex')
}

interface SessionClaims {
  uid: string
  email: string
  subscriptionIds: string[]
  iat: number
  exp: number
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

// Exported for cancel.ts (re-used via direct file import). Keeps
// the token format in one place even though each endpoint also
// has its own verifier copy (defence-in-depth).
export { paypalCall, getDb }
