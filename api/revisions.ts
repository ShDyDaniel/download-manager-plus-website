import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import {
  getFirestore,
  FieldValue,
  type Firestore,
} from 'firebase-admin/firestore'
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import nodemailer from 'nodemailer'

/**
 * Revisions feature — server endpoints.
 *
 * Consolidated into ONE Vercel function file (dispatched by
 * ?action=...) to stay within the Hobby plan's 12-function cap.
 * Same pattern as api/paypal.ts.
 *
 * ─────────────────────────────────────────────────────────────
 * PHASE 2 actions (this commit) — Google Drive OAuth
 * ─────────────────────────────────────────────────────────────
 *
 *   action=oauth-start
 *     Request: GET ?action=oauth-start&idToken=<firebase-id-token>
 *     Verifies the Firebase ID token to identify the user, mints a
 *     short-lived "state" JWT that carries the user's uid, then
 *     302-redirects the browser to Google's consent screen with that
 *     state. The Firebase ID token never travels to Google or
 *     re-appears in the URL after this redirect.
 *
 *   action=oauth-callback
 *     Request: GET ?action=oauth-callback&code=<google-code>&state=<our-state>
 *     Google brings the user back here after they grant (or deny)
 *     consent. We verify the state JWT, exchange the code for an
 *     access+refresh token pair, encrypt the refresh token with
 *     AES-256-GCM, and write it to Firestore at
 *     users/{uid}/integrations/googleDrive. Responds with a plain
 *     HTML "אפשר לסגור את החלון" success page. The Electron app
 *     detects completion via its Firestore real-time listener on
 *     the same doc — no polling, no deep-link protocol needed.
 *
 *   action=access-token
 *     Request: POST { idToken }
 *     Returns a fresh 1-hour Drive access token for the user. The
 *     Electron app calls this just-in-time before any Drive
 *     operation (upload, list, etc.). The refresh token never
 *     leaves the server.
 *
 *   action=oauth-status
 *     Request: POST { idToken }
 *     Returns { connected: boolean, email?: string } so the UI can
 *     render the right state without having to subscribe to
 *     Firestore from outside the app (used by some headless flows).
 *
 *   action=oauth-disconnect
 *     Request: POST { idToken }
 *     Deletes the stored refresh-token document AND revokes the
 *     token at Google. After this, the user is fully disconnected.
 *
 * ─────────────────────────────────────────────────────────────
 * PHASE 4-6 actions (future commits, same file)
 * ─────────────────────────────────────────────────────────────
 *   action=create-project, get-project, verify-password,
 *   add-note, list-notes, resolve-note, ...
 *
 * Adding actions here costs nothing — Vercel still counts this as
 * one function.
 */

export const config = {
  // OAuth callback occasionally needs >10s on first-time Google API
  // calls (cold start + token exchange). 30s is generous.
  maxDuration: 30,
}

/* ──────────────────────────────────────────────────────────────
 *  Constants
 * ────────────────────────────────────────────────────────────── */

// Google OAuth endpoints — public, never change.
const GOOGLE_AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URI = 'https://oauth2.googleapis.com/revoke'

// Drive scope — `drive.file` is the most restrictive scope that
// still lets us upload + read our own files. It does NOT let us see
// the user's other Drive content. This matters for getting through
// Google's OAuth verification process: drive.file is on the "simple"
// scope tier; broader scopes like drive.readonly need security audit.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

// Where Google sends users after consent. Must match EXACTLY the
// URI registered in Google Cloud Console → Credentials → OAuth
// client → Authorized redirect URIs.
//
// We deliberately use a CLEAN path (no ?action=... query string)
// and rely on a vercel.json rewrite to route it to this dispatcher.
// Reason: Google's OAuth redirect_uri validation is exact-match,
// and query strings have historically been a source of subtle
// "redirect_uri_mismatch" failures (different encoding of `?`/`&`,
// different ordering, etc.). A plain path always works.
const REDIRECT_URI = 'https://dmplus.net/oauth/drive/callback'

// State JWT lifetime — long enough for a slow user to complete the
// Google consent flow, short enough that a stale state can't be
// replayed weeks later.
const STATE_TTL_SECONDS = 10 * 60 // 10 min

/* ──────────────────────────────────────────────────────────────
 *  Firebase init (singleton)
 * ────────────────────────────────────────────────────────────── */

function getFirebase(): App {
  if (getApps().length > 0) return getApps()[0]!
  // The rest of the codebase (paypal.ts, capture.ts) stores the
  // service account as ONE single-line JSON blob in
  // FIREBASE_SERVICE_ACCOUNT — not as three separate env vars.
  // Keep the same shape here so the operator doesn't need to add
  // anything new in Vercel; we read what's already there.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set')
  return initializeApp({ credential: cert(JSON.parse(raw)) })
}

function getDb(): Firestore {
  return getFirestore(getFirebase())
}

/* ──────────────────────────────────────────────────────────────
 *  R2 (Cloudflare) object storage — S3-compatible
 *
 *  Replaces Google Drive as the home for revision videos + note
 *  media. Videos are uploaded DIRECTLY from the client (browser /
 *  desktop) to R2 via presigned multipart URLs — bytes never pass
 *  through Vercel. The Cloudflare Worker streams them back out from
 *  R2 (zero egress). Object keys are namespaced per-owner:
 *    videos/{uid}/{ts}-{rand}-{name}
 *    notes/{uid}/{ts}-{rand}.{ext}
 *  so a key always proves which user it belongs to (we verify the
 *  `videos/{uid}/` prefix on every presign / mutate to stop a user
 *  signing parts for someone else's object).
 * ────────────────────────────────────────────────────────────── */

const R2_BUCKET = process.env.R2_BUCKET || ''
// Presigned-URL lifetime. Long enough to upload one ~5GB part on a
// slow line, short enough that a leaked URL expires quickly.
const R2_PRESIGN_TTL = 60 * 60 // 1 hour

// Public Cloudflare Worker that proxies ALL media bytes — video,
// note images/audio, and Drive→R2 import — so that ZERO media ever
// streams through Vercel (Vercel egress is what blew past the 10GB
// free tier). The worker base lives in config (CLOUDFLARE_STREAM_BASE),
// NOT in the code, so we can repoint the worker without a redeploy.
//
// CRITICAL: if this is blank we FAIL SAFE — media URL builders refuse
// and the byte-proxy endpoints return an error. We NEVER fall back to
// streaming bytes through Vercel; that silent fallback is exactly what
// caused the egress blow-up. So a missing env var breaks playback
// loudly (easy to spot + fix) instead of quietly costing money.
const WORKER_STREAM_BASE = (process.env.CLOUDFLARE_STREAM_BASE || '')
  .trim()
  .replace(/\/$/, '')

let _r2: S3Client | null = null
function getR2(): S3Client {
  if (_r2) return _r2
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey || !R2_BUCKET) {
    throw new Error(
      'R2 env vars missing (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)',
    )
  }
  _r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Newer aws-sdk v3 versions add a CRC32 integrity checksum to every
    // request by default. For PRESIGNED URLs that bakes an (empty-body)
    // checksum into the signature, which R2 then rejects when the real
    // part bytes arrive — and it also adds an x-amz-sdk-checksum-algorithm
    // header that trips CORS preflight. R2 doesn't need these, so switch
    // checksums to "only when the API requires it" (i.e. never here).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return _r2
}

// Per-user folder layout, kept tidy:
//   {uid}/videos/<file>   — round videos
//   {uid}/notes/<file>    — reviewer screenshots + voice notes
function buildVideoKey(uid: string, fileName: string): string {
  const safe =
    (fileName || 'video')
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(-80) || 'video'
  const rand = crypto.randomBytes(8).toString('hex')
  return `${uid}/videos/${Date.now()}-${rand}-${safe}`
}

// Map a filename's extension to a real video MIME type. Keeps R2
// objects served as video/* so the browser <video> renders a picture
// instead of mis-sniffing the file as an audio-only stream.
function videoTypeFromFileName(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim())
  switch ((m ? m[1] : '').toLowerCase()) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'avi':
      return 'video/x-msvideo'
    case 'wmv':
      return 'video/x-ms-wmv'
    case 'flv':
      return 'video/x-flv'
    default:
      return 'video/mp4'
  }
}

function buildNoteMediaKey(uid: string, ext: string): string {
  const clean = (ext || 'bin').replace(/[^\w]+/g, '').slice(0, 8) || 'bin'
  const rand = crypto.randomBytes(8).toString('hex')
  return `${uid}/notes/${Date.now()}-${rand}.${clean}`
}

// Google Drive API key (server env). Used to read PUBLIC files
// ("anyone with the link") without OAuth — both for the size/quota
// pre-check here and for the Worker's actual byte transfer.
// Reuses the existing GOOGLE_DRIVE_API_KEY; falls back to DRIVE_API_KEY.
const DRIVE_API_KEY = (
  process.env.GOOGLE_DRIVE_API_KEY ||
  process.env.DRIVE_API_KEY ||
  ''
).trim()

/** Pull the file id out of any common Google Drive share URL shape:
 *    https://drive.google.com/file/d/<ID>/view?usp=sharing
 *    https://drive.google.com/open?id=<ID>
 *    https://drive.google.com/uc?id=<ID>&export=download
 *    https://docs.google.com/.../d/<ID>/edit
 *  Also accepts a bare id. Returns null if nothing id-shaped found. */
function extractDriveFileId(input: string): string | null {
  const s = String(input || '').trim()
  if (!s) return null
  // /d/<id>/ or /d/<id> end
  const dMatch = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/)
  if (dMatch) return dMatch[1]
  // ?id=<id> or &id=<id>
  const idMatch = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (idMatch) return idMatch[1]
  // bare id
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s
  return null
}

/** Read a public Drive file's metadata via the API key. Returns null
 *  when the file isn't reachable (not shared publicly / wrong id /
 *  key missing). `size` is bytes (Drive returns it as a string). */
async function fetchDrivePublicMeta(
  fileId: string,
): Promise<{ name: string; size: number; mimeType: string } | null> {
  if (!DRIVE_API_KEY) return null
  try {
    const url =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
      `?fields=id,name,size,mimeType&supportsAllDrives=true&key=${DRIVE_API_KEY}`
    const r = await fetch(url)
    if (!r.ok) return null
    const j = (await r.json()) as {
      name?: string
      size?: string
      mimeType?: string
    }
    return {
      name: String(j.name || 'video.mp4'),
      size: Math.max(0, Math.floor(Number(j.size) || 0)),
      mimeType: String(j.mimeType || 'video/mp4'),
    }
  } catch {
    return null
  }
}

// A key is owned by `uid` iff it sits under that user's folder. The
// new layout is `{uid}/...`; we also accept the original
// `videos/{uid}/` & `notes/{uid}/` prefixes so objects created before
// the reorg still validate (for delete, etc.).
function keyBelongsToUser(key: string, uid: string): boolean {
  if (!key || !uid) return false
  return (
    key.startsWith(`${uid}/`) ||
    key.startsWith(`videos/${uid}/`) ||
    key.startsWith(`notes/${uid}/`)
  )
}

async function r2DeleteObject(key: string): Promise<boolean> {
  if (!key) return false
  try {
    await getR2().send(
      new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    )
    return true
  } catch (e) {
    console.error('[r2] delete failed:', key, e)
    return false
  }
}

// Presigned GET URL for a note-media object. Note media is small and
// immutable, so the browser can fetch it directly from R2 via this
// short-lived URL — no Worker hop needed (unlike video, which streams
// with Range through the Worker).
async function r2PresignGet(key: string, ttl = 60 * 60): Promise<string> {
  return getSignedUrl(
    getR2(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: ttl },
  )
}

// Presign a one-shot PUT so the browser uploads note media (screenshots
// / voice notes) STRAIGHT to R2 — zero bytes through Vercel, same as the
// video multipart parts. We deliberately sign only Bucket+Key: the
// browser still sends Content-Type + Content-Length as unsigned headers
// and R2 stores them, so we avoid signed-header mismatches (e.g. an
// `audio/webm;codecs=opus` blob type vs a stripped `audio/webm`).
async function r2PresignPut(
  key: string,
  ttl = R2_PRESIGN_TTL,
): Promise<string> {
  return getSignedUrl(
    getR2(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: ttl },
  )
}

async function r2HeadSize(key: string): Promise<number> {
  try {
    const r = await getR2().send(
      new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    )
    return r.ContentLength || 0
  } catch {
    return 0
  }
}

// Delete every R2 note-media object (screenshots / audio) attached to a
// round's notes. Safe no-op for notes that still use Drive. Note media
// is tiny so it isn't tracked in the storage quota counter.
async function deleteRoundNoteMediaR2(
  ownerUid: string,
  roundId: string,
): Promise<void> {
  try {
    const notesSnap = await getDb()
      .collection('revisionProjects')
      .doc(roundId)
      .collection('notes')
      .get()
    const keys: string[] = []
    for (const n of notesSnap.docs) {
      const d = n.data() as { screenshotR2Key?: string; audioR2Key?: string }
      if (d.screenshotR2Key) keys.push(d.screenshotR2Key)
      if (d.audioR2Key) keys.push(d.audioR2Key)
    }
    if (keys.length) await Promise.all(keys.map((k) => r2DeleteObject(k)))
  } catch (e) {
    console.warn('[r2] note-media cleanup failed:', roundId, e)
  }
}

// Move a Drive file to trash, on behalf of its owner (Drive-backed
// rounds only). Best-effort — returns whether the trash succeeded.
async function driveTrashFile(ownerUid: string, fileId: string): Promise<boolean> {
  if (!ownerUid || !fileId) return false
  try {
    const integrationSnap = await integrationDocRef(ownerUid).get()
    if (!integrationSnap.exists) return false
    const integration = integrationSnap.data() as IntegrationDoc
    const refreshToken = decryptToken(integration.refreshTokenEnc)
    const r = await refreshAccessToken(refreshToken)
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${r.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trashed: true }),
      },
    )
    return resp.ok
  } catch (e) {
    console.error('[drive] trash failed:', fileId, e)
    return false
  }
}

/* ── Upload actions (owner-only, Pro-gated) ───────────────────── */

// action=r2-upload-init
// Body: { fileName, contentType }
// Starts a multipart upload, returns { key, uploadId }. The client
// then asks for a presigned URL per part and PUTs the bytes itself.
async function handleR2UploadInit(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const body = (req.body || {}) as {
    fileName?: string
    contentType?: string
    sizeBytes?: number
  }
  const fileName = String(body.fileName || 'video').slice(0, 300)
  // Store a real video/* content-type so the <video> player on the
  // review page renders a picture (a generic octet-stream makes some
  // browsers mis-sniff the file as audio-only). Trust the client's
  // type only when it's already a video/* value; otherwise derive it
  // from the file extension.
  const clientType = String(body.contentType || '').toLowerCase()
  const contentType = clientType.startsWith('video/')
    ? clientType.slice(0, 100)
    : videoTypeFromFileName(fileName)
  const sizeBytes = Math.max(0, Math.floor(Number(body.sizeBytes) || 0))

  // Storage-quota gate, BEFORE the upload starts. We require a real
  // size up front: without it we can't guarantee the file fits, so we
  // refuse rather than let an unbounded upload begin (the size is
  // re-verified for real at r2-upload-complete as a backstop).
  const { usedBytes, limitBytes } = await getStorageState(verified.uid)
  if (sizeBytes <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'size-required',
      message: 'לא ניתן לקבוע את גודל הקובץ. נסו שוב.',
    })
  }
  if (usedBytes + sizeBytes > limitBytes) {
    return res.status(413).json({
      ok: false,
      error: 'quota',
      message: `אין מספיק מקום אחסון. הקובץ שוקל ${(sizeBytes / GB).toFixed(2)}GB, ובשימוש כבר ${(usedBytes / GB).toFixed(2)}GB מתוך ${(limitBytes / GB).toFixed(2)}GB. מחקו סבבים ישנים ונסו שוב.`,
      usedBytes,
      limitBytes,
      sizeBytes,
    })
  }

  const key = buildVideoKey(verified.uid, fileName)

  try {
    const out = await getR2().send(
      new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
    )
    return res.status(200).json({ ok: true, key, uploadId: out.UploadId })
  } catch (e) {
    console.error('[r2-upload-init]', e)
    return res.status(500).json({ ok: false, error: 'upload init failed' })
  }
}

// action=r2-upload-part-url
// Body: { key, uploadId, partNumber } → { url }
async function handleR2UploadPartUrl(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const body = (req.body || {}) as {
    key?: string
    uploadId?: string
    partNumber?: number
  }
  const key = String(body.key || '')
  const uploadId = String(body.uploadId || '')
  const partNumber = Math.floor(Number(body.partNumber) || 0)
  if (!keyBelongsToUser(key, verified.uid)) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  if (!uploadId || partNumber < 1 || partNumber > 10000) {
    return res.status(400).json({ ok: false, error: 'bad part request' })
  }

  try {
    const url = await getSignedUrl(
      getR2(),
      new UploadPartCommand({
        Bucket: R2_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: R2_PRESIGN_TTL },
    )
    return res.status(200).json({ ok: true, url })
  } catch (e) {
    console.error('[r2-upload-part-url]', e)
    return res.status(500).json({ ok: false, error: 'sign failed' })
  }
}

// action=r2-upload-complete
// Body: { key, uploadId, parts: [{ partNumber, etag }] }
// → { key, sizeBytes }
async function handleR2UploadComplete(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const body = (req.body || {}) as {
    key?: string
    uploadId?: string
    parts?: Array<{ partNumber?: number; etag?: string }>
  }
  const key = String(body.key || '')
  const uploadId = String(body.uploadId || '')
  const parts = Array.isArray(body.parts) ? body.parts : []
  if (!keyBelongsToUser(key, verified.uid)) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  if (!uploadId || parts.length === 0) {
    return res.status(400).json({ ok: false, error: 'no parts' })
  }

  const Parts = parts
    .map((p) => ({
      PartNumber: Math.floor(Number(p.partNumber) || 0),
      ETag: String(p.etag || ''),
    }))
    .filter((p) => p.PartNumber >= 1 && p.ETag)
    .sort((a, b) => a.PartNumber - b.PartNumber)

  try {
    await getR2().send(
      new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts },
      }),
    )
    // Backstop against a client that under-reported its size at init:
    // measure the REAL assembled object and, if it pushes the account
    // over quota, delete it and reject. This makes the quota
    // impossible to exceed even with a tampered client. (The object
    // isn't a round doc yet, so getStorageState doesn't include it —
    // used + real is the true projected usage.)
    const sizeBytes = await r2HeadSize(key)
    const { usedBytes, limitBytes } = await getStorageState(verified.uid)
    if (usedBytes + sizeBytes > limitBytes) {
      try {
        await r2DeleteObject(key)
      } catch {
        /* best-effort cleanup */
      }
      return res.status(413).json({
        ok: false,
        error: 'quota',
        message: `אין מספיק מקום אחסון לקובץ הזה (${(sizeBytes / GB).toFixed(2)}GB). בשימוש ${(usedBytes / GB).toFixed(2)}GB מתוך ${(limitBytes / GB).toFixed(2)}GB.`,
        usedBytes,
        limitBytes,
        sizeBytes,
      })
    }
    return res.status(200).json({ ok: true, key, sizeBytes })
  } catch (e) {
    console.error('[r2-upload-complete]', e)
    return res.status(500).json({ ok: false, error: 'complete failed' })
  }
}

// action=r2-upload-abort — best-effort cleanup if the client cancels.
// Body: { key, uploadId }
async function handleR2UploadAbort(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const body = (req.body || {}) as { key?: string; uploadId?: string }
  const key = String(body.key || '')
  const uploadId = String(body.uploadId || '')
  if (!keyBelongsToUser(key, verified.uid) || !uploadId) {
    return res.status(400).json({ ok: false, error: 'bad request' })
  }
  try {
    await getR2().send(
      new AbortMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: key,
        UploadId: uploadId,
      }),
    )
  } catch (e) {
    console.error('[r2-upload-abort]', e)
  }
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Drive-link → R2 import (R2-backend users)
 *
 *  Lets an R2 user paste a PUBLIC Google-Drive share link instead of
 *  uploading a local file. The actual byte transfer runs in the
 *  Cloudflare Worker (Drive → Cloudflare → R2) so nothing transits
 *  Vercel. Two-step:
 *    1. drive-import-init (this user) — validate link, read size via
 *       the API key, enforce the storage quota, and mint a one-time
 *       nonce describing the job. Returns the Worker import URL.
 *    2. The client hits that Worker URL; the Worker calls
 *       drive-import-auth (worker secret) to exchange the nonce for
 *       {fileId, key, apiKey}, streams the file into R2, and reports
 *       back. The client then registers the round with the r2Key.
 * ────────────────────────────────────────────────────────────── */

// action=drive-import-init  Body: { idToken|sessionToken, driveUrl }
async function handleDriveImportInit(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  if (!DRIVE_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'drive-import-not-configured',
      message: 'ייבוא מקישור אינו מוגדר בשרת (חסר DRIVE_API_KEY).',
    })
  }
  const cfBase = WORKER_STREAM_BASE
  if (!cfBase) {
    return res.status(500).json({
      ok: false,
      error: 'stream-base-not-configured',
      message: 'ייבוא מקישור אינו מוגדר בשרת (חסר CLOUDFLARE_STREAM_BASE).',
    })
  }

  const body = (req.body || {}) as { driveUrl?: string }
  const fileId = extractDriveFileId(String(body.driveUrl || ''))
  if (!fileId) {
    return res.status(400).json({
      ok: false,
      error: 'bad-link',
      message: 'הקישור אינו נראה כמו קישור של Google Drive.',
    })
  }

  const meta = await fetchDrivePublicMeta(fileId)
  if (!meta) {
    return res.status(400).json({
      ok: false,
      error: 'not-public',
      message:
        'לא הצלחנו לגשת לקובץ. ודאו שהשיתוף מוגדר ל"כל מי שיש לו את הקישור" ושהקישור תקין.',
    })
  }

  // No hard per-file cap — the only limit is the account's storage
  // quota (checked below). Users can import any size that fits.

  // Storage-quota gate — same rule as the local-upload path.
  const { usedBytes, limitBytes } = await getStorageState(verified.uid)
  if (meta.size > 0 && usedBytes + meta.size > limitBytes) {
    return res.status(413).json({
      ok: false,
      error: 'quota',
      message: `אין מספיק מקום אחסון לקובץ הזה (${(meta.size / GB).toFixed(2)}GB). בשימוש ${(usedBytes / GB).toFixed(2)}GB מתוך ${(limitBytes / GB).toFixed(2)}GB.`,
      usedBytes,
      limitBytes,
      sizeBytes: meta.size,
    })
  }

  const key = buildVideoKey(verified.uid, meta.name)
  const nonce = crypto.randomBytes(24).toString('hex')
  const now = Date.now()
  await getDb()
    .collection('driveImports')
    .doc(nonce)
    .set({
      ownerUid: verified.uid,
      fileId,
      key,
      sizeBytes: meta.size,
      mimeType: meta.mimeType,
      fileName: meta.name,
      createdAt: now,
      // 1-hour window for the Worker to pick the job up + finish.
      expiresAt: now + 60 * 60 * 1000,
    })

  const sep = cfBase.includes('?') ? '&' : '?'
  const importUrl = `${cfBase}${sep}import=${encodeURIComponent(nonce)}`

  return res.status(200).json({
    ok: true,
    importToken: nonce,
    importUrl,
    r2Key: key,
    sizeBytes: meta.size,
    fileName: meta.name,
    mimeType: meta.mimeType,
  })
}

