import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

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
const REDIRECT_URI = 'https://dm-plus.vercel.app/oauth/drive/callback'

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
  iat: number
  exp: number
}

function mintStateToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const claims: StateClaims = {
    uid,
    purpose: 'drive-oauth',
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
  const idToken = String(req.query.idToken || '').trim()
  const verified = await verifyFirebaseIdToken(idToken)
  if (!verified) {
    return res.status(401).send(errorHtml('יש להתחבר מחדש לתוכנה ולנסות שוב.'))
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) {
    return res.status(500).send(errorHtml('שירות החיבור לא מוגדר. פנו לתמיכה.'))
  }
  const state = mintStateToken(verified.uid)
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
    // `consent` forces Google to show the consent screen even if
    // the user previously approved this app — which guarantees we
    // get a fresh refresh_token. Without this, Google sometimes
    // skips the consent and returns NO refresh_token on subsequent
    // grants, leaving us stuck.
    prompt: 'consent',
    state,
    // Hint the user's email so they pick the right Google account
    // in the multi-account picker.
    login_hint: verified.email,
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

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

  // Best-effort touch — used as a "last activity" indicator in the
  // UI. Errors here don't block returning the access token.
  void integrationDocRef(verified.uid)
    .update({ lastUsedAt: Date.now() })
    .catch(() => undefined)

  return res.status(200).json({
    ok: true,
    accessToken: fresh.accessToken,
    expiresIn: fresh.expiresIn,
    email: data.email,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: oauth-status
 * ────────────────────────────────────────────────────────────── */
async function handleOauthStatus(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const snap = await integrationDocRef(verified.uid).get()
  if (!snap.exists) {
    return res.status(200).json({ ok: true, connected: false })
  }
  const data = snap.data() as IntegrationDoc
  return res.status(200).json({
    ok: true,
    connected: true,
    email: data.email,
    connectedAt: data.connectedAt,
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Action: oauth-disconnect
 * ────────────────────────────────────────────────────────────── */
async function handleOauthDisconnect(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
 *  Dispatcher
 * ────────────────────────────────────────────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = String(req.query.action || '').trim()
  try {
    switch (action) {
      case 'oauth-start':
        return await handleOauthStart(req, res)
      case 'oauth-callback':
        return await handleOauthCallback(req, res)
      case 'access-token':
        return await handleAccessToken(req, res)
      case 'oauth-status':
        return await handleOauthStatus(req, res)
      case 'oauth-disconnect':
        return await handleOauthDisconnect(req, res)
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
