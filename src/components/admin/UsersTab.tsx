import { useEffect, useState } from 'react'
import {
  Users as UsersIcon,
  ShieldCheck,
  Sparkles,
  Search,
  Ban,
  Monitor,
  HardDrive,
  Loader2,
  RefreshCw,
  Key as KeyIcon,
  X,
  AlertTriangle,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

/**
 * Admin → Users tab (web). Faithful port of the desktop UsersTab:
 * list + stats + search, per-user plan chips (free / trial / pro),
 * block, clear device lock, role toggle, and a key-details modal.
 * All reads/writes go through the 2FA-gated admin endpoints.
 */

const ADMIN_EMAILS = ['dyshalts@gmail.com']
function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.includes((email || '').toLowerCase())
}

interface KeySummary {
  id: string
  key: string
  expiresAt?: string | null
  redeemedAt?: string | null
  createdAt?: string
  createdBy?: string
  subscriptionStatus?: string | null
  subscriptionId?: string | null
  planId?: string | null
  subscriptionPrice?: number | null
  subscriptionCurrency?: string | null
  subscriptionPlanDays?: number | null
  planDays?: number | null
  buyerEmail?: string | null
}

interface UserDoc {
  uid: string
  email: string
  name?: string
  role?: 'admin' | 'user'
  subscription?: string
  /** Revisions storage backend: 'r2' (new, default) | 'drive'. */
  storageBackend?: 'r2' | 'drive'
  blocked?: boolean
  deviceId?: string | null
  createdAt?: string
  lastSeenAt?: string
  lastSeenVersion?: string
  lastSeenPlatform?: string | null
  trialStatus?: string
  trialExpiresAt?: string
  /** Website last-seen (stamped when entering the web revisions
   *  workspace) — separate from lastSeenAt which is the desktop app. */
  lastSeenWebAt?: string
}

function isKeyActive(key: KeySummary | null): boolean {
  if (!key) return false
  if (!key.expiresAt) return true
  const expiry = new Date(key.expiresAt).getTime()
  if (!Number.isFinite(expiry)) return true
  const now = Date.now()
  if (expiry > now) return true
  if (key.subscriptionStatus === 'active') {
    return now - expiry <= 24 * 60 * 60 * 1000
  }
  return false
}

function isTrialActive(u: UserDoc): boolean {
  if (u.trialStatus !== 'approved' || !u.trialExpiresAt) return false
  const e = new Date(u.trialExpiresAt).getTime()
  return Number.isFinite(e) && e > Date.now()
}

function relTime(iso?: string): string {
  if (!iso) return 'מעולם לא התחבר'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'הרגע'
  if (m < 60) return `לפני ${m} ד׳`
  const h = Math.floor(m / 60)
  if (h < 24) return `לפני ${h} ש׳`
  const d = Math.floor(h / 24)
  if (d < 30) return `לפני ${d} ימים`
  return new Date(iso).toLocaleDateString('he-IL')
}

