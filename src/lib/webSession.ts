/**
 * Browser-side session + auth client for the /revisions workspace.
 *
 * The website deliberately does NOT ship Firebase Web SDK to keep
 * the bundle slim (~100kb saved); instead, all auth flows run
 * server-side via /api/paypal?action=... and the result is a
 * custom HMAC-signed session JWT stored in sessionStorage. This
 * module wraps every action the workspace needs:
 *
 *   - signIn(email, password)
 *   - requestSignupCode(email)         → step 1 of 2 in signup
 *   - verifySignupCode(email, code, …) → step 2 of 2 in signup
 *   - requestPasswordReset(email)
 *   - redeemProductKey(key)
 *   - getStatus()                      → /api/paypal?action=status
 *   - signOut()
 *
 * Plus reactive plumbing:
 *
 *   - getSession()       → snapshot the cached session (null if out)
 *   - subscribeSession() → fire on signin / signout / token refresh
 *
 * The session token is the same one /account uses (key
 * `dmplus.session.v1` in sessionStorage), so a user who already
 * signed in via /account stays signed in when they navigate to
 * /revisions and vice versa.
 */

import { getStoredRef } from './referral'

/** sessionStorage key — MUST match the one used by AccountPage and
 *  BuyPage so a sign-in done on either /account or /buy carries
 *  over to /revisions without a second login. */
export const SESSION_STORAGE_KEY = 'dmplus.session.v1'

/** Decoded session JWT shape we read on the client for display.
 *  Mirrors paypal.ts → SessionClaims. We don't verify the
 *  signature client-side (server does that on every API call);
 *  this is purely for "who's logged in" UI affordances. */
export interface DecodedSession {
  uid: string
  email: string
  subscriptionIds: string[]
  exp: number
}

/** Cached snapshot of the most-recently-stored session token +
 *  decoded claims. Hydrated synchronously from sessionStorage on
 *  module load so the first React render doesn't flash a logged-
 *  out state for a user who's already signed in. */
let cached: { token: string; claims: DecodedSession } | null = (() => {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const claims = decodeJwtClaims(raw)
    if (!claims) {
      // Stale / malformed token — wipe so future reads don't keep
      // tripping the same check.
      try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY)
      } catch {
        // sessionStorage can throw in private-browsing mode on some
        // browsers — swallow.
      }
      return null
    }
    return { token: raw, claims }
  } catch {
    return null
  }
})()

const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn('[webSession] listener threw:', err)
    }
  }
}

/** Subscribe to session changes (signin / signout / token refresh).
 *  Returns an unsubscribe function — call it from a useEffect
 *  cleanup. The callback receives no args; pull the current state
 *  via getSession() inside the callback. */
export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Snapshot of the active session. Returns null when signed out.
 *  Synchronous — backed by an in-memory cache so React hooks can
 *  read it during render without triggering a state-update
 *  warning. */
export function getSession(): { token: string; claims: DecodedSession } | null {
  hydrateFromStorage()
  return cached
}

/** Raw session token, or null. Shorthand for the most common
 *  consumer (API clients that need to send `sessionToken` in the
 *  request body). */
export function getSessionToken(): string | null {
  hydrateFromStorage()
  return cached?.token ?? null
}

/** Re-sync the in-memory cache from sessionStorage when it's empty.
 *
 *  WHY: `cached` is hydrated once at module load. But AccountPage
 *  writes the session token DIRECTLY to sessionStorage (same key)
 *  after a login/SSO, bypassing adoptToken — so this module's cache
 *  never learns about it. On desktop the session was usually already
 *  in storage at load (cache warm), but on mobile a user who logs in
 *  during the page session leaves `cached` stale-null, so
 *  getSessionToken() returned null and "redeem key" wrongly said
 *  "you must log in". Re-reading storage here closes that gap. We
 *  only re-read when cached is null (fast path stays in-memory), and
 *  signOut() clears storage too so this can't resurrect a dead
 *  session. */
