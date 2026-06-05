import crypto from 'crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * Admin-only draft-release workspace. Replaces direct Firestore
 * client access to `appReleases/draft`.
 *
 * Why it matters: the draft contains unreleased changelog text,
 * download URLs for not-yet-public builds, and the `mandatory`
 * flag (which forces every user to update). Letting an attacker
 * read the draft means they learn about upcoming security fixes
 * before the fix is rolled out — a textbook one-day exploit
 * window. Letting an attacker WRITE the draft means they can
 * publish a malicious "1.6.6" update with whatever download URL
 * they want; once a real admin clicks "Publish", every user's
 * auto-updater fetches that URL.
 *
 * Single endpoint with action dispatch, because the Vercel Hobby
 * plan caps us at 12 functions and the draft endpoints share so
 * much setup (Firebase init + admin gate) that splitting them is
 * a waste of slots.
 *
 * All requests are POST with body:
 *   { idToken, action: 'load' | 'save' | 'delete' | 'publish',
 *     release?: ReleaseDoc }
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT — for Admin SDK
 *   ADMIN_EMAILS (optional)  — comma-separated allowlist; if a
 *     caller's email isn't on it, we fall back to checking
 *     `users/{uid}.role === 'admin'`. Set both for defence in depth.
 */

const RELEASE_LATEST = 'latest'
const RELEASE_DRAFT = 'draft'

interface ReleaseDoc {
  version: string
  notes: string
  macUrl: string
  winUrl: string
  macUrlBackup: string
  winUrlBackup: string
  draft: boolean
  publishedAt?: string
  mandatory?: boolean
  mandatoryExemptVersions?: string[]
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

function adminEmailsFromEnv(): string[] {
  const raw = process.env.ADMIN_EMAILS || ''
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/* ── Admin token (2FA) + gate-key verification ──────────────────
 *
 * This endpoint lives in its OWN file (separate from api/paypal.ts,
 * which owns signAdminToken / verifyAdmin2FA), so we re-implement the
 * exact same crypto here. It MUST stay byte-for-byte compatible with
 * paypal.ts:
 *   - tokenSecret()  → process.env.RENEW_TOKEN_SECRET as UTF-8
 *   - adminToken     → HS256 JWT, use:'admin', 12h, signed with that
 *   - gateKey        → HMAC-SHA256(gateKey, secret) compared to the
 *                      stored adminSecurity/config.gateKeyHash
 * If you change the token format in paypal.ts, change it here too.
 */

function tokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  return Buffer.from(s, 'utf8')
}

function b64urlDecode(s: string): Buffer {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64')
}

interface AdminTokenClaims {
  email: string
  use: 'admin' | 'admin-stepup'
  iat: number
  exp: number
}

/** Verify an HMAC admin token of a given `use`. Mirrors paypal.ts. */
function verifyTokenOfUse(
  token: string,
  use: 'admin' | 'admin-stepup',
): AdminTokenClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [h, p, s] = parts
    const expected = crypto
      .createHmac('sha256', tokenSecret())
      .update(`${h}.${p}`)
      .digest()
    const actual = b64urlDecode(s)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(
      b64urlDecode(p).toString('utf8'),
    ) as AdminTokenClaims
    if (claims.use !== use) return null
    const allow = adminEmailsFromEnv()
    if (!claims.email || !allow.includes(claims.email.toLowerCase())) {
      return null
    }
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    return claims
  } catch {
    return null
  }
}

function verifyAdminToken(token: string): AdminTokenClaims | null {
  return verifyTokenOfUse(token, 'admin')
}

function verifyStepUpToken(token: string): AdminTokenClaims | null {
  return verifyTokenOfUse(token, 'admin-stepup')
}

function hashGateKey(key: string): string {
  return crypto.createHmac('sha256', tokenSecret()).update(key).digest('hex')
}