export default function UsersTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [users, setUsers] = useState<UserDoc[] | null>(null)
  const [keysByUid, setKeysByUid] = useState<Record<string, KeySummary>>({})
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [keyModal, setKeyModal] = useState<KeySummary | null>(null)

  async function load() {
    setError('')
    try {
      const r = await adminApi<{
        users: UserDoc[]
        keysByUid: Record<string, KeySummary>
      }>('admin-list-users')
      setUsers(r.users)
      setKeysByUid(r.keysByUid || {})
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'טעינה נכשלה')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const total = users?.length ?? 0
  const admins =
    users?.filter((u) => u.role === 'admin' || isAdminEmail(u.email)).length ?? 0
  const paid =
    users?.filter(
      (u) => u.subscription === 'pro' || keysByUid[u.uid],
    ).length ?? 0

  const filtered =
    users?.filter((u) => {
      if (!search) return true
      const q = search.toLowerCase()
      return (
        (u.name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q)
      )
    }) ?? []

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">משתמשים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            כל מי שנרשם או התחבר. הנתונים נשלפים בזמן אמת.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          רענן
        </button>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="משתמשים" value={total} icon={<UsersIcon className="h-4 w-4" />} />
        <Stat label="אדמינים" value={admins} icon={<ShieldCheck className="h-4 w-4" />} />
        <Stat
          label="מנויים בתשלום"
          value={paid}
          icon={<Sparkles className="h-4 w-4" />}
          accent
        />
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חפש לפי שם, מייל או UID…"
          className="w-full rounded-lg border border-border bg-transparent py-2 pr-10 pl-3 text-sm text-fg outline-none focus:border-primary"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="space-y-2">
        {users === null ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-8 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> טוען משתמשים…
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-border py-8 text-center text-sm text-fg-muted">
            {users.length === 0
              ? 'אין משתמשים עדיין'
              : 'אין משתמשים שתואמים את החיפוש'}
          </div>
        ) : (
          filtered.map((u) => (
            <UserRow
              key={u.uid}
              user={u}
              redeemedKey={keysByUid[u.uid] ?? null}
              onChange={load}
              onAuthExpired={onAuthExpired}
              onShowKey={(k) => setKeyModal(k)}
            />
          ))
        )}
      </div>

      {keyModal && (
        <KeyDetailsModal keyDoc={keyModal} onClose={() => setKeyModal(null)} />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  icon,
  accent,
}: {
  label: string
  value: number
  icon: React.ReactNode
  accent?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <div className="text-2xl font-semibold tabular-nums text-fg">{value}</div>
        <div className="text-[11px] text-fg-muted">{label}</div>
      </div>
      <div
        className={
          'flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md ' +
          (accent
            ? 'from-success to-success shadow-success/40'
            : 'from-primary to-accent shadow-primary/40')
        }
      >
        {icon}
      </div>
    </div>
  )
}

