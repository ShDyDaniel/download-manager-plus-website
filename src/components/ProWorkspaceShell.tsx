import { useMemo, useRef, useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
} from 'lucide-react'
import {
  fetchAccountStatus,
  getSession,
  offerCredentialSave,
  redeemProductKey,
  requestPasswordReset,
  requestSignupCode,
  signIn,
  subscribeSession,
  verifySignupCode,
  type DecodedSession,
} from '../lib/webSession'
import {
  TermsModal,
  PrivacyModal,
  usePrefetchLegalDocs,
} from './LegalModals'
import { FlPage } from './site/FlPage'
import {
  CodeBoxes,
  ErrorNote,
  LOGO_MARK,
  ShellMark,
  ShellStage,
} from './workspace/shell/ShellUi'
import '../styles/pages/workspace.css'

/**
 * ProWorkspaceShell — the shared auth + Pro-entitlement ladder used
 * by every signed-in, Pro-gated browser workspace (currently
 * /revisions and /deliveries).
 *
 * Layered structure:
 *
 *   <ProWorkspaceShell featureLabel="…">  site frame + route guard
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
 * Look: the page sits in the redesigned site frame (<FlPage>: site
 * header + footer), and the shell's own screens (sign-in, sign-up,
 * forgot password, plan gate, loading, errors) use the site look. The
 * workspace itself (children) keeps the desktop app's look — each
 * workspace wraps itself in `.app-ui` (src/styles/app-ui.css).
 *
 * `featureLabel` is the human name of the feature being gated
 * ("סבבי תיקונים", "מסירה ללקוח") — it's the page title, the
 * sign-in eyebrow and the plan-gate eyebrow, so the same ladder reads
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
    <FlPage name="workspace" chrome="full" title={featureLabel}>
      {session ? (
        <>
          <ProGate session={session.claims} featureLabel={featureLabel}>
            {/* Centred column, like the app's main area (no sidebar). */}
            <div className="ws-app">{children}</div>
          </ProGate>
        </>
      ) : (
        <AuthShell
          featureLabel={featureLabel}
          onSignedIn={() => setSession(getSession())}
        />
      )}
    </FlPage>
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
          'לא הצלחנו לבדוק את סטטוס המנוי כרגע. נסו שוב בעוד רגע.',
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
      <div className="ws-loading" role="status" aria-live="polite">
        <Loader2 className="ic ws-spin" aria-hidden />
        <span>בודקים את המנוי…</span>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <ShellStage>
        <FeedbackCard
          mark={<ShellMark tone="err" badge={<AlertTriangle className="ic" aria-hidden />} />}
          title="שגיאה זמנית"
          message={state.message}
          action={
            <button
              type="button"
              onClick={() => void refresh()}
              className="btn btn-p btn-block"
            >
              <RefreshCw className="ic" aria-hidden />
              נסו שוב
            </button>
          }
        />
      </ShellStage>
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
    <ShellStage wide>
      <div className="card ws-card center">
        <ShellMark
          badge={
            showRedeem ? (
              <KeyRound className="ic" aria-hidden />
            ) : (
              <Lock className="ic" aria-hidden />
            )
          }
        />
        <span className="eyebrow">{featureLabel}</span>
        <h1 className="ws-h">נדרש מנוי Pro פעיל</h1>
        <p className="ws-p">
          הכלי הזה פתוח למנויי Pro. אם כבר רכשתם מפתח מוצר, אפשר
          להפעיל אותו כאן. אחרת, אפשר לבחור מנוי.
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
          <div className="ws-btns two">
            <Link to="/buy" className="btn btn-p">
              לרכישת מנוי
            </Link>
            <button
              type="button"
              onClick={() => setShowRedeem(true)}
              className="btn btn-g"
            >
              <KeyRound className="ic" aria-hidden />
              יש לי מפתח מוצר
            </button>
          </div>
        )}
      </div>
    </ShellStage>
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
    <form onSubmit={submit} className="form ws-form gap-top">
      <div className="field">
        <label htmlFor="ws-redeem-key">מפתח מוצר</label>
        <input
          id="ws-redeem-key"
          className={`input ws-key${error ? ' bad' : ''}`}
          dir="ltr"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          maxLength={19}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="ws-redeem-row">
        <button
          type="submit"
          disabled={busy || key.length < 19}
          className="btn btn-p"
        >
          {busy && <Loader2 className="ic ws-spin" aria-hidden />}
          {busy ? 'מפעילים…' : 'הפעלת מפתח'}
        </button>
        <button type="button" onClick={onCancel} className="link ws-muted">
          ביטול
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
  // account — so labelling the form with the feature name feels
  // misleading. Hide it on that entry path; users who came to the
  // workspace directly still see it (it explains what they're
  // signing into).
  const cameFromAccountSignup = searchParams.get('mode') === 'signup'

  const eyebrow = [
    !cameFromAccountSignup ? featureLabel : '',
    mode === 'signup-verify' ? 'שלב 2 מתוך 2' : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const title =
    mode === 'signin'
      ? 'התחברות לחשבון'
      : mode === 'signup-details' || mode === 'signup-verify'
        ? 'יצירת חשבון'
        : 'איפוס סיסמה'

  return (
    <ShellStage>
      <div className="card ws-card">
        <img className="ws-logo" src={LOGO_MARK} alt="" width={44} height={44} />
        <div className="ws-head">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1 className="ws-h">{title}</h1>
          {mode === 'signin' && (
            <p className="ws-sub">התחברו עם החשבון שלכם בפריימליין.</p>
          )}
          {mode === 'signup-details' && (
            <p className="ws-sub">
              כבר יש לכם חשבון?{' '}
              <button
                type="button"
                className="link"
                onClick={() => setMode('signin')}
              >
                התחברות
              </button>
            </p>
          )}
          {mode === 'forgot' && (
            <p className="ws-sub">
              הזינו את המייל של החשבון, ונשלח אליו קישור לאיפוס הסיסמה.
            </p>
          )}
        </div>

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
          <div className="form">
            {/* Neutral on purpose: never reveal whether the email is
                registered. */}
            <div className="note" role="status">
              <Mail className="ic" aria-hidden />
              <span>אם המייל קיים במערכת, נשלח אליו קישור לאיפוס סיסמה.</span>
            </div>
            <p className="ws-help">
              הקישור תקף לשעה אחת. לא מצאתם את המייל? בדקו בתיקיית הספאם
              או בקידומי מכירות.
            </p>
            <button
              type="button"
              onClick={() => setMode('signin')}
              className="btn btn-s btn-block"
            >
              <ArrowRight className="ic" aria-hidden />
              חזרה להתחברות
            </button>
          </div>
        )}
      </div>
    </ShellStage>
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
      className="form ws-form"
    >
      <Field
        label="אימייל"
        type="email"
        autoComplete="username email"
        name="email"
        value={email}
        onChange={setEmail}
        autoFocus
        dir="ltr"
      />
      <Field
        label="סיסמה"
        type="password"
        autoComplete="current-password"
        name="password"
        value={password}
        onChange={setPassword}
        labelAside={
          <button
            type="button"
            onClick={onSwitchForgot}
            className="link ws-small"
          >
            שכחתי סיסמה
          </button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <button
        type="submit"
        disabled={busy || !email || !password}
        className="btn btn-p btn-block ws-go"
      >
        {busy && <Loader2 className="ic ws-spin" aria-hidden />}
        {busy ? 'מתחברים…' : 'התחברות'}
      </button>
      <div className="ws-foot">
        <span>
          אין לכם חשבון?{' '}
          <button type="button" onClick={onSwitchSignup} className="link">
            יצירת חשבון
          </button>
        </span>
      </div>
    </form>
  )
}

