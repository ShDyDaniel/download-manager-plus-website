import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'

/**
 * Daily Vercel cron — scans `productKeys` for licenses that will
 * expire in the next 2 days and haven't been reminded yet, and
 * sends each buyer a "renew now" email with a signed link to
 * /buy?renew=<token>.
 *
 * Schedule lives in vercel.json. Hobby plan allows 1 cron per
 * project, which fits — one daily pass at 09:00 UTC (≈ noon Israel
 * time, when people are most likely to actually read email).
 *
 * Security:
 *   Vercel signs cron requests with the CRON_SECRET env var; we
 *   reject anything without a matching Authorization header. This
 *   stops random callers from hammering the endpoint and bursting
 *   our Gmail quota.
 *
 * Reminder window logic:
 *   - look for keys expiring within REMINDER_LEAD_DAYS (currently 2)
 *   - skip keys with reminderSentAt within the last cycle
 *   - on send, stamp reminderSentAt = now so the next pass doesn't
 *     spam the same buyer
 *
 * Renewal anchors back to /api/capture via a JWT we sign here. The
 * JWT format and secret mirror the one in api/capture.ts and
 * api/renew/info.ts (kept duplicated on purpose — sharing modules
 * across Vercel functions has bitten us before).
 */

const REMINDER_LEAD_DAYS = 2
const REMINDER_TOKEN_TTL_DAYS = 7
const WEBSITE_BASE = 'https://dm-plus.vercel.app'

interface KeyDoc {
  key: string
  buyerEmail?: string
  /** Set when the key has been redeemed by an account. Used as a
   *  fallback recipient when buyerEmail is missing (legacy keys
   *  predating the buyerEmail field still have this from the redeem
   *  flow, which lets the renewal cron find them anyway). */
  redeemedByEmail?: string
  expiresAt?: string
  tier?: string
  reminderSentAt?: string | null
  // Some legacy docs store buyer uid here.
  buyerUid?: string
  redeemedBy?: string | null
}

// ----- JWT (sign) ----------------------------------------------------

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function renewTokenSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  return Buffer.from(s, 'hex')
}

function signRenewToken(uid: string, key: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + REMINDER_TOKEN_TTL_DAYS * 86400
  const header = b64urlEncode(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ uid, key, iat, exp })),
  )
  const signature = b64urlEncode(
    crypto
      .createHmac('sha256', renewTokenSecret())
      .update(`${header}.${payload}`)
      .digest(),
  )
  return `${header}.${payload}.${signature}`
}

// ----- Firebase ------------------------------------------------------

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

// ----- Email ---------------------------------------------------------

function formatExpiryHebrew(date: Date): string {
  return date.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem',
  })
}

function daysUntil(date: Date): number {
  return Math.max(
    0,
    Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  )
}

