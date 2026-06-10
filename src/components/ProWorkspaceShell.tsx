import { useMemo, useRef, useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  fetchAccountStatus,
  getSession,
  offerCredentialSave,
  redeemProductKey,
  requestPasswordReset,
  requestSignupCode,
  signIn,
  signOut,
  subscribeSession,
  verifySignupCode,
  type DecodedSession,
} from '../lib/webSession'
import {
  TermsModal,
  PrivacyModal,
  usePrefetchLegalDocs,
} from './LegalModals'

/**
 * ProWorkspaceShell — the shared auth + Pro-entitlement ladder used
 * by every signed-in, Pro-gated browser workspace (currently
 * /revisions and /deliveries).
 *
 * Layered structure:
 *
 *   <ProWorkspaceShell featureLabel="…">  chrome + route guard
 *     <AuthShell>                         not-signed-in / unverified
 *       <ProGate>                         no-Pro / loading / error
 *         {children}                      the actual workspace
 *
 * The children only mount once {signed in, email verified, Pro
 * entitled} all hold. This mirrors the desktop's gate ladder but
 * adapted for the lack of Firebase Web SDK on the public site:
 * instead of Firebase Auth state we read our HMAC-signed session
 * JWT from sessionStorage (see src/lib/webSession.ts).
 *
 * `featureLabel` is the human name of the feature being gated
 * ("סבבי תיקונים", "מסירה ללקוח") — it's woven into the header,
 * the auth chip, and the no-Pro panel so the same ladder reads
 * correctly for any workspace that wraps it.
 *
 * Pages that need extra pre-gate handling (e.g. /revisions' Drive
 * OAuth popup callback) do that BEFORE rendering this shell and
 * pass their fully-built workspace as children.
 */
