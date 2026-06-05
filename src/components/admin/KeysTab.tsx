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
  X,
  ExternalLink,
  Infinity as InfinityIcon,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { adminApi } from '../../lib/adminApi'
import { Portal } from '@/components/ui/Portal'
import { cn } from '@/lib/cn'

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
  const [keys, setKeys] = useState<KeyDoc[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Create form: a preset day count, custom days, or an until-date.
  // null preset = perpetual (no expiry).
  const [preset, setPreset] = useState<number | null>(30)
  const [customDays, setCustomDays] = useState('')
  const [untilDate, setUntilDate] = useState('')

  const [extendingId, setExtendingId] = useState<string | null>(null)
  const [extendDate, setExtendDate] = useState('')
  const [detailKey, setDetailKey] = useState<KeyDoc | null>(null)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  async function load() {
    setError('')
    try {
      const r = await adminApi<{ keys: KeyDoc[] }>('admin-list-keys')
      setKeys(r.keys)
    } catch (e) {
      handleErr(e)
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
      await adminApi('admin-create-key', { expiresAt: exp })
      await load()
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
      await load()
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
      await load()
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
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
        >
          <RefreshCw className="h-3.5 w-3.5" /> רענן
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
                      {k.key}
                    </button>
                    {k.redeemedBy ? (
                      <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] text-success">
                        מומש
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

function fmtDateTime(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  })
}

function KeyDetailsModal({
  keyDoc,
  onClose,
}: {
  keyDoc: KeyDoc | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState<'key' | 'sub' | null>(null)
  function copy(text: string, kind: 'key' | 'sub') {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  useEffect(() => {
    if (!keyDoc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [keyDoc, onClose])

  if (!keyDoc) return null

  const createdLabel = (() => {
    const cb = keyDoc.createdBy || ''
    if (cb.startsWith('admin-grant:')) return `הענקת אדמין (${cb.slice(12)})`
    if (cb.startsWith('admin-web:')) return `הענקת אדמין (${cb.slice(10)})`
    if (cb.startsWith('paypal-subscription-yearly')) return 'PayPal — מנוי שנתי'
    if (cb.startsWith('paypal-subscription-monthly')) return 'PayPal — מנוי חודשי'
    if (cb.startsWith('paypal')) return 'PayPal'
    if (cb === 'manual') return 'ידני (קונסול)'
    return cb || '—'
  })()
  const planLabel = (() => {
    const days = keyDoc.subscriptionPlanDays || keyDoc.planDays
    if (!days) return null
    if (days >= 300) return 'שנתי'
    if (days === 30) return 'חודשי'
    return `${days} ימים`
  })()

  return (
    <Portal>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, pointerEvents: 'auto' }}
          exit={{ opacity: 0, pointerEvents: 'none' }}
          transition={{ duration: 0.18 }}
          dir="rtl"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-md"
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, y: 12 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-7 shadow-xl"
          >
            <button
              onClick={onClose}
              className="absolute left-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-popover hover:text-foreground"
              aria-label="סגור"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/15">
                <KeyIcon className="h-5 w-5 text-accent" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-foreground">פרטי מפתח מוצר</h2>
                <div className="text-xs text-muted-foreground">
                  כל הנתונים שיש על המפתח הזה
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <KeyDetailRow label="מפתח מלא">
                <div className="flex items-center gap-2">
                  <span dir="ltr" className="select-text font-mono text-xs text-foreground">
                    {keyDoc.key}
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(keyDoc.key, 'key')}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-popover hover:text-foreground"
                  >
                    {copied === 'key' ? '✓' : 'העתק'}
                  </button>
                </div>
              </KeyDetailRow>

              <KeyDetailSection title="פרטי יצירה">
                <KeyDetailRow label="נוצר בתאריך">
                  <span dir="ltr" className="text-xs text-foreground">
                    {fmtDateTime(keyDoc.createdAt)}
                  </span>
                </KeyDetailRow>
                <KeyDetailRow label="מקור">
                  <span className="text-xs text-foreground">{createdLabel}</span>
                </KeyDetailRow>
                {keyDoc.subscriptionId && (
                  <KeyDetailRow label="מזהה עסקה / מנוי">
                    <div className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="select-text font-mono text-[11px] text-foreground">
                        {keyDoc.subscriptionId}
                      </span>
                      <button
                        type="button"
                        onClick={() => copy(keyDoc.subscriptionId!, 'sub')}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-popover hover:text-foreground"
                      >
                        {copied === 'sub' ? '✓' : 'העתק'}
                      </button>
                      <a
                        href={`https://www.paypal.com/billing/subscriptions/${encodeURIComponent(keyDoc.subscriptionId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
                        title="פותח את דף המנוי ב-PayPal — שם רואים את כל החיובים שבוצעו בפועל"
                      >
                        <ExternalLink className="h-2.5 w-2.5" />
                        צפה ב-PayPal
                      </a>
                    </div>
                  </KeyDetailRow>
                )}
                {keyDoc.planId && (
                  <KeyDetailRow label="Plan ID">
                    <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                      {keyDoc.planId}
                    </span>
                  </KeyDetailRow>
                )}
                {planLabel && (
                  <KeyDetailRow label="תוכנית">
                    <span className="text-xs text-foreground">{planLabel}</span>
                  </KeyDetailRow>
                )}
                {keyDoc.subscriptionPrice != null && (
                  <KeyDetailRow label="מחיר נעול">
                    <span className="text-xs text-foreground">
                      {keyDoc.subscriptionPrice}{' '}
                      {keyDoc.subscriptionCurrency === 'ILS'
                        ? '₪'
                        : keyDoc.subscriptionCurrency === 'USD'
                          ? '$'
                          : keyDoc.subscriptionCurrency || ''}
                    </span>
                  </KeyDetailRow>
                )}
                {keyDoc.buyerEmail && (
                  <KeyDetailRow label="מייל קונה">
                    <span dir="ltr" className="font-mono text-xs text-foreground">
                      {keyDoc.buyerEmail}
                    </span>
                  </KeyDetailRow>
                )}
                {keyDoc.nonPaidGrant && (
                  <KeyDetailRow label="הענקה ידנית">
                    <span className="text-xs text-accent">
                      {keyDoc.grantReason || '—'}
                      {keyDoc.grantedByAdmin && (
                        <span className="text-muted-foreground/60"> ({keyDoc.grantedByAdmin})</span>
                      )}
                    </span>
                  </KeyDetailRow>
                )}
              </KeyDetailSection>

              <KeyDetailSection title="פעילות">
                <KeyDetailRow label="מימוש">
                  {keyDoc.redeemedAt ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span dir="ltr" className="text-xs text-foreground">
                        {fmtDateTime(keyDoc.redeemedAt)}
                      </span>
                      {keyDoc.autoRedeemedFromWebhook && (
                        <span className="text-[10px] text-muted-foreground/70">
                          (אוטומטי דרך webhook)
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">לא מומש</span>
                  )}
                </KeyDetailRow>
                <KeyDetailRow label="בתוקף עד">
                  {keyDoc.expiresAt ? (
                    <span
                      dir="ltr"
                      className={cn(
                        'text-xs',
                        new Date(keyDoc.expiresAt).getTime() < Date.now()
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {fmtDateTime(keyDoc.expiresAt)}
                      {new Date(keyDoc.expiresAt).getTime() < Date.now() && (
                        <span className="mr-1 text-destructive">(פג)</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">ללא תפוגה</span>
                  )}
                </KeyDetailRow>
                {keyDoc.subscriptionStatus && (
                  <KeyDetailRow label="סטטוס מנוי">
                    <span className="text-xs text-foreground">{keyDoc.subscriptionStatus}</span>
                  </KeyDetailRow>
                )}
                {keyDoc.subscriptionCancelledAt && (
                  <KeyDetailRow label="בוטל בתאריך">
                    <div className="flex flex-col items-end gap-0.5">
                      <span dir="ltr" className="text-xs text-foreground">
                        {fmtDateTime(keyDoc.subscriptionCancelledAt)}
                      </span>
                      {keyDoc.subscriptionCancelReason && (
                        <span className="text-[10px] text-muted-foreground/70">
                          {keyDoc.subscriptionCancelReason}
                        </span>
                      )}
                    </div>
                  </KeyDetailRow>
                )}
                {keyDoc.billingHistory && keyDoc.billingHistory.length > 0 && (
                  <KeyDetailRow label="חיובים">
                    <span className="text-xs text-foreground">
                      {keyDoc.billingHistory.length} סה״כ
                    </span>
                  </KeyDetailRow>
                )}
                {keyDoc.replacedPriorKeys && keyDoc.replacedPriorKeys.length > 0 && (
                  <KeyDetailRow label="החליף מפתחות">
                    <span className="text-xs text-muted-foreground">
                      {keyDoc.replacedPriorKeys.length} מפתחות קודמים
                    </span>
                  </KeyDetailRow>
                )}
              </KeyDetailSection>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </Portal>
  )
}

function KeyDetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {title}
      </div>
      <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
        {children}
      </div>
    </div>
  )
}

function KeyDetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="text-left">{children}</div>
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