async function isAdminGateOpen(providedKey?: string): Promise<boolean> {
  let stored: string | null
  try {
    const snap = await getFirestore(getFirebase())
      .collection('adminSecurity')
      .doc('config')
      .get()
    const h = snap.exists
      ? (snap.data() as { gateKeyHash?: unknown }).gateKeyHash
      : null
    stored = typeof h === 'string' && h.length > 0 ? h : null
  } catch {
    // Fail CLOSED on read error.
    return false
  }
  if (!stored) return true // no key configured → open (bootstrap)
  const key = (providedKey || '').trim()
  if (!key) return false
  const a = Buffer.from(hashGateKey(key), 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Full admin gate — mirrors verifyAdmin2FA() in api/paypal.ts. Three
 * independent factors, all required:
 *   1. gateKey       — the secret access key (outermost gate)
 *   2. idToken       — a live Firebase admin session
 *   3. adminToken    — the 12h HMAC token minted only by passing the
 *                      email code OR a passkey assertion
 * A stolen idToken alone (or a leaked gateKey alone) can't publish a
 * release — exactly what the user asked for: every admin action is
 * "signed" by proof of a real, recently-2FA'd admin.
 */
async function verifyAdmin(body: {
  idToken?: string
  adminToken?: string
  gateKey?: string
}): Promise<
  | { ok: true; uid: string; email: string }
  | { ok: false; status: number; error: string }
> {
  // 1) Outermost gate — the secret access key.
  if (!(await isAdminGateOpen(body.gateKey))) {
    return { ok: false, status: 403, error: 'אין גישה' }
  }
  // 2) Live Firebase admin session.
  const app = getFirebase()
  const auth = getAuth(app)
  let decoded
  try {
    decoded = await auth.verifyIdToken((body.idToken || '').trim())
  } catch {
    return { ok: false, status: 401, error: 'אימות נכשל — התחברו מחדש' }
  }
  const email = (decoded.email || '').toLowerCase().trim()
  const uid = decoded.uid
  const allow = adminEmailsFromEnv()
  // Hard ADMIN_EMAILS allowlist ONLY — sourced from Vercel env vars,
  // never from a client-writable Firestore field, so there's no
  // self-promotion ("role:'admin'") vulnerability to worry about.
  if (!email || !allow.includes(email)) {
    return { ok: false, status: 403, error: 'אין הרשאת אדמין' }
  }
  // 3) The 2FA admin token — proves a real second factor was passed
  //    recently, and binds the action to the same admin email.
  const claims = verifyAdminToken((body.adminToken || '').trim())
  if (!claims || claims.email.toLowerCase() !== email) {
    return { ok: false, status: 403, error: 'נדרש אימות דו-שלבי מחדש' }
  }
  return { ok: true, uid, email }
}

/** Normalize a posted ReleaseDoc — drop unknown fields, drop
 *  undefined ones (Firestore rejects undefined), and force the
 *  `draft` flag. We never trust the client to set publishedAt on
 *  a draft — only `publish` action stamps it. */
function cleanDraft(input: unknown): ReleaseDoc {
  const r = (input as Partial<ReleaseDoc>) || {}
  const out: ReleaseDoc = {
    version: String(r.version || ''),
    notes: String(r.notes || ''),
    macUrl: String(r.macUrl || ''),
    winUrl: String(r.winUrl || ''),
    macUrlBackup: String(r.macUrlBackup || ''),
    winUrlBackup: String(r.winUrlBackup || ''),
    draft: true,
    mandatory: r.mandatory === true,
    mandatoryExemptVersions: Array.isArray(r.mandatoryExemptVersions)
      ? r.mandatoryExemptVersions.filter((v) => typeof v === 'string')
      : [],
  }
  // Keep publishedAt only if it was already there (e.g. editing a
  // previously-published draft snapshot). Don't invent one here.
  if (typeof r.publishedAt === 'string') out.publishedAt = r.publishedAt
  return out
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const body = req.body as {
    idToken?: string
    adminToken?: string
    gateKey?: string
    stepUpToken?: string
    action?: 'load' | 'save' | 'delete' | 'publish' | 'save-latest'
    release?: unknown
    publish?: boolean
  }
  const action = body.action
  if (
    !action ||
    !['load', 'save', 'delete', 'publish', 'save-latest'].includes(action)
  ) {
    return res.status(400).json({ ok: false, error: 'פעולה לא חוקית' })
  }

  const gate = await verifyAdmin({
    idToken: body.idToken,
    adminToken: body.adminToken,
    gateKey: body.gateKey,
  })
  if (!gate.ok) {
    return res.status(gate.status).json({ ok: false, error: gate.error })
  }

  // Every MUTATION (everything except 'load') additionally requires a
  // fresh step-up token — a live passkey assertion minted in the last
  // 2 minutes for the same admin. Reading the draft doesn't.
  if (action !== 'load') {
    const stepUp = verifyStepUpToken((body.stepUpToken || '').trim())
    if (!stepUp || stepUp.email.toLowerCase() !== gate.email.toLowerCase()) {
      return res
        .status(403)
        .json({ ok: false, error: 'נדרש אימות ביומטרי לפעולה הזו' })
    }
  }

  try {
    const app = getFirebase()
    const db = getFirestore(app)
    const draftRef = db.collection('appReleases').doc(RELEASE_DRAFT)
    const latestRef = db.collection('appReleases').doc(RELEASE_LATEST)

    if (action === 'load') {
      const [snap, latestSnap] = await Promise.all([
        draftRef.get(),
        latestRef.get(),
      ])
      return res.status(200).json({
        ok: true,
        draft: snap.exists ? snap.data() : null,
        latest: latestSnap.exists ? latestSnap.data() : null,
      })
    }

    if (action === 'save') {
      const cleaned = cleanDraft(body.release)
      if (!cleaned.version) {
        return res
          .status(400)
          .json({ ok: false, error: 'חסר מספר גרסה לטיוטה' })
      }
      await draftRef.set(cleaned)
      return res.status(200).json({ ok: true, draft: cleaned })
    }

    if (action === 'delete') {
      await draftRef.delete().catch(() => undefined)
      return res.status(200).json({ ok: true })
    }

    // action === 'save-latest' — write directly to the LIVE release
    // doc (edit-in-place). `publish:true` makes it visible to users
    // (draft:false) and stamps publishedAt; otherwise it's parked as
    // a not-yet-public draft on the latest doc.
    if (action === 'save-latest') {
      const r = (body.release as Partial<ReleaseDoc>) || {}
      const cleaned = cleanDraft(r)
      if (!cleaned.version) {
        return res.status(400).json({ ok: false, error: 'חסר מספר גרסה' })
      }
      const publish = body.publish === true
      const finalDoc: ReleaseDoc = {
        ...cleaned,
        draft: !publish,
      }
      if (publish) finalDoc.publishedAt = new Date().toISOString()
      else if (typeof r.publishedAt === 'string')
        finalDoc.publishedAt = r.publishedAt
      await latestRef.set(finalDoc)
      return res.status(200).json({ ok: true, release: finalDoc })
    }

    // action === 'publish' — promote draft → latest, stamp the
    // publish timestamp, and clean up the draft. We do this with
    // an explicit read-then-two-writes rather than a transaction
    // because the two docs are independent — there's no race we
    // care about here (only admins call this, one at a time).
    const draftSnap = await draftRef.get()
    if (!draftSnap.exists) {
      return res.status(404).json({ ok: false, error: 'אין טיוטה לפרסום' })
    }
    const draftData = draftSnap.data() as ReleaseDoc
    const published: ReleaseDoc = {
      ...draftData,
      draft: false,
      publishedAt: new Date().toISOString(),
    }
    await latestRef.set(published)
    await draftRef.delete().catch(() => undefined)
    return res.status(200).json({ ok: true, release: published })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('admin/draft-release failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
