import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Plus,
  Copy,
  Check,
  Trash2,
  ChevronDown,
  Download,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

interface Partner {
  code: string
  name: string
  signups: number
  paidAccounts: number
  revenueByCurrency: Record<string, number>
  loginEmail?: string
  hasLogin?: boolean
  commissionType?: 'percent' | 'fixed' | null
  commissionValue?: number | null
  commissionCurrency?: string | null
  earningsByCurrency?: Record<string, number>
  visibility?: { revenue: boolean; earnings: boolean; counts: boolean }
}

function referralLink(code: string): string {
  return `https://dmplus.net/?ref=${encodeURIComponent(code)}`
}
function fmtMoney(rev?: Record<string, number>): string {
  const parts = Object.entries(rev || {})
    .filter(([, v]) => v > 0)
    .map(([c, v]) => `${v.toFixed(2)} ${c}`)
  return parts.length ? parts.join(' · ') : '—'
}
function commissionLabel(p: Partner): string {
  if (!p.commissionType || !p.commissionValue) return 'לא הוגדר'
  return p.commissionType === 'percent'
    ? `${p.commissionValue}% מכל קנייה`
    : `${p.commissionValue} ${p.commissionCurrency || 'ILS'} לכל קנייה`
}

export default function ReferralsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [partners, setPartners] = useState<Partner[] | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // Create form
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [password, setPassword] = useState('')
  const [commType, setCommType] = useState<'none' | 'percent' | 'fixed'>('none')
  const [commValue, setCommValue] = useState('')
  const [creating, setCreating] = useState(false)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  async function load() {
    setError('')
    try {
      const r = await adminApi<{ partners: Partner[] }>('admin-referral-report')
      setPartners(r.partners)
    } catch (e) {
      handleErr(e)
      setPartners([])
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create() {
    if (creating || !name.trim()) return
    setCreating(true)
    setError('')
    try {
      await adminApi('admin-create-referral', {
        name: name.trim(),
        code: code.trim() || undefined,
        loginEmail: loginEmail.trim() || undefined,
        password: password.trim() || undefined,
        commissionType: commType !== 'none' ? commType : undefined,
        commissionValue:
          commType !== 'none' && commValue.trim() ? Number(commValue) : undefined,
      })
      setName('')
      setCode('')
      setLoginEmail('')
      setPassword('')
      setCommType('none')
      setCommValue('')
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setCreating(false)
    }
  }

  async function del(p: Partner) {
    if (!window.confirm(`למחוק את השותף "${p.name}"? הפעולה אינה הפיכה.`)) return
    try {
      await adminApi('admin-delete-referral', { code: p.code })
      await load()
    } catch (e) {
      handleErr(e)
    }
  }

  async function copy(link: string, key: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(key)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-medium text-fg">שותפים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            ניהול שותפים, עמלות, וקישורי הפניה.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          <RefreshCw className="h-3.5 w-3.5" /> רענן
        </button>
      </header>

      {/* Create */}
      <div className="space-y-3 rounded-2xl border border-border/60 bg-white/[0.015] p-4">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-fg">שותף חדש</h3>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field value={name} onChange={setName} placeholder="שם השותף *" />
          <Field value={code} onChange={setCode} placeholder="קוד (אופציונלי)" ltr />
          <Field value={loginEmail} onChange={setLoginEmail} placeholder="מייל כניסה לדשבורד" ltr />
          <Field value={password} onChange={setPassword} placeholder="סיסמה לדשבורד" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-faint">עמלה:</span>
          {(['none', 'percent', 'fixed'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setCommType(t)}
              className={
                'rounded-lg border px-3 py-1 text-xs transition-colors ' +
                (commType === t
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-fg-muted hover:text-fg')
              }
            >
              {t === 'none' ? 'ללא' : t === 'percent' ? 'אחוזים' : 'סכום קבוע'}
            </button>
          ))}
          {commType !== 'none' && (
            <input
              type="number"
              value={commValue}
              onChange={(e) => setCommValue(e.target.value)}
              placeholder={commType === 'percent' ? '%' : 'סכום'}
              className="w-28 rounded-lg border border-border bg-transparent px-3 py-1 text-sm text-fg outline-none focus:border-primary"
            />
          )}
          <button
            type="button"
            onClick={create}
            disabled={creating || !name.trim()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            צור שותף
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
        {partners === null ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-border/60 py-8 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> טוען שותפים…
          </div>
        ) : partners.length === 0 ? (
          <div className="rounded-2xl border border-border/60 py-8 text-center text-sm text-fg-muted">
            אין שותפים עדיין
          </div>
        ) : (
          partners.map((p) => (
            <PartnerCard
              key={p.code}
              p={p}
              expanded={expanded === p.code}
              onToggle={() => setExpanded(expanded === p.code ? null : p.code)}
              onCopy={() => copy(referralLink(p.code), p.code)}
              copied={copied === p.code}
              onChange={load}
              onDelete={() => del(p)}
              onAuthExpired={onAuthExpired}
            />
          ))
        )}
      </div>
    </div>
  )
}

function Field({
  value,
  onChange,
  placeholder,
  ltr,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  ltr?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      dir={ltr ? 'ltr' : undefined}
      className="rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
    />
  )
}

function PartnerCard({
  p,
  expanded,
  onToggle,
  onCopy,
  copied,
  onChange,
  onDelete,
  onAuthExpired,
}: {
  p: Partner
  expanded: boolean
  onToggle: () => void
  onCopy: () => void
  copied: boolean
  onChange: () => void
  onDelete: () => void
  onAuthExpired: () => void
}) {
  const [commType, setCommType] = useState<'none' | 'percent' | 'fixed'>(
    p.commissionType || 'none',
  )
  const [commValue, setCommValue] = useState(String(p.commissionValue || ''))
  const [vis, setVis] = useState(
    p.visibility || { revenue: false, earnings: true, counts: true },
  )
  const [credEmail, setCredEmail] = useState(p.loginEmail || '')
  const [credPassword, setCredPassword] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [exporting, setExporting] = useState(false)
  const [expUsers, setExpUsers] = useState(true)
  const [expGross, setExpGross] = useState(true)
  const [expEarnings, setExpEarnings] = useState(true)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setMsg(err.message || 'שגיאה')
  }

  async function call(action: string, body: Record<string, unknown>, label: string) {
    setBusy(label)
    setMsg('')
    try {
      await adminApi(action, { code: p.code, ...body })
      setMsg('נשמר ✓')
      onChange()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy('')
    }
  }

  async function exportCsv() {
    setExporting(true)
    setMsg('')
    try {
      const r = await adminApi<{
        payments?: {
          at: string
          email?: string
          amount: number
          currency: string
        }[]
        accounts?: {
          email: string
          name?: string
          createdAt: string
          planType?: string | null
        }[]
      }>('admin-referral-export', { code: p.code })
      const rows: string[] = []
      if (expUsers) {
        rows.push('משתמשים')
        rows.push('name,email,created,plan')
        for (const a of r.accounts || [])
          rows.push(
            `${a.name || ''},${a.email},${a.createdAt},${a.planType || 'free'}`,
          )
        rows.push('')
      }
      if (expGross || expEarnings) {
        rows.push('תשלומים')
        rows.push('date,email,amount,currency')
        for (const pay of r.payments || [])
          rows.push(
            `${pay.at},${pay.email || ''},${pay.amount},${pay.currency}`,
          )
      }
      const blob = new Blob(['﻿' + rows.join('\n')], {
        type: 'text/csv;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `partner-${p.code}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      handleErr(e)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-white/[0.015]">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-right"
        >
          <ChevronDown
            className={
              'h-4 w-4 shrink-0 text-fg-muted transition-transform ' +
              (expanded ? 'rotate-180' : '')
            }
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg">{p.name}</div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
              <span dir="ltr">?ref={p.code}</span>
              <span>·</span>
              <span>{p.signups} נרשמו</span>
              <span>·</span>
              <span>{p.paidAccounts} קנו</span>
              {p.hasLogin && (
                <span className="rounded bg-success/10 px-1.5 text-success">
                  דשבורד
                </span>
              )}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          העתק קישור
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 text-fg-muted transition-colors hover:text-destructive"
          title="מחק"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border bg-bg/40 p-4">
          {/* Stats */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Mini label="הכנסות (ברוטו)" value={fmtMoney(p.revenueByCurrency)} />
            <Mini label="רווח לשותף" value={fmtMoney(p.earningsByCurrency)} />
            <Mini label="עמלה" value={commissionLabel(p)} />
          </div>

          {/* Commission editor */}
          <Editor title="עמלה">
            <div className="flex flex-wrap items-center gap-2">
              {(['none', 'percent', 'fixed'] as const).map((t) => (
                <Chip key={t} active={commType === t} onClick={() => setCommType(t)}>
                  {t === 'none' ? 'ללא' : t === 'percent' ? 'אחוזים' : 'קבוע'}
                </Chip>
              ))}
              {commType !== 'none' && (
                <input
                  type="number"
                  value={commValue}
                  onChange={(e) => setCommValue(e.target.value)}
                  className="w-24 rounded-lg border border-border bg-transparent px-2 py-1 text-sm text-fg outline-none focus:border-primary"
                />
              )}
              <SaveBtn
                busy={busy === 'comm'}
                onClick={() =>
                  call(
                    'admin-set-referral-commission',
                    {
                      commissionType: commType !== 'none' ? commType : null,
                      commissionValue:
                        commType !== 'none' ? Number(commValue) || 0 : null,
                    },
                    'comm',
                  )
                }
              />
            </div>
          </Editor>

          {/* Visibility editor */}
          <Editor title="מה השותף רואה בדשבורד">
            <div className="flex flex-wrap items-center gap-3">
              <Toggle label="הכנסות ברוטו" checked={vis.revenue} onChange={(v) => setVis({ ...vis, revenue: v })} />
              <Toggle label="רווח שלו" checked={vis.earnings} onChange={(v) => setVis({ ...vis, earnings: v })} />
              <Toggle label="כמויות" checked={vis.counts} onChange={(v) => setVis({ ...vis, counts: v })} />
              <SaveBtn
                busy={busy === 'vis'}
                onClick={() => call('admin-set-referral-visibility', { visibility: vis }, 'vis')}
              />
            </div>
          </Editor>

          {/* Credentials editor */}
          <Editor title="פרטי כניסה לדשבורד">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={credEmail}
                onChange={(e) => setCredEmail(e.target.value)}
                placeholder="מייל"
                dir="ltr"
                className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-fg outline-none focus:border-primary"
              />
              <input
                value={credPassword}
                onChange={(e) => setCredPassword(e.target.value)}
                placeholder="סיסמה חדשה"
                className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm text-fg outline-none focus:border-primary"
              />
              <SaveBtn
                busy={busy === 'cred'}
                onClick={() =>
                  call(
                    'admin-set-referral-credentials',
                    { loginEmail: credEmail.trim(), password: credPassword.trim() },
                    'cred',
                  )
                }
              />
            </div>
          </Editor>

          {/* Export */}
          <Editor title="ייצוא נתונים (CSV)">
            <div className="flex flex-wrap items-center gap-3">
              <Toggle label="שמות+מיילים" checked={expUsers} onChange={setExpUsers} />
              <Toggle label="הכנסות ברוטו" checked={expGross} onChange={setExpGross} />
              <Toggle label="רווח לשותף" checked={expEarnings} onChange={setExpEarnings} />
              <button
                type="button"
                onClick={exportCsv}
                disabled={exporting}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
              >
                {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                ייצוא
              </button>
            </div>
          </Editor>

          {msg && <div className="text-xs text-fg-muted">{msg}</div>}
        </div>
      )}
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] text-fg-muted">{label}</div>
      <div className="text-sm font-medium text-fg">{value}</div>
    </div>
  )
}
function Editor({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="mb-2 text-xs font-medium text-fg-muted">{title}</div>
      {children}
    </div>
  )
}
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-lg border px-3 py-1 text-xs transition-colors ' +
        (active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-fg-muted hover:text-fg')
      }
    >
      {children}
    </button>
  )
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-primary,#d4a574)]"
      />
      {label}
    </label>
  )
}
function SaveBtn({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      שמור
    </button>
  )
}
