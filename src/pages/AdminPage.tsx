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
  KeyRound,
  Copy,
  Check,
  X,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { getClientAuth } from '../lib/firebaseClient'
import { AuthButton, AuthError, AuthHeader, AuthInput } from '../components/authUi'
import {
  adminSignIn,
  adminSignOut,
  captureGateKeyFromUrl,
  checkAdminGate,
  clearAdminToken,
  generateGateKey,
  getAdminEmail,
  getGateStatus,
  getStoredAdminToken,
  requestAdminCode,
  setGateKey,
  verifyAdminCode,
} from '../lib/adminApi'
import UsersTab from '../components/admin/UsersTab'
import KeysTab from '../components/admin/KeysTab'
import TrialsTab from '../components/admin/TrialsTab'
import DashboardTab from '../components/admin/DashboardTab'
import DataTab from '../components/admin/DataTab'

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

type Phase = 'checking' | 'blocked' | 'loading' | 'login' | 'code' | 'ready'

export default function AdminPage() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [tab, setTab] = useState<AdminTabKey>('users')
  // When we land on the code step WITHOUT having just sent a code
  // (a page refresh while signed-in, or an expired 2FA token), the
  // code screen must request one itself. After the login step it must
  // NOT — login already sent it (that was the double-email bug).
  const [codeAutoReq, setCodeAutoReq] = useState(false)

  // STEP 0 — IP gate. Before anything else (even before showing a
  // login form), ask the server whether this IP is allowed. If not,
  // the page renders nothing at all — no hint that an admin panel
  // exists here. Only if allowed do we wire up the auth listener.
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null
    // Capture a secret key handed in via the link (…/admin#k=…) before
    // probing the gate.
    captureGateKeyFromUrl()
    void (async () => {
      const open = await checkAdminGate()
      if (cancelled) return
      if (!open) {
        setPhase('blocked')
        return
      }
      setPhase('loading')
      // IP ok → resolve auth state (Firebase session persists across
      // refreshes; the 2FA token in sessionStorage does not).
      unsub = onAuthStateChanged(getClientAuth(), (user) => {
        if (cancelled) return
        if (!user) {
          setPhase('login')
          return
        }
        if (getStoredAdminToken()) {
          setPhase('ready')
        } else {
          // Direct landing on the code step → it must send a code.
          setCodeAutoReq(true)
          setPhase('code')
        }
      })
    })()
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [])

  // IP not allowed (or still probing) → render nothing. A bare dark
  // screen, indistinguishable from an empty/non-existent page.
  if (phase === 'checking' || phase === 'blocked') {
    return <div className="min-h-dvh bg-bg" />
  }

  if (phase === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg text-sm text-fg-muted">
        טוען…
      </div>
    )
  }

  if (phase === 'login') {
    return (
      <AdminLogin
        onNeedCode={() => {
          // Login already sent the code — don't double-send.
          setCodeAutoReq(false)
          setPhase('code')
        }}
      />
    )
  }

  if (phase === 'code') {
    return (
      <AdminCode
        autoRequest={codeAutoReq}
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
      // 2FA token expired/rejected mid-session → drop just the token
      // (keep the Firebase session) and re-prompt for a fresh code.
      onAuthExpired={() => {
        clearAdminToken()
        setCodeAutoReq(true)
        setPhase('code')
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
  autoRequest,
  onVerified,
  onCancel,
}: {
  autoRequest: boolean
  onVerified: () => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  // 60s resend cooldown (resets on each send).
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearTimeout(t)
  }, [cooldown])
  // Only request a code here when we arrived WITHOUT one already being
  // sent (refresh / expired token). After the login step, login sent
  // it — requesting again is the double-email bug.
  const requestedRef = useRef(false)
  useEffect(() => {
    if (!autoRequest || requestedRef.current) return
    requestedRef.current = true
    void requestAdminCode()
  }, [autoRequest])
  // A code was just sent (by login or by the effect above) — start the
  // resend cooldown immediately on mount.
  useEffect(() => {
    setCooldown(60)
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
    if (cooldown > 0) return
    setError(null)
    const r = await requestAdminCode()
    if (r.ok) {
      setResent(true)
      setCooldown(60)
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
            disabled={cooldown > 0}
            className="text-fg-muted transition-colors hover:text-fg disabled:opacity-50 disabled:hover:text-fg-muted"
          >
            {resent
              ? 'נשלח קוד חדש ✓'
              : cooldown > 0
                ? `שלח שוב (${cooldown})`
                : 'שלח קוד מחדש'}
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
  onAuthExpired,
}: {
  tab: AdminTabKey
  onTab: (t: AdminTabKey) => void
  onLogout: () => void
  onAuthExpired: () => void
}) {
  const [gateModal, setGateModal] = useState(false)
  return (
    <div className="min-h-dvh bg-bg" dir="rtl">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-14 pb-10 md:flex-row md:pt-20 md:pb-16">
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

          <div className="mt-5 hidden flex-col gap-2 md:flex">
            <button
              type="button"
              onClick={() => setGateModal(true)}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <KeyRound className="h-3.5 w-3.5" />
              מפתח גישה לדף
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <LogOut className="h-3.5 w-3.5" />
              התנתקות
            </button>
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">
          {tab === 'users' ? (
            <UsersTab onAuthExpired={onAuthExpired} />
          ) : tab === 'keys' ? (
            <KeysTab onAuthExpired={onAuthExpired} />
          ) : tab === 'trials' ? (
            <TrialsTab onAuthExpired={onAuthExpired} />
          ) : tab === 'dashboard' ? (
            <DashboardTab onAuthExpired={onAuthExpired} />
          ) : tab === 'data' ? (
            <DataTab onAuthExpired={onAuthExpired} />
          ) : (
            <TabPlaceholder tab={tab} />
          )}
        </main>
      </div>
      {gateModal && <GateKeyModal onClose={() => setGateModal(false)} />}
    </div>
  )
}

/* ── Secret-access-key management ──────────────────────────────── */
function GateKeyModal({ onClose }: { onClose: () => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [newLink, setNewLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setHasKey(await getGateStatus())
      } catch {
        setHasKey(null)
      }
    })()
  }, [])

  async function rotate() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const key = generateGateKey()
      await setGateKey(key)
      setNewLink(`${window.location.origin}/admin#k=${key}`)
      setHasKey(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'הפעולה נכשלה')
    } finally {
      setBusy(false)
    }
  }

  async function clearKey() {
    if (busy) return
    if (!window.confirm('לבטל את מפתח הגישה? הדף יהפוך נגיש ללא קישור מיוחד.'))
      return
    setBusy(true)
    setError(null)
    try {
      await setGateKey('')
      setHasKey(false)
      setNewLink(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'הפעולה נכשלה')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative w-full max-w-md rounded-xl border border-border bg-bg-elevated p-6">
        <button
          onClick={onClose}
          className="absolute left-4 top-4 rounded-md p-1 text-fg-muted hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <h2 className="text-base font-bold text-fg">מפתח גישה לדף הניהול</h2>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-fg-muted">
          מפתח סודי שמסתיר את הדף לחלוטין. מי שאין לו את הקישור עם המפתח —
          רואה דף ריק. בשרת נשמר רק טביעת-אצבע מוצפנת של המפתח, לא המפתח
          עצמו. שמור את הקישור החדש (סימנייה) בכל מכשיר שתרצה לגשת ממנו.
        </p>

        <div className="mb-4 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-sm">
          <span className="text-fg-muted">מצב נוכחי: </span>
          <span className="font-medium text-fg">
            {hasKey === null
              ? '—'
              : hasKey
                ? 'מוגדר מפתח — הדף מוסתר'
                : 'אין מפתח — הדף נגיש (מומלץ להגדיר)'}
          </span>
        </div>

        {newLink && (
          <div className="mb-4 rounded-lg border border-success/30 bg-success/5 p-3">
            <div className="mb-1.5 text-xs text-success">
              הקישור החדש שלך — שמור אותו עכשיו:
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={newLink}
                dir="ltr"
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 truncate rounded-md border border-border bg-transparent px-2 py-1.5 text-xs text-fg"
              />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(newLink)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-bg"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'הועתק' : 'העתק'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={rotate}
            disabled={busy}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {hasKey ? 'הפק מפתח חדש' : 'הפק מפתח'}
          </button>
          {hasKey && (
            <button
              type="button"
              onClick={clearKey}
              disabled={busy}
              className="rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              בטל מפתח
            </button>
          )}
        </div>
        {hasKey && !newLink && (
          <p className="mt-3 text-[11px] text-fg-faint">
            הפקת מפתח חדש תבטל את הקישורים הישנים.
          </p>
        )}
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
