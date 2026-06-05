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

export function getStoredAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY)
}
export function storeAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
}
export function clearAdminToken(): void {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY)
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

/** Public IP-gate probe — the /admin page renders nothing at all if
 *  the caller's IP isn't on the allowlist (configured from desktop).
 *  Fails CLOSED (allowed:false) on any network error. */
export async function checkAdminIpAllowed(): Promise<{
  allowed: boolean
  ip: string
}> {
  try {
    const r = await fetch('/api/paypal?action=admin-ip-allowed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const j = (await r.json()) as { allowed?: boolean; ip?: string }
    return { allowed: Boolean(j.allowed), ip: String(j.ip || '') }
  } catch {
    return { allowed: false, ip: '' }
  }
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

/** Register a new passkey on THIS device (requires an unlocked admin
 *  session — email code or an existing passkey). */
export async function registerPasskey(
  deviceName: string,
): Promise<ApiResult<unknown>> {
  try {
    const opt = await adminApi<{ options: unknown }>('admin-passkey-reg-options')
    const { startRegistration } = await import('@simplewebauthn/browser')
    const att = await startRegistration({ optionsJSON: opt.options as never })
    await adminApi('admin-passkey-reg-verify', { response: att, deviceName })
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

/**
 * The workhorse for every admin DATA call. Attaches BOTH the
 * Firebase idToken and the stored 2FA admin token. Throws on a
 * non-ok response so callers can try/catch. A 403 here means the
 * 2FA token expired/missing — callers should bounce to the login.
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
  const r = await fetch(`/api/paypal?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, idToken, adminToken, gateKey: getGateKey() }),
  })
  const json = (await r.json()) as ApiResult<T>
  if (!json.ok) {
    const err = new Error(json.error || 'admin call failed') as Error & {
      code?: string
    }
    if (r.status === 403) err.code = 'auth'
    throw err
  }
  return json
}
