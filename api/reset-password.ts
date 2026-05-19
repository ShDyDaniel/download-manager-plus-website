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
  // Same dark-mode lock as the license email — see capture.ts for
  // the rationale. Style block + bgcolor attributes + inline styles
  // + `only dark` color-scheme work together to keep the dark theme
  // intact across mobile clients that like to auto-invert.
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="only dark" />
    <meta name="supported-color-schemes" content="only dark" />
    <title>איפוס סיסמה</title>
    <style>
      :root { color-scheme: only dark; supported-color-schemes: only dark; }
      body, table, td { background-color:#0b0b14 !important; }
      .email-bg { background-color:#0b0b14 !important; }
      .email-card { background-color:#14141f !important; }
      .text-default { color:#e5e7eb !important; }
      .text-amber { color:#fbbf24 !important; }
      .text-muted { color:#9ca3af !important; }
      .text-faint { color:#6b7280 !important; }
      .text-list { color:#d1d5db !important; }
      .btn-primary { background-color:#fbbf24 !important; color:#0b0b14 !important; }
      [data-ogsc] .email-bg { background-color:#0b0b14 !important; }
      [data-ogsc] .email-card { background-color:#14141f !important; }
      [data-ogsc] .text-default { color:#e5e7eb !important; }
      [data-ogsc] .text-amber { color:#fbbf24 !important; }
      [data-ogsc] .text-muted { color:#9ca3af !important; }
      [data-ogsc] .text-faint { color:#6b7280 !important; }
      [data-ogsc] .text-list { color:#d1d5db !important; }
      [data-ogsc] .btn-primary { background-color:#fbbf24 !important; color:#0b0b14 !important; }
      @media (prefers-color-scheme: light) {
        .email-bg { background-color:#0b0b14 !important; }
        .email-card { background-color:#14141f !important; }
        .text-default { color:#e5e7eb !important; }
        .text-amber { color:#fbbf24 !important; }
        .text-muted { color:#9ca3af !important; }
        .text-faint { color:#6b7280 !important; }
        .text-list { color:#d1d5db !important; }
        .btn-primary { background-color:#fbbf24 !important; color:#0b0b14 !important; }
      }
    </style>
  </head>
  <body class="email-bg" bgcolor="#0b0b14" dir="rtl" style="margin:0;padding:0;background-color:#0b0b14;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;direction:rtl;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="#0b0b14" class="email-bg" style="background-color:#0b0b14;">
      <tr>
        <td align="center" bgcolor="#0b0b14" class="email-bg" style="padding:32px 16px;background-color:#0b0b14;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" bgcolor="#14141f" class="email-card" style="max-width:560px;width:100%;background-color:#14141f;border-radius:16px;border:1px solid #2a2a3a;">
            <tr>
              <td dir="rtl" bgcolor="#14141f" class="email-card" style="padding:32px;text-align:right;direction:rtl;background-color:#14141f;">
                <h1 dir="rtl" class="text-amber" style="margin:0 0 16px;font-size:22px;color:#fbbf24;text-align:right;direction:rtl;font-weight:700;">איפוס סיסמה 🔑</h1>
                <p dir="rtl" class="text-default" style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#e5e7eb;text-align:right;direction:rtl;">
                  קיבלנו בקשה לאיפוס הסיסמה לחשבון שלך ב-<strong>ניהול הורדות פלוס</strong>.
                </p>
                <p dir="rtl" class="text-default" style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#e5e7eb;text-align:right;direction:rtl;">
                  לחץ על הכפתור כדי לקבוע סיסמה חדשה:
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;">
                  <tr>
                    <td align="center">
                      <a href="${resetUrl}" target="_blank" class="btn-primary" style="display:inline-block;background-color:#fbbf24;color:#0b0b14;padding:13px 34px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">לאיפוס הסיסמה</a>
                    </td>
                  </tr>
                </table>
                <p dir="rtl" class="text-muted" style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af;text-align:right;direction:rtl;">
                  או הדבק את הקישור הבא לדפדפן:
                </p>
                <p dir="ltr" class="text-list" style="margin:0 0 22px;font-size:11px;line-height:1.5;color:#d1d5db;word-break:break-all;text-align:left;direction:ltr;font-family:'SF Mono',Menlo,Consolas,monospace;">
                  ${resetUrl}
                </p>
                <p dir="rtl" class="text-muted" style="margin:0 0 14px;font-size:12px;line-height:1.6;color:#9ca3af;text-align:right;direction:rtl;">
                  ⚠️ הקישור תקף לשעה אחת בלבד.
                </p>
                <p dir="rtl" class="text-faint" style="margin:24px 0 0;font-size:11px;line-height:1.6;color:#6b7280;text-align:right;direction:rtl;">
                  לא ביקשת לאפס סיסמה? פשוט התעלם מהמייל הזה — אף אחד לא יכול להחליף לך את הסיסמה בלי לחיצה על הקישור למעלה.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
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
