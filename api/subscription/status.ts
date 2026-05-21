import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { getDb } from '../_paypal'

/**
 * POST /api/subscription/status
 *
 * Refresh the subscriptions list for an already-authenticated user
 * WITHOUT requiring them to re-enter their password. Takes a session
 * token issued by /api/subscription/session, returns the same shape
 * of subscription data — with whatever the current Firestore state
 * is (so cancellations / renewals are reflected).
 *
 * Used by /manage after a cancel action to refresh the page, and on
 * route mount if the user navigated away and came back within the
 * 1-hour token TTL.
 *
 * Note: we trust the token's allow-list of subscription ids — we
 * only return subscriptions that were on the list when the token
 * was issued. If a user's subscription situation changes (e.g.
 * a new subscription is created), they'll need to sign in again
 * to pick it up. This is a deliberate scope limitation, not a bug.
 */

export const config = {
  maxDuration: 15,
}

interface Body {
  token?: string
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
  expiresAt?: string
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
  const token = (body.token || '').trim()
  if (!token) {
    return res.status(400).json({ ok: false, error: 'חסר סשן' })
  }
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

  try {
    const db = getDb()
    // Firestore "in" supports up to 30 values per query — more than
    // enough for any realistic per-user subscription count.
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
        cycleLabel:
          (k.subscriptionPlanDays || 30) === 30 ? 'חודשי' : 'שנתי',
      }
    })

    return res
      .status(200)
      .json({ ok: true, email: claims.email, subscriptions: subs })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('subscription/status failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

// ─── Token verification (mirrors session.ts signer) ───────────

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
