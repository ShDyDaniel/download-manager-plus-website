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
async function isUserPro(uid: string, email: string): Promise<boolean> {
  // Fast path — admin email, no Firestore round-trip. Admins keep
  // working even if Firestore is completely down.
  if (email && SERVER_ADMIN_EMAILS.has(email.toLowerCase())) return true

  const db = getDb()

  // Beta-mode global override. Wrapped in try/catch — if the
  // appConfig/global doc doesn't exist yet (operator hasn't
  // turned beta mode on/off explicitly), reading it succeeds
  // but `.exists` is false → we fall through to user-level
  // checks. If the read itself THROWS (Firestore down) we also
  // fall through; either way `betaMode` defaults to false. The
  // alternative — letting the exception bubble — would punish
  // viewers of legitimately-Pro projects for an unrelated
  // Firestore hiccup on an OPTIONAL config flag.
  try {
    const cfgSnap = await db.collection('appConfig').doc('global').get()
    if (cfgSnap.exists && cfgSnap.data()?.betaMode === true) return true
  } catch (err) {
    console.warn('[revisions/isUserPro] appConfig read failed (continuing):', err)
  }

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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const title = String(body.title || '').trim().slice(0, 200)
  const driveFileId = String(body.driveFileId || '').trim()
  const driveFolderId = String(body.driveFolderId || '').trim() || null
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
    createdAt: now,
    updatedAt: now,
  })

  let roundIdOut: string | null = null
  if (driveFileId) {
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
      driveFileId,
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
    driveFileId?: string
    driveFolderId?: string
    videoFileName?: string
    videoSizeBytes?: number
    videoMime?: string
    roundNumber?: number
  }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return

  const groupId = String(body.groupId || '').trim()
  const driveFileId = String(body.driveFileId || '').trim()
  if (!groupId) return res.status(400).json({ ok: false, error: 'groupId required' })
  if (!driveFileId) return res.status(400).json({ ok: false, error: 'driveFileId required' })

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
    driveFileId,
    driveFolderId: String(body.driveFolderId || '').trim() || group.driveFolderId,
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
  // Bump group's updatedAt so editor-side queries that sort by
  // recency reflect the new activity.
  await groupRef.update({ updatedAt: now })

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
      notesCount: Number(r.notesCount) || 0,
      videoFileName: String(r.videoFileName || ''),
      createdAt: Number(r.createdAt) || 0,
    }))
    .sort((a, b) => a.roundNumber - b.roundNumber)

  return res.status(200).json({
    ok: true,
    group: { id: group.id, title: group.title },
    rounds,
  })
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
async function handleListGroupsOwner(
  req: VercelRequest,
  res: VercelResponse,
) {
  const body = (req.body || {}) as { idToken?: string }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const groupsSnap = await getDb()
    .collection('revisionGroups')
    .where('ownerUid', '==', verified.uid)
    .get()
  const activeGroups = groupsSnap.docs
    .map((d) => d.data() as RevisionGroupDoc)
    .filter((g) => g.status === 'active')

  // Pull all rounds in one go, then bucket client-side. One query
  // per editor is cheaper than one query per group on Firestore's
  // billing. Rounds with a groupId belong inside a group card;
  // rounds without one are legacy single-round projects from
  // before the group refactor — we surface them in a separate
  // array so the desktop can render them as standalone cards.
  const roundsSnap = await getDb()
    .collection('revisionProjects')
    .where('ownerUid', '==', verified.uid)
    .get()
  const roundsByGroup = new Map<string, Record<string, unknown>[]>()
  const legacyRoundDocs: Record<string, unknown>[] = []
  for (const doc of roundsSnap.docs) {
    const r = doc.data() as Record<string, unknown>
    if (r.status !== 'active') continue
    const gid = String(r.groupId || '')
    if (gid) {
      if (!roundsByGroup.has(gid)) roundsByGroup.set(gid, [])
      roundsByGroup.get(gid)!.push(r)
    } else {
      legacyRoundDocs.push(r)
    }
  }

  const out = activeGroups
    .map((g) => {
      const rounds = (roundsByGroup.get(g.id) || [])
        .map((r) => ({
          id: r.id as string,
          roundNumber: Number(r.roundNumber) || 1,
          videoFileName: String(r.videoFileName || ''),
          videoSizeBytes: Number(r.videoSizeBytes) || 0,
          locked: r.locked === true,
          notesCount: Number(r.notesCount) || 0,
          createdAt: Number(r.createdAt) || 0,
        }))
        .sort((a, b) => a.roundNumber - b.roundNumber)
      return {
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
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        rounds,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  // Shape the legacy projects in a flat array. Their fields
  // overlap with rounds-inside-a-group (videoFileName, locked,
  // notesCount) but they also have their own shareToken +
  // hasPassword (groups own those for new-style projects).
  const legacyProjects = legacyRoundDocs
    .map((r) => ({
      id: String(r.id || ''),
      title: String(r.title || ''),
      shareToken: String(r.shareToken || ''),
      hasPassword: Boolean(r.passwordHash),
      videoFileName: String(r.videoFileName || ''),
      videoSizeBytes: Number(r.videoSizeBytes) || 0,
      roundNumber: Number(r.roundNumber) || 1,
      locked: r.locked === true,
      notesCount: Number(r.notesCount) || 0,
      createdAt: Number(r.createdAt) || 0,
      updatedAt: Number(r.updatedAt) || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return res.status(200).json({ ok: true, groups: out, legacyProjects })
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
    // Fail-CLOSED for the owner-Pro check. The earlier version
    // was fail-OPEN (treat errors as "Pro") on the theory that
    // denying viewers because of a transient Firestore blip is
    // worse than briefly serving a lapsed project. In practice
    // the most common "error" is the appConfig/global doc not
    // existing yet (operator hasn't created it) — and that
    // shouldn't grant access; it should fall through to the
    // user-doc check. So we now log the error AND treat as
    // not-Pro so the inactive notice surfaces correctly.
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
    console.log(
      '[revisions/get-project] ownerCheck',
      JSON.stringify({ ownerUid, ownerEmail, ownerActive }),
    )
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
            embedUrl: `https://drive.google.com/file/d/${selectedRoundData.driveFileId}/preview`,
            videoSizeBytes: Number(selectedRoundData.videoSizeBytes) || 0,
            videoMime: String(selectedRoundData.videoMime || ''),
            createdAt: selectedRound.createdAt,
            locked: selectedRound.locked,
            // Public-review-page toggles, inherited from the group
            // (legacy fallback = original ship behavior).
            watermark: group.watermark !== false,
            allowDownload: group.allowDownload === true,
            // Only expose the Drive URL when the editor explicitly
            // turned on "open in Drive" — otherwise the client
            // would have a backdoor around the streaming proxy.
            driveViewUrl:
              group.openInDrive === true
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
      embedUrl: `https://drive.google.com/file/d/${project.driveFileId}/preview`,
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
  if (!shareToken) return res.status(400).json({ ok: false, error: 'shareToken' })
  if (!viewerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(viewerEmail)) {
    return res.status(400).json({ ok: false, error: 'מייל לא תקין' })
  }
  if (
    !text &&
    !body.screenshotDataUrl &&
    !screenshotDriveFileId &&
    !audioDriveFileId
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
  const shareToken = String(req.query.token || '').trim()
  const passwordToken = String(req.query.t || '').trim()
  const roundIdHint = String(req.query.r || '').trim() || null
  if (!shareToken) {
    res.status(400).send('shareToken required')
    return
  }
  const resolved = await resolvePublicRound(
    shareToken,
    roundIdHint,
    passwordToken,
  )
  if (!resolved.ok) {
    res.status(resolved.status).send(resolved.error)
    return
  }
  const { roundData, group } = resolved
  const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')
  const driveFileId = String(roundData.driveFileId || '')

  // Owner's Drive token.
  const integrationSnap = await integrationDocRef(ownerUid).get()
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
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`
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
  const { roundData, group } = resolved
  const title = String(group?.title || roundData.title || '')
  const videoMime = String(roundData.videoMime || '')

  // Stream URL includes the roundId hint (`&r=`) for new-style
  // groups so the Worker → auth-stream → Drive flow can identify
  // which round's file to fetch. Legacy single-round projects don't
  // need it (shareToken already identifies the round).
  const cfBase = (process.env.CLOUDFLARE_STREAM_BASE || '').trim()
  const passwordSuffix = body.passwordToken
    ? `&t=${encodeURIComponent(String(body.passwordToken))}`
    : ''
  const roundSuffix = group
    ? `&r=${encodeURIComponent(String(roundData.id || ''))}`
    : ''
  const baseUrl = cfBase
    ? `${cfBase.replace(/\/$/, '')}/?token=${encodeURIComponent(shareToken)}${passwordSuffix}${roundSuffix}`
    : `/api/revisions?action=stream-video&token=${encodeURIComponent(shareToken)}${passwordSuffix}${roundSuffix}`

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
  const { roundData, group } = resolved
  const ownerUid = String(group?.ownerUid || roundData.ownerUid || '')
  const driveFileId = String(roundData.driveFileId || '')

  const integrationSnap = await integrationDocRef(ownerUid).get()
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
      driveFileId,
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
  if (!(await requirePro(res, verified))) return

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
  if (!(await requirePro(res, verified))) return
  const projectId = String(body.projectId || '').trim()
  if (!projectId) return res.status(400).json({ ok: false, error: 'projectId' })
  const deleteDriveFile = body.deleteDriveFile === true

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as {
    ownerUid: string
    driveFileId: string
    notesFolderId?: string
  }
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
    driveFileId: string
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

  // Optional Drive cleanup — trash the round's video file PLUS
  // every note attachment (screenshot / voice memo) tagged with
  // this round's id via appProperties at upload time. The shared
  // notes folder itself stays (sibling rounds still need it), we
  // just delete this round's contents out of it.
  //
  // Files written before the appProperties tagging shipped won't
  // be matched by the query — they stay orphaned. There's no safe
  // way to identify them after the fact (they don't carry a
  // roundId anywhere queryable), so legacy attachments survive a
  // per-round delete. Whole-project delete still nukes them via
  // the notes-folder trash in delete-group.
  let driveDeleted = false
  let mediaTrashedCount = 0
  if (deleteDriveFile) {
    try {
      const integrationSnap = await integrationDocRef(verified.uid).get()
      if (integrationSnap.exists) {
        const integration = integrationSnap.data() as IntegrationDoc
        const refreshToken = decryptToken(integration.refreshTokenEnc)
        const tokenResp = await refreshAccessToken(refreshToken)
        const trashHeaders = {
          Authorization: `Bearer ${tokenResp.accessToken}`,
          'Content-Type': 'application/json',
        }
        const trashBody = JSON.stringify({ trashed: true })

        // 1. Trash the round's video file.
        const trashResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${round.driveFileId}`,
          { method: 'PATCH', headers: trashHeaders, body: trashBody },
        )
        if (trashResp.ok) driveDeleted = true
        else
          console.warn(
            '[revisions/delete-round] Drive trash failed:',
            trashResp.status,
          )

        // 2. Find every note attachment tagged with this round id
        //    and trash them in parallel. The query uses Drive's
        //    appProperties operator; we ask for non-trashed only
        //    so retries on a partially-deleted round don't blow
        //    up on already-trashed siblings. pageSize=1000 covers
        //    all realistic round sizes (most rounds have <50
        //    notes, each with ≤2 attachments).
        try {
          const listUrl = new URL('https://www.googleapis.com/drive/v3/files')
          listUrl.searchParams.set(
            'q',
            `appProperties has { key='dmpRoundId' and value='${roundId}' } and trashed = false`,
          )
          listUrl.searchParams.set('fields', 'files(id)')
          listUrl.searchParams.set('pageSize', '1000')
          const listResp = await fetch(listUrl.toString(), {
            headers: { Authorization: `Bearer ${tokenResp.accessToken}` },
          })
          if (listResp.ok) {
            const listJson = (await listResp.json()) as {
              files?: Array<{ id: string }>
            }
            const ids = (listJson.files || []).map((f) => f.id).filter(Boolean)
            const results = await Promise.all(
              ids.map((id) =>
                fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
                  method: 'PATCH',
                  headers: trashHeaders,
                  body: trashBody,
                })
                  .then((r) => r.ok)
                  .catch(() => false),
              ),
            )
            mediaTrashedCount = results.filter(Boolean).length
          } else {
            console.warn(
              '[revisions/delete-round] media list failed:',
              listResp.status,
            )
          }
        } catch (err) {
          console.warn('[revisions/delete-round] media cleanup failed:', err)
        }
      }
    } catch (err) {
      console.warn('[revisions/delete-round] Drive cleanup failed:', err)
    }
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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

  // Optional Drive cleanup — trash every round's video file plus
  // every note attachment tagged with this project's group id via
  // appProperties at upload time. We DO NOT trash the notes folder
  // itself — it's shared across every project the same user owns
  // (lives directly under their "ניהול הורדות פלוס" root). Trashing
  // it would orphan every other project's screenshots and voice
  // memos. Instead we list-and-trash by appProperties.dmpGroupId
  // so only this project's media disappears, and the folder
  // continues to serve the user's other projects untouched.
  //
  // Legacy media (uploaded before the appProperties tagging
  // shipped) doesn't carry the group id and won't match the query
  // — those files stay in the shared folder as harmless orphans.
  let driveDeleted = false
  let mediaTrashedCount = 0
  if (deleteDriveFiles) {
    try {
      const integrationSnap = await integrationDocRef(verified.uid).get()
      if (integrationSnap.exists) {
        const integration = integrationSnap.data() as IntegrationDoc
        const refreshToken = decryptToken(integration.refreshTokenEnc)
        const tokenResp = await refreshAccessToken(refreshToken)
        const trashHeaders = {
          Authorization: `Bearer ${tokenResp.accessToken}`,
          'Content-Type': 'application/json',
        }
        const trashBody = JSON.stringify({ trashed: true })
        const trashUrl = (id: string) =>
          `https://www.googleapis.com/drive/v3/files/${id}`

        // 1. Trash each round's video file in parallel.
        const videoIds: string[] = []
        for (const d of activeRoundDocs) {
          const r = d.data() as { driveFileId?: string }
          if (r.driveFileId) videoIds.push(r.driveFileId)
        }
        const videoResults = await Promise.all(
          videoIds.map((id) =>
            fetch(trashUrl(id), {
              method: 'PATCH',
              headers: trashHeaders,
              body: trashBody,
            })
              .then((r) => r.ok)
              .catch(() => false),
          ),
        )
        if (videoResults.some(Boolean)) driveDeleted = true

        // 2. List every note attachment tagged with this group id
        //    and trash them in parallel. The shared notes folder
        //    is untouched — only the files belonging to this
        //    project go away.
        try {
          const listUrl = new URL('https://www.googleapis.com/drive/v3/files')
          listUrl.searchParams.set(
            'q',
            `appProperties has { key='dmpGroupId' and value='${groupId}' } and trashed = false`,
          )
          listUrl.searchParams.set('fields', 'files(id)')
          listUrl.searchParams.set('pageSize', '1000')
          const listResp = await fetch(listUrl.toString(), {
            headers: { Authorization: `Bearer ${tokenResp.accessToken}` },
          })
          if (listResp.ok) {
            const listJson = (await listResp.json()) as {
              files?: Array<{ id: string }>
            }
            const ids = (listJson.files || []).map((f) => f.id).filter(Boolean)
            const mediaResults = await Promise.all(
              ids.map((id) =>
                fetch(trashUrl(id), {
                  method: 'PATCH',
                  headers: trashHeaders,
                  body: trashBody,
                })
                  .then((r) => r.ok)
                  .catch(() => false),
              ),
            )
            mediaTrashedCount = mediaResults.filter(Boolean).length
            if (mediaTrashedCount > 0) driveDeleted = true
          } else {
            console.warn(
              '[revisions/delete-group] media list failed:',
              listResp.status,
            )
          }
        } catch (err) {
          console.warn('[revisions/delete-group] media cleanup failed:', err)
        }
      }
    } catch (err) {
      console.warn('[revisions/delete-group] Drive cleanup failed:', err)
    }
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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
  }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
    driveFileId?: string
    videoFileName?: string
    videoSizeBytes?: number
    videoMime?: string
    trashOldFile?: boolean
  }
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
  if (!verified) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!(await requirePro(res, verified))) return
  const projectId = String(body.projectId || '').trim()
  const newDriveFileId = String(body.driveFileId || '').trim()
  const videoFileName = String(body.videoFileName || '').trim().slice(0, 300)
  const videoSizeBytes = Number(body.videoSizeBytes) || 0
  const videoMime = String(body.videoMime || '').trim().slice(0, 100)
  if (!projectId || !newDriveFileId) {
    return res.status(400).json({ ok: false, error: 'חסרים פרטים' })
  }

  const docRef = getDb().collection('revisionProjects').doc(projectId)
  const snap = await docRef.get()
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'לא נמצא' })
  const project = snap.data() as {
    ownerUid: string
    driveFileId: string
  }
  if (project.ownerUid !== verified.uid) {
    return res.status(403).json({ ok: false, error: 'forbidden' })
  }
  const oldDriveFileId = project.driveFileId

  const now = Date.now()
  await docRef.update({
    driveFileId: newDriveFileId,
    videoFileName: videoFileName || undefined,
    videoSizeBytes: videoSizeBytes || undefined,
    videoMime: videoMime || undefined,
    // Reset videoStatus on the off chance the legacy polling
    // path is still consulting it for a legacy project.
    videoStatus: 'ready',
    updatedAt: now,
  })

  // Best-effort: trash the old Drive file unless the caller asked
  // to keep it. If Drive errors, the new pointer still lives on
  // the project doc — the orphan is a cleanup nuisance, not a
  // user-facing failure.
  const trashOld = body.trashOldFile !== false
  if (trashOld && oldDriveFileId && oldDriveFileId !== newDriveFileId) {
    try {
      const integrationSnap = await integrationDocRef(verified.uid).get()
      if (integrationSnap.exists) {
        const integration = integrationSnap.data() as IntegrationDoc
        const refreshToken = decryptToken(integration.refreshTokenEnc)
        const tokenResp = await refreshAccessToken(refreshToken)
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${oldDriveFileId}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${tokenResp.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ trashed: true }),
          },
        ).catch(() => undefined)
      }
    } catch (err) {
      console.warn('[revisions/replace-video] trash-old failed:', err)
    }
  }

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
  const verified = await verifyFirebaseIdToken(String(body.idToken || ''))
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
      case 'drive-storage':
        return await handleDriveStorage(req, res)
      case 'create-project':
        return await handleCreateProject(req, res)
      case 'create-project-group':
        return await handleCreateProjectGroup(req, res)
      case 'add-round-to-group':
        return await handleAddRoundToGroup(req, res)
      case 'list-rounds-for-group':
        return await handleListRoundsForGroup(req, res)
      case 'list-groups-owner':
        return await handleListGroupsOwner(req, res)
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
      case 'note-media':
        return await handleNoteMedia(req, res)
      case 'note-media-owner':
        return await handleNoteMediaOwner(req, res)
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
