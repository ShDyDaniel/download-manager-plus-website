/**
 * Fire-and-forget page-view ping for the marketing / buy / account
 * pages. De-duped once per page per browser session (so refreshes and
 * SPA re-renders don't double-count). Raw counts only — no cookies, no
 * personal data. The server (api/paypal?action=track-pageview)
 * accumulates these and the admin "נתוני שימוש" tab shows them.
 */
const TRACK_URL = '/api/paypal?action=track-pageview'
const SESSION_PREFIX = 'dmplus.pv.'

export function trackPageview(page: 'home' | 'buy' | 'account'): void {
  try {
    const k = SESSION_PREFIX + page
    if (sessionStorage.getItem(k)) return // already counted this session
    sessionStorage.setItem(k, '1')
    void fetch(TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* never let analytics break the page */
  }
}
