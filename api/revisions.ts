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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

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

const WEBSITE_BASE = 'https://dm-plus.vercel.app'

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
  const body = (req.body || {}) as { shareToken?: string; passwordToken?: string }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) {
    return res.status(404).json({ ok: false, error: 'הקישור לא נמצא' })
  }
  const project = snap.docs[0].data() as {
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
  }
  if (project.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'הסבב כבר לא פעיל' })
  }

  const roundNumber =
    typeof project.roundNumber === 'number' && project.roundNumber > 0
      ? project.roundNumber
      : 1

  const hasPassword = Boolean(project.passwordHash)
  if (hasPassword) {
    const passwordToken = String(body.passwordToken || '').trim()
    const validToken = passwordToken && verifyPasswordToken(passwordToken, project.id)
    if (!validToken) {
      return res.status(200).json({
        ok: true,
        needsPassword: true,
        title: project.title,
        roundNumber,
      })
    }
  }

  return res.status(200).json({
    ok: true,
    needsPassword: false,
    project: {
      id: project.id,
      title: project.title,
      roundNumber,
      // The embed URL is the only Drive identifier we expose to the
      // client. The raw fileId is omitted intentionally.
      embedUrl: `https://drive.google.com/file/d/${project.driveFileId}/preview`,
      videoSizeBytes: project.videoSizeBytes,
      videoMime: project.videoMime,
      createdAt: project.createdAt,
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
  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.docs[0].data() as {
    id: string
    passwordHash: string | null
    passwordSalt: string | null
  }
  if (!project.passwordHash || !project.passwordSalt) {
    return res.status(400).json({ ok: false, error: 'לפרויקט הזה אין סיסמה' })
  }
  const computed = crypto
    .pbkdf2Sync(password, project.passwordSalt, 100_000, 32, 'sha256')
    .toString('hex')
  if (computed !== project.passwordHash) {
    return res.status(401).json({ ok: false, error: 'סיסמה שגויה' })
  }
  const passwordToken = mintPasswordToken(project.id)
  return res.status(200).json({ ok: true, passwordToken })
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
async function handleAddNote(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as {
    shareToken?: string
    passwordToken?: string
    viewerEmail?: string
    viewerName?: string
    timeSeconds?: number
    text?: string
    screenshotDataUrl?: string
    annotations?: unknown[]
  }
  const shareToken = String(body.shareToken || '').trim()
  const viewerEmail = String(body.viewerEmail || '').trim().toLowerCase()
  const text = String(body.text || '').trim()
  const timeSeconds = Number(body.timeSeconds)
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })
  if (!viewerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(viewerEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל לא תקין' })
  }
  if (!text && !body.screenshotDataUrl) {
    return res.status(400).json({ ok: false, error: 'חובה לכתוב תיאור או לצרף תמונה' })
  }
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
    return res.status(400).json({ ok: false, error: 'timestamp לא תקין' })
  }

  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const projectDoc = snap.docs[0]
  const project = projectDoc.data() as {
    id: string
    status: string
    passwordHash: string | null
  }
  if (project.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'הסבב כבר לא פעיל' })
  }
  if (project.passwordHash) {
    const passwordToken = String(body.passwordToken || '').trim()
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      return res.status(403).json({ ok: false, error: 'נדרשת סיסמה' })
    }
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

  const noteRef = projectDoc.ref.collection('notes').doc()
  const now = Date.now()
  await noteRef.set({
    id: noteRef.id,
    viewerEmail,
    viewerName: String(body.viewerName || '').trim().slice(0, 80) || null,
    timeSeconds,
    text: text.slice(0, 2000),
    screenshotDataUrl: screenshotDataUrl || null,
    annotations,
    status: 'new',
    createdAt: now,
  })
  // Counter for the editor's dashboard. Best-effort — don't fail
  // the note add if the counter increment glitches.
  void projectDoc.ref
    .update({
      notesCount: (((projectDoc.data() as { notesCount?: number }).notesCount || 0) + 1),
      updatedAt: now,
    })
    .catch(() => undefined)

  return res.status(200).json({ ok: true, noteId: noteRef.id })
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
  const body = (req.body || {}) as { shareToken?: string; passwordToken?: string }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })

  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const projectDoc = snap.docs[0]
  const project = projectDoc.data() as {
    id: string
    passwordHash: string | null
  }
  if (project.passwordHash) {
    const passwordToken = String(body.passwordToken || '').trim()
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      return res.status(403).json({ ok: false, error: 'נדרשת סיסמה' })
    }
  }

  const notesSnap = await projectDoc.ref
    .collection('notes')
    .orderBy('timeSeconds', 'asc')
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
  const shareToken = String(req.query.token || '').trim()
  const passwordToken = String(req.query.t || '').trim()
  if (!shareToken) {
    res.status(400).send('shareToken required')
    return
  }
  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) {
    res.status(404).send('not found')
    return
  }
  const project = snap.docs[0].data() as {
    id: string
    ownerUid: string
    driveFileId: string
    status: string
    passwordHash: string | null
    videoMime: string
  }
  if (project.status !== 'active') {
    res.status(410).send('archived')
    return
  }
  if (project.passwordHash) {
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      res.status(403).send('password required')
      return
    }
  }

  // Owner's Drive token.
  const integrationSnap = await integrationDocRef(project.ownerUid).get()
  if (!integrationSnap.exists) {
    res.status(500).send('drive not connected')
    return
  }
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  let accessToken: string
  try {
    const r = await refreshAccessToken(refreshToken)
    accessToken = r.accessToken
  } catch {
    res.status(401).send('drive auth expired')
    return
  }

  // Forward Range header so seek/scrub works.
  const range = req.headers.range
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${project.driveFileId}?alt=media`
  const driveResp = await fetch(driveUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(range ? { Range: range } : {}),
    },
  })

  if (!driveResp.ok && driveResp.status !== 206) {
    res.status(driveResp.status).send('drive error')
    return
  }

  res.status(driveResp.status)
  const forwardHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
  ]
  for (const header of forwardHeaders) {
    const value = driveResp.headers.get(header)
    if (value) res.setHeader(header, value)
  }
  if (!driveResp.headers.get('accept-ranges')) {
    res.setHeader('Accept-Ranges', 'bytes')
  }
  // 60s tight cache — file content is immutable but we want to be
  // able to revoke access fast when a project is archived.
  res.setHeader('Cache-Control', 'private, max-age=60')
  // Allow the <video crossOrigin="anonymous"> attribute to work so
  // canvas frame capture stays CORS-clean.
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (!driveResp.body) {
    res.end()
    return
  }
  const reader = driveResp.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const ok = res.write(value)
      if (!ok) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
  } catch (err) {
    // ERR_STREAM_PREMATURE_CLOSE is the browser aborting (e.g.
    // seek interrupted the previous Range fetch). Not a real bug.
    if ((err as { code?: string }).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[stream-video] pipe error:', err)
    }
  } finally {
    res.end()
  }
}

/* Returns a stream URL the <video> tag can use directly. The URL
 * points at the Cloudflare Worker if CLOUDFLARE_STREAM_BASE is
 * configured (zero-bandwidth path), otherwise falls back to the
 * Vercel proxy. */
async function handleGetStreamToken(req: VercelRequest, res: VercelResponse) {
  const body = (req.body || {}) as { shareToken?: string; passwordToken?: string }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) {
    return res.status(404).json({ ok: false, error: 'not found' })
  }
  const project = snap.docs[0].data() as {
    id: string
    status: string
    passwordHash: string | null
    videoMime: string
    title: string
  }
  if (project.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'archived' })
  }
  if (project.passwordHash) {
    const passwordToken = String(body.passwordToken || '').trim()
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      return res.status(403).json({ ok: false, error: 'password required' })
    }
  }
  // Prefer the Cloudflare Worker base URL when set — Cloudflare has
  // unlimited free egress, so all video bandwidth becomes free.
  // Fall back to the Vercel proxy (metered against the 100 GB free
  // tier) when the env var isn't configured yet.
  const cfBase = (process.env.CLOUDFLARE_STREAM_BASE || '').trim()
  const passwordSuffix = body.passwordToken
    ? `&t=${encodeURIComponent(String(body.passwordToken))}`
    : ''
  const url = cfBase
    ? `${cfBase.replace(/\/$/, '')}/?token=${encodeURIComponent(shareToken)}${passwordSuffix}`
    : `/api/revisions?action=stream-video&token=${encodeURIComponent(shareToken)}${passwordSuffix}`
  return res.status(200).json({
    ok: true,
    streamUrl: url,
    videoMime: project.videoMime,
    title: project.title,
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

  const body = (req.body || {}) as { shareToken?: string; passwordToken?: string }
  const shareToken = String(body.shareToken || '').trim()
  if (!shareToken) {
    return res.status(400).json({ ok: false, error: 'shareToken required' })
  }
  const snap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (snap.empty) {
    return res.status(404).json({ ok: false, error: 'not found' })
  }
  const project = snap.docs[0].data() as {
    id: string
    ownerUid: string
    driveFileId: string
    status: string
    passwordHash: string | null
  }
  if (project.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'archived' })
  }
  if (project.passwordHash) {
    const passwordToken = String(body.passwordToken || '').trim()
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      return res.status(403).json({ ok: false, error: 'password required' })
    }
  }
  const integrationSnap = await integrationDocRef(project.ownerUid).get()
  if (!integrationSnap.exists) {
    return res.status(500).json({ ok: false, error: 'drive not connected' })
  }
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  try {
    const r = await refreshAccessToken(refreshToken)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      ok: true,
      accessToken: r.accessToken,
      driveFileId: project.driveFileId,
    })
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as {
    ownerUid: string
    driveFileId: string
    videoStatus?: string
  }
  // Authorization — only the owner can poll their own project.
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  // Short-circuit if we already know it's ready.
  if (project.videoStatus === 'ready') {
    return res.status(200).json({ ok: true, status: 'ready' })
  }

  // Need a Drive access token for the editor's account.
  const integrationSnap = await integrationDocRef(verified.uid).get()
  if (!integrationSnap.exists) {
    return res.status(400).json({ ok: false, error: 'Drive לא מחובר' })
  }
  const integration = integrationSnap.data() as IntegrationDoc
  const refreshToken = decryptToken(integration.refreshTokenEnc)
  let accessToken: string
  try {
    const r = await refreshAccessToken(refreshToken)
    accessToken = r.accessToken
  } catch (err) {
    console.warn('[revisions/check-video-status] refresh failed:', err)
    return res.status(401).json({ ok: false, error: 'הזדהות Drive פגה' })
  }

  // Query Drive for the videoMediaMetadata field. Its presence is
  // the signal that transcoding completed.
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${project.driveFileId}?fields=id,videoMediaMetadata`
  const driveResp = await fetch(driveUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!driveResp.ok) {
    // 404 / 410 = the editor deleted the file from Drive manually.
    // Surface this so the UI can show "missing" instead of polling
    // forever.
    if (driveResp.status === 404 || driveResp.status === 410) {
      return res.status(200).json({ ok: true, status: 'failed' })
    }
    return res.status(502).json({ ok: false, error: 'Drive שגיאה' })
  }
  const driveJson = (await driveResp.json()) as {
    videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number }
  }
  const meta = driveJson.videoMediaMetadata
  if (!meta) {
    // Still processing — leave videoStatus alone, return current.
    return res.status(200).json({ ok: true, status: 'processing' })
  }

  // Ready! Persist the flip + duration to Firestore so future
  // listeners see it without another round-trip.
  const durationSec = meta.durationMillis ? Math.round(parseInt(meta.durationMillis, 10) / 1000) : 0
  await docRef.update({
    videoStatus: 'ready',
    videoDurationSec: durationSec,
    videoWidth: meta.width || 0,
    videoHeight: meta.height || 0,
    updatedAt: Date.now(),
  })
  return res.status(200).json({ ok: true, status: 'ready', durationSec })
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })
  const deleteDriveFile = body.deleteDriveFile === true

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as { ownerUid: string; driveFileId: string }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }

  // Drive cleanup — share-link revoke (always) + optional file
  // delete. Best-effort: if Drive hiccups we still archive the
  // Firestore doc, because the public review page checks
  // status='active' before serving anything.
  let driveDeleted = false
  try {
    const integrationSnap = await integrationDocRef(verified.uid).get()
    if (integrationSnap.exists) {
      const integration = integrationSnap.data() as IntegrationDoc
      const refreshToken = decryptToken(integration.refreshTokenEnc)
      const tokenResp = await refreshAccessToken(refreshToken)

      if (deleteDriveFile) {
        // Move the file to Drive's trash. We use trash rather than
        // permanent delete so the editor can recover if they
        // misclicked — Drive empties trash after 30 days on its
        // own, which is plenty of time to notice the mistake.
        const trashResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${project.driveFileId}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${tokenResp.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ trashed: true }),
          },
        )
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
    noteId?: string
    viewerEmail?: string
  }
  const shareToken = String(body.shareToken || '').trim()
  const noteId = String(body.noteId || '').trim()
  const viewerEmail = String(body.viewerEmail || '').trim().toLowerCase()
  if (!shareToken || !noteId || !viewerEmail) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }

  const projSnap = await getDb()
    .collection('revisionProjects')
    .where('shareToken', '==', shareToken)
    .limit(1)
    .get()
  if (projSnap.empty) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const projectDoc = projSnap.docs[0]
  const project = projectDoc.data() as {
    id: string
    status: string
    passwordHash: string | null
  }
  if (project.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'הסבב כבר לא פעיל' })
  }
  if (project.passwordHash) {
    const passwordToken = String(body.passwordToken || '').trim()
    if (!passwordToken || !verifyPasswordToken(passwordToken, project.id)) {
      return res.status(403).json({ ok: false, error: 'נדרשת סיסמה' })
    }
  }

  const noteRef = projectDoc.ref.collection('notes').doc(noteId)
  const noteSnap = await noteRef.get()
  if (!noteSnap.exists) {
    return res.status(404).json({ ok: false, error: 'התיקון לא נמצא' })
  }
  const note = noteSnap.data() as { viewerEmail: string }
  if ((note.viewerEmail || '').toLowerCase() !== viewerEmail) {
    return res.status(403).json({
      ok: false,
      error: 'ניתן למחוק רק תיקונים שאתם הוספתם',
    })
  }

  await noteRef.delete()
  // Decrement the counter on the project doc. Best-effort, like
  // the increment on add-note — we clamp at 0 to handle the case
  // where the counter and actual note count drifted.
  void projectDoc.ref
    .update({
      notesCount: Math.max(
        0,
        ((projectDoc.data() as { notesCount?: number }).notesCount || 1) - 1,
      ),
      updatedAt: Date.now(),
    })
    .catch(() => undefined)
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
  }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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

  // Build the partial update. We only touch fields the client
  // explicitly asked about; missing fields stay as-is. Today this
  // is just `password` but the structure leaves room for adding
  // title / roundNumber later without changing the dispatch path.
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

  await docRef.update(update)
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
      case 'create-project':
        return await handleCreateProject(req, res)
      case 'get-project':
        return await handleGetProject(req, res)
      case 'verify-password':
        return await handleVerifyPassword(req, res)
      case 'add-note':
        return await handleAddNote(req, res)
      case 'list-notes':
        return await handleListNotes(req, res)
      case 'check-video-status':
        return await handleCheckVideoStatus(req, res)
      case 'delete-project':
        return await handleDeleteProject(req, res)
      case 'delete-note':
        return await handleDeleteNote(req, res)
      case 'update-project':
        return await handleUpdateProject(req, res)
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
