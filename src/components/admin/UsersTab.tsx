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
  AlertTriangle,
  Trash2,
  X,
  Film,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { Portal } from '@/components/ui/Portal'
import { adminApi } from '../../lib/adminApi'
import { cachedAdminApi, peekAdminCache } from '../../lib/adminCache'
import { KeyDetailsModal } from './KeyDetailsModal'

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
  /** Plan level the key grants (basic/pro/ultra); older keys omit it → pro. */
  tier?: string
  redeemedBy?: string | null
  redeemedByEmail?: string | null
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
  nonPaidGrant?: boolean
  grantReason?: string | null
  grantedByAdmin?: string | null
  subscriptionCancelledAt?: string | null
  subscriptionCancelReason?: string | null
  autoRedeemedFromWebhook?: boolean
  billingHistory?: unknown[]
  replacedPriorKeys?: unknown[]
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
  /** Why the account was blocked (e.g. 'quota-abuse' from the daily audit). */
  blockReason?: string
  blockedAt?: string
  /** Usage snapshot captured when the audit blocked the user. */
  blockDetails?: {
    tier?: string
    storage?: { usedGb?: number; limitGb?: number }
    transcription?: { usedSec?: number; limitSec?: number }
    tokens?: { used?: number; limit?: number }
  }
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
  // A timestamp well in the FUTURE means that machine's clock is skewed
  // (older builds stamped lastSeenAt from the local clock). Don't show a
  // misleading "just now" — fall back to the absolute date.
  if (diff < -2 * 60000) return new Date(iso).toLocaleDateString('he-IL')
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'הרגע'
  if (m < 60) return `לפני ${m} ד׳`
  const h = Math.floor(m / 60)
  if (h < 24) return `לפני ${h} ש׳`
  const d = Math.floor(h / 24)
  if (d < 30) return `לפני ${d} ימים`
  return new Date(iso).toLocaleDateString('he-IL')
}

const GB = 1024 * 1024 * 1024

