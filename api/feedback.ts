import type { VercelRequest, VercelResponse } from '@vercel/node'
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

/**
 * Server-mediated feedback pipeline. Replaces a three-step client
 * flow that did:
 *   1. Firestore write to `feedback/{auto}` from the renderer
 *   2. Electron main IPC → Telegram Bot API (with bundled bot token)
 *   3. Firestore updateDoc on the same `feedback/{id}` with the
 *      Telegram file_ids
 *
 * The bot token used to be base64-encoded-in-chunks inside the .asar
 * bundle. That stops `strings | grep` and casual GitHub token
 * scanners but a determined attacker can re-derive it in a minute.
 * Anyone with the token can post arbitrary messages as our bot AND
 * read every message it has received (i.e. every other user's
 * feedback including screenshots). Removing it from the bundle is
 * the whole point of this migration.
 *
 * Two operations live behind this single endpoint to stay under the
 * Vercel Hobby plan's 12-function limit:
 *   - `POST /api/feedback` — submit feedback (body: { idToken,
 *     kind, message, appVersion, platform, imageDataUrls[] })
 *     → writes the Firestore doc, forwards to Telegram, returns
 *       the new doc id (and the file_ids for the photos, in case
 *       the client wants to render a "sent" preview).
 *   - `GET  /api/feedback?fileId=xxx` — admin-only image fetch.
 *     Returns the JPEG/PNG bytes inline. The admin panel uses this
 *     to show screenshots without ever touching the bot token.
 *
 * Required env vars (NEW for this endpoint):
 *   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — id of the group/supergroup to post into
 *
 * Already-set env vars used:
 *   FIREBASE_SERVICE_ACCOUNT
 *   ADMIN_EMAILS (optional, comma-separated; falls back to userDoc.role)
 */

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

// ----- Telegram ------------------------------------------------------

const TELEGRAM_CAPTION_MAX = 1024

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface FeedbackUser {
  uid: string
  email: string | null
  name: string | null
}

function formatFeedbackHtml(p: {
  kind: 'bug' | 'feature'
  message: string
  appVersion: string
  platform: string
  user: FeedbackUser
}): string {
  const emoji = p.kind === 'bug' ? '🐞' : '💡'
  const title = p.kind === 'bug' ? 'דיווח על באג חדש' : "הצעה לפיצ'ר חדש"
  const userLine =
    p.user.name || p.user.email
      ? `<b>${escapeHtml(p.user.name || '')}</b>${
          p.user.email ? ` &lt;${escapeHtml(p.user.email)}&gt;` : ''
        }`
      : `UID <code>${escapeHtml(p.user.uid.slice(0, 8))}</code>`
  return [
    `${emoji} <b>${escapeHtml(title)}</b>`,
    '',
    `<b>מאת:</b> ${userLine}`,
    `<b>גרסה:</b> v${escapeHtml(p.appVersion)} · ${escapeHtml(p.platform)}`,
    '',
    `<pre>${escapeHtml(p.message)}</pre>`,
  ].join('\n')
}

function dataUrlToBuffer(
  dataUrl: string,
): { buffer: Buffer; mime: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  try {
    return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }
  } catch {
    return null
  }
}

interface PhotoEntry {
  buffer: Buffer
  mime: string
}

