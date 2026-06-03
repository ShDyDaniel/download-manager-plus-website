import { useEffect, useRef, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import {
  Users as UsersIcon,
  Key as KeyIcon,
  Clock,
  BarChart3,
  Activity,
  Share2,
  DownloadCloud,
  MessageSquare,
  Settings as SettingsIcon,
  LogOut,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import { getClientAuth } from '../lib/firebaseClient'
import { AuthButton, AuthError, AuthHeader, AuthInput } from '../components/authUi'
import {
  adminSignIn,
  adminSignOut,
  getAdminEmail,
  getStoredAdminToken,
  requestAdminCode,
  verifyAdminCode,
} from '../lib/adminApi'

/**
 * Website admin panel (/admin) — the web twin of the desktop
 * AdminPanel. Two-factor gate: Firebase email/password → an email
 * code on every login → the panel. This file owns the auth flow +
 * the shell (sidebar + tab routing); each tab's content is added in
 * later phases.
 */

type AdminTabKey =
  | 'users'
  | 'keys'
  | 'trials'
  | 'data'
  | 'dashboard'
  | 'referrals'
  | 'updates'
  | 'feedback'
  | 'settings'

const TABS: { key: AdminTabKey; label: string; icon: LucideIcon }[] = [
  { key: 'users', label: 'משתמשים', icon: UsersIcon },
  { key: 'keys', label: 'מפתח מוצר', icon: KeyIcon },
  { key: 'trials', label: 'ניסיון 14 יום', icon: Clock },
  { key: 'data', label: 'נתונים', icon: BarChart3 },
  { key: 'dashboard', label: 'דשבורד', icon: Activity },
  { key: 'referrals', label: 'שותפים', icon: Share2 },
  { key: 'updates', label: 'עדכונים', icon: DownloadCloud },
  { key: 'feedback', label: 'דיווחים והצעות', icon: MessageSquare },
  { key: 'settings', label: 'הגדרות', icon: SettingsIcon },
]

type Phase = 'loading' | 'login' | 'code' | 'ready'

export default function AdminPage() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [tab, setTab] = useState<AdminTabKey>('users')

  // Resolve the initial state from the Firebase auth session (it
  // persists across refreshes) + the sessionStorage 2FA token (does
  // not — dies with the tab).
  useEffect(() => {
    const unsub = onAuthStateChanged(getClientAuth(), (user) => {
      if (!user) {
        setPhase('login')
        return
      }
      // Signed in. If we still hold a 2FA token from this tab session,
      // go straight in (data calls will bounce us back on a 403 if it
      // turns out to be expired). Otherwise require the email code.
      setPhase(getStoredAdminToken() ? 'ready' : 'code')
    })
    return () => unsub()
  }, [])

  if (phase === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg text-sm text-fg-muted">
        טוען…
      </div>
    )
  }

  if (phase === 'login') {
    return <AdminLogin onNeedCode={() => setPhase('code')} />
  }

  if (phase === 'code') {
    return (
      <AdminCode
        onVerified={() => setPhase('ready')}
        onCancel={async () => {
          await adminSignOut()
          setPhase('login')
        }}
      />
    )
  }

  return (
    <AdminShell
      tab={tab}
      onTab={setTab}
      onLogout={async () => {
        await adminSignOut()
        setPhase('login')
      }}
    />
  )
}

