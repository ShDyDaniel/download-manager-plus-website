/**
 * Referral capture — when a visitor lands via a partner link
 * (dmplus.net/?ref=<code>), we remember the code so it can be stamped
 * onto their account when they sign up. The account is the attribution
 * anchor: once `referredBy` is on the account, every later purchase is
 * attributable to the partner.
 *
 * Stored in localStorage (survives across tabs + reloads, unlike
 * sessionStorage) with a 60-day TTL. Last-write-wins: a fresh ?ref
 * overrides an older stored one.
 */

const REF_KEY = 'dmplus.ref.v1'
const REF_TTL_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

interface StoredRef {
  code: string
  at: number
}

/** Read ?ref from the current URL and persist it. Call once on app
 *  load. Safe to call repeatedly. */
export function captureRefFromUrl(): void {
  try {
    const code = new URLSearchParams(window.location.search)
      .get('ref')
      ?.trim()
      .slice(0, 40)
    if (!code) return
    const payload: StoredRef = { code, at: Date.now() }
    localStorage.setItem(REF_KEY, JSON.stringify(payload))
  } catch {
    /* private mode / storage disabled — referral just won't persist */
  }
}

/** The stored referral code, or undefined if none / expired. */
export function getStoredRef(): string | undefined {
  try {
    const raw = localStorage.getItem(REF_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as StoredRef
    if (!parsed?.code || typeof parsed.at !== 'number') return undefined
    if (Date.now() - parsed.at > REF_TTL_MS) {
      localStorage.removeItem(REF_KEY)
      return undefined
    }
    return parsed.code
  } catch {
    return undefined
  }
}

/** Clear the stored referral (e.g. after it's been bound to an
 *  account, to avoid mis-attributing a second account on the same
 *  browser). */
export function clearStoredRef(): void {
  try {
    localStorage.removeItem(REF_KEY)
  } catch {
    /* ignore */
  }
}