async function sendToTelegram(
  token: string,
  chatId: string,
  fullText: string,
  images: PhotoEntry[],
): Promise<{ ok: true; fileIds?: string[] } | { ok: false; error: string }> {
  const api = `https://api.telegram.org/bot${token}`
  let res: Response
  let fileIds: string[] | undefined
  let needFollowUpText = false

  try {
    if (images.length === 0) {
      res = await fetch(`${api}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: fullText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      })
    } else if (images.length === 1) {
      const trimmed =
        fullText.length > TELEGRAM_CAPTION_MAX
          ? fullText.slice(0, TELEGRAM_CAPTION_MAX - 30) +
            '\n…\n<i>(המשך בהודעה הבאה)</i>'
          : fullText
      const form = new FormData()
      form.append('chat_id', chatId)
      form.append('caption', trimmed)
      form.append('parse_mode', 'HTML')
      const ext = images[0].mime.split('/')[1] || 'jpg'
      form.append(
        'photo',
        new Blob([new Uint8Array(images[0].buffer)], { type: images[0].mime }),
        `screenshot.${ext}`,
      )
      res = await fetch(`${api}/sendPhoto`, { method: 'POST', body: form })
      if (res.ok) {
        const id = await extractLargestFileIdSingle(res)
        if (id) fileIds = [id]
      }
      needFollowUpText = res.ok && fullText.length > TELEGRAM_CAPTION_MAX
    } else {
      // Album path — 2 to 10 photos. Caption attaches to the first
      // item per Telegram's protocol; the rest stay caption-less.
      const trimmed =
        fullText.length > TELEGRAM_CAPTION_MAX
          ? fullText.slice(0, TELEGRAM_CAPTION_MAX - 30) +
            '\n…\n<i>(המשך בהודעה הבאה)</i>'
          : fullText
      const form = new FormData()
      form.append('chat_id', chatId)
      const media = images.map((_img, i) => ({
        type: 'photo',
        media: `attach://photo${i}`,
        ...(i === 0 ? { caption: trimmed, parse_mode: 'HTML' } : {}),
      }))
      form.append('media', JSON.stringify(media))
      for (let i = 0; i < images.length; i++) {
        const ext = images[i].mime.split('/')[1] || 'jpg'
        form.append(
          `photo${i}`,
          new Blob([new Uint8Array(images[i].buffer)], {
            type: images[i].mime,
          }),
          `screenshot-${i}.${ext}`,
        )
      }
      res = await fetch(`${api}/sendMediaGroup`, {
        method: 'POST',
        body: form,
      })
      if (res.ok) {
        fileIds = await extractLargestFileIdsAlbum(res)
      }
      needFollowUpText = res.ok && fullText.length > TELEGRAM_CAPTION_MAX
    }

    if (needFollowUpText) {
      // Best-effort overflow. Don't fail the call if this errors —
      // the main delivery already succeeded.
      await fetch(`${api}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: fullText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }).catch(() => undefined)
    }

    if (!res.ok) {
      let detail = ''
      try {
        const j = (await res.json()) as { description?: string }
        detail = j.description || ''
      } catch {
        // ignore
      }
      return {
        ok: false,
        error: `Telegram החזיר ${res.status}: ${detail || res.statusText}`,
      }
    }
    return { ok: true, fileIds }
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'שליחה נכשלה' }
  }
}

async function extractLargestFileIdSingle(
  res: Response,
): Promise<string | undefined> {
  try {
    const j = (await res.clone().json().catch(() => null)) as {
      ok?: boolean
      result?: {
        photo?: Array<{ file_id: string; width: number; height: number }>
      }
    } | null
    const photos = j?.result?.photo
    if (!photos || photos.length === 0) return undefined
    const biggest = photos.reduce((acc, p) =>
      p.width * p.height > acc.width * acc.height ? p : acc,
    )
    return biggest.file_id
  } catch {
    return undefined
  }
}

async function extractLargestFileIdsAlbum(
  res: Response,
): Promise<string[] | undefined> {
  try {
    const j = (await res.clone().json().catch(() => null)) as {
      ok?: boolean
      result?: Array<{
        photo?: Array<{ file_id: string; width: number; height: number }>
      }>
    } | null
    const items = j?.result
    if (!items || items.length === 0) return undefined
    const out: string[] = []
    for (const item of items) {
      const photos = item.photo
      if (!photos || photos.length === 0) continue
      const biggest = photos.reduce((acc, p) =>
        p.width * p.height > acc.width * acc.height ? p : acc,
      )
      out.push(biggest.file_id)
    }
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

// ----- Admin gate ----------------------------------------------------

function adminEmailsFromEnv(): string[] {
  const raw = process.env.ADMIN_EMAILS || ''
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

async function verifyAdminFromIdToken(
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
    return { ok: false, status: 401, error: 'אימות נכשל. התחברו מחדש' }
  }
  const email = (decoded.email || '').toLowerCase().trim()
  const uid = decoded.uid
  // Hard ADMIN_EMAILS allowlist ONLY. The fallback to users/{uid}
  // .role === 'admin' was removed: it relied entirely on Firestore
  // rules to prevent a regular user from self-promoting by writing
  // `role:'admin'` to their own doc via the client SDK, and a
  // permissive rules file would silently turn it into a privilege
  // escalation. ADMIN_EMAILS lives in Vercel env vars where only
  // the operator can change it.
  const allow = adminEmailsFromEnv()
  if (email && allow.includes(email)) return { ok: true, uid, email }
  return { ok: false, status: 403, error: 'אין הרשאת אדמין' }
}

// ----- GET — admin image fetch --------------------------------------

async function handleGetImage(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    return res
      .status(500)
      .json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' })
  }

  // Auth: admin only. The image fetch reveals user-submitted
  // screenshots, which may contain sensitive data — gate it hard.
  const idToken = (
    req.headers['authorization']?.toString().replace(/^Bearer\s+/i, '') || ''
  ).trim()
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'חסר אסימון אימות' })
  }
  const gate = await verifyAdminFromIdToken(idToken)
  if (!gate.ok) {
    return res.status(gate.status).json({ ok: false, error: gate.error })
  }

  const fileId = (req.query.fileId || '').toString().trim()
  if (!fileId) {
    return res.status(400).json({ ok: false, error: 'fileId חסר' })
  }

  try {
    const meta = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(
        fileId,
      )}`,
    )
    if (!meta.ok) {
      return res
        .status(502)
        .json({ ok: false, error: `getFile ${meta.status}` })
    }
    const metaJson = (await meta.json()) as {
      ok: boolean
      result?: { file_path?: string }
      description?: string
    }
    if (!metaJson.ok || !metaJson.result?.file_path) {
      return res.status(404).json({
        ok: false,
        error: metaJson.description || 'תמונה לא נמצאה',
      })
    }
    const filePath = metaJson.result.file_path
    const bin = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`,
    )
    if (!bin.ok) {
      return res
        .status(502)
        .json({ ok: false, error: `download ${bin.status}` })
    }
    const ext = (filePath.split('.').pop() || 'jpg').toLowerCase()
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg'
    const buf = Buffer.from(await bin.arrayBuffer())
    res.setHeader('Content-Type', mime)
    // Short cache so the admin panel doesn't refetch every render
    // but stale-after-a-day in case Telegram rotates file_paths.
    res.setHeader('Cache-Control', 'private, max-age=3600')
    return res.status(200).send(buf)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('feedback GET image failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

// ----- POST — submit feedback ---------------------------------------

async function handlePostSubmit(
  req: VercelRequest,
  res: VercelResponse,
): Promise<VercelResponse> {
  const body = req.body as {
    idToken?: string
    kind?: 'bug' | 'feature'
    message?: string
    appVersion?: string
    platform?: string | null
    imageDataUrls?: string[]
  }
  const idToken = (body.idToken || '').trim()
  const kind = body.kind === 'feature' ? 'feature' : 'bug'
  const message = (body.message || '').trim()
  const appVersion = (body.appVersion || '0.0.0').trim()
  const platform = (body.platform || '').toString().trim() || null

  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'אסימון אימות חסר' })
  }
  if (!message) {
    return res.status(400).json({ ok: false, error: 'ההודעה ריקה' })
  }
  if (message.length > 4000) {
    return res
      .status(400)
      .json({ ok: false, error: 'ההודעה ארוכה מדי (עד 4000 תווים)' })
  }

  try {
    const app = getFirebase()
    const auth = getAuth(app)
    const db = getFirestore(app)

    let decoded
    try {
      decoded = await auth.verifyIdToken(idToken)
    } catch {
      return res
        .status(401)
        .json({ ok: false, error: 'אימות נכשל. התחברו מחדש' })
    }
    const uid = decoded.uid
    const email = (decoded.email || '').toLowerCase().trim() || null
    const name = (decoded.name as string | undefined) || null

    // 1) Write the feedback doc first so we have a stable id to
    //    associate the Telegram fileIds with.
    const docRef = await db.collection('feedback').add({
      kind,
      message,
      userId: uid,
      userEmail: email,
      userName: name,
      appVersion,
      platform,
      resolved: false,
      createdAt: new Date().toISOString(),
      _createdAt: FieldValue.serverTimestamp(),
    })
    const id = docRef.id

    // 2) Best-effort Telegram mirror. Caps at 10 images (Telegram
    //    media-group limit) and silently drops bad data URLs.
    let telegramFileIds: string[] | undefined
    let telegramError: string | undefined

    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (!token || !chatId) {
      telegramError = 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured'
      console.warn('feedback submit: ' + telegramError)
    } else {
      const rawImages = Array.isArray(body.imageDataUrls)
        ? body.imageDataUrls.slice(0, 10)
        : []
      const images = rawImages
        .map((u) => dataUrlToBuffer(u))
        .filter((x): x is PhotoEntry => x !== null)
      const fullText = formatFeedbackHtml({
        kind,
        message,
        appVersion,
        platform: platform || 'unknown',
        user: { uid, email, name },
      })
      const tgResult = await sendToTelegram(token, chatId, fullText, images)
      if (tgResult.ok) {
        telegramFileIds = tgResult.fileIds
      } else {
        telegramError = tgResult.error
        console.warn('feedback Telegram mirror failed:', tgResult.error)
      }
    }

    // 3) Persist the Telegram fileIds onto the doc (when we got
    //    any). Failure here is non-fatal — the feedback is already
    //    saved, the admin just won't see thumbnails inline.
    if (telegramFileIds && telegramFileIds.length > 0) {
      await db
        .collection('feedback')
        .doc(id)
        .update({ telegramFileIds })
        .catch((err) =>
          console.warn('feedback: attaching fileIds failed', err),
        )
    }

    return res.status(200).json({
      ok: true,
      id,
      telegramFileIds,
      // Surface the Telegram error to the caller too — UI doesn't
      // need to show it (the feedback DID land in Firestore) but
      // having it for diagnostics is useful.
      telegramError,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('feedback POST submit failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

// ----- Dispatcher ----------------------------------------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === 'GET') return handleGetImage(req, res)
  if (req.method === 'POST') return handlePostSubmit(req, res)
  return res.status(405).json({ ok: false, error: 'Method not allowed' })
}
