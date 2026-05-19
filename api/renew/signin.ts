import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * Self-service renewal: a buyer who already has an account types
 * their email + password on /buy, we authenticate against Firebase,
 * look up every productKey they've redeemed, and hand back one
 * signed renewToken per key. The BuyPage then walks them through
 * exactly the same renewal UI the email-reminder link uses.
 *
 * Why a separate path from the email link:
 *   - the email link works only if the buyer can find the email and
 *     it hasn't expired (14d TTL).
 *   - buyers whose key was bought-then-redeemed-by-someone-else
 *     can't use the email flow at all (the email went to the
 *     original buyer, but only the redeemer can renew their own
 *     key cycle).
 *   - some buyers just lose the email.
 *
 * Security:
 *   - Auth happens against Firebase Identity Toolkit using the
 *     public Web API key (same key the desktop app embeds — it's
 *     designed to be public; the actual gate is the password).
 *   - We do NOT echo the unmasked key to the wire. Renewal goes
 *     through the renewToken (HS256, server-signed), so even if a
 *     network observer scraped the response they couldn't forge
 *     a renew of a key they didn't already own.
 *   - We only return keys redeemed by the authenticated uid — never
 *     keys the user merely *purchased* (buyerEmail-only). That'd
 *     leak the existence of a key to anyone who knew the buyer's
 *     password but wasn't the redeemer.
 */

const RENEW_TOKEN_TTL_DAYS = 14
/** How far past expiry we still surface a key. Lets recently-lapsed
 *  users renew without bouncing through "buy new" — the capture
 *  endpoint anchors the new term at max(currentExpiry, now), so the
 *  user isn't billed for the lapsed gap. */
const EXPIRED_GRACE_DAYS = 60

// ----- JWT (sign) ----------------------------------------------------

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function renewTokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  return Buffer.from(s, 'hex')
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

// ----- Firebase ------------------------------------------------------

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

// ----- Helpers -------------------------------------------------------

function maskKey(key: string): string {
  const blocks = key.split('-')
  if (blocks.length === 0) return '••••'
  const last = blocks[blocks.length - 1]
  return `${'•••• '.repeat(blocks.length - 1).trim()}-${last}`.trim()
}

interface IdentityResponse {
  localId?: string
  email?: string
  error?: { code?: number; message?: string }
}

/** Map Firebase Identity Toolkit error codes to Hebrew copy. */
function authErrorMessage(code: string | undefined): string {
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

// ----- Handler -------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = req.body as { email?: string; password?: string }
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

  // 1) Authenticate against Firebase Identity Toolkit.
  let uid: string
  try {
    const authRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(
        apiKey,
      )}`,
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
        error: authErrorMessage(auth.error?.message),
      })
    }
    uid = auth.localId
  } catch (err) {
    console.error('signInWithPassword failed', err)
    return res
      .status(502)
      .json({ ok: false, error: 'שירות ההתחברות אינו זמין כרגע. נסו שוב.' })
  }

  // 2) Look up every productKey this user has redeemed.
  try {
    const app = getFirebase()
    const db = getFirestore(app)
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
        }
        if (data.blocked) return null
        if (!data.expiresAt) return null
        const expiresMs = new Date(data.expiresAt).getTime()
        if (!Number.isFinite(expiresMs)) return null
        // Drop ancient lapsed keys — those buyers should buy fresh.
        if (expiresMs < graceCutoff) return null
        const key = data.key || doc.id
        return {
          key,
          keyMasked: maskKey(key),
          tier: data.tier || 'pro',
          expiresAt: new Date(expiresMs).toISOString(),
          isExpired: expiresMs < now,
          renewToken: signRenewToken(uid, key),
        }
      })
      .filter((k): k is NonNullable<typeof k> => k !== null)
      // Newest expiry first — the most recently-active license is
      // almost always the one the user actually wants to renew.
      .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))

    return res.status(200).json({ ok: true, keys })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('renew/signin lookup failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
