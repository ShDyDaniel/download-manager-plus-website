import {
  signInWithEmailAndPassword,
  signOut as fbSignOut,
} from 'firebase/auth'
import { getClientAuth } from './firebaseClient'

/**
 * Client helpers for the website /admin panel.
 *
 * Auth model (two factors):
 *   1. Firebase email/password sign-in → a real Firebase `idToken`.
 *      This is the SAME token every admin endpoint already verifies
 *      (verifyIdToken → email ∈ ADMIN_EMAILS), so the desktop and the
 *      web admin share one server-side gate.
 *   2. An email code (admin-2fa-request / admin-2fa-verify) → a
 *      short-lived `adminToken` (HMAC JWT, use:'admin', 12h). Stored
 *      in sessionStorage so it dies when the tab closes.
 *
 * Every data call sends BOTH tokens; the server's verifyAdmin2FA()
 * requires both, so the email code is a real boundary — not just a
 * UI gate. The Firebase session itself persists across refreshes
 * (Firebase handles that); the 2FA token does not.
 */

const ADMIN_TOKEN_KEY = 'dmplus.admin.v1'
// The secret access key lives in localStorage (persists across tabs +
// restarts on this trusted device) so the operator only has to open
// the special link once per device.
const GATE_KEY = 'dmplus.admin.gate.v1'
// The step-up token + its expiry. sessionStorage (dies with the tab)
// because it's a short-lived per-action re-verification, never a
// long-term credential.
const STEPUP_TOKEN_KEY = 'dmplus.admin.stepup.v1'
const STEPUP_EXP_KEY = 'dmplus.admin.stepup.exp.v1'

export function getStoredAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY)
}
export function storeAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
}
export function clearAdminToken(): void {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY)
  clearStepUpToken()
}

export function getGateKey(): string {
  try {
    return localStorage.getItem(GATE_KEY) || ''
  } catch {
    return ''
  }
}
export function storeGateKey(key: string): void {
  try {
    localStorage.setItem(GATE_KEY, key)
  } catch {
    /* ignore */
  }
}

/** Pull the secret key out of the URL (`#k=…` preferred — fragments
 *  never reach the server; `?k=…` also accepted), persist it, then
 *  scrub it from the address bar so it doesn't linger in history. */