function hydrateFromStorage(): void {
  if (cached) return
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return
    const claims = decodeJwtClaims(raw)
    if (claims) cached = { token: raw, claims }
  } catch {
    /* private browsing / storage disabled — nothing to recover */
  }
}

/** Wipe the session locally AND notify other tabs / hooks. We
 *  don't call a server "logout" endpoint because the session JWT
 *  is stateless (verify-only on the server); dropping it client-
 *  side is enough to revoke access from this device. */
export function signOut(): void {
  cached = null
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
    // Clear the once-per-session "web seen" guard so the NEXT login
    // re-stamps lastSeenWebAt (each login = a fresh entrance).
    sessionStorage.removeItem('dmplus.webseen.v1')
  } catch {
    // ignore — private browsing
  }
  emit()
}

/** Internal: persist a freshly-issued token, decode it, update
 *  the cache, fire listeners. Used by signIn and the signup-
 *  verification flow once it auto-logs the user in. */
function adoptToken(token: string): DecodedSession {
  const claims = decodeJwtClaims(token)
  if (!claims) throw new Error('Server returned an invalid session token')
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, token)
  } catch {
    // private browsing — token still lives in memory for this tab
  }
  cached = { token, claims }
  emit()
  // Stamp the website "last seen" once per session on login / signup
  // auto-login. Inlined (not imported from revisionsApi) to avoid a
  // circular import; shares the same sessionStorage guard key so it
  // and the revisions-workspace ping fire at most once together.
  try {
    if (!sessionStorage.getItem('dmplus.webseen.v1')) {
      sessionStorage.setItem('dmplus.webseen.v1', '1')
      void fetch('/api/revisions?action=touch-web-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'touch-web-seen', sessionToken: token }),
      }).catch(() => undefined)
    }
  } catch {
    /* ignore */
  }
  return claims
}

/* ──────────────────────────────────────────────────────────────
 *  JWT decode (claims only — no signature check)
 * ────────────────────────────────────────────────────────────── */

function decodeJwtClaims(token: string): DecodedSession | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payloadB64.padEnd(
      payloadB64.length + ((4 - (payloadB64.length % 4)) % 4),
      '=',
    )
    // atob is available in all browsers; produces a binary string we
    // then decode as UTF-8 via TextDecoder for non-ASCII safety.
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const json = new TextDecoder('utf-8').decode(bytes)
    const obj = JSON.parse(json) as Record<string, unknown>
    if (typeof obj.uid !== 'string' || !obj.uid) return null
    if (typeof obj.email !== 'string' || !obj.email) return null
    const exp = typeof obj.exp === 'number' ? obj.exp : 0
    if (exp && exp * 1000 < Date.now()) return null
    return {
      uid: obj.uid,
      email: String(obj.email).toLowerCase(),
      subscriptionIds: Array.isArray(obj.subscriptionIds)
        ? (obj.subscriptionIds as string[])
        : [],
      exp,
    }
  } catch {
    return null
  }
}

/* ──────────────────────────────────────────────────────────────
 *  API client — talks to /api/paypal and /api/keys/redeem
 * ────────────────────────────────────────────────────────────── */

const PAYPAL_API = '/api/paypal'
const REDEEM_API = '/api/keys/redeem'

interface ApiOk<T> {
  ok: true
  result: T
}
interface ApiErr {
  ok: false
  error: string
  status?: number
}
type ApiResult<T> = ApiOk<T> | ApiErr

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  let r: Response
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    // Network failure — be explicit so the UI can surface a
    // "check your connection" hint rather than the generic message
    // we use for server errors.
    return { ok: false, error: 'בעיית רשת — בדקו את החיבור ונסו שוב' }
  }
  let json: unknown
  try {
    json = await r.json()
  } catch {
    return {
      ok: false,
      error: `שגיאת שרת לא צפויה (${r.status})`,
      status: r.status,
    }
  }
  const data = json as { ok?: boolean; error?: string } & Record<string, unknown>
  if (!data || data.ok !== true) {
    return {
      ok: false,
      error: data?.error || `שגיאה (${r.status})`,
      status: r.status,
    }
  }
  return { ok: true, result: data as T }
}

