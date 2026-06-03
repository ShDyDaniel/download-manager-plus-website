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

export function getStoredAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY)
}
export function storeAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
}
export function clearAdminToken(): void {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY)
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
  return adminAuthCall('admin-2fa-request', { idToken })
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
  })
  if (r.ok) storeAdminToken(r.adminToken)
  return r
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
    body: JSON.stringify({ ...body, idToken, adminToken }),
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
