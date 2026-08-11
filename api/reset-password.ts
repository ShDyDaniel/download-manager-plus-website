import type { VercelRequest, VercelResponse } from '@vercel/node'
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
 * Custom password-reset email sender for the Electron app.
 *
 * Why this exists instead of using Firebase Auth's built-in
 * `sendPasswordResetEmail` from the client:
 *
 *   - The default sender is `noreply@<project>.firebaseapp.com`,
 *     which lands in spam more often and doesn't look like it came
 *     from us. Routing through our Gmail SMTP means the email
 *     comes from the same address (and with the same dark-themed
 *     branding) as the license email the user already trusts.
 *   - We get full control over the Hebrew copy and the dark theme.
 *   - The Electron app calls one HTTP endpoint instead of pulling
 *     in the Firebase client SDK for auth-side-effects.
 *
 * Flow:
 *   1. Electron app POSTs `{ email }` here.
 *   2. We use Firebase Admin to generate a one-time reset link
 *      (Firebase still hosts the actual reset page; we just send
 *      the link via our SMTP).
 *   3. We send an HTML email through Gmail SMTP.
 *   4. We return 200 either way — even if the email isn't
 *      registered — so attackers can't enumerate user accounts by
 *      probing this endpoint.
 *
 * Required env vars (all already set for /api/capture):
 *   FIREBASE_SERVICE_ACCOUNT
 *   GMAIL_USER, GMAIL_APP_PASSWORD
 */

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

async function sendResetEmail(to: string, resetUrl: string): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set')
  }
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const html = renderEmail({
    heading: 'איפוס סיסמה',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        קיבלנו בקשה לאיפוס הסיסמה לחשבון שלך ב-<strong>ניהול הורדות פלוס</strong>.
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
        לחץ על הכפתור כדי לקבוע סיסמה חדשה:
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
        <tr><td align="center">
          <a href="${resetUrl}" target="_blank" style="display:inline-block;background:#B8794F;color:#F5EFE6;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">לאיפוס הסיסמה</a>
        </td></tr>
      </table>
      <p style="font-size:12px;line-height:1.6;margin:0 0 6px;color:#8B8170;">
        או הדבק את הקישור הבא לדפדפן:
      </p>
      <p dir="ltr" style="font-size:11px;line-height:1.5;margin:0 0 22px;color:#C9BFA8;word-break:break-all;text-align:left;direction:ltr;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;">
        ${resetUrl}
      </p>
      <p style="font-size:12px;line-height:1.6;margin:0 0 14px;color:#8B8170;">
        ⚠️ הקישור תקף לשעה אחת בלבד.
      </p>
      <p style="font-size:11px;line-height:1.6;margin:24px 0 0;color:#5C5444;">
        לא ביקשת לאפס סיסמה? פשוט התעלם מהמייל הזה. אף אחד לא יכול להחליף לך את הסיסמה בלי לחיצה על הקישור למעלה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to,
    subject: 'איפוס סיסמה · ניהול הורדות פלוס',
    html,
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = req.body as { email?: string }
  const email = (body.email || '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'כתובת מייל לא תקינה' })
  }

  try {
    const app = getFirebase()
    const auth = getAuth(app)

    let resetLink: string
    try {
      resetLink = await auth.generatePasswordResetLink(email)
    } catch (err) {
      // We couldn't generate a reset link. Almost always this is because
      // the email isn't registered — Firebase usually throws
      // auth/user-not-found, but for some accounts it surfaces a generic
      // internal error instead ("Unable to create the email action link"
      // / "INTERNAL ASSERT FAILED"), which used to fall through to the 500
      // branch and leak that raw English string to the app.
      //
      // NEVER leak the reason to the caller: whether the address exists,
      // and whatever Firebase's internal error was, would both let an
      // attacker probe accounts or see a scary technical message. Return
      // the SAME 200 as a real send for *any* link-generation failure; a
      // legitimate user simply retries. We log the details for ourselves.
      const code = (err as { code?: string }).code || ''
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('reset-password: could not generate link for', email, code, msg)
      return res.status(200).json({ ok: true })
    }

    await sendResetEmail(email, resetLink)
    return res.status(200).json({ ok: true })
  } catch (err) {
    // Genuine server failure (SMTP down, Firebase init, etc.). Log the raw
    // reason for us, but never surface the technical English string to the
    // app — return a Hebrew message the client can show as-is.
    console.error('reset-password handler failed', err)
    return res
      .status(500)
      .json({ ok: false, error: 'שליחת המייל נכשלה. נסו שוב מאוחר יותר.' })
  }
}

/* ─────────────────────────────────────────────────────────────
 *  Email template helper. Mirror of the same function inlined in
 *  api/paypal.ts, api/capture.ts, and api/cron/expiry-reminders
 *  .ts. Kept duplicated rather than shared because Vercel's
 *  per-function bundler is unreliable with helper-only modules
 *  out of api/. If you change the chrome here, change it in the
 *  other three too.
 * ───────────────────────────────────────────────────────────── */
function renderEmail(args: { heading: string; contentHtml: string }): string {
  // Brand palette — kept in sync with api/paypal.ts. See that
  // file's renderEmail for the rationale.
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
