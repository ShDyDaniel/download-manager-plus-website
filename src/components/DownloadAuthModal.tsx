import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import {
  AuthButton,
  AuthError,
  AuthInput,
  AuthModeLinks,
} from './authUi'
import {
  requestPasswordReset,
  requestSignupCode,
  signIn,
  verifySignupCode,
} from '../lib/webSession'

/**
 * DownloadAuthModal — gates the app download behind a website account.
 *
 * Why: a partner referral (?ref=...) can only be attributed to a user
 * if their account is created ON THE WEBSITE (the browser is where the
 * ref lives). By requiring sign-up / log-in before the download starts,
 * every referred visitor gets a web account → guaranteed attribution.
 *
 * On success we call onAuthed(), which the caller uses to start the
 * pending download. Sign-up routes through the same verifySignupCode
 * path that stamps the referral, so attribution is automatic.
 */

type Mode = 'login' | 'signup' | 'forgot'

export function DownloadAuthModal({
  open,
  onClose,
  onAuthed,
}: {
  open: boolean
  onClose: () => void
  onAuthed: () => void
}) {
  const [mode, setMode] = useState<Mode>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [marketingOptIn, setMarketingOptIn] = useState(false)
  const [codeSent, setCodeSent] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Reset on open so a re-open never shows stale state.
  useEffect(() => {
    if (!open) return
    setMode('signup')
    setEmail('')
    setPassword('')
    setName('')
    setMarketingOptIn(false)
    setCodeSent(false)
    setCode('')
    setBusy(false)
    setError(null)
    setNotice(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setNotice(null)
    setCodeSent(false)
    setCode('')
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await signIn(email, password)
    setBusy(false)
    if (!r.ok) {
      setError(r.error || 'ההתחברות נכשלה')
      return
    }
    onAuthed()
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('כתובת מייל לא תקינה')
      return
    }
    if (password.length < 6) {
      setError('סיסמה חייבת להיות לפחות 6 תווים')
      return
    }
    setBusy(true)
    setError(null)
    const r = await requestSignupCode(email)
    setBusy(false)
    if (!r.ok) {
      setError(r.error || 'שליחת הקוד נכשלה')
      return
    }
    setCodeSent(true)
    setNotice('שלחנו קוד אימות למייל. הזינו אותו כדי להשלים את ההרשמה.')
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!/^\d{6}$/.test(code)) {
      setError('קוד האימות הוא 6 ספרות')
      return
    }
    setBusy(true)
    setError(null)
    const v = await verifySignupCode({
      email,
      code,
      password,
      name: name || undefined,
      marketingOptIn,
    })
    if (!v.ok) {
      setBusy(false)
      setError(v.error || 'אימות הקוד נכשל')
      return
    }
    // Account created — sign in to establish a session, then proceed.
    const s = await signIn(email, password)
    setBusy(false)
    if (!s.ok) {
      setError(s.error || 'ההתחברות לאחר ההרשמה נכשלה')
      return
    }
    onAuthed()
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    await requestPasswordReset(email)
    setBusy(false)
    setNotice('אם המייל קיים במערכת — נשלח אליו קישור לאיפוס סיסמה.')
  }

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        dir="rtl"
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
        onClick={() => {
          if (!busy) onClose()
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-md rounded-2xl border border-border/60 bg-bg p-7 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירה"
            className="absolute left-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="mb-6">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
              — הורדת התוכנה
            </div>
            <h2
              className="font-display text-fg"
              style={{ fontSize: 'clamp(22px,3vw,28px)', fontWeight: 500 }}
            >
              {mode === 'login'
                ? 'התחברות'
                : mode === 'forgot'
                  ? 'איפוס סיסמה'
                  : 'יצירת חשבון להורדה'}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-fg-muted">
              {mode === 'login'
                ? 'התחברו כדי להוריד את התוכנה.'
                : mode === 'forgot'
                  ? 'נשלח אליכם קישור לאיפוס הסיסמה.'
                  : 'חשבון חינמי נדרש כדי להוריד. לוקח פחות מדקה.'}
            </p>
          </div>

          {mode === 'login' && (
            <form onSubmit={handleLogin} className="space-y-5">
              <AuthInput
                label="אימייל"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                autoFocus
              />
              <AuthInput
                label="סיסמה"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />
              {error && <AuthError message={error} />}
              <AuthButton busy={busy}>התחברות והורדה</AuthButton>
              <AuthModeLinks
                items={[
                  { label: 'אין לי חשבון — הרשמה', onClick: () => switchMode('signup'), accent: true },
                  { label: 'שכחתי סיסמה', onClick: () => switchMode('forgot') },
                ]}
              />
            </form>
          )}

          {mode === 'signup' && !codeSent && (
            <form onSubmit={handleSendCode} className="space-y-5">
              <AuthInput
                label="אימייל"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                autoFocus
              />
              <AuthInput
                label="שם (אופציונלי)"
                value={name}
                onChange={setName}
                required={false}
                autoComplete="name"
              />
              <AuthInput
                label="סיסמה (לפחות 6 תווים)"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
              />
              <label className="flex cursor-pointer items-start gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={marketingOptIn}
                  onChange={(e) => setMarketingOptIn(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span>אשמח לקבל עדכונים ומבצעים במייל (אופציונלי)</span>
              </label>
              {error && <AuthError message={error} />}
              {notice && (
                <div className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2 text-xs text-fg-muted">
                  {notice}
                </div>
              )}
              <AuthButton busy={busy}>שליחת קוד אימות</AuthButton>
              <AuthModeLinks
                items={[
                  { label: 'כבר יש לי חשבון — התחברות', onClick: () => switchMode('login'), accent: true },
                ]}
              />
            </form>
          )}

          {mode === 'signup' && codeSent && (
            <form onSubmit={handleVerify} className="space-y-5">
              <AuthInput
                label="קוד אימות (6 ספרות)"
                value={code}
                onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                maxLength={6}
                autoFocus
              />
              {notice && (
                <div className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2 text-xs text-fg-muted">
                  {notice}
                </div>
              )}
              {error && <AuthError message={error} />}
              <AuthButton busy={busy}>אימות והורדה</AuthButton>
              <AuthModeLinks
                items={[
                  { label: 'שליחת קוד מחדש', onClick: () => { setCodeSent(false); setCode(''); setError(null) } },
                ]}
              />
            </form>
          )}

          {mode === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-5">
              <AuthInput
                label="אימייל"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                autoFocus
              />
              {notice && (
                <div className="rounded-md border border-border/60 bg-white/[0.02] px-3 py-2 text-xs text-fg-muted">
                  {notice}
                </div>
              )}
              {error && <AuthError message={error} />}
              <AuthButton busy={busy}>שליחת קישור לאיפוס</AuthButton>
              <AuthModeLinks
                items={[
                  { label: 'חזרה להתחברות', onClick: () => switchMode('login'), accent: true },
                ]}
              />
            </form>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