export function captureGateKeyFromUrl(): void {
  try {
    const hash = window.location.hash || ''
    const search = window.location.search || ''
    let key = ''
    const hm = hash.match(/(?:^#|&)k=([^&]+)/)
    if (hm) key = decodeURIComponent(hm[1])
    if (!key) {
      const sm = search.match(/(?:^\?|&)k=([^&]+)/)
      if (sm) key = decodeURIComponent(sm[1])
    }
    if (key) {
      storeGateKey(key)
      // Strip both the query key and the fragment from the URL.
      const url = new URL(window.location.href)
      url.searchParams.delete('k')
      url.hash = ''
      window.history.replaceState(null, '', url.toString())
    }
  } catch {
    /* ignore */
  }
}

/** Public probe — is the gate open for the key we hold? */
export async function checkAdminGate(): Promise<boolean> {
  try {
    const r = await fetch('/api/paypal?action=admin-gate-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateKey: getGateKey() }),
    })
    const j = (await r.json()) as { open?: boolean }
    return Boolean(j.open)
  } catch {
    return false
  }
}

/** Generate a fresh high-entropy key (~150 bits, URL-safe). */
export function generateGateKey(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const alpha =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (const b of bytes) s += alpha[b % alpha.length]
  return s
}

/** Current admin's Firebase id token, or null if not signed in. */
export async function getAdminIdToken(): Promise<string | null> {
  const u = getClientAuth().currentUser
  if (!u) return null
  try {
    return await u.getIdToken()
  } catch {
    return null
  }
}

export function getAdminEmail(): string | null {
  return getClientAuth().currentUser?.email ?? null
}

/** Sign in with email/password. Returns the idToken on success. */
export async function adminSignIn(
  email: string,
  password: string,
): Promise<string> {
  const cred = await signInWithEmailAndPassword(
    getClientAuth(),
    email.trim(),
    password,
  )
  return cred.user.getIdToken()
}

export async function adminSignOut(): Promise<void> {
  clearAdminToken()
  try {
    await fbSignOut(getClientAuth())
  } catch {
    /* ignore */
  }
}

type ApiResult<T> = (T & { ok: true }) | { ok: false; error: string }

/** POST a raw action without the 2FA token (used by the 2FA flow
 *  itself, which only has the Firebase idToken at that point). */
export async function adminAuthCall<T>(
  action: string,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  const r = await fetch(`/api/paypal?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await r.json()) as ApiResult<T>
}

/** Request a fresh email login code (requires Firebase admin session). */
export async function requestAdminCode(): Promise<ApiResult<unknown>> {
  const idToken = await getAdminIdToken()
  if (!idToken) return { ok: false, error: 'לא מחובר' }
  return adminAuthCall('admin-2fa-request', { idToken, gateKey: getGateKey() })
}

/* ── Passkeys (WebAuthn) ───────────────────────────────────────── */

/** Attempt a passkey login. Returns {ok} on success (token stored),
 *  {noPasskeys:true} if this admin has none registered (caller should
 *  fall back to the email code), or {error}. */
export async function tryPasskeyLogin(): Promise<{
  ok: boolean
  noPasskeys?: boolean
  error?: string
}> {
  const idToken = await getAdminIdToken()
  if (!idToken) return { ok: false, error: 'לא מחובר' }
  const opt = await adminAuthCall<{ hasPasskeys?: boolean; options?: unknown }>(
    'admin-passkey-auth-options',
    { idToken, gateKey: getGateKey() },
  )
  if (!opt.ok) return { ok: false, error: opt.error }
  if (!opt.hasPasskeys || !opt.options) return { ok: false, noPasskeys: true }
  const { startAuthentication } = await import('@simplewebauthn/browser')
  let assertion
  markWebauthnCeremony()
  try {
    assertion = await startAuthentication({ optionsJSON: opt.options as never })
  } catch {
    return { ok: false, error: 'האימות הביומטרי בוטל' }
  }
  const v = await adminAuthCall<{ adminToken: string }>(
    'admin-passkey-auth-verify',
    { idToken, gateKey: getGateKey(), response: assertion },
  )
  if (v.ok) {
    storeAdminToken(v.adminToken)
    return { ok: true }
  }
  return { ok: false, error: v.error }
}

/** Register a new passkey on THIS device.
 *  - FIRST passkey (bootstrap): needs only the unlocked admin session.
 *  - ADDITIONAL passkey: ALSO needs a fresh step-up (prove an existing
 *    passkey), matching the server. This is what stops a stolen 12h
 *    adminToken from enrolling an attacker's device. */
export async function registerPasskey(
  deviceName: string,
): Promise<ApiResult<unknown>> {
  try {
    // If a passkey already exists, mint a step-up token first (prompts a
    // biometric on an existing credential) and attach it to both calls.
    let stepUpToken: string | undefined
    const existing = await listPasskeys()
    if (existing.length > 0) {
      stepUpToken = await ensureStepUp()
    }
    const extra = stepUpToken ? { stepUpToken } : {}
    const opt = await adminApi<{ options: unknown }>(
      'admin-passkey-reg-options',
      extra,
    )
    const { startRegistration } = await import('@simplewebauthn/browser')
    markWebauthnCeremony()
    const att = await startRegistration({ optionsJSON: opt.options as never })
    await adminApi('admin-passkey-reg-verify', {
      response: att,
      deviceName,
      ...extra,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'רישום נכשל' }
  }
}

export interface PasskeyInfo {
  id: string
  deviceName: string
  createdAt: number
}
export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const r = await adminApi<{ passkeys: PasskeyInfo[] }>('admin-passkey-list')
  return r.passkeys || []
}
export async function deletePasskey(id: string): Promise<void> {
  await adminApi('admin-passkey-delete', { id })
}

/** Verify the email code → returns + stores the 12h admin token. */
export async function verifyAdminCode(
  code: string,
): Promise<ApiResult<{ adminToken: string }>> {
  const idToken = await getAdminIdToken()
  if (!idToken) return { ok: false, error: 'לא מחובר' }
  const r = await adminAuthCall<{ adminToken: string }>('admin-2fa-verify', {
    idToken,
    code,
    gateKey: getGateKey(),
  })
  if (r.ok) storeAdminToken(r.adminToken)
  return r
}

/** Is a gate key currently configured server-side? */
export async function getGateStatus(): Promise<boolean> {
  const r = await adminApi<{ hasKey: boolean }>('admin-gate-status')
  return r.hasKey
}

/** Set/rotate the gate key (empty string clears it). Also persists
 *  the new key locally so this device keeps access. */
export async function setGateKey(newKey: string): Promise<void> {
  await adminApi('admin-set-gate-key', { newKey })
  storeGateKey(newKey)
}

/* ── Step-up (per-action re-verification) ───────────────────────────
 *
 * Every admin MUTATION requires a fresh STEP-UP token on top of the
 * 12h admin session: a 2-minute token minted ONLY by a live passkey
 * (Face ID / Touch ID / Windows Hello) assertion. So changing anything
 * always needs a present, biometric-verified admin — not just a login
 * that happened hours ago. Reads don't need it.
 *
 * This Set is the SINGLE SOURCE OF TRUTH on the client for which
 * actions are mutations. It MUST stay in sync with the server: every
 * action listed here is gated by verifyAdminStepUp() in api/paypal.ts.
 */
const STEPUP_ACTIONS = new Set<string>([
  'admin-set-pricing',
  'sync-plans',
  'admin-migrate-email-verified',
  'admin-send-test-email',
  'admin-test-sumit',
  'admin-send-marketing-email',
  'admin-create-referral',
  'admin-delete-referral',
  'admin-set-referral-credentials',
  'admin-set-referral-commission',
  'admin-set-referral-visibility',
  'admin-attribute-referral',
  'admin-grant-pro',
  'admin-passkey-delete',
  'admin-set-gate-key',
  'admin-set-user-blocked',
  'admin-set-user-role',
  'admin-set-user-storage',
  'admin-set-user-subscription',
  'admin-clear-user-device',
  'admin-delete-user',
  'admin-approve-trial',
  'admin-revoke-trial',
  'admin-reset-trial',
  'admin-device-check-create',
  'admin-create-key',
  'admin-delete-key',
  'admin-set-key-expiry',
  'admin-issue-usage-pull',
  'admin-set-app-config',
  'admin-set-receipts-settings',
  'admin-mark-casual-reported',
  'admin-set-popup',
  'admin-delete-backup',
  'admin-restore-backup',
  'admin-delete-client-error',
  'admin-clear-client-errors',
  'admin-sync-telemetry-clear',
  'admin-storage-cleanup',
  'admin-set-terms',
  'admin-set-privacy',
  'admin-set-accessibility',
  'admin-set-partner-terms',
  'admin-set-feedback-resolved',
  'admin-delete-feedback',
])

/** True if this action needs a step-up token (it's a mutation). */
export function actionNeedsStepUp(action: string): boolean {
  return STEPUP_ACTIONS.has(action)
}

function getValidStepUpToken(): string | null {
  try {
    const tok = sessionStorage.getItem(STEPUP_TOKEN_KEY)
    const exp = Number(sessionStorage.getItem(STEPUP_EXP_KEY) || '0')
    if (!tok || !exp) return null
    // Treat as expired 10s early to avoid a race where it lapses
    // server-side between this check and the request landing.
    if (Date.now() >= exp - 10_000) return null
    return tok
  } catch {
    return null
  }
}
function storeStepUpToken(token: string, expiresInSeconds: number): void {
  try {
    sessionStorage.setItem(STEPUP_TOKEN_KEY, token)
    sessionStorage.setItem(
      STEPUP_EXP_KEY,
      String(Date.now() + expiresInSeconds * 1000),
    )
  } catch {
    /* ignore */
  }
}
export function clearStepUpToken(): void {
  try {
    sessionStorage.removeItem(STEPUP_TOKEN_KEY)
    sessionStorage.removeItem(STEPUP_EXP_KEY)
  } catch {
    /* ignore */
  }
}

/* ── WebAuthn ceremony marker (mobile reload guard) ─────────────────
 *
 * iOS Safari frequently RELOADS a backgrounded tab when the system
 * Face ID / passkey sheet dismisses and control returns to the page.
 * That reload would otherwise trip our "page load == full logout"
 * rule (see AdminPage), trapping the user in a
 * prompt → reload → logout → re-login loop where no admin action can
 * ever complete on a phone.
 *
 * Fix: stamp a timestamp right BEFORE every WebAuthn ceremony. We do
 * NOT clear it when the ceremony resolves — on iOS the reload happens
 * just AFTER the sheet returns, so clearing-on-finish would be too
 * early. Instead the next page load consumes the marker: if it's
 * fresh (≤2 min), that load was almost certainly the ceremony reload,
 * so we SKIP the logout. A genuine manual refresh more than 2 min
 * after the last biometric still logs out as intended.
 */
const WEBAUTHN_ACTIVE_KEY = 'dmplus.admin.webauthn.active.v1'
const WEBAUTHN_ACTIVE_TTL_MS = 2 * 60 * 1000

function markWebauthnCeremony(): void {
  try {
    sessionStorage.setItem(WEBAUTHN_ACTIVE_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

/** Read-and-clear: returns true if a WebAuthn ceremony was started in
 *  the last 2 minutes (i.e. THIS page load is most likely the reload
 *  that the biometric sheet triggered). Always clears the marker. */
export function consumeWebauthnCeremonyReload(): boolean {
  try {
    const ts = Number(sessionStorage.getItem(WEBAUTHN_ACTIVE_KEY) || '0')
    sessionStorage.removeItem(WEBAUTHN_ACTIVE_KEY)
    return ts > 0 && Date.now() - ts < WEBAUTHN_ACTIVE_TTL_MS
  } catch {
    return false
  }
}

/**
 * Ensure we hold a valid step-up token, prompting a fresh passkey
 * assertion if not. Returns the token. Throws:
 *   - code 'auth'      → the 12h session lapsed (bounce to login)
 *   - code 'no-passkey'→ this device has no registered passkey
 *   - code 'cancelled' → the operator dismissed the biometric prompt
 */
async function ensureStepUp(): Promise<string> {
  const cached = getValidStepUpToken()
  if (cached) return cached
  // 1) Ask the server for a fresh authentication challenge. This call
  //    itself is a normal 2FA-gated call (NOT in STEPUP_ACTIONS, so no
  //    recursion). If the session lapsed, adminApi throws code 'auth'.
  const opt = await adminApi<{ hasPasskeys?: boolean; options?: unknown }>(
    'admin-stepup-options',
  )
  if (!opt.hasPasskeys || !opt.options) {
    const err = new Error(
      'אין Passkey רשום במכשיר הזה. הוסף Passkey בהגדרות כדי לבצע פעולות ניהול.',
    ) as Error & { code?: string }
    err.code = 'no-passkey'
    throw err
  }
  // 2) Drive the biometric prompt. Mark the ceremony first so that if
  //    iOS reloads the tab on return, the next load won't log us out.
  const { startAuthentication } = await import('@simplewebauthn/browser')
  let assertion
  markWebauthnCeremony()
  try {
    assertion = await startAuthentication({ optionsJSON: opt.options as never })
  } catch {
    const err = new Error('האימות הביומטרי בוטל') as Error & { code?: string }
    err.code = 'cancelled'
    throw err
  }
  // 3) Exchange the assertion for a 2-min step-up token.
  const v = await adminApi<{ stepUpToken: string; expiresInSeconds: number }>(
    'admin-stepup-verify',
    { response: assertion },
  )
  storeStepUpToken(v.stepUpToken, v.expiresInSeconds || 120)
  return v.stepUpToken
}

/** Public: get a valid step-up token (for non-adminApi callers like
 *  the draft-release endpoint). Prompts a passkey if needed. */
export async function getStepUpToken(): Promise<string> {
  return ensureStepUp()
}

/**
 * The workhorse for every admin call. Attaches the Firebase idToken,
 * the 12h admin token, and the gate key. For MUTATIONS (see
 * STEPUP_ACTIONS) it ALSO ensures + attaches a fresh step-up token,
 * prompting a passkey assertion when the previous one expired. Throws
 * on a non-ok response. A 403 means a gate failed — callers treat
 * code 'auth' as "bounce to login".
 */
export async function adminApi<T>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const idToken = await getAdminIdToken()
  const adminToken = getStoredAdminToken()
  if (!idToken || !adminToken) {
    const err = new Error('admin-auth-required') as Error & { code?: string }
    err.code = 'auth'
    throw err
  }

  const needsStepUp = STEPUP_ACTIONS.has(action)

  const doFetch = async (stepUpToken?: string) => {
    const r = await fetch(`/api/paypal?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        idToken,
        adminToken,
        gateKey: getGateKey(),
        ...(stepUpToken ? { stepUpToken } : {}),
      }),
    })
    const json = (await r.json()) as ApiResult<T>
    return { status: r.status, json }
  }

  // Mutation: ensure a step-up token up front (may prompt passkey).
  let stepUpToken: string | undefined
  if (needsStepUp) {
    stepUpToken = await ensureStepUp()
  }

  let { status, json } = await doFetch(stepUpToken)

  // If a mutation 403s despite our token, the step-up may have lapsed
  // between mint and landing (or been rejected). Drop it and re-prompt
  // exactly once. If THAT still fails, fall through to the error path
  // (ensureStepUp throws code 'auth' when the 12h session is the real
  // problem, which bounces to login).
  if (needsStepUp && status === 403) {
    clearStepUpToken()
    stepUpToken = await ensureStepUp()
    ;({ status, json } = await doFetch(stepUpToken))
  }

  if (!json.ok) {
    const err = new Error(json.error || 'admin call failed') as Error & {
      code?: string
    }
    if (status === 403) err.code = 'auth'
    throw err
  }
  return json
}
