import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Unlink,
} from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import '../styles/pages/auth-action.css'

/**
 * Custom action handler — replaces Firebase Auth's default
 * `firebaseapp.com/__/auth/action` page with one that matches our
 * branding.
 *
 * Wiring:
 *   1. Firebase Console → Authentication → Templates → Password
 *      reset → "Customize action URL" set to
 *      `https://www.framelineapp.com/auth-action` (the old
 *      `https://dmplus.net/auth-action` redirects there with its query).
 *   2. From then on, every `generatePasswordResetLink()` call in
 *      api/reset-password.ts produces a URL with our domain
 *      instead of `n-plus-64549.firebaseapp.com`.
 *   3. The user clicks the email link → lands here with URL params:
 *      ?mode=resetPassword&oobCode=...&apiKey=...&continueUrl=...
 *   4. We verify the oobCode (so we can show "for <email>"), accept
 *      a new password, and confirm the reset via Firebase's Identity
 *      Toolkit REST API.
 *
 * Why REST directly and not the firebase JS SDK:
 *   The client SDK adds ~80kB gzipped to the bundle just for this
 *   one flow. The REST endpoint
 *   `identitytoolkit.googleapis.com/v1/accounts:resetPassword` does
 *   the same job in two POST calls. The apiKey is public (it's in
 *   the URL we just received) — security comes from the oobCode,
 *   which is a one-time secret token.
 *
 * Supported modes:
 *   - resetPassword (this is what we use today)
 *   - verifyEmail / recoverEmail (future-proofed but not used yet —
 *     currently shown as "unsupported" so we fail loud rather than
 *     drop the user into a broken flow)
 */
const MARK = '/logo-mark.svg?v=1'
const HELP = 'help.frameline@gmail.com'

/** What went wrong with the link, and how the card should look:
 *   expired — expired / used code: "no longer valid" + ask for a new link
 *   link    — missing details, disabled / unknown account
 *   error   — network, rate limit, anything unknown: offer a retry */
type LinkProblem = { kind: 'expired' | 'link' | 'error'; msg: string }

export function AuthActionPage() {
  const [params] = useSearchParams()
  const mode = params.get('mode')
  const oobCode = params.get('oobCode')
  const apiKey = params.get('apiKey')

  return (
    <FlPage name="auth-action" chrome="min" title="איפוס סיסמה">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.35 }}
        className="aa-wrap"
      >
        {mode === 'resetPassword' ? (
          <ResetPasswordHandler oobCode={oobCode} apiKey={apiKey} />
        ) : (
          <UnsupportedMode mode={mode} />
        )}
      </motion.div>
    </FlPage>
  )
}

