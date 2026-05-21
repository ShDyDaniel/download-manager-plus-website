import type { VercelRequest, VercelResponse } from '@vercel/node'
import { syncPlansForPricing, getDb } from '../_paypal'
import { loadCurrentPricing } from '../pricing'

/**
 * POST /api/admin/sync-paypal-plans
 *
 * Admin-only endpoint that re-syncs the PayPal Plans against the
 * current pricing doc in Firestore. Called by the admin panel
 * after saving new prices — it deactivates the old Plans (so new
 * subscribers can't accidentally subscribe at a stale price) and
 * creates fresh Plans for each new price point. Existing
 * subscribers stay grandfathered into their original Plans.
 *
 * Auth: requires a valid Firebase ID token from an admin user
 * (email in ADMIN_EMAILS). This is the same gate /api/admin/draft-
 * release uses — see that file for the rationale.
 *
 * It's safe to call this multiple times: syncPlansForPricing is
 * idempotent (reuses Plans whose stored price still matches the
 * pricing doc, creates only what's new).
 */

export const config = {
  maxDuration: 30,
}

const ADMIN_EMAILS = ['dyshalts@gmail.com']

interface Body {
  idToken?: string
}

interface IdentityResponse {
  users?: Array<{ email?: string; localId?: string; emailVerified?: boolean }>
  error?: { code?: number; message?: string }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }
  const body = (req.body || {}) as Body
  const idToken = (body.idToken || '').trim()
  if (!idToken) {
    return res.status(400).json({ ok: false, error: 'missing idToken' })
  }

  const apiKey = process.env.FIREBASE_WEB_API_KEY
  if (!apiKey) {
    return res
      .status(500)
      .json({ ok: false, error: 'FIREBASE_WEB_API_KEY not set' })
  }

  // Verify the ID token by looking up the user — Identity Toolkit
  // returns 4xx if the token is invalid/expired. Same minimal-
  // dependencies pattern /api/admin/draft-release uses (vs. pulling
  // in firebase-admin's verifyIdToken which adds startup cost).
  let email: string
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    )
    const json = (await r.json()) as IdentityResponse
    if (!r.ok || !json.users?.[0]?.email) {
      return res.status(401).json({ ok: false, error: 'invalid id token' })
    }
    email = json.users[0].email.toLowerCase()
  } catch (err) {
    console.error('sync-paypal-plans token verify failed', err)
    return res.status(502).json({ ok: false, error: 'token verify failed' })
  }
  if (!ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ ok: false, error: 'not an admin' })
  }

  // We have an authenticated admin. Pull current pricing and
  // re-sync the PayPal Plans against it. The actual sync logic
  // lives in _paypal.ts and is idempotent — calling it when
  // everything's already in sync is essentially a no-op.
  try {
    const pricing = await loadCurrentPricing()
    const plans = await syncPlansForPricing(pricing)
    return res.status(200).json({
      ok: true,
      plans,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('[admin/sync-paypal-plans] failed:', err)
    return res.status(500).json({ ok: false, error: message })
  }
}

// Re-export getDb so any future admin endpoint can import it
// without re-importing _paypal — keeps the API folder coherent.
export { getDb }
