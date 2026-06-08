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
  FileText,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { cachedAdminApi, peekAdminCache } from '../../lib/adminCache'

interface ReferralDetail {
  accounts: { email: string; createdAt: string; paid: boolean }[]
  revenueByMonth: Record<string, Record<string, number>>
}

interface Partner {
  code: string
  name: string
  signups: number
  paidAccounts: number
  revenueByCurrency: Record<string, number>
  netByCurrency?: Record<string, number>
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
  const [partners, setPartners] = useState<Partner[] | null>(
    peekAdminCache<{ partners: Partner[] }>('admin-referral-report')?.partners ??
      null,
  )
  const [refreshing, setRefreshing] = useState(false)
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

  async function load(force = false) {
    setError('')
    if (force) setRefreshing(true)
    try {
      const r = await cachedAdminApi<{ partners: Partner[] }>(
        'admin-referral-report',
        {},
        { force },
      )
      setPartners(r.partners)
    } catch (e) {
      handleErr(e)
      setPartners([])
    } finally {
      if (force) setRefreshing(false)
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
      await load(true)
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
      await load(true)
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
          <h2 className="text-3xl font-bold font-display text-fg">שותפים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            ניהול שותפים, עמלות, וקישורי הפניה.
          </p>
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

      {/* Create */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
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
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-8 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> טוען שותפים…
          </div>
        ) : partners.length === 0 ? (
          <div className="rounded-2xl border border-border py-8 text-center text-sm text-fg-muted">
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
  const [exportingPdf, setExportingPdf] = useState(false)
  const [expUsers, setExpUsers] = useState(true)
  const [expGross, setExpGross] = useState(true)
  const [expEarnings, setExpEarnings] = useState(true)
  const [exportFrom, setExportFrom] = useState('')
  const [exportTo, setExportTo] = useState('')
  const [detail, setDetail] = useState<ReferralDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setMsg(err.message || 'שגיאה')
  }

  // Load the per-partner detail (accounts + revenue-by-month) the
  // first time this card is expanded. Cached after that.
  useEffect(() => {
    if (!expanded || detail || detailLoading) return
    let alive = true
    setDetailLoading(true)
    ;(async () => {
      try {
        const r = await adminApi<ReferralDetail>('admin-referral-detail', {
          code: p.code,
        })
        if (alive) setDetail({ accounts: r.accounts, revenueByMonth: r.revenueByMonth })
      } catch (e) {
        if (alive) handleErr(e)
      } finally {
        if (alive) setDetailLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  async function exportPdf() {
    if (exportingPdf) return
    setExportingPdf(true)
    setMsg('')
    try {
      const fromMs = exportFrom ? Date.parse(`${exportFrom}T00:00:00`) : undefined
      const toMs = exportTo ? Date.parse(`${exportTo}T23:59:59`) : undefined
      const j = await adminApi<{
        partner: { code: string; name: string }
        payments: {
          at: string
          email: string
          name: string
          planType: 'monthly' | 'yearly'
          amount: number
          currency: string
        }[]
        accounts: {
          email: string
          name: string
          createdAt: string
          planType: 'monthly' | 'yearly' | null
        }[]
      }>('admin-referral-export', { code: p.code, fromMs, toMs })

      const planLabel = (t: 'monthly' | 'yearly' | null) =>
        t === 'yearly' ? 'שנתי' : t === 'monthly' ? 'חודשי' : '—'

      const paidByEmail: Record<string, Record<string, number>> = {}
      const countByEmail: Record<string, number> = {}
      const grossTotals: Record<string, number> = {}
      const grossByMonth: Record<string, Record<string, number>> = {}
      const countByMonth: Record<string, number> = {}
      for (const pay of j.payments) {
        const e = pay.email.toLowerCase()
        paidByEmail[e] = paidByEmail[e] || {}
        paidByEmail[e][pay.currency] = (paidByEmail[e][pay.currency] || 0) + pay.amount
        countByEmail[e] = (countByEmail[e] || 0) + 1
        grossTotals[pay.currency] = (grossTotals[pay.currency] || 0) + pay.amount
        const m = pay.at.slice(0, 7)
        grossByMonth[m] = grossByMonth[m] || {}
        grossByMonth[m][pay.currency] = (grossByMonth[m][pay.currency] || 0) + pay.amount
        countByMonth[m] = (countByMonth[m] || 0) + 1
      }
      const comm =
        p.commissionType && p.commissionValue
          ? { type: p.commissionType, value: p.commissionValue, cur: p.commissionCurrency || 'ILS' }
          : null
      const earn = (gross: Record<string, number>, count: number): Record<string, number> => {
        if (!comm) return {}
        if (comm.type === 'percent') {
          const f = comm.value / 100
          const o: Record<string, number> = {}
          for (const [c, v] of Object.entries(gross)) o[c] = v * f
          return o
        }
        return { [comm.cur]: count * comm.value }
      }
      const earnTotals = earn(grossTotals, j.payments.length)
      const earnByEmail: Record<string, Record<string, number>> = {}
      for (const e of Object.keys(paidByEmail)) earnByEmail[e] = earn(paidByEmail[e], countByEmail[e])

      const sym: Record<string, string> = { ILS: '₪', USD: '$', EUR: '€' }
      const money = (m: Record<string, number>) => {
        const parts = Object.entries(m)
          .filter(([, v]) => v > 0)
          .map(([c, v]) => `${v.toFixed(2)} ${sym[c] || c}`)
        return parts.length ? parts.join(' · ') : '—'
      }
      let logo = ''
      try {
        const lr = await fetch('/icon.png')
        if (lr.ok) {
          const b = await lr.blob()
          logo = await new Promise<string>((res) => {
            const fr = new FileReader()
            fr.onload = () => res(String(fr.result))
            fr.readAsDataURL(b)
          })
        }
      } catch {
        /* logo optional */
      }
      const esc = (s: string | number) =>
        String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const link = `dmplus.net/?ref=${p.code}`
      const rangeLabel =
        exportFrom || exportTo
          ? `${exportFrom || 'ההתחלה'} — ${exportTo || 'היום'}`
          : 'כל הזמן'
      const today = new Date().toLocaleDateString('he-IL')
      const paidCount = j.accounts.filter((a) => paidByEmail[a.email.toLowerCase()]).length
      const showMoney = expGross || expEarnings
      const statCards = [
        `<div class="stat"><b>${j.accounts.length}</b><span>חשבונות</span></div>`,
        `<div class="stat"><b>${paidCount}</b><span>קנו מנוי</span></div>`,
        ...(expGross ? [`<div class="stat"><b>${esc(money(grossTotals))}</b><span>סה״כ הכנסות</span></div>`] : []),
        ...(expEarnings ? [`<div class="stat"><b>${esc(money(earnTotals))}</b><span>רווח לשותף</span></div>`] : []),
      ].join('')
      const moneyCols = (expGross ? '<th>סה״כ שולם</th>' : '') + (expEarnings ? '<th>רווח לשותף</th>' : '')
      const baseColspan = 5 + (expGross ? 1 : 0) + (expEarnings ? 1 : 0)
      const accountRows =
        j.accounts
          .map((a) => {
            const e = a.email.toLowerCase()
            const paid = paidByEmail[e]
            return `<tr><td class="ltr">${esc(a.email)}</td><td>${esc(a.name || '—')}</td><td>${a.createdAt ? a.createdAt.slice(0, 10) : '—'}</td><td><span class="badge ${paid ? 'paid' : ''}">${paid ? 'קנה' : 'נרשם'}</span></td><td>${planLabel(a.planType)}</td>${expGross ? `<td>${paid ? esc(money(paid)) : '—'}</td>` : ''}${expEarnings ? `<td>${earnByEmail[e] ? esc(money(earnByEmail[e])) : '—'}</td>` : ''}</tr>`
          })
          .join('') || `<tr><td colspan="${baseColspan}" class="empty">אין משתמשים</td></tr>`
      const usersSection = expUsers
        ? `<h2>משתמשים שהגיעו דרך השותף</h2><table><thead><tr><th>מייל</th><th>שם</th><th>תאריך הרשמה</th><th>סטטוס</th><th>סוג מנוי</th>${moneyCols}</tr></thead><tbody>${accountRows}</tbody></table>`
        : `<h2>סיכום משתמשים</h2><div class="info"><div><span>נרשמו</span><b>${j.accounts.length}</b></div><div><span>קנו מנוי</span><b>${paidCount}</b></div></div>`
      const monthHeader =
        '<th>חודש / שנה</th>' + (expGross ? '<th>הכנסה</th>' : '') + (expEarnings ? '<th>רווח לשותף</th>' : '')
      const monthColspan = 1 + (expGross ? 1 : 0) + (expEarnings ? 1 : 0)
      const monthRows =
        Object.keys(grossByMonth)
          .sort((a, b) => b.localeCompare(a))
          .map(
            (m) =>
              `<tr><td>${m.slice(5, 7)}/${m.slice(0, 4)}</td>${expGross ? `<td>${esc(money(grossByMonth[m]))}</td>` : ''}${expEarnings ? `<td>${esc(money(earn(grossByMonth[m], countByMonth[m])))}</td>` : ''}</tr>`,
          )
          .join('') || `<tr><td colspan="${monthColspan}" class="empty">אין נתונים בטווח</td></tr>`
      const monthSection = showMoney
        ? `<h2>פירוט לפי חודש</h2><table><thead><tr>${monthHeader}</tr></thead><tbody>${monthRows}</tbody></table>`
        : ''
      const totalLines = [
        ...(expGross ? [`<div class="total"><span>סך הכל הכנסות שיוחסו לשותף</span><b>${esc(money(grossTotals))}</b></div>`] : []),
        ...(expEarnings ? [`<div class="total"><span>סך הרווח לשותף (לפי ההסכם)</span><b>${esc(money(earnTotals))}</b></div>`] : []),
      ].join('')
      const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>דוח שותף - ${esc(j.partner.name)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Heebo','Assistant','Arial',sans-serif; color: #1f1a16; background: #fff; }
  .header { background: #16110D; color: #F5EFE6; padding: 28px 36px; display: flex; align-items: center; gap: 16px; }
  .header img { width: 46px; height: 46px; border-radius: 11px; }
  .brand { font-size: 13px; letter-spacing: .04em; color: #cdbba6; }
  .brand b { display:block; font-size: 19px; color: #F5EFE6; font-weight: 600; }
  .accent { height: 4px; background: linear-gradient(90deg,#C8843C,#9c6328); }
  .wrap { padding: 28px 36px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color:#7a6f64; font-size: 13px; margin-bottom: 18px; }
  .info { display:flex; flex-wrap:wrap; gap: 8px 28px; background:#faf6f0; border:1px solid #ece2d5; border-radius:12px; padding:14px 18px; margin-bottom:18px; font-size:13px; }
  .info div span { color:#9a8d7e; margin-left:6px; }
  .info .ltr { direction:ltr; unicode-bidi:isolate; }
  .stats { display:flex; gap:12px; margin-bottom:24px; }
  .stat { flex:1; border:1px solid #ece2d5; border-radius:12px; padding:14px 16px; text-align:center; }
  .stat b { display:block; font-size:20px; color:#9c6328; }
  .stat span { font-size:12px; color:#7a6f64; }
  h2 { font-size:15px; margin: 22px 0 8px; padding-right:10px; border-right:3px solid #C8843C; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { background:#16110D; color:#F5EFE6; text-align:right; padding:8px 10px; font-weight:500; }
  td { padding:7px 10px; border-bottom:1px solid #eee3d6; }
  tbody tr:nth-child(even) { background:#faf6f0; }
  td.ltr { direction:ltr; unicode-bidi:isolate; text-align:right; }
  td.empty { text-align:center; color:#9a8d7e; padding:16px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; background:#efe6da; color:#7a6f64; }
  .badge.paid { background:#dff3e4; color:#1f7a45; }
  .total { margin-top:14px; background:#16110D; color:#F5EFE6; border-radius:12px; padding:14px 20px; display:flex; justify-content:space-between; align-items:center; }
  .total b { font-size:20px; color:#E7B98A; }
  .foot { margin-top:26px; text-align:center; color:#9a8d7e; font-size:11px; }
</style></head><body>
  <div class="header">${logo ? `<img src="${logo}" alt="logo"/>` : ''}<div class="brand">דוח שותפים<b>ניהול הורדות פלוס</b></div></div>
  <div class="accent"></div>
  <div class="wrap">
    <h1>${esc(j.partner.name)}</h1>
    <div class="sub">דוח שיוך${showMoney ? ' והכנסות' : ''}</div>
    <div class="info"><div><span>קוד שותף</span><b>${esc(j.partner.code)}</b></div><div><span>קישור</span><b class="ltr">${esc(link)}</b></div><div><span>טווח</span><b>${esc(rangeLabel)}</b></div><div><span>הופק בתאריך</span><b>${esc(today)}</b></div></div>
    <div class="stats">${statCards}</div>
    ${usersSection}
    ${monthSection}
    ${totalLines}
    <div class="foot">הופק ע״י ניהול הורדות פלוס · dmplus.net · ${esc(today)}</div>
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
</body></html>`
      const w = window.open('', '_blank', 'width=900,height=1200')
      if (!w) {
        setMsg('הדפדפן חסם את חלון ההדפסה — אפשר חלונות קופצים ונסה שוב')
        return
      }
      w.document.open()
      w.document.write(html)
      w.document.close()
    } catch (e) {
      handleErr(e)
    } finally {
      setExportingPdf(false)
    }
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
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label="הכנסות (ברוטו)" value={fmtMoney(p.revenueByCurrency)} />
            <Mini
              label={'נטו (אחרי PayPal ומע"מ)'}
              value={fmtMoney(p.netByCurrency)}
            />
            <Mini label="רווח לשותף" value={fmtMoney(p.earningsByCurrency)} />
            <Mini label="עמלה" value={commissionLabel(p)} />
          </div>

          {/* Detail: revenue-by-month + accounts */}
          {detailLoading && !detail ? (
            <div className="flex items-center gap-2 py-3 text-xs text-fg-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען פרטים…
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                  הכנסות לפי חודש
                </div>
                {Object.keys(detail.revenueByMonth).length === 0 ? (
                  <div className="text-xs text-fg-muted">עדיין אין הכנסות.</div>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(detail.revenueByMonth)
                      .sort((a, b) => b[0].localeCompare(a[0]))
                      .map(([month, rev]) => (
                        <div
                          key={month}
                          className="flex items-center justify-between rounded-md bg-background px-3 py-1.5 text-xs"
                        >
                          <span className="text-fg">{fmtMoney(rev)}</span>
                          <span className="tabular-nums text-fg-muted" dir="ltr">
                            {month}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                  חשבונות ({detail.accounts.length})
                </div>
                {detail.accounts.length === 0 ? (
                  <div className="text-xs text-fg-muted">עדיין אין חשבונות.</div>
                ) : (
                  <div className="max-h-60 space-y-1 overflow-y-auto">
                    {detail.accounts.map((a) => (
                      <div
                        key={a.email}
                        className="flex items-center justify-between gap-2 rounded-md bg-background px-3 py-1.5 text-xs"
                      >
                        <span className="truncate text-fg" dir="ltr">
                          {a.email}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {a.paid ? (
                            <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                              קנה
                            </span>
                          ) : (
                            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-fg-muted">
                              נרשם
                            </span>
                          )}
                          <span className="tabular-nums text-fg-muted">
                            {a.createdAt ? a.createdAt.slice(0, 10) : ''}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

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
          <Editor title="ייצוא נתונים (PDF / CSV)">
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <Toggle label="שמות+מיילים" checked={expUsers} onChange={setExpUsers} />
                <Toggle label="הכנסות ברוטו" checked={expGross} onChange={setExpGross} />
                <Toggle label="רווח לשותף" checked={expEarnings} onChange={setExpEarnings} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-fg-faint">טווח (לדוח ה-PDF):</span>
                <input
                  type="date"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                  className="rounded-lg border border-border bg-transparent px-2 py-1 text-xs text-fg outline-none focus:border-primary"
                />
                <span className="text-fg-faint">—</span>
                <input
                  type="date"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                  className="rounded-lg border border-border bg-transparent px-2 py-1 text-xs text-fg outline-none focus:border-primary"
                />
              </div>
              <p className="text-[10px] text-fg-faint">
                השאירו ריק לייצוא הכל מאז שהשותף נוצר. ה-PDF נוצר מעוצב עם הלוגו,
                שם השותף, רשימת המשתמשים, הכנסות לפי חודש וסה״כ.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={exportPdf}
                  disabled={exportingPdf}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  {exportingPdf ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  ייצוא PDF
                </button>
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={exporting}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50"
                >
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  ייצוא CSV
                </button>
              </div>
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
    <div className="rounded-lg bg-background px-3 py-2">
      <div className="text-[10px] text-fg-muted">{label}</div>
      <div className="text-sm font-medium text-fg">{value}</div>
    </div>
  )
}
function Editor({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
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
