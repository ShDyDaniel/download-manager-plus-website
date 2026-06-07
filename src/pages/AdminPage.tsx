import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { onAuthStateChanged } from 'firebase/auth'
import {
  Users as UsersIcon,
  Key as KeyIcon,
  Clock,
  BarChart3,
  Activity,
  Share2,
  DownloadCloud,
  DatabaseBackup,
  MessageSquare,
  Coins,
  Receipt,
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
  consumeWebauthnCeremonyReload,
  generateGateKey,
  getAdminEmail,
  getGateStatus,
  getStoredAdminToken,
  requestAdminCode,
  setGateKey,
  verifyAdminCode,
  tryPasskeyLogin,
} from '../lib/adminApi'
import UsersTab from '../components/admin/UsersTab'
import KeysTab from '../components/admin/KeysTab'
import TrialsTab from '../components/admin/TrialsTab'
import DashboardTab from '../components/admin/DashboardTab'
import DataTab from '../components/admin/DataTab'
import RevenueTab from '../components/admin/RevenueTab'
import ReferralsTab from '../components/admin/ReferralsTab'
import FeedbackTab from '../components/admin/FeedbackTab'
import UpdatesTab from '../components/admin/UpdatesTab'
import ReceiptsTab from '../components/admin/ReceiptsTab'
import BackupTab from '../components/admin/BackupTab'
import SettingsTab from '../components/admin/SettingsTab'

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
  | 'revenue'
  | 'referrals'
  | 'updates'
  | 'feedback'
  | 'receipts'
  | 'backup'
  | 'settings'

const TABS: { key: AdminTabKey; label: string; icon: LucideIcon }[] = [
  { key: 'users', label: 'משתמשים', icon: UsersIcon },
  { key: 'keys', label: 'מפתח מוצר', icon: KeyIcon },
  { key: 'trials', label: 'ניסיון 14 יום', icon: Clock },
  { key: 'data', label: 'נתוני שימוש', icon: BarChart3 },
  { key: 'dashboard', label: 'דשבורד', icon: Activity },
  { key: 'revenue', label: 'הכנסות', icon: Coins },
  { key: 'receipts', label: 'קבלות', icon: Receipt },
  { key: 'referrals', label: 'שותפים', icon: Share2 },
  { key: 'updates', label: 'עדכונים', icon: DownloadCloud },
  { key: 'feedback', label: 'דיווחים והצעות', icon: MessageSquare },
  { key: 'backup', label: 'גיבוי', icon: DatabaseBackup },
  { key: 'settings', label: 'הגדרות', icon: SettingsIcon },
]

type Phase = 'checking' | 'blocked' | 'loading' | 'login' | 'code' | 'ready'

// One-shot guard: true exactly once per real page load (a browser
// refresh re-evaluates the module, so it resets to true). Used to force
// a full logout on every page (re)load — see the init effect. In-app
// React re-renders/remounts DON'T reset it, so they never log you out.
let adminFreshPageLoad = true

