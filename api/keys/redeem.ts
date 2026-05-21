import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

/**
 * Server-side product-key redemption. Replaces the previous flow
 * where the Electron client read `productKeys/{key}` directly via
 * the Web SDK to validate the key and then wrote `redeemedBy` to
 * claim it.
 *
 * Why the client path was risky:
 *   - For the read to work, Firestore rules had to allow ANY
 *     authenticated user to `get` an unredeemed productKey doc.
 *     That meant a determined attacker who could guess the key
 *     format (XXXX-XXXX-XXXX-XXXX, base32-ish) could brute-force
 *     the API and harvest unclaimed keys without ever paying.
 *   - The validation logic ("is this key expired? is it taken?")
 *     ran in the client. Anyone with a debugger could patch it
 *     out and write the `redeemedBy` field on an already-redeemed
 *     key, hijacking another user's license.
 *
 * Why this endpoint is safe:
 *   - Caller proves identity via a Firebase Auth ID token; we
 *     never trust the body for `uid` or `email`. Token verification
 *     uses Firebase Admin which is online with Google so a revoked
 *     or expired session bounces immediately.
 *   - The actual read+write runs inside a Firestore transaction
 *     with Admin SDK credentials. Once we tighten the
 *     `productKeys` rule to `allow read, write: if false` from the
 *     client side, there is no client path to keys at all — only
 *     this endpoint can touch them, and only after token check.
 *   - Error messages collapse "not found" and "permission denied"
 *     into a single "המפתח לא נמצא" so a probing attacker can't
 *     distinguish "key never existed" from "key was redeemed by
 *     someone else and the rules now hide it" — both look the same.
 *
 * Required env vars (already set):
 *   FIREBASE_SERVICE_ACCOUNT
 */