/* ── Step 1: email + password ─────────────────────────────────── */
function AdminLogin({ onNeedCode }: { onNeedCode: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await adminSignIn(email, password)
      // Signed in — now ask the server to email a code. This also
      // doubles as the admin-email check: non-admins get a 403.
      const r = await requestAdminCode()
      if (!r.ok) {
        await adminSignOut()
        setError(r.error || 'אינך מורשה לגשת לפאנל הניהול.')
        return
      }
      onNeedCode()
    } catch (err) {
      setError(
        err instanceof Error && /password|credential|user/i.test(err.message)
          ? 'מייל או סיסמה שגויים.'
          : 'ההתחברות נכשלה. נסה שוב.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-5" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </span>
        </div>
        <AuthHeader label="— ניהול" title="כניסת מנהל" />
        <form onSubmit={submit} className="space-y-5">
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
          <AuthButton busy={busy}>המשך</AuthButton>
        </form>
        <p className="mt-6 text-center text-xs text-fg-muted">
          לאחר הסיסמה יישלח קוד אימות לכתובת המייל שלך.
        </p>
      </div>
    </div>
  )
}

/* ── Step 2: email code ───────────────────────────────────────── */
function AdminCode({
  onVerified,
  onCancel,
}: {
  onVerified: () => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  // If we landed here on a refresh (signed in, no token), make sure a
  // code actually got sent.
  const requestedRef = useRef(false)
  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    void requestAdminCode()
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await verifyAdminCode(code.trim())
    setBusy(false)
    if (!r.ok) {
      setError(r.error || 'קוד שגוי.')
      return
    }
    onVerified()
  }

  async function resend() {
    setError(null)
    const r = await requestAdminCode()
    if (r.ok) {
      setResent(true)
      setTimeout(() => setResent(false), 3000)
    } else {
      setError(r.error || 'שליחת הקוד נכשלה.')
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-5" dir="rtl">
      <div className="w-full max-w-sm">
        <AuthHeader label="— אימות דו-שלבי" title="הזן את קוד הכניסה" />
        <p className="mb-5 text-center text-xs text-fg-muted">
          שלחנו קוד בן 6 ספרות אל <span dir="ltr">{getAdminEmail()}</span>.
        </p>
        <form onSubmit={submit} className="space-y-5">
          <AuthInput
            label="קוד אימות"
            type="text"
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          {error && <AuthError message={error} />}
          <AuthButton busy={busy}>כניסה</AuthButton>
        </form>
        <div className="mt-5 flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={resend}
            className="text-fg-muted transition-colors hover:text-fg"
          >
            {resent ? 'נשלח קוד חדש ✓' : 'שלח קוד מחדש'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-fg-muted transition-colors hover:text-fg"
          >
            חזרה
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── The panel shell ──────────────────────────────────────────── */
function AdminShell({
  tab,
  onTab,
  onLogout,
}: {
  tab: AdminTabKey
  onTab: (t: AdminTabKey) => void
  onLogout: () => void
}) {
  return (
    <div className="min-h-dvh bg-bg" dir="rtl">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 md:flex-row md:py-12">
        {/* Sidebar */}
        <aside className="shrink-0 md:w-56">
          <div className="mb-5 flex items-center justify-between md:block">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
                — ניהול
              </div>
              <h1
                className="font-display text-fg"
                style={{ fontSize: 'clamp(22px,4vw,28px)', fontWeight: 500 }}
              >
                פאנל ניהול
              </h1>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg md:hidden"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>

          <nav className="flex gap-1.5 overflow-x-auto md:flex-col md:overflow-visible">
            {TABS.map((t) => {
              const Icon = t.icon
              const active = t.key === tab
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => onTab(t.key)}
                  className={
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ' +
                    (active
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-fg-muted hover:bg-white/[0.03] hover:text-fg')
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t.label}
                </button>
              )
            })}
          </nav>

          <button
            type="button"
            onClick={onLogout}
            className="mt-5 hidden items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg md:flex"
          >
            <LogOut className="h-3.5 w-3.5" />
            התנתקות
          </button>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">
          <TabPlaceholder tab={tab} />
        </main>
      </div>
    </div>
  )
}

function TabPlaceholder({ tab }: { tab: AdminTabKey }) {
  const label = TABS.find((t) => t.key === tab)?.label ?? ''
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-2xl border border-border/60 bg-white/[0.015] p-10 text-center">
      <div className="mb-2 text-base font-medium text-fg">{label}</div>
      <p className="max-w-sm text-sm text-fg-muted">
        הטאב הזה ייבנה בשלב הבא. כרגע עומדים על הרגליים: התחברות, אימות
        דו-שלבי ושלד הפאנל.
      </p>
    </div>
  )
}