// action=drive-import-auth  (Worker only — X-Worker-Secret)
// Body: { importToken } → { ok, fileId, key, apiKey, mimeType }
async function handleDriveImportAuth(req: VercelRequest, res: VercelResponse) {
  const expected = (process.env.WORKER_SHARED_SECRET || '').trim()
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'WORKER_SHARED_SECRET not set' })
  }
  const got = req.headers['x-worker-secret']
  if (typeof got !== 'string' || got !== expected) {
    return res.status(403).json({ ok: false, error: 'invalid worker secret' })
  }

  const body = (req.body || {}) as { importToken?: string }
  const nonce = String(body.importToken || '').trim()
  if (!nonce) return res.status(400).json({ ok: false, error: 'importToken required' })

  const snap = await getDb().collection('driveImports').doc(nonce).get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'unknown import' })
  const job = snap.data() as {
    fileId?: string
    key?: string
    mimeType?: string
    expiresAt?: number
  }
  if (!job.fileId || !job.key) {
    return res.status(400).json({ ok: false, error: 'malformed import' })
  }
  if (job.expiresAt && Date.now() > job.expiresAt) {
    return res.status(410).json({ ok: false, error: 'import expired' })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    ok: true,
    fileId: job.fileId,
    key: job.key,
    apiKey: DRIVE_API_KEY,
    mimeType: job.mimeType || 'video/mp4',
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Token encryption — AES-256-GCM
 *
 *  We derive a distinct 32-byte key from RENEW_TOKEN_SECRET (which
 *  is already used elsewhere for HMAC) plus a domain-separator
 *  string. Mixing the secret with the literal "drive-oauth-token-v1"
 *  via SHA-256 means the encryption key can never accidentally be
 *  the same as a JWT signing key — a defense against the classic
 *  "key reuse across primitives" footgun.
 * ────────────────────────────────────────────────────────────── */

function encryptionKey(): Buffer {
  const secret = process.env.RENEW_TOKEN_SECRET
  if (!secret) throw new Error('RENEW_TOKEN_SECRET env var not set')
  return crypto
    .createHash('sha256')
    .update(`drive-oauth-token-v1:${secret}`)
    .digest()
}

interface EncryptedToken {
  /** base64 of the ciphertext */
  ct: string
  /** base64 of the 12-byte GCM nonce */
  iv: string
  /** base64 of the 16-byte GCM authentication tag */
  tag: string
}

function encryptToken(plaintext: string): EncryptedToken {
  const key = encryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

function decryptToken(payload: EncryptedToken): string {
  const key = encryptionKey()
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const ct = Buffer.from(payload.ct, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

/* ──────────────────────────────────────────────────────────────
 *  State JWT — carries the user's uid through the Google redirect
 * ────────────────────────────────────────────────────────────── */

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64')
}

function hmacSecret(): Buffer {
  const s = process.env.RENEW_TOKEN_SECRET
  if (!s) throw new Error('RENEW_TOKEN_SECRET env var not set')
  return Buffer.from(s, 'utf8')
}

interface StateClaims {
  uid: string
  /** "drive-oauth" — separator so we never confuse states across
   *  features that might one day share the same signing secret. */
  purpose: 'drive-oauth'
  /** Origin of the connect flow. `desktop` (default — legacy) returns
   *  the HTML "Connected, you can close this tab" page so Electron's
   *  external-browser flow can finish gracefully. `web` returns a 302
   *  redirect back into the SPA at `/revisions?oauth=connected` so the
   *  user lands on the workspace they came from. Embedded in the
   *  HMAC-signed state so a tampered redirect can't trick the
   *  callback into the wrong branch. */
  source?: 'desktop' | 'web'
  iat: number
  exp: number
}

function mintStateToken(uid: string, source: 'desktop' | 'web' = 'desktop'): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const claims: StateClaims = {
    uid,
    purpose: 'drive-oauth',
    source,
    iat: now,
    exp: now + STATE_TTL_SECONDS,
  }
  const payload = b64url(Buffer.from(JSON.stringify(claims)))
  const sig = b64url(
    crypto.createHmac('sha256', hmacSecret()).update(`${header}.${payload}`).digest(),
  )
  return `${header}.${payload}.${sig}`
}

function verifyStateToken(token: string): StateClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [h, p, s] = parts
    const expected = crypto.createHmac('sha256', hmacSecret()).update(`${h}.${p}`).digest()
    const actual = b64urlDecode(s)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(b64urlDecode(p).toString('utf8')) as StateClaims
    if (claims.purpose !== 'drive-oauth') return null
    if (typeof claims.uid !== 'string' || !claims.uid) return null
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null
    // Default to 'desktop' for tokens minted before the `source` field
    // existed — backward compat for any tokens still in flight when
    // we deployed this change.
    if (claims.source !== 'web' && claims.source !== 'desktop') {
      claims.source = 'desktop'
    }
    return claims
  } catch {
    return null
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Firebase ID token verification
 * ────────────────────────────────────────────────────────────── */

interface VerifiedUser {
  uid: string
  email: string
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedUser | null> {
  if (!idToken) return null
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(getFirebase()).verifyIdToken(idToken, true)
    if (!decoded.uid || !decoded.email) return null
    return { uid: decoded.uid, email: decoded.email.toLowerCase() }
  } catch (err) {
    console.warn('[revisions] verifyIdToken failed:', err)
    return null
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Website session-token verifier (mirror of paypal.ts)
 *
 *  The desktop app sends Firebase ID tokens because it has the
 *  Firebase Web SDK loaded and the user signed in via email/
 *  password. The website signed in via /api/paypal?action=session
 *  and got back a custom HMAC-signed session JWT — no Firebase
 *  SDK on the page. Both flows produce the same final `{uid,
 *  email}` once verified, so downstream handlers don't care which
 *  was used. This mirror keeps the verification logic local to
 *  revisions.ts so we don't have a cross-file import dependency
 *  (paypal.ts is huge and re-imports would bloat the bundle).
 *
 *  Keep the secret env-var name (`RENEW_TOKEN_SECRET`) and JWT
 *  shape exactly aligned with paypal.ts → signSessionToken /
 *  verifySessionToken. If those ever change there, mirror the
 *  change here too.
 * ────────────────────────────────────────────────────────────── */
interface WebSessionClaims {
  uid: string
  email: string
  subscriptionIds?: string[]
  iat: number
  exp: number
}

function verifyWebSessionToken(token: string): WebSessionClaims | null {
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts
    const expected = crypto
      .createHmac('sha256', hmacSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest()
    const actual = b64urlDecode(sigB64)
    if (expected.length !== actual.length) return null
    if (!crypto.timingSafeEqual(expected, actual)) return null
    const claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as WebSessionClaims
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp && claims.exp < now) return null
    if (!claims.uid || !claims.email) return null
    return claims
  } catch (err) {
    console.warn('[revisions] verifyWebSessionToken failed:', err)
    return null
  }
}

/** Owner-side auth wrapper that accepts EITHER a Firebase ID token
 *  (desktop) or a website session token (web /revisions). Both
 *  travel in the request body as `idToken` or `sessionToken`
 *  respectively; we try the Firebase path first since it's the
 *  pre-existing convention and almost all current callers use it.
 *
 *  Returns null if neither token is present or valid. Caller
 *  should respond 401. */
async function verifyOwnerAuth(req: VercelRequest): Promise<VerifiedUser | null> {
  const body = (req.body || {}) as { idToken?: string; sessionToken?: string }
  const idToken = String(body.idToken || req.query.idToken || '').trim()
  if (idToken) {
    const v = await verifyFirebaseIdToken(idToken)
    if (v) return v
    // Fall through — maybe they sent both; try session token next.
  }
  const sessionToken = String(body.sessionToken || req.query.sessionToken || '').trim()
  if (sessionToken) {
    const claims = verifyWebSessionToken(sessionToken)
    if (claims) return { uid: claims.uid, email: claims.email.toLowerCase() }
  }
  return null
}

/* ──────────────────────────────────────────────────────────────
 *  Server-side Pro entitlement check
 *
 *  The desktop renderer renders Pro-only UI behind a `!isPro` gate,
 *  but a determined attacker can patch the JS bundle (asar isn't
 *  encrypted on Windows — Mac uses asar integrity fuses, Windows
 *  doesn't have an equivalent yet). They can also bypass the
 *  client entirely and call this API straight from the browser.
 *
 *  So every owner-side action that touches Pro features
 *  re-validates entitlement server-side via this helper. The logic
 *  mirrors `hasProAccess` in src/lib/firestore.ts EXACTLY so a
 *  legitimate Pro user never sees a server-side denial after the
 *  client said they're entitled.
 *
 *  FAIL-CLOSED on transient errors. If any Firestore query throws
 *  we send 503 (transient — retry-friendly) rather than granting
 *  access. The product is in beta with no paying customers yet,
 *  so the priority is "no unauthorized use ever" over "no false
 *  negatives ever". A legit user who hits a one-in-a-million
 *  Firestore blip retries their request and it succeeds the
 *  second time. The original fail-open design (let users through
 *  on errors) was rejected by the operator for exactly this
 *  reason — security over availability while in beta.
 * ────────────────────────────────────────────────────────────── */

// Mirrors src/lib/firestore.ts → ADMIN_EMAILS. Keep in sync if you
// ever change the client-side list.
const SERVER_ADMIN_EMAILS = new Set(['dyshalts@gmail.com'])

// Mirror of isTrialActive() from src/lib/firestore.ts — APPROVED
// trial that hasn't expired.
function serverIsTrialActive(user: Record<string, unknown>): boolean {
  if (user.trialStatus !== 'approved') return false
  const exp = user.trialExpiresAt
  if (!exp) return false
  const ts = new Date(String(exp)).getTime()
  if (!Number.isFinite(ts)) return false
  return ts > Date.now()
}

/* ──────────────────────────────────────────────────────────────
 *  R2 storage quota (per user)
 *
 *  Paid (Pro) users get the full quota; users whose access is a
 *  14-day trial get a small one. The counter (users.storageUsedBytes)
 *  is bumped on round create / replace and decremented on delete —
 *  only for R2-backed rounds (Drive videos live in the user's own
 *  Drive and don't count against our storage).
 * ────────────────────────────────────────────────────────────── */
const GB = 1024 * 1024 * 1024
// Defaults — used when the admin hasn't overridden the quota in
// appConfig/global, or if that read fails. Kept here so behaviour is
// identical to before the admin control existed.
const DEFAULT_PRO_GB = 100
const DEFAULT_TRIAL_GB = 1.5

/** Read the admin-configured per-tier storage quotas (GB → bytes) from
 *  appConfig/global. The admin sets these in the website panel →
 *  Settings. Falls back to the defaults on a missing/invalid value or
 *  a read error, so storage never breaks on a config hiccup. */
async function getStorageQuotaBytes(): Promise<{
  proBytes: number
  trialBytes: number
}> {
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    const d = (snap.exists ? snap.data() : {}) as {
      proStorageGb?: unknown
      trialStorageGb?: unknown
    }
    const proGb =
      typeof d.proStorageGb === 'number' && d.proStorageGb > 0
        ? d.proStorageGb
        : DEFAULT_PRO_GB
    const trialGb =
      typeof d.trialStorageGb === 'number' && d.trialStorageGb > 0
        ? d.trialStorageGb
        : DEFAULT_TRIAL_GB
    return {
      proBytes: Math.round(proGb * GB),
      trialBytes: Math.round(trialGb * GB),
    }
  } catch (e) {
    console.warn('[storage] quota config read failed, using defaults:', e)
    return {
      proBytes: Math.round(DEFAULT_PRO_GB * GB),
      trialBytes: Math.round(DEFAULT_TRIAL_GB * GB),
    }
  }
}

function storageQuotaForUser(
  user: Record<string, unknown>,
  quota: { proBytes: number; trialBytes: number },
): number {
  // Trial-only access → small quota. Any paid/other Pro path → full.
  if (serverIsTrialActive(user) && user.subscription !== 'pro') {
    return quota.trialBytes
  }
  return quota.proBytes
}

// Compute a user's CURRENT R2 usage + their quota. Usage is summed
// live from their active R2 rounds on every call (accurate + self-
// healing — never drifts, and covers rounds created before any counter
// existed). One query per call; fine at solo-creator scale.
async function getStorageState(
  uid: string,
): Promise<{ usedBytes: number; limitBytes: number }> {
  const [userSnap, quota] = await Promise.all([
    getDb().collection('users').doc(uid).get(),
    getStorageQuotaBytes(),
  ])
  const user = (userSnap.data() as Record<string, unknown>) || {}
  const limitBytes = storageQuotaForUser(user, quota)

  let usedBytes = 0
  try {
    const roundsSnap = await getDb()
      .collection('revisionProjects')
      .where('ownerUid', '==', uid)
      .get()
    for (const d of roundsSnap.docs) {
      const r = d.data() as {
        r2Key?: string
        videoSizeBytes?: number
        status?: string
      }
      // Only R2-backed, non-archived rounds occupy our storage.
      if (r.r2Key && r.status !== 'archived') {
        usedBytes += Number(r.videoSizeBytes) || 0
      }
    }
  } catch (e) {
    console.warn('[storage] usage sum failed:', uid, e)
  }
  return { usedBytes, limitBytes }
}

// Adjust the stored usage counter atomically (deltaBytes may be
// negative on delete). Never lets the counter go below zero.
async function adjustStorageUsage(uid: string, deltaBytes: number): Promise<void> {
  if (!uid || !deltaBytes) return
  try {
    await getDb()
      .collection('users')
      .doc(uid)
      .set({ storageUsedBytes: FieldValue.increment(deltaBytes) }, { merge: true })
    // Clamp negatives that can arise from drift (best-effort).
    if (deltaBytes < 0) {
      const snap = await getDb().collection('users').doc(uid).get()
      const v = Number((snap.data() as { storageUsedBytes?: number })?.storageUsedBytes)
      if (Number.isFinite(v) && v < 0) {
        await getDb().collection('users').doc(uid).update({ storageUsedBytes: 0 })
      }
    }
  } catch (e) {
    console.warn('[storage] adjust usage failed:', uid, deltaBytes, e)
  }
}

// Mirror of isKeyActive() from src/lib/firestore.ts — null/expired
// key returns false; perpetual key (no expiresAt) returns true;
// future expiry returns true; expired-but-still-active PayPal
// subscription gets a 24h grace window before lockout.
function serverIsKeyActive(key: Record<string, unknown> | null): boolean {
  if (!key) return false
  if (!key.expiresAt) return true
  const expiry = new Date(String(key.expiresAt)).getTime()
  if (!Number.isFinite(expiry)) return true
  const now = Date.now()
  if (expiry > now) return true
  if (key.subscriptionStatus === 'active') {
    const SUBSCRIPTION_GRACE_MS = 24 * 60 * 60 * 1000
    return now - expiry <= SUBSCRIPTION_GRACE_MS
  }
  return false
}

/** True if the (already-Firebase-Auth-verified) user has Pro
 *  entitlement. Reads users/{uid}, productKeys (by redeemedBy=uid),
 *  and appConfig/global for the betaMode flag. Order of checks
 *  matches the client (admin email → betaMode → role/subscription
 *  → trial → active key) so denials happen for the same reason at
 *  both layers.
 *
 *  Returns positive at the FIRST signal that qualifies — later
 *  checks (and their potential errors) are skipped once we have a
 *  definite "yes". This keeps the happy path fast AND immune to
 *  errors in later checks for already-qualified users.
 *
 *  Throws on Firestore errors. The caller (`requirePro`) catches
 *  and converts to a 503 — see the doc-block above. */
/* In-memory cache for the global betaMode flag.
 *
 *  `appConfig/global` is identical for every user and changes maybe
 *  once a month (operator toggling beta). Before this cache,
 *  isUserPro re-read it on EVERY call — and isUserPro runs on the
 *  hottest path in the whole API (check-pro on every app boot + tab
 *  entry, plus every requirePro() gate). That was 1 wasted Firestore
 *  read per call, which the runaway-loop incident multiplied into a
 *  read storm.
 *
 *  60s TTL — same freshness window the edge-cached config endpoints
 *  (get-terms / get-privacy) already use. Serverless caveat: each
 *  Vercel instance has its own copy and cold starts re-read, so this
 *  is a best-effort reducer, not a hard guarantee — exactly right for
 *  a non-critical flag. On any read error we return false WITHOUT
 *  caching so the next call retries, preserving the original
 *  "betaMode defaults off on error → fall through to per-user checks"
 *  behavior byte-for-byte. */
let betaModeCache: { value: boolean; expiresAt: number } | null = null
const BETA_MODE_TTL_MS = 60 * 1000

async function isBetaModeOn(): Promise<boolean> {
  const now = Date.now()
  if (betaModeCache && betaModeCache.expiresAt > now) {
    return betaModeCache.value
  }
  try {
    const cfgSnap = await getDb().collection('appConfig').doc('global').get()
    const value = cfgSnap.exists && cfgSnap.data()?.betaMode === true
    betaModeCache = { value, expiresAt: now + BETA_MODE_TTL_MS }
    return value
  } catch (err) {
    console.warn('[revisions/isUserPro] appConfig read failed (continuing):', err)
    return false
  }
}

async function isUserPro(uid: string, email: string): Promise<boolean> {
  // Fast path — admin email, no Firestore round-trip. Admins keep
  // working even if Firestore is completely down.
  if (email && SERVER_ADMIN_EMAILS.has(email.toLowerCase())) return true

  const db = getDb()

  // Beta-mode global override — served from a 60s in-memory cache
  // (see isBetaModeOn) instead of a fresh Firestore read on every
  // call. Same semantics as before: beta on → everyone's Pro; beta
  // off OR doc missing OR read error → fall through to the per-user
  // checks below. Fail-CLOSED posture preserved: the users/{uid} and
  // productKeys reads further down can still throw and bubble to
  // requirePro → 503.
  if (await isBetaModeOn()) return true

  // User doc — primary source of subscription / trial / role state.
  const userSnap = await db.collection('users').doc(uid).get()
  if (userSnap.exists) {
    const user = userSnap.data() as Record<string, unknown>
    if (user.role === 'admin') return true
    if (user.subscription === 'pro') return true
    if (serverIsTrialActive(user)) return true
  }

  // Active redeemed key. Costs an extra round-trip so it's last
  // (most Pro users are subscription-based; key-redeemed users
  // are the minority). Throws bubble up → 503.
  const keySnap = await db
    .collection('productKeys')
    .where('redeemedBy', '==', uid)
    .limit(1)
    .get()
  if (!keySnap.empty) {
    const key = keySnap.docs[0].data() as Record<string, unknown>
    if (serverIsKeyActive(key)) return true
  }

  return false
}

/** Gate a handler behind Pro entitlement. Caller pattern:
 *
 *     const verified = await verifyFirebaseIdToken(...)
 *     if (!verified) return res.status(401).json({...})
 *     if (!(await requirePro(res, verified))) return
 *     // ... continue with the action ...
 *
 *  Three response shapes:
 *    - Pro confirmed         → returns true, no response sent
 *    - Definitively not Pro  → sends 403, returns false
 *    - Couldn't determine    → sends 503, returns false (user
 *                              retries the same request)
 *
 *  The 503 → retry pattern lets a legit user hit a one-off
 *  Firestore blip and recover with a single retry, without ever
 *  granting access to someone we couldn't verify. */
async function requirePro(
  res: VercelResponse,
  verified: VerifiedUser,
): Promise<boolean> {
  let pro: boolean
  try {
    pro = await isUserPro(verified.uid, verified.email)
  } catch (err) {
    console.warn('[revisions/requirePro] entitlement check failed:', err)
    res.status(503).json({
      ok: false,
      error: 'לא הצלחנו לאמת את המנוי כרגע. נסו שוב בעוד רגע.',
    })
    return false
  }
  if (pro) return true
  res.status(403).json({
    ok: false,
    error: 'נדרש מנוי Pro פעיל כדי להשתמש בסבבי תיקונים',
  })
  return false
}

/* ──────────────────────────────────────────────────────────────
 *  Google Drive token exchange / refresh
 * ────────────────────────────────────────────────────────────── */

interface GoogleTokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope: string
  token_type: 'Bearer'
  id_token?: string
}

async function exchangeAuthCode(code: string): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET env vars not set')
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  })
  const r = await fetch(GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Google token exchange failed: ${r.status} ${errText}`)
  }
  return (await r.json()) as GoogleTokenResponse
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string
  expiresIn: number
}> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET env vars not set')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const r = await fetch(GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Google token refresh failed: ${r.status} ${errText}`)
  }
  const json = (await r.json()) as { access_token: string; expires_in: number }
  return { accessToken: json.access_token, expiresIn: json.expires_in }
}