/** Tell the browser's password manager to offer saving these
 *  credentials. Must be called from a component that has access
 *  to the actual <form> DOM element — passing the form to
 *  `PasswordCredential` is what makes Chrome detect this as a
 *  real submission and trigger the save bubble. The earlier
 *  attempt to pass `{id, password}` literals stored the
 *  credential silently in some scenarios but did not show the
 *  prompt.
 *
 *  This function ALSO calls history.replaceState to emulate a
 *  navigation — Chromium docs explicitly call out that the
 *  password-save heuristic for fetch-based logins requires
 *  either a real page nav OR a synthetic pushState/replaceState
 *  PLUS the form being removed from the DOM. The caller is
 *  responsible for unmounting the form (typically via the same
 *  React state change that mounted the post-login UI).
 *
 *  Source: https://www.chromium.org/developers/design-documents/create-amazing-password-forms/ */
export async function offerCredentialSave(
  form: HTMLFormElement | null,
): Promise<void> {
  if (!form) return
  try {
    const PC = (
      window as unknown as {
        PasswordCredential?: new (form: HTMLFormElement) => Credential
      }
    ).PasswordCredential
    if (!PC) return
    if (!navigator.credentials || !navigator.credentials.store) return
    const cred = new PC(form)
    await navigator.credentials.store(cred)
  } catch {
    // Browser doesn't support the Credential Management API, or the
    // user dismissed the prompt — nothing to do, the login still
    // succeeded.
  }
  try {
    const here = window.location.pathname + window.location.search
    window.history.replaceState(window.history.state, '', here)
  } catch {
    /* replaceState blocked — harmless, the save heuristic is best-effort */
  }
}

/** Sign in with email + password. Adopts the returned session
 *  token on success. The returned claims are also stored for
 *  consumers to read via getSession().
 *
 *  Wire shape note: paypal.ts → handleSession returns the JWT in
 *  a field called `token` (NOT `sessionToken` — that's the body
 *  field name used by the newer revisions / redeem endpoints).
 *  Keep both names in mind: server SENDS `token`, our /revisions
 *  + /redeem code RECEIVES `sessionToken`.
 *
 *  Does NOT call offerCredentialSave automatically — the form
 *  element lives in the component, not here. Caller is
 *  responsible for the credential save after this resolves
 *  successfully. */
export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: true; claims: DecodedSession } | { ok: false; error: string }> {
  const r = await postJson<{ token: string; email?: string }>(PAYPAL_API, {
    action: 'session',
    email: email.trim().toLowerCase(),
    password,
  })
  if (!r.ok) return { ok: false, error: r.error }
  const token = String(r.result.token || '')
  if (!token) {
    return { ok: false, error: 'השרת לא החזיר token תקין' }
  }
  try {
    const claims = adoptToken(token)
    return { ok: true, claims }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : 'אסימון לא תקין מהשרת',
    }
  }
}

/** Step 1/2 of signup — server emails a 6-digit code to `email`
 *  that the user must echo back via verifySignupCode. No Firebase
 *  user is created yet at this step. Rate-limited server-side
 *  (5/hour per email, 30/hour per IP). */
export async function requestSignupCode(
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<unknown>(PAYPAL_API, {
    action: 'signup-request-code',
    email: email.trim().toLowerCase(),
  })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

/** Step 2/2 of signup — submit the code + a chosen password. On
 *  success the Firebase user is created with `emailVerified: true`
 *  (the code itself proved control of the inbox). This call does
 *  NOT issue a session token, so we follow it up with a signIn()
 *  to get the user straight into the workspace. */
export async function verifySignupCode(args: {
  email: string
  code: string
  password: string
  name?: string
  marketingOptIn?: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ alreadyExisted?: boolean }>(PAYPAL_API, {
    action: 'signup-verify-code',
    email: args.email.trim().toLowerCase(),
    code: args.code.trim(),
    password: args.password,
    name: args.name?.trim() || undefined,
    marketingOptIn: args.marketingOptIn === true,
    // Partner attribution: if this visitor arrived via a ?ref link,
    // stamp the new account so later purchases credit the partner.
    ref: getStoredRef(),
  })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true }
}