async function sendReminderEmail(
  to: string,
  renewUrl: string,
  expiresAt: Date,
): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set')
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const dateStr = formatExpiryHebrew(expiresAt)
  const days = daysUntil(expiresAt)
  const daysWord = days === 1 ? 'יום אחד' : `${days} ימים`
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="only dark" />
    <meta name="supported-color-schemes" content="only dark" />
    <title>חידוש מנוי</title>
    <style>
      :root { color-scheme: only dark; supported-color-schemes: only dark; }
      body, table, td { background-color:#0b0b14 !important; }
      .email-bg { background-color:#0b0b14 !important; }
      .email-card { background-color:#14141f !important; }
      .text-default { color:#e5e7eb !important; }
      .text-amber { color:#fbbf24 !important; }
      .text-muted { color:#9ca3af !important; }
      .text-faint { color:#6b7280 !important; }
      .cta-btn { background:linear-gradient(to left,#f59e0b,#f97316) !important; color:#0b0b14 !important; }
      @media (prefers-color-scheme: light) {
        .email-bg { background-color:#0b0b14 !important; }
        .email-card { background-color:#14141f !important; }
        .text-default { color:#e5e7eb !important; }
        .text-amber { color:#fbbf24 !important; }
        .text-muted { color:#9ca3af !important; }
        .text-faint { color:#6b7280 !important; }
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
                <h1 dir="rtl" class="text-amber" style="margin:0 0 16px;font-size:22px;color:#fbbf24;text-align:right;direction:rtl;font-weight:700;">⏳ המנוי שלך עומד להסתיים</h1>
                <p dir="rtl" class="text-default" style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#e5e7eb;text-align:right;direction:rtl;">
                  המפתח שלך לתוכנה <strong>ניהול הורדות פלוס</strong> פג בעוד <strong>${daysWord}</strong> (${dateStr}).
                </p>
                <p dir="rtl" class="text-default" style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#e5e7eb;text-align:right;direction:rtl;">
                  לחיצה על הכפתור למטה תעביר אותך לעמוד החידוש. המפתח שלך נשאר אותו דבר — אין מה לעדכן באפליקציה, פשוט מאריכים את התוקף.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px;">
                  <tr>
                    <td align="center">
                      <a href="${renewUrl}" target="_blank" class="cta-btn" style="display:inline-block;padding:14px 36px;border-radius:12px;background:linear-gradient(to left,#f59e0b,#f97316);color:#0b0b14;text-decoration:none;font-weight:700;font-size:15px;">
                        חידוש המנוי 👑
                      </a>
                    </td>
                  </tr>
                </table>
                <p dir="rtl" class="text-muted" style="margin:0 0 6px;font-size:12px;color:#9ca3af;text-align:right;direction:rtl;">
                  או העתיקו את הקישור הבא:
                </p>
                <p dir="ltr" class="text-faint" style="margin:0;font-size:11px;line-height:1.5;color:#6b7280;word-break:break-all;text-align:left;direction:ltr;font-family:'SF Mono',Menlo,Consolas,monospace;">
                  ${renewUrl}
                </p>
                <p dir="rtl" class="text-faint" style="margin:22px 0 0;font-size:11px;color:#6b7280;text-align:right;direction:rtl;">
                  הקישור תקף ל-${REMINDER_TOKEN_TTL_DAYS} ימים. לא רוצים להמשיך? אל תעשו כלום — המנוי פג מעצמו.
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
    subject: `⏳ המנוי שלך מסתיים בעוד ${daysWord} — חידוש בלחיצה`,
    html,
  })
}

// ----- Cron handler --------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron hits us with `Authorization: Bearer <CRON_SECRET>`.
  // Reject anything else so the endpoint can't be invoked by random
  // outsiders to drain our Gmail quota.
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const auth = req.headers['authorization']
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' })
    }
  }

  try {
    const app = getFirebase()
    const db = getFirestore(app)

    const now = Date.now()
    const windowEnd = now + REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000

    // Pull every Pro key whose expiry falls inside our reminder
    // window. We filter post-fetch by reminderSentAt because that
    // field may not exist on legacy docs (Firestore where() on a
    // missing field excludes the doc entirely).
    const snap = await db
      .collection('productKeys')
      .where('expiresAt', '>=', new Date(now).toISOString())
      .where('expiresAt', '<=', new Date(windowEnd).toISOString())
      .get()

    const results: Array<{
      key: string
      action: 'sent' | 'skipped' | 'failed'
      reason?: string
    }> = []

    for (const doc of snap.docs) {
      const data = doc.data() as KeyDoc
      const key = doc.id
      // Prefer buyerEmail (set at purchase time) but fall back to
      // redeemedByEmail (set at redeem time) so legacy keys that
      // pre-date the buyerEmail field still get reminders. They go
      // to the same person 99% of the time anyway — the user who
      // pays is usually the same user who redeems.
      const buyerEmail = (
        data.buyerEmail || data.redeemedByEmail || ''
      ).trim()
      const expiresAtIso = data.expiresAt
      const reminderAt = data.reminderSentAt

      if (!buyerEmail) {
        results.push({ key, action: 'skipped', reason: 'no buyer email' })
        continue
      }
      if (!expiresAtIso) {
        results.push({ key, action: 'skipped', reason: 'no expiry' })
        continue
      }
      // Already reminded for THIS cycle? If reminder was sent after
      // the most recent renewal cutoff, skip. We treat any prior
      // reminder within the past REMINDER_LEAD_DAYS as "fresh
      // enough" — extendLicense clears reminderSentAt on renewal so
      // the next cycle reminds again.
      if (reminderAt) {
        results.push({ key, action: 'skipped', reason: 'already reminded' })
        continue
      }

      // The user's uid lives in either buyerUid or redeemedBy
      // depending on when the doc was created. Renewal works without
      // it (we identify by `key` from the token), but we still
      // include it in the JWT for audit + future use.
      const uid = data.buyerUid || data.redeemedBy || ''
      const token = signRenewToken(uid, key)
      const renewUrl = `${WEBSITE_BASE}/buy?renew=${encodeURIComponent(token)}`
      const expiresAt = new Date(expiresAtIso)

      try {
        await sendReminderEmail(buyerEmail, renewUrl, expiresAt)
        await doc.ref.update({
          reminderSentAt: new Date().toISOString(),
        })
        results.push({ key, action: 'sent' })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown'
        console.error(`cron: failed to send reminder for ${key}:`, err)
        results.push({ key, action: 'failed', reason: message })
      }
    }

    const sent = results.filter((r) => r.action === 'sent').length
    const skipped = results.filter((r) => r.action === 'skipped').length
    const failed = results.filter((r) => r.action === 'failed').length
    console.info(
      `[cron/expiry-reminders] scanned ${results.length} keys; sent=${sent} skipped=${skipped} failed=${failed}`,
    )
    return res.status(200).json({
      ok: true,
      scanned: results.length,
      sent,
      skipped,
      failed,
      results,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('cron/expiry-reminders failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