function UserRow({
  user,
  redeemedKey,
  onChange,
  onAuthExpired,
  onShowKey,
}: {
  user: UserDoc
  redeemedKey: KeySummary | null
  onChange: () => void | Promise<void>
  onAuthExpired: () => void
  onShowKey: (k: KeySummary) => void
}) {
  const [busy, setBusy] = useState<
    null | 'block' | 'device' | 'role' | 'plan' | 'storage'
  >(
    null,
  )
  const [error, setError] = useState('')

  async function run(
    kind: typeof busy,
    action: string,
    body: Record<string, unknown>,
  ) {
    if (busy) return
    setBusy(kind)
    setError('')
    try {
      await adminApi(action, body)
      await onChange()
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'הפעולה נכשלה')
    } finally {
      setBusy(null)
    }
  }

  const isAdmin = user.role === 'admin' || isAdminEmail(user.email)
  const isDrive = user.storageBackend === 'drive'
  const onTrial = isTrialActive(user)
  const isPro = user.subscription === 'pro' || isKeyActive(redeemedKey)
  const blocked = user.blocked === true
  const initial = (user.name || user.email || '?').charAt(0).toUpperCase()
  const platform =
    user.lastSeenPlatform === 'darwin'
      ? 'macOS'
      : user.lastSeenPlatform === 'win32'
        ? 'Windows'
        : user.lastSeenPlatform || '—'

  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-stretch gap-3">
        <div className="relative shrink-0">
          <div
            className={
              'flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-bold text-white ' +
              (blocked
                ? 'bg-fg-muted grayscale'
                : isAdmin
                  ? 'bg-gradient-to-br from-primary to-destructive'
                  : 'bg-primary')
            }
          >
            {initial}
          </div>
          {blocked && (
            <div className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive ring-2 ring-bg">
              <Ban className="h-2.5 w-2.5 text-white" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-fg">
              {user.name || '—'}
            </span>
            {isAdmin && <Badge tone="primary">Admin</Badge>}
            {!isAdmin && isPro && <Badge tone="success">Pro</Badge>}
            {!isAdmin && !isPro && onTrial && (
              <Badge tone="accent">ניסיון חינם</Badge>
            )}
            {!isAdmin && !isPro && !onTrial && <Badge tone="muted">חינם</Badge>}
            {blocked && <Badge tone="destructive">חסום</Badge>}
          </div>
          <div className="truncate text-right text-xs text-fg-muted" dir="ltr">
            {user.email}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-fg-faint">
            <span>תוכנה: {relTime(user.lastSeenAt)}</span>
            <span>·</span>
            <span>אתר: {relTime(user.lastSeenWebAt)}</span>
            {user.lastSeenAt && user.lastSeenVersion && (
              <>
                <span>·</span>
                <span dir="ltr">v{user.lastSeenVersion}</span>
              </>
            )}
            {user.lastSeenAt && (
              <>
                <span>·</span>
                <span dir="ltr">{platform}</span>
              </>
            )}
            {user.createdAt && (
              <>
                <span>·</span>
                <span dir="ltr">
                  נוצר {new Date(user.createdAt).toLocaleDateString('he-IL')}
                </span>
              </>
            )}
            {redeemedKey && (
              <>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => onShowKey(redeemedKey)}
                  className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent transition-colors hover:bg-accent/20"
                  dir="ltr"
                >
                  <KeyIcon className="h-2.5 w-2.5" />…{redeemedKey.key.slice(-8)}
                </button>
              </>
            )}
          </div>

          {!isAdmin && (
            <div className="flex items-center gap-1 pt-1">
              <span className="text-[10px] text-fg-faint">שנה תוכנית:</span>
              <PlanChip
                label="חינם"
                active={!isPro && !onTrial}
                disabled={!!busy}
                onClick={() =>
                  run('plan', 'admin-set-user-subscription', {
                    uid: user.uid,
                    subscription: 'free',
                  })
                }
              />
              <PlanChip
                label="ניסיון"
                active={onTrial}
                disabled={!!busy}
                onClick={() =>
                  run('plan', 'admin-approve-trial', {
                    uid: user.uid,
                    demoteFirst: isPro,
                  })
                }
              />
              <PlanChip
                label="Pro"
                active={isPro}
                disabled={!!busy}
                onClick={() =>
                  run('plan', 'admin-set-user-subscription', {
                    uid: user.uid,
                    subscription: 'pro',
                  })
                }
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end justify-between gap-2">
          <div className="text-[10px] text-fg-faint" dir="ltr">
            {user.uid.slice(0, 10)}…
          </div>
          <div className="flex items-center gap-1">
            <IconBtn
              title={blocked ? 'בטל חסימה' : 'חסום משתמש'}
              busy={busy === 'block'}
              active={blocked}
              activeClass="border-destructive/30 bg-destructive/10 text-destructive"
              onClick={() =>
                run('block', 'admin-set-user-blocked', {
                  uid: user.uid,
                  blocked: !blocked,
                })
              }
            >
              <Ban className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn
              title={user.deviceId ? 'שחרר נעילת מכשיר' : 'אין מכשיר נעול'}
              busy={busy === 'device'}
              active={!!user.deviceId}
              disabled={!user.deviceId}
              activeClass="border-accent/30 bg-accent/10 text-accent"
              onClick={() =>
                run('device', 'admin-clear-user-device', { uid: user.uid })
              }
            >
              <Monitor className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn
              title="שינוי תפקיד"
              busy={busy === 'role'}
              active={isAdmin}
              activeClass="border-primary/30 bg-primary/10 text-primary"
              onClick={() =>
                run('role', 'admin-set-user-role', {
                  uid: user.uid,
                  role: isAdmin ? 'user' : 'admin',
                })
              }
            >
              <ShieldCheck className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn
              title={
                isDrive
                  ? 'אחסון סבבים: גוגל דרייב (לחץ למעבר למערכת החדשה R2)'
                  : 'אחסון סבבים: מערכת חדשה R2 (לחץ למעבר לגוגל דרייב)'
              }
              busy={busy === 'storage'}
              active={isDrive}
              activeClass="border-amber-400/30 bg-amber-400/10 text-amber-400"
              onClick={() =>
                run('storage', 'admin-set-user-storage', {
                  uid: user.uid,
                  storageBackend: isDrive ? 'r2' : 'drive',
                })
              }
            >
              <HardDrive className="h-3.5 w-3.5" />
            </IconBtn>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'primary' | 'success' | 'accent' | 'destructive' | 'muted'
}) {
  const cls = {
    primary: 'border-primary/30 bg-primary/10 text-primary',
    success: 'border-success/30 bg-success/10 text-success',
    accent: 'border-accent/30 bg-accent/10 text-accent',
    destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
    muted: 'border-border bg-white/[0.03] text-fg-muted',
  }[tone]
  return (
    <span
      className={
        'rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ' +
        cls
      }
    >
      {children}
    </span>
  )
}

function PlanChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        'rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-50 ' +
        (active
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border text-fg-muted hover:text-fg')
      }
    >
      {label}
    </button>
  )
}