/** Trigger a password-reset email. The reset link lands on
 *  /auth-action?mode=resetPassword — the same flow /account uses,
 *  so the page already exists. */
export async function requestPasswordReset(
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let r: Response
  try {
    r = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    })
  } catch {
    return { ok: false, error: 'בעיית רשת — בדקו את החיבור ונסו שוב' }
  }
  const data = (await r.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
  }
  if (!data?.ok) {
    return { ok: false, error: data?.error || 'שליחת המייל נכשלה' }
  }
  return { ok: true }
}

/** Redeem a XXXX-XXXX-XXXX-XXXX product key for the logged-in
 *  user's account. The server side accepts both Firebase ID tokens
 *  (desktop) and our session JWT (web) — we send the session JWT
 *  here. On success, the user becomes Pro immediately. The caller
 *  should re-fetch entitlement status after this resolves. */
export async function redeemProductKey(
  key: string,
): Promise<
  | {
      ok: true
      tier: 'pro'
      expiresAt: string | null
      keyId: string
      replacedKeys: string[]
    }
  | { ok: false; error: string }
> {
  const token = getSessionToken()
  if (!token) return { ok: false, error: 'יש להתחבר לפני הפעלת מפתח' }
  const r = await postJson<{
    tier: 'pro'
    expiresAt: string | null
    keyId: string
    replacedKeys: string[]
  }>(REDEEM_API, {
    sessionToken: token,
    key: key.trim().toUpperCase(),
  })
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    tier: r.result.tier,
    expiresAt: r.result.expiresAt,
    keyId: r.result.keyId,
    replacedKeys: r.result.replacedKeys,
  }
}

/** Entitlement snapshot for the signed-in user. We deliberately
 *  ask the revisions endpoint (which uses isUserPro) rather than
 *  the /paypal?action=status one — that one only knows about
 *  PayPal subscriptions and would falsely report not-Pro for
 *  users who became Pro via a redeemed product key, an active
 *  trial, an admin role, or the betaMode global. */
export interface AccountStatus {
  ok: true
  hasPro: boolean
}

/** Fetch the canonical Pro-entitlement state from the server.
 *  Returns null on transient failures so the caller can show a
 *  retry button instead of incorrectly displaying "not Pro" — we
 *  never want to demote a paying user because of a one-off
 *  network blip. The server itself is fail-closed: if it can't
 *  verify entitlement it sends 503 and we fall through to null.
 *
 *  401 path is treated differently from 5xx: it means the session
 *  token is no longer valid (expired, rotated secret, or wiped on
 *  the server). We clear the local session synchronously and fire
 *  listeners — this re-renders the page into the AuthShell instead
 *  of stranding the user on a "transient error" card that retries
 *  forever against an authoritatively-rejected token. */
export async function fetchAccountStatus(): Promise<AccountStatus | null> {
  const token = getSessionToken()
  if (!token) return null
  let r: Response
  try {
    r = await fetch('/api/revisions?action=check-pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token }),
    })
  } catch {
    return null
  }
  if (r.status === 401 || r.status === 403) {
    // Server explicitly rejected our token. Don't keep showing the
    // user as "signed in" while every API call fails — wipe the
    // bad token so the next render falls back to the login form.
    signOut()
    return null
  }
  if (!r.ok) return null
  const data = (await r.json().catch(() => null)) as
    | { ok: true; isPro: boolean }
    | { ok: false }
    | null
  if (!data || data.ok !== true) return null
  return { ok: true, hasPro: data.isPro === true }
}