function Mark({ badge, cls = '' }: { badge: React.ReactNode; cls?: string }) {
  return (
    <div className="aa-mark">
      <img src={MARK} alt="פריימליין" width={68} height={68} />
      <span className={`aa-badge ${cls}`}>{badge}</span>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Reset-password handler
 *
 *  Two-stage flow:
 *    1. On mount: verify-only call to the same endpoint without a
 *       `newPassword`. Firebase returns the email the code is for,
 *       which we display so the user can be sure they're resetting
 *       the right account (matches the "for foo@example.com" line
 *       on the default Firebase page).
 *    2. On submit: full call with `newPassword`. Firebase applies
 *       the reset; we show a success screen with a link back to
 *       /account.
 * ───────────────────────────────────────────────────────────── */
function ResetPasswordHandler({
  oobCode,
  apiKey,
}: {
  oobCode: string | null
  apiKey: string | null
}) {
  const [email, setEmail] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(true)
  const [verifyError, setVerifyError] = useState<LinkProblem | null>(null)

  const [newPassword, setNewPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Verify the oobCode and get the email it's for. We do this once
  // on mount — if the link is expired/used the user finds out
  // immediately instead of after typing a new password.
  useEffect(() => {
    if (!oobCode || !apiKey) {
      setVerifyError({
        kind: 'link',
        msg: 'הקישור פגום או שחסרים בו פרטים. בקשו איפוס סיסמה חדש מדף ההתחברות.',
      })
      setVerifying(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oobCode }),
          },
        )
        const json = (await r.json()) as {
          email?: string
          error?: { message?: string }
        }
        if (cancelled) return
        if (!r.ok) {
          throw new Error(json.error?.message || 'invalid code')
        }
        setEmail(json.email || null)
      } catch (err) {
        if (cancelled) return
        setVerifyError(translateFirebaseError(err, 'verify'))
      } finally {
        if (!cancelled) setVerifying(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [oobCode, apiKey])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!oobCode || !apiKey) return
    // Firebase's default minimum is 6 chars — we surface the same
    // limit pre-flight so the user doesn't waste a round-trip and
    // then see a generic English error.
    if (newPassword.length < 6) {
      setSubmitError('הסיסמה צריכה להכיל לפחות 6 תווים.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const r = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oobCode, newPassword }),
        },
      )
      const json = (await r.json()) as { error?: { message?: string } }
      if (!r.ok) {
        throw new Error(json.error?.message || 'failed')
      }
      setSuccess(true)
    } catch (err) {
      setSubmitError(translateFirebaseError(err, 'save').msg)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Loading state — verifying the code on mount ──
  if (verifying) {
    return (
      <div className="card aa-card" role="status" aria-live="polite">
        <Mark cls="spin" badge={<Loader2 className="ic" aria-hidden />} />
        <h1 className="aa-h">בודקים את הקישור…</h1>
        <p className="aa-p">רגע אחד.</p>
      </div>
    )
  }

  // ── Invalid / expired code ──
  if (verifyError) {
    if (verifyError.kind === 'error') {
      return (
        <div className="card aa-card">
          <Mark cls="err" badge={<AlertTriangle className="ic" aria-hidden />} />
          <h1 className="aa-h">משהו השתבש</h1>
          <p className="aa-p" role="alert">
            {verifyError.msg}
          </p>
          <div className="aa-btns">
            {/* Same as refreshing the page: the link is checked again. */}
            <button type="button" className="btn btn-p btn-block" onClick={() => window.location.reload()}>
              <RefreshCw className="ic" aria-hidden />
              ניסיון נוסף
            </button>
          </div>
          <p className="aa-fine">
            אם זה חוזר, כתבו לנו:{' '}
            <a className="link" href={`mailto:${HELP}`}>
              {HELP}
            </a>
          </p>
        </div>
      )
    }
    const expired = verifyError.kind === 'expired'
    return (
      <div className="card aa-card">
        <Mark cls="err" badge={<Unlink className="ic" aria-hidden />} />
        <h1 className="aa-h">{expired ? 'הקישור כבר לא בתוקף' : 'הקישור לא תקין'}</h1>
        <p className="aa-p" role="alert">
          {verifyError.msg}
        </p>
        {expired && <p className="aa-fine">כל קישור איפוס עובד פעם אחת, ובמשך שעה אחת.</p>}
        <div className="aa-btns">
          <Link className="btn btn-p btn-block" to="/account">
            בקשת קישור איפוס חדש
          </Link>
        </div>
      </div>
    )
  }

  // ── Success — password reset applied ──
  if (success) {
    return (
      <div className="card aa-card">
        <Mark cls="ok" badge={<Check className="ic" aria-hidden />} />
        <h1 className="aa-h">הסיסמה עודכנה</h1>
        <p className="aa-p">
          {email ? (
            <>
              הסיסמה של <bdi className="aa-mail">{email}</bdi> שונתה. אפשר להתחבר עכשיו עם הסיסמה החדשה.
            </>
          ) : (
            'הסיסמה שונתה. אפשר להתחבר עכשיו עם הסיסמה החדשה.'
          )}
        </p>
        <div className="aa-btns">
          <Link className="btn btn-p btn-block" to="/account">
            התחברות לחשבון שלי
          </Link>
        </div>
      </div>
    )
  }

  // ── Main form — pick a new password ──
  return (
    <div className="card aa-card">
      <Mark badge={<KeyRound className="ic" aria-hidden />} />
      <h1 className="aa-h">בחירת סיסמה חדשה</h1>
      {email && (
        <p className="aa-p">
          איפוס סיסמה עבור <bdi className="aa-mail">{email}</bdi>
        </p>
      )}
      <form className="form aa-form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="aa-pw">סיסמה חדשה</label>
          <div className="aa-pw">
            <input
              className={`input${submitError ? ' bad' : ''}`}
              id="aa-pw"
              type={showPassword ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              disabled={submitting}
              aria-invalid={!!submitError || undefined}
              aria-describedby={submitError ? 'aa-pw-e' : 'aa-pw-h'}
            />
            <button
              type="button"
              className="aa-eye"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              aria-label={showPassword ? 'הסתרת הסיסמה' : 'הצגת הסיסמה'}
            >
              {showPassword ? <EyeOff className="ic" aria-hidden /> : <Eye className="ic" aria-hidden />}
            </button>
          </div>
          {submitError ? (
            <span className="err-msg" id="aa-pw-e" role="alert">
              {submitError}
            </span>
          ) : (
            <span className="hint" id="aa-pw-h">
              לפחות 6 תווים.
            </span>
          )}
        </div>
        <button type="submit" className="btn btn-p btn-block aa-go" disabled={submitting}>
          {submitting ? <Loader2 className="ic aa-spin" aria-hidden /> : <Lock className="ic" aria-hidden />}
          שמירת הסיסמה החדשה
        </button>
      </form>
      <p className="aa-fine">אחרי השמירה תוכלו להתחבר עם הסיסמה החדשה.</p>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Unsupported mode — when Firebase sends us a mode we haven't
 *  implemented yet (verifyEmail, recoverEmail, etc.). Fail loud
 *  rather than silently — the user clicked an email link expecting
 *  *something* to happen, so telling them "we got the link, we just
 *  don't handle this kind yet" is the honest answer.
 * ───────────────────────────────────────────────────────────── */
function UnsupportedMode({ mode }: { mode: string | null }) {
  return (
    // The raw mode name (e.g. verifyEmail) stays out of the Hebrew text;
    // it's kept on the card for support.
    <div className="card aa-card" data-mode={mode ?? undefined}>
      <Mark cls="err" badge={<AlertCircle className="ic" aria-hidden />} />
      <h1 className="aa-h">פעולה לא נתמכת</h1>
      <p className="aa-p">
        הקישור הזה ביקש פעולה שהאתר עוד לא תומך בה. אם הגעתם ממייל של איפוס סיסמה, בקשו קישור חדש מדף
        ההתחברות.
      </p>
      <div className="aa-btns">
        <Link className="btn btn-s btn-block" to="/account">
          חזרה לדף החשבון
        </Link>
      </div>
    </div>
  )
}

/**
 * Firebase Identity Toolkit returns errors as English constants
 * like `EXPIRED_OOB_CODE`. Every one of them is shown in Hebrew: the
 * ones we expect get their own sentence, and anything else (an
 * unmapped code, "Failed to fetch") gets a general message that says
 * what to do — raw English never reaches the visitor.
 */
function translateFirebaseError(err: unknown, step: 'verify' | 'save'): LinkProblem {
  // fetch() itself failed → no connection.
  if (err instanceof TypeError) {
    return {
      kind: 'error',
      msg:
        step === 'verify'
          ? 'לא הצלחנו לבדוק את הקישור. בדקו את החיבור לאינטרנט ונסו שוב.'
          : 'לא הצלחנו לשמור את הסיסמה. בדקו את החיבור לאינטרנט ונסו שוב.',
    }
  }
  const upper = (err instanceof Error ? err.message : '').toUpperCase()
  if (upper.includes('EXPIRED_OOB_CODE')) {
    return { kind: 'expired', msg: 'הקישור פג תוקף. בקשו איפוס סיסמה חדש.' }
  }
  if (upper.includes('INVALID_OOB_CODE')) {
    return { kind: 'expired', msg: 'הקישור לא תקין או שכבר השתמשו בו. בקשו איפוס חדש.' }
  }
  if (upper.includes('USER_DISABLED')) {
    return { kind: 'link', msg: `החשבון מושבת. כתבו לנו: ${HELP}` }
  }
  if (upper.includes('USER_NOT_FOUND')) {
    return { kind: 'link', msg: 'החשבון לא נמצא. בקשו איפוס חדש מדף ההתחברות.' }
  }
  if (upper.includes('WEAK_PASSWORD')) {
    return { kind: 'error', msg: 'הסיסמה חלשה מדי. בחרו סיסמה ארוכה יותר.' }
  }
  if (upper.includes('TOO_MANY_ATTEMPTS')) {
    return { kind: 'error', msg: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }
  }
  return {
    kind: 'error',
    msg:
      step === 'verify'
        ? 'לא הצלחנו לבדוק את הקישור. נסו שוב בעוד רגע.'
        : 'לא הצלחנו לשמור את הסיסמה. נסו שוב.',
  }
}

export default AuthActionPage
