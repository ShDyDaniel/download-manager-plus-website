import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import {
  S3Client,
  DeleteObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import nodemailer from 'nodemailer'

/* ── Outgoing-email counter (twin of api/paypal.ts) ─────────────────
 *  Counts every email into metrics/emailSends (UTC hourly buckets) so
 *  the admin dashboard can show sent-in-24h vs the ~500/day Gmail cap.
 *  The cron is a bulk sender (renewal reminders), so this matters most. */
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
const WEBSITE_BASE = 'https://dmplus.net'

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
  /** PayPal subscription state: 'active' | 'cancelled' | 'expired' |
   *  'past_due'. A cancelled/expired sub no longer auto-renews, so it
   *  qualifies for the expiry reminders below. */
  subscriptionStatus?: string
  subscriptionPlanDays?: number
  billingHistory?: Array<{
    eventId?: string
    amount?: number
    currency?: string
    at?: string
  }>
  // String index signature — makes KeyDoc structurally a Record,
  // which lets us cast freely to Record<string, unknown> for
  // dynamic-key lookups (reminder stamps + annual-report stamps).
  // Without this, TS 5.9's stricter cast rules reject the
  // `as Record<string, unknown>` cast as "non-overlapping types".
  // The unknown value type doesn't downgrade typed properties —
  // TS still resolves `data.expiresAt` as `string | undefined`
  // because explicit properties take precedence over the index
  // signature.
  [field: string]: unknown
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
  // UTF-8 bytes, not hex — see capture.ts comment for the rationale.
  return Buffer.from(s, 'utf8')
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
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const dateStr = formatExpiryHebrew(expiresAt)
  const days = daysUntil(expiresAt)
  const daysWord = days === 1 ? 'יום אחד' : `${days} ימים`
  const html = renderEmail({
    heading: '⏳ המנוי שלך עומד להסתיים',
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        המפתח שלך לתוכנה <strong>ניהול הורדות פלוס</strong> פג בעוד <strong>${daysWord}</strong> (${dateStr}).
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 24px;color:#C9BFA8;">
        לחיצה על הכפתור למטה תעביר אותך לעמוד החידוש. המפתח שלך נשאר אותו דבר — אין מה לעדכן באפליקציה, פשוט מאריכים את התוקף.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;">
        <tr><td align="center">
          <a href="${renewUrl}" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">חידוש המנוי 👑</a>
        </td></tr>
      </table>
      <p style="font-size:12px;margin:0 0 6px;color:#8B8170;">
        או העתיקו את הקישור הבא:
      </p>
      <p dir="ltr" style="font-size:11px;line-height:1.5;margin:0;color:#5C5444;word-break:break-all;text-align:left;direction:ltr;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;">
        ${renewUrl}
      </p>
      <p style="font-size:11px;margin:22px 0 0;color:#5C5444;">
        הקישור תקף ל-${REMINDER_TOKEN_TTL_DAYS} ימים. לא רוצים להמשיך? אל תעשו כלום — המנוי פג מעצמו.
      </p>
    `,
  })
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

      // Auto-renewing subscriptions handle themselves via PayPal —
      // reminding them to "manually renew" would confuse + risk a
      // double charge. BUT a subscription the user CANCELLED won't
      // renew: it just runs out at expiresAt, so those users DO need
      // the heads-up. So we skip only subscriptions still live in
      // PayPal (status active / past_due / unset). 'cancelled' and
      // 'expired' fall through to the reminder windows below.
      const subStatus = String(data.subscriptionStatus || '').toLowerCase()
      const subWillAutoRenew =
        Boolean(data.subscriptionId) &&
        subStatus !== 'cancelled' &&
        subStatus !== 'expired'
      if (subWillAutoRenew) {
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

    // ─── Storage purge sweep ──────────────────────────────────
    // Warn-then-delete the R2 videos of users who lost access (lapsed
    // subscription / ended trial). Two emails, then deletion after the
    // grace window. Runs in this same daily cron (Hobby = 1 cron).
    const purgeResults = await runStoragePurgeSweep(db)

    // ─── Daily Firestore backup → R2 ──────────────────────────
    // Free safety net: one full logical snapshot per day, kept for 30
    // days. Manageable from the admin "גיבוי" tab.
    const backupResults = await runFirestoreBackupSweep(db, getR2OrNull())

    return res.status(200).json({
      ok: true,
      scanned: results.length,
      sent,
      skipped,
      failed,
      results,
      annual: annualResults,
      purge: purgeResults,
      backup: backupResults,
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
  const transporter = makeCountedTransport({
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
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #2a2a3a;color:#F5EFE6;">${dateStr}</td><td style="padding:6px 12px;border-bottom:1px solid #2a2a3a;color:#D4A574;text-align:left;direction:ltr;">${amount} ${sym}</td></tr>`
    })
    .join('')
  const totalsHtml = Object.entries(totalByCurrency)
    .map(([cur, amt]) => {
      const sym = cur === 'ILS' ? '₪' : cur === 'USD' ? '$' : cur
      return `<strong style="color:#D4A574;">${amt} ${sym}</strong>`
    })
    .join(' / ')
  const html = renderEmail({
    heading: `סיכום חיובים שנתי — ${args.year}`,
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 18px;color:#C9BFA8;">
        ריכוז כל החיובים שבוצעו על המנוי שלך ל-<strong>ניהול הורדות פלוס</strong> במהלך ${args.year}.
        מסמך זה נשלח אליך אחת לשנה לפי דרישת חוק הגנת הצרכן.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;border:1px solid rgba(245,239,230,0.08);border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#16110D;">
            <th style="padding:10px 12px;text-align:right;color:#8B8170;font-weight:500;font-size:12px;">תאריך</th>
            <th style="padding:10px 12px;text-align:left;color:#8B8170;font-weight:500;font-size:12px;direction:ltr;">סכום</th>
          </tr>
        </thead>
        <tbody style="font-size:13px;">${rows}</tbody>
      </table>
      <p style="margin:14px 0;font-size:14px;color:#F5EFE6;">
        <strong>סה״כ ${args.year}:</strong> ${totalsHtml}
      </p>
      <p style="margin:24px 0 0;font-size:11px;color:#5C5444;">
        שאלות? תשובה ישירה למייל הזה תגיע לתמיכה.
      </p>
      <p style="margin:8px 0 0;font-size:11px;color:#5C5444;">
        לניהול או ביטול המנוי: <a href="https://dmplus.net/account" style="color:#D4A574;text-decoration:underline;">החשבון שלי</a>
      </p>
    `,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: `סיכום חיובים שנתי — ${args.year}`,
    html,
  })
}

/* ═══════════════════════════════════════════════════════════════
 *  Storage purge — warn-then-delete R2 files for lapsed users
 *
 *  Users who lose access (subscription expired / cancelled-and-ended,
 *  or a 14-day trial that ended) can't reach their Revisions videos.
 *  We don't delete immediately — a grace window lets them renew and
 *  "rescue" their files. Per-user timeline (tracked on the user doc):
 *    - day 0  (first run with no access): warning #1 + stamp filesPurgeAt
 *    - day 11 (3 days before): warning #2 (final)
 *    - day 14 (>= filesPurgeAt): delete every R2 video + note media,
 *      free the quota.
 *  Regaining access clears the countdown. Only OUR R2 storage is
 *  touched — Google-Drive videos live in the user's own Drive and are
 *  never deleted by us.
 * ═══════════════════════════════════════════════════════════════ */

const PURGE_GRACE_DAYS = 14
const PURGE_FINAL_WARN_DAYS = 3
const R2_BUCKET = (process.env.R2_BUCKET || '').trim()

let _r2: S3Client | null = null
function getR2OrNull(): S3Client | null {
  if (_r2) return _r2
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey || !R2_BUCKET) return null
  _r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return _r2
}

async function r2Delete(r2: S3Client, key: string): Promise<void> {
  if (!key) return
  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
}

/* ── Daily Firestore backup → R2 ───────────────────────────────────
 *  Twin of api/paypal.ts createBackup('auto'). KEEP BACKUP_COLLECTIONS
 *  + serializeForBackup in sync with paypal.ts. Writes one JSON
 *  snapshot per day under backups/auto-*.json and prunes to the most
 *  recent BACKUP_KEEP_AUTO. Skips silently if R2 isn't configured. */
const BACKUP_PREFIX = 'backups/'
const BACKUP_KEEP_AUTO = 30
const BACKUP_COLLECTIONS = [
  'productKeys',
  'users',
  'appConfig',
  'referralPartners',
  'receipts',
  'trialFingerprints',
  'usageStats',
  'feedback',
  'integrations',
  'pendingSubscriptions',
  'adminCredentials',
  'adminSecurity',
  'revisionProjects',
  'revisionGroups',
  'notes',
]
function serializeForBackup(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  const t = v as { toDate?: () => Date; seconds?: number }
  if (typeof t.toDate === 'function' && typeof t.seconds === 'number') {
    return { __t: 'ts', v: t.toDate().toISOString() }
  }
  if (Array.isArray(v)) return v.map(serializeForBackup)
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = serializeForBackup(val)
  }
  return out
}

/** Best-effort Telegram alert (twin of api/paypal.ts). */
async function backupTelegramAlert(text: string): Promise<void> {
  try {
    const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
    if (!token || !chatId) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    })
  } catch {
    /* ignore */
  }
}

async function runFirestoreBackupSweep(
  db: FirebaseFirestore.Firestore,
  r2: S3Client | null,
): Promise<{
  ok: boolean
  skipped?: boolean
  reason?: string
  key?: string
  docCount?: number
  pruned?: number
  error?: string
}> {
  if (!r2) return { ok: false, error: 'R2 not configured' }
  try {
    // Read the configured cadence + notify flag.
    let intervalDays = 1
    let notify = false
    try {
      const cfgSnap = await db.collection('appConfig').doc('global').get()
      const cfg = (cfgSnap.exists ? cfgSnap.data() : {}) as {
        backupIntervalDays?: number
        backupNotify?: boolean
      }
      if (typeof cfg.backupIntervalDays === 'number' && cfg.backupIntervalDays >= 1) {
        intervalDays = Math.round(cfg.backupIntervalDays)
      }
      notify = cfg.backupNotify === true
    } catch {
      /* defaults: daily, no notify */
    }

    // List existing auto snapshots (for the due-check + pruning).
    const listed = await r2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: `${BACKUP_PREFIX}auto-`,
      }),
    )
    const autos = (listed.Contents || [])
      .filter((o) => o.Key)
      .sort(
        (a, b) =>
          (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0),
      )

    // Due-check: skip if the newest auto backup is younger than the
    // configured interval (the cron itself still runs daily on Hobby).
    const newest = autos[0]?.LastModified?.getTime() || 0
    const ageMs = Date.now() - newest
    if (newest && ageMs < intervalDays * 24 * 60 * 60 * 1000) {
      return { ok: true, skipped: true, reason: 'not due yet' }
    }

    const docs: Array<{ path: string; data: unknown }> = []
    for (const name of BACKUP_COLLECTIONS) {
      const snap = await db.collectionGroup(name).get()
      for (const d of snap.docs) {
        docs.push({ path: d.ref.path, data: serializeForBackup(d.data()) })
      }
    }
    const createdAt = new Date().toISOString()
    const body = JSON.stringify({
      version: 1,
      createdAt,
      type: 'auto',
      collections: BACKUP_COLLECTIONS,
      docCount: docs.length,
      docs,
    })
    const sizeBytes = Buffer.byteLength(body, 'utf8')
    const key = `${BACKUP_PREFIX}auto-${createdAt.replace(/[:.]/g, '-')}.json`
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    )
    // Prune old auto snapshots (keep the most recent N). Manual + pre-
    // restore + uploaded backups use other prefixes and are left alone.
    let pruned = 0
    for (const o of autos.slice(BACKUP_KEEP_AUTO - 1)) {
      // -1 because we just added one above (not in `autos` yet).
      await r2Delete(r2, o.Key as string)
      pruned += 1
    }
    if (notify) {
      await backupTelegramAlert(
        `💾 גיבוי אוטומטי בוצע\n${docs.length} מסמכים · ${(sizeBytes / 1024).toFixed(0)} KB`,
      )
    }
    return { ok: true, key, docCount: docs.length, pruned }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'backup failed' }
  }
}

// Operators always keep access — mirror the hardcoded admin set used
// by api/revisions.ts (SERVER_ADMIN_EMAILS) and api/paypal.ts
// (ADMIN_EMAILS), keyed by email since an admin's user-doc role isn't
// guaranteed to be 'admin'. Prevents the purge from ever touching an
// operator account.
const PURGE_ADMIN_EMAILS = new Set(['dyshalts@gmail.com'])

/** Does this user currently have access (so we must NOT purge)? Mirrors
 *  the server's isUserPro (admin email + role + subscription + trial +
 *  active key). Throws bubble up; the caller treats any error as
 *  "uncertain → skip", so a Firestore blip never deletes. */
async function userHasAccess(
  db: ReturnType<typeof getFirestore>,
  uid: string,
): Promise<boolean> {
  const userSnap = await db.collection('users').doc(uid).get()
  if (userSnap.exists) {
    const u = userSnap.data() as Record<string, unknown>
    if (PURGE_ADMIN_EMAILS.has(String(u.email || '').toLowerCase())) return true
    if (u.role === 'admin') return true
    if (u.subscription === 'pro') return true
    if (u.trialStatus === 'approved' && u.trialExpiresAt) {
      const ts = new Date(String(u.trialExpiresAt)).getTime()
      if (Number.isFinite(ts) && ts > Date.now()) return true
    }
  }
  const keySnap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', uid)
    .limit(1)
    .get()
  if (!keySnap.empty) {
    const k = keySnap.docs[0].data() as Record<string, unknown>
    if (!k.expiresAt) return true
    const exp = new Date(String(k.expiresAt)).getTime()
    if (!Number.isFinite(exp)) return true
    if (exp > Date.now()) return true
    if (
      k.subscriptionStatus === 'active' &&
      Date.now() - exp <= 24 * 60 * 60 * 1000
    ) {
      return true
    }
  }
  return false
}

/** Global beta mode → everyone has Pro, so we must not purge anyone.
 *  Fail-SAFE: a read error returns true (treat as beta-on) so we never
 *  delete during a Firestore hiccup. */
async function isBetaOn(db: ReturnType<typeof getFirestore>): Promise<boolean> {
  try {
    const cfg = await db.collection('appConfig').doc('global').get()
    return cfg.exists && cfg.data()?.betaMode === true
  } catch {
    return true
  }
}

async function runStoragePurgeSweep(
  db: ReturnType<typeof getFirestore>,
): Promise<{
  ran: boolean
  warned1: number
  warned2: number
  purged: number
  skipped: number
  reason?: string
}> {
  const r2 = getR2OrNull()
  if (!r2) {
    return { ran: false, warned1: 0, warned2: 0, purged: 0, skipped: 0, reason: 'R2 not configured' }
  }
  if (await isBetaOn(db)) {
    return { ran: false, warned1: 0, warned2: 0, purged: 0, skipped: 0, reason: 'beta mode on' }
  }

  // Candidate users = owners of at least one active R2 round.
  const roundsSnap = await db
    .collection('revisionProjects')
    .where('status', '==', 'active')
    .get()
  const byOwner = new Map<
    string,
    Array<{ id: string; r2Key: string; videoSizeBytes: number }>
  >()
  for (const d of roundsSnap.docs) {
    const r = d.data() as {
      ownerUid?: string
      r2Key?: string
      videoSizeBytes?: number
    }
    if (!r.ownerUid || !r.r2Key) continue
    const arr = byOwner.get(r.ownerUid) || []
    arr.push({
      id: d.id,
      r2Key: r.r2Key,
      videoSizeBytes: Number(r.videoSizeBytes) || 0,
    })
    byOwner.set(r.ownerUid, arr)
  }

  const now = Date.now()
  const graceMs = PURGE_GRACE_DAYS * 86_400_000
  const finalWarnMs = PURGE_FINAL_WARN_DAYS * 86_400_000
  let warned1 = 0
  let warned2 = 0
  let purged = 0
  let skipped = 0

  for (const [uid, rounds] of byOwner) {
    try {
      const userRef = db.collection('users').doc(uid)
      const userSnap = await userRef.get()
      const user = (userSnap.data() as Record<string, unknown>) || {}

      if (await userHasAccess(db, uid)) {
        // Has access (or came back) — cancel any running countdown.
        if (user.filesPurgeAt) {
          await userRef.update({
            filesPurgeAt: null,
            purgeWarn1SentAt: null,
            purgeWarn2SentAt: null,
          })
        }
        skipped++
        continue
      }

      // No access. We must have an email to warn before deleting.
      const email = String(user.email || '').trim()
      if (!email) {
        skipped++
        continue
      }

      // Which copy to use — a paid user always has a productKey; a
      // trial-only user doesn't.
      let purgeKind: 'subscription' | 'trial' = 'subscription'
      try {
        const k = await db
          .collection('productKeys')
          .where('redeemedBy', '==', uid)
          .limit(1)
          .get()
        if (k.empty && user.trialStatus) purgeKind = 'trial'
      } catch {
        /* default to subscription copy on lookup error */
      }

      const purgeAt = user.filesPurgeAt
        ? Date.parse(String(user.filesPurgeAt))
        : NaN

      if (!Number.isFinite(purgeAt)) {
        // First detection — start the countdown + warning #1.
        const at = now + graceMs
        await sendPurgeWarningEmail(email, new Date(at), false, purgeKind)
        await userRef.update({
          filesPurgeAt: new Date(at).toISOString(),
          purgeWarn1SentAt: new Date(now).toISOString(),
          purgeWarn2SentAt: null,
        })
        warned1++
        continue
      }

      if (now >= purgeAt) {
        // Grace elapsed → delete every R2 video + its note media.
        for (const rd of rounds) {
          try {
            await r2Delete(r2, rd.r2Key)
            const notesSnap = await db
              .collection('revisionProjects')
              .doc(rd.id)
              .collection('notes')
              .get()
            for (const n of notesSnap.docs) {
              const nd = n.data() as {
                screenshotR2Key?: string
                audioR2Key?: string
              }
              if (nd.screenshotR2Key) {
                await r2Delete(r2, nd.screenshotR2Key).catch(() => undefined)
              }
              if (nd.audioR2Key) {
                await r2Delete(r2, nd.audioR2Key).catch(() => undefined)
              }
            }
            await db.collection('revisionProjects').doc(rd.id).update({
              status: 'archived',
              r2Purged: true,
              updatedAt: now,
            })
          } catch (err) {
            console.warn(`[purge] round ${rd.id} for ${uid} failed:`, err)
          }
        }
        await userRef.update({
          storageUsedBytes: 0,
          filesPurgeAt: null,
          purgeWarn1SentAt: null,
          purgeWarn2SentAt: null,
          filesPurgedAt: new Date(now).toISOString(),
        })
        purged++
        continue
      }

      // Within the grace window — send the final warning once.
      if (now >= purgeAt - finalWarnMs && !user.purgeWarn2SentAt) {
        await sendPurgeWarningEmail(email, new Date(purgeAt), true, purgeKind)
        await userRef.update({ purgeWarn2SentAt: new Date(now).toISOString() })
        warned2++
        continue
      }

      skipped++
    } catch (err) {
      console.warn(`[purge] skipping ${uid} (error):`, err)
      skipped++
    }
  }

  console.info(
    `[cron/purge] warned1=${warned1} warned2=${warned2} purged=${purged} skipped=${skipped}`,
  )
  return { ran: true, warned1, warned2, purged, skipped }
}

async function sendPurgeWarningEmail(
  to: string,
  purgeAt: Date,
  isFinal: boolean,
  kind: 'subscription' | 'trial',
): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass) throw new Error('GMAIL credentials not set')
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  })
  const { subject, html } = buildPurgeWarningEmail({
    kind,
    isFinal,
    purgeAt,
  })
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to,
    subject,
    html,
  })
}

/** Builds the purge-warning email — separate copy for an ended
 *  SUBSCRIPTION vs an ended TRIAL, and a more urgent variant for the
 *  final (3-days-out) notice. Exported-style helper so the admin test
 *  panel can render the exact same templates. */
export function buildPurgeWarningEmail(args: {
  kind: 'subscription' | 'trial'
  isFinal: boolean
  purgeAt: Date
}): { subject: string; html: string } {
  const dateStr = formatExpiryHebrew(args.purgeAt)
  const days = daysUntil(args.purgeAt)
  const daysWord = days === 1 ? 'יום אחד' : `${days} ימים`
  const sourceLine =
    args.kind === 'trial'
      ? 'תקופת הניסיון שלך ל-<strong>ניהול הורדות פלוס</strong> הסתיימה, ואין יותר גישה לסבבי התיקונים שהעלית.'
      : 'המנוי שלך ל-<strong>ניהול הורדות פלוס</strong> הסתיים, ואין יותר גישה לסבבי התיקונים שהעלית.'
  const ctaLabel =
    args.kind === 'trial' ? 'שדרוג ושמירת הסבבים 👑' : 'חידוש ושמירת הסבבים 👑'
  const heading = args.isFinal
    ? '🚨 סבבי התיקונים שלך יימחקו בקרוב'
    : '⚠️ הגישה הסתיימה — סבבי התיקונים יימחקו בקרוב'
  const subject = args.isFinal
    ? `🚨 סבבי התיקונים שלך יימחקו בעוד ${daysWord}`
    : `⚠️ הגישה הסתיימה — סבבי התיקונים יימחקו בעוד ${daysWord}`
  const html = renderEmail({
    heading,
    contentHtml: `
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        ${sourceLine}
      </p>
      <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
        סבבי התיקונים שלך (הסרטונים, התמונות וההקלטות) יימחקו לצמיתות בעוד <strong>${daysWord}</strong> (${dateStr}). ${
          args.kind === 'trial' ? 'שדרוג למנוי' : 'חידוש המנוי'
        } לפני התאריך הזה ישמור את כל הסבבים.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:18px 0 24px;">
        <tr><td align="center">
          <a href="${WEBSITE_BASE}/buy" target="_blank" style="display:inline-block;padding:14px 36px;border-radius:8px;background:#B8794F;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:15px;">${ctaLabel}</a>
        </td></tr>
      </table>
      <p style="font-size:12px;margin:0;color:#5C5444;">
        לא רוצים להמשיך? אין צורך לעשות דבר — סבבי התיקונים יימחקו אוטומטית בתאריך הנ"ל.
      </p>
    `,
  })
  return { subject, html }
}

/* ─────────────────────────────────────────────────────────────
 *  Email template helper. Mirror of the same function in
 *  api/paypal.ts, api/capture.ts, api/reset-password.ts.
 *  Duplicated (not shared) because Vercel's per-function bundler
 *  is unreliable with helper-only modules out of api/.
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