async function revokeRefreshToken(refreshToken: string): Promise<void> {
  // Best-effort revoke at Google. We deliberately don't fail the
  // disconnect flow if Google says "already revoked" — the local
  // Firestore record is the source of truth from our perspective.
  try {
    await fetch(`${GOOGLE_REVOKE_URI}?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST',
    })
  } catch (err) {
    console.warn('[revisions] revoke failed (ignoring):', err)
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Get the Google email associated with an access token
 * ────────────────────────────────────────────────────────────── */

async function googleUserInfoEmail(accessToken: string): Promise<string | null> {
  // Use the lightweight tokeninfo endpoint instead of the heavier
  // userinfo endpoint — we only need the email and it's part of the
  // standard tokeninfo response when openid/email scope is granted.
  // Falls back to the v3 userinfo endpoint if tokeninfo doesn't
  // include the email (depends on which scopes the user granted).
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!r.ok) return null
    const json = (await r.json()) as { email?: string }
    return json.email ? json.email.toLowerCase() : null
  } catch {
    return null
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Firestore helpers — integration doc path
 * ────────────────────────────────────────────────────────────── */

function integrationDocRef(uid: string) {
  return getDb().collection('users').doc(uid).collection('integrations').doc('googleDrive')
}

interface IntegrationDoc {
  connected: true
  email: string
  scope: string
  connectedAt: number
  lastUsedAt: number
  refreshTokenEnc: EncryptedToken
}

/* ──────────────────────────────────────────────────────────────
 *  Action: oauth-start
 *
 *  GET /api/revisions?action=oauth-start&idToken=<token>
 *
 *  Verifies the Firebase ID token to identify the user, mints a
 *  state JWT, redirects to Google.
 *
 *  Why GET + idToken in query: this endpoint is invoked by the
 *  Electron app opening the user's default browser. POST + body
 *  isn't possible across the open-browser handoff. We accept the
 *  slight risk of the idToken appearing in browser history;
 *  Firebase ID tokens expire in 1 hour anyway, and the state JWT
 *  that takes its place in the URL after the redirect is feature-
 *  scoped (drive-oauth purpose only) and 10-min-lived.
 * ────────────────────────────────────────────────────────────── */
async function handleOauthStart(req: VercelRequest, res: VercelResponse) {
  // `source` lets the caller tell us where to send them after the
  // Google handoff completes. The desktop opens this URL in the
  // system browser and depends on the post-callback HTML page (so
  // the user can close the tab themselves); the website opens it
  // in-place and wants a redirect back into the SPA. Defaults to
  // 'desktop' for backward compat with existing Electron builds
  // that don't send this param.
  const sourceRaw = String(req.query.source || '').trim().toLowerCase()
  const source: 'desktop' | 'web' = sourceRaw === 'web' ? 'web' : 'desktop'
  // verifyOwnerAuth accepts either Firebase ID token (desktop) or
  // website session token (web). Both arrive in the query string
  // for this handler because it's hit via a GET navigation that
  // can't carry a body.
  const verified = await verifyOwnerAuth(req)
  if (!verified) {
    return res.status(401).send(errorHtml('יש להתחבר מחדש ולנסות שוב.'))
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) {
    return res.status(500).send(errorHtml('שירות החיבור לא מוגדר. פנו לתמיכה.'))
  }
  const state = mintStateToken(verified.uid, source)
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    // `offline` is what causes Google to return a refresh_token (in
    // addition to the access_token). Without it we'd only get the
    // 1-hour access token and would have to prompt the user again
    // every hour — unusable.
    access_type: 'offline',
    // Two prompts, space-separated:
    //   select_account — force the multi-account picker EVERY TIME,
    //     even if the user is logged in to only one Google account.
    //     Critical because the email a user signed up to OUR app
    //     with often differs from the Drive they want to use for
    //     client review (personal vs. work account). Without this,
    //     Google silently picks "the default account" and there's
    //     no way to switch.
    //   consent — force the consent screen even if the user
    //     previously approved this app, so we get a FRESH
    //     refresh_token on every connect. Without consent, Google
    //     sometimes skips the screen and returns NO refresh_token
    //     on subsequent grants, leaving us stuck.
    prompt: 'select_account consent',
    state,
    // No login_hint — the user explicitly should be able to pick
    // ANY of their Google accounts. We don't want to nudge them
    // toward the email they happen to be using in our desktop app.
  })
  res.setHeader('Cache-Control', 'no-store')
  return res.redirect(302, `${GOOGLE_AUTH_URI}?${params.toString()}`)
}

/* ──────────────────────────────────────────────────────────────
 *  Action: oauth-callback
 *
 *  GET /api/revisions?action=oauth-callback&code=...&state=...
 *  GET /api/revisions?action=oauth-callback&error=access_denied&state=...
 *
 *  Receives Google's response after the user accepts/declines.
 * ────────────────────────────────────────────────────────────── */
async function handleOauthCallback(req: VercelRequest, res: VercelResponse) {
  const state = String(req.query.state || '').trim()
  const code = String(req.query.code || '').trim()
  const googleError = String(req.query.error || '').trim()

  const claims = verifyStateToken(state)
  if (!claims) {
    return res
      .status(400)
      .send(errorHtml('הקישור פג תוקף. נסו להתחבר שוב מהתוכנה.'))
  }

  if (googleError) {
    // User clicked "Cancel" on the consent screen, or Google rejected.
    return res
      .status(400)
      .send(errorHtml(`Google דחה את הבקשה (${googleError}). אפשר לסגור את החלון ולנסות שוב.`))
  }

  if (!code) {
    return res.status(400).send(errorHtml('לא התקבל קוד אישור מ-Google.'))
  }

  let tokens: GoogleTokenResponse
  try {
    tokens = await exchangeAuthCode(code)
  } catch (err) {
    console.error('[revisions/oauth-callback] token exchange failed:', err)
    return res.status(502).send(errorHtml('החלפת הקוד מול Google נכשלה. נסו שוב.'))
  }

  if (!tokens.refresh_token) {
    // This shouldn't happen because we forced prompt=consent, but
    // belt-and-suspenders: tell the user clearly instead of silently
    // failing with a half-broken connection.
    return res
      .status(500)
      .send(
        errorHtml(
          'Google לא החזיר refresh token. נתקו את החיבור הקיים מ-Google Account → Security ונסו שוב.',
        ),
      )
  }

  const email = (await googleUserInfoEmail(tokens.access_token)) || ''

  const doc: IntegrationDoc = {
    connected: true,
    email,
    scope: tokens.scope,
    connectedAt: Date.now(),
    lastUsedAt: Date.now(),
    refreshTokenEnc: encryptToken(tokens.refresh_token),
  }

  try {
    await integrationDocRef(claims.uid).set(doc, { merge: true })
  } catch (err) {
    console.error('[revisions/oauth-callback] firestore write failed:', err)
    return res
      .status(500)
      .send(errorHtml('שמירת החיבור נכשלה. נסו שוב או פנו לתמיכה.'))
  }

  // Branch on origin: desktop gets the "you can close this tab"
  // HTML page (Electron opened the URL in the system browser, the
  // app is polling Firestore for connection state, the user needs
  // a visual cue that something happened). Web users came from
  // inside the SPA — bounce them straight back to /revisions so
  // they don't have to manually navigate. Cache-Control: no-store
  // because the email we just connected with is sensitive enough
  // that we don't want it sitting in any intermediate cache.
  if (claims.source === 'web') {
    const target = `${WEBSITE_BASE}/revisions?oauth=connected`
    res.setHeader('Cache-Control', 'no-store')
    return res.redirect(302, target)
  }
  return res.status(200).send(successHtml(email))
}

/* ──────────────────────────────────────────────────────────────
 *  Action: access-token
 *
 *  POST /api/revisions?action=access-token  { idToken }
 *  Returns { ok, accessToken, expiresIn }
 *
 *  The Electron app calls this just-in-time before any Drive API
 *  operation (upload, list, get, etc.). The refresh token never
 *  leaves the server.
 * ────────────────────────────────────────────────────────────── */
async function handleAccessToken(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const snap = await integrationDocRef(verified.uid).get()
  if (!snap.exists) {
    return res
      .status(404)
      .json({ ok: false, error: 'Drive לא מחובר. חבר חשבון Google Drive בהגדרות.' })
  }
  const data = snap.data() as IntegrationDoc
  const refreshToken = decryptToken(data.refreshTokenEnc)

  let fresh: { accessToken: string; expiresIn: number }
  try {
    fresh = await refreshAccessToken(refreshToken)
  } catch (err) {
    console.error('[revisions/access-token] refresh failed:', err)
    // Most likely cause: the user revoked our app's access via
    // their Google Account settings. Surface this to the user so
    // they know to reconnect, not retry.
    return res.status(401).json({
      ok: false,
      error: 'החיבור ל-Drive פג. יש להתחבר מחדש.',
      needsReconnect: true,
    })
  }

  // Best-effort "last activity" touch — THROTTLED to at most once
  // per hour. access-token is called just-in-time before every Drive
  // operation (often many times per editing session), and writes
  // count against the Firestore daily write quota. The lastUsedAt
  // field isn't displayed anywhere in either client (verified by
  // grep), so hour-granularity is more than enough — we just don't
  // want a write on every single token mint. `data` is the
  // integration doc we already read above, so this guard costs zero
  // extra reads.
  const HOUR_MS = 60 * 60 * 1000
  const lastTouch =
    typeof data.lastUsedAt === 'number' ? data.lastUsedAt : 0
  if (Date.now() - lastTouch > HOUR_MS) {
    void integrationDocRef(verified.uid)
      .update({ lastUsedAt: Date.now() })
      .catch(() => undefined)
  }

  return res.status(200).json({
    ok: true,
    accessToken: fresh.accessToken,
    expiresIn: fresh.expiresIn,
    email: data.email,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Drive Picker hand-off (desktop ⇄ system browser)
 *
 *  Google blocks its Picker / OAuth sign-in inside embedded Electron
 *  windows ("disallowed_useragent" / "this browser may not be
 *  secure"), so the desktop runs the Picker in the user's REAL
 *  browser — where they already have a Google session — and the
 *  chosen file is relayed back through a short-lived session doc,
 *  exactly like the OAuth flow returns via the browser.
 *
 *  Flow:
 *    1. desktop  → picker-open   {idToken}            → {nonce}
 *    2. desktop opens browser at /drive-picker?session=<nonce>
 *    3. browser  → picker-token  ?session=<nonce>     → {accessToken}
 *    4. browser runs the Picker, then
 *       browser  → picker-result {session,file|canceled}
 *    5. desktop  → picker-poll   {idToken,session}    → {status,file?}
 *
 *  The nonce is a 256-bit capability with a 10-minute TTL; the Drive
 *  token is minted on demand and never stored.
 * ────────────────────────────────────────────────────────────── */
const PICKER_SESSION_TTL_MS = 10 * 60 * 1000

interface PickedFile {
  id: string
  name: string
  sizeBytes: number
  mimeType: string
}
interface PickerSessionDoc {
  uid: string
  status: 'pending' | 'done' | 'canceled'
  createdAt: number
  file?: PickedFile
}

function pickerSessionRef(nonce: string) {
  return getDb().collection('pickerSessions').doc(nonce)
}

/** POST { idToken } → { ok, nonce } */
async function handlePickerOpen(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const snap = await integrationDocRef(verified.uid).get()
  if (!snap.exists) {
    return res.status(404).json({ ok: false, error: 'Drive לא מחובר' })
  }
  const nonce = crypto.randomBytes(32).toString('base64url')
  const doc: PickerSessionDoc = {
    uid: verified.uid,
    status: 'pending',
    createdAt: Date.now(),
  }
  await pickerSessionRef(nonce).set(doc)
  return res.status(200).json({ ok: true, nonce })
}

/** GET/POST ?session=<nonce> → { ok, accessToken }
 *  Called by the browser picker page. The nonce is the capability —
 *  it only mints a drive.file-scoped, short-lived token while the
 *  session is still pending and unexpired. */
async function handlePickerToken(req: VercelRequest, res: VercelResponse) {
  const nonce = String(
    req.query.session || (req.body as { session?: string })?.session || '',
  )
  if (!nonce) return res.status(400).json({ ok: false, error: 'missing session' })
  const snap = await pickerSessionRef(nonce).get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'session not found' })
  const data = snap.data() as PickerSessionDoc
  if (Date.now() - data.createdAt > PICKER_SESSION_TTL_MS) {
    return res.status(410).json({ ok: false, error: 'session expired' })
  }
  if (data.status !== 'pending') {
    return res.status(409).json({ ok: false, error: 'session already used' })
  }
  const intSnap = await integrationDocRef(data.uid).get()
  if (!intSnap.exists) return res.status(404).json({ ok: false, error: 'drive not connected' })
  const intData = intSnap.data() as IntegrationDoc
  try {
    const fresh = await refreshAccessToken(decryptToken(intData.refreshTokenEnc))
    return res.status(200).json({ ok: true, accessToken: fresh.accessToken })
  } catch {
    return res.status(401).json({ ok: false, error: 'drive token refresh failed' })
  }
}

/** POST { session, file } | { session, canceled:true } → { ok } */
async function handlePickerResult(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    session?: string
    canceled?: boolean
    file?: Partial<PickedFile>
  }
  const nonce = String(body.session || '')
  if (!nonce) return res.status(400).json({ ok: false, error: 'missing session' })
  const ref = pickerSessionRef(nonce)
  const snap = await ref.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'session not found' })
  const data = snap.data() as PickerSessionDoc
  if (Date.now() - data.createdAt > PICKER_SESSION_TTL_MS) {
    return res.status(410).json({ ok: false, error: 'session expired' })
  }
  if (body.canceled) {
    await ref.update({ status: 'canceled' })
    return res.status(200).json({ ok: true })
  }
  const f = body.file
  if (!f || !f.id) return res.status(400).json({ ok: false, error: 'missing file' })
  const file: PickedFile = {
    id: String(f.id),
    name: String(f.name || 'video'),
    sizeBytes: Number(f.sizeBytes) || 0,
    mimeType: String(f.mimeType || 'video/mp4'),
  }
  await ref.update({ status: 'done', file })
  return res.status(200).json({ ok: true })
}

/** POST { idToken, session } → { ok, status: 'pending'|'done'|'canceled'|'expired', file? } */
async function handlePickerPoll(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const body = (req.body || {}) as { session?: string }
  const nonce = String(body.session || '')
  if (!nonce) return res.status(400).json({ ok: false, error: 'missing session' })
  const ref = pickerSessionRef(nonce)
  const snap = await ref.get()
  if (!snap.exists) return res.status(200).json({ ok: true, status: 'expired' })
  const data = snap.data() as PickerSessionDoc
  if (data.uid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  if (data.status === 'done' || data.status === 'canceled') {
    void ref.delete().catch(() => undefined)
    return res.status(200).json({ ok: true, status: data.status, file: data.file })
  }
  if (Date.now() - data.createdAt > PICKER_SESSION_TTL_MS) {
    return res.status(200).json({ ok: true, status: 'expired' })
  }
  return res.status(200).json({ ok: true, status: 'pending' })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: oauth-status
 * ────────────────────────────────────────────────────────────── */
async function handleOauthStatus(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  // Which storage backend this user is on (admin-controlled, default R2),
  // plus their R2 usage + quota for the in-app storage bar.
  const userSnap = await getDb().collection('users').doc(verified.uid).get()
  const userDoc = (userSnap.data() as Record<string, unknown>) || {}
  const storageBackend = userDoc.storageBackend === 'drive' ? 'drive' : 'r2'
  // Compute usage LIVE from the user's actual R2 rounds rather than the
  // stored counter — the counter is 0 for rounds created before it
  // existed (and can drift), which made the in-app bar read "0 B" even
  // with real videos uploaded. getStorageState sums every active
  // r2Key round's videoSizeBytes on each call.
  const { usedBytes: storageUsedBytes, limitBytes: storageLimitBytes } =
    await getStorageState(verified.uid)

  const snap = await integrationDocRef(verified.uid).get()
  if (!snap.exists) {
    return res.status(200).json({
      ok: true,
      connected: false,
      storageBackend,
      storageUsedBytes,
      storageLimitBytes,
    })
  }
  const data = snap.data() as IntegrationDoc
  return res.status(200).json({
    ok: true,
    connected: true,
    storageBackend,
    storageUsedBytes,
    storageLimitBytes,
    email: data.email,
    // Full integration shape so the desktop can stop using a
    // direct Firestore listener (blocked by rules for non-admin
    // users) and rely entirely on this server-side read instead.
    // Admin SDK on the server bypasses rules, so this works for
    // every user regardless of how their Firestore rules are
    // configured.
    scope: data.scope || '',
    connectedAt: data.connectedAt,
    lastUsedAt: data.lastUsedAt,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: check-pro
 *
 *  POST /api/revisions?action=check-pro { idToken | sessionToken }
 *  Returns { ok: true, isPro: boolean }
 *
 *  The /paypal?action=status endpoint only knows about PayPal
 *  subscriptions, but a user can be Pro via a redeemed product
 *  key, an active trial, an admin role, or the betaMode global.
 *  This action wraps the canonical isUserPro() check so the web
 *  /revisions page can ask "is this user entitled?" in one round-
 *  trip without re-implementing the gate ladder client-side.
 *
 *  No requirePro() here — the whole point IS the gate check, so
 *  we surface the answer instead of bouncing 403.
 * ────────────────────────────────────────────────────────────── */
async function handleCheckPro(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const pro = await isUserPro(verified.uid, verified.email)
    return res.status(200).json({ ok: true, isPro: pro })
  } catch (err) {
    // Fail-closed: same posture as requirePro — when we can't
    // determine entitlement we say "unknown" via 503 rather than
    // ever falsely returning isPro:true on an error path.
    console.warn('[revisions/check-pro] entitlement check failed:', err)
    return res
      .status(503)
      .json({ ok: false, error: 'לא הצלחנו לבדוק את המנוי כרגע. נסו שוב.' })
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Action: oauth-disconnect
 * ────────────────────────────────────────────────────────────── */
async function handleOauthDisconnect(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const ref = integrationDocRef(verified.uid)
  const snap = await ref.get()
  if (snap.exists) {
    const data = snap.data() as IntegrationDoc
    try {
      const refreshToken = decryptToken(data.refreshTokenEnc)
      await revokeRefreshToken(refreshToken)
    } catch (err) {
      console.warn('[revisions/oauth-disconnect] decrypt/revoke failed:', err)
    }
    await ref.delete()
  }
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: drive-storage  (auth required)
 *
 *  POST /api/revisions?action=drive-storage  { idToken }
 *  Returns: { ok, usageBytes, limitBytes, usageInDriveBytes?,
 *             usageInTrashBytes? }
 *
 *  Reads the user's Drive storage quota via Drive's `/about`
 *  endpoint. Surfaced in the desktop footer so the editor knows
 *  how much room they still have before uploads start failing.
 *  Cheap call — Drive returns the numbers from a cached counter,
 *  no scan. limitBytes is missing for accounts on the "unlimited"
 *  Google Workspace plans, in which case the desktop just hides
 *  the usage bar and shows the absolute usage.
 * ────────────────────────────────────────────────────────────── */
async function handleDriveStorage(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const integrationSnap = await integrationDocRef(verified.uid).get()
  if (!integrationSnap.exists) {
    return res.status(404).json({ ok: false, error: 'Drive לא מחובר' })
  }
  const integration = integrationSnap.data() as IntegrationDoc
  let accessToken: string
  try {
    const refreshToken = decryptToken(integration.refreshTokenEnc)
    const tokenResp = await refreshAccessToken(refreshToken)
    accessToken = tokenResp.accessToken
  } catch {
    return res.status(401).json({ ok: false, error: 'Drive auth פג תוקף' })
  }

  // storageQuota fields:
  //   - limit       : total storage in bytes (string in JSON;
  //                   absent for unlimited Workspace plans)
  //   - usage       : total bytes used (Drive + Gmail + Photos)
  //   - usageInDrive: bytes used by Drive specifically
  //   - usageInDriveTrash: bytes in the Drive trash
  // We coerce to numbers ourselves — Drive returns strings to
  // avoid 53-bit precision loss on huge accounts, but for the
  // sizes the desktop displays (up to a few hundred GB) the
  // safe-integer range is fine.
  const aboutResp = await fetch(
    'https://www.googleapis.com/drive/v3/about?fields=storageQuota',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!aboutResp.ok) {
    const txt = await aboutResp.text().catch(() => '')
    console.warn('[revisions/drive-storage] about failed:', aboutResp.status, txt.slice(0, 200))
    return res.status(502).json({ ok: false, error: 'שגיאה בקריאת מצב הדרייב' })
  }
  const json = (await aboutResp.json()) as {
    storageQuota?: {
      limit?: string
      usage?: string
      usageInDrive?: string
      usageInDriveTrash?: string
    }
  }
  const q = json.storageQuota || {}
  return res.status(200).json({
    ok: true,
    usageBytes: Number(q.usage || 0),
    limitBytes: q.limit ? Number(q.limit) : null,
    usageInDriveBytes: q.usageInDrive ? Number(q.usageInDrive) : null,
    usageInTrashBytes: q.usageInDriveTrash ? Number(q.usageInDriveTrash) : null,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  HTML responses for the OAuth callback flow
 *
 *  These pages live INSIDE the response body of the callback
 *  endpoint instead of being served as separate routes. Reason:
 *  Vercel Hobby plan caps us at 12 serverless functions and we're
 *  already there. Inline HTML costs zero extra functions and gives
 *  the user a polished landing without a separate /oauth-success
 *  route.
 *
 *  The pages don't try to look identical to the app — that would
 *  require loading the whole React bundle just for a one-time
 *  hand-off screen. They go for "respectful editorial card", same
 *  espresso bg + warm copper accent, matching font.
 * ────────────────────────────────────────────────────────────── */

function pageShell(args: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(args.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #16110D;
      --fg: #F5EFE6;
      --fg-muted: #8B8170;
      --primary: #B8794F;
      --border: rgba(245, 239, 230, 0.08);
    }
    html, body {
      background: var(--bg);
      color: var(--fg);
      font-family: 'Rubik', system-ui, sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px 28px;
      text-align: center;
    }
    .icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 16px;
      border-radius: 14px;
      background: rgba(184, 121, 79, 0.12);
      color: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 0 0 12px;
    }
    p {
      font-size: 14px;
      line-height: 1.55;
      color: var(--fg-muted);
      margin: 0 0 6px;
    }
    p strong {
      color: var(--fg);
      font-weight: 500;
    }
    .hint {
      margin-top: 20px;
      font-size: 12px;
      color: var(--fg-muted);
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      ${args.bodyHtml}
    </div>
  </div>
</body>
</html>`
}

function successHtml(email: string): string {
  return pageShell({
    title: 'התחברת בהצלחה',
    bodyHtml: `
      <div class="icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"/>
        </svg>
      </div>
      <h1>החיבור ל-Google Drive הצליח</h1>
      <p>החיבור בוצע ל-<strong dir="ltr">${escapeHtml(email)}</strong></p>
      <p>אפשר לסגור את החלון הזה ולחזור לתוכנה.</p>
      <p class="hint">התוכנה תזהה את החיבור באופן אוטומטי.</p>
    `,
  })
}

function errorHtml(message: string): string {
  return pageShell({
    title: 'שגיאה בחיבור',
    bodyHtml: `
      <div class="icon" aria-hidden="true" style="background: rgba(193, 107, 95, 0.15); color: #C16B5F;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <h1>החיבור נכשל</h1>
      <p>${escapeHtml(message)}</p>
    `,
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ──────────────────────────────────────────────────────────────
 *  PROJECT GROUPS — multi-round projects (new shape)
 *
 *  Until this section was added, each "revision project" was a
 *  single video round and got its own public share link. Editors
 *  who iterated through multiple rounds on the same cut ended up
 *  with N separate cards in their desktop list and N separate
 *  links to send the client — confusing for both sides.
 *
 *  The new shape introduces a "revision group" — a project that
 *  contains one or more rounds. One share link per group; rounds
 *  numbered 1, 2, 3… inside. Password and title live on the
 *  group; each round has its own video file + per-round lock.
 *
 *  Data layout:
 *    revisionGroups/{groupId}                    ← project
 *      • title, shareToken, passwordHash, ownerUid, ownerEmail,
 *        driveFolderId, notesFolderId, status, createdAt, updatedAt
 *    revisionProjects/{roundId}                  ← round (existing
 *                                                  collection, now
 *                                                  with optional
 *                                                  groupId pointer)
 *      • groupId (NEW), roundNumber, driveFileId, video* fields,
 *        videoStatus, locked, notesCount, createdAt, updatedAt
 *    revisionProjects/{roundId}/notes/{noteId}   ← notes (unchanged)
 *
 *  Backward compatibility: existing revisionProjects docs without a
 *  groupId continue to act as standalone "round-as-project" units.
 *  Their shareToken + passwordHash + title live on the round doc
 *  itself (as before) and existing /review/<token> links keep
 *  resolving directly.
 *
 *  Public /review URL semantics:
 *    /review/<token>           ↳ if token matches a group →
 *                                round picker (or single round if
 *                                exactly one).
 *                              ↳ if token matches a legacy round →
 *                                render that round directly.
 *    /review/<token>?round=ID  ↳ specific round of a group.
 * ────────────────────────────────────────────────────────────── */

interface RevisionGroupDoc {
  id: string
  ownerUid: string
  ownerEmail: string
  title: string
  shareToken: string
  passwordHash: string | null
  passwordSalt: string | null
  driveFolderId: string | null
  notesFolderId: string | null
  status: 'active' | 'archived'
  /** Public-review-page toggles, settable by the owner in the
   *  edit-project modal. All have safe legacy defaults so groups
   *  created before this field was added behave the same as the
   *  original ship: watermark on, download off, Drive link off.
   *
   *  - watermark      : show the animated viewer-email watermark
   *                     over the video.
   *  - allowDownload  : let the browser render the native download
   *                     button on the player (removes the
   *                     controlsList="nodownload" hint).
   *  - openInDrive    : surface a "פתח ב-Google Drive" link on the
   *                     workspace. Requires the editor to have
   *                     marked the underlying Drive file as
   *                     publicly viewable (already done at upload
   *                     time via setShareablePermissions). */
  watermark?: boolean
  allowDownload?: boolean
  openInDrive?: boolean
  /** Denormalised count of active rounds in this group. Maintained
   *  by add-round / delete-round so the project LIST can render the
   *  round count without reading every round doc (lazy-load). Older
   *  groups created before this field exists get it backfilled the
   *  first time list-groups-owner runs. */
  roundCount?: number
  createdAt: number
  updatedAt: number
}

/** Resolve a share token into either a new-style group or a legacy
 *  single-round project. The two collections share namespace via
 *  shareToken — a fresh token created today goes into the groups
 *  collection; tokens from before the migration live on revision
 *  Projects docs. We check the groups first because new traffic
 *  is more common than legacy lookups. */
async function resolveByShareToken(
  shareToken: string,
): Promise<
  | { kind: 'group'; group: RevisionGroupDoc; ref: FirebaseFirestore.DocumentReference }
  | { kind: 'legacy'; round: Record<string, unknown>; ref: FirebaseFirestore.DocumentReference }
  | null
> {
  const groupsSnap = await getDb()
    .collection('revisionGroups')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (!groupsSnap.empty) {
    const doc = groupsSnap.docs[0]
    return {
      kind: 'group',
      group: doc.data() as RevisionGroupDoc,
      ref: doc.ref,
    }
  }
  const legacySnap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (!legacySnap.empty) {
    const doc = legacySnap.docs[0]
    return {
      kind: 'legacy',
      round: doc.data() as Record<string, unknown>,
      ref: doc.ref,
    }
  }
  return null
}

/** Single resolver for every public note-side action.
 *
 *  Given a shareToken (and, for new-style groups, a roundId hint),
 *  returns the ROUND we should operate on. Handles both shapes
 *  transparently:
 *
 *    Legacy: shareToken lives directly on the round doc; the round
 *            IS the project. roundIdHint is ignored.
 *    Group:  shareToken lives on a revisionGroups doc. The caller
 *            must also pass roundId so we know which sibling round
 *            inside the project they meant. We cross-check that the
 *            round belongs to the group (rejects a token-A round-of-
 *            group-B attack).
 *
 *  Validates password (using the matching entity's passwordHash)
 *  and active-status before returning. Caller doesn't need to
 *  re-check either — they get a ready-to-use round doc.
 *
 *  projectIdForPasswordToken is what the caller should pass when
 *  it later calls verifyPasswordToken: the GROUP's id for new-style,
 *  the ROUND's id for legacy. verify-password mints tokens against
 *  the same id, so the symmetry stays consistent. */
async function resolvePublicRound(
  shareToken: string,
  roundIdHint: string | undefined | null,
  passwordToken: string | undefined | null,
): Promise<
  | {
      ok: true
      roundRef: FirebaseFirestore.DocumentReference
      roundData: Record<string, unknown>
      /** Non-null when the round belongs to a new-style group. */
      group: RevisionGroupDoc | null
      /** The id the matching passwordToken (if any) was minted for. */
      projectIdForPasswordToken: string
    }
  | { ok: false; status: number; error: string }
> {
  const resolved = await resolveByShareToken(shareToken)
  if (!resolved) return { ok: false, status: 404, error: 'הקישור לא נמצא' }

  if (resolved.kind === 'group') {
    const group = resolved.group
    if (group.status !== 'active') {
      return { ok: false, status: 410, error: 'הפרויקט כבר לא פעיל' }
    }
    if (group.passwordHash) {
      const pt = String(passwordToken || '').trim()
      if (!pt || !verifyPasswordToken(pt, group.id)) {
        return { ok: false, status: 403, error: 'נדרשת סיסמה' }
      }
    }
    const roundId = String(roundIdHint || '').trim()
    if (!roundId) {
      return { ok: false, status: 400, error: 'roundId required for group' }
    }
    const roundRef = getDb().collection('revisionProjects').doc(roundId)
    const roundSnap = await roundRef.get()
    if (!roundSnap.exists) {
      return { ok: false, status: 404, error: 'הסבב לא נמצא' }
    }
    const roundData = roundSnap.data() as Record<string, unknown>
    if (roundData.groupId !== group.id) {
      // Cross-project lookup — security violation. Token A asked
      // to operate on a round that lives in a different project.
      return { ok: false, status: 403, error: 'forbidden' }
    }
    if (roundData.status && roundData.status !== 'active') {
      return { ok: false, status: 410, error: 'הסבב כבר לא פעיל' }
    }
    return {
      ok: true,
      roundRef,
      roundData,
      group,
      projectIdForPasswordToken: group.id,
    }
  }

  // Legacy path — shareToken matched a round-as-project. The
  // password (if any) was minted for the round's id.
  const round = resolved.round
  const roundId = String(round.id || '')
  if (round.status && round.status !== 'active') {
    return { ok: false, status: 410, error: 'הסבב כבר לא פעיל' }
  }
  if (round.passwordHash) {
    const pt = String(passwordToken || '').trim()
    if (!pt || !verifyPasswordToken(pt, roundId)) {
      return { ok: false, status: 403, error: 'נדרשת סיסמה' }
    }
  }
  return {
    ok: true,
    roundRef: resolved.ref,
    roundData: round,
    group: null,
    projectIdForPasswordToken: roundId,
  }
}

/** Hash a password with PBKDF2-SHA256. Returns null hash/salt for
 *  an empty password (= no password protection). Same primitive
 *  the rest of revisions.ts uses; centralised here so the new
 *  group flow and the legacy create-project flow can't drift. */
function hashPasswordOrNull(
  password: string,
): { passwordHash: string; passwordSalt: string } | null {
  if (!password) return null
  const passwordSalt = crypto.randomBytes(16).toString('hex')
  const passwordHash = crypto
    .pbkdf2Sync(password, passwordSalt, 100_000, 32, 'sha256')
    .toString('hex')
  return { passwordHash, passwordSalt }
}

/* ──────────────────────────────────────────────────────────────
 *  Action: create-project-group  (auth required)
 *
 *  POST /api/revisions?action=create-project-group
 *  Body: {
 *    idToken,
 *    title,             // project title
 *    password?,         // project-level password (optional)
 *    // first-round details — same shape as create-project's body:
 *    driveFileId, driveFolderId,
 *    videoFileName, videoSizeBytes, videoMime,
 *    roundNumber? (default 1),
 *  }
 *  Returns: { ok, groupId, roundId, shareToken, shareUrl }
 *
 *  Creates the group + its first round in a single batch so we
 *  never end up with an orphan group (a project with zero rounds)
 *  or a round with a dangling groupId pointer.
 * ────────────────────────────────────────────────────────────── */
async function handleCreateProjectGroup(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    idToken?: string
    title?: string
    password?: string
    // Dual storage backend: an R2-backed round carries r2Key; a
    // Drive-backed round carries driveFileId (+ driveFolderId). The
    // client sends whichever its user's storageBackend dictates.
    r2Key?: string
    driveFileId?: string
    driveFolderId?: string
    videoFileName?: string
    videoSizeBytes?: number
    videoMime?: string
    roundNumber?: number
    // Public-review-page toggles, settable at creation time so
    // the editor can pre-configure a project without having to
    // open the edit modal afterwards. All optional — server
    // falls back to the safe defaults (watermark on, download
    // off, Drive link off) when omitted.
    watermark?: boolean
    allowDownload?: boolean
    openInDrive?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const title = String(body.title || '').trim().slice(0, 200)
  const r2Key = String(body.r2Key || '').trim()
  const driveFileId = String(body.driveFileId || '').trim()
  // Drive note-media needs the parent folder; R2 rounds leave it null.
  const driveFolderId = String(body.driveFolderId || '').trim() || null
  const hasVideo = !!(r2Key || driveFileId)
  const videoFileName = String(body.videoFileName || '').trim().slice(0, 300)
  const videoSizeBytes = Number(body.videoSizeBytes) || 0
  const videoMime = String(body.videoMime || '').trim().slice(0, 100)
  const password = String(body.password || '')
  const roundNumber = Math.max(
    1,
    Math.min(99, Math.floor(Number(body.roundNumber) || 1)),
  )

  if (!title) return res.status(400).json({ ok: false, error: 'title required' })
  // driveFileId is OPTIONAL — when omitted we create an "empty"
  // project (group only, no rounds). The editor's typical flow is:
  //   1. "+ פרויקט"   → name + optional password → empty group
  //   2. "+ סבב חדש"  → upload first video → first round
  // This separation lets editors plan projects ahead of having the
  // video ready, and matches the user's expectation that "creating
  // a project" is a lightweight naming step distinct from uploading.

  let pw: { passwordHash: string; passwordSalt: string } | null = null
  if (password) {
    if (password.length < 4) {
      return res.status(400).json({ ok: false, error: 'הסיסמה קצרה מדי (4 תווים מינימום)' })
    }
    pw = hashPasswordOrNull(password)
  }

  const shareToken = crypto.randomBytes(16).toString('base64url')
  const db = getDb()
  const groupRef = db.collection('revisionGroups').doc()
  const now = Date.now()

  // Group doc — always written. If we also got a video this call
  // creates the first round in the same batch (atomically so the
  // share link is never half-baked).
  const batch = db.batch()
  batch.set(groupRef, {
    id: groupRef.id,
    ownerUid: verified.uid,
    ownerEmail: verified.email,
    title,
    shareToken,
    passwordHash: pw?.passwordHash ?? null,
    passwordSalt: pw?.passwordSalt ?? null,
    driveFolderId,
    notesFolderId: null,
    status: 'active',
    // Public-review-page toggles. Pre-fill from the request body
    // when the editor set them in the creation modal — otherwise
    // fall back to the safe defaults (watermark on, download off,
    // Drive link off). The edit-project modal can flip any of
    // them later.
    watermark: typeof body.watermark === 'boolean' ? body.watermark : true,
    allowDownload:
      typeof body.allowDownload === 'boolean' ? body.allowDownload : false,
    openInDrive:
      typeof body.openInDrive === 'boolean' ? body.openInDrive : false,
    // Denormalised count of active rounds — lets the project list
    // render the card (with its round count) WITHOUT reading every
    // round doc. Maintained on add-round / delete-round.
    roundCount: hasVideo ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  })

  let roundIdOut: string | null = null
  if (hasVideo) {
    const roundRef = db.collection('revisionProjects').doc()
    roundIdOut = roundRef.id
    batch.set(roundRef, {
      id: roundRef.id,
      // Linkage — distinguishes new-style rounds from legacy ones.
      groupId: groupRef.id,
      // Owner is mirrored onto the round for query convenience (so
      // a single where('ownerUid','==',uid) over revisionProjects
      // still returns the editor's rounds without needing a parent
      // lookup).
      ownerUid: verified.uid,
      ownerEmail: verified.email,
      // Exactly one of these is set, per the user's storage backend.
      // null (not undefined) so the field exists for queries/clarity.
      r2Key: r2Key || null,
      driveFileId: driveFileId || null,
      driveFolderId,
      videoFileName,
      videoSizeBytes,
      videoMime,
      videoStatus: 'ready',
      roundNumber,
      locked: false,
      notesCount: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
  }
  await batch.commit()

  // Count R2 storage toward the user's quota (Drive videos don't).
  if (r2Key && videoSizeBytes > 0) {
    await adjustStorageUsage(verified.uid, videoSizeBytes)
  }

  return res.status(200).json({
    ok: true,
    groupId: groupRef.id,
    roundId: roundIdOut,
    shareToken,
    shareUrl: `${WEBSITE_BASE}/review/${shareToken}`,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: add-round-to-group  (auth required — owner only)
 *
 *  POST /api/revisions?action=add-round-to-group
 *  Body: {
 *    idToken,
 *    groupId,
 *    driveFileId, driveFolderId, videoFileName,
 *    videoSizeBytes, videoMime,
 *    roundNumber? (default = highest existing + 1),
 *  }
 *  Returns: { ok, roundId }
 *
 *  Adds a new round to an existing project. The new round shares
 *  the group's share link, password and title — the editor only
 *  needs to upload a new video. If the editor doesn't supply a
 *  roundNumber we auto-pick the next sequential number; if they
 *  do, we let them (allows out-of-order numbering like 1, 2, 5).
 * ────────────────────────────────────────────────────────────── */
async function handleAddRoundToGroup(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    idToken?: string
    groupId?: string
    r2Key?: string
    driveFileId?: string
    driveFolderId?: string
    videoFileName?: string
    videoSizeBytes?: number
    videoMime?: string
    roundNumber?: number
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const groupId = String(body.groupId || '').trim()
  const r2Key = String(body.r2Key || '').trim()
  const driveFileId = String(body.driveFileId || '').trim()
  const driveFolderId = String(body.driveFolderId || '').trim() || null
  if (!groupId) return res.status(400).json({ ok: false, error: 'groupId required' })
  if (!r2Key && !driveFileId)
    return res.status(400).json({ ok: false, error: 'r2Key or driveFileId required' })

  const db = getDb()
  const groupRef = db.collection('revisionGroups').doc(groupId)
  const groupSnap = await groupRef.get()
  if (!groupSnap.exists) return res.status(404).json({ ok: false, error: 'הפרויקט לא נמצא' })
  const group = groupSnap.data() as RevisionGroupDoc
  if (group.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  // Compute the next round number unless the caller supplied one.
  // We let an explicit roundNumber win so the editor can leave gaps
  // for organisational reasons (e.g. start a "round 5" without
  // having sequential 2/3/4).
  let roundNumber = Math.floor(Number(body.roundNumber) || 0)
  if (!roundNumber || roundNumber < 1) {
    const existing = await db
      .collection('revisionProjects')
      .where('groupId', '==', groupId)
      .get()
    const max = existing.docs.reduce((m, d) => {
      const n = Number((d.data() as { roundNumber?: number }).roundNumber) || 0
      return n > m ? n : m
    }, 0)
    roundNumber = Math.min(99, max + 1)
  } else {
    roundNumber = Math.min(99, roundNumber)
  }

  const roundRef = db.collection('revisionProjects').doc()
  const now = Date.now()
  await roundRef.set({
    id: roundRef.id,
    groupId,
    ownerUid: verified.uid,
    ownerEmail: verified.email,
    r2Key: r2Key || null,
    driveFileId: driveFileId || null,
    driveFolderId: driveFolderId || group.driveFolderId || null,
    videoFileName: String(body.videoFileName || '').trim().slice(0, 300),
    videoSizeBytes: Number(body.videoSizeBytes) || 0,
    videoMime: String(body.videoMime || '').trim().slice(0, 100),
    videoStatus: 'ready',
    roundNumber,
    locked: false,
    notesCount: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  // Bump group's updatedAt + refresh the denormalised roundCount to
  // the true active-round count (also self-heals legacy groups that
  // predate the field). One small per-group read on an infrequent op.
  const sibSnap = await db
    .collection('revisionProjects')
    .where('groupId', '==', groupId)
    .get()
  const activeCount = sibSnap.docs.filter(
    (d) => (d.data() as { status?: string }).status === 'active',
  ).length
  await groupRef.update({ updatedAt: now, roundCount: activeCount })

  // Count R2 storage toward the user's quota (Drive videos don't).
  if (r2Key) {
    await adjustStorageUsage(verified.uid, Number(body.videoSizeBytes) || 0)
  }

  return res.status(200).json({ ok: true, roundId: roundRef.id })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: list-rounds-for-group  (PUBLIC — gated by share token)
 *
 *  POST /api/revisions?action=list-rounds-for-group
 *  Body: { shareToken, passwordToken? }
 *  Returns: { ok, group: { title, roundNumber? }, rounds: [...] }
 *
 *  Powers the round-picker screen on /review/<token> when the
 *  token resolves to a multi-round group. Returns rounds in
 *  ascending roundNumber order with the minimal metadata the
 *  picker needs (round id, number, locked, notesCount).
 * ────────────────────────────────────────────────────────────── */
async function handleListRoundsForGroup(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { shareToken?: string; passwordToken?: string }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })

  const groupSnap = await getDb()
    .collection('revisionGroups')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (groupSnap.empty) return res.status(404).json({ ok: false, error: 'הפרויקט לא נמצא' })
  const group = groupSnap.docs[0].data() as RevisionGroupDoc
  if (group.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'הפרויקט כבר לא פעיל' })
  }
  if (group.passwordHash) {
    const passwordToken = String(body.passwordToken || '').trim()
    if (!passwordToken || !verifyPasswordToken(passwordToken, group.id)) {
      return res.status(403).json({ ok: false, error: 'נדרשת סיסמה' })
    }
  }

  const roundsSnap = await getDb()
    .collection('revisionProjects')
    .where('groupId', '==', group.id)
    .get()
  const rounds = roundsSnap.docs
    .map((d) => d.data() as Record<string, unknown>)
    .filter((r) => r.status === 'active')
    .map((r) => ({
      id: r.id as string,
      roundNumber: Number(r.roundNumber) || 1,
      locked: r.locked === true,
      clientFinalized: !!r.clientFinalizedAt,
      clientFinalizedAt: Number(r.clientFinalizedAt) || 0,
      clientFinalizedBy: String(r.clientFinalizedBy || ''),
      notesCount: Number(r.notesCount) || 0,
      videoFileName: String(r.videoFileName || ''),
      createdAt: Number(r.createdAt) || 0,
      storage: (r.r2Key ? 'r2' : 'drive') as 'r2' | 'drive',
    }))
    .sort((a, b) => a.roundNumber - b.roundNumber)

  return res.status(200).json({
    ok: true,
    group: { id: group.id, title: group.title },
    rounds,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: list-rounds-owner  (auth required — owner only)
 *
 *  POST /api/revisions?action=list-rounds-owner
 *  Body: { idToken, groupId }
 *  Returns: { ok, rounds: [...] }
 *
 *  The owner-side counterpart to list-rounds-for-group (which is
 *  public + share-token-gated). This powers LAZY-LOAD: the project
 *  list (list-groups-owner / the live listener) returns groups only,
 *  and the editor calls this the moment a project is opened to pull
 *  just that one group's rounds. Reads scale with "rounds in the
 *  opened project", not "every round the user owns".
 * ────────────────────────────────────────────────────────────── */
async function handleListRoundsOwner(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string; groupId?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const groupId = String(body.groupId || '').trim()
  if (!groupId) return res.status(400).json({ ok: false, error: 'groupId' })

  const db = getDb()
  // Confirm the caller actually owns this group before handing back
  // its rounds — the share-token gate doesn't apply on the owner path.
  const groupSnap = await db.collection('revisionGroups').doc(groupId).get()
  if (!groupSnap.exists) {
    return res.status(404).json({ ok: false, error: 'הפרויקט לא נמצא' })
  }
  const group = groupSnap.data() as RevisionGroupDoc
  if (group.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  const roundsSnap = await db
    .collection('revisionProjects')
    .where('groupId', '==', groupId)
    .get()
  const rounds = roundsSnap.docs
    .map((d) => d.data() as Record<string, unknown>)
    .filter((r) => r.status === 'active')
    .map((r) => ({
      id: r.id as string,
      roundNumber: Number(r.roundNumber) || 1,
      videoFileName: String(r.videoFileName || ''),
      videoSizeBytes: Number(r.videoSizeBytes) || 0,
      locked: r.locked === true,
      clientFinalized: !!r.clientFinalizedAt,
      clientFinalizedAt: Number(r.clientFinalizedAt) || 0,
      clientFinalizedBy: String(r.clientFinalizedBy || ''),
      notesCount: Number(r.notesCount) || 0,
      createdAt: Number(r.createdAt) || 0,
      storage: (r.r2Key ? 'r2' : 'drive') as 'r2' | 'drive',
    }))
    .sort((a, b) => a.roundNumber - b.roundNumber)

  // Self-heal: if the denormalised count drifted from reality, fix it
  // so the (rounds-free) list shows the right number next time.
  if (Number(group.roundCount) !== rounds.length) {
    try {
      await db
        .collection('revisionGroups')
        .doc(groupId)
        .update({ roundCount: rounds.length })
    } catch {
      /* best-effort */
    }
  }

  return res.status(200).json({ ok: true, rounds })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: list-groups-owner  (auth required)
 *
 *  POST /api/revisions?action=list-groups-owner  { idToken }
 *  Returns: { ok, groups: [...with embedded rounds summary...] }
 *
 *  Used by the desktop project list — each group renders as one
 *  card and the rounds list expands inline. Returning rounds
 *  inline (rather than a second roundtrip per card) cuts the
 *  initial paint down to a single request.
 * ────────────────────────────────────────────────────────────── */
/* ──────────────────────────────────────────────────────────────
 *  Action: firebase-custom-token  (auth required)
 *
 *  Mints a short-lived Firebase custom auth token for the verified
 *  owner. The website authenticates via the HMAC session JWT and has
 *  NO password-based Firebase sign-in, but the live revisions
 *  listener (onSnapshot) needs a real Firebase Auth session so the
 *  Firestore read rules (request.auth.uid == resource.data.ownerUid)
 *  pass. The web client calls this once, signs in with
 *  signInWithCustomToken, then opens the listener.
 *
 *  Cost: ZERO Firestore reads — createCustomToken is purely an Auth
 *  operation, so the live model stays as cheap on the web as on the
 *  desktop. The session JWT remains the single source of truth; this
 *  just derives a Firebase session from it on demand.
 * ────────────────────────────────────────────────────────────── */
/** Record a WEBSITE "last seen" timestamp for the owner. The client
 *  calls this ONCE per visit (on login / entering revisions, guarded
 *  by sessionStorage) — NOT on every data request — so it's a true
 *  "last entered the site" marker, kept separate from the desktop's
 *  `lastSeenAt`. */
async function handleTouchWebSeen(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    await getDb()
      .collection('users')
      .doc(verified.uid)
      .update({ lastSeenWebAt: new Date().toISOString() })
  } catch {
    // Non-critical — never fail the caller over a presence ping.
  }
  return res.status(200).json({ ok: true })
}

async function handleFirebaseCustomToken(
  req: VercelRequest,
  res: VercelResponse,
) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const token = await getAuth(getFirebase()).createCustomToken(verified.uid)
    return res.status(200).json({ ok: true, token })
  } catch (err) {
    console.warn('[revisions] createCustomToken failed:', err)
    return res.status(500).json({ ok: false, error: 'token_mint_failed' })
  }
}

async function handleListGroupsOwner(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  // `.limit(500)` is a pure runaway guard — it does NOT change
  // behavior for any real user (nobody in beta has 500 projects),
  // it just caps the worst case so a data anomaly or the runaway
  // loop can't make this read an unbounded number of docs. Single
  // equality filter + limit needs only the automatic single-field
  // index — NO composite index, so it can't throw FAILED_PRECONDITION
  // and break the list. (We deliberately did NOT add a second
  // `.where('status','==','active')` filter — that WOULD require a
  // composite index. Status is still filtered in JS below.)
  const db = getDb()
  const groupsSnap = await db
    .collection('revisionGroups')
    .where('ownerUid', '==', verified.uid)
    .limit(500)
    .get()
  const activeGroups = groupsSnap.docs
    .map((d) => d.data() as RevisionGroupDoc)
    .filter((g) => g.status === 'active')

  // LAZY-LOAD: the project list no longer reads any round docs. Each
  // group carries a denormalised `roundCount`, kept in sync by
  // add-round / delete-round. The actual rounds are fetched only when
  // the user opens a project, via list-rounds-owner. This collapses
  // the per-tab-entry cost from "all groups + all rounds" down to
  // "groups only".
  //
  // Backfill: groups created before roundCount existed have no value.
  // We compute it once here (a small per-group read, only for those
  // groups) and persist it, so subsequent loads stay rounds-free.
  const needBackfill = activeGroups.filter(
    (g) => typeof g.roundCount !== 'number',
  )
  if (needBackfill.length) {
    await Promise.all(
      needBackfill.map(async (g) => {
        const sib = await db
          .collection('revisionProjects')
          .where('groupId', '==', g.id)
          .get()
        const cnt = sib.docs.filter(
          (d) => (d.data() as { status?: string }).status === 'active',
        ).length
        g.roundCount = cnt
        try {
          await db
            .collection('revisionGroups')
            .doc(g.id)
            .update({ roundCount: cnt })
        } catch {
          /* best-effort persist; the in-memory value is still returned */
        }
      }),
    )
  }

  const out = activeGroups
    .map((g) => ({
      id: g.id,
      title: g.title,
      shareToken: g.shareToken,
      hasPassword: Boolean(g.passwordHash),
      // Public-review-page toggles. Legacy groups that don't
      // have these fields fall back to the original ship
      // behavior (watermark on, download off, Drive link off)
      // so the desktop UI shows the right toggle states even
      // for projects created before the feature existed.
      watermark: g.watermark !== false,
      allowDownload: g.allowDownload === true,
      openInDrive: g.openInDrive === true,
      roundCount: Number(g.roundCount) || 0,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      // Rounds are loaded on demand (list-rounds-owner). Kept as an
      // empty array so existing clients that read `.rounds` don't
      // crash before they adopt the lazy fetch.
      rounds: [],
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  // Legacy single-round projects (no groupId) are no longer surfaced
  // in the live list — this user has none, and listing them would
  // require the very all-rounds scan we're removing.
  return res.status(200).json({ ok: true, groups: out, legacyProjects: [] })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: create-project
 *
 *  POST /api/revisions?action=create-project
 *  Body: {
 *    idToken,
 *    driveFileId,           // ID of the file already uploaded to Drive
 *    driveFolderId,         // ID of the parent "ניהול הורדות פלוס" folder
 *    title,
 *    videoFileName,
 *    videoSizeBytes,
 *    videoMime,
 *    password?              // plain — server hashes with PBKDF2
 *  }
 *  Returns: { ok, projectId, shareToken, shareUrl }
 *
 *  The upload itself happens in the Electron client (using a short
 *  access token from the access-token action) so the bytes never
 *  touch our server. This endpoint only registers the metadata in
 *  Firestore and mints the share token.
 * ────────────────────────────────────────────────────────────── */
async function handleCreateProject(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    driveFileId?: string
    driveFolderId?: string
    title?: string
    videoFileName?: string
    videoSizeBytes?: number
    videoMime?: string
    password?: string
    roundNumber?: number
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const driveFileId = String(body.driveFileId || '').trim()
  const driveFolderId = String(body.driveFolderId || '').trim()
  const title = String(body.title || '').trim().slice(0, 200)
  const videoFileName = String(body.videoFileName || '').trim().slice(0, 300)
  const videoSizeBytes = Number(body.videoSizeBytes) || 0
  const videoMime = String(body.videoMime || '').trim().slice(0, 100)
  const password = String(body.password || '')
  // Round number — clamp to a sensible range. NaN / missing / <1
  // all default to round 1, matching the client behaviour. The
  // upper cap of 99 keeps the badge two-digit; nobody actually
  // runs 100+ rounds of revisions in practice.
  const roundNumber = Math.max(
    1,
    Math.min(99, Math.floor(Number(body.roundNumber) || 1)),
  )

  if (!driveFileId) return res.status(400).json({ ok: false, error: 'driveFileId required' })
  if (!title) return res.status(400).json({ ok: false, error: 'title required' })

  // Hash the password if one was provided. PBKDF2-SHA256 with a
  // fresh random salt — same primitive the payments lock uses
  // server-side. Empty password = no password protection.
  let passwordHash: string | null = null
  let passwordSalt: string | null = null
  if (password) {
    if (password.length < 4) {
      return res.status(400).json({ ok: false, error: 'הסיסמה קצרה מדי (4 תווים מינימום)' })
    }
    passwordSalt = crypto.randomBytes(16).toString('hex')
    passwordHash = crypto
      .pbkdf2Sync(password, passwordSalt, 100_000, 32, 'sha256')
      .toString('hex')
  }

  // Share token — URL-safe random, 22 chars (132 bits of entropy)
  // is plenty for "unguessable per-project link".
  const shareToken = crypto.randomBytes(16).toString('base64url')

  const projectRef = getDb().collection('revisionProjects').doc()
  const now = Date.now()
  await projectRef.set({
    id: projectRef.id,
    ownerUid: verified.uid,
    ownerEmail: verified.email,
    driveFileId,
    driveFolderId,
    title,
    videoFileName,
    videoSizeBytes,
    videoMime,
    shareToken,
    passwordHash,
    passwordSalt,
    status: 'active',
    // videoStatus is a holdover from when we relied on Drive's embed
    // player, which only worked AFTER Drive finished transcoding
    // (1–60 min wait). The Cloudflare Worker proxy streams the raw
    // file via Range requests, which works the moment the upload
    // completes — no transcoding wait. So new projects start as
    // 'ready' directly, and the field is kept on the doc only for
    // backward compatibility with old data already in Firestore.
    videoStatus: 'ready',
    notesCount: 0,
    roundNumber,
    // locked=true blocks the public review page from accepting
    // new notes (add-note returns 423). The editor toggles this
    // from the project detail view when a round is "closed" —
    // useful when the editor wants the client's feedback freeze
    // before incorporating the changes into the next cut.
    locked: false,
    createdAt: now,
    updatedAt: now,
  })

  return res.status(200).json({
    ok: true,
    projectId: projectRef.id,
    shareToken,
    shareUrl: `${WEBSITE_BASE}/review/${shareToken}`,
  })
}

const WEBSITE_BASE = 'https://dmplus.net'

/* ──────────────────────────────────────────────────────────────
 *  Action: get-project  (PUBLIC — no auth)
 *
 *  POST /api/revisions?action=get-project  { shareToken, viewerEmail? }
 *
 *  Returns the project metadata needed to render the review page.
 *  Strips the DRIVE_FILE_ID and replaces with an embed URL so the
 *  raw fileId is never exposed to the client (defense-in-depth so
 *  someone digging into the network tab can't paste the fileId
 *  somewhere weird).
 *
 *  Password handling:
 *    - If the project has no password set → returns full data.
 *    - If it has a password but no `passwordToken` was provided →
 *      returns { ok: true, needsPassword: true, title } so the
 *      review page can render the password gate.
 *    - If `passwordToken` was provided AND matches → returns full data.
 *    - We don't return the password hash itself.
 *
 *  Email is OPTIONAL but recorded if provided (for analytics +
 *  watermark). The review page asks for email separately and stores
 *  it in cookie.
 * ────────────────────────────────────────────────────────────── */
async function handleGetProject(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  const passwordToken = String(body.passwordToken || '').trim() || null
  const roundIdHint = String(body.roundId || '').trim() || null

  const resolved = await resolveByShareToken(shareToken)
  if (!resolved) return res.status(404).json({ ok: false, error: 'הקישור לא נמצא' })

  // Owner-entitlement gate: if the editor's Pro subscription has
  // lapsed, the project's share link should NOT serve content.
  // We short-circuit with a special response shape that the
  // website renders as a friendly notice (instead of the
  // workspace) telling the viewer to contact the editor. Putting
  // the check here, BEFORE the password gate, means the viewer
  // sees the right message regardless of whether the password is
  // typed — they're not getting in either way, so the early notice
  // is clearer than "wrong password" loop after lapse.
  const ownerUid =
    resolved.kind === 'group'
      ? resolved.group.ownerUid
      : String((resolved.round as { ownerUid?: string }).ownerUid || '')
  const ownerEmail =
    resolved.kind === 'group'
      ? resolved.group.ownerEmail
      : String((resolved.round as { ownerEmail?: string }).ownerEmail || '')
  if (ownerUid) {
    // Fail-CLOSED for the owner-Pro check. If the check throws
    // (e.g. Firestore down) we treat as not-Pro and surface the
    // inactive notice rather than leaking access to a lapsed
    // project. Internal diagnostics go through console.log only
    // — we never expose owner-side details (uid, key id, reason)
    // to the public response since viewers shouldn't be able to
    // enumerate the editor's account state.
    let ownerActive: boolean
    try {
      ownerActive = await isUserPro(ownerUid, ownerEmail)
    } catch (err) {
      console.warn(
        '[revisions/get-project] owner-active check threw:',
        err,
      )
      ownerActive = false
    }
    if (!ownerActive) {
      return res.status(200).json({
        ok: true,
        ownerInactive: true,
        ownerEmail,
      })
    }
  }

  // ── New-style group ────────────────────────────────────────
  if (resolved.kind === 'group') {
    const group = resolved.group
    if (group.status !== 'active') {
      return res.status(410).json({ ok: false, error: 'הפרויקט כבר לא פעיל' })
    }
    // Password gate at the GROUP level (project-wide password).
    if (group.passwordHash) {
      if (!passwordToken || !verifyPasswordToken(passwordToken, group.id)) {
        return res.status(200).json({
          ok: true,
          needsPassword: true,
          title: group.title,
          kind: 'group',
        })
      }
    }
    // Fetch all rounds in this group (so the client can render the
    // picker without a second roundtrip).
    const roundsSnap = await getDb()
      .collection('revisionProjects')
      .where('groupId', '==', group.id)
      .get()
    const rounds = roundsSnap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((r) => r.status === 'active')
      .map((r) => ({
        id: String(r.id || ''),
        roundNumber: Number(r.roundNumber) || 1,
        locked: r.locked === true,
        notesCount: Number(r.notesCount) || 0,
        videoFileName: String(r.videoFileName || ''),
        createdAt: Number(r.createdAt) || 0,
        storage: (r.r2Key ? 'r2' : 'drive') as 'r2' | 'drive',
      }))
      .sort((a, b) => a.roundNumber - b.roundNumber)

    // Pick the round to drill into: explicit roundId from the
    // client (after they tapped the picker), OR if there's only
    // one round just auto-select it (skip the picker entirely for
    // the most common case).
    let selectedRound: (typeof rounds)[number] | null = null
    let selectedRoundData: Record<string, unknown> | null = null
    if (roundIdHint) {
      const match = rounds.find((r) => r.id === roundIdHint)
      if (match) {
        selectedRound = match
        const matchDoc = roundsSnap.docs.find((d) => d.id === roundIdHint)
        if (matchDoc) selectedRoundData = matchDoc.data() as Record<string, unknown>
      }
    } else if (rounds.length === 1) {
      selectedRound = rounds[0]
      selectedRoundData = roundsSnap.docs[0].data() as Record<string, unknown>
    }

    return res.status(200).json({
      ok: true,
      needsPassword: false,
      kind: 'group',
      group: {
        id: group.id,
        title: group.title,
        rounds,
      },
      // `project` is the SELECTED round (when known). Same shape
      // as the legacy single-round response so the client can
      // continue rendering the workspace with one code path.
      project: selectedRound && selectedRoundData
        ? {
            id: selectedRound.id,
            title: group.title,
            roundNumber: selectedRound.roundNumber,
            // Playback always uses streamUrl (get-stream-token → Worker).
            embedUrl: null,
            videoSizeBytes: Number(selectedRoundData.videoSizeBytes) || 0,
            videoMime: String(selectedRoundData.videoMime || ''),
            createdAt: selectedRound.createdAt,
            locked: selectedRound.locked,
            clientFinalizedBy: String(
              selectedRoundData.clientFinalizedBy || '',
            ),
            // Public-review-page toggles, inherited from the group
            // (legacy fallback = original ship behavior).
            watermark: group.watermark !== false,
            allowDownload: group.allowDownload === true,
            // "Open in Drive" link only for Drive-backed rounds whose
            // editor enabled the toggle. R2 rounds have no Drive URL.
            driveViewUrl:
              group.openInDrive === true && selectedRoundData.driveFileId
                ? `https://drive.google.com/file/d/${selectedRoundData.driveFileId}/view`
                : null,
          }
        : null,
    })
  }

  // ── Legacy single-round project ────────────────────────────
  const project = resolved.round as {
    id: string
    title: string
    driveFileId: string
    videoSizeBytes: number
    videoMime: string
    passwordHash: string | null
    passwordSalt: string | null
    status: string
    createdAt: number
    roundNumber?: number
    locked?: boolean
  }
  if (project.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'הסבב כבר לא פעיל' })
  }
  const roundNumber =
    typeof project.roundNumber === 'number' && project.roundNumber > 0
      ? project.roundNumber
      : 1
  const locked = project.locked === true
  if (project.passwordHash) {
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      return res.status(200).json({
        ok: true,
        needsPassword: true,
        title: project.title,
        roundNumber,
        locked,
        kind: 'single',
      })
    }
  }
  return res.status(200).json({
    ok: true,
    needsPassword: false,
    kind: 'single',
    project: {
      id: project.id,
      title: project.title,
      roundNumber,
      embedUrl: null,
      videoSizeBytes: project.videoSizeBytes,
      videoMime: project.videoMime,
      createdAt: project.createdAt,
      // Legacy single-round projects pre-date the per-project
      // settings — they always get the original ship defaults
      // (watermark on, download off, no Drive link).
      watermark: true,
      allowDownload: false,
      driveViewUrl: null,
      locked,
      clientFinalizedBy: String(
        (project as { clientFinalizedBy?: string }).clientFinalizedBy || '',
      ),
    },
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: verify-password
 *
 *  POST /api/revisions?action=verify-password  { shareToken, password }
 *  Returns { ok, passwordToken }
 *
 *  Verifies the password against the stored PBKDF2 hash. On
 *  success, mints a short-lived JWT (`passwordToken`) that the
 *  client stores in sessionStorage and presents on subsequent
 *  get-project calls so it doesn't have to re-enter the password
 *  on every reload.
 * ────────────────────────────────────────────────────────────── */
async function handleVerifyPassword(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { shareToken?: string; password?: string }
  const shareToken = String(body.shareToken || '').trim()
  const password = String(body.password || '')
  if (!shareToken || !password) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }
  const resolved = await resolveByShareToken(shareToken)
  if (!resolved) return res.status(404).json({ ok: false, error: 'לא נמצא' })

  // Pull the password hash/salt + the id we'll mint the token
  // against. For new-style groups the password is project-wide
  // (lives on the group); for legacy rounds it's per-round.
  const { passwordHash, passwordSalt, projectId } =
    resolved.kind === 'group'
      ? {
          passwordHash: resolved.group.passwordHash,
          passwordSalt: resolved.group.passwordSalt,
          projectId: resolved.group.id,
        }
      : {
          passwordHash: (resolved.round.passwordHash as string | null) ?? null,
          passwordSalt: (resolved.round.passwordSalt as string | null) ?? null,
          projectId: String(resolved.round.id || ''),
        }
  if (!passwordHash || !passwordSalt) {
    return res.status(400).json({ ok: false, error: 'לפרויקט הזה אין סיסמה' })
  }
  const computed = crypto
    .pbkdf2Sync(password, passwordSalt, 100_000, 32, 'sha256')
    .toString('hex')
  if (computed !== passwordHash) {
    return res.status(401).json({ ok: false, error: 'סיסמה שגויה' })
  }
  return res.status(200).json({
    ok: true,
    passwordToken: mintPasswordToken(projectId),
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: add-note  (PUBLIC — no auth, gated by share token)
 *
 *  POST /api/revisions?action=add-note
 *  Body: { shareToken, viewerEmail, viewerName?, timeSeconds, text,
 *          screenshotDataUrl?, annotations? }
 *
 *  Anyone with the share link can add notes. The viewerEmail is
 *  required because it's used for the watermark + so the editor
 *  knows who left the note. If a password is set the client must
 *  have a valid passwordToken (we verify by checking the project
 *  has the same shareToken — same authorization model as the
 *  get-project endpoint).
 * ────────────────────────────────────────────────────────────── */
/* ── Email (Gmail SMTP) — counted so the dashboard's 24h gauge stays
 *  accurate. Mirrors the helper in api/paypal.ts. Only used by the
 *  "round finished" notification below. ─────────────────────────── */
function recordEmailSent(): void {
  try {
    const bucket = new Date().toISOString().slice(0, 13) // YYYY-MM-DDTHH
    void getDb()
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

/** Email the editor that a client finished a review round. Best-effort:
 *  a mail failure must never block the round from being finalized. */
async function sendRoundReadyEmail(args: {
  to: string
  projectTitle: string
  roundNumber: number
  viewerEmail?: string
}): Promise<void> {
  const user = process.env.GMAIL_USER
  const pass = process.env.GMAIL_APP_PASSWORD
  if (!user || !pass || !args.to) return
  const transporter = makeCountedTransport({
    service: 'gmail',
    auth: { user, pass },
  })
  const safeTitle = args.projectTitle || 'פרויקט'
  const markedBy = args.viewerEmail
    ? `<p style="font-size:13px;line-height:1.7;margin:0 0 18px;color:#9A8F78;">סומן כמוכן על ידי: <strong dir="ltr">${args.viewerEmail}</strong></p>`
    : ''
  await transporter.sendMail({
    from: `"ניהול הורדות פלוס" <${user}>`,
    to: args.to,
    subject: `הסבב מוכן לתיקונים — ${safeTitle} (סבב ${args.roundNumber})`,
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;background:#1A140C;color:#E8DFC8;padding:24px;border-radius:12px;max-width:480px;margin:auto;">
        <h2 style="margin:0 0 12px;color:#E8DFC8;">הסבב הזה מוכן לתיקונים ✅</h2>
        <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
          סבב <strong>${args.roundNumber}</strong> של הפרויקט <strong>${safeTitle}</strong>
          מוכן לתיקונים — סומן שסיימו לרשום את כל מה שצריך לתקן בו.
        </p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#C9BFA8;">
          הסבב ננעל ולא ייכנסו אליו עוד תיקונים חדשים. אפשר להתחיל לעבוד עליו.
        </p>
        ${markedBy}
        <a href="https://dmplus.net/revisions" style="display:inline-block;background:#B8794F;color:#1A140C;text-decoration:none;font-weight:bold;padding:10px 20px;border-radius:8px;font-size:14px;">מעבר לדף התיקונים</a>
        <p style="font-size:11px;margin:18px 0 0;color:#5C5444;">ניהול הורדות פלוס — מערכת סבבי תיקונים.</p>
      </div>
    `,
  })
}

/* ── Action: finalize-round (PUBLIC — gated by share token + password)
 *  The reviewer presses "סיימתי, אין עוד תיקונים" → we lock the round
 *  (so add-note rejects from now on) and email the editor that it's
 *  ready to fix. Idempotent: a second press just returns ok. ─────── */
async function handleFinalizeRound(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
    viewerEmail?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundRef, roundData, group } = resolved
  // Already finalized by a client → idempotent success, don't re-email.
  if (roundData.clientFinalizedAt) {
    return res.status(200).json({ ok: true, alreadyFinalized: true })
  }
  const viewerEmail = String(body.viewerEmail || '').trim()
  await roundRef.update({
    locked: true,
    clientFinalizedAt: Date.now(),
    clientFinalizedBy: viewerEmail || null,
    updatedAt: Date.now(),
  })
  const ownerEmail = String(group?.ownerEmail || roundData.ownerEmail || '')
  const projectTitle = String(group?.title || roundData.title || '')
  const roundNumber = Number(roundData.roundNumber) || 1
  try {
    await sendRoundReadyEmail({
      to: ownerEmail,
      projectTitle,
      roundNumber,
      viewerEmail: viewerEmail || undefined,
    })
  } catch (e) {
    console.warn('[finalize-round] editor email failed:', e)
  }
  return res.status(200).json({ ok: true })
}

async function handleAddNote(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    /** Required when shareToken matches a new-style project group
     *  (since the group has multiple rounds). Ignored for legacy
     *  single-round projects — the share token already identifies
     *  the round uniquely there. */
    roundId?: string
    viewerEmail?: string
    viewerName?: string
    timeSeconds?: number
    text?: string
    /** Legacy: base64 data URL stored on the note doc. New notes
     *  should send screenshotDriveFileId instead — the bytes live
     *  in the editor's Drive and the note stores only a pointer. */
    screenshotDataUrl?: string
    /** Drive file ID of the uploaded screenshot. Set by the client
     *  after calling action=upload-note-media. */
    screenshotDriveFileId?: string
    /** Drive file ID of the uploaded voice recording. Same flow as
     *  screenshotDriveFileId — upload first, then submit the note. */
    audioDriveFileId?: string
    /** R2 keys — the equivalent of the Drive ids for R2-backed rounds.
     *  upload-note-media returns one of these; the client forwards it. */
    screenshotR2Key?: string
    audioR2Key?: string
    annotations?: unknown[]
  }
  const shareToken = String(body.shareToken || '').trim()
  const viewerEmail = String(body.viewerEmail || '').trim().toLowerCase()
  const text = String(body.text || '').trim()
  // timeSeconds is OPTIONAL now — a missing/null/negative value
  // means the note is "general" (not tied to a specific moment in
  // the video). General notes get a dedicated badge instead of a
  // clickable timestamp on both the editor + reviewer side. Stored
  // as null on the doc rather than 0 so we can distinguish "comment
  // about the very first frame" from "no timestamp".
  //
  // Important: we check the TYPE before coercing. Number(null) is 0,
  // which would have turned every general note into a "second-zero"
  // note — exactly the bug this comment now prevents from coming
  // back.
  const timeSeconds: number | null =
    typeof body.timeSeconds === 'number' &&
    Number.isFinite(body.timeSeconds) &&
    body.timeSeconds >= 0
      ? body.timeSeconds
      : null
  const screenshotDriveFileId = String(body.screenshotDriveFileId || '').trim() || null
  const audioDriveFileId = String(body.audioDriveFileId || '').trim() || null
  const screenshotR2Key = String(body.screenshotR2Key || '').trim() || null
  const audioR2Key = String(body.audioR2Key || '').trim() || null
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })
  if (!viewerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(viewerEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל לא תקין' })
  }
  if (
    !text &&
    !body.screenshotDataUrl &&
    !screenshotDriveFileId &&
    !audioDriveFileId &&
    !screenshotR2Key &&
    !audioR2Key
  ) {
    return res
      .status(400)
      .json({ ok: false, error: 'חובה לכתוב תיאור, לצרף תמונה או להקליט' })
  }

  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundRef, roundData } = resolved
  // Locked rounds: existing notes stay readable but no new ones
  // accepted. 423 Locked is the right HTTP semantic; the client
  // surfaces the friendly Hebrew message.
  if (roundData.locked === true) {
    return res.status(423).json({
      ok: false,
      error: 'הסבב נסגר לתיקונים. תוכלו לראות את הסרטון ואת התיקונים הקודמים אבל אי אפשר להוסיף חדשים.',
    })
  }

  // Screenshot size sanity check — Firestore's 1 MB doc cap means
  // we can't store huge base64 blobs. Cap at ~500 KB encoded which
  // is plenty for a JPEG frame at moderate quality.
  let screenshotDataUrl = String(body.screenshotDataUrl || '')
  if (screenshotDataUrl && screenshotDataUrl.length > 700_000) {
    return res.status(400).json({ ok: false, error: 'צילום הפריים גדול מדי' })
  }
  // Annotations — defensive cap. Each note shouldn't have hundreds.
  const annotations = Array.isArray(body.annotations)
    ? body.annotations.slice(0, 50)
    : []

  const noteRef = roundRef.collection('notes').doc()
  const now = Date.now()
  await noteRef.set({
    id: noteRef.id,
    viewerEmail,
    viewerName: String(body.viewerName || '').trim().slice(0, 80) || null,
    timeSeconds,
    text: text.slice(0, 2000),
    // Legacy base64 path stays supported so existing data still
    // renders. New uploads always go through the Drive route below
    // (screenshotDriveFileId + audioDriveFileId).
    screenshotDataUrl: screenshotDataUrl || null,
    screenshotDriveFileId,
    audioDriveFileId,
    // R2 equivalents (R2-backed rounds). A note carries either the
    // Drive ids or the R2 keys, never both.
    screenshotR2Key,
    audioR2Key,
    annotations,
    status: 'new',
    createdAt: now,
  })
  // Counter for the editor's dashboard. Best-effort — don't fail
  // the note add if the counter increment glitches.
  void roundRef
    .update({
      notesCount: ((roundData.notesCount as number | undefined) || 0) + 1,
      updatedAt: now,
    })
    .catch(() => undefined)

  return res.status(200).json({ ok: true, noteId: noteRef.id })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: upload-note-media  (PUBLIC — gated by share + password)
 *
 *  POST /api/revisions?action=upload-note-media
 *  Body: { shareToken, passwordToken?, kind: 'image'|'audio',
 *          mimeType, dataBase64 }
 *  Returns: { ok, driveFileId, mimeType }
 *
 *  Why this exists: the previous flow base64-encoded screenshots
 *  into the note doc itself, which capped at ~700 KB because of
 *  Firestore's 1 MB doc limit. That worked for stills but rules
 *  out voice notes (90 s of Opus alone is ~270 KB, comfortable
 *  inside the cap on its own but not alongside a screenshot, and
 *  the user wants ALL media in Drive as a matter of principle —
 *  one storage source).
 *
 *  Flow:
 *    1. Browser uploads the blob (base64) here.
 *    2. We auth the viewer (shareToken + optional passwordToken).
 *    3. We use the project owner's stored refresh token to mint
 *       a Drive access token.
 *    4. Multipart upload to Drive into the project's parent folder.
 *    5. Return the driveFileId. Client then sends add-note with
 *       screenshotDriveFileId / audioDriveFileId pointing at it.
 *
 *  Permissions: the uploaded file stays private to the editor's
 *  Drive — we don't flip "anyone with link" because the only path
 *  back to it is action=note-media below, which re-auths every
 *  request server-side. Smaller attack surface than public links.
 *
 *  Size caps:
 *    image: 5 MB encoded (~3.5 MB raw). Plenty for a 1080p JPEG.
 *    audio: 5 MB encoded (~3.5 MB raw). 90 s of 256 kbps Opus is
 *           ~3 MB, so this caps the recording UI without us having
 *           to expose the math.
 *  These caps also keep us under Vercel Hobby's ~4.5 MB body cap.
 * ────────────────────────────────────────────────────────────── */
const NOTE_MEDIA_MAX_BASE64 = 5 * 1024 * 1024 // 5 MB encoded
// Raw-byte cap for the direct-to-R2 path (note-media-upload-url). The
// browser uploads the blob straight to R2, so there's no Vercel body
// limit to worry about — this is just a sane abuse ceiling. 8 MB covers
// a high-res screenshot or a couple minutes of Opus comfortably.
const NOTE_MEDIA_MAX_BYTES = 8 * 1024 * 1024 // 8 MB raw

/** Find-or-create the "קבצי תיקונים" subfolder inside the project's
 *  root Drive folder. Mirrors the desktop's ensureFolder helper but
 *  lives here because the server is the one writing notes media —
 *  the desktop never touches that subfolder. */
const NOTES_SUBFOLDER_NAME = 'קבצי תיקונים'
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

async function ensureNotesSubfolder(
  accessToken: string,
  rootFolderId: string,
): Promise<string> {
  const escaped = NOTES_SUBFOLDER_NAME.replace(/'/g, "\\'")
  const q = `name='${escaped}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and '${rootFolderId}' in parents`
  const searchUrl = new URL('https://www.googleapis.com/drive/v3/files')
  searchUrl.searchParams.set('q', q)
  searchUrl.searchParams.set('fields', 'files(id)')
  searchUrl.searchParams.set('pageSize', '1')

  const searchResp = await fetch(searchUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!searchResp.ok) throw new Error(`drive search ${searchResp.status}`)
  const searchJson = (await searchResp.json()) as {
    files?: Array<{ id: string }>
  }
  if (searchJson.files && searchJson.files.length > 0) {
    return searchJson.files[0].id
  }

  const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: NOTES_SUBFOLDER_NAME,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [rootFolderId],
    }),
  })
  if (!createResp.ok) throw new Error(`drive create ${createResp.status}`)
  const folder = (await createResp.json()) as { id: string }
  return folder.id
}

async function handleUploadNoteMedia(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
    kind?: 'image' | 'audio'
    mimeType?: string
    dataBase64?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  const kind = body.kind
  const rawMime = String(body.mimeType || '').trim()
  const dataBase64 = String(body.dataBase64 || '')
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })
  if (kind !== 'image' && kind !== 'audio') {
    return res.status(400).json({ ok: false, error: 'kind חייב להיות image או audio' })
  }
  // MediaRecorder in Chrome reports mimeTypes like
  // `audio/webm;codecs=opus` — the codecs parameter is a hint to
  // decoders, irrelevant for storage. Strip everything after the
  // first `;` and validate just the base type. Without this strip
  // the regex below would 400 every voice note from Chromium.
  const mimeType = rawMime.split(';')[0].trim()
  if (!mimeType || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(mimeType)) {
    return res.status(400).json({ ok: false, error: 'mimeType לא תקין' })
  }
  if (!dataBase64) {
    return res.status(400).json({ ok: false, error: 'dataBase64 חסר' })
  }
  if (dataBase64.length > NOTE_MEDIA_MAX_BASE64) {
    return res.status(413).json({
      ok: false,
      error: kind === 'image' ? 'התמונה גדולה מדי' : 'ההקלטה ארוכה מדי',
    })
  }

  // Resolve project + auth (group or legacy round).
  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundRef, roundData, group } = resolved
  if (roundData.locked === true) {
    return res.status(423).json({
      ok: false,
      error: 'הסבב סגור לתיקונים. אי אפשר להעלות מדיה חדשה.',
    })
  }

  // R2-backed round → store the attachment in our R2 bucket (under the
  // owner's folder), exactly like the video. Returns an r2Key the
  // client then attaches to the note via add-note. No Drive involved.
  if (roundData.r2Key) {
    const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')
    const bytes = Buffer.from(dataBase64, 'base64')
    const ext =
      kind === 'image'
        ? mimeType.includes('png')
          ? 'png'
          : 'jpg'
        : mimeType.includes('mp4')
          ? 'm4a'
          : 'webm'
    const key = buildNoteMediaKey(ownerUid, ext)
    try {
      await getR2().send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
        }),
      )
    } catch (e) {
      console.error('[upload-note-media] R2 put failed:', e)
      return res
        .status(502)
        .json({ ok: false, error: 'העלאת המדיה לאחסון נכשלה' })
    }
    return res.status(200).json({ ok: true, r2Key: key, mimeType })
  }

  // Owner uid + drive folder come from either the group (preferred
  // when available) or the round (legacy). For new-style groups,
  // notesFolderId is cached on the GROUP doc since it's shared
  // across all rounds in the project.
  const ownerUid = String(
    group?.ownerUid || roundData.ownerUid || '',
  )
  const driveFolderId = String(
    group?.driveFolderId || roundData.driveFolderId || '',
  )

  // Drive access — refresh token belongs to the project owner.
  const integrationSnap = await integrationDocRef(ownerUid).get()
  if (!integrationSnap.exists) {
    return res.status(500).json({ ok: false, error: 'Drive לא מחובר' })
  }
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  let accessToken: string
  try {
    const r = await refreshAccessToken(refreshToken)
    accessToken = r.accessToken
  } catch {
    return res.status(401).json({ ok: false, error: 'Drive auth פג תוקף' })
  }

  // Resolve (or lazily create) the "קבצי תיקונים" subfolder where
  // all reviewer-uploaded attachments live. Cached on the group
  // doc (new) or round doc (legacy) after the first call so
  // subsequent uploads skip the round-trip.
  const cachedNotesFolderId: string | null = group
    ? group.notesFolderId
    : (roundData.notesFolderId as string | undefined) || null
  let notesFolderId: string | undefined = cachedNotesFolderId || undefined
  if (!notesFolderId && driveFolderId) {
    try {
      notesFolderId = await ensureNotesSubfolder(
        accessToken,
        driveFolderId,
      )
      // Persist for next time — fire-and-forget. Cache on the
      // GROUP for new-style projects (shared by all rounds) or
      // on the round itself for legacy.
      const cacheRef = group
        ? getDb().collection('revisionGroups').doc(group.id)
        : roundRef
      void cacheRef
        .update({ notesFolderId, updatedAt: Date.now() })
        .catch(() => undefined)
    } catch (err) {
      console.warn(
        '[revisions/upload-note-media] ensureNotesSubfolder failed:',
        err,
      )
      // Fall back to the root project folder — upload still works,
      // it just lands one level shallower than the user wanted.
    }
  }
  const targetFolderId = notesFolderId || driveFolderId

  // Multipart upload to Drive — metadata + bytes in one request.
  const ext =
    kind === 'image'
      ? mimeType.includes('png')
        ? 'png'
        : 'jpg'
      : mimeType.includes('mp4')
        ? 'm4a'
        : 'webm'
  const fileName = `note-${shareToken}-${Date.now()}-${crypto
    .randomBytes(3)
    .toString('hex')}.${ext}`
  const bytes = Buffer.from(dataBase64, 'base64')
  const boundary = `dmp-${crypto.randomBytes(8).toString('hex')}`
  const metadata = {
    name: fileName,
    parents: targetFolderId ? [targetFolderId] : undefined,
    mimeType,
    // Tag the file so delete-round (and any future per-round
    // cleanup) can find it later via files.list?q=...appProperties
    // has {key='dmpRoundId' and value='<id>'}. appProperties are
    // private to our OAuth app — invisible to the user in the
    // Drive UI, and only readable when authenticated with the same
    // client_id that wrote them. We tag both round + group ids so
    // we can also purge by group if needed (delete-group currently
    // trashes the entire shared notes folder so it doesn't query
    // these, but it's cheap to record).
    appProperties: {
      dmpRoundId: String(roundRef.id),
      dmpGroupId: group ? String(group.id) : '',
    },
  }
  const multipart = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ])

  const uploadResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipart,
    },
  )
  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => '')
    console.error(
      '[revisions/upload-note-media] Drive upload failed:',
      uploadResp.status,
      errText.slice(0, 200),
    )
    return res
      .status(502)
      .json({ ok: false, error: 'העלאה ל-Drive נכשלה' })
  }
  const uploadJson = (await uploadResp.json()) as { id?: string }
  if (!uploadJson.id) {
    return res.status(502).json({ ok: false, error: 'Drive החזיר תשובה לא תקינה' })
  }

  return res.status(200).json({
    ok: true,
    driveFileId: uploadJson.id,
    mimeType,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: note-media-upload-url  (PUBLIC — gated by share + password)
 *
 *  POST /api/revisions?action=note-media-upload-url
 *  Body: { shareToken, passwordToken?, roundId?, kind, contentType, sizeBytes }
 *  Returns: { ok, url, key }
 *
 *  The browser then PUTs the screenshot / voice-note blob STRAIGHT to
 *  R2 via `url` — zero bytes through Vercel, exactly like the video
 *  multipart parts. Note media now ALWAYS lands in R2 (even for
 *  Drive-backed rounds): it's tiny, and it's the only way a public
 *  reviewer — who has no Drive credentials — can upload without us
 *  proxying the bytes. The returned `key` is attached to the note via
 *  add-note (screenshotR2Key / audioR2Key), and note-media-url already
 *  serves R2 keys with a presigned GET, so playback stays Vercel-free.
 * ────────────────────────────────────────────────────────────── */
async function handleNoteMediaUploadUrl(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
    kind?: 'image' | 'audio'
    contentType?: string
    sizeBytes?: number
  }
  const shareToken = String(body.shareToken || '').trim()
  const kind = body.kind
  const sizeBytes = Math.floor(Number(body.sizeBytes) || 0)
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })
  if (kind !== 'image' && kind !== 'audio') {
    return res
      .status(400)
      .json({ ok: false, error: 'kind חייב להיות image או audio' })
  }
  if (sizeBytes <= 0) {
    return res.status(400).json({ ok: false, error: 'sizeBytes חסר' })
  }
  if (sizeBytes > NOTE_MEDIA_MAX_BYTES) {
    return res.status(413).json({
      ok: false,
      error: kind === 'image' ? 'התמונה גדולה מדי' : 'ההקלטה ארוכה מדי',
    })
  }

  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundData, group } = resolved
  if (roundData.locked === true) {
    return res.status(423).json({
      ok: false,
      error: 'הסבב סגור לתיקונים. אי אפשר להעלות מדיה חדשה.',
    })
  }

  const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')
  const ct = String(body.contentType || '').split(';')[0].trim().toLowerCase()
  const ext =
    kind === 'image'
      ? ct.includes('png')
        ? 'png'
        : 'jpg'
      : ct.includes('mp4') || ct.includes('mpeg') || ct.includes('m4a')
        ? 'm4a'
        : 'webm'
  const key = buildNoteMediaKey(ownerUid, ext)
  try {
    const url = await r2PresignPut(key)
    return res.status(200).json({ ok: true, url, key })
  } catch (e) {
    console.error('[note-media-upload-url] presign failed:', e)
    return res.status(500).json({ ok: false, error: 'presign failed' })
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Action: note-media  (PUBLIC — gated by share + password)
 *
 *  GET /api/revisions?action=note-media&token=<share>&note=<noteId>
 *                                      &kind=image|audio&t=<pwd?>
 *
 *  Streams a single note's media file from the editor's Drive.
 *  Same auth model as list-notes (share token + optional password
 *  token). We look up the note doc, read screenshotDriveFileId /
 *  audioDriveFileId, then proxy Drive's response.
 *
 *  Why Vercel proxy (not the Cloudflare Worker that serves video):
 *  note media is small (sub-MB) and accessed sporadically. Burning
 *  a Worker handshake per asset would be measurable latency for no
 *  bandwidth win. Vercel Hobby has 100 GB egress/mo — at ~500 KB
 *  per note image and ~300 KB per voice clip, that's headroom for
 *  hundreds of thousands of views.
 * ────────────────────────────────────────────────────────────── */
async function handleNoteMedia(req: VercelRequest, res: VercelResponse) {
  const shareToken = String(req.query.token || '').trim()
  const noteId = String(req.query.note || '').trim()
  const kind = String(req.query.kind || '').trim() as 'image' | 'audio'
  const passwordToken = String(req.query.t || '').trim()
  // Note: roundId in the URL is `r` (kept short because this is a
  // GET URL that ends up in <img src> + <audio src> and stays
  // visible in dev-tools / referer headers).
  const roundIdHint = String(req.query.r || '').trim() || null
  if (!shareToken || !noteId) {
    return res.status(400).end('token + note required')
  }
  if (kind !== 'image' && kind !== 'audio') {
    return res.status(400).end('kind must be image or audio')
  }

  const resolved = await resolvePublicRound(
    shareToken,
    roundIdHint,
    passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).end(resolved.error)
  }
  const { roundRef, roundData, group } = resolved
  const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')

  const noteSnap = await roundRef.collection('notes').doc(noteId).get()
  if (!noteSnap.exists) return res.status(404).end('note not found')
  const note = noteSnap.data() as {
    screenshotDriveFileId?: string | null
    audioDriveFileId?: string | null
    screenshotR2Key?: string | null
    audioR2Key?: string | null
  }

  // ── R2-backed note media — stream straight from our bucket ──
  // Small files (screenshots/voice notes), so we pull the whole
  // object server-side and pipe it back. No Range, no CORS concerns
  // (the bytes flow R2 → Vercel → browser, same-origin to the client).
  const r2Key = kind === 'image' ? note.screenshotR2Key : note.audioR2Key
  if (r2Key) {
    try {
      const r2 = getR2()
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
      )
      const contentType = obj.ContentType || 'application/octet-stream'
      res.setHeader('Content-Type', contentType)
      if (typeof obj.ContentLength === 'number') {
        res.setHeader('Content-Length', String(obj.ContentLength))
      }
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Disposition', 'inline')
      const bytes = await obj.Body?.transformToByteArray()
      if (!bytes) return res.status(404).end('media not attached')
      return res.status(200).send(Buffer.from(bytes))
    } catch (err) {
      console.warn('[revisions/note-media] R2 fetch failed:', err)
      return res.status(404).end('media not attached')
    }
  }

  const driveFileId =
    kind === 'image' ? note.screenshotDriveFileId : note.audioDriveFileId
  if (!driveFileId) return res.status(404).end('media not attached')

  // Mint a Drive access token via the owner's refresh token.
  const integrationSnap = await integrationDocRef(ownerUid).get()
  if (!integrationSnap.exists) return res.status(500).end('drive not connected')
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  let accessToken: string
  try {
    const r = await refreshAccessToken(refreshToken)
    accessToken = r.accessToken
  } catch {
    return res.status(401).end('drive auth expired')
  }

  // Pull the bytes from Drive and stream them back. Note media is
  // small enough that we don't bother with Range support — the
  // browser fetches the whole thing once and caches it.
  const driveResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!driveResp.ok) {
    return res.status(driveResp.status).end('drive fetch failed')
  }
  const contentType = driveResp.headers.get('content-type') || 'application/octet-stream'
  const contentLength = driveResp.headers.get('content-length')
  res.setHeader('Content-Type', contentType)
  if (contentLength) res.setHeader('Content-Length', contentLength)
  // 1-hour browser cache — note media is immutable once uploaded
  // (delete-note tears it down rather than overwrites), so caching
  // is safe and cuts repeat-view roundtrips.
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.setHeader('Content-Disposition', 'inline')
  const buf = Buffer.from(await driveResp.arrayBuffer())
  return res.status(200).send(buf)
}

/* ──────────────────────────────────────────────────────────────
 *  Action: note-media-owner  (auth required — owner only)
 *
 *  POST /api/revisions?action=note-media-owner
 *  Body: { idToken, projectId, noteId, kind: 'image'|'audio' }
 *  Returns: raw binary (image/audio bytes), with the Drive file's
 *  Content-Type passed through verbatim.
 *
 *  Why a separate endpoint instead of extending note-media to
 *  accept idToken? Owner auth needs idToken which we don't want
 *  in a GET URL (logged in access logs, leaks via Referer, shows
 *  up if the user copies an image URL). POST keeps the token in
 *  the request body. The desktop renderer fetches with this then
 *  builds an object-URL blob to assign to <img src>, so the
 *  rendered URL never contains anything sensitive.
 * ────────────────────────────────────────────────────────────── */
async function handleNoteMediaOwner(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    idToken?: string
    projectId?: string
    noteId?: string
    kind?: 'image' | 'audio'
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).end('unauthorized')
  const projectId = String(body.projectId || '').trim()
  const noteId = String(body.noteId || '').trim()
  const kind = body.kind
  if (!projectId || !noteId) return res.status(400).end('projectId + noteId required')
  if (kind !== 'image' && kind !== 'audio') return res.status(400).end('bad kind')

  const projectRef = getDb().collection('revisionProjects').doc(projectId)
  const projectSnap = await projectRef.get()
  if (!projectSnap.exists) return res.status(404).end('project not found')
  const project = projectSnap.data() as { ownerUid: string }
  if (project.ownerUid !== verified.uid) return res.status(403).end('forbidden')

  const noteSnap = await projectRef.collection('notes').doc(noteId).get()
  if (!noteSnap.exists) return res.status(404).end('note not found')
  const note = noteSnap.data() as {
    screenshotDriveFileId?: string | null
    audioDriveFileId?: string | null
    screenshotR2Key?: string | null
    audioR2Key?: string | null
  }

  // R2-backed note media — stream straight from our bucket. Same as
  // the public note-media endpoint; works for the desktop owner view
  // without any bucket-CORS dependency (bytes flow R2 → Vercel → app).
  const r2Key = kind === 'image' ? note.screenshotR2Key : note.audioR2Key
  if (r2Key) {
    try {
      const r2 = getR2()
      const obj = await r2.send(
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
      )
      res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream')
      if (typeof obj.ContentLength === 'number') {
        res.setHeader('Content-Length', String(obj.ContentLength))
      }
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Disposition', 'inline')
      const bytes = await obj.Body?.transformToByteArray()
      if (!bytes) return res.status(404).end('media not attached')
      return res.status(200).send(Buffer.from(bytes))
    } catch (err) {
      console.warn('[revisions/note-media-owner] R2 fetch failed:', err)
      return res.status(404).end('media not attached')
    }
  }

  const driveFileId =
    kind === 'image' ? note.screenshotDriveFileId : note.audioDriveFileId
  if (!driveFileId) return res.status(404).end('media not attached')

  const integrationSnap = await integrationDocRef(project.ownerUid).get()
  if (!integrationSnap.exists) return res.status(500).end('drive not connected')
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  let accessToken: string
  try {
    const r = await refreshAccessToken(refreshToken)
    accessToken = r.accessToken
  } catch {
    return res.status(401).end('drive auth expired')
  }

  const driveResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!driveResp.ok) return res.status(driveResp.status).end('drive fetch failed')
  const contentType = driveResp.headers.get('content-type') || 'application/octet-stream'
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  const buf = Buffer.from(await driveResp.arrayBuffer())
  return res.status(200).send(buf)
}

/* ──────────────────────────────────────────────────────────────
 *  Action: list-notes  (PUBLIC — no auth, gated by share token)
 *
 *  POST /api/revisions?action=list-notes  { shareToken, passwordToken? }
 *  Returns { ok, notes: [...] }
 *
 *  Used by both the public review page (so the same person who
 *  left notes earlier can see what they wrote) AND eventually by
 *  the editor's project list in the desktop app. For now the
 *  editor reads notes via Firestore real-time listener directly
 *  (skipping this endpoint).
 * ────────────────────────────────────────────────────────────── */
async function handleListNotes(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })

  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const notesSnap = await resolved.roundRef
    .collection('notes')
    .limit(500)
    .get()
  const notes = notesSnap.docs.map((d) => d.data())
  return res.status(200).json({ ok: true, notes })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: stream-video  (PUBLIC — gated by share token + password)
 *
 *  GET /api/revisions?action=stream-video&token=<shareToken>&t=<pwdToken?>
 *
 *  HISTORY OF THIS ENDPOINT: tried two simpler approaches first,
 *  both rejected by Google in 2024–2025:
 *    1. drive.google.com/uc?export=view&id=...  — returns an HTML
 *       virus-warning page for any file >100 MB.
 *    2. googleapis.com/drive/v3/files/{id}?alt=media&access_token=X
 *       — was the legacy way; Google now returns 403 + no CORS
 *       headers, so <video src=...> fails outright (the screenshot
 *       you see with "ERR_FAILED 403" is exactly this).
 *
 *  Only the proxy works. The FILE STILL LIVES ONLY ON DRIVE — this
 *  endpoint just pipes bytes through in real time and forgets them
 *  the instant the response stream closes. Nothing is cached or
 *  persisted on our side.
 *
 *  Range-aware: forwards the browser's Range header to Drive and
 *  echoes Content-Range/Content-Length back so seek+scrub work
 *  natively in the <video> element.
 *
 *  Cost: bandwidth runs through Vercel. Each per-Range chunk is
 *  small (browser fetches 1–4 MB at a time) so individual function
 *  invocations stay well under the 10s Hobby timeout. Total
 *  monthly bandwidth = Σ(video size × viewers per video). At
 *  100 GB/month free tier you can absorb hundreds of small-project
 *  views before paying anything.
 * ────────────────────────────────────────────────────────────── */
async function handleStreamVideo(req: VercelRequest, res: VercelResponse) {
  // LEGACY PATH — NEUTRALIZED. This used to pipe video bytes straight
  // through Vercel, which is exactly what blew past the egress free
  // tier. get-stream-token no longer mints this URL (it always points
  // at the Cloudflare Worker now), but an old/cached share link or a
  // manual hit could still land here. Rather than stream a single byte
  // through Vercel, 302-redirect to the Worker so EVERY byte rides
  // Cloudflare. The browser re-issues its Range request to the Worker,
  // so seek/scrub keep working.
  const shareToken = String(req.query.token || '').trim()
  if (!shareToken) {
    res.status(400).send('shareToken required')
    return
  }
  // FAIL SAFE: no worker base → refuse, never stream bytes through Vercel.
  if (!WORKER_STREAM_BASE) {
    res.status(500).send('stream worker not configured')
    return
  }
  const passwordToken = String(req.query.t || '').trim()
  const roundId = String(req.query.r || '').trim()
  const download = String(req.query.d || '').trim() === '1'
  let target = `${WORKER_STREAM_BASE}/?token=${encodeURIComponent(shareToken)}`
  if (passwordToken) target += `&t=${encodeURIComponent(passwordToken)}`
  if (roundId) target += `&r=${encodeURIComponent(roundId)}`
  if (download) target += '&d=1'
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(302, target)
}

/* Returns a stream URL the <video> tag can use directly. The URL
 * ALWAYS points at the Cloudflare Worker (WORKER_STREAM_BASE) so video
 * bytes never touch Vercel — there is no Vercel-proxy fallback anymore. */
async function handleGetStreamToken(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  // FAIL SAFE: no worker base → refuse, never mint a Vercel URL.
  if (!WORKER_STREAM_BASE) {
    return res
      .status(500)
      .json({ ok: false, error: 'stream-not-configured' })
  }
  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundData, group } = resolved
  const title = String(group?.title || roundData.title || '')
  const videoMime = String(roundData.videoMime || '')

  // Stream URL includes the roundId hint (`&r=`) for new-style
  // groups so the Worker → auth-stream → Drive flow can identify
  // which round's file to fetch. Legacy single-round projects don't
  // need it (shareToken already identifies the round).
  const cfBase = WORKER_STREAM_BASE
  const passwordSuffix = body.passwordToken
    ? `&t=${encodeURIComponent(String(body.passwordToken))}`
    : ''
  const roundSuffix = group
    ? `&r=${encodeURIComponent(String(roundData.id || ''))}`
    : ''
  // ALWAYS the Cloudflare Worker — never /api/revisions?action=stream-video.
  // Routing video bytes through Vercel is exactly what blew past the egress
  // free tier; the worker base is hardcoded so this can't silently regress.
  const baseUrl = `${cfBase}/?token=${encodeURIComponent(shareToken)}${passwordSuffix}${roundSuffix}`

  // Separate download URL — appends `&d=1`, which the Worker
  // honors by sending `Content-Disposition: attachment` instead
  // of `inline`. That flips the browser from "play inline" mode
  // (used by the <video> tag) to "save as file" mode (used by
  // the explicit "הורדה" link rendered when the editor enables
  // the allowDownload toggle). Only returned when the project's
  // allowDownload setting is on AND we know about the group
  // (legacy single-round projects don't have the toggle yet).
  const allowDownload = group?.allowDownload === true
  const downloadFileName = String(roundData.videoFileName || '') ||
    `round-${roundData.roundNumber || 1}.mp4`
  const downloadUrl =
    allowDownload && cfBase
      ? `${baseUrl}&d=1`
      : null

  return res.status(200).json({
    ok: true,
    streamUrl: baseUrl,
    downloadUrl,
    downloadFileName,
    videoMime,
    title,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: auth-stream  (Cloudflare Worker ↔ Vercel handshake)
 *
 *  POST /api/revisions?action=auth-stream
 *  Header: X-Worker-Secret: <shared secret>
 *  Body:   { shareToken, passwordToken? }
 *  Returns: { ok, accessToken, driveFileId }
 *
 *  Authenticates the Cloudflare Worker that proxies video bytes.
 *  The Worker calls this once per HTTP request from the browser
 *  (could be cached for a short window) to:
 *    1. Verify the share token + password.
 *    2. Get a Drive access token for the project's owner.
 *  Then the Worker uses the access token to fetch Drive directly.
 *
 *  The shared secret lives in Vercel env (WORKER_SHARED_SECRET)
 *  AND in the Worker env (WORKER_SECRET) — same value, two homes.
 *  Without it the access token would leak to any browser that asks,
 *  letting an attacker access OTHER projects the same Drive owns.
 * ────────────────────────────────────────────────────────────── */
async function handleAuthStream(req: VercelRequest, res: VercelResponse) {
  const expected = (process.env.WORKER_SHARED_SECRET || '').trim()
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'WORKER_SHARED_SECRET not set' })
  }
  const got = req.headers['x-worker-secret']
  if (typeof got !== 'string' || got !== expected) {
    return res.status(403).json({ ok: false, error: 'invalid worker secret' })
  }

  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundData } = resolved

  // R2-backed round: hand the Worker the object key; it reads the bytes
  // straight from R2 via its binding (no token, zero egress).
  const r2Key = String(roundData.r2Key || '')
  if (r2Key) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, r2Key })
  }

  // Drive-backed round (a user kept on the Google Drive backend): mint a
  // fresh access token from the owner's stored refresh token and hand the
  // Worker the Drive file id, exactly like before the R2 migration.
  const driveFileId = String(roundData.driveFileId || '')
  if (!driveFileId) {
    return res.status(404).json({ ok: false, error: 'video not attached' })
  }
  const ownerUid = String(roundData.ownerUid || '')
  const integrationSnap = await integrationDocRef(ownerUid).get()
  if (!integrationSnap.exists) {
    return res.status(500).json({ ok: false, error: 'drive not connected' })
  }
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  try {
    const r = await refreshAccessToken(refreshToken)
    res.setHeader('Cache-Control', 'no-store')
    return res
      .status(200)
      .json({ ok: true, accessToken: r.accessToken, driveFileId })
  } catch {
    return res.status(401).json({ ok: false, error: 'drive auth expired' })
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Action: admin-usage  (ADMIN ONLY)
 *
 *  Live infrastructure quota dashboard for the admin panel. Pulls
 *  real usage from the two platforms that expose it cleanly:
 *    - Firestore: Google Cloud Monitoring API (document read/write
 *      counts, last 24h) vs the 50K read / 20K write free daily caps.
 *    - Cloudflare: GraphQL Analytics API (Worker requests, last 24h)
 *      vs the 100K/day free cap.
 *  Vercel has no clean usage API on Hobby, so the client just links
 *  out to the Vercel dashboard.
 *
 *  Every source is independently try/caught and reports
 *  { configured:false } when its env/credentials aren't set, so the
 *  dashboard degrades gracefully instead of erroring as a whole.
 * ────────────────────────────────────────────────────────────── */

/** Mint a Google OAuth access token for the given scope from the
 *  service-account creds in FIREBASE_SERVICE_ACCOUNT (RS256 JWT
 *  assertion → token exchange). No extra deps — Node crypto signs. */
async function googleAccessToken(scope: string): Promise<{ token: string; projectId: string }> {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set')
  const sa = JSON.parse(raw) as {
    client_email: string
    private_key: string
    project_id: string
  }
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        iss: sa.client_email,
        scope,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  )
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(sa.private_key)
  const assertion = `${header}.${claims}.${b64url(sig)}`
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const j = (await r.json()) as { access_token?: string }
  if (!j.access_token) throw new Error('google token exchange failed')
  return { token: j.access_token, projectId: sa.project_id }
}

