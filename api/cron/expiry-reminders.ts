import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import nodemailer from 'nodemailer'

/**
 * Daily Vercel cron — scans `productKeys` for licenses that fall
 * inside any of our reminder windows and haven't been reminded for
 * that specific window yet, and sends each buyer a "renew now"
 * email with a signed link to /buy?renew=<token>.
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
 * Reminder schedule — two passes per key:
 *   - 10 days out: gentle heads-up, plenty of time to renew
 *   - 2 days out: last-chance nudge
 *
 *   Each pass is tracked by its own timestamp field on the key
 *   doc (reminder10dSentAt / reminder2dSentAt). On renewal the
 *   capture endpoint clears BOTH so the next cycle's reminders
 *   fire fresh. The windows are wide enough that a missed cron
 *   day (Vercel maintenance, network blip, whatever) still catches
 *   the next day — we'd rather double-stamp a flag than miss a
 *   reminder entirely.
 *
 * Renewal anchors back to /api/capture via a JWT we sign here. The
 * JWT format and secret mirror the one in api/capture.ts and
 * api/renew/info.ts (kept duplicated on purpose — sharing modules
 * across Vercel functions has bitten us before).
 */

const REMINDER_TOKEN_TTL_DAYS = 14
const WEBSITE_BASE = 'https://dm-plus.vercel.app'

/** Stages of the reminder pipeline. Order matters only for the
 *  loop below — we check them sequentially and break after the
 *  first one that fires for a given key, so the cron never sends
 *  both reminders on the same run even if a key somehow ended up
 *  in both windows. */
