import { useEffect, useState } from 'react'
import {
  Key as KeyIcon,
  CheckCircle2,
  Crown,
  Plus,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Eye,
  Infinity as InfinityIcon,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { cachedAdminApi, peekAdminCache } from '../../lib/adminCache'
import { KeyDetailsModal } from './KeyDetailsModal'

interface KeyDoc {
  id: string
  key: string
  redeemedBy?: string | null
  redeemedByEmail?: string | null
  redeemedAt?: string | null
  expiresAt?: string | null
  createdAt?: string
  createdBy?: string
  subscriptionId?: string | null
  planId?: string | null
  planDays?: number | null
  subscriptionPlanDays?: number | null
  subscriptionPrice?: number | null
  subscriptionCurrency?: string | null
  buyerEmail?: string | null
  nonPaidGrant?: boolean
  grantReason?: string | null
  grantedByAdmin?: string | null
  subscriptionStatus?: string | null
  subscriptionCancelledAt?: string | null
  subscriptionCancelReason?: string | null
  autoRedeemedFromWebhook?: boolean
  billingHistory?: unknown[]
  replacedPriorKeys?: unknown[]
}

function daysFromNowIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}
function fmtDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('he-IL')
}

export default function KeysTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [keys, setKeys] = useState<KeyDoc[] | null>(
    peekAdminCache<{ keys: KeyDoc[] }>('admin-list-keys')?.keys ?? null,
  )
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Create form: a preset day count, custom days, or an until-date.
  // null preset = perpetual (no expiry).
  const [preset, setPreset] = useState<number | null>(30)
  const [customDays, setCustomDays] = useState('')
  const [untilDate, setUntilDate] = useState('')
  const [keyTier, setKeyTier] = useState<'basic' | 'pro' | 'ultra'>('pro')

  const [extendingId, setExtendingId] = useState<string | null>(null)
  const [extendDate, setExtendDate] = useState('')
  const [detailKey, setDetailKey] = useState<KeyDoc | null>(null)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  async function load(force = false) {
    setError('')
    if (force) setRefreshing(true)
    try {
      const r = await cachedAdminApi<{ keys: KeyDoc[] }>(
        'admin-list-keys',
        {},
        { force },
      )
      setKeys(r.keys)
    } catch (e) {
      handleErr(e)
    } finally {
      if (force) setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function resolveExpiry(): string | null | 'INVALID' {
    if (untilDate) {
      const ms = new Date(untilDate).getTime()
      if (Number.isNaN(ms) || ms <= Date.now()) return 'INVALID'
      return new Date(untilDate).toISOString()
    }
    if (customDays.trim()) {
      const n = Math.floor(Number(customDays))
      if (!Number.isFinite(n) || n <= 0) return 'INVALID'
      return daysFromNowIso(n)
    }
    if (preset === null) return null
    return daysFromNowIso(preset)
  }

  async function create() {
    if (busy) return
    const exp = resolveExpiry()
    if (exp === 'INVALID') {
      setError('בחר תוקף תקין')
      return
    }
    setBusy(true)
    setError('')
    try {
      await adminApi('admin-create-key', { expiresAt: exp, tier: keyTier })
      await load(true)
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function del(id: string) {
    if (busy) return
    if (!window.confirm('למחוק את המפתח הזה?')) return
    setBusy(true)
    try {
      await adminApi('admin-delete-key', { keyId: id })
      await load(true)
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function setExpiry(id: string, iso: string | null) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await adminApi('admin-set-key-expiry', { keyId: id, expiresAt: iso })
      setExtendingId(null)
      setExtendDate('')
      await load(true)
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  function copy(id: string, value: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }

  const available = keys?.filter((k) => !k.redeemedBy).length ?? 0
  const used = keys?.filter((k) => k.redeemedBy).length ?? 0

  const presets: { label: string; val: number | null }[] = [
    { label: '7 ימים', val: 7 },
    { label: '30 יום', val: 30 },
    { label: '90 יום', val: 90 },
    { label: 'שנה', val: 365 },
    { label: 'ללא תפוגה', val: null },
  ]

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">מפתחות מוצר</h2>
          <p className="mt-1 text-sm text-fg-muted">יצירה וניהול מפתחות Pro</p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-60"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
          />{' '}
          {refreshing ? 'מרענן…' : 'רענן'}
        </button>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="זמינים" value={available} icon={<KeyIcon className="h-4 w-4" />} accent />
        <Stat label="מומשו" value={used} icon={<CheckCircle2 className="h-4 w-4" />} success />
        <Stat label="סך הכל" value={keys?.length ?? 0} icon={<Crown className="h-4 w-4" />} />
      </div>

      {/* Create */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-fg">הפק מפתח Pro חדש</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={String(p.val)}
              type="button"
              onClick={() => {
                setPreset(p.val)
                setCustomDays('')
                setUntilDate('')
              }}
              className={
                'inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors ' +
                (preset === p.val && !customDays && !untilDate
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-fg-muted hover:text-fg')
              }
            >
              {p.val === null && <InfinityIcon className="h-3.5 w-3.5" />}
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            value={customDays}
            onChange={(e) => {
              setCustomDays(e.target.value)
              setUntilDate('')
            }}
            placeholder="ימים מותאם"
            className="w-32 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-fg outline-none focus:border-primary"
          />
          <span className="text-xs text-fg-faint">או עד תאריך:</span>
          <input
            type="date"
            value={untilDate}
            onChange={(e) => {
              setUntilDate(e.target.value)
              setCustomDays('')
            }}
            className="rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-fg outline-none focus:border-primary"
          />
          <span className="text-xs text-fg-faint">מנוי:</span>
          <select
            value={keyTier}
            onChange={(e) => setKeyTier(e.target.value as 'basic' | 'pro' | 'ultra')}
            className="rounded-lg border border-border bg-bg-elevated px-2 py-1.5 text-sm text-fg outline-none focus:border-primary"
          >
            <option value="basic">Basic</option>
            <option value="pro">Pro</option>
            <option value="ultra">Ultra</option>
          </select>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            צור מפתח
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* List */}
      <div className="space-y-2">
        {keys === null ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-8 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> טוען מפתחות…
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-2xl border border-border py-8 text-center text-sm text-fg-muted">
            אין מפתחות עדיין
          </div>
        ) : (
          [...keys]
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .map((k) => (
              <div
                key={k.id}
                className="rounded-2xl border border-border bg-card p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => copy(k.id, k.key)}
                      className="inline-flex items-center gap-1.5 font-mono text-sm text-fg transition-colors hover:text-primary"
                      dir="ltr"
                      title="העתק"
                    >
                      {copiedId === k.id ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 text-fg-muted" />
                      )}
                      <span className={k.redeemedBy ? 'text-fg-muted line-through' : ''}>
                        {k.key}
                      </span>
                    </button>
                    {k.redeemedBy ? (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                        PRO
                      </span>
                    ) : (
                      <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                        זמין
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDetailKey(k)}
                      className="text-fg-muted transition-colors hover:text-accent"
                      title="פרטי המפתח"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => del(k.id)}
                      disabled={busy}
                      className="text-fg-muted transition-colors hover:text-destructive disabled:opacity-50"
                      title="מחק"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
                  {k.redeemedByEmail && (
                    <span dir="ltr">{k.redeemedByEmail}</span>
                  )}
                  <span>·</span>
                  <span>תוקף: {k.expiresAt ? fmtDate(k.expiresAt) : 'ללא תפוגה'}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setExtendingId(extendingId === k.id ? null : k.id)
                    }
                    className="text-primary hover:underline"
                  >
                    שנה תוקף
                  </button>
                </div>
                {extendingId === k.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      value={extendDate}
                      onChange={(e) => setExtendDate(e.target.value)}
                      className="rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-fg outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      disabled={busy || !extendDate}
                      onClick={() =>
                        setExpiry(k.id, new Date(extendDate).toISOString())
                      }
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                    >
                      עדכן
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setExpiry(k.id, null)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
                    >
                      הסר תפוגה
                    </button>
                  </div>
                )}
              </div>
            ))
        )}
      </div>

      <KeyDetailsModal keyDoc={detailKey} onClose={() => setDetailKey(null)} />
    </div>
  )
}


function Stat({
  label,
  value,
  icon,
  accent,
  success,
}: {
  label: string
  value: number
  icon: React.ReactNode
  accent?: boolean
  success?: boolean
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
          (success
            ? 'from-success to-success shadow-success/40'
            : accent
              ? 'from-accent to-primary shadow-accent/40'
              : 'from-primary to-accent shadow-primary/40')
        }
      >
        {icon}
      </div>
    </div>
  )
}
