import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  X,
} from 'lucide-react'
import {
  requestPasswordReset,
  requestSignupCode,
  signIn,
  verifySignupCode,
} from '../lib/webSession'
import {
  TermsModal,
  PrivacyModal,
  prefetchLegalDocs,
} from './LegalModals'
import '../styles/pages/download.css'

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
 *
 * Mounted once at the app root (DownloadGate), outside any page, so it
 * carries its own `.fl` root (fl-overlay) for the redesign styles.
 */

type Mode = 'login' | 'signup' | 'forgot'
type Field = 'email' | 'name' | 'password' | 'terms' | 'code'
/** A message shown to the visitor — always Hebrew. `field` puts it under
 *  that field; otherwise it shows as a box above the button. `link` adds
 *  a follow-up action next to the text. */
type ErrMsg = { msg: string; field?: Field; link?: 'login' | 'forgot' }
type Notice = 'sent' | 'resent' | 'reset'

const MARK = '/logo-mark.svg?v=1'
const HELP = 'help.frameline@gmail.com'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Server / network messages → the approved Hebrew wording (plural address,
 *  says what to do). Anything that isn't Hebrew (a raw exception or English
 *  code) never reaches the visitor: it gets the step's generic message. */
function toHebrew(
  raw: string | undefined,
  step: 'send' | 'resend' | 'verify' | 'login',
): ErrMsg {
  const fallback: Record<typeof step, string> = {
    send: 'לא הצלחנו לשלוח את הקוד. נסו שוב.',
    resend: 'לא הצלחנו לשלוח קוד חדש. נסו שוב.',
    verify: 'אימות הקוד נכשל. נסו שוב.',
    login: 'ההתחברות נכשלה. בדקו שהאימייל והסיסמה נכונים.',
  }
  const s = (raw || '').trim()
  if (!s) return { msg: fallback[step] }
  const has = (x: string) => s.includes(x)
  const onDetails = step === 'send'

  // Sign-up: sending the code
  if (has('כתובת מייל לא תקינה') || s === 'אימייל לא תקין')
    return { msg: 'כתובת מייל לא תקינה', field: onDetails ? 'email' : undefined }
  if (has('ניתן להירשם רק עם כתובת מייל'))
    return {
      msg: 'אפשר להירשם רק עם מייל מספק מוכר, כמו Gmail, Outlook, Yahoo או iCloud.',
      field: onDetails ? 'email' : undefined,
    }
  if (has('כבר רשומה'))
    return { msg: 'כתובת המייל כבר רשומה. התחברו עם הסיסמה שלכם.', field: onDetails ? 'email' : undefined, link: 'login' }
  if (has('יותר מדי בקשות')) return { msg: 'יותר מדי בקשות. נסו שוב מאוחר יותר.' }
  if (has('שירות לא זמין כרגע')) return { msg: 'השירות לא זמין כרגע. נסו שוב בעוד רגע.' }
  if (has('שליחת המייל לא מוגדר')) return { msg: `לא הצלחנו לשלוח מייל כרגע. כתבו לנו: ${HELP}` }
  if (has('בתחזוקה')) return { msg: 'המערכת בתחזוקה קצרה. נסו שוב בעוד כמה דקות.' }
  if (has('בעיית רשת')) return { msg: 'בעיית רשת. בדקו את החיבור ונסו שוב.' }
  if (has('שגיאת שרת לא צפויה') || /^שגיאה \(\d+\)$/.test(s))
    return { msg: 'משהו השתבש אצלנו. נסו שוב בעוד רגע.' }

  // Sign-up: the code from the email
  if (s === 'קוד שגוי') return { msg: 'הקוד שגוי. בדקו את הספרות במייל ונסו שוב.', field: 'code' }
  if (has('קוד פג תוקף')) return { msg: 'תוקף הקוד פג. בקשו קוד חדש.', field: 'code' }
  if (has('ניסיונות שגויים')) return { msg: 'יותר מדי ניסיונות שגויים. בקשו קוד חדש.', field: 'code' }
  if (has('קוד אימות לא תקין')) return { msg: 'קוד האימות לא תקין. בקשו קוד חדש.', field: 'code' }
  if (has('סיסמה חייבת להיות לפחות 6'))
    return { msg: 'הסיסמה צריכה להכיל לפחות 6 תווים', field: onDetails ? 'password' : undefined }
  if (has('יצירת המשתמש נכשלה')) return { msg: 'לא הצלחנו ליצור את החשבון. נסו שוב.' }

  // Log in
  if (has('יש להזין אימייל וסיסמה') || s === 'חסרה סיסמה') return { msg: 'יש להזין אימייל וסיסמה' }
  if (has('אימייל או סיסמה שגויים')) return { msg: 'האימייל או הסיסמה שגויים.', link: 'forgot' }
  if (has('הושבת')) return { msg: `החשבון הזה הושבת. כתבו לנו: ${HELP}` }
  if (has('יותר מדי ניסיונות')) return { msg: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }
  if (has('לאמת את כתובת המייל'))
    return { msg: `צריך לאמת את כתובת המייל לפני ההתחברות. כתבו לנו: ${HELP}` }
  if (has('שירות ההתחברות')) return { msg: 'שירות ההתחברות לא זמין כרגע. נסו שוב בעוד רגע.' }
  if (has('token') || has('אסימון') || has('בטעינת המנויים'))
    return { msg: 'משהו השתבש בהתחברות. נסו שוב.' }
  if (has('התחברות נכשלה')) return { msg: fallback.login }

  // No Hebrew at all → a raw exception or code: never show it.
  if (!/[֐-׿]/.test(s))
    return { msg: step === 'login' ? 'משהו השתבש בהתחברות. נסו שוב.' : 'משהו השתבש אצלנו. נסו שוב בעוד רגע.' }
  return { msg: s }
}

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
  const [showPassword, setShowPassword] = useState(false)
  const [name, setName] = useState('')
  const [terms, setTerms] = useState(false)
  const [marketingOptIn, setMarketingOptIn] = useState(false)
  const [termsModalOpen, setTermsModalOpen] = useState(false)
  const [privacyModalOpen, setPrivacyModalOpen] = useState(false)
  const [codeSent, setCodeSent] = useState(false)
  const [code, setCode] = useState('')
  const [codeFocused, setCodeFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrMsg | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Seconds left before "resend code" is allowed again. Set to 60 on
  // every send; ticks down to 0. Stops the user spamming the endpoint.
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Reset on open so a re-open never shows stale state.
  useEffect(() => {
    if (!open) return
    // Warm the terms/privacy docs now so clicking either link opens
    // the modal instantly (no spinner / DB round-trip on click).
    prefetchLegalDocs()
    setMode('signup')
    setEmail('')
    setPassword('')
    setShowPassword(false)
    setName('')
    setTerms(false)
    setMarketingOptIn(false)
    setTermsModalOpen(false)
    setPrivacyModalOpen(false)
    setCodeSent(false)
    setCode('')
    setBusy(false)
    setError(null)
    setNotice(null)
    setCooldown(0)
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
    if (!email.trim() || !password) {
      setError({ msg: 'יש להזין אימייל וסיסמה' })
      return
    }
    setBusy(true)
    setError(null)
    const r = await signIn(email, password)
    setBusy(false)
    if (!r.ok) {
      setError(toHebrew(r.error, 'login'))
      return
    }
    onAuthed()
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!email || !EMAIL_RE.test(email)) {
      setError({ msg: 'כתובת מייל לא תקינה', field: 'email' })
      return
    }
    if (!name.trim()) {
      setError({ msg: 'יש להזין שם', field: 'name' })
      return
    }
    if (password.length < 6) {
      setError({ msg: 'הסיסמה צריכה להכיל לפחות 6 תווים', field: 'password' })
      return
    }
    if (!terms) {
      setError({ msg: 'יש לאשר את תנאי השימוש ומדיניות הפרטיות כדי להמשיך', field: 'terms' })
      return
    }
    setBusy(true)
    setError(null)
    const r = await requestSignupCode(email)
    setBusy(false)
    if (!r.ok) {
      setError(toHebrew(r.error, 'send'))
      return
    }
    setCodeSent(true)
    setCooldown(60)
    setNotice('sent')
  }

  // Resend the signup code in-place (no leaving the code screen).
  // Disabled until the 60s cooldown elapses; each send restarts it.
  async function handleResendCode() {
    if (busy || cooldown > 0) return
    setBusy(true)
    setError(null)
    const r = await requestSignupCode(email)
    setBusy(false)
    if (!r.ok) {
      setError(toHebrew(r.error, 'resend'))
      return
    }
    setCode('')
    setCooldown(60)
    setNotice('resent')
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!/^\d{6}$/.test(code)) {
      setError({ msg: 'קוד האימות הוא 6 ספרות', field: 'code' })
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
      setError(toHebrew(v.error, 'verify'))
      return
    }
    // Account created — sign in to establish a session, then proceed.
    const s = await signIn(email, password)
    setBusy(false)
    if (!s.ok) {
      setError({ msg: 'החשבון נוצר, אבל ההתחברות נכשלה. התחברו עם המייל והסיסמה.' })
      return
    }
    onAuthed()
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!email || !EMAIL_RE.test(email)) {
      setError({ msg: 'כתובת מייל לא תקינה', field: 'email' })
      return
    }
    setBusy(true)
    setError(null)
    await requestPasswordReset(email)
    setBusy(false)
    // Deliberately neutral: never reveal whether the email is registered.
    setNotice('reset')
  }

  if (!open) return null

  const fieldErr = (f: Field) => (error?.field === f ? error : null)
  const boxErr = error && !error.field ? error : null
  const codeStep = mode === 'signup' && codeSent
  const forgotSent = mode === 'forgot' && notice === 'reset'

  const errLink = (e: ErrMsg) =>
    e.link === 'login' ? (
      <>
        {' '}
        <button type="button" className="link" onClick={() => switchMode('login')}>
          התחברות
        </button>
      </>
    ) : e.link === 'forgot' ? (
      <>
        {' '}
        <button type="button" className="link" onClick={() => switchMode('forgot')}>
          שכחתם את הסיסמה?
        </button>
      </>
    ) : null

  const errBox = boxErr && (
    <div className="note err" role="alert">
      <AlertCircle className="ic" aria-hidden />
      <span>
        {boxErr.msg}
        {errLink(boxErr)}
      </span>
    </div>
  )

  const fieldMsg = (f: Field, id: string) => {
    const e = fieldErr(f)
    return e ? (
      <span className="err-msg" id={id} role="alert">
        {e.msg}
        {errLink(e)}
      </span>
    ) : null
  }

  const submitBtn = (label: string) => (
    <button type="submit" className="btn btn-p btn-block dl-go" disabled={busy}>
      {busy && <Loader2 className="ic dl-spin" aria-hidden />}
      {label}
    </button>
  )

  const eye = (
    <button
      type="button"
      className="dl-eye"
      onClick={() => setShowPassword((v) => !v)}
      aria-label={showPassword ? 'הסתרת הסיסמה' : 'הצגת הסיסמה'}
      aria-pressed={showPassword}
    >
      {showPassword ? <EyeOff className="ic" aria-hidden /> : <Eye className="ic" aria-hidden />}
    </button>
  )

  const title =
    mode === 'login' ? 'התחברות' : mode === 'forgot' ? 'איפוס סיסמה' : 'יצירת חשבון להורדה'

  return (
    <>
      <div className="fl fl-overlay">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          dir="rtl"
          className="pg-download dl-overlay"
          onClick={() => {
            if (!busy) onClose()
          }}
        >
          <div className="dl-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="dialog dl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="dl-title"
              onClick={(e) => e.stopPropagation()}
            >
              <button type="button" className="dl-x" onClick={onClose} aria-label="סגירה">
                <X className="ic" aria-hidden />
              </button>
              <img className="logo" src={MARK} alt="" width={44} height={44} />

              <div className="dl-head">
                <span className="eyebrow">
                  {codeStep ? 'הורדת התוכנה · שלב 2 מתוך 2' : 'הורדת התוכנה'}
                </span>
                <h2 className="dl-h" id="dl-title">
                  {title}
                </h2>
                {mode === 'signup' && !codeSent && (
                  <p className="dl-sub">
                    כבר יש לכם חשבון?{' '}
                    <button type="button" className="link" onClick={() => switchMode('login')}>
                      התחברות
                    </button>
                  </p>
                )}
                {mode === 'login' && <p className="dl-sub">התחברו כדי להוריד את התוכנה.</p>}
                {mode === 'forgot' && !forgotSent && (
                  <p className="dl-sub">הזינו את המייל של החשבון, ונשלח אליו קישור לאיפוס הסיסמה.</p>
                )}
              </div>

              {mode === 'login' && (
                <form className="form" onSubmit={handleLogin} noValidate>
                  <div className="field">
                    <label htmlFor="dl-li-email">אימייל</label>
                    <input
                      className="input"
                      id="dl-li-email"
                      type="email"
                      dir="ltr"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                  <div className="field">
                    <div className="dl-lblrow">
                      <label htmlFor="dl-li-pass">סיסמה</label>
                      <button type="button" className="link dl-small" onClick={() => switchMode('forgot')}>
                        שכחתי סיסמה
                      </button>
                    </div>
                    <div className="dl-pw">
                      <input
                        className={`input${error?.link === 'forgot' ? ' bad' : ''}`}
                        id="dl-li-pass"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        aria-invalid={error?.link === 'forgot' || undefined}
                      />
                      {eye}
                    </div>
                  </div>
                  {errBox}
                  {submitBtn('התחברות והורדה')}
                  <div className="dl-foot">
                    <span>
                      אין לכם חשבון?{' '}
                      <button type="button" className="link" onClick={() => switchMode('signup')}>
                        הרשמה
                      </button>
                    </span>
                  </div>
                </form>
              )}

              {mode === 'signup' && !codeSent && (
                <form className="form" onSubmit={handleSendCode} noValidate>
                  <div className="field">
                    <label htmlFor="dl-su-email">אימייל</label>
                    <input
                      className={`input${fieldErr('email') ? ' bad' : ''}`}
                      id="dl-su-email"
                      type="email"
                      dir="ltr"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      autoFocus
                      aria-invalid={!!fieldErr('email') || undefined}
                      aria-describedby={fieldErr('email') ? 'dl-su-email-e' : undefined}
                    />
                    {fieldMsg('email', 'dl-su-email-e')}
                  </div>
                  <div className="field">
                    <label htmlFor="dl-su-name">שם</label>
                    <input
                      className={`input${fieldErr('name') ? ' bad' : ''}`}
                      id="dl-su-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      aria-invalid={!!fieldErr('name') || undefined}
                      aria-describedby={fieldErr('name') ? 'dl-su-name-e' : undefined}
                    />
                    {fieldMsg('name', 'dl-su-name-e')}
                  </div>
                  <div className="field">
                    <label htmlFor="dl-su-pass">סיסמה</label>
                    <div className="dl-pw">
                      <input
                        className={`input${fieldErr('password') ? ' bad' : ''}`}
                        id="dl-su-pass"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                        aria-invalid={!!fieldErr('password') || undefined}
                        aria-describedby={fieldErr('password') ? 'dl-su-pass-e' : 'dl-su-pass-h'}
                      />
                      {eye}
                    </div>
                    {fieldMsg('password', 'dl-su-pass-e') ?? (
                      <span className="hint" id="dl-su-pass-h">
                        לפחות 6 תווים
                      </span>
                    )}
                  </div>
                  <div className="dl-checks">
                    <div>
                      <label className={`check${fieldErr('terms') ? ' bad' : ''}`}>
                        <input
                          type="checkbox"
                          checked={terms}
                          onChange={(e) => setTerms(e.target.checked)}
                          aria-required="true"
                          aria-invalid={!!fieldErr('terms') || undefined}
                          aria-describedby={fieldErr('terms') ? 'dl-su-terms-e' : undefined}
                        />
                        <span>
                          אני מאשר/ת את{' '}
                          <button type="button" className="link" onClick={() => setTermsModalOpen(true)}>
                            תנאי השימוש
                          </button>{' '}
                          ואת{' '}
                          <button type="button" className="link" onClick={() => setPrivacyModalOpen(true)}>
                            מדיניות הפרטיות
                          </button>{' '}
                          של פריימליין.
                        </span>
                      </label>
                      {fieldErr('terms') && (
                        <span className="err-msg dl-under-check" id="dl-su-terms-e" role="alert">
                          {fieldErr('terms')!.msg}
                        </span>
                      )}
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={marketingOptIn}
                        onChange={(e) => setMarketingOptIn(e.target.checked)}
                      />
                      <span>אני רוצה לקבל עדכונים על תוספות, הטבות וטיפים. ניתן להסיר את ההסכמה תמיד.</span>
                    </label>
                  </div>
                  {errBox}
                  {submitBtn('שליחת קוד אימות')}
                </form>
              )}

              {codeStep && (
                <form className="form" onSubmit={handleVerify} noValidate>
                  {notice && (
                    <div className="note info" role="status">
                      <Mail className="ic" aria-hidden />
                      <span>
                        {notice === 'resent' ? 'שלחנו קוד חדש אל ' : 'שלחנו קוד אימות אל '}
                        <bdi className="dl-mail">{email.trim()}</bdi>
                        {notice === 'resent' ? '.' : '. הזינו אותו כדי להשלים את ההרשמה.'}
                      </span>
                    </div>
                  )}
                  <div className="field dl-code">
                    <label className="lbl" htmlFor="dl-code-in">
                      קוד אימות
                    </label>
                    <div className={`otp dl-otp${fieldErr('code') ? ' bad' : ''}`}>
                      <input
                        id="dl-code-in"
                        className="dl-otp-in"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        onFocus={() => setCodeFocused(true)}
                        onBlur={() => setCodeFocused(false)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        autoFocus
                        aria-invalid={!!fieldErr('code') || undefined}
                        aria-describedby={fieldErr('code') ? 'dl-code-e' : 'dl-code-h'}
                      />
                      {Array.from({ length: 6 }, (_, i) => (
                        <span
                          key={i}
                          aria-hidden
                          className={codeFocused && i === code.length ? 'cur' : undefined}
                        >
                          {code[i] || ''}
                        </span>
                      ))}
                    </div>
                    {fieldMsg('code', 'dl-code-e') ?? (
                      <span className="hint" id="dl-code-h">
                        6 ספרות. הקוד תקף ל-15 דקות.
                      </span>
                    )}
                  </div>
                  <p className="dl-help">לא מצאתם את המייל? בדקו בתיקיית הספאם או בקידומי מכירות.</p>
                  {errBox}
                  {submitBtn('אימות והורדה')}
                  <div className="dl-foot">
                    {cooldown > 0 ? (
                      <span>
                        אפשר לשלוח קוד חדש בעוד <bdi className="num">{cooldown}</bdi> שניות
                      </span>
                    ) : (
                      <button type="button" className="link" onClick={handleResendCode} disabled={busy}>
                        <RefreshCw className="ic" aria-hidden />
                        שליחת קוד מחדש
                      </button>
                    )}
                    <button type="button" className="link dl-muted" onClick={() => switchMode('signup')}>
                      <Pencil className="ic" aria-hidden />
                      שינוי כתובת המייל
                    </button>
                  </div>
                </form>
              )}

              {mode === 'forgot' && !forgotSent && (
                <form className="form" onSubmit={handleForgot} noValidate>
                  <div className="field">
                    <label htmlFor="dl-fp-email">אימייל</label>
                    <input
                      className={`input${fieldErr('email') ? ' bad' : ''}`}
                      id="dl-fp-email"
                      type="email"
                      dir="ltr"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      autoFocus
                      aria-invalid={!!fieldErr('email') || undefined}
                      aria-describedby={fieldErr('email') ? 'dl-fp-email-e' : undefined}
                    />
                    {fieldMsg('email', 'dl-fp-email-e')}
                  </div>
                  {errBox}
                  {submitBtn('שליחת קישור לאיפוס')}
                  <div className="dl-foot">
                    <button type="button" className="link" onClick={() => switchMode('login')}>
                      <ArrowRight className="ic" aria-hidden />
                      חזרה להתחברות
                    </button>
                  </div>
                </form>
              )}

              {forgotSent && (
                <div className="form">
                  <div className="note" role="status">
                    <Mail className="ic" aria-hidden />
                    <span>אם המייל קיים במערכת, נשלח אליו קישור לאיפוס סיסמה.</span>
                  </div>
                  <p className="dl-help">
                    הקישור תקף לשעה אחת. לא מצאתם את המייל? בדקו בתיקיית הספאם או בקידומי מכירות.
                  </p>
                  <button type="button" className="btn btn-s btn-block" onClick={() => switchMode('login')}>
                    <ArrowRight className="ic" aria-hidden />
                    חזרה להתחברות
                  </button>
                  <div className="dl-foot">
                    <button type="button" className="link dl-muted" onClick={() => setNotice(null)}>
                      שליחה לכתובת אחרת
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        </motion.div>
      </div>

      {/* Live terms / privacy docs — same modals the /revisions
          sign-up uses, so the wording stays in one place. Rendered
          outside the .fl root so the redesign styles never touch them. */}
      {termsModalOpen && <TermsModal onClose={() => setTermsModalOpen(false)} />}
      {privacyModalOpen && <PrivacyModal onClose={() => setPrivacyModalOpen(false)} />}
    </>
  )
}
