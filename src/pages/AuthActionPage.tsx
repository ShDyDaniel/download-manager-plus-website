import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
} from 'lucide-react'

/**
 * Custom action handler — replaces Firebase Auth's default
 * `firebaseapp.com/__/auth/action` page with one that matches our
 * branding.
 *
 * Wiring:
 *   1. Firebase Console → Authentication → Templates → Password
 *      reset → "Customize action URL" set to
 *      `https://www.dmplus.net/auth-action`.
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
export function AuthActionPage() {
  const [params] = useSearchParams()
  const mode = params.get('mode')
  const oobCode = params.get('oobCode')
  const apiKey = params.get('apiKey')

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen px-6 py-12 md:py-20"
    >
      <div className="mx-auto max-w-md">
        {/* Brand chip — keeps the page from feeling orphaned from
            the rest of the site even though there's no Hero here. */}
        <div className="mb-8 text-center">
          <img
            src="/icon.png"
            alt="ניהול הורדות פלוס"
            className="mx-auto h-16 w-16 rounded-2xl shadow-2xl"
          />
        </div>

        {mode === 'resetPassword' ? (
          <ResetPasswordHandler oobCode={oobCode} apiKey={apiKey} />
        ) : (
          <UnsupportedMode mode={mode} />
        )}
      </div>
    </motion.div>
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
  const [verifyError, setVerifyError] = useState<string | null>(null)

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
      setVerifyError(
        'הקישור פגום או חסר פרטים. בקש איפוס סיסמה חדש מדף ההתחברות.',
      )
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
        const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה'
        setVerifyError(translateFirebaseError(msg))
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
      setSubmitError('הסיסמה חייבת להיות לפחות 6 תווים')
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
      const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה'
      setSubmitError(translateFirebaseError(msg))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Loading state — verifying the code on mount ──
  if (verifying) {
    return (
      <div className="card-elevated flex flex-col items-center gap-3 rounded-2xl border-border p-6 py-12 text-center md:p-8">
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
        <div className="text-sm text-fg-muted">בודק את הקישור…</div>
      </div>
    )
  }

  // ── Invalid / expired code ──
  if (verifyError) {
    return (
      <div className="card-elevated rounded-2xl border-border p-6 md:p-8">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-destructive">
          <AlertCircle className="h-4 w-4" />
          הקישור לא תקין
        </div>
        <p className="mb-6 text-sm leading-relaxed text-fg-secondary">
          {verifyError}
        </p>
        <Link
          to="/account"
          className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary-hover"
        >
          בקש קישור איפוס חדש
        </Link>
      </div>
    )
  }

  // ── Success — password reset applied ──
  if (success) {
    return (
      <div className="card-elevated rounded-2xl border-border p-6 md:p-8">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-success">
          <CheckCircle2 className="h-4 w-4" />
          הסיסמה עודכנה
        </div>
        <p className="mb-6 text-sm leading-relaxed text-fg-secondary">
          הסיסמה ל-{email ? <strong className="text-fg">{email}</strong> : 'חשבונך'} שונתה
          בהצלחה. אפשר עכשיו להתחבר עם הסיסמה החדשה.
        </p>
        <Link
          to="/account"
          className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary-hover"
        >
          התחבר לחשבון שלי
        </Link>
      </div>
    )
  }

  // ── Main form — pick a new password ──
  return (
    <form
      onSubmit={handleSubmit}
      className="card-elevated space-y-4 rounded-2xl border-border p-6 md:p-8"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Lock className="h-4 w-4 text-accent" />
        בחירת סיסמה חדשה
      </div>
      {email && (
        <p className="text-xs leading-relaxed text-fg-muted">
          איפוס סיסמה עבור{' '}
          <strong className="text-fg-secondary">{email}</strong>
        </p>
      )}
      <label className="block">
        <span className="mb-1 block text-[11px] text-fg-muted">
          סיסמה חדשה
        </span>
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            // No explicit dir — passwords are LTR by content but
            // we let it inherit dir="rtl" so the placeholder /
            // typed dots anchor on the right edge to match the
            // surrounding Hebrew label, same pattern as the
            // /account login form.
            className="w-full rounded-md border border-border bg-bg-elevated px-4 py-2.5 pe-12 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            tabIndex={-1}
            aria-label={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
            className="absolute inset-y-0 end-3 flex items-center text-fg-muted transition-colors hover:text-fg"
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        <span className="mt-1 block text-[10px] text-fg-muted">
          לפחות 6 תווים.
        </span>
      </label>
      {submitError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {submitError}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Lock className="h-4 w-4" />
        )}
        שמירת הסיסמה החדשה
      </button>
      <p className="pt-2 text-center text-[11px] text-fg-muted">
        אחרי השמירה תוכל לחזור לדף ההתחברות ולהיכנס עם הסיסמה החדשה.
      </p>
    </form>
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
    <div className="card-elevated rounded-2xl border-border p-6 md:p-8">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-destructive">
        <AlertCircle className="h-4 w-4" />
        פעולה לא נתמכת
      </div>
      <p className="mb-6 text-sm leading-relaxed text-fg-secondary">
        הקישור הזה ביקש פעולה שעדיין לא נתמכת באתר
        {mode ? ` (${mode})` : ''}. אם הגעת לכאן ממייל איפוס סיסמה, בקש
        קישור חדש מדף ההתחברות.
      </p>
      <Link
        to="/account"
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary-hover"
      >
        חזרה לדף החשבון
      </Link>
    </div>
  )
}

/**
 * Firebase Identity Toolkit returns errors as English constants
 * like `EXPIRED_OOB_CODE`. Translate the ones we expect to surface
 * to the user; fall through to the raw message for anything else
 * (better than a generic "something went wrong" that hides the
 * actual cause from forensics).
 */
function translateFirebaseError(msg: string): string {
  const upper = msg.toUpperCase()
  if (upper.includes('EXPIRED_OOB_CODE')) {
    return 'הקישור פג תוקף. בקש איפוס סיסמה חדש.'
  }
  if (upper.includes('INVALID_OOB_CODE')) {
    return 'הקישור לא תקין או כבר נוצל. בקש איפוס חדש.'
  }
  if (upper.includes('USER_DISABLED')) {
    return 'החשבון מושבת. פנה לתמיכה.'
  }
  if (upper.includes('USER_NOT_FOUND')) {
    return 'החשבון לא נמצא. בקש איפוס חדש מדף ההתחברות.'
  }
  if (upper.includes('WEAK_PASSWORD')) {
    return 'הסיסמה חלשה מדי. בחר סיסמה ארוכה יותר.'
  }
  return msg
}

export default AuthActionPage