const REMINDER_STAGES = [
  {
    kind: '10d' as const,
    /** Field name on the key doc for "this stage already sent". */
    sentField: 'reminder10dSentAt',
    /** Inclusive window: a key in [daysMin, daysMax] triggers this
     *  reminder. Wider than 1 day to absorb the case where the cron
     *  misses a day (we'd rather catch them on day 9 than skip). */
    daysMin: 7,
    daysMax: 10,
  },
  {
    kind: '2d' as const,
    sentField: 'reminder2dSentAt',
    daysMin: 0,
    daysMax: 2,
  },
] as const

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
  /** Legacy single-reminder field — ignored by the new logic but
   *  retained on doc reads so the typecheck doesn't blow up on old
   *  data. The new fields below replace it. */
  reminderSentAt?: string | null
  /** Stamped when the 10-day-out reminder is sent. Missing/null =
   *  not yet sent for the current cycle. */
  reminder10dSentAt?: string | null
  /** Stamped when the 2-day-out reminder is sent. */
  reminder2dSentAt?: string | null
  // Some legacy docs store buyer uid here.
  buyerUid?: string
  redeemedBy?: string | null
  /** When set, this key is backed by an auto-renewing PayPal
   *  subscription — the user doesn't need our manual-renewal
   *  reminders because PayPal handles the recurring charge. We
   *  skip these in the 10d/2d reminder loop. */
  subscriptionId?: string
  subscriptionPlanDays?: number
  billingHistory?: Array<{
    eventId?: string
    amount?: number
    currency?: string
    at?: string
  }>
  // Annual-report stamp fields like `annualReport2026SentAt` are
  // accessed dynamically (the year is computed at runtime), so we
  // don't declare them in this interface. The reader casts the
  // doc through Record<string, unknown> for the typed lookup.
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

    // Widest reminder window currently configured — used as the
    // upper bound on the Firestore query. Everything between now
    // and that horizon comes back and we filter per-stage in JS.
    const horizonDays = Math.max(
      ...REMINDER_STAGES.map((s) => s.daysMax),
    )
    const now = Date.now()
    const horizonEnd = now + horizonDays * 24 * 60 * 60 * 1000

    const snap = await db
      .collection('productKeys')
      .where('expiresAt', '>=', new Date(now).toISOString())
      .where('expiresAt', '<=', new Date(horizonEnd).toISOString())
      .get()

    const results: Array<{
      key: string
      stage?: '10d' | '2d'
      action: 'sent' | 'skipped' | 'failed'
      reason?: string
    }> = []

    for (const doc of snap.docs) {
      const data = doc.data() as KeyDoc
      const key = doc.id
      const buyerEmail = (
        data.buyerEmail || data.redeemedByEmail || ''
      ).trim()
      const expiresAtIso = data.expiresAt

      // Subscription keys auto-renew via PayPal — sending them a
      // "manually renew" email would be confusing and might prompt
      // duplicate payments. The PayPal webhook handles the renewal
      // and extends expiresAt without our cron's help.
      if (data.subscriptionId) {
        results.push({ key, action: 'skipped', reason: 'auto-renewing subscription' })
        continue
      }

      if (!buyerEmail) {
        results.push({ key, action: 'skipped', reason: 'no buyer email' })
        continue
      }
      if (!expiresAtIso) {
        results.push({ key, action: 'skipped', reason: 'no expiry' })
        continue
      }

      const expiresAt = new Date(expiresAtIso)
      const daysLeft = Math.ceil(
        (expiresAt.getTime() - now) / (24 * 60 * 60 * 1000),
      )

      // Find the first stage this key qualifies for. We break after
      // sending so a single cron run never fires two reminders on
      // the same key — even with weirdly overlapping windows the
      // user gets one email per day at most.
      let firedStage:
        | { kind: '10d' | '2d'; sentField: string }
        | undefined
      for (const stage of REMINDER_STAGES) {
        if (daysLeft < stage.daysMin || daysLeft > stage.daysMax) continue
        // Per-stage idempotency: each stage has its own *SentAt
        // field; once stamped we don't re-send for the same cycle.
        // extendLicense in capture.ts clears both stamps on renewal
        // so the new cycle gets a fresh shot at both reminders.
        // Double-cast through `unknown` is required because KeyDoc
        // has no general string index signature, and Vercel's
        // per-function tsc rejects the direct `as Record<...>` cast.
        const alreadySent = (data as unknown as Record<string, unknown>)[
          stage.sentField
        ] as string | null | undefined
        if (alreadySent) continue
        firedStage = stage
        break
      }

      if (!firedStage) {
        results.push({
          key,
          action: 'skipped',
          reason: `outside any window or already reminded (daysLeft=${daysLeft})`,
        })
        continue
      }

      // The user's uid lives in either buyerUid or redeemedBy
      // depending on when the doc was created. Renewal works without
      // it (we identify by `key` from the token), but we still
      // include it in the JWT for audit + future use.
      const uid = data.buyerUid || data.redeemedBy || ''
      const token = signRenewToken(uid, key)
      const renewUrl = `${WEBSITE_BASE}/buy?renew=${encodeURIComponent(token)}`

      try {
        await sendReminderEmail(buyerEmail, renewUrl, expiresAt)
        await doc.ref.update({
          [firedStage.sentField]: new Date().toISOString(),
        })
        results.push({ key, stage: firedStage.kind, action: 'sent' })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown'
        console.error(
          `cron: failed to send ${firedStage.kind} reminder for ${key}:`,
          err,
        )
        results.push({
          key,
          stage: firedStage.kind,
          action: 'failed',
          reason: message,
        })
      }
    }

    const sent = results.filter((r) => r.action === 'sent').length
    const skipped = results.filter((r) => r.action === 'skipped').length
    const failed = results.filter((r) => r.action === 'failed').length
    console.info(
      `[cron/expiry-reminders] scanned ${results.length} keys; sent=${sent} skipped=${skipped} failed=${failed}`,
    )

    // ─── Annual billing report (sec. 13ב(ב1)) ─────────────────
    // Once a year, on March 1st (Israel time), email each
    // subscriber a summary of every charge from the previous
    // calendar year. This is a hard legal requirement for
    // continuing transactions, regardless of how the user is
    // billed. Idempotent — each key gets stamped with
    // annualReport{YEAR}SentAt so a re-run on the same day
    // doesn't double-send.
    const annualResults = await maybeSendAnnualReports(db)

    return res.status(200).json({
      ok: true,
      scanned: results.length,
      sent,
      skipped,
      failed,
      results,
      annual: annualResults,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('cron/expiry-reminders failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

// ─── Annual billing report ────────────────────────────────────

/** Check if today is March 1st (Israel time). The annual report is
 *  triggered on this date per sec. 13ב(ב1) — the law says "during
 *  March" but most practitioners interpret as "early in March", and
 *  the 1st gives users the maximum time to review/dispute. */
function isMarchFirstIsraelTime(): boolean {
  // Convert "now" to Israel time by formatting through Intl, then
  // parsing the resulting MM-DD. Simpler than a tz library; works
  // because we only care about the date, not exact moment.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.format(new Date()).split('-')
  // 'en-CA' gives YYYY-MM-DD, but with the format above we only
  // get MM-DD. The parts will be ['03', '01'] on March 1st.
  if (parts.length === 2) {
    return parts[0] === '03' && parts[1] === '01'
  }
  // Defensive: if parsing weird, just don't send (better than
  // false positive).
  return false
}

async function maybeSendAnnualReports(
  db: ReturnType<typeof getFirestore>,
): Promise<{ ran: boolean; sent: number; failed: number; skipped: number }> {
  if (!isMarchFirstIsraelTime()) {
    return { ran: false, sent: 0, failed: 0, skipped: 0 }
  }
  const year = new Date().getFullYear() - 1 // report for PREVIOUS year
  const stampField = `annualReport${year}SentAt` as const
  const yearStart = new Date(`${year}-01-01T00:00:00Z`).toISOString()
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00Z`).toISOString()

  // Pull every productKey backed by a subscription that has any
  // billing history. We can't filter inside Firestore (Firestore
  // doesn't support array-of-objects-with-date predicates) so we
  // post-filter in code.
  const snap = await db
    .collection('productKeys')
    .where('subscriptionId', '!=', null)
    .get()

  let sent = 0
  let failed = 0
  let skipped = 0
  for (const doc of snap.docs) {
    const data = doc.data() as KeyDoc
    const recipient = (data.buyerEmail || data.redeemedByEmail || '').trim()
    if (!recipient) {
      skipped += 1
      continue
    }
    // Already sent this year's report? Skip. Cast through unknown
    // because the stamp field name (annualReport{year}SentAt) is
    // computed at runtime — KeyDoc doesn't declare it statically.
    if ((data as unknown as Record<string, unknown>)[stampField]) {
      skipped += 1
      continue
    }
    // Filter the billing history to last calendar year's charges.
    const charges = (data.billingHistory || []).filter((c) => {
      if (!c.at) return false
      return c.at >= yearStart && c.at < yearEnd
    })
    if (charges.length === 0) {
      skipped += 1
      continue
    }
    try {
      await sendAnnualReportEmail({
        to: recipient,
        year,
        charges,
        keyId: doc.id,
      })
      await doc.ref.update({ [stampField]: new Date().toISOString() })
      sent += 1
    } catch (err) {
      console.error(`annual report failed for ${doc.id}:`, err)
      failed += 1
    }
  }
  return { ran: true, sent, failed, skipped }
}

async function sendAnnualReportEmail(args: {
  to: string
  year: number
  charges: Array<{ amount?: number; currency?: string; at?: string }>
  keyId: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  // Build the table of charges
  const totalByCurrency: Record<string, number> = {}
  const rows = args.charges
    .slice()
    .sort((a, b) => (a.at || '').localeCompare(b.at || ''))
    .map((c) => {
      const amount = c.amount || 0
      const cur = c.currency || 'ILS'
      totalByCurrency[cur] = (totalByCurrency[cur] || 0) + amount
      const dateStr = c.at
        ? new Date(c.at).toLocaleDateString('he-IL', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'Asia/Jerusalem',
          })
        : '—'
      const sym = cur === 'ILS' ? '₪' : cur === 'USD' ? '$' : cur
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #2a2a3a;color:#e5e7eb;">${dateStr}</td><td style="padding:6px 12px;border-bottom:1px solid #2a2a3a;color:#fbbf24;text-align:left;direction:ltr;">${amount} ${sym}</td></tr>`
    })
    .join('')
  const totalsHtml = Object.entries(totalByCurrency)
    .map(([cur, amt]) => {
      const sym = cur === 'ILS' ? '₪' : cur === 'USD' ? '$' : cur
      return `<strong style="color:#fbbf24;">${amt} ${sym}</strong>`
    })
    .join(' / ')
  const html = `<!doctype html>
<html lang="he" dir="rtl">
  <head><meta charset="utf-8"/><meta name="color-scheme" content="only dark"/></head>
  <body style="margin:0;padding:0;background-color:#0b0b14;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;direction:rtl;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#0b0b14;">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;background-color:#14141f;border-radius:16px;border:1px solid #2a2a3a;">
          <tr><td style="padding:32px;text-align:right;direction:rtl;">
            <h1 style="margin:0 0 16px;font-size:22px;color:#fbbf24;font-weight:700;">סיכום חיובים שנתי — ${args.year}</h1>
            <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#e5e7eb;">
              ריכוז כל החיובים שבוצעו על המנוי שלך ל-<strong>ניהול הורדות פלוס</strong> במהלך ${args.year}.
              מסמך זה נשלח אליך אחת לשנה לפי דרישת חוק הגנת הצרכן.
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0;border:1px solid #2a2a3a;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#0b0b14;">
                  <th style="padding:8px 12px;text-align:right;color:#9ca3af;font-weight:500;font-size:12px;">תאריך</th>
                  <th style="padding:8px 12px;text-align:left;color:#9ca3af;font-weight:500;font-size:12px;direction:ltr;">סכום</th>
                </tr>
              </thead>
              <tbody style="font-size:13px;">${rows}</tbody>
            </table>
            <p style="margin:14px 0;font-size:14px;color:#e5e7eb;text-align:right;">
              <strong>סה״כ ${args.year}:</strong> ${totalsHtml}
            </p>
            <p style="margin:24px 0 0;font-size:11px;color:#6b7280;">
              שאלות? תשובה ישירה למייל הזה תגיע לתמיכה.
            </p>
            <p style="margin:8px 0 0;font-size:11px;color:#6b7280;">
              לניהול או ביטול המנוי: <a href="https://dm-plus.vercel.app/manage" style="color:#fbbf24;">ניהול תוכנית</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: `סיכום חיובים שנתי — ${args.year}`,
    html,
  })
}