export default function AdminPage() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [tab, setTab] = useState<AdminTabKey>('users')
  // When we land on the code step WITHOUT having just sent a code
  // (a page refresh while signed-in, or an expired 2FA token), the
  // code screen must request one itself. After the login step it must
  // NOT — login already sent it (that was the double-email bug).

  // STEP 0 — secret-key gate. Before anything else (even before showing
  // a login form), ask the server whether this device's secret access
  // key opens the gate. If not, the page renders nothing at all — no
  // hint that an admin panel exists here. Only if open do we proceed.
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
      // Refresh / fresh page load == full logout. We deliberately do
      // NOT restore an admin session across a reload: sign out of
      // Firebase AND drop the 2FA + step-up tokens, exactly like
      // clicking "התנתק", so the operator must authenticate from
      // scratch every time the page loads. The module-scoped flag makes
      // this fire once per real page load (a refresh re-runs the
      // module); in-app re-renders don't trigger it.
      //
      // EXCEPTION — mobile biometric reload: iOS Safari often reloads a
      // backgrounded tab when the Face ID / passkey sheet dismisses.
      // That reload is NOT a user refresh, and logging out there traps
      // the user in a prompt → reload → logout loop (the panel becomes
      // unusable on phones). So if a WebAuthn ceremony was started in
      // the last ~2 min, treat this load as that reload and KEEP the
      // session.
      if (adminFreshPageLoad) {
        adminFreshPageLoad = false
        if (!consumeWebauthnCeremonyReload()) {
          await adminSignOut()
          if (cancelled) return
        }
      }
      setPhase('loading')
      // Resolve auth state. After the sign-out above this is null on a
      // fresh load → the login screen; it only stays signed-in across
      // in-app navigation within the same page load.
      unsub = onAuthStateChanged(getClientAuth(), (user) => {
        if (cancelled) return
        if (!user) {
          setPhase('login')
          return
        }
        if (getStoredAdminToken()) {
          setPhase('ready')
        } else {
          // Signed in but not unlocked → the unlock step tries a
          // passkey first, falling back to the email code.
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
    return <AdminLogin onNeedCode={() => setPhase('code')} />
  }

  if (phase === 'code') {
    return (
      <AdminUnlock
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
      // Signed in — move to the unlock step, which tries a passkey
      // (Touch ID / Face ID) first and falls back to the email code.
      // The admin-only check happens there (passkey/code 403 for
      // non-admins).
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
          לאחר הסיסמה — אימות מהיר ב-Passkey (Touch ID / Face ID), או קוד למייל.
        </p>
      </div>
    </div>
  )
}
/* ── Step 2: unlock — passkey first, email code fallback ──────── */
function AdminUnlock({
  onVerified,
  onCancel,
}: {
  onVerified: () => void
  onCancel: () => void
}) {
  const [mode, setMode] = useState<'init' | 'passkey' | 'code'>('init')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [pkBusy, setPkBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Try a passkey the moment we land here. If the admin has none,
  // fall back to emailing a code automatically.
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void attempt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function attempt() {
    setPkBusy(true)
    setError(null)
    const pk = await tryPasskeyLogin()
    setPkBusy(false)
    if (pk.ok) return onVerified()
    if (pk.noPasskeys) {
      // No passkey on file → email-code path.
      await sendCode()
      setMode('code')
      return
    }
    // Has passkeys but the assertion failed / was cancelled.
    setMode('passkey')
    if (pk.error) setError(pk.error)
  }

  async function sendCode() {
    const r = await requestAdminCode()
    if (r.ok) {
      setCooldown(60)
      return true
    }
    setError(r.error || 'אינך מורשה לגשת לפאנל הניהול.')
    return false
  }

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
    const ok = await sendCode()
    if (ok) {
      setResent(true)
      setTimeout(() => setResent(false), 3000)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-5" dir="rtl">
      <div className="w-full max-w-sm">
        <AuthHeader label="— אימות דו-שלבי" title="אימות כניסה" />

        {mode === 'init' ? (
          <p className="mt-6 text-center text-sm text-fg-muted">מאמת…</p>
        ) : mode === 'passkey' ? (
          <>
            <p className="mb-5 text-center text-xs text-fg-muted">
              אשר את הכניסה עם Touch ID / Face ID.
            </p>
            {error && <AuthError message={error} />}
            <button
              type="button"
              onClick={attempt}
              disabled={pkBusy}
              className="mt-2 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {pkBusy ? 'ממתין לאימות…' : 'כניסה עם Passkey'}
            </button>
            <div className="mt-5 flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={async () => {
                  if (await sendCode()) setMode('code')
                }}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                שלח קוד למייל במקום
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                חזרה
              </button>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
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
      <div className="flex min-h-dvh flex-col md:flex-row">
        {/* Sidebar — solid full-height panel pinned to the right (RTL),
            matching the desktop admin shell. */}
        <aside className="shrink-0 border-border bg-card p-4 md:min-h-dvh md:w-60 md:border-l md:p-5">
          <div className="mb-5 flex items-center justify-between md:mb-7 md:block">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-muted">
                ADMIN
              </div>
              <h1 className="font-display text-2xl font-bold text-fg md:mt-0.5">
                פאנל ניהול
              </h1>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover md:hidden"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>

          <nav className="flex gap-1.5 overflow-x-auto md:flex-col md:gap-1 md:overflow-visible">
            {TABS.map((t) => {
              const Icon = t.icon
              const active = t.key === tab
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => onTab(t.key)}
                  className={
                    'relative flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ' +
                    (active
                      ? 'font-medium text-primary'
                      : 'text-fg-muted hover:bg-white/[0.03] hover:text-fg')
                  }
                >
                  {active && (
                    <motion.span
                      layoutId="adminActivePill"
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      className="absolute inset-0 -z-0 rounded-lg bg-primary/15"
                    />
                  )}
                  <Icon className="relative z-10 h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span className="relative z-10">{t.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="mt-5 hidden flex-col gap-2 md:flex">
            <button
              type="button"
              onClick={() => setGateModal(true)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
            >
              <KeyRound className="h-3.5 w-3.5" />
              מפתח גישה לדף
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
            >
              <LogOut className="h-3.5 w-3.5" />
              התנתקות
            </button>
          </div>
        </aside>

        {/* Content — centered comfortable-width column (like the desktop
            app), not stretched to the full width of the window. */}
        <main className="min-w-0 flex-1 p-5 md:p-8 md:pt-10">
          <div className="mx-auto w-full max-w-3xl">
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
          ) : tab === 'revenue' ? (
            <RevenueTab onAuthExpired={onAuthExpired} />
          ) : tab === 'referrals' ? (
            <ReferralsTab onAuthExpired={onAuthExpired} />
          ) : tab === 'feedback' ? (
            <FeedbackTab onAuthExpired={onAuthExpired} />
          ) : tab === 'updates' ? (
            <UpdatesTab onAuthExpired={onAuthExpired} />
          ) : tab === 'receipts' ? (
            <ReceiptsTab onAuthExpired={onAuthExpired} />
          ) : tab === 'backup' ? (
            <BackupTab onAuthExpired={onAuthExpired} />
          ) : tab === 'settings' ? (
            <SettingsTab onAuthExpired={onAuthExpired} />
          ) : (
            <TabPlaceholder tab={tab} />
          )}
          </div>
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
