import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { getDb, paypalCall } from '../_paypal'

/**
 * POST /api/subscription/cancel
 *
 * Cancel a PayPal subscription. The current paid period stays
 * valid (key.expiresAt is not modified); the cancellation only
 * stops the NEXT auto-charge. This is the standard SaaS pattern
 * and complies with the Israeli consumer-protection requirement
 * that cancellation takes effect within 3 business days (PayPal's
 * cancel API is effectively instant).
 *
 * Body: { token: string, subscriptionId: string, reason?: string }
 *
 * The `token` comes from /api/subscription/session — it carries
 * the user's uid AND the allow-list of subscription ids they own.
 * We verify the token, verify the requested subscriptionId is in
 * the allow-list, then call PayPal's cancel endpoint.
 *
 * Defence-in-depth: even if a token could somehow be forged, we
 * additionally re-check the productKey's redeemedBy / buyerEmail
 * against the token's uid / email before touching PayPal.
 */

export const config = {
  maxDuration: 30,
}

const MAX_REASON_LENGTH = 500

interface Body {
  token?: string
  subscriptionId?: string
  reason?: string
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
  subscriptionId?: string
  subscriptionStatus?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = (req.body || {}) as Body
  const token = (body.token || '').trim()
  const subscriptionId = (body.subscriptionId || '').trim()
  const reason = (body.reason || '').slice(0, MAX_REASON_LENGTH).trim() ||
    'User cancelled via dm-plus.vercel.app/manage'

  if (!token || !subscriptionId) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטי בקשה' })
  }

  // 1) Verify the session token
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

  // 2) Cross-check ownership against Firestore — token allow-list
  //    is the primary gate; this is the secondary one in case a
  //    user's subscription moved hands or the token was tampered.
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
    return res.status(403).json({ ok: false, error: 'המנוי לא שייך לחשבון שלך' })
  }

  // Already cancelled? No-op success.
  if (
    key.subscriptionStatus === 'cancelled' ||
    key.subscriptionStatus === 'expired'
  ) {
    return res.status(200).json({
      ok: true,
      alreadyCancelled: true,
    })
  }

  // 3) Call PayPal to cancel. 204 = success. PayPal will follow
  //    up with BILLING.SUBSCRIPTION.CANCELLED webhook which marks
  //    the key's subscriptionStatus = "cancelled" — but we also
  //    stamp it here so the /manage page reflects the change
  //    immediately without waiting for the webhook roundtrip.
  try {
    await paypalCall('POST', `/v1/billing/subscriptions/${subscriptionId}/cancel`, {
      reason,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('[subscription/cancel] PayPal call failed:', err)
    // If PayPal says the subscription is already cancelled
    // (status 422 "SUBSCRIPTION_STATUS_INVALID"), treat as success.
    if (message.includes('SUBSCRIPTION_STATUS_INVALID')) {
      await keyDoc.ref.update({
        subscriptionStatus: 'cancelled',
        subscriptionCancelledAt: new Date().toISOString(),
        subscriptionCancelReason: reason,
      })
      return res
        .status(200)
        .json({ ok: true, alreadyCancelled: true })
    }
    return res
      .status(502)
      .json({ ok: false, error: `ביטול דרך PayPal נכשל: ${message}` })
  }

  // Optimistic local update — webhook will confirm shortly.
  await keyDoc.ref.update({
    subscriptionStatus: 'cancelled',
    subscriptionCancelledAt: new Date().toISOString(),
    subscriptionCancelReason: reason,
  })

  return res.status(200).json({
    ok: true,
    alreadyCancelled: false,
  })
}

// ─── Session-token verification (mirrors session.ts signer) ───

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
