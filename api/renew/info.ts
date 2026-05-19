import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * Renewal landing-page helper. The Electron renewal email links the
 * buyer to /buy?renew=<token>; BuyPage hits this endpoint to find
 * out WHO the token is for and HOW MUCH TIME they have left, so it
 * can render the renewal confirmation card before launching the
 * PayPal flow.
 *
 * We never echo back any sensitive data — only the buyer's
 * own email (already in their mailbox), the masked product key,
 * and the current expiry date. The actual payment still goes
 * through /api/capture; this endpoint is read-only.
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
  return Buffer.from(s, 'hex')
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

/** Mask all but the last four-character block of a product key —
 *  shown in the renewal card so the user can spot-check which key
 *  they're about to extend without us echoing the full credential
 *  back over the wire. */
function maskKey(key: string): string {
  const blocks = key.split('-')
  if (blocks.length === 0) return '••••'
  const last = blocks[blocks.length - 1]
  return `${'•••• '.repeat(blocks.length - 1).trim()}-${last}`.trim()
}

/** Hide all but the first char and the domain of the email. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return email
  if (local.length <= 1) return `${local}@${domain}`
  return `${local[0]}${'•'.repeat(Math.min(local.length - 1, 5))}@${domain}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = req.body as { token?: string }
  const token = (body.token || '').trim()
  if (!token) {
    return res.status(400).json({ ok: false, error: 'token חסר' })
  }
  const claims = verifyRenewToken(token)
  if (!claims) {
    return res.status(400).json({
      ok: false,
      error: 'הקישור לא תקף או שתוקפו פג. בקשו תזכורת חדשה במייל.',
    })
  }
  try {
    const app = getFirebase()
    const db = getFirestore(app)
    const snap = await db
      .collection('productKeys')
      .doc(claims.key)
      .get()
    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: 'המפתח לא נמצא במערכת',
      })
    }
    const data = snap.data() as {
      buyerEmail?: string
      expiresAt?: string
      tier?: string
    }
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
    if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
      return res.status(500).json({
        ok: false,
        error: 'מפתח ללא תאריך תפוגה — לא ניתן לחדש',
      })
    }
    return res.status(200).json({
      ok: true,
      key: claims.key,
      keyMasked: maskKey(claims.key),
      emailMasked: maskEmail(data.buyerEmail || ''),
      tier: data.tier || 'pro',
      expiresAt: expiresAt.toISOString(),
      isExpired: expiresAt.getTime() < Date.now(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('renew/info failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