/** Bytes → compact human size (MB/GB), Hebrew-friendly. */
function fmtBytes(bytes: number): string {
  const b = Number(bytes) || 0
  if (b <= 0) return '0'
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < GB) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / GB).toFixed(2)} GB`
}

/** GB with at most one decimal, trimming a trailing ".0". */
function fmtGb(bytes: number): string {
  const g = (Number(bytes) || 0) / GB
  return (g >= 10 ? g.toFixed(0) : g.toFixed(1)).replace(/\.0$/, '')
}

interface UserUsage {
  usedBytes: number
  count: number
}
interface StorageQuota {
  proBytes: number
  trialBytes: number
  betaMode: boolean
}
interface StorageObject {
  id: string
  kind: 'round' | 'delivery' | 'other'
  name: string
  size: number
  lastModified: number
  count: number
  folder?: string
  roundId?: string
  deliveryId?: string
  key?: string
}

export default function UsersTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  // Seed from the session cache so re-entering the tab paints the last
  // data instantly — no loading flash, no read. load() then refreshes
  // in the background (free within the TTL).
  const seed = peekAdminCache<{
    users: UserDoc[]
    keysByUid: Record<string, KeySummary>
  }>('admin-list-users')
  const [users, setUsers] = useState<UserDoc[] | null>(seed?.users ?? null)
  const [keysByUid, setKeysByUid] = useState<Record<string, KeySummary>>(
    seed?.keysByUid ?? {},
  )
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [keyModal, setKeyModal] = useState<KeySummary | null>(null)
  // Per-user R2 storage: usage map (one full-bucket scan) + the pro/trial
  // quota so each row can render "used / allocated". Loaded lazily after
  // the user list so it never blocks the first paint.
  const [usageByUid, setUsageByUid] = useState<Record<string, UserUsage> | null>(
    null,
  )
  const [quota, setQuota] = useState<StorageQuota | null>(null)
  const [storageModal, setStorageModal] = useState<{
    uid: string
    email: string
    name?: string
  } | null>(null)

  async function loadStorage() {
    try {
      const r = await adminApi<{
        usageByUid: Record<string, UserUsage>
        proBytes: number
        trialBytes: number
        betaMode?: boolean
      }>('admin-users-storage', {})
      setUsageByUid(r.usageByUid || {})
      setQuota({
        proBytes: r.proBytes,
        trialBytes: r.trialBytes,
        betaMode: r.betaMode === true,
      })
    } catch {
      // Non-fatal: the row just shows "—" for storage. Auth errors are
      // already surfaced by the main list load.
    }
  }

  // force = bypass the session cache (refresh button + after a mutation).
  // A plain mount uses the cache, so bouncing back to this tab within a
  // few minutes costs zero reads.
  async function load(force = false) {
    setError('')
    if (force) setRefreshing(true)
    try {
      const r = await cachedAdminApi<{
        users: UserDoc[]
        keysByUid: Record<string, KeySummary>
      }>('admin-list-users', {}, { force })
      setUsers(r.users)
      setKeysByUid(r.keysByUid || {})
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'טעינה נכשלה')
    } finally {
      if (force) setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
    void loadStorage()
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
          onClick={() => {
            void load(true)
            void loadStorage()
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-60"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
          />
          {refreshing ? 'מרענן…' : 'רענן'}
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
              usage={usageByUid ? usageByUid[u.uid] ?? { usedBytes: 0, count: 0 } : null}
              quota={quota}
              onChange={() => load(true)}
              onAuthExpired={onAuthExpired}
              onShowKey={(k) => setKeyModal(k)}
              onOpenStorage={(uid, email, name) =>
                setStorageModal({ uid, email, name })
              }
            />
          ))
        )}
      </div>

      {keyModal && (
        <KeyDetailsModal keyDoc={keyModal} onClose={() => setKeyModal(null)} />
      )}
      {storageModal && (
        <UserStorageModal
          uid={storageModal.uid}
          email={storageModal.email}
          name={storageModal.name}
          onClose={() => setStorageModal(null)}
          onAuthExpired={onAuthExpired}
          onChanged={() => void loadStorage()}
        />
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
  usage,
  quota,
  onChange,
  onAuthExpired,
  onShowKey,
  onOpenStorage,
}: {
  user: UserDoc
  redeemedKey: KeySummary | null
  usage: UserUsage | null
  quota: StorageQuota | null
  onChange: () => void | Promise<void>
  onAuthExpired: () => void
  onShowKey: (k: KeySummary) => void
  onOpenStorage: (uid: string, email: string, name?: string) => void
}) {
  const [busy, setBusy] = useState<
    null | 'block' | 'device' | 'role' | 'plan' | 'storage' | 'delete'
  >(
    null,
  )
  const [error, setError] = useState('')
  // Hard-delete confirmation: requires typing the user's email.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmText, setConfirmText] = useState('')

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

  async function del() {
    if (busy) return
    setBusy('delete')
    setError('')
    try {
      await adminApi('admin-delete-user', { uid: user.uid })
      setConfirmDelete(false)
      setConfirmText('')
      await onChange()
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'המחיקה נכשלה')
    } finally {
      setBusy(null)
    }
  }

  const isAdmin = user.role === 'admin' || isAdminEmail(user.email)
  const isDrive = user.storageBackend === 'drive'
  const onTrial = isTrialActive(user)
  // Effective tier = the higher of the subscription field and an active key.
  const TIER_RANK: Record<string, number> = { free: 0, basic: 1, pro: 2, ultra: 3 }
  const subTier = String(user.subscription || 'free')
  const keyTier = isKeyActive(redeemedKey) ? String(redeemedKey?.tier || 'pro') : 'free'
  const effectiveTier =
    (TIER_RANK[keyTier] ?? 0) > (TIER_RANK[subTier] ?? 0) ? keyTier : subTier
  const isPro = (TIER_RANK[effectiveTier] ?? 0) >= TIER_RANK.pro
  // Allocated bytes reflect the account's CURRENT state:
  //   Pro            → full pro quota
  //   active trial   → trial quota
  //   free + beta ON → pro quota (beta grants everyone)
  //   free + beta OFF→ 0 (no paid storage)
  const limitBytes = quota
    ? isPro
      ? quota.proBytes
      : onTrial
        ? quota.trialBytes
        : quota.betaMode
          ? quota.proBytes
          : 0
    : 0
  const usedBytes = usage?.usedBytes ?? 0
  const usePct =
    limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0
  const storageOver = limitBytes > 0 && usedBytes > limitBytes
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
      <div className="flex flex-wrap items-stretch gap-3">
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
            {!isAdmin && effectiveTier !== 'free' && (
              <Badge tone="success">
                {effectiveTier === 'ultra' ? 'Ultra' : effectiveTier === 'basic' ? 'Basic' : 'Pro'}
              </Badge>
            )}
            {!isAdmin && effectiveTier === 'free' && onTrial && (
              <Badge tone="accent">ניסיון חינם</Badge>
            )}
            {!isAdmin && effectiveTier === 'free' && !onTrial && (
              <Badge tone="muted">חינם</Badge>
            )}
            {blocked && <Badge tone="destructive">חסום</Badge>}
          </div>
          <div className="truncate text-right text-xs text-fg-muted" dir="ltr">
            {user.email}
          </div>
          {blocked && user.blockReason === 'quota-abuse' && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
              <span className="font-semibold">נחסם אוטומטית — חריגת מכסה</span>
              {user.blockedAt && (
                <span className="text-destructive/70">
                  {' '}· {new Date(user.blockedAt).toLocaleDateString('he-IL')}
                </span>
              )}
              <div className="mt-0.5 space-y-0.5 text-destructive/90">
                {user.blockDetails?.storage && (
                  <div>
                    אחסון: {user.blockDetails.storage.usedGb}GB מתוך{' '}
                    {user.blockDetails.storage.limitGb}GB
                  </div>
                )}
                {user.blockDetails?.transcription && (
                  <div>
                    תמלול: {Math.round((user.blockDetails.transcription.usedSec ?? 0) / 60)} דק' מתוך{' '}
                    {Math.round((user.blockDetails.transcription.limitSec ?? 0) / 60)} דק'
                  </div>
                )}
                {user.blockDetails?.tokens && (
                  <div>
                    טוקנים: {(user.blockDetails.tokens.used ?? 0).toLocaleString()} מתוך{' '}
                    {(user.blockDetails.tokens.limit ?? 0).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
          )}
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
            <div className="flex flex-wrap items-center gap-1 pt-1">
              <span className="text-[10px] text-fg-faint">שנה תוכנית:</span>
              <PlanChip
                label="חינם"
                active={effectiveTier === 'free' && !onTrial}
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
              {(['basic', 'pro', 'ultra'] as const).map((t) => (
                <PlanChip
                  key={t}
                  label={t === 'basic' ? 'Basic' : t === 'pro' ? 'Pro' : 'Ultra'}
                  active={effectiveTier === t && !onTrial}
                  disabled={!!busy}
                  onClick={() =>
                    run('plan', 'admin-set-user-subscription', {
                      uid: user.uid,
                      subscription: t,
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex w-full flex-col gap-1.5 border-t border-border/60 pt-2 sm:w-[220px] sm:shrink-0 sm:border-0 sm:pt-0">
          {/* Account id — top of the column. */}
          <div className="text-[10px] text-fg-faint" dir="ltr">
            {user.uid.slice(0, 10)}…
          </div>
          {/* Storage: used / allocated — borderless. Click to inspect. */}
          <button
            type="button"
            onClick={() => onOpenStorage(user.uid, user.email, user.name)}
            title="הצג קבצי אחסון · לחץ לצפייה ומחיקה"
            className="flex w-full items-center gap-2 rounded-md py-0.5 text-right transition-opacity hover:opacity-80"
          >
            <HardDrive
              className={
                'h-3.5 w-3.5 shrink-0 ' +
                (storageOver ? 'text-destructive' : 'text-fg-muted')
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={
                    'text-[11px] font-medium tabular-nums ' +
                    (storageOver ? 'text-destructive' : 'text-fg')
                  }
                  dir="ltr"
                >
                  {usage === null || quota === null
                    ? '—'
                    : `${fmtGb(usedBytes)} / ${fmtGb(limitBytes)} GB`}
                </span>
                {usage && usage.count > 0 && (
                  <span className="text-[10px] text-fg-faint">
                    {usage.count} קבצים
                  </span>
                )}
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                <div
                  className={
                    'h-full rounded-full ' +
                    (storageOver
                      ? 'bg-destructive'
                      : usePct > 80
                        ? 'bg-amber-400'
                        : 'bg-primary')
                  }
                  style={{ width: `${usage && quota ? usePct : 0}%` }}
                />
              </div>
            </div>
          </button>

          <div className="flex flex-wrap items-center gap-1">
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
            {!isAdmin && (
              <IconBtn
                title="מחק משתמש לצמיתות"
                busy={busy === 'delete'}
                active={false}
                activeClass=""
                onClick={() => {
                  setConfirmText('')
                  setError('')
                  setConfirmDelete(true)
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </IconBtn>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div className="mt-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-start gap-2 text-[12px] text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <div className="font-semibold">מחיקת משתמש לצמיתות</div>
              <p className="text-[11px] leading-relaxed text-fg-muted">
                פעולה זו תמחק את המשתמש ואת כל המידע שלו מכל המערכות: חשבון,
                מפתחות ומנויים, סבבי תיקונים והקבצים שלהם, טביעות ניסיון
                והחשבון עצמו. מנוי פעיל בפייפאל יבוטל. רשומות מס נשמרות כחוק.
                אי אפשר לבטל.
              </p>
              <p className="text-[11px] text-fg-muted">
                להמשך, הקלד את המייל של המשתמש:{' '}
                <span dir="ltr" className="font-mono text-fg">
                  {user.email || '—'}
                </span>
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              dir="ltr"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={user.email || ''}
              className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-fg outline-none focus:border-destructive"
            />
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false)
                setConfirmText('')
              }}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-popover"
            >
              ביטול
            </button>
            <button
              type="button"
              disabled={
                busy === 'delete' ||
                !user.email ||
                confirmText.trim().toLowerCase() !==
                  (user.email || '').trim().toLowerCase()
              }
              onClick={del}
              className="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy === 'delete' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              מחק לצמיתות
            </button>
          </div>
        </div>
      )}

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

/** Storage item → Hebrew type label + tone for the chip. */
function itemLabel(it: StorageObject): { label: string; cls: string } {
  if (it.kind === 'round')
    return {
      label: 'סבב תיקונים',
      cls: 'border-sky-400/30 bg-sky-400/10 text-sky-400',
    }
  if (it.kind === 'delivery')
    return { label: 'מסירה', cls: 'border-primary/30 bg-primary/10 text-primary' }
  if (it.folder === 'notes')
    return { label: 'הערה', cls: 'border-accent/30 bg-accent/10 text-accent' }
  return { label: 'אחר', cls: 'border-border bg-bg-elevated text-fg-muted' }
}

/**
 * Per-user storage inspector. Lists every object under the user's R2
 * prefix (name, type, size, upload time) and lets the admin delete any
 * one of them — the delete is step-up (biometric) gated and also
 * reconciles the referencing Firestore doc on the server.
 */
function UserStorageModal({
  uid,
  email,
  name,
  onClose,
  onAuthExpired,
  onChanged,
}: {
  uid: string
  email: string
  name?: string
  onClose: () => void
  onAuthExpired: () => void
  onChanged: () => void
}) {
  const [items, setItems] = useState<StorageObject[] | null>(null)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function load() {
    setError('')
    try {
      const r = await adminApi<{ items: StorageObject[] }>(
        'admin-list-user-storage',
        { uid },
      )
      setItems(r.items || [])
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'טעינת הקבצים נכשלה')
      setItems([])
    }
  }

  useEffect(() => {
    void load()
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

  async function del(it: StorageObject, purge: boolean) {
    if (deleting) return
    setDeleting(it.id)
    setError('')
    try {
      const payload: Record<string, unknown> = { uid, purge }
      if (it.roundId) payload.roundId = it.roundId
      else if (it.deliveryId) {
        payload.deliveryId = it.deliveryId
        payload.key = it.key
      } else payload.key = it.key
      await adminApi('admin-delete-user-object', payload)
      setItems((prev) => (prev ? prev.filter((i) => i.id !== it.id) : prev))
      setPendingDelete(null)
      onChanged()
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'המחיקה נכשלה')
    } finally {
      setDeleting(null)
    }
  }

  const totalBytes = (items || []).reduce((s, i) => s + (i.size || 0), 0)

  return (
    <Portal>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-md"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          dir="rtl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary" />
                <h3 className="text-base font-semibold text-fg">אחסון המשתמש</h3>
              </div>
              <div className="mt-0.5 truncate text-xs text-fg-muted">
                {name ? `${name} · ` : ''}
                <span dir="ltr">{email}</span>
              </div>
              {items !== null && (
                <div className="mt-1 text-[11px] text-fg-faint">
                  {items.length} קבצים · סה״כ{' '}
                  <span dir="ltr" className="tabular-nums">
                    {fmtBytes(totalBytes)}
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-fg-muted transition-colors hover:bg-popover hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {error && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
              </div>
            )}
            {items === null ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> טוען קבצים…
              </div>
            ) : items.length === 0 ? (
              <div className="py-10 text-center text-sm text-fg-muted">
                אין קבצים באחסון של המשתמש הזה
              </div>
            ) : (
              <div className="space-y-1.5">
                {items.map((it) => {
                  const fl = itemLabel(it)
                  const isConfirming = pendingDelete === it.id
                  const isDeleting = deleting === it.id
                  return (
                    <div
                      key={it.id}
                      className="rounded-xl border border-border bg-bg-elevated/40 p-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-popover text-fg-muted">
                          <Film className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate text-[13px] font-medium text-fg"
                            title={it.name}
                            dir="ltr"
                          >
                            {it.name}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-fg-faint">
                            <span
                              className={
                                'rounded border px-1 py-px text-[9px] ' + fl.cls
                              }
                            >
                              {fl.label}
                            </span>
                            <span dir="ltr" className="tabular-nums">
                              {fmtBytes(it.size)}
                            </span>
                            {it.kind === 'round' && it.count > 1 && (
                              <>
                                <span>·</span>
                                <span>כולל {it.count} קבצים</span>
                              </>
                            )}
                            {it.lastModified > 0 && (
                              <>
                                <span>·</span>
                                <span dir="ltr">
                                  {new Date(it.lastModified).toLocaleString(
                                    'he-IL',
                                    {
                                      dateStyle: 'short',
                                      timeStyle: 'short',
                                    },
                                  )}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {!isConfirming && (
                          <button
                            type="button"
                            onClick={() => setPendingDelete(it.id)}
                            disabled={!!deleting}
                            title="מחק מהאחסון"
                            className="shrink-0 rounded-md border border-border p-1.5 text-fg-muted transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {isConfirming &&
                        (it.kind === 'round' || it.kind === 'delivery' ? (
                          // Rounds + deliveries have a backing record in the
                          // app → offer both "free storage only" and "remove
                          // from the app entirely".
                          <div className="mt-2 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
                            <div className="text-[11px] text-destructive">
                              {it.kind === 'round' && it.count > 1
                                ? `מחיקת הסבב וכל ${it.count} הקבצים שבו:`
                                : it.kind === 'delivery'
                                  ? 'מחיקת המסירה:'
                                  : 'מחיקה:'}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => del(it, false)}
                                disabled={isDeleting}
                                title="משחרר את הנפח מהאחסון; הרשומה נשארת (מסומנת כמאורכבת)"
                                className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : null}
                                מחק מהאחסון בלבד
                              </button>
                              <button
                                type="button"
                                onClick={() => del(it, true)}
                                disabled={isDeleting}
                                title="מוחק לגמרי · גם מהתוכנה של המשתמש, בלי להשאיר רשומה ריקה"
                                className="flex items-center gap-1 rounded-md bg-destructive px-2.5 py-1 text-[11px] font-medium text-white hover:bg-destructive/90 disabled:opacity-60"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                                מחק מהמערכת לגמרי
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(null)}
                                disabled={isDeleting}
                                className="rounded-md px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-40"
                              >
                                ביטול
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
                            <span className="text-[11px] text-destructive">
                              למחוק לצמיתות מהאחסון?
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setPendingDelete(null)}
                                disabled={isDeleting}
                                className="rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-40"
                              >
                                ביטול
                              </button>
                              <button
                                type="button"
                                onClick={() => del(it, false)}
                                disabled={isDeleting}
                                className="flex items-center gap-1 rounded-md bg-destructive px-2.5 py-1 text-[11px] font-medium text-white hover:bg-destructive/90 disabled:opacity-60"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3 w-3" />
                                )}
                                מחק
                              </button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </Portal>
  )
}

