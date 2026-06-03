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

async function verifyAdmin(
  idToken: string,
): Promise<
  | { ok: true; uid: string; email: string }
  | { ok: false; status: number; error: string }
> {
  const app = getFirebase()
  const auth = getAuth(app)
  const db = getFirestore(app)
  let decoded
  try {
    decoded = await auth.verifyIdToken(idToken)
  } catch {
    return { ok: false, status: 401, error: 'אימות נכשל — התחברו מחדש' }
  }
  const email = (decoded.email || '').toLowerCase().trim()
  const uid = decoded.uid
  const allow = adminEmailsFromEnv()
  // Hard ADMIN_EMAILS allowlist ONLY. The previous fallback path
  // ("else check users/{uid}.role === 'admin'") was removed: it
  // depended entirely on Firestore rules to prevent a regular user
  // from writing `role:'admin'` to their own doc via the client
  // SDK, and a permissive rules file would silently turn it into a
  // self-promotion vulnerability. ADMIN_EMAILS lives in Vercel env
  // vars where only the operator can touch it — no Firestore-rules
  // dependency.
  if (email && allow.includes(email)) return { ok: true, uid, email }
  return { ok: false, status: 403, error: 'אין הרשאת אדמין' }
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
    action?: 'load' | 'save' | 'delete' | 'publish'
    release?: unknown
  }
  const idToken = (body.idToken || '').trim()
  const action = body.action
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'אסימון אימות חסר' })
  }
  if (!action || !['load', 'save', 'delete', 'publish'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'פעולה לא חוקית' })
  }

  const gate = await verifyAdmin(idToken)
  if (!gate.ok) {
    return res.status(gate.status).json({ ok: false, error: gate.error })
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
