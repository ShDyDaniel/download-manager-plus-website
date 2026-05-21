import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import nodemailer from 'nodemailer'

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
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const html = renderEmail({
    heading: 'איפוס סיסמה',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#d1d5db;">
        קיבלנו בקשה לאיפוס הסיסמה לחשבון שלך ב-<strong>ניהול הורדות פלוס</strong>.
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#d1d5db;">
        לחץ על הכפתור כדי לקבוע סיסמה חדשה:
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
        <tr><td align="center">
          <a href="${resetUrl}" target="_blank" style="display:inline-block;background:#fbbf24;color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">לאיפוס הסיסמה</a>
        </td></tr>
      </table>
      <p style="font-size:12px;line-height:1.6;margin:0 0 6px;color:#9ca3af;">
        או הדבק את הקישור הבא לדפדפן:
      </p>
      <p dir="ltr" style="font-size:11px;line-height:1.5;margin:0 0 22px;color:#d1d5db;word-break:break-all;text-align:left;direction:ltr;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;">
        ${resetUrl}
      </p>
      <p style="font-size:12px;line-height:1.6;margin:0 0 14px;color:#9ca3af;">
        ⚠️ הקישור תקף לשעה אחת בלבד.
      </p>
      <p style="font-size:11px;line-height:1.6;margin:24px 0 0;color:#6b7280;">
        לא ביקשת לאפס סיסמה? פשוט התעלם מהמייל הזה — אף אחד לא יכול להחליף לך את הסיסמה בלי לחיצה על הקישור למעלה.
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to,
    subject: 'איפוס סיסמה — ניהול הורדות פלוס',
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
      // Email not registered — don't leak that fact to the caller.
      // Same response shape as a successful send: an attacker
      // probing the endpoint can't tell which addresses exist.
      // The legitimate user gets nothing, but their next attempt
      // (with the correct address) succeeds. We log so we can spot
      // abuse later.
      const code = (err as { code?: string }).code || ''
      if (
        code === 'auth/user-not-found' ||
        code === 'auth/email-not-found'
      ) {
        console.warn('reset-password: no user for', email)
        return res.status(200).json({ ok: true })
      }
      throw err
    }

    await sendResetEmail(email, resetLink)
    return res.status(200).json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('reset-password handler failed', err)
    return res.status(500).json({ ok: false, error: message })
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
  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="color-scheme" content="only dark"/>
  <meta name="supported-color-schemes" content="only dark"/>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e5e7eb;direction:rtl;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#1a1a1a;border-radius:12px;overflow:hidden;border:1px solid #2a2a2a;">
<tr><td style="padding:32px;text-align:right;direction:rtl;">
  <h1 style="font-size:18px;margin:0 0 16px;color:#fbbf24;font-weight:600;direction:rtl;text-align:right;">ניהול הורדות פלוס</h1>
  <h2 style="font-size:24px;margin:0 0 12px;color:#e5e7eb;font-weight:700;direction:rtl;text-align:right;">${args.heading}</h2>
  ${args.contentHtml}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}
