/**
 * Referral capture — when a visitor lands via a partner link
 * (dmplus.net/?ref=<code>), we remember the code so it can be stamped
 * onto their account when they sign up, and kept sticky in the URL
 * while they browse.
 *
 * Storage choice: sessionStorage (NOT localStorage). The referral is
 * scoped to the BROWSING SESSION you arrived in:
 *   - It survives navigation between pages and a page refresh (same
 *     tab), so the ?ref stays in the address bar everywhere you go.
 *   - It is cleared when the tab is closed. So if you later open the
 *     plain dmplus.net link in a fresh tab, you stay on the plain link
 *     — a previous partner visit doesn't "stick" forever.
 * This matches the operator's intent: the link you came in with is the
 * one you keep, until you close the tab.
 */

const REF_KEY = 'dmplus.ref.v1'

/** Read ?ref from the current URL and persist it for this session.
 *  Call on app load and on each navigation. Safe to call repeatedly. */
export function captureRefFromUrl(): void {
  try {
    const code = new URLSearchParams(window.location.search)
      .get('ref')
      ?.trim()
      .slice(0, 40)
    if (!code) return
    sessionStorage.setItem(REF_KEY, code)
  } catch {
    /* private mode / storage disabled — referral just won't persist */
  }
}

/** The referral code for this session, or undefined if none. */
export function getStoredRef(): string | undefined {
  try {
    return sessionStorage.getItem(REF_KEY)?.trim() || undefined
  } catch {
    return undefined
  }
}

/** Clear the stored referral for this session. */
export function clearStoredRef(): void {
  try {
    sessionStorage.removeItem(REF_KEY)
  } catch {
    /* ignore */
  }
}
