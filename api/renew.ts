import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * Renewal endpoints — consolidated dispatcher for the legacy
 * one-shot-key renewal flow. Dispatches on `?action=...`:
 *
 *   - info    Look up a renew token from the email-reminder link
 *             so /buy can render "you're renewing X" before
 *             launching PayPal.
 *   - signin  Email+password login that returns one renewToken
 *             per redeemed key (covers users who lost the email
 *             reminder or whose key was redeemed by a different
 *             account than the buyer).
 *
 * Originally split into /api/renew/info.ts + /api/renew/signin.ts.
 * Consolidated to fit under the Vercel Hobby plan's 12-function
 * cap after the subscription endpoints were added — same dispatch
 * pattern /api/paypal.ts uses for the same reason.
 */

const RENEW_TOKEN_TTL_DAYS = 14
const EXPIRED_GRACE_DAYS = 60

interface RenewClaims {
  uid: string
  key: string
  iat: number
  exp: number
}

interface IdentityResponse {
  localId?: string
  email?: string
  error?: { code?: number; message?: string }
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
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set')
  firebaseApp = initializeApp({ credential: cert(JSON.parse(raw)) })
  return firebaseApp
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const action =
    (typeof req.query.action === 'string' ? req.query.action : '') ||
    (typeof (req.body as { action?: string })?.action === 'string'
      ? (req.body as { action: string }).action
      : '')
  try {
    switch (action) {
      case 'info':
        return await handleInfo(req, res)
      case 'signin':
        return await handleSignin(req, res)
      default:
        return res
          .status(400)
          .json({ ok: false, error: `unknown action: ${action || '(empty)'}` })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error(`[renew/${action}] failed:`, err)
    return res.status(500).json({ ok: false, error: message })
  }
}

/* ─────────────────────────────────────────────────────────────
 *  info — look up renewal info from a signed token
 * ───────────────────────────────────────────────────────────── */

async function handleInfo(req: VercelRequest, res: VercelResponse) {
  const body = req.body as { token?: string }
  const token = (body.token || '').trim()
  if (!token) return res.status(400).json({ ok: false, error: 'token חסר' })
  const claims = verifyRenewToken(token)
  if (!claims) {
    return res.status(400).json({
      ok: false,
      error: 'הקישור לא תקף או שתוקפו פג. בקשו תזכורת חדשה במייל.',
    })
  }
  const db = getFirestore(getFirebase())
  const snap = await db.collection('productKeys').doc(claims.key).get()
  if (!snap.exists) {
    return res
      .status(404)
      .json({ ok: false, error: 'המפתח לא נמצא במערכת' })
  }
  const data = snap.data() as {
    buyerEmail?: string
    redeemedByEmail?: string
    expiresAt?: string
    tier?: string
    // Read the subscription metadata so the BuyPage can decide
    // whether to lock the buyer's current plan card with a
    // "המנוי הנוכחי" badge — without these the page can't know
    // if the buyer is mid-cycle on monthly vs yearly, so it would
    // either show no lock or have to guess.
    planDays?: number
    subscriptionPlanDays?: number
    subscriptionStatus?: string
  }
  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
    return res.status(500).json({
      ok: false,
      error: 'מפתח ללא תאריך תפוגה, לא ניתן לחדש',
    })
  }
  const displayEmail = data.buyerEmail || data.redeemedByEmail || ''
  return res.status(200).json({
    ok: true,
    key: claims.key,
    keyMasked: maskKey(claims.key),
    emailMasked: maskEmail(displayEmail),
    tier: data.tier || 'pro',
    expiresAt: expiresAt.toISOString(),
    isExpired: expiresAt.getTime() < Date.now(),
    // planDays falls back through both schemas: the newer
    // `planDays` is the canonical field; older keys may have
    // only `subscriptionPlanDays` from before the field was
    // renamed. Either way the client gets a number or null.
    planDays: data.planDays || data.subscriptionPlanDays || null,
    subscriptionStatus: data.subscriptionStatus || null,
  })
}

/* ─────────────────────────────────────────────────────────────
 *  signin — self-service email+password login → list renewable keys
 * ───────────────────────────────────────────────────────────── */

async function handleSignin(req: VercelRequest, res: VercelResponse) {
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
    console.error('renew/signin auth failed', err)
    return res
      .status(502)
      .json({ ok: false, error: 'שירות ההתחברות אינו זמין כרגע. נסו שוב.' })
  }
  const db = getFirestore(getFirebase())
  const snap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', uid)
    .get()
  const now = Date.now()
  const graceCutoff = now - EXPIRED_GRACE_DAYS * 86_400_000
  const keys = snap.docs
    .map((doc) => {
      const data = doc.data() as {
        key?: string
        expiresAt?: string
        tier?: string
        blocked?: boolean
        // Subscription metadata needed by BuyPage to lock the
        // buyer's current plan card when they sign in through the
        // /buy "כבר יש לי מנוי" flow. Same fields the info handler
        // returns above — kept symmetric so the client can treat
        // both response shapes identically.
        planDays?: number
        subscriptionPlanDays?: number
        subscriptionStatus?: string
      }
      if (data.blocked) return null
      if (!data.expiresAt) return null
      const expiresMs = new Date(data.expiresAt).getTime()
      if (!Number.isFinite(expiresMs)) return null
      if (expiresMs < graceCutoff) return null
      const key = data.key || doc.id
      return {
        key,
        keyMasked: maskKey(key),
        tier: data.tier || 'pro',
        expiresAt: new Date(expiresMs).toISOString(),
        isExpired: expiresMs < now,
        renewToken: signRenewToken(uid, key),
        planDays: data.planDays || data.subscriptionPlanDays || null,
        subscriptionStatus: data.subscriptionStatus || null,
      }
    })
    .filter((k): k is NonNullable<typeof k> => k !== null)
    .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))
  return res.status(200).json({ ok: true, keys })
}

/* ─────────────────────────────────────────────────────────────
 *  Token helpers (HS256 JWT, same format as capture.ts)
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

function renewTokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  // UTF-8 bytes, not hex — see capture.ts comment for the rationale.
  return Buffer.from(s, 'utf8')
}

function signRenewToken(uid: string, key: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + RENEW_TOKEN_TTL_DAYS * 86400
  const header = b64urlEncode(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ uid, key, iat, exp })),
  )
  const signature = b64urlEncode(
    crypto
      .createHmac('sha256', renewTokenSecret())
      .update(`${header}.${payload}`)
      .digest(),
  )
  return `${header}.${payload}.${signature}`
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

function maskKey(key: string): string {
  const blocks = key.split('-')
  if (blocks.length === 0) return '••••'
  const last = blocks[blocks.length - 1]
  return `${'•••• '.repeat(blocks.length - 1).trim()}-${last}`.trim()
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return email
  if (local.length <= 1) return `${local}@${domain}`
  return `${local[0]}${'•'.repeat(Math.min(local.length - 1, 5))}@${domain}`
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