export function ProWorkspaceShell({
  featureLabel,
  children,
}: {
  featureLabel: string
  children: React.ReactNode
}) {
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
      <WorkspaceHeader featureLabel={featureLabel} />
      <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-8 md:px-8 md:pt-12">
        {session ? (
          <ProGate session={session.claims} featureLabel={featureLabel}>
            {children}
          </ProGate>
        ) : (
          <AuthShell
            featureLabel={featureLabel}
            onSignedIn={() => setSession(getSession())}
          />
        )}
      </main>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Header — text-only, matches /account chrome
 * ────────────────────────────────────────────────────────────── */

function WorkspaceHeader({ featureLabel }: { featureLabel: string }) {
  const session = getSession()
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
      {/* 3-column grid so the centre title is TRULY centered
          regardless of how wide the side groups are (justify-between
          pushed it off-centre because the left group is wider). */}
      <div className="mx-auto grid w-full max-w-6xl grid-cols-3 items-center px-5 py-4 md:px-8">
        <div className="flex justify-start">
          <Link
            to="/"
            className="text-xs uppercase tracking-[0.18em] text-fg-muted transition-colors hover:text-fg"
          >
            ← דף הבית
          </Link>
        </div>
        <div className="flex items-center justify-center text-xs">
          <span className="font-medium tracking-tight text-fg">
            {featureLabel}
          </span>
        </div>
        <div className="flex items-center justify-end gap-4 text-xs text-fg-muted">
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

function ProGate({
  session,
  featureLabel,
  children,
}: {
  session: DecodedSession
  featureLabel: string
  children: React.ReactNode
}) {
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
    return (
      <NoProAccessPanel
        featureLabel={featureLabel}
        onRedeemed={() => void refresh()}
      />
    )
  }

  return <>{children}</>
}

/* ──────────────────────────────────────────────────────────────
 *  Not-Pro panel — choice between "buy" and "redeem existing key"
 * ────────────────────────────────────────────────────────────── */

function NoProAccessPanel({
  featureLabel,
  onRedeemed,
}: {
  featureLabel: string
  onRedeemed: () => void
}) {
  const [showRedeem, setShowRedeem] = useState(false)
  return (
    <div className="mx-auto max-w-xl py-12">
      <div className="rounded-2xl border border-border bg-bg-card p-8 text-center">
        <div className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          {featureLabel}
        </div>
        <h1 className="mt-3 text-2xl font-medium text-fg">
          נדרש מנוי Pro פעיל
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          הפיצ'ר הזה פתוח רק למשתמשי Pro. אם כבר רכשת מפתח, אפשר
          להפעיל אותו כאן. אחרת אפשר להירשם למנוי.
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

function AuthShell({
  featureLabel,
  onSignedIn,
}: {
  featureLabel: string
  onSignedIn: () => void
}) {
  // Initial mode honors a `?mode=signup` query param so callers
  // can deep-link straight into the signup flow instead of
  // landing on the login form and forcing the user to click
  // "יצירת חשבון" first. Only `signup` is honored — everything
  // else falls through to the default `signin`, so the URL
  // surface stays small.
  const [searchParams] = useSearchParams()
  const initialMode: AuthMode =
    searchParams.get('mode') === 'signup' ? 'signup-details' : 'signin'
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [signupDraft, setSignupDraft] = useState<SignupDraft>(EMPTY_SIGNUP_DRAFT)

  // `?mode=signup` is set ONLY when the user arrived via the
  // "יצירת חשבון חדש" link on /account. In that flow the user
  // didn't actively choose this feature — they just wanted an
  // account — so labelling the form with the feature chip feels
  // misleading. Hide the chip on that entry path; users who came
  // to the workspace directly still see it (it explains what
  // they're signing into).
  const cameFromAccountSignup = searchParams.get('mode') === 'signup'

  return (
    <div className="mx-auto mt-20 max-w-md md:mt-28">
      <div className="mb-8">
        {!cameFromAccountSignup && (
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
            — {featureLabel}
          </div>
        )}
        <h1
          className="font-display text-fg"
          style={{
            fontSize: 'clamp(26px, 4vw, 34px)',
            lineHeight: 1.05,
            letterSpacing: '-0.025em',
            fontWeight: 500,
          }}
        >
          {mode === 'signin'
            ? 'התחברות לחשבון שלך'
            : mode === 'signup-details' || mode === 'signup-verify'
              ? 'יצירת חשבון'
              : 'איפוס סיסמה'}
        </h1>
      </div>

      <div>
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
  // Ref to the actual <form> element. PasswordCredential's most
  // reliable constructor signature takes the form node directly —
  // it reads name + autocomplete attributes off the inputs the
  // way a real submit would.
  const formRef = useRef<HTMLFormElement>(null)

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
    // Fire the credential-save hint BEFORE the parent flips state
    // and unmounts this form.
    await offerCredentialSave(formRef.current)
    onSignedIn()
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      method="post"
      action="/api/paypal?action=session"
      className="space-y-4"
    >
      <Field
        label="אימייל"
        type="email"
        autoComplete="username email"
        name="email"
        value={email}
        onChange={setEmail}
        autoFocus
      />
      <Field
        label="סיסמה"
        type="password"
        autoComplete="current-password"
        name="password"
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

/** Step 1 of signup — collect ALL the user's details + agreements. */
function SignupDetailsForm({
  initial,
  onCodeSent,
  onBack,
}: {
  initial: SignupDraft
  onCodeSent: (draft: SignupDraft) => void
  onBack: () => void
}) {
  usePrefetchLegalDocs()
  const [name, setName] = useState(initial.name)
  const [email, setEmail] = useState(initial.email)
  const [password, setPassword] = useState(initial.password)
  const [terms, setTerms] = useState(false)
  const [marketing, setMarketing] = useState(initial.marketingOptIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [termsModalOpen, setTermsModalOpen] = useState(false)
  const [privacyModalOpen, setPrivacyModalOpen] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const trimmedName = name.trim()
    const trimmedEmail = email.trim().toLowerCase()
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
      {privacyModalOpen && (
        <PrivacyModal onClose={() => setPrivacyModalOpen(false)} />
      )}
      <form onSubmit={submit} method="post" action="#" className="space-y-4">
        <Field
          label="שם תצוגה"
          type="text"
          autoComplete="name"
          name="name"
          value={name}
          onChange={setName}
          autoFocus
        />
        <Field
          label="אימייל"
          type="email"
          autoComplete="username email"
          name="email"
          value={email}
          onChange={setEmail}
        />
        <Field
          label="סיסמה (לפחות 6 תווים)"
          type="password"
          autoComplete="new-password"
          name="new-password"
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
              onClick={() => setTermsModalOpen(true)}
              className="text-accent underline underline-offset-2 transition-colors hover:text-fg"
            >
              תנאי השימוש
            </button>{' '}
            ואת{' '}
            <button
              type="button"
              onClick={() => setPrivacyModalOpen(true)}
              className="text-accent underline underline-offset-2 transition-colors hover:text-fg"
            >
              מדיניות הפרטיות
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

/** Step 2 of signup — the 6-digit code echo-back, then auto-signin. */
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
  name?: string
}) {
  const id = useMemo(() => `f${Math.random().toString(36).slice(2, 9)}`, [])
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-fg-muted"
      >
        {props.label}
      </label>
      <input
        id={id}
        name={props.name}
        type={props.type || 'text'}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        dir={props.dir}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={
          'block w-full border-b border-border bg-transparent px-0 py-2 text-base text-fg placeholder:text-fg-faint/50 transition-colors focus:border-accent focus:outline-none ' +
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

export function FeedbackCard({
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
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">{message}</p>
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  )
}
