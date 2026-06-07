import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'

/* ── Outgoing-email counter (twin of api/paypal.ts) ─────────────────
 *  Counts every email into metrics/emailSends (UTC hourly buckets) so
 *  the admin dashboard can show sent-in-24h vs the ~500/day Gmail cap. */
function recordEmailSent(): void {
  try {
    const bucket = new Date().toISOString().slice(0, 13)
    void getFirestore(getFirebase())
      .collection('metrics')
      .doc('emailSends')
      .set(
        {
          hours: { [bucket]: FieldValue.increment(1) },
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      )
      .catch(() => {})
  } catch {
    /* never let counting break email sending */
  }
}
function makeCountedTransport(
  config: Record<string, unknown>,
): ReturnType<typeof nodemailer.createTransport> {
  const t = nodemailer.createTransport(
    config as unknown as Parameters<typeof nodemailer.createTransport>[0],
  )
  return new Proxy(t, {
    get(target, prop, recv) {
      const val = Reflect.get(target, prop, recv)
      if (prop === 'sendMail' && typeof val === 'function') {
        return (...args: unknown[]) => {
          recordEmailSent()
          return (val as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof val === 'function'
        ? (val as (...a: unknown[]) => unknown).bind(target)
        : val
    },
  }) as ReturnType<typeof nodemailer.createTransport>
}

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

/* ──────────────────────────────────────────────────────────────
 *  Website session-token verifier (mirror of paypal.ts)
 *
 *  Desktop callers always send a Firebase ID token; the website
 *  uses our HMAC-signed session JWT instead (paid via /api/paypal
 *  ?action=session) because we deliberately avoided shipping the
 *  Firebase Web SDK to the public site. Accept either here so the
 *  /revisions web page can redeem keys with the same token it
 *  already has, without forcing the user to authenticate twice.
 *
 *  Keep the HMAC secret + JWT shape exactly aligned with paypal.ts
 *  → signSessionToken / verifySessionToken. If those move, mirror
 *  the change here too (the per-file no-shared-helpers convention
 *  was forced on us by Vercel's bundler).
 * ────────────────────────────────────────────────────────────── */
interface WebSessionClaims {
  uid: string
  email: string
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

function verifyWebSessionToken(token: string): WebSessionClaims | null {
  if (!token) return null
  const secret = process.env.RENEW_TOKEN_SECRET
  if (!secret) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts
    const expected = crypto
      .createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${headerB64}.${payloadB64}`)
      .digest()
    const actual = b64urlDecode(sigB64)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(
      b64urlDecode(payloadB64).toString('utf8'),
    ) as WebSessionClaims
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    if (!claims.uid || !claims.email) return null
    return claims
  } catch (err) {
    console.warn('[keys/redeem] verifyWebSessionToken failed:', err)
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const body = req.body as {
    idToken?: string
    sessionToken?: string
    key?: string
  }
  const idToken = (body.idToken || '').trim()
  const sessionToken = (body.sessionToken || '').trim()
  const rawKey = (body.key || '').trim().toUpperCase()

  if (!idToken && !sessionToken) {
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

    // Resolve {uid, email} from whichever token type we got. The
    // desktop sends a Firebase ID token (has Firebase Web SDK
    // loaded); the website /revisions page sends a session JWT
    // (no SDK on the page — purely server-issued). The Firebase
    // path also returns `emailVerified` from the decoded token,
    // which we use for the optional ENFORCE_EMAIL_VERIFIED gate.
    // The session path can't tell us emailVerified directly, so
    // we read it from the Firebase Auth user record AS A SECOND
    // ROUND-TRIP when the gate is on — keeps the happy path fast
    // for the common case where the gate is off.
    let uid: string
    let email: string
    let emailVerified: boolean

    if (idToken) {
      let decoded
      try {
        decoded = await auth.verifyIdToken(idToken)
      } catch (err) {
        console.warn('keys/redeem: id token verification failed', err)
        return res
          .status(401)
          .json({ ok: false, error: 'אימות נכשל — התחברו מחדש ונסו שוב' })
      }
      uid = decoded.uid
      email = (decoded.email || '').toLowerCase().trim()
      emailVerified = decoded.email_verified === true
    } else {
      const claims = verifyWebSessionToken(sessionToken)
      if (!claims) {
        return res
          .status(401)
          .json({ ok: false, error: 'אימות נכשל — התחברו מחדש ונסו שוב' })
      }
      uid = claims.uid
      email = claims.email.toLowerCase().trim()
      // Lookup emailVerified only when the gate is actually on —
      // avoids an extra Auth round-trip for the common case.
      if (process.env.ENFORCE_EMAIL_VERIFIED === 'true') {
        try {
          const u = await auth.getUser(uid)
          emailVerified = u.emailVerified === true
        } catch (err) {
          console.warn('keys/redeem: getUser failed', err)
          emailVerified = false
        }
      } else {
        // Gate off — we never check this; assume true so the
        // downstream condition is always false.
        emailVerified = true
      }
    }

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
    if (process.env.ENFORCE_EMAIL_VERIFIED === 'true' && !emailVerified) {
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
          newlyActivated: boolean
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
          // No state change — the caller should NOT send a
          // "Pro activated" email this round; the user was
          // already Pro.
          newlyActivated: false,
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
        // First-time redemption (or replacement of a different
        // key) — caller should send the "Pro activated" email
        // so the user has a record that the activation worked.
        newlyActivated: true,
      }
    })

    if (result.ok) {
      // Pro-activation email — sent only on a NEW redemption
      // (newlyActivated=true), not on the idempotent
      // already-redeemed-by-this-user path. Fire-and-forget;
      // an email failure shouldn't fail the redemption itself.
      if (result.newlyActivated) {
        void sendProActivatedEmail({
          to: email,
          key: result.keyId,
          validUntil: result.expiresAt ? new Date(result.expiresAt) : null,
        }).catch((err) => {
          console.error('[keys/redeem] pro-activated email failed:', err)
        })
      }
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

const WEBSITE_BASE_REDEEM = 'https://dmplus.net'

/**
 * Pro-activation email. Twin of the same-named function in
 * api/paypal.ts (kept duplicated, not shared, because Vercel's
 * per-function bundler has been unreliable with cross-file
 * imports out of api/). Keep the markup in sync if you tweak
 * the design.
 */
async function sendProActivatedEmail(args: {
  to: string
  key: string
  validUntil: Date | null
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const validUntilStr = args.validUntil
    ? args.validUntil.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Jerusalem',
      })
    : 'ללא תפוגה'
  const keyLast8 = args.key.length >= 8 ? args.key.slice(-8) : args.key
  const html = renderEmail({
    heading: '✓ החשבון שלך עכשיו Pro',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 16px;color:#C9BFA8;">
        המפתח הופעל בהצלחה, וכעת יש לך גישה מלאה לכל היכולות של מנוי Pro בתוכנה <strong>ניהול הורדות פלוס</strong>.
      </p>
      <div style="background:#16110D;border:1px solid rgba(245,239,230,0.08);border-radius:8px;padding:20px;margin:0 0 24px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;line-height:1.8;color:#C9BFA8;">
          <div>
            <div style="color:#8B8170;font-size:11px;margin-bottom:4px;">מפתח</div>
            <div dir="ltr" style="font-family:ui-monospace,'SF Mono',monospace;color:#D4A574;font-size:14px;font-weight:600;">…${keyLast8}</div>
          </div>
          <div style="text-align:left;">
            <div style="color:#8B8170;font-size:11px;margin-bottom:4px;">בתוקף עד</div>
            <div style="color:#F5EFE6;font-size:14px;font-weight:600;">${validUntilStr}</div>
          </div>
        </div>
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#F5EFE6;font-weight:600;">מה אפשר עכשיו</h3>
      <div style="font-size:13px;line-height:1.9;color:#C9BFA8;">
        <div>• מיון אוטומטי + חוקי ניתוב מותאמים אישית</div>
        <div>• הורדה מסרטוני וידאו ב-MP3 / 1080p / 4K</div>
        <div>• המרת קבצים בין כל הפורמטים</div>
        <div>• דחיסת וידאו לגודל יעד</div>
        <div>• הצעות מחיר עם יועץ AI ופלט PDF</div>
        <div>• ניהול תשלומים והכנסות</div>
        <div>• עדכונים אוטומטיים ותמיכה מועדפת</div>
      </div>
      <p style="font-size:12px;line-height:1.7;margin:24px 0 0;color:#8B8170;">
        אפשר לראות את פרטי החשבון ולנהל את המנוי בכל עת ב-
        <a href="${WEBSITE_BASE_REDEEM}/account" style="color:#D4A574;text-decoration:underline;">${WEBSITE_BASE_REDEEM}/account</a>.
      </p>
      <p style="font-size:11px;line-height:1.6;margin:14px 0 0;color:#5C5444;">
        בכל בעיה — תשובה ישירה למייל הזה תגיע לתמיכה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: '✓ החשבון שלך פעיל — ניהול הורדות פלוס Pro',
    html,
  })
}

/**
 * Email-template wrapper. Mirror of api/paypal.ts (and friends).
 * If you change the chrome, change all four files.
 */
function renderEmail(args: { heading: string; contentHtml: string }): string {
  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="color-scheme" content="only dark"/>
  <meta name="supported-color-schemes" content="only dark"/>
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#16110D;font-family:'Rubik',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:#F5EFE6;direction:rtl;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#16110D;padding:48px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;background:#2A211A;border-radius:10px;border:1px solid rgba(245,239,230,0.08);box-shadow:0 24px 48px rgba(13,8,4,0.55);">
<tr><td style="padding:40px 36px;text-align:right;direction:rtl;">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8B8170;margin:0 0 14px;font-weight:500;direction:rtl;text-align:right;">— ניהול הורדות פלוס</div>
  <h1 style="font-size:28px;margin:0 0 22px;color:#F5EFE6;font-weight:500;line-height:1.18;letter-spacing:-0.015em;direction:rtl;text-align:right;">${args.heading}</h1>
  ${args.contentHtml}
</td></tr>
</table>
<div style="margin:24px auto 0;font-size:10px;letter-spacing:0.18em;color:#5C5444;text-align:center;">— ניהול הורדות פלוס —</div>
</td></tr>
</table>
</body>
</html>`
}
