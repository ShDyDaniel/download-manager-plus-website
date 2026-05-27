import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  fetchAccountStatus,
  getSession,
  redeemProductKey,
  requestPasswordReset,
  requestSignupCode,
  signIn,
  signOut,
  subscribeSession,
  verifySignupCode,
  type DecodedSession,
} from '../lib/webSession'
import { RevisionsWorkspace as WebRevisionsWorkspace } from '../components/RevisionsWorkspace'

/**
 * Public /revisions workspace — the editor side of the Revisions
 * feature, exposed on the website so anyone with a Pro
 * subscription can manage projects from a browser instead of
 * installing the desktop app.
 *
 * Layered structure:
 *
 *   <RevisionsPage>             top-level chrome + route guard
 *     <AuthShell>               not-signed-in / unverified / no-Pro
 *       <RevisionsWorkspace />  fully-authenticated workspace
 *
 * The AuthShell sub-states are mutually exclusive — the workspace
 * only mounts once {signed in, email verified, Pro entitled} all
 * hold. This mirrors the desktop's gate ladder but adapted for
 * the lack of Firebase Web SDK on the public site: instead of
 * Firebase Auth state we read our HMAC-signed session JWT from
 * sessionStorage (see src/lib/webSession.ts).
 */

export function RevisionsPage() {
  // Hydrate from cache synchronously — getSession() reads in-memory
  // state populated at module load, so the first paint matches the
  // browser's actual auth state (no logged-out → logged-in flash
  // for a returning user).
  const [session, setSession] = useState(() => getSession())

  // Re-render on cross-tab signin/signout. The session module fires
  // listeners after adoptToken() / signOut(), so this keeps the
  // page in sync if the user signs in via /account in another tab.
  useEffect(() => subscribeSession(() => setSession(getSession())), [])

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <WorkspaceHeader />
      <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-8 md:px-8 md:pt-12">
        {session ? (
          <ProGate session={session.claims} />
        ) : (
          <AuthShell onSignedIn={() => setSession(getSession())} />
        )}
      </main>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Header — text-only, matches /account chrome
 * ────────────────────────────────────────────────────────────── */

function WorkspaceHeader() {
  const session = getSession()
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 md:px-8">
        <Link
          to="/"
          className="text-xs uppercase tracking-[0.18em] text-fg-muted transition-colors hover:text-fg"
        >
          ← דף הבית
        </Link>
        <div className="flex items-center gap-4 text-xs">
          <span className="font-medium tracking-tight text-fg">
            סבבי תיקונים
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-fg-muted">
          {session ? (
            <>
              <span dir="ltr" className="hidden truncate sm:inline">
                {session.claims.email}
              </span>
              <button
                type="button"
                onClick={() => {
                  signOut()
                }}
                className="transition-colors hover:text-fg"
              >
                התנתקות
              </button>
            </>
          ) : (
            <Link
              to="/account"
              className="transition-colors hover:text-fg"
            >
              החשבון שלי
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ProGate — once logged in, gate again on Pro entitlement
 * ────────────────────────────────────────────────────────────── */

type EntitlementState =
  | { kind: 'loading' }
  | { kind: 'pro' }
  | { kind: 'not-pro' }
  | { kind: 'error'; message: string }

function ProGate({ session }: { session: DecodedSession }) {
  const [state, setState] = useState<EntitlementState>({ kind: 'loading' })

  async function refresh(): Promise<void> {
    setState({ kind: 'loading' })
    const status = await fetchAccountStatus()
    if (!status) {
      setState({
        kind: 'error',
        message:
          'לא הצלחנו לבדוק את סטטוס המנוי כרגע. נסה שוב בעוד רגע.',
      })
      return
    }
    setState({ kind: status.hasPro ? 'pro' : 'not-pro' })
  }

  useEffect(() => {
    void refresh()
    // session.uid as dep so a user-switch (sign out + sign in as
    // someone else) re-runs the entitlement check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.uid])

  if (state.kind === 'loading') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-sm text-fg-muted">בודק מנוי…</div>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <FeedbackCard
        title="שגיאה זמנית"
        message={state.message}
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-border px-5 py-2 text-sm text-fg transition-colors hover:bg-bg-card"
          >
            נסה שוב
          </button>
        }
      />
    )
  }

  if (state.kind === 'not-pro') {
    return <NoProAccessPanel onRedeemed={() => void refresh()} />
  }

  return <RevisionsWorkspace />
}

/* ──────────────────────────────────────────────────────────────
 *  Not-Pro panel — choice between "buy" and "redeem existing key"
 * ────────────────────────────────────────────────────────────── */

function NoProAccessPanel({ onRedeemed }: { onRedeemed: () => void }) {
  const [showRedeem, setShowRedeem] = useState(false)
  return (
    <div className="mx-auto max-w-xl py-12">
      <div className="rounded-2xl border border-border bg-bg-card p-8 text-center">
        <div className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          סבבי תיקונים
        </div>
        <h1 className="mt-3 text-2xl font-medium text-fg">
          נדרש מנוי Pro פעיל
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          הפיצ'ר של סבבי התיקונים פתוח רק למשתמשי Pro. אם כבר
          רכשת מפתח, אפשר להפעיל אותו כאן. אחרת אפשר להירשם
          למנוי.
        </p>
        {showRedeem ? (
          <RedeemKeyForm
            onCancel={() => setShowRedeem(false)}
            onSuccess={() => {
              setShowRedeem(false)
              onRedeemed()
            }}
          />
        ) : (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link
              to="/buy"
              className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover"
            >
              לרכישת מנוי
            </Link>
            <button
              type="button"
              onClick={() => setShowRedeem(true)}
              className="inline-flex items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm text-fg transition-colors hover:bg-bg-card"
            >
              יש לי מפתח מוצר
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function RedeemKeyForm({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void
  onSuccess: () => void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await redeemProductKey(key)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onSuccess()
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4 text-right">
      <div>
        <label className="mb-2 block text-xs text-fg-muted">
          מפתח מוצר
        </label>
        <input
          dir="ltr"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          maxLength={19}
          className="w-full rounded-md border border-border bg-bg-elevated px-3 py-2.5 text-center font-mono text-sm tracking-widest text-fg placeholder:text-fg-faint focus:border-white/30 focus:outline-none"
        />
      </div>
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-fg-muted transition-colors hover:text-fg"
        >
          ביטול
        </button>
        <button
          type="submit"
          disabled={busy || key.length < 19}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover disabled:opacity-40"
        >
          {busy ? 'מפעיל…' : 'הפעלת מפתח'}
        </button>
      </div>
    </form>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  AuthShell — login / signup / forgot-password tabs
 * ────────────────────────────────────────────────────────────── */

type AuthMode =
  | 'signin'
  | 'signup-details'
  | 'signup-verify'
  | 'forgot'
  | 'forgot-sent'

/** Form draft shared between the two signup screens. The user
 *  fills EVERYTHING in step 1 (name + email + password + terms +
 *  optional marketing opt-in); step 2 is just the 6-digit code
 *  echo-back. This mirrors the desktop's signup UX — by the time
 *  we ask for the code, the user already knows the account they
 *  are about to create. Keeping the draft at the AuthShell level
 *  also means a user who hits "back" from the verify screen lands
 *  on a form with all their previous answers pre-filled. */
interface SignupDraft {
  name: string
  email: string
  password: string
  marketingOptIn: boolean
}

const EMPTY_SIGNUP_DRAFT: SignupDraft = {
  name: '',
  email: '',
  password: '',
  marketingOptIn: false,
}

function AuthShell({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<AuthMode>('signin')
  const [signupDraft, setSignupDraft] = useState<SignupDraft>(EMPTY_SIGNUP_DRAFT)

  return (
    <div className="mx-auto mt-8 max-w-md">
      <div className="rounded-2xl border border-border bg-bg-card p-8">
        <div className="text-center">
          <div className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            סבבי תיקונים
          </div>
          <h1 className="mt-2 text-xl font-medium text-fg">
            {mode === 'signin'
              ? 'התחברות'
              : mode === 'signup-details' || mode === 'signup-verify'
                ? 'יצירת חשבון'
                : 'איפוס סיסמה'}
          </h1>
        </div>

        <div className="mt-6">
          {mode === 'signin' && (
            <SignInForm
              onSignedIn={onSignedIn}
              onSwitchSignup={() => setMode('signup-details')}
              onSwitchForgot={() => setMode('forgot')}
            />
          )}
          {mode === 'signup-details' && (
            <SignupDetailsForm
              initial={signupDraft}
              onCodeSent={(draft) => {
                setSignupDraft(draft)
                setMode('signup-verify')
              }}
              onBack={() => setMode('signin')}
            />
          )}
          {mode === 'signup-verify' && (
            <SignupVerifyForm
              draft={signupDraft}
              onSignedIn={onSignedIn}
              onBack={() => setMode('signup-details')}
            />
          )}
          {mode === 'forgot' && (
            <ForgotForm
              onSent={() => setMode('forgot-sent')}
              onBack={() => setMode('signin')}
            />
          )}
          {mode === 'forgot-sent' && (
            <FeedbackCard
              title="המייל נשלח"
              message="שלחנו אליך קישור לאיפוס סיסמה. בדוק את תיבת הדואר וגם את תיקיית הספאם."
              action={
                <button
                  type="button"
                  onClick={() => setMode('signin')}
                  className="text-sm text-fg-muted transition-colors hover:text-fg"
                >
                  חזרה להתחברות
                </button>
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Forms (signin / signup / forgot)
 * ────────────────────────────────────────────────────────────── */

function SignInForm({
  onSignedIn,
  onSwitchSignup,
  onSwitchForgot,
}: {
  onSignedIn: () => void
  onSwitchSignup: () => void
  onSwitchForgot: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await signIn(email, password)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onSignedIn()
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        label="אימייל"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        autoFocus
      />
      <Field
        label="סיסמה"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
      />
      {error && <FieldError>{error}</FieldError>}
      <button
        type="submit"
        disabled={busy || !email || !password}
        className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover disabled:opacity-40"
      >
        {busy ? 'מתחבר…' : 'התחברות'}
      </button>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <button
          type="button"
          onClick={onSwitchSignup}
          className="transition-colors hover:text-fg"
        >
          יצירת חשבון
        </button>
        <button
          type="button"
          onClick={onSwitchForgot}
          className="transition-colors hover:text-fg"
        >
          שכחתי סיסמה
        </button>
      </div>
    </form>
  )
}

/** Step 1 of signup — collect ALL the user's details + agreements.
 *  No Firebase user is created here; we just persist the draft in
 *  the AuthShell's React state and ask the server to email a code.
 *  Step 2 only takes the code echo-back. Mirrors the desktop's
 *  signup flow so a user who's done it there already knows the
 *  rhythm. */
function SignupDetailsForm({
  initial,
  onCodeSent,
  onBack,
}: {
  initial: SignupDraft
  onCodeSent: (draft: SignupDraft) => void
  onBack: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [email, setEmail] = useState(initial.email)
  const [password, setPassword] = useState(initial.password)
  const [terms, setTerms] = useState(false)
  const [marketing, setMarketing] = useState(initial.marketingOptIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [termsModalOpen, setTermsModalOpen] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const trimmedName = name.trim()
    const trimmedEmail = email.trim().toLowerCase()
    // Client-side guards. The server re-validates everything, but
    // catching obvious issues here saves a round-trip and gives a
    // faster error message.
    if (!trimmedName) {
      setError('יש להזין שם תצוגה')
      return
    }
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('יש להזין כתובת אימייל תקינה')
      return
    }
    if (password.length < 6) {
      setError('הסיסמה חייבת להיות לפחות 6 תווים')
      return
    }
    if (!terms) {
      setError('יש לאשר את תנאי השימוש כדי להמשיך')
      return
    }
    setBusy(true)
    setError(null)
    const r = await requestSignupCode(trimmedEmail)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onCodeSent({
      name: trimmedName,
      email: trimmedEmail,
      password,
      marketingOptIn: marketing,
    })
  }

  return (
    <>
    {termsModalOpen && <TermsModal onClose={() => setTermsModalOpen(false)} />}
    <form onSubmit={submit} className="space-y-4">
      <Field
        label="שם תצוגה"
        type="text"
        autoComplete="name"
        value={name}
        onChange={setName}
        autoFocus
      />
      <Field
        label="אימייל"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
      />
      <Field
        label="סיסמה (לפחות 6 תווים)"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
      />
      <label className="flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
        <input
          type="checkbox"
          checked={terms}
          onChange={(e) => setTerms(e.target.checked)}
          className="mt-0.5 accent-current"
        />
        <span>
          אני מאשר/ת את{' '}
          <button
            type="button"
            // Opens an in-place modal with the live terms doc
            // pulled from /api/paypal?action=get-terms. We
            // deliberately don't use a real <a href> — a new tab
            // would lose the half-filled signup form. The
            // checkbox-+-link pattern matches how /buy presents
            // its subscription-terms link.
            onClick={() => setTermsModalOpen(true)}
            className="text-accent underline underline-offset-2 transition-colors hover:text-fg"
          >
            תנאי השימוש
          </button>{' '}
          של ניהול הורדות פלוס.
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
        <input
          type="checkbox"
          checked={marketing}
          onChange={(e) => setMarketing(e.target.checked)}
          className="mt-0.5 accent-current"
        />
        <span>
          אני רוצה לקבל עדכונים על תוספות, הטבות וטיפים. ניתן
          להסיר את הסכמה בכל עת.
        </span>
      </label>
      {error && <FieldError>{error}</FieldError>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
      >
        {busy ? 'שולח קוד אימות…' : 'המשך — שליחת קוד אימות'}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="block w-full text-xs text-fg-muted transition-colors hover:text-fg"
      >
        חזרה להתחברות
      </button>
    </form>
    </>
  )
}

/** Step 2 of signup — the only thing the user does here is type
 *  in the 6-digit code we just emailed. All other account fields
 *  came along in the draft from step 1. On verify success we
 *  immediately auto-signin so the user lands in the workspace
 *  without retyping their password. */
function SignupVerifyForm({
  draft,
  onSignedIn,
  onBack,
}: {
  draft: SignupDraft
  onSignedIn: () => void
  onBack: () => void
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resentChip, setResentChip] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setError('הקוד חייב להיות 6 ספרות')
      return
    }
    setBusy(true)
    setError(null)
    const verify = await verifySignupCode({
      email: draft.email,
      code,
      password: draft.password,
      name: draft.name,
      marketingOptIn: draft.marketingOptIn,
    })
    if (!verify.ok) {
      setBusy(false)
      setError(verify.error)
      return
    }
    // signup-verify-code doesn't issue a session token — sign in
    // straight away with the password the user already set in
    // step 1.
    const r = await signIn(draft.email, draft.password)
    setBusy(false)
    if (!r.ok) {
      setError(
        `החשבון נוצר, אך ההתחברות נכשלה: ${r.error}. נסה להתחבר מהמסך הראשי.`,
      )
      return
    }
    onSignedIn()
  }

  async function resend() {
    if (busy) return
    setResentChip(null)
    setError(null)
    const r = await requestSignupCode(draft.email)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setResentChip('הקוד נשלח שוב למייל.')
    setTimeout(() => setResentChip(null), 4000)
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs leading-relaxed text-fg-muted">
        שלחנו קוד 6 ספרות ל-
        <span dir="ltr" className="mx-1 text-fg">
          {draft.email}
        </span>
        . הזן אותו כדי להשלים את יצירת החשבון.
      </p>
      <Field
        label="קוד אימות (6 ספרות)"
        type="text"
        value={code}
        onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        autoFocus
        inputMode="numeric"
        dir="ltr"
        className="text-center font-mono text-lg tracking-[0.4em]"
      />
      {resentChip && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
          {resentChip}
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      <button
        type="submit"
        disabled={busy || code.length !== 6}
        className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
      >
        {busy ? 'יוצר חשבון…' : 'אימות והשלמת ההרשמה'}
      </button>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <button
          type="button"
          onClick={onBack}
          className="transition-colors hover:text-fg"
        >
          חזרה לעריכת פרטים
        </button>
        <button
          type="button"
          onClick={() => void resend()}
          className="transition-colors hover:text-fg"
        >
          שליחת קוד מחדש
        </button>
      </div>
    </form>
  )
}

function ForgotForm({
  onSent,
  onBack,
}: {
  onSent: () => void
  onBack: () => void
}) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await requestPasswordReset(email)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onSent()
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs leading-relaxed text-fg-muted">
        נשלח אליך מייל עם קישור לאיפוס סיסמה.
      </p>
      <Field
        label="אימייל"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        autoFocus
      />
      {error && <FieldError>{error}</FieldError>}
      <button
        type="submit"
        disabled={busy || !email}
        className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover disabled:opacity-40"
      >
        {busy ? 'שולח…' : 'שליחת קישור'}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="block w-full text-xs text-fg-muted transition-colors hover:text-fg"
      >
        חזרה להתחברות
      </button>
    </form>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Workspace (placeholder — port from desktop in next session)
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
    <div className="space-y-10">
      {justConnected && (
        <div className="mx-auto max-w-2xl rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-center text-sm text-success">
          החיבור ל-Google Drive הושלם בהצלחה.
        </div>
      )}
      <WorkspacePlaceholder />
    </div>
  )
}

function WorkspacePlaceholder() {
  // Workspace itself lives in src/components/RevisionsWorkspace.tsx
  // to keep this file focused on the auth ladder. It handles
  // Drive-connection state, project list rendering, the create/
  // edit/add-round modals, and Drive storage display.
  return <WebRevisionsWorkspace />
}

/* ──────────────────────────────────────────────────────────────
 *  Small primitives (Field, FieldError, FeedbackCard)
 * ────────────────────────────────────────────────────────────── */

function Field(props: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoComplete?: string
  autoFocus?: boolean
  inputMode?: 'numeric' | 'text'
  dir?: 'rtl' | 'ltr'
  className?: string
}) {
  const id = useMemo(
    () => `f${Math.random().toString(36).slice(2, 9)}`,
    [],
  )
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs text-fg-muted"
      >
        {props.label}
      </label>
      <input
        id={id}
        type={props.type || 'text'}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        dir={props.dir}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={
          'w-full rounded-md border border-border bg-bg-elevated px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-white/30 focus:outline-none ' +
          (props.className || '')
        }
      />
    </div>
  )
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
    >
      {children}
    </div>
  )
}

function FeedbackCard({
  title,
  message,
  action,
}: {
  title: string
  message: string
  action?: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-border bg-bg-card p-8 text-center">
      <h2 className="text-lg font-medium text-fg">{title}</h2>
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">
        {message}
      </p>
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Terms modal — fetched on-demand from /api/paypal?action=get-terms
 *
 *  The terms doc is the SAME one the desktop's TermsModal renders
 *  (Firestore appConfig/terms, edited via the admin panel). We
 *  fetch when the modal opens so the user always sees the latest
 *  published version even if it was updated since they landed on
 *  the page.
 * ────────────────────────────────────────────────────────────── */

interface TermsSection {
  title: string
  paragraphs: string[]
}
interface TermsDoc {
  version: number
  lastUpdated: string
  sections: TermsSection[]
}

function TermsModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; terms: TermsDoc }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' })

  // Esc-to-close — common modal expectation. Keep this lightweight;
  // we don't trap focus or do anything fancy because the modal is
  // short-lived and contains no interactive content beyond the
  // close button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/paypal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-terms' }),
        })
        const data = (await r.json()) as
          | (TermsDoc & { ok: true })
          | { ok: false; error: string }
        if (cancelled) return
        if (!data.ok) {
          setState({ kind: 'error', message: data.error })
          return
        }
        setState({ kind: 'ready', terms: data })
      } catch {
        if (cancelled) return
        setState({
          kind: 'error',
          message: 'בעיית רשת. נסו שוב בעוד רגע.',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        // Click-outside-to-close — only on the backdrop itself
        // (e.target === currentTarget), so clicks INSIDE the
        // panel don't accidentally dismiss the modal mid-read.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-bg-elevated p-6 md:p-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute left-3 top-3 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-card hover:text-fg"
          aria-label="סגור"
        >
          {/* Inline X icon — avoids importing an icon library just
              for this one glyph. 14×14 stroke-1.5 reads at the same
              weight as the editorial text around it. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <h2 className="mb-1 text-xl font-medium text-fg">תנאי השימוש</h2>
        {state.kind === 'ready' && state.terms.lastUpdated && (
          <div className="mb-5 text-xs text-fg-muted">
            עודכן: {state.terms.lastUpdated}
          </div>
        )}

        {state.kind === 'loading' && (
          <div className="py-8 text-center text-sm text-fg-muted">
            טוען…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.message}
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="space-y-5">
            {state.terms.sections.length === 0 ? (
              <p className="text-sm text-fg-muted">
                התנאים טרם פורסמו.
              </p>
            ) : (
              state.terms.sections.map((section, i) => (
                <section key={i}>
                  <h3 className="mb-2 text-sm font-semibold text-fg">
                    {section.title}
                  </h3>
                  <div className="space-y-2 text-xs leading-relaxed text-fg-muted">
                    {section.paragraphs.map((p, j) => (
                      <p key={j}>{p}</p>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
        >
          סגירה
        </button>
      </div>
    </div>
  )
}