/** Sum a Firestore Monitoring metric over the last 24h. */
async function firestoreMetricSum(
  projectId: string,
  token: string,
  metricType: string,
): Promise<number> {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  const params = new URLSearchParams()
  params.set('filter', `metric.type="${metricType}"`)
  params.set('interval.startTime', start.toISOString())
  params.set('interval.endTime', end.toISOString())
  params.set('aggregation.alignmentPeriod', '86400s')
  params.set('aggregation.perSeriesAligner', 'ALIGN_SUM')
  params.set('aggregation.crossSeriesReducer', 'REDUCE_SUM')
  const url = `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params.toString()}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`monitoring ${r.status}: ${body.slice(0, 300)}`)
  }
  const j = (await r.json()) as {
    timeSeries?: Array<{ points?: Array<{ value?: { int64Value?: string; doubleValue?: number } }> }>
  }
  let sum = 0
  for (const ts of j.timeSeries || []) {
    for (const p of ts.points || []) {
      const v = p.value?.int64Value != null ? Number(p.value.int64Value) : p.value?.doubleValue || 0
      sum += v
    }
  }
  return sum
}

async function fetchFirestoreUsage() {
  // Surface WHICH service account + project the code is actually using,
  // so a 403 can be diagnosed (e.g. the role was granted to a different
  // SA than the one in FIREBASE_SERVICE_ACCOUNT).
  let saEmail = '?'
  let saProject = '?'
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT
    if (raw) {
      const sa = JSON.parse(raw) as { client_email?: string; project_id?: string }
      saEmail = sa.client_email || '?'
      saProject = sa.project_id || '?'
    }
  } catch {
    /* ignore */
  }
  try {
    const { token, projectId } = await googleAccessToken(
      'https://www.googleapis.com/auth/monitoring.read',
    )
    const [reads, writes] = await Promise.all([
      firestoreMetricSum(projectId, token, 'firestore.googleapis.com/document/read_count'),
      firestoreMetricSum(projectId, token, 'firestore.googleapis.com/document/write_count'),
    ])
    const r = Math.round(reads)
    const w = Math.round(writes)
    // Projected MONTHLY cost: today's overage above the free daily
    // allowance × 30, at Firestore's published rates. Matches the
    // dashboard caption ($0.03 / 100K reads, $0.18 / 100K writes).
    const costReads =
      (Math.max(0, r - FS_FREE_READS_DAY) * 30 * FS_READ_USD_PER_100K) / 100_000
    const costWrites =
      (Math.max(0, w - FS_FREE_WRITES_DAY) * 30 * FS_WRITE_USD_PER_100K) / 100_000
    return {
      configured: true,
      reads: r,
      readsLimit: FS_FREE_READS_DAY,
      writes: w,
      writesLimit: FS_FREE_WRITES_DAY,
      costReads,
      costWrites,
      costTotal: costReads + costWrites,
    }
  } catch (err) {
    return {
      configured: false,
      error: `${String((err as Error)?.message || err)} | SA=${saEmail} | project=${saProject}`,
    }
  }
}

async function fetchCloudflareUsage() {
  const apiToken = (process.env.CF_API_TOKEN || '').trim()
  const accountId = (process.env.CF_ACCOUNT_ID || '').trim()
  if (!apiToken || !accountId) {
    return { configured: false, error: 'CF_API_TOKEN / CF_ACCOUNT_ID not set' }
  }
  try {
    const end = new Date()
    // Last 24h. The account is on the FREE Workers plan (only R2 is on a
    // paid subscription), so the relevant allowance is 100K requests/day.
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
    const query = `query($acc:String!,$start:Time!,$end:Time!){
      viewer { accounts(filter:{accountTag:$acc}) {
        workersInvocationsAdaptive(limit:10000, filter:{datetime_geq:$start, datetime_leq:$end}) {
          sum { requests }
        }
      } }
    }`
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { acc: accountId, start: start.toISOString(), end: end.toISOString() },
      }),
    })
    if (!r.ok) throw new Error(`cf ${r.status}`)
    const j = (await r.json()) as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> } }
      errors?: unknown
    }
    if (j.errors) throw new Error('cf graphql error')
    const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || []
    const requests = rows.reduce((acc, row) => acc + (row.sum?.requests || 0), 0)
    // Free Workers plan: 100K requests/day included, and NO overage
    // billing — beyond the daily cap requests are throttled (the Worker
    // stops responding until the next day), not charged. So monthly cost
    // on Free is always $0. (Workers Paid would be $5/mo incl 10M req/mo,
    // then $0.30 per additional million.)
    return {
      configured: true,
      requests,
      requestsLimit: 100000,
      plan: 'free',
      costTotal: 0,
    }
  } catch (err) {
    return { configured: false, error: String((err as Error)?.message || err) }
  }
}

/* ── Cloudflare R2 storage + projected monthly cost ──────────────
 *  Account is on the "R2 Paid" subscription: $0.00/month base, pay
 *  PER USAGE only (confirmed on the Cloudflare billing page). So there
 *  is NO fixed monthly fee — the bill is purely usage above the free
 *  tier, using Cloudflare's public R2 rates:
 *    - R2 storage:           $0.015 / GB-month, first 10 GB free
 *    - R2 egress:            FREE
 *    - Class A operations:   $4.50 / million, first 1M free
 *    - Class B operations:   $0.36 / million, first 10M free
 *  At solo-creator scale the operations stay within the free tier, so
 *  storage above 10 GB is effectively the only cost. We compute "GB in
 *  use" by summing every active, R2-backed round's video size from our
 *  own DB (one scan; accurate, no R2-analytics permission needed).
 *  Update these constants if Cloudflare changes pricing. */
const R2_FREE_STORAGE_GB = 10
const R2_STORAGE_USD_PER_GB_MONTH = 0.015
const BYTES_PER_GB = 1024 * 1024 * 1024

/* Firestore (Blaze) free DAILY allowance + published overage rates.
 * Used to project the monthly database cost from the live 24h counts. */
const FS_FREE_READS_DAY = 50_000
const FS_FREE_WRITES_DAY = 20_000
const FS_READ_USD_PER_100K = 0.03
const FS_WRITE_USD_PER_100K = 0.18

async function fetchR2Usage() {
  try {
    // Sum the actual stored bytes: every R2-backed, non-archived round.
    let usedBytes = 0
    let roundCount = 0
    const snap = await getDb().collection('revisionProjects').get()
    for (const d of snap.docs) {
      const r = d.data() as {
        r2Key?: string
        videoSizeBytes?: number
        status?: string
      }
      if (r.r2Key && r.status !== 'archived') {
        usedBytes += Number(r.videoSizeBytes) || 0
        roundCount += 1
      }
    }
    const usedGb = usedBytes / BYTES_PER_GB
    const billableGb = Math.max(0, usedGb - R2_FREE_STORAGE_GB)
    const costStorage = billableGb * R2_STORAGE_USD_PER_GB_MONTH
    // No fixed base on R2 Paid → total is purely storage overage.
    const costTotal = costStorage
    return {
      configured: true,
      usedBytes,
      usedGb,
      roundCount,
      freeStorageGb: R2_FREE_STORAGE_GB,
      costStorage,
      costTotal,
    }
  } catch (err) {
    return { configured: false, error: String((err as Error)?.message || err) }
  }
}

/* Emails sent in the last 24h vs the ~500/day Gmail SMTP cap. Summed
 * from the UTC hourly buckets written by recordEmailSent() across the
 * email-sending endpoints (metrics/emailSends). */
async function fetchEmailUsage() {
  try {
    const snap = await getDb().collection('metrics').doc('emailSends').get()
    const hours =
      (snap.exists
        ? (snap.data() as { hours?: Record<string, number> }).hours
        : {}) || {}
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    let sent24h = 0
    for (const [bucket, n] of Object.entries(hours)) {
      const t = Date.parse(`${bucket}:00:00Z`) // bucket = YYYY-MM-DDTHH
      if (Number.isFinite(t) && t >= cutoff) sent24h += Number(n) || 0
    }
    return { configured: true, sent24h, limit: 500 }
  } catch (err) {
    return { configured: false, error: String((err as Error)?.message || err) }
  }
}

async function handleAdminUsage(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  // Admin only — same allowlist as the Firestore rules' isAdmin().
  if (verified.email !== 'dyshalts@gmail.com') {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const [firestore, cloudflare, r2, cfg, vc, email] = await Promise.all([
    fetchFirestoreUsage(),
    fetchCloudflareUsage(),
    fetchR2Usage(),
    readProtectionConfig(),
    readVercelInvocations(),
    fetchEmailUsage(),
  ])

  // Auto-trip: if the ceiling guard is armed and today's usage crossed
  // either ceiling, engage maintenance mode automatically (one write).
  // This piggybacks on the Cloud Monitoring numbers we already fetched
  // (free, not Firestore) so the guard itself adds no read load.
  let autoTripped = false
  const reads = firestore.configured ? firestore.reads || 0 : 0
  const writes = firestore.configured ? firestore.writes || 0 : 0
  const overRead = cfg.dailyReadCeiling > 0 && reads >= cfg.dailyReadCeiling
  const overWrite = cfg.dailyWriteCeiling > 0 && writes >= cfg.dailyWriteCeiling
  if (cfg.autoKill && !cfg.killSwitch && (overRead || overWrite)) {
    try {
      await getDb()
        .collection('appConfig')
        .doc('global')
        .set({ killSwitch: true }, { merge: true })
      killCacheRev = { value: true, ts: Date.now() }
      cfg.killSwitch = true
      autoTripped = true
      const which = overRead
        ? `קריאות ${reads.toLocaleString()}/${cfg.dailyReadCeiling.toLocaleString()}`
        : `כתיבות ${writes.toLocaleString()}/${cfg.dailyWriteCeiling.toLocaleString()}`
      await sendTelegramAlert(
        `🚨 מצב תחזוקה נדלק אוטומטית — נחצתה התקרה היומית (${which}). האתר והתוכנה חסומים עד שתכבה ידנית ב"הגדרות".`,
      )
    } catch {
      /* if the write fails, leave the switch as-is */
    }
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    ok: true,
    firestore,
    cloudflare,
    r2,
    vercel: {
      configured: true,
      invocations: vc.invocations,
      invocationsLimit: 100000,
      month: vc.month,
      dashboardUrl: 'https://vercel.com/dashboard/usage',
    },
    protection: {
      killSwitch: cfg.killSwitch,
      autoKill: cfg.autoKill,
      dailyReadCeiling: cfg.dailyReadCeiling,
      dailyWriteCeiling: cfg.dailyWriteCeiling,
      autoTripped,
    },
    email,
    fetchedAt: Date.now(),
  })
}

/** Read the cost-protection / kill-switch config from appConfig/global.
 *  One admin-only read per dashboard load; defaults to "off". */
async function readProtectionConfig(): Promise<{
  killSwitch: boolean
  autoKill: boolean
  dailyReadCeiling: number
  dailyWriteCeiling: number
}> {
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    const d = (snap.exists ? snap.data() : {}) as {
      killSwitch?: boolean
      autoKill?: boolean
      dailyReadCeiling?: number
      dailyWriteCeiling?: number
    }
    return {
      killSwitch: d.killSwitch === true,
      autoKill: d.autoKill === true,
      dailyReadCeiling:
        typeof d.dailyReadCeiling === 'number' && d.dailyReadCeiling > 0
          ? d.dailyReadCeiling
          : 0,
      dailyWriteCeiling:
        typeof d.dailyWriteCeiling === 'number' && d.dailyWriteCeiling > 0
          ? d.dailyWriteCeiling
          : 0,
    }
  } catch {
    return {
      killSwitch: false,
      autoKill: false,
      dailyReadCeiling: 0,
      dailyWriteCeiling: 0,
    }
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Note-media via Cloudflare Worker (zero Vercel egress)
 *
 *  Same model as the video stream proxy: the heavy bytes
 *  (screenshots + audio of notes) flow Drive → Cloudflare → browser,
 *  NEVER through Vercel. Vercel only mints a tiny signed URL and,
 *  separately, hands the Worker a Drive access token.
 *
 *  Flow:
 *    1. Client (review page OR owner workspace/desktop) calls
 *       note-media-url / note-media-owner-url. Vercel authenticates
 *       (share token + password, or owner auth), resolves the note's
 *       Drive fileId + owner uid, and returns an ENCRYPTED, short-
 *       lived token packed into a Worker URL: `${CF}/?m=<token>`.
 *    2. Client points <img>/<audio> (or fetch) at that Worker URL.
 *    3. Worker calls auth-media (X-Worker-Secret) with the token →
 *       Vercel decrypts it, mints a Drive access token for the owner,
 *       returns { accessToken, driveFileId }.
 *    4. Worker streams Drive bytes back. Vercel never touches them.
 *
 *  The token is ENCRYPTED (not just signed) so the owner uid + Drive
 *  fileId are never exposed in a URL — only Vercel can read them.
 *  A 15-minute exp limits replay of a leaked URL.
 * ────────────────────────────────────────────────────────────── */

interface MediaTokenClaims {
  uid: string
  fid: string
  exp: number
}

/** Pack the AES-GCM parts into one URL-safe string: iv.tag.ct */
function packMediaToken(uid: string, fid: string): string {
  const exp = Math.floor(Date.now() / 1000) + 15 * 60
  const enc = encryptToken(JSON.stringify({ uid, fid, exp } as MediaTokenClaims))
  return [
    b64url(Buffer.from(enc.iv, 'base64')),
    b64url(Buffer.from(enc.tag, 'base64')),
    b64url(Buffer.from(enc.ct, 'base64')),
  ].join('.')
}

function unpackMediaToken(token: string): MediaTokenClaims | null {
  try {
    const [iv, tag, ct] = token.split('.')
    if (!iv || !tag || !ct) return null
    const plain = decryptToken({
      iv: b64urlDecode(iv).toString('base64'),
      tag: b64urlDecode(tag).toString('base64'),
      ct: b64urlDecode(ct).toString('base64'),
    })
    const claims = JSON.parse(plain) as MediaTokenClaims
    if (!claims.uid || !claims.fid || typeof claims.exp !== 'number') return null
    if (claims.exp < Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

/** Build the Worker media URL for a resolved (owner, fileId) pair.
 *  Returns null when no worker base is configured — the caller then
 *  returns an error rather than a Vercel byte URL (fail safe). */
function mintMediaWorkerUrl(ownerUid: string, driveFileId: string): string | null {
  const cfBase = WORKER_STREAM_BASE
  if (!cfBase) return null
  const tok = packMediaToken(ownerUid, driveFileId)
  return `${cfBase}/?m=${encodeURIComponent(tok)}`
}

/* Action: note-media-url  (PUBLIC — gated by share token + password)
 * Returns { ok, url } — a Cloudflare Worker URL for the note's media.
 * Mirrors handleNoteMedia's auth but streams ZERO bytes through us. */
async function handleNoteMediaUrl(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
    noteId?: string
    kind?: 'image' | 'audio'
  }
  const shareToken = String(body.shareToken || '').trim()
  const noteId = String(body.noteId || '').trim()
  const kind = body.kind
  if (!shareToken || !noteId) return res.status(400).json({ ok: false, error: 'shareToken + noteId required' })
  if (kind !== 'image' && kind !== 'audio') return res.status(400).json({ ok: false, error: 'bad kind' })

  const resolved = await resolvePublicRound(shareToken, body.roundId || null, body.passwordToken || '')
  if (!resolved.ok) return res.status(resolved.status).json({ ok: false, error: resolved.error })
  const { roundRef, roundData, group } = resolved
  const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')

  const noteSnap = await roundRef.collection('notes').doc(noteId).get()
  if (!noteSnap.exists) return res.status(404).json({ ok: false, error: 'note not found' })
  const note = noteSnap.data() as {
    screenshotDriveFileId?: string | null
    audioDriveFileId?: string | null
    screenshotR2Key?: string | null
    audioR2Key?: string | null
  }

  // R2-backed media → hand the browser a short-lived presigned GET URL
  // straight to R2 (no Worker hop needed for small images/audio).
  const r2Key = kind === 'image' ? note.screenshotR2Key : note.audioR2Key
  if (r2Key) {
    const url = await r2PresignGet(String(r2Key))
    return res.status(200).json({ ok: true, url })
  }

  const driveFileId = kind === 'image' ? note.screenshotDriveFileId : note.audioDriveFileId
  if (!driveFileId) return res.status(404).json({ ok: false, error: 'media not attached' })

  const url = mintMediaWorkerUrl(ownerUid, String(driveFileId))
  if (!url) return res.status(500).json({ ok: false, error: 'media worker not configured' })
  return res.status(200).json({ ok: true, url })
}

/* Action: note-media-owner-url  (auth required — owner only)
 * Owner twin of note-media-url. */
async function handleNoteMediaOwnerUrl(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    sessionToken?: string
    projectId?: string
    noteId?: string
    kind?: 'image' | 'audio'
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const projectId = String(body.projectId || '').trim()
  const noteId = String(body.noteId || '').trim()
  const kind = body.kind
  if (!projectId || !noteId) return res.status(400).json({ ok: false, error: 'projectId + noteId required' })
  if (kind !== 'image' && kind !== 'audio') return res.status(400).json({ ok: false, error: 'bad kind' })

  const projectRef = getDb().collection('revisionProjects').doc(projectId)
  const projectSnap = await projectRef.get()
  if (!projectSnap.exists) return res.status(404).json({ ok: false, error: 'project not found' })
  const project = projectSnap.data() as { ownerUid: string }
  if (project.ownerUid !== verified.uid) return res.status(403).json({ ok: false, error: 'forbidden' })

  const noteSnap = await projectRef.collection('notes').doc(noteId).get()
  if (!noteSnap.exists) return res.status(404).json({ ok: false, error: 'note not found' })
  const note = noteSnap.data() as {
    screenshotDriveFileId?: string | null
    audioDriveFileId?: string | null
    screenshotR2Key?: string | null
    audioR2Key?: string | null
  }

  const r2Key = kind === 'image' ? note.screenshotR2Key : note.audioR2Key
  if (r2Key) {
    const url = await r2PresignGet(String(r2Key))
    return res.status(200).json({ ok: true, url })
  }

  const driveFileId = kind === 'image' ? note.screenshotDriveFileId : note.audioDriveFileId
  if (!driveFileId) return res.status(404).json({ ok: false, error: 'media not attached' })

  const url = mintMediaWorkerUrl(project.ownerUid, String(driveFileId))
  if (!url) return res.status(500).json({ ok: false, error: 'media worker not configured' })
  return res.status(200).json({ ok: true, url })
}

/* Action: auth-media  (Cloudflare Worker ↔ Vercel handshake)
 * Header: X-Worker-Secret. Body: { m: <packed token> }.
 * Returns { ok, accessToken, driveFileId }. The Worker uses these to
 * fetch the file from Drive and stream it — bytes never touch Vercel. */
async function handleAuthMedia(req: VercelRequest, res: VercelResponse) {
  const expected = (process.env.WORKER_SHARED_SECRET || '').trim()
  if (!expected) return res.status(500).json({ ok: false, error: 'WORKER_SHARED_SECRET not set' })
  const got = req.headers['x-worker-secret']
  if (typeof got !== 'string' || got !== expected) {
    return res.status(403).json({ ok: false, error: 'invalid worker secret' })
  }
  const body = (req.body || {}) as { m?: string }
  const claims = unpackMediaToken(String(body.m || ''))
  if (!claims) return res.status(403).json({ ok: false, error: 'bad or expired media token' })

  const integrationSnap = await integrationDocRef(claims.uid).get()
  if (!integrationSnap.exists) return res.status(500).json({ ok: false, error: 'drive not connected' })
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  try {
    const r = await refreshAccessToken(refreshToken)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, accessToken: r.accessToken, driveFileId: claims.fid })
  } catch {
    return res.status(401).json({ ok: false, error: 'drive auth expired' })
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Action: check-video-status
 *
 *  POST /api/revisions?action=check-video-status  { idToken, projectId }
 *  Returns { ok, status: 'processing' | 'ready' | 'failed', durationSec? }
 *
 *  Drive doesn't push notifications when transcoding completes —
 *  the editor's client polls this endpoint every ~30s while
 *  videoStatus is 'processing'. We hit Drive's files.get with
 *  fields=videoMediaMetadata; the field is populated only after
 *  transcoding succeeds. When we see it we flip the Firestore
 *  videoStatus to 'ready' so the editor's UI updates immediately
 *  (via real-time listener) and future polls short-circuit.
 * ────────────────────────────────────────────────────────────── */
async function handleCheckVideoStatus(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string; projectId?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as {
    ownerUid: string
    r2Key?: string
    driveFileId?: string
    videoStatus?: string
  }
  // Authorization — only the owner can poll their own project.
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  // Both backends serve the file the moment the round doc exists with a
  // key — R2 has no transcode step, and Drive files stream through the
  // Worker immediately. So once either key is present it's ready.
  if (project.r2Key || project.driveFileId || project.videoStatus === 'ready') {
    return res.status(200).json({ ok: true, status: 'ready' })
  }
  return res.status(200).json({ ok: true, status: 'processing' })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: delete-project
 *
 *  Two modes:
 *    deleteDriveFile=false (default) → SOFT delete. Flips the
 *      Firestore status to 'archived' and revokes the file's
 *      "anyone with link" permission on Drive (so old share links
 *      stop working immediately). The Drive file itself stays
 *      where it is — useful when the editor wants to keep the raw
 *      footage but stop the client from accessing it.
 *    deleteDriveFile=true → also DELETE THE DRIVE FILE itself
 *      (files.delete). Frees up the user's Drive quota. Irrevers-
 *      ible: the file goes to the Drive trash and will eventually
 *      be permanently deleted. Used when the round was a working
 *      copy the editor no longer needs.
 *
 *  Either way the Firestore doc is archived and the share link
 *  stops resolving — the difference is only what happens to the
 *  underlying bytes in Drive.
 * ────────────────────────────────────────────────────────────── */
async function handleDeleteProject(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    projectId?: string
    deleteDriveFile?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })
  const deleteDriveFile = body.deleteDriveFile === true

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as {
    ownerUid: string
    driveFileId?: string
    notesFolderId?: string
    r2Key?: string
    videoSizeBytes?: number
  }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  // R2-backed legacy project (defensive — legacy projects predate R2,
  // but never leak storage if one exists): always delete the object +
  // its note-media and free the quota, regardless of the Drive flag.
  if (project.r2Key) {
    try {
      await r2DeleteObject(project.r2Key)
      await adjustStorageUsage(
        verified.uid,
        -(Number(project.videoSizeBytes) || 0),
      )
      await deleteRoundNoteMediaR2(verified.uid, projectId)
    } catch (err) {
      console.warn('[revisions/delete] R2 cleanup failed (ignoring):', err)
    }
  }

  // Drive cleanup — share-link revoke (always) + optional file
  // delete. Best-effort: if Drive hiccups we still archive the
  // Firestore doc, because the public review page checks
  // status='active' before serving anything.
  let driveDeleted = false
  try {
    const integrationSnap = await integrationDocRef(verified.uid).get()
    if (integrationSnap.exists && project.driveFileId) {
      const integration = integrationSnap.data() as IntegrationDoc
      const refreshToken = decryptToken(integration.refreshTokenEnc)
      const tokenResp = await refreshAccessToken(refreshToken)

      if (deleteDriveFile) {
        // Trash the main video file AND the entire "קבצי תיקונים"
        // subfolder (which sweeps every screenshot + voice memo
        // attached to any note in this project). Trashing a Drive
        // folder takes its contents along — no need to iterate
        // individual notes.
        //
        // Both calls run in parallel for speed. We mark
        // driveDeleted=true if the main video trash succeeded; the
        // notes folder is best-effort beyond that (the user's
        // primary concern is the video — orphan thumbnails are a
        // cleanup nuisance, not a privacy leak, since they sit
        // inside their own Drive).
        const trashUrl = (id: string) =>
          `https://www.googleapis.com/drive/v3/files/${id}`
        const trashOpts = {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenResp.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ trashed: true }),
        }
        const [trashResp] = await Promise.all([
          fetch(trashUrl(project.driveFileId), trashOpts),
          project.notesFolderId
            ? fetch(trashUrl(project.notesFolderId), trashOpts).catch(
                () => undefined,
              )
            : Promise.resolve(undefined),
        ])
        if (trashResp.ok) {
          driveDeleted = true
        } else {
          console.warn(
            '[revisions/delete] Drive trash failed:',
            trashResp.status,
          )
        }
      } else {
        // Soft delete only — revoke the "anyone" permission so the
        // share link stops working. The file itself stays in Drive.
        const permsResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${project.driveFileId}/permissions?fields=permissions(id,type)`,
          { headers: { Authorization: `Bearer ${tokenResp.accessToken}` } },
        )
        if (permsResp.ok) {
          const perms = (await permsResp.json()) as {
            permissions?: Array<{ id: string; type: string }>
          }
          const anyonePerm = perms.permissions?.find((p) => p.type === 'anyone')
          if (anyonePerm) {
            await fetch(
              `https://www.googleapis.com/drive/v3/files/${project.driveFileId}/permissions/${anyonePerm.id}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${tokenResp.accessToken}` },
              },
            )
          }
        }
      }
    }
  } catch (err) {
    console.warn('[revisions/delete] Drive cleanup failed (ignoring):', err)
  }

  await docRef.update({
    status: 'archived',
    driveDeleted,
    updatedAt: Date.now(),
  })
  return res.status(200).json({ ok: true, driveDeleted })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: delete-round  (auth required — owner only)
 *
 *  POST /api/revisions?action=delete-round
 *  Body: { idToken, roundId, deleteDriveFile? }
 *  Returns: { ok, driveDeleted, lastRound }
 *
 *  Archives a single round inside a project group. Used when the
 *  editor wants to remove one cut from a multi-round project
 *  without nuking the whole project. The notes folder is shared
 *  across siblings, so we never trash it here — that only happens
 *  in delete-group. If this was the last active round in the
 *  group, we return lastRound=true so the desktop UI can prompt
 *  "the project is now empty; delete it too?" — we intentionally
 *  do NOT auto-delete the group, to keep delete semantics
 *  predictable (one action, one Firestore mutation surface).
 *
 *  Refuses on legacy single-round projects (no groupId). The
 *  caller should use delete-project for those.
 * ────────────────────────────────────────────────────────────── */