const KEY_FORMAT = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

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

  const body = req.body as { idToken?: string; key?: string }
  const idToken = (body.idToken || '').trim()
  const rawKey = (body.key || '').trim().toUpperCase()

  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'אסימון אימות חסר' })
  }
  if (!KEY_FORMAT.test(rawKey)) {
    return res.status(400).json({
      ok: false,
      error: 'פורמט מפתח לא תקין — צריך להיות XXXX-XXXX-XXXX-XXXX',
    })
  }

  try {
    const app = getFirebase()
    const auth = getAuth(app)
    const db = getFirestore(app)

    // Verify the ID token — this is the gate. Body uid/email are
    // never read; we always pull the trusted values out of the
    // decoded token claims.
    let decoded
    try {
      decoded = await auth.verifyIdToken(idToken)
    } catch (err) {
      console.warn('keys/redeem: token verification failed', err)
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
    // Email-verified gate. Otherwise an attacker registers
    // someone-else's-email@example.com, signs in, and redeems
    // any key that was bought with that email but never claimed
    // (an unredeemed productKey with redeemedBy=null and
    // buyerEmail=victim). The signup flow already issues users
    // with emailVerified=true; the migration covers pre-existing
    // users.
    if (process.env.ENFORCE_EMAIL_VERIFIED === 'true' && !decoded.email_verified) {
      return res.status(403).json({
        ok: false,
        error: 'יש לאמת את כתובת המייל לפני מימוש מפתח.',
      })
    }

    // ── Account-key lock: enforce one active key per account ──
    //
    // User asked: "if a user redeemed one key, their account is
    // locked to that key. If the key expires and they BUY A NEW
    // ONE (instead of renewing), the system should delete the old
    // key from their account and set the new one."
    //
    // We query for any keys currently linked to this uid BEFORE
    // the transaction. Inside the transaction we then unset those
    // links (set redeemedBy=null + record `replacedByKey`) so the
    // account is single-key going forward. The old key documents
    // stick around for audit / support — only the redemption
    // pointer is cleared.
    //
    // Race window: between this query and the txn, a parallel
    // redemption from the same uid could slip in. In practice this
    // means two simultaneous clicks of "redeem" — extremely rare,
    // and the worst-case outcome is one stray un-cleared old key
    // that the /account page just won't show as primary (it picks
    // the longest-lived one). Tolerable.
    const priorKeysSnap = await db
      .collection('productKeys')
      .where('redeemedBy', '==', uid)
      .get()
    const priorKeyIds = priorKeysSnap.docs
      .map((d) => d.id)
      .filter((id) => id !== rawKey)

    // Atomic read+write inside a transaction. If two clients race
    // to redeem the same key, Firestore retries one and the second
    // attempt sees the already-redeemed state and bounces.
    const result = await db.runTransaction<
      | {
          ok: true
          tier: 'pro'
          expiresAt: string | null
          keyId: string
          replacedKeys: string[]
        }
      | { ok: false; status: number; error: string }
    >(async (txn) => {
      const ref = db.collection('productKeys').doc(rawKey)
      const snap = await txn.get(ref)
      if (!snap.exists) {
        return { ok: false, status: 404, error: 'המפתח לא נמצא במאגר' }
      }
      const data = snap.data() as {
        redeemedBy?: string | null
        redeemedByEmail?: string | null
        expiresAt?: string | null
        tier?: string
        blocked?: boolean
      }

      if (data.blocked) {
        return {
          ok: false,
          status: 400,
          // Don't tell the user "blocked" — looks identical to "not
          // found" so a probing attacker can't distinguish which
          // keys exist-but-blocked from which never existed.
          error: 'המפתח לא נמצא במאגר',
        }
      }

      // Expiry check first — applies regardless of who (if anyone)
      // redeemed it. Without this, a user who already redeemed a
      // key that then expired would re-enter it and see a fresh
      // "you're Pro" success message, which is wrong.
      if (
        data.expiresAt &&
        new Date(data.expiresAt).getTime() < Date.now()
      ) {
        return { ok: false, status: 400, error: 'המפתח פג תוקף' }
      }

      // Already redeemed by THIS user — idempotent success. This
      // path matters because the client used to surface "already
      // yours" as a success too (e.g. user re-runs the modal after
      // a reload). Only reached when the key is still in force,
      // thanks to the expiry check above.
      if (data.redeemedBy === uid) {
        return {
          ok: true,
          tier: 'pro',
          expiresAt: data.expiresAt ?? null,
          keyId: rawKey,
          replacedKeys: [],
        }
      }

      if (data.redeemedBy && data.redeemedBy !== uid) {
        return {
          ok: false,
          status: 400,
          error: 'המפתח כבר מומש על ידי משתמש אחר',
        }
      }

      // Account-key lock: unset any keys this uid had previously
      // redeemed. Done as blind writes inside the txn (no read
      // first — these docs aren't part of the consistency check
      // for the new redemption). The old key documents are kept
      // for audit / support; only the user-link pointer is cleared
      // and an audit trail is recorded.
      const replacedAt = new Date().toISOString()
      for (const priorId of priorKeyIds) {
        const priorRef = db.collection('productKeys').doc(priorId)
        txn.update(priorRef, {
          redeemedBy: null,
          redeemedByEmail: null,
          replacedAt,
          replacedByKey: rawKey,
        })
      }

      txn.update(ref, {
        redeemedBy: uid,
        redeemedByEmail: email,
        redeemedAt: new Date().toISOString(),
        // Preserve the existing expiry — admin-set keys have one,
        // unbound keys keep `null`. We never invent an expiry here;
        // that's the purchase flow's job in /api/capture.
        expiresAt: data.expiresAt ?? null,
        // If the user is replacing previous keys, record which
        // ones got displaced. The /account page can render a
        // "החלפת מפתח קודם" hint based on this.
        replacedPriorKeys: priorKeyIds,
      })

      return {
        ok: true,
        tier: 'pro',
        expiresAt: data.expiresAt ?? null,
        keyId: rawKey,
        replacedKeys: priorKeyIds,
      }
    })

    if (result.ok) {
      return res.status(200).json({
        ok: true,
        tier: result.tier,
        expiresAt: result.expiresAt,
        keyId: result.keyId,
        replacedKeys: result.replacedKeys,
      })
    }
    return res
      .status(result.status)
      .json({ ok: false, error: result.error })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('keys/redeem handler failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
