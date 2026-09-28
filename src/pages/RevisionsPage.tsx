import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, CheckCircle2 } from 'lucide-react'
import { getSession, subscribeSession } from '../lib/webSession'
import { RevisionsWorkspace as WebRevisionsWorkspace } from '../components/RevisionsWorkspace'
import { ProWorkspaceShell } from '../components/ProWorkspaceShell'
import { FlPage } from '../components/site/FlPage'
import { ShellMark, ShellStage } from '../components/workspace/shell/ShellUi'
import '../styles/pages/workspace.css'

/**
 * Public /revisions workspace — the editor side of the Revisions
 * feature, exposed on the website so anyone with a Pro
 * subscription can manage projects from a browser instead of
 * installing the desktop app.
 *
 * The auth + Pro-entitlement ladder is shared with /deliveries via
 * <ProWorkspaceShell>. This page only adds the revisions-specific
 * Drive-OAuth popup handling on top: when the Drive connect flow
 * opens in a noopener popup, that popup lands back here with
 * `?oauth=connected` but NO session (sessionStorage isn't inherited
 * across the noopener boundary), so we detect that case up front,
 * signal the original workspace tab, and close the popup — all
 * BEFORE the shell would otherwise strand the user on a login form.
 */
export function RevisionsPage() {
  // Kept locally only to drive the OAuth-popup early-return below.
  // The shell independently manages session state for rendering.
  const [session, setSession] = useState(() => getSession())
  useEffect(() => subscribeSession(() => setSession(getSession())), [])

  // OAuth-popup auto-close. ConnectDriveEmptyState opens the Drive
  // OAuth flow in a new tab via window.open(_, _, 'noopener'). The
  // noopener strips the link to the original tab — which also means
  // the new tab starts with EMPTY sessionStorage. So when Google
  // redirects the new tab back here with `?oauth=connected`, it has
  // no session and would otherwise strand the user on the login
  // form ("I already signed in!").
  const isOauthCallback = useMemo(() => {
    if (typeof window === 'undefined') return false
    const url = new URL(window.location.href)
    return url.searchParams.get('oauth') === 'connected'
  }, [])

  useEffect(() => {
    // Only auto-close if (a) this looks like the OAuth result tab
    // (?oauth=connected) and (b) we have no session — the exact
    // signature of a noopener-opened OAuth popup landing here.
    if (isOauthCallback && !session) {
      // Three signals to the original workspace tab, fired in
      // parallel. Whichever lands first triggers the refetch.
      try {
        const channel = new BroadcastChannel('dmplus-revisions-oauth')
        channel.postMessage({ kind: 'connected' })
        channel.close()
      } catch {
        // BroadcastChannel unsupported (very old Safari) — the
        // localStorage path below still fires.
      }
      try {
        const key = 'dmplus.revisions.oauth.signal'
        localStorage.setItem(key, String(Date.now()))
        localStorage.removeItem(key)
      } catch {
        // localStorage blocked (private browsing in older Safari,
        // etc.) — fall through to the close + focus path.
      }
      try {
        window.close()
      } catch {
        // Browser blocked the close — fall through to the visible
        // "you can close this tab" card instead.
      }
    }
  }, [isOauthCallback, session])

  if (isOauthCallback && !session) {
    return <SignedOutOauthSuccess />
  }

  return (
    <ProWorkspaceShell featureLabel="סבבי תיקונים">
      <RevisionsWorkspace />
    </ProWorkspaceShell>
  )
}

/** Last-resort UI for the OAuth popup tab when window.close() got
 *  blocked. The original workspace tab has already picked up the
 *  fresh Drive connection via its polling effect, so this tab is
 *  only here to confirm to the user that the flow worked and tell
 *  them they can close it. */
function SignedOutOauthSuccess() {
  return (
    <FlPage name="workspace" chrome="min" title="סבבי תיקונים">
      <ShellStage>
        <div className="card ws-card center">
          <ShellMark tone="ok" badge={<Check className="ic" aria-hidden />} />
          <h1 className="ws-h">ה-Drive מחובר</h1>
          <p className="ws-p">
            אפשר לסגור את החלון הזה ולחזור לחלון של סבבי התיקונים. הוא
            יזהה את החיבור תוך שניות.
          </p>
        </div>
      </ShellStage>
    </FlPage>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Workspace — wraps the real workspace with the one-time
 *  "Drive connected" confirmation chip on OAuth return.
 * ────────────────────────────────────────────────────────────── */

function RevisionsWorkspace() {
  // Detect a successful OAuth round-trip — the api/revisions
  // oauth-callback redirects here with ?oauth=connected on a
  // successful web-source connect. Show a one-time confirmation
  // chip and then strip the param so refreshing the page doesn't
  // keep re-displaying it.
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const justConnected = searchParams.get('oauth') === 'connected'
  useEffect(() => {
    if (!justConnected) return
    const t = setTimeout(() => {
      navigate('/revisions', { replace: true })
    }, 3500)
    return () => clearTimeout(t)
  }, [justConnected, navigate])

  return (
    <>
      {justConnected && (
        <div className="ws-chip">
          <div className="note ok" role="status">
            <CheckCircle2 className="ic" aria-hidden />
            <span>החיבור ל-Google Drive הושלם בהצלחה.</span>
          </div>
        </div>
      )}
      <WebRevisionsWorkspace />
    </>
  )
}