async function handleDeleteRound(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    roundId?: string
    deleteDriveFile?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const roundId = String(body.roundId || '').trim()
  if (!roundId) return res.status(400).json({ ok: false, error: 'roundId' })
  const deleteDriveFile = body.deleteDriveFile === true

  const roundRef = getDb().collection('revisionProjects').doc(roundId)
  const snap = await roundRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'הסבב לא נמצא' })
  const round = snap.data() as {
    ownerUid: string
    r2Key?: string
    driveFileId?: string
    videoSizeBytes?: number
    groupId?: string
  }
  if (round.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  if (!round.groupId) {
    // Legacy project — refuse and point the caller at delete-project
    // so it gets the original flow (with notes-folder cleanup etc.).
    return res.status(400).json({
      ok: false,
      error: 'סבב ישן — השתמש ב-delete-project',
    })
  }

  // Remove the round's video from storage. For R2 we ALWAYS delete the
  // object (it's our storage — keeping it just wastes the user's quota)
  // and decrement the usage counter. For Drive we only trash when the
  // caller opted in (the file lives in the user's own Drive).
  let driveDeleted = false
  const mediaTrashedCount = 0
  if (round.r2Key) {
    driveDeleted = await r2DeleteObject(round.r2Key)
    await adjustStorageUsage(round.ownerUid, -(Number(round.videoSizeBytes) || 0))
    // Also delete this round's R2 note-media attachments + free quota.
    await deleteRoundNoteMediaR2(round.ownerUid, roundId)
  } else if (deleteDriveFile && round.driveFileId) {
    driveDeleted = await driveTrashFile(round.ownerUid, round.driveFileId)
  }

  await roundRef.update({
    status: 'archived',
    driveDeleted,
    updatedAt: Date.now(),
  })

  // Was this the last active sibling? The UI uses this to decide
  // whether to surface the "delete the empty project too?" prompt.
  const siblingsSnap = await getDb()
    .collection('revisionProjects')
    .where('groupId', '==', round.groupId)
    .get()
  const remaining = siblingsSnap.docs.filter((d) => {
    const r = d.data() as { status?: string }
    return r.status === 'active' && d.id !== roundId
  }).length

  // Keep the denormalised count on the group in sync with reality so
  // the (rounds-free) project list shows the right number.
  if (round.groupId) {
    await getDb()
      .collection('revisionGroups')
      .doc(round.groupId)
      .update({ roundCount: remaining, updatedAt: Date.now() })
  }

  return res.status(200).json({
    ok: true,
    driveDeleted,
    mediaTrashedCount,
    lastRound: remaining === 0,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: delete-group  (auth required — owner only)
 *
 *  POST /api/revisions?action=delete-group
 *  Body: { idToken, groupId, deleteDriveFiles? }
 *  Returns: { ok, driveDeleted, roundsArchived }
 *
 *  Archives an entire project (group + all its rounds). Drive
 *  cleanup, when enabled, trashes every round's video file plus
 *  the shared notes folder on the group. All Firestore writes
 *  go through a single batch so the UI never observes a partial
 *  state (group archived, rounds still active or vice versa).
 * ────────────────────────────────────────────────────────────── */
async function handleDeleteGroup(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    groupId?: string
    deleteDriveFiles?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const groupId = String(body.groupId || '').trim()
  if (!groupId) return res.status(400).json({ ok: false, error: 'groupId' })
  const deleteDriveFiles = body.deleteDriveFiles === true

  const db = getDb()
  const groupRef = db.collection('revisionGroups').doc(groupId)
  const groupSnap = await groupRef.get()
  if (!groupSnap.exists) return res.status(404).json({ ok: false, error: 'הפרויקט לא נמצא' })
  const group = groupSnap.data() as RevisionGroupDoc
  if (group.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  const roundsSnap = await db
    .collection('revisionProjects')
    .where('groupId', '==', groupId)
    .get()
  const activeRoundDocs = roundsSnap.docs.filter((d) => {
    const r = d.data() as { status?: string }
    return r.status === 'active'
  })

  // Optional R2 cleanup — delete every round's video object from our
  // bucket so the user's quota is freed immediately. Note-media (still
  // on Drive during the transition) is handled when that path migrates.
  let driveDeleted = false
  const mediaTrashedCount = 0
  {
    const ops: Array<Promise<unknown>> = []
    let freedBytes = 0
    for (const d of activeRoundDocs) {
      const r = d.data() as {
        r2Key?: string
        driveFileId?: string
        ownerUid?: string
        videoSizeBytes?: number
      }
      if (r.r2Key) {
        // R2 video: always delete + free quota + clean its note media.
        ops.push(r2DeleteObject(r.r2Key))
        ops.push(deleteRoundNoteMediaR2(r.ownerUid || verified.uid, d.id))
        freedBytes += Number(r.videoSizeBytes) || 0
        driveDeleted = true
      } else if (deleteDriveFiles && r.driveFileId) {
        // Drive video: only trash when the caller opted in.
        ops.push(driveTrashFile(r.ownerUid || verified.uid, r.driveFileId))
        driveDeleted = true
      }
    }
    await Promise.all(ops)
    if (freedBytes > 0) await adjustStorageUsage(verified.uid, -freedBytes)
  }

  const now = Date.now()
  const batch = db.batch()
  for (const d of activeRoundDocs) {
    batch.update(d.ref, {
      status: 'archived',
      driveDeleted,
      updatedAt: now,
    })
  }
  batch.update(groupRef, {
    status: 'archived',
    updatedAt: now,
  })
  await batch.commit()

  return res.status(200).json({
    ok: true,
    driveDeleted,
    mediaTrashedCount,
    roundsArchived: activeRoundDocs.length,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: delete-note  (PUBLIC — soft auth by viewer email match)
 *
 *  POST /api/revisions?action=delete-note
 *  Body: { shareToken, passwordToken?, noteId, viewerEmail }
 *
 *  Authorisation model: the viewer claims an email (used for the
 *  watermark + note attribution). We allow them to delete only
 *  notes whose stored viewerEmail matches the claimed one. There's
 *  no real authentication on /review — anyone with the share link
 *  + correct password gets in — so an attacker could spoof an
 *  email and delete someone else's notes. We accept that for now:
 *  the alternative (require viewer accounts) would block the
 *  "send link to a non-technical client" use case entirely. The
 *  notes never leave the editor's project, so even worst-case the
 *  editor still has the original Drive file + can read deletion
 *  attempts in Firestore audit logs.
 * ────────────────────────────────────────────────────────────── */
async function handleDeleteNote(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    roundId?: string
    noteId?: string
    viewerEmail?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  const noteId = String(body.noteId || '').trim()
  const viewerEmail = String(body.viewerEmail || '').trim().toLowerCase()
  if (!shareToken || !noteId || !viewerEmail) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }

  const resolved = await resolvePublicRound(
    shareToken,
    body.roundId,
    body.passwordToken,
  )
  if (!resolved.ok) {
    return res.status(resolved.status).json({ ok: false, error: resolved.error })
  }
  const { roundRef, roundData, group } = resolved
  // Locked rounds are FROZEN: no add-note (handled elsewhere) AND
  // no delete-note (here). The intent is that once the editor
  // closes the round, the thread is preserved as-is for their
  // workflow. If the viewer mis-deletes a note we'd rather they
  // ask the editor to re-open the round than silently lose data.
  if (roundData.locked === true) {
    return res.status(423).json({
      ok: false,
      error: 'הסבב סגור — אי אפשר למחוק תיקונים בשלב זה.',
    })
  }

  const noteRef = roundRef.collection('notes').doc(noteId)
  const noteSnap = await noteRef.get()
  if (!noteSnap.exists) {
    return res.status(404).json({ ok: false, error: 'התיקון לא נמצא' })
  }
  const note = noteSnap.data() as {
    viewerEmail: string
    screenshotDriveFileId?: string | null
    audioDriveFileId?: string | null
    screenshotR2Key?: string | null
    audioR2Key?: string | null
  }
  if ((note.viewerEmail || '').toLowerCase() !== viewerEmail) {
    return res.status(403).json({
      ok: false,
      error: 'ניתן למחוק רק תיקונים שאתם הוספתם',
    })
  }

  // Trash any Drive-side media attached to this note before removing
  // the Firestore doc. Best-effort: if Drive hiccups we still drop
  // the note (the user clicked delete, not "delete-pending-cleanup"),
  // and the orphan media file just sits in the editor's Drive until
  // they clean it up manually. Same forgiveness we apply elsewhere.
  // R2-side media (the new backend) — delete the objects directly.
  // Best-effort, same forgiveness as Drive: a failed delete leaves an
  // orphan object but never blocks the note deletion.
  const r2Keys = [note.screenshotR2Key, note.audioR2Key].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  )
  for (const k of r2Keys) {
    try {
      await r2DeleteObject(k)
    } catch (err) {
      console.warn('[revisions/delete-note] R2 media cleanup failed:', err)
    }
  }

  const driveIds = [note.screenshotDriveFileId, note.audioDriveFileId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  if (driveIds.length > 0) {
    try {
      const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')
      const integrationSnap = await integrationDocRef(ownerUid).get()
      if (integrationSnap.exists) {
        const integration = integrationSnap.data() as IntegrationDoc
        const refreshToken = decryptToken(integration.refreshTokenEnc)
        const r = await refreshAccessToken(refreshToken)
        await Promise.all(
          driveIds.map((id) =>
            fetch(
              `https://www.googleapis.com/drive/v3/files/${id}`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${r.accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ trashed: true }),
              },
            ).catch(() => undefined),
          ),
        )
      }
    } catch (err) {
      console.warn(
        '[revisions/delete-note] Drive media cleanup failed:',
        err,
      )
    }
  }

  await noteRef.delete()
  // Decrement the counter on the round doc. Best-effort, like
  // the increment on add-note — we clamp at 0 to handle the case
  // where the counter and actual note count drifted.
  void roundRef
    .update({
      notesCount: Math.max(0, ((roundData.notesCount as number) || 1) - 1),
      updatedAt: Date.now(),
    })
    .catch(() => undefined)
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: update-group  (auth required — owner only)
 *
 *  POST /api/revisions?action=update-group
 *  Body: {
 *    idToken,
 *    groupId,
 *    password?,        // "" clears, non-empty sets, undefined = no change
 *    watermark?,       // boolean, undefined = no change
 *    allowDownload?,   // boolean, undefined = no change
 *    openInDrive?,     // boolean, undefined = no change
 *  }
 *  Returns: { ok }
 *
 *  Lets the project owner mutate group-level settings after the
 *  group already exists. Patch semantics — only the fields
 *  explicitly passed get touched, everything else stays.
 *
 *  Password convention matches update-project:
 *    - undefined → no change
 *    - ""         → clear existing password
 *    - non-empty  → hash with a fresh salt and store
 *  Existing password tokens already minted stay valid for their
 *  6h TTL (same trade-off as update-project — simpler than
 *  tracking a per-group revocation epoch).
 * ────────────────────────────────────────────────────────────── */
async function handleUpdateGroup(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    groupId?: string
    password?: string
    watermark?: boolean
    allowDownload?: boolean
    openInDrive?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const groupId = String(body.groupId || '').trim()
  if (!groupId) return res.status(400).json({ ok: false, error: 'groupId' })

  const ref = getDb().collection('revisionGroups').doc(groupId)
  const snap = await ref.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const group = snap.data() as RevisionGroupDoc
  if (group.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  // Patch fields — only touch what the caller explicitly passed.
  // `Record<string, unknown>` rather than a typed Partial because
  // Firestore's update() accepts arbitrary key/value pairs and
  // typing it would require enumerating every legal field.
  const update: Record<string, unknown> = { updatedAt: Date.now() }

  if (typeof body.password === 'string') {
    if (body.password === '') {
      // Clear path.
      update.passwordHash = null
      update.passwordSalt = null
    } else {
      if (body.password.length < 4) {
        return res.status(400).json({
          ok: false,
          error: 'הסיסמה קצרה מדי (4 תווים מינימום)',
        })
      }
      const pw = hashPasswordOrNull(body.password)!
      update.passwordHash = pw.passwordHash
      update.passwordSalt = pw.passwordSalt
    }
  }

  if (typeof body.watermark === 'boolean') update.watermark = body.watermark
  if (typeof body.allowDownload === 'boolean')
    update.allowDownload = body.allowDownload
  if (typeof body.openInDrive === 'boolean')
    update.openInDrive = body.openInDrive

  await ref.update(update)
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: update-project  (auth required — owner only)
 *
 *  POST /api/revisions?action=update-project
 *  Body: { idToken, projectId, password? }
 *
 *  Currently supports password mutations only. password === ""
 *  clears any existing password; a non-empty string sets a new
 *  one (re-hashed with a fresh salt). Owner check via Firebase
 *  ID token — only the editor who created the project can update
 *  it. Existing password tokens already issued stay valid for
 *  their 6h TTL (acceptable trade-off, simpler than tracking a
 *  per-project revocation epoch).
 * ────────────────────────────────────────────────────────────── */
async function handleUpdateProject(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    projectId?: string
    password?: string
    locked?: boolean
    /** Editor clears a client's "ready to fix" marker (e.g. the client
     *  pressed it by mistake). Also reopens the round so notes can be
     *  added again. */
    clearFinalized?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as { ownerUid: string }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  // Build the partial update. We only touch fields the client
  // explicitly asked about; missing fields stay as-is. This pattern
  // lets the same endpoint serve both "change password only" and
  // "toggle lock only" calls without needing the client to round-
  // trip the full project doc.
  const update: Record<string, unknown> = { updatedAt: Date.now() }

  if (typeof body.password === 'string') {
    const newPassword = body.password
    if (newPassword === '') {
      // Explicit clear → drop both fields.
      update.passwordHash = null
      update.passwordSalt = null
    } else {
      if (newPassword.length < 4) {
        return res.status(400).json({
          ok: false,
          error: 'הסיסמה קצרה מדי (4 תווים מינימום)',
        })
      }
      const salt = crypto.randomBytes(16).toString('hex')
      const hash = crypto
        .pbkdf2Sync(newPassword, salt, 100_000, 32, 'sha256')
        .toString('hex')
      update.passwordHash = hash
      update.passwordSalt = salt
    }
  }

  if (typeof body.locked === 'boolean') {
    update.locked = body.locked
    // Reopening a round (unlock) is also the "undo finalize" action — the
    // single lock control doubles as reopen-for-corrections, so clear the
    // client's "ready to fix" marker whenever we unlock.
    if (body.locked === false) {
      update.clientFinalizedAt = FieldValue.delete()
      update.clientFinalizedBy = FieldValue.delete()
    }
  }

  // Explicit clear (also reopens) — kept for callers that pass it.
  if (body.clearFinalized === true) {
    update.locked = false
    update.clientFinalizedAt = FieldValue.delete()
    update.clientFinalizedBy = FieldValue.delete()
  }

  await docRef.update(update)
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: replace-project-video  (auth required — owner only)
 *
 *  POST /api/revisions?action=replace-project-video
 *  Body: {
 *    idToken,
 *    projectId,
 *    driveFileId,        // ID of the NEW file already uploaded to Drive
 *    videoFileName,
 *    videoSizeBytes,
 *    videoMime,
 *    trashOldFile?: boolean,  // default true
 *  }
 *
 *  Lets the editor swap the underlying video for an existing
 *  revision round (e.g. they uploaded a wrong format or have a
 *  fresh re-cut for the same round). Existing notes + share
 *  link + folder + password all stay intact — only the pointer to
 *  the Drive video file changes.
 *
 *  The desktop is expected to have already uploaded the new file
 *  to Drive (under סרטונים) and set "anyone with link" sharing on
 *  it BEFORE calling this action — same upload helpers as the new-
 *  revision flow. We just update the Firestore pointer and trash
 *  the obsolete old file from Drive (best-effort, never blocks).
 * ────────────────────────────────────────────────────────────── */
async function handleReplaceProjectVideo(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as {
    idToken?: string
    projectId?: string
    r2Key?: string
    driveFileId?: string
    driveFolderId?: string
    videoFileName?: string
    videoSizeBytes?: number
    videoMime?: string
    trashOldFile?: boolean
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const projectId = String(body.projectId || '').trim()
  const newR2Key = String(body.r2Key || '').trim()
  const newDriveFileId = String(body.driveFileId || '').trim()
  const videoFileName = String(body.videoFileName || '').trim().slice(0, 300)
  const videoSizeBytes = Number(body.videoSizeBytes) || 0
  const videoMime = String(body.videoMime || '').trim().slice(0, 100)
  if (!projectId || (!newR2Key && !newDriveFileId)) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }
  if (newR2Key && !keyBelongsToUser(newR2Key, verified.uid)) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as {
    ownerUid: string
    r2Key?: string
    driveFileId?: string
    videoSizeBytes?: number
  }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const oldR2Key = project.r2Key || ''
  const oldDriveFileId = project.driveFileId || ''
  const oldSizeBytes = Number(project.videoSizeBytes) || 0

  const now = Date.now()
  // Swap to whichever backend the new upload used; clear the other so
  // the round carries exactly one pointer.
  await docRef.update({
    r2Key: newR2Key || null,
    driveFileId: newDriveFileId || null,
    driveFolderId: String(body.driveFolderId || '').trim() || null,
    videoFileName: videoFileName || undefined,
    videoSizeBytes: videoSizeBytes || undefined,
    videoMime: videoMime || undefined,
    videoStatus: 'ready',
    updatedAt: now,
  })

  // Best-effort: remove the OLD object/file unless asked to keep it.
  const trashOld = body.trashOldFile !== false
  let freedOldR2 = false
  if (trashOld) {
    if (oldR2Key && oldR2Key !== newR2Key) {
      await r2DeleteObject(oldR2Key)
      freedOldR2 = true
    }
    if (oldDriveFileId && oldDriveFileId !== newDriveFileId) {
      await driveTrashFile(project.ownerUid, oldDriveFileId)
    }
  }

  // Quota: add the new R2 object's bytes, subtract the freed old one's.
  let delta = 0
  if (newR2Key) delta += videoSizeBytes
  if (freedOldR2) delta -= oldSizeBytes
  if (delta) await adjustStorageUsage(project.ownerUid, delta)

  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: owner-signin  (PUBLIC — exchanges email+password for
 *                         a Firebase ID token, gated by share)
 *
 *  POST /api/revisions?action=owner-signin
 *  Body: { shareToken, email, password }
 *  Returns: { ok: true, idToken, expiresInSec } on success
 *           { ok: false, error } on bad creds / not-owner
 *
 *  Lets the editor authenticate from the /review page without
 *  needing the desktop app, so they can mark notes as resolved /
 *  question / not-possible directly. We:
 *    1. Validate the share token + that this email is the owner.
 *    2. Call identitytoolkit signInWithPassword with the supplied
 *       credentials.
 *    3. Cross-check that the returned uid matches project.ownerUid
 *       — a successful signin only matters if it's for THIS
 *       project's owner.
 *    4. Hand the idToken to the browser. Client stores it in
 *       sessionStorage and forwards it on update-note-status.
 *
 *  Done server-side rather than via the Firebase JS SDK in the
 *  browser so we don't add the (~80KB minified) Auth SDK to the
 *  review page's bundle. The website already uses this pattern in
 *  renew.ts for the BuyPage signin flow.
 * ────────────────────────────────────────────────────────────── */
async function handleOwnerSignin(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    email?: string
    password?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  if (!shareToken || !email || !password) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }

  // Find the project + remember its ownerUid for cross-check.
  // Owner email + uid come from either a new-style group or a
  // legacy round-as-project. resolveByShareToken handles the
  // choice so the rest of the function stays uniform.
  const resolved = await resolveByShareToken(shareToken)
  if (!resolved) return res.status(404).json({ ok: false, error: 'הסבב לא נמצא' })
  const ownerEmail =
    resolved.kind === 'group'
      ? (resolved.group.ownerEmail || '').toLowerCase()
      : String((resolved.round.ownerEmail as string) || '').toLowerCase()
  const ownerUid =
    resolved.kind === 'group'
      ? resolved.group.ownerUid
      : String((resolved.round.ownerUid as string) || '')
  if (ownerEmail !== email) {
    return res.status(403).json({
      ok: false,
      error: 'המייל אינו של בעל הסבב — לא ניתן להתחבר כעורך',
    })
  }

  const apiKey = process.env.FIREBASE_WEB_API_KEY
  if (!apiKey) {
    return res
      .status(500)
      .json({ ok: false, error: 'FIREBASE_WEB_API_KEY לא מוגדר' })
  }
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      },
    )
    const json = (await r.json()) as
      | { idToken: string; localId: string; expiresIn: string }
      | { error?: { message?: string } }
    if (!r.ok || !('idToken' in json)) {
      // Firebase error codes we want to surface readably:
      const msg =
        (json as { error?: { message?: string } }).error?.message || ''
      const friendly = /INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/.test(
        msg,
      )
        ? 'סיסמה שגויה'
        : 'ההתחברות נכשלה'
      return res.status(401).json({ ok: false, error: friendly })
    }
    if (json.localId !== ownerUid) {
      // The credentials are valid but for a DIFFERENT account than
      // the project owner. Defensive — shouldn't normally happen
      // because we filtered by email above, but a stale ownerEmail
      // field (renamed Google account?) could open this gap.
      return res.status(403).json({
        ok: false,
        error: 'החשבון אינו של בעל הסבב',
      })
    }
    return res.status(200).json({
      ok: true,
      idToken: json.idToken,
      expiresInSec: parseInt(json.expiresIn, 10) || 3600,
    })
  } catch (err) {
    console.error('[owner-signin] failed:', err)
    return res.status(502).json({ ok: false, error: 'תקלת רשת — נסו שוב' })
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Action: check-owner-email  (PUBLIC — gated by share token)
 *
 *  POST /api/revisions?action=check-owner-email
 *  Body: { shareToken, email }
 *  Returns: { ok: true, isOwner: boolean }
 *
 *  Used by the public review page to decide whether to prompt for
 *  a password when the reviewer enters their email. If isOwner=true
 *  the page shows a "log in as editor" prompt; signing in unlocks
 *  the status menu so the editor can mark notes as resolved /
 *  question / not-possible without switching to the desktop app.
 *
 *  No auth required because the response leaks essentially nothing
 *  — anyone with the share token can already see project metadata.
 *  Confirming whether a specific email is the owner is information
 *  the editor would readily volunteer on a phone call.
 * ────────────────────────────────────────────────────────────── */
async function handleCheckOwnerEmail(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { shareToken?: string; email?: string }
  const shareToken = String(body.shareToken || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  if (!shareToken || !email) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }
  const resolved = await resolveByShareToken(shareToken)
  if (!resolved) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const ownerEmail =
    resolved.kind === 'group'
      ? (resolved.group.ownerEmail || '').toLowerCase()
      : String((resolved.round.ownerEmail as string) || '').toLowerCase()
  return res.status(200).json({ ok: true, isOwner: ownerEmail === email })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: list-notes-owner  (auth required — owner only)
 *
 *  POST /api/revisions?action=list-notes-owner  { idToken, projectId }
 *  Returns { ok, notes: [...] }
 *
 *  Same shape as list-notes but skips the password gate (owners
 *  shouldn't need to know their own password to read replies) and
 *  works by projectId instead of shareToken (the editor's natural
 *  identifier). Lets the desktop project-detail view fetch the
 *  full thread without polling Firestore directly — which would
 *  need client-SDK security rules we'd rather not maintain.
 * ────────────────────────────────────────────────────────────── */
async function handleListNotesOwner(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string; projectId?: string }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as { ownerUid: string }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  const notesSnap = await docRef
    .collection('notes')
    .orderBy('timeSeconds', 'asc')
    .limit(500)
    .get()
  const notes = notesSnap.docs.map((d) => d.data())
  return res.status(200).json({ ok: true, notes })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: update-note-status  (auth required — owner only)
 *
 *  POST /api/revisions?action=update-note-status
 *  Body: {
 *    idToken,
 *    projectId,
 *    noteId,
 *    status: 'new' | 'resolved' | 'question' | 'not-possible',
 *    editorResponse?: string,
 *  }
 *
 *  Owner-only because "what's the state of this feedback" is a
 *  workflow signal that belongs to the editor, not the client who
 *  left the note. We don't expose a public mutation for status
 *  (clients can't mark their own notes resolved on the editor's
 *  behalf).
 *
 *  Four states:
 *    new          — default; reviewer left this, editor hasn't
 *                   acted on it yet.
 *    resolved     — editor incorporated the change. Green badge,
 *                   no extra text.
 *    question     — editor needs clarification; editorResponse
 *                   carries the question text. Blue badge.
 *    not-possible — editor can't do it; editorResponse carries the
 *                   reason. Amber badge.
 *
 *  editorResponse is required for question/not-possible (gives the
 *  reviewer the context they need) and stripped for new/resolved
 *  (those statuses don't have any associated text).
 * ────────────────────────────────────────────────────────────── */
type NoteStatus = 'new' | 'resolved' | 'question' | 'not-possible'

async function handleUpdateNoteStatus(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    idToken?: string
    projectId?: string
    noteId?: string
    status?: NoteStatus
    editorResponse?: string
  }
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const projectId = String(body.projectId || '').trim()
  const noteId = String(body.noteId || '').trim()
  const status = body.status
  if (!projectId || !noteId) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }
  const validStatuses: NoteStatus[] = ['new', 'resolved', 'question', 'not-possible']
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'סטטוס לא תקין' })
  }
  // Trim + cap the response text. Same 2000-char limit as note text.
  let editorResponse: string | null = null
  if (status === 'question' || status === 'not-possible') {
    editorResponse = String(body.editorResponse || '').trim().slice(0, 2000)
    if (!editorResponse) {
      return res.status(400).json({
        ok: false,
        error:
          status === 'question'
            ? 'חובה לכתוב את השאלה'
            : 'חובה לכתוב את הסיבה שלא ניתן',
      })
    }
  }

  const projectRef = getDb().collection('revisionProjects').doc(projectId)
  const projectSnap = await projectRef.get()
  if (!projectSnap.exists) {
    return res.status(404).json({ ok: false, error: 'לא נמצא' })
  }
  const project = projectSnap.data() as { ownerUid: string }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  const noteRef = projectRef.collection('notes').doc(noteId)
  const noteSnap = await noteRef.get()
  if (!noteSnap.exists) {
    return res.status(404).json({ ok: false, error: 'התיקון לא נמצא' })
  }
  await noteRef.update({
    status,
    // Clear the response when moving BACK to new/resolved — keeps
    // stale question/reason text from haunting a note the editor
    // re-classified.
    editorResponse,
    updatedAt: Date.now(),
  })
  return res.status(200).json({ ok: true })
}

/* ──────────────────────────────────────────────────────────────
 *  Password token (HMAC) — proves the client knows the password
 *  without having to re-enter it on every API call.
 * ────────────────────────────────────────────────────────────── */
function mintPasswordToken(projectId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 6 * 60 * 60 // 6h
  const payload = `${projectId}.${exp}`
  const sig = crypto.createHmac('sha256', hmacSecret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyPasswordToken(token: string, expectedProjectId: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [projectId, expStr, sig] = parts
    if (projectId !== expectedProjectId) return false
    const exp = parseInt(expStr, 10)
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false
    const expected = crypto
      .createHmac('sha256', hmacSecret())
      .update(`${projectId}.${expStr}`)
      .digest('base64url')
    if (expected.length !== sig.length) return false
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  } catch {
    return false
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Kill switch (maintenance mode) — mirror of api/paypal.ts.
 *
 *  This endpoint serves the revisions workspace (uploads, reviewer
 *  video, notes) — the heaviest data path. When the kill switch in
 *  appConfig/global is ON, EVERY action here is blocked with 503
 *  EXCEPT `admin-usage`, which the admin dashboard needs to see the
 *  status and turn the switch back off. Cached in-memory per instance
 *  (≤1 read / 30s) and fails OPEN so a transient read error never
 *  bricks the site.
 * ────────────────────────────────────────────────────────────── */
let killCacheRev: { value: boolean; ts: number } | null = null
const KILL_TTL_MS_REV = 30_000
const KILL_ALLOW_REVISIONS = new Set<string>(['admin-usage'])
async function isSiteKilledRev(): Promise<boolean> {
  const now = Date.now()
  if (killCacheRev && now - killCacheRev.ts < KILL_TTL_MS_REV)
    return killCacheRev.value
  try {
    const snap = await getDb().collection('appConfig').doc('global').get()
    const v =
      snap.exists && (snap.data() as { killSwitch?: boolean }).killSwitch === true
    killCacheRev = { value: v, ts: now }
    return v
  } catch {
    return false // fail open
  }
}

/** Best-effort Telegram alert (mirror of api/paypal.ts). Uses the
 *  DEDICATED alert bot + chat (separate from the feedback bot). Pushes
 *  the auto-trip event so an automatic shutdown is never silent. */
async function sendTelegramAlert(text: string): Promise<void> {
  try {
    const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
    if (!token || !chatId) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    })
  } catch (e) {
    console.error('[telegram-alert] failed:', e)
  }
}

/* ── Client error logging (desktop → server aggregation) ──────────
 *  The desktop app batches errors into a local file and uploads them
 *  here (every few hours / on launch). We GROUP identical errors by a
 *  fingerprint (normalized message + top stack frames) so the admin
 *  Logs tab shows ONE row per unique bug with an occurrence count +
 *  how many devices hit it; click a row to see individual samples. */
function normalizeErrMessage(msg: string): string {
  return String(msg || '')
    .replace(/0x[0-9a-fA-F]+/g, '0xN')
    .replace(/[A-Za-z]:\\[^\s'"]+|\/[^\s'")]+/g, 'PATH') // file paths
    .replace(/\b\d[\d.,:_-]*\b/g, 'N') // numbers / ids / timestamps
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}
function stackSignature(stack: string): string {
  if (!stack) return ''
  const frames = String(stack)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at ') || /:\d+:\d+/.test(l))
    .slice(0, 3)
    .map((l) =>
      l
        .replace(/:\d+:\d+/g, '') // strip line:col
        .replace(/([A-Za-z]:\\|\/)[^\s)]+[\\/]/g, '') // strip dir paths
        .replace(/\?[^\s):]+/g, ''), // strip query strings
    )
  return frames.join(' | ').slice(0, 400)
}
function errorFingerprint(level: string, message: string, stack: string): string {
  const basis = `${level}::${normalizeErrMessage(message)}::${stackSignature(stack)}`
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24)
}

interface ClientLogEntry {
  at?: string
  level?: string
  message?: string
  stack?: string
  context?: unknown
}

async function handleClientLogIngest(req: VercelRequest, res: VercelResponse) {
  const verified = await verifyOwnerAuth(req)
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const body = (req.body || {}) as {
    deviceId?: string
    appVersion?: string
    platform?: string
    entries?: ClientLogEntry[]
  }
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : []
  if (entries.length === 0) return res.status(200).json({ ok: true, ingested: 0 })
  const deviceId = String(body.deviceId || 'unknown').slice(0, 80)
  const appVersion = String(body.appVersion || '?').slice(0, 40)
  const platform = String(body.platform || '?').slice(0, 40)
  const email = verified.email || '?'

  // Group this upload's entries by fingerprint first, so a runaway loop
  // (same error ×1000) costs ONE write, not 1000.
  const groups = new Map<
    string,
    { level: string; message: string; samples: ClientLogEntry[]; count: number }
  >()
  for (const e of entries) {
    const level = String(e.level || 'error').slice(0, 16)
    const message = String(e.message || '').slice(0, 1000)
    const stack = String(e.stack || '').slice(0, 4000)
    if (!message && !stack) continue
    const fp = errorFingerprint(level, message, stack)
    let g = groups.get(fp)
    if (!g) {
      g = { level, message, samples: [], count: 0 }
      groups.set(fp, g)
    }
    g.count += 1
    if (g.samples.length < 10) {
      g.samples.push({ at: e.at, message, stack, context: e.context })
    }
  }

  const db = getDb()
  const now = new Date().toISOString()
  let ingested = 0
  // Cap groups processed per upload so a pathological file can't trigger
  // hundreds of writes. Most-frequent first.
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 50)
  for (const [fp, g] of sorted) {
    const ref = db.collection('clientErrors').doc(fp)
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const prev = (snap.exists ? snap.data() : {}) as {
        devices?: string[]
        samples?: unknown[]
        firstSeenAt?: string
      }
      const devices = new Set<string>(Array.isArray(prev.devices) ? prev.devices : [])
      devices.add(deviceId)
      const fresh = g.samples.map((s) => ({
        at: s.at || now,
        deviceId,
        email,
        appVersion,
        platform,
        message: s.message,
        stack: s.stack,
        context: typeof s.context === 'undefined' ? null : s.context,
      }))
      const samples = [...fresh, ...(Array.isArray(prev.samples) ? prev.samples : [])].slice(0, 30)
      const patch: Record<string, unknown> = {
        fingerprint: fp,
        level: g.level,
        message: g.message,
        count: FieldValue.increment(g.count),
        devices: Array.from(devices).slice(0, 200),
        deviceCount: Math.min(devices.size, 200),
        samples,
        firstSeenAt: prev.firstSeenAt || now,
        lastSeenAt: now,
        lastVersion: appVersion,
        lastPlatform: platform,
      }
      if (!snap.exists) patch.resolved = false // never un-resolve on re-ingest
      tx.set(ref, patch, { merge: true })
    })
    ingested += g.count
  }
  return res.status(200).json({ ok: true, ingested, groups: sorted.length })
}

/* ── Vercel invocation counter (self-metered) — twin of api/paypal.ts.
 *  Every call to this endpoint is one Vercel function invocation. We
 *  count in memory and flush to metrics/vercelUsage only in batches
 *  (a few writes/day), so it costs effectively nothing. */
let vcPendingRev = 0
let vcLastFlushTsRev = Date.now()
const VC_FLUSH_THRESHOLD_REV = 200
const VC_FLUSH_WINDOW_MS_REV = 2 * 60 * 60 * 1000
function recordVercelInvocation(): void {
  vcPendingRev += 1
  const now = Date.now()
  if (
    vcPendingRev < VC_FLUSH_THRESHOLD_REV &&
    now - vcLastFlushTsRev < VC_FLUSH_WINDOW_MS_REV
  )
    return
  const n = vcPendingRev
  vcPendingRev = 0
  vcLastFlushTsRev = now
  const month = new Date().toISOString().slice(0, 7)
  getDb()
    .collection('metrics')
    .doc('vercelUsage')
    .set(
      { counts: { [month]: FieldValue.increment(n) }, updatedAt: now },
      { merge: true },
    )
    .catch(() => {
      vcPendingRev += n
    })
}

/** Read this month's self-metered Vercel invocation count for the
 *  dashboard (one read per dashboard open). */
async function readVercelInvocations(): Promise<{
  invocations: number
  month: string
}> {
  const month = new Date().toISOString().slice(0, 7)
  try {
    const snap = await getDb().collection('metrics').doc('vercelUsage').get()
    const counts =
      (snap.exists
        ? (snap.data() as { counts?: Record<string, number> }).counts
        : {}) || {}
    return { invocations: Math.round(counts[month] || 0), month }
  } catch {
    return { invocations: 0, month }
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Dispatcher
 * ────────────────────────────────────────────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  recordVercelInvocation()
  const action = String(req.query.action || '').trim()
  // Maintenance mode: block all revision traffic except the admin
  // dashboard's own status read.
  if (!KILL_ALLOW_REVISIONS.has(action) && (await isSiteKilledRev())) {
    return res.status(503).json({
      ok: false,
      maintenance: true,
      error: 'המערכת בתחזוקה זמנית. נסה שוב בעוד כמה דקות.',
    })
  }
  try {
    switch (action) {
      case 'oauth-start':
        return await handleOauthStart(req, res)
      case 'oauth-callback':
        return await handleOauthCallback(req, res)
      case 'picker-open':
        return await handlePickerOpen(req, res)
      case 'picker-token':
        return await handlePickerToken(req, res)
      case 'picker-result':
        return await handlePickerResult(req, res)
      case 'picker-poll':
        return await handlePickerPoll(req, res)
      case 'access-token':
        return await handleAccessToken(req, res)
      case 'oauth-status':
        return await handleOauthStatus(req, res)
      case 'check-pro':
        return await handleCheckPro(req, res)
      case 'oauth-disconnect':
        return await handleOauthDisconnect(req, res)
      case 'drive-storage':
        return await handleDriveStorage(req, res)
      case 'create-project':
        return await handleCreateProject(req, res)
      case 'r2-upload-init':
        return await handleR2UploadInit(req, res)
      case 'r2-upload-part-url':
        return await handleR2UploadPartUrl(req, res)
      case 'r2-upload-complete':
        return await handleR2UploadComplete(req, res)
      case 'r2-upload-abort':
        return await handleR2UploadAbort(req, res)
      case 'drive-import-init':
        return await handleDriveImportInit(req, res)
      case 'drive-import-auth':
        return await handleDriveImportAuth(req, res)
      case 'create-project-group':
        return await handleCreateProjectGroup(req, res)
      case 'add-round-to-group':
        return await handleAddRoundToGroup(req, res)
      case 'list-rounds-for-group':
        return await handleListRoundsForGroup(req, res)
      case 'list-groups-owner':
        return await handleListGroupsOwner(req, res)
      case 'firebase-custom-token':
        return await handleFirebaseCustomToken(req, res)
      case 'get-project':
        return await handleGetProject(req, res)
      case 'verify-password':
        return await handleVerifyPassword(req, res)
      case 'add-note':
        return await handleAddNote(req, res)
      case 'finalize-round':
        return await handleFinalizeRound(req, res)
      case 'list-notes':
        return await handleListNotes(req, res)
      case 'check-video-status':
        return await handleCheckVideoStatus(req, res)
      case 'delete-project':
        return await handleDeleteProject(req, res)
      case 'delete-round':
        return await handleDeleteRound(req, res)
      case 'delete-group':
        return await handleDeleteGroup(req, res)
      case 'delete-note':
        return await handleDeleteNote(req, res)
      case 'update-project':
        return await handleUpdateProject(req, res)
      case 'update-group':
        return await handleUpdateGroup(req, res)
      case 'replace-project-video':
        return await handleReplaceProjectVideo(req, res)
      case 'touch-web-seen':
        return await handleTouchWebSeen(req, res)
      case 'list-rounds-owner':
        return await handleListRoundsOwner(req, res)
      case 'list-notes-owner':
        return await handleListNotesOwner(req, res)
      case 'check-owner-email':
        return await handleCheckOwnerEmail(req, res)
      case 'owner-signin':
        return await handleOwnerSignin(req, res)
      case 'update-note-status':
        return await handleUpdateNoteStatus(req, res)
      case 'upload-note-media':
        return await handleUploadNoteMedia(req, res)
      case 'note-media-upload-url':
        return await handleNoteMediaUploadUrl(req, res)
      case 'note-media':
        return await handleNoteMedia(req, res)
      case 'note-media-owner':
        return await handleNoteMediaOwner(req, res)
      case 'note-media-url':
        return await handleNoteMediaUrl(req, res)
      case 'note-media-owner-url':
        return await handleNoteMediaOwnerUrl(req, res)
      case 'auth-media':
        return await handleAuthMedia(req, res)
      case 'admin-usage':
        return await handleAdminUsage(req, res)
      case 'client-log-ingest':
        return await handleClientLogIngest(req, res)
      case 'get-stream-token':
        return await handleGetStreamToken(req, res)
      case 'stream-video':
        return await handleStreamVideo(req, res)
      case 'auth-stream':
        return await handleAuthStream(req, res)
      default:
        return res
          .status(400)
          .json({ ok: false, error: `unknown action: ${action || '(empty)'}` })
    }
  } catch (err) {
    console.error('[revisions] dispatcher error:', err)
    return res.status(500).json({ ok: false, error: 'internal error' })
  }
}