/** Step 1 of signup — collect ALL the user's details + agreements. */
function SignupDetailsForm({
  initial,
  onCodeSent,
}: {
  initial: SignupDraft
  onCodeSent: (draft: SignupDraft) => void
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
      <form onSubmit={submit} method="post" action="#" className="form ws-form">
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
          dir="ltr"
        />
        <Field
          label="סיסמה"
          hint="לפחות 6 תווים"
          type="password"
          autoComplete="new-password"
          name="new-password"
          value={password}
          onChange={setPassword}
        />
        <div className="ws-checks">
          <label className="check">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              aria-required="true"
            />
            <span>
              אני מאשר/ת את{' '}
              <button
                type="button"
                onClick={() => setTermsModalOpen(true)}
                className="link"
              >
                תנאי השימוש
              </button>{' '}
              ואת{' '}
              <button
                type="button"
                onClick={() => setPrivacyModalOpen(true)}
                className="link"
              >
                מדיניות הפרטיות
              </button>{' '}
              של פריימליין.
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
            />
            <span>
              אני רוצה לקבל עדכונים על תוספות, הטבות וטיפים. ניתן
              להסיר את ההסכמה תמיד.
            </span>
          </label>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button
          type="submit"
          disabled={busy}
          className="btn btn-p btn-block ws-go"
        >
          {busy && <Loader2 className="ic ws-spin" aria-hidden />}
          {busy ? 'שולחים קוד אימות…' : 'שליחת קוד אימות'}
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
        `החשבון נוצר, אך ההתחברות נכשלה: ${r.error}. נסו להתחבר מהמסך הראשי.`,
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
    <form onSubmit={submit} className="form ws-form">
      <div className="note info" role="status">
        <Mail className="ic" aria-hidden />
        <span>
          שלחנו קוד אימות אל <bdi className="ws-mailtxt">{draft.email}</bdi>.
          הזינו אותו כדי להשלים את יצירת החשבון.
        </span>
      </div>
      <div className="field ws-code">
        <label className="lbl" htmlFor="ws-code-in">
          קוד אימות
        </label>
        <CodeBoxes
          id="ws-code-in"
          value={code}
          onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          bad={!!error}
          describedBy="ws-code-h"
        />
        <span className="hint" id="ws-code-h">
          6 ספרות מהמייל.
        </span>
      </div>
      <p className="ws-help">
        לא מצאתם את המייל? בדקו בתיקיית הספאם או בקידומי מכירות.
      </p>
      {resentChip && (
        <div className="note ok" role="status">
          <Mail className="ic" aria-hidden />
          <span>{resentChip}</span>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <button
        type="submit"
        disabled={busy || code.length !== 6}
        className="btn btn-p btn-block ws-go"
      >
        {busy && <Loader2 className="ic ws-spin" aria-hidden />}
        {busy ? 'יוצרים את החשבון…' : 'אימות ויצירת החשבון'}
      </button>
      <div className="ws-foot">
        <button type="button" onClick={() => void resend()} className="link">
          <RefreshCw className="ic" aria-hidden />
          שליחת קוד מחדש
        </button>
        <button type="button" onClick={onBack} className="link ws-muted">
          <ArrowRight className="ic" aria-hidden />
          חזרה לעריכת פרטים
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
    <form onSubmit={submit} className="form ws-form">
      <Field
        label="אימייל"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        autoFocus
        dir="ltr"
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <button
        type="submit"
        disabled={busy || !email}
        className="btn btn-p btn-block ws-go"
      >
        {busy && <Loader2 className="ic ws-spin" aria-hidden />}
        {busy ? 'שולחים…' : 'שליחת קישור לאיפוס'}
      </button>
      <div className="ws-foot">
        <button type="button" onClick={onBack} className="link">
          <ArrowRight className="ic" aria-hidden />
          חזרה להתחברות
        </button>
      </div>
    </form>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Small primitives (Field, FeedbackCard)
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
  /** Small text under the input. */
  hint?: string
  /** Something at the end of the label row (e.g. "שכחתי סיסמה"). */
  labelAside?: React.ReactNode
}) {
  const id = useMemo(() => `f${Math.random().toString(36).slice(2, 9)}`, [])
  const label = <label htmlFor={id}>{props.label}</label>
  return (
    <div className="field">
      {props.labelAside ? (
        <div className="ws-lblrow">
          {label}
          {props.labelAside}
        </div>
      ) : (
        label
      )}
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
        aria-describedby={props.hint ? `${id}-h` : undefined}
        className={'input ' + (props.className || '')}
      />
      {props.hint && (
        <span className="hint" id={`${id}-h`}>
          {props.hint}
        </span>
      )}
    </div>
  )
}

export function FeedbackCard({
  title,
  message,
  action,
  mark,
}: {
  title: string
  message: string
  action?: React.ReactNode
  /** Optional logo mark with a status badge above the title. */
  mark?: React.ReactNode
}) {
  return (
    <div className="card ws-card center">
      {mark}
      <h2 className="ws-h">{title}</h2>
      <p className="ws-p">{message}</p>
      {action && <div className="ws-btns">{action}</div>}
    </div>
  )
}
