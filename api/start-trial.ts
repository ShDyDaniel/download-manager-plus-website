import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * Auto-approval trial activation. Replaces the previous flow where
 * the Electron app wrote `trialStatus: "pending"` to Firestore and
 * an admin had to manually approve in AdminPanel.
 *
 * Flow:
 *   1. Electron app POSTs `{ idToken, deviceId }`.
 *   2. We verify the ID token with Firebase Admin and extract the
 *      caller's uid + email FROM the verified token — never trust
 *      what the client put in the body.
 *   3. We check `trialFingerprints/email_*` and
 *      `trialFingerprints/device_*` — if either exists, this caller
 *      (or this hardware) has already taken a trial. Reject.
 *   4. We check the user's current state — already Pro or
 *      already on a live trial? Reject with a clearer message.
 *   5. Inside a single Firestore transaction, write both
 *      fingerprints AND flip `users/{uid}` to trial-approved with
 *      a 30-day expiry. The transaction's atomicity is what
 *      protects against double-clicks and race conditions — if two
 *      requests sneak through the precondition check at the same
 *      time, only the first to commit succeeds.
 *
 * Security boundary:
 *   - The deviceId still comes from the client. We trust the
 *     Electron app to send the OS hardware UUID (see
 *     electron/handlers/system.ts). Yes, a determined attacker
 *     could modify the Electron build to send a fake deviceId per
 *     run — but the JS bundle is now obfuscated and the asar is
 *     integrity-locked (via Electron Fuses), so this is no longer
 *     a "5 minutes with a text editor" attack.
 *   - email + uid come from the verified ID token, not the body.
 *     Forging those requires breaking Firebase Auth, which is not
 *     a realistic threat.
 *
 * Required env vars (already set for /api/capture):
 *   FIREBASE_SERVICE_ACCOUNT
 */

const TRIAL_DAYS = 30

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

/** Sanitize an email or device-id into a Firestore document id.
 *  Firestore doc ids can't contain `/`, `.`, `#`, `$`, `[`, `]`, so
 *  we collapse anything outside `[a-z0-9_-]` to underscore. Mirrors
 *  the same function in the Electron app's lib/firestore.ts so the
 *  doc ids stay aligned. */
function sanitizeForDocId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const body = req.body as { idToken?: string; deviceId?: string }
  const idToken = (body.idToken || '').trim()
  const deviceId = (body.deviceId || '').trim()

  if (!idToken) {
    return res
      .status(400)
      .json({ ok: false, error: 'אסימון אימות חסר' })
  }
  if (!deviceId || deviceId.length < 16) {
    return res.status(400).json({
      ok: false,
      error:
        'לא ניתן לאמת את המחשב לבקשת ניסיון. הפעילו מחדש את התוכנה ונסו שוב.',
    })
  }

  try {
    const app = getFirebase()
    const auth = getAuth(app)
    const db = getFirestore(app)

    // Verify the ID token. This both proves the caller has signed
    // in via Firebase Auth AND gives us a trusted uid + email that
    // can't be spoofed by manipulating the request body.
    let decoded
    try {
      decoded = await auth.verifyIdToken(idToken)
    } catch (err) {
      console.warn('start-trial: token verification failed', err)
      return res
        .status(401)
        .json({ ok: false, error: 'אימות נכשל — התחברו מחדש ונסו שוב' })
    }

    const uid = decoded.uid
    const email = (decoded.email || '').toLowerCase().trim()
    if (!email) {
      return res
        .status(400)
        .json({ ok: false, error: 'לא נמצא מייל בחשבון' })
    }
    // Email-verified gate. Without this, an attacker registers
    // throwaway@one.gmail.com (no need to receive verification —
    // Firebase doesn't require it by default), gets an idToken,
    // and trips a new 30-day trial for each fresh email. The
    // signup flow at /api/paypal?action=signup-verify-code already
    // creates users with emailVerified=true; the migration grand
    // -fathers in pre-existing users.
    if (process.env.ENFORCE_EMAIL_VERIFIED === 'true' && !decoded.email_verified) {
      return res.status(403).json({
        ok: false,
        error: 'יש לאמת את כתובת המייל לפני שמתחילים את תקופת הניסיון.',
      })
    }

    const emailFingerprintId = `email_${sanitizeForDocId(email)}`
    const deviceFingerprintId = `device_${sanitizeForDocId(deviceId)}`

    // Atomic transaction: read all three docs, validate state,
    // then write fingerprints + user trial-active in one go. If
    // any condition fails we abort without writing anything. If
    // two requests race to here, Firestore retries one of them and
    // the second will see the fingerprint that the first wrote.
    const result = await db.runTransaction<
      | { ok: true; expiresAt: string }
      | { ok: false; status: number; error: string }
    >(async (txn) => {
      const userRef = db.collection('users').doc(uid)
      const emailFingerRef = db
        .collection('trialFingerprints')
        .doc(emailFingerprintId)
      const deviceFingerRef = db
        .collection('trialFingerprints')
        .doc(deviceFingerprintId)

      const [userSnap, emailSnap, deviceSnap] = await Promise.all([
        txn.get(userRef),
        txn.get(emailFingerRef),
        txn.get(deviceFingerRef),
      ])

      if (!userSnap.exists) {
        return { ok: false, status: 404, error: 'המשתמש לא נמצא במערכת' }
      }

      const userData = userSnap.data() as
        | {
            subscription?: string
            trialStatus?: string
            trialExpiresAt?: string
          }
        | undefined

      // Already a paying Pro? No point handing out a trial.
      if (userData?.subscription === 'pro') {
        return {
          ok: false,
          status: 400,
          error: 'כבר יש לכם מנוי Pro פעיל',
        }
      }

      // Already on an active trial — they should know how much
      // time is left, not "you already used your trial".
      if (
        userData?.trialStatus === 'approved' &&
        userData?.trialExpiresAt
      ) {
        const expiry = new Date(userData.trialExpiresAt).getTime()
        if (Number.isFinite(expiry) && expiry > Date.now()) {
          const expiresAtFormatted = new Date(expiry).toLocaleDateString(
            'he-IL',
            {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              timeZone: 'Asia/Jerusalem',
            },
          )
          return {
            ok: false,
            status: 400,
            error: `יש לכם ניסיון פעיל עד ${expiresAtFormatted}`,
          }
        }
      }

      if (emailSnap.exists) {
        return {
          ok: false,
          status: 400,
          error: 'המייל הזה כבר ניצל ניסיון חינם בעבר',
        }
      }
      if (deviceSnap.exists) {
        return {
          ok: false,
          status: 400,
          error: 'המחשב הזה כבר ניצל ניסיון חינם בעבר',
        }
      }

      // All gates passed — activate trial.
      const now = new Date()
      const expiresAt = new Date(
        now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
      )

      txn.update(userRef, {
        trialStatus: 'approved',
        trialRequestedAt: now.toISOString(),
        trialApprovedAt: now.toISOString(),
        trialExpiresAt: expiresAt.toISOString(),
        trialApprovedBy: 'auto-system',
      })

      const fingerprintData = {
        uid,
        email,
        deviceId,
        requestedAt: now.toISOString(),
      }
      txn.set(emailFingerRef, fingerprintData)
      txn.set(deviceFingerRef, fingerprintData)

      return { ok: true, expiresAt: expiresAt.toISOString() }
    })

    if (result.ok) {
      return res.status(200).json({ ok: true, expiresAt: result.expiresAt })
    }
    return res.status(result.status).json({ ok: false, error: result.error })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('start-trial handler failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