function IconBtn({
  children,
  title,
  busy,
  active,
  activeClass,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  title: string
  busy?: boolean
  active?: boolean
  activeClass?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || busy}
      onClick={onClick}
      className={
        'flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:opacity-40 ' +
        (active ? activeClass || '' : 'border-border text-fg-muted hover:text-fg')
      }
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  )
}

function KeyDetailsModal({
  keyDoc,
  onClose,
}: {
  keyDoc: KeySummary
  onClose: () => void
}) {
  function fmt(s?: string | null): string {
    if (!s) return '—'
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('he-IL')
  }
  const createdLabel = (() => {
    const cb = keyDoc.createdBy || ''
    if (cb.startsWith('admin-grant:')) return `הענקת אדמין (${cb.slice(12)})`
    if (cb.includes('yearly')) return 'PayPal — מנוי שנתי'
    if (cb.includes('monthly')) return 'PayPal — מנוי חודשי'
    if (cb.startsWith('paypal')) return 'PayPal'
    if (cb === 'manual') return 'ידני'
    return cb || '—'
  })()
  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-bg-elevated p-6">
        <button
          onClick={onClose}
          className="absolute left-4 top-4 rounded-md p-1 text-fg-muted hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15">
            <KeyIcon className="h-5 w-5 text-accent" />
          </div>
          <h2 className="text-base font-bold text-fg">פרטי מפתח מוצר</h2>
        </div>
        <div className="space-y-2 text-sm">
          <Field label="מפתח" value={keyDoc.key} mono />
          <Field label="מקור" value={createdLabel} />
          <Field label="נוצר" value={fmt(keyDoc.createdAt)} />
          <Field label="מומש" value={fmt(keyDoc.redeemedAt)} />
          <Field label="תוקף" value={fmt(keyDoc.expiresAt)} />
          {keyDoc.subscriptionStatus && (
            <Field label="סטטוס מנוי" value={keyDoc.subscriptionStatus} />
          )}
          {keyDoc.subscriptionId && (
            <Field label="מזהה מנוי" value={keyDoc.subscriptionId} mono />
          )}
          {keyDoc.subscriptionPrice != null && (
            <Field
              label="מחיר"
              value={`${keyDoc.subscriptionPrice} ${keyDoc.subscriptionCurrency || ''}`}
            />
          )}
          {keyDoc.buyerEmail && (
            <Field label="מייל קונה" value={keyDoc.buyerEmail} mono />
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg bg-background px-3 py-2">
      <span className="shrink-0 text-xs text-fg-muted">{label}</span>
      <span
        className={'text-left text-fg ' + (mono ? 'font-mono text-xs' : 'text-sm')}
        dir={mono ? 'ltr' : undefined}
      >
        {value}
      </span>
    </div>
  )
}
