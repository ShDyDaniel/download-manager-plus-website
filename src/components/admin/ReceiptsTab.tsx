import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Download,
  FileText,
  FileDown,
  Receipt,
  Check,
  Building2,
  Save,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

interface ReceiptRow {
  at: string
  email: string
  amount: number | null
  currency: string
  description: string
  documentNumber: string | number | null
  url: string
  draft: boolean
  subscriptionId: string | null
  test?: boolean
}

interface CasualRow {
  seq: number
  eventId: string
  at: string
  email: string
  name: string
  description: string
  currency: string
  gross: number
  vat: number
  net: number
  reported: boolean
}

interface CasualTotals {
  count: number
  gross: number
  vat: number
  net: number
}

/** Reporter ("עוסק") identity for the עסקת-אקראי report (טופס 8356).
 *  Exactly the fields the form asks about the seller/service-provider.
 *  Persisted admin-side; reused on every per-row PDF. */
interface CasualBusiness {
  firstName: string
  lastName: string
  idNumber: string
  city: string
  street: string
  houseNumber: string
  zip: string
  phone: string
}

const EMPTY_BUSINESS: CasualBusiness = {
  firstName: '',
  lastName: '',
  idNumber: '',
  city: '',
  street: '',
  houseNumber: '',
  zip: '',
  phone: '',
}

function fmtDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function fmtDateOnly(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

/** עסקת אקראי must be reported within 30 days of the transaction.
 *  Returns the deadline date (charge date + 30d) and whether it has
 *  already passed, so the table can flag overdue lines. */
function reportDeadline(iso: string): { label: string; overdue: boolean } {
  if (!iso) return { label: '', overdue: false }
  try {
    const d = new Date(iso)
    d.setDate(d.getDate() + 30)
    return { label: fmtDateOnly(d.toISOString()), overdue: d.getTime() < Date.now() }
  } catch {
    return { label: '', overdue: false }
  }
}

/** Current month as a YYYY-MM string for the native month input. */
function currentMonthValue(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function csvCell(v: string | number): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function ReceiptsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [subTab, setSubTab] = useState<'receipts' | 'casual'>('receipts')

  // ── Settings (master switch + VAT rate) ──────────────────────
  const [sumitEnabled, setSumitEnabled] = useState<boolean | null>(null)
  const [sumitConfigured, setSumitConfigured] = useState(false)
  const [vatRate, setVatRate] = useState(18)
  const [vatAuto, setVatAuto] = useState(true)
  const [currentIlVat, setCurrentIlVat] = useState(18)
  const [savingToggle, setSavingToggle] = useState(false)

  // ── Receipts log ─────────────────────────────────────────────
  const [rows, setRows] = useState<ReceiptRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ── Casual-transaction report ────────────────────────────────
  const [month, setMonth] = useState(currentMonthValue())
  const [casualRows, setCasualRows] = useState<CasualRow[] | null>(null)
  const [casualTotals, setCasualTotals] = useState<Record<string, CasualTotals>>(
    {},
  )
  const [casualLoading, setCasualLoading] = useState(false)
  const [casualVat, setCasualVat] = useState(18)

  // ── Reporter ("עוסק") identity for the 8356 PDF ───────────────
  const [business, setBusiness] = useState<CasualBusiness>(EMPTY_BUSINESS)
  const [savingBusiness, setSavingBusiness] = useState(false)
  const [businessSaved, setBusinessSaved] = useState(false)
  // Effective VAT % the server used for this month's rows — shown on
  // each generated 8356 document.
  const [casualVatPercent, setCasualVatPercent] = useState(18)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'טעינה נכשלה')
  }

  async function loadSettings() {
    try {
      const r = await adminApi<{
        receiptsEnabled: boolean
        vatRate: number
        vatAuto: boolean
        currentIlVat: number
        sumitConfigured: boolean
        business?: Partial<CasualBusiness>
      }>('admin-get-receipts-settings')
      setSumitEnabled(Boolean(r.receiptsEnabled))
      setSumitConfigured(Boolean(r.sumitConfigured))
      setVatAuto(r.vatAuto !== false)
      setCurrentIlVat(r.currentIlVat || 18)
      setVatRate(r.vatRate || 18)
      setCasualVat(r.vatRate || 18)
      if (r.business)
        setBusiness({ ...EMPTY_BUSINESS, ...r.business })
    } catch (e) {
      handleErr(e)
    }
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const r = await adminApi<{ receipts: ReceiptRow[] }>('admin-list-receipts')
      setRows(Array.isArray(r.receipts) ? r.receipts : [])
    } catch (e) {
      handleErr(e)
    } finally {
      setLoading(false)
    }
  }

  async function toggleSumit(next: boolean) {
    setSavingToggle(true)
    setError('')
    try {
      await adminApi('admin-set-receipts-settings', { receiptsEnabled: next })
      setSumitEnabled(next)
    } catch (e) {
      handleErr(e)
    } finally {
      setSavingToggle(false)
    }
  }

  async function saveVat(next: number) {
    if (!(next > 0 && next < 100)) return
    setError('')
    try {
      await adminApi('admin-set-receipts-settings', { vatRate: next })
      setVatRate(next)
      void loadCasual()
    } catch (e) {
      handleErr(e)
    }
  }

  async function saveBusiness() {
    setSavingBusiness(true)
    setBusinessSaved(false)
    setError('')
    try {
      await adminApi('admin-set-receipts-settings', { business })
      setBusinessSaved(true)
      setTimeout(() => setBusinessSaved(false), 2500)
    } catch (e) {
      handleErr(e)
    } finally {
      setSavingBusiness(false)
    }
  }

  /** Switch between auto (track the current statutory rate) and manual. */
  async function setVatMode(auto: boolean) {
    setError('')
    try {
      await adminApi('admin-set-receipts-settings', { vatAuto: auto })
      setVatAuto(auto)
      if (auto) setCasualVat(currentIlVat)
      void loadCasual()
    } catch (e) {
      handleErr(e)
    }
  }

  const [marking, setMarking] = useState<string | null>(null)
  async function markReported(row: CasualRow, reported: boolean) {
    setMarking(row.eventId)
    setError('')
    try {
      await adminApi('admin-mark-casual-reported', {
        eventId: row.eventId,
        reported,
        at: row.at,
        amount: row.gross,
        currency: row.currency,
        email: row.email,
        name: row.name,
      })
      setCasualRows((prev) =>
        prev
          ? prev.map((r) =>
              r.eventId === row.eventId ? { ...r, reported } : r,
            )
          : prev,
      )
    } catch (e) {
      handleErr(e)
    } finally {
      setMarking(null)
    }
  }

  async function loadCasual() {
    const [yStr, mStr] = month.split('-')
    const year = Number(yStr)
    const m = Number(mStr)
    if (!year || !m) return
    setCasualLoading(true)
    setError('')
    try {
      const r = await adminApi<{
        rows: CasualRow[]
        totals: Record<string, CasualTotals>
        vatPercent: number
      }>('admin-casual-report', { year, month: m })
      setCasualRows(Array.isArray(r.rows) ? r.rows : [])
      setCasualTotals(r.totals || {})
      if (typeof r.vatPercent === 'number' && r.vatPercent > 0)
        setCasualVatPercent(r.vatPercent)
    } catch (e) {
      handleErr(e)
    } finally {
      setCasualLoading(false)
    }
  }

  useEffect(() => {
    void loadSettings()
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the casual report whenever that sub-tab is active or the month
  // changes.
  useEffect(() => {
    if (subTab === 'casual') void loadCasual()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, month])

  function downloadCasualCsv() {
    if (!casualRows) return
    const header = [
      'מס׳',
      'תאריך עסקה',
      'מועד דיווח אחרון',
      'שם הלקוח',
      'אימייל',
      'תיאור',
      'מטבע',
      'סכום כולל מע"מ',
      'מע"מ',
      'לפני מע"מ',
    ]
    const lines: (string | number)[][] = [header]
    for (const r of casualRows)
      lines.push([
        r.seq,
        fmtDateOnly(r.at),
        reportDeadline(r.at).label,
        r.name,
        r.email,
        r.description,
        r.currency,
        r.gross,
        r.vat,
        r.net,
      ])
    lines.push([])
    for (const [cur, t] of Object.entries(casualTotals))
      lines.push([
        '',
        `סה"כ ${cur}`,
        '',
        `${t.count} עסקאות`,
        '',
        '',
        cur,
        t.gross,
        t.vat,
        t.net,
      ])
    const csv =
      '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `casual-report-${month}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** Build a print-ready "דיווח עסקת אקראי – טופס 8356" document for a
   *  single transaction and open the browser print dialog (Save as PDF).
   *  Mirrors the partner-report print flow. Includes the reporter
   *  identity (from settings) plus the full VAT breakdown — exactly the
   *  fields form 8356 asks for. */
  async function downloadCasualPdf(row: CasualRow) {
    const esc = (s: string | number) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    const money = (n: number) =>
      `${(Number(n) || 0).toLocaleString('he-IL', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${row.currency}`
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

    const fullName = `${business.firstName} ${business.lastName}`.trim()
    const addressParts = [
      [business.street, business.houseNumber].filter(Boolean).join(' '),
      business.city,
      business.zip,
    ].filter(Boolean)
    const address = addressParts.join(', ')
    const deadline = reportDeadline(row.at)
    const today = new Date().toLocaleDateString('he-IL')
    const dash = '—'
    const infoMissing =
      !fullName || !business.idNumber || !address
        ? `<div class="warn">⚠ חלק מפרטי המדווח חסרים. מלאו אותם ב"פרטי המדווח לדיווח" כדי שהמסמך יהיה שלם לשליחה.</div>`
        : ''

    const rowHtml = (label: string, value: string, strong = false) =>
      `<tr><td class="lbl">${esc(label)}</td><td class="${strong ? 'val strong' : 'val'}">${value}</td></tr>`

    const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>דיווח עסקת אקראי - עסקה ${esc(row.seq)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Heebo','Assistant','Arial',sans-serif; color: #1f1a16; background: #fff; }
  .header { background: #16110D; color: #F5EFE6; padding: 26px 36px; display: flex; align-items: center; gap: 16px; }
  .header img { width: 46px; height: 46px; border-radius: 11px; }
  .brand { font-size: 13px; letter-spacing: .04em; color: #cdbba6; }
  .brand b { display:block; font-size: 19px; color: #F5EFE6; font-weight: 600; }
  .accent { height: 4px; background: linear-gradient(90deg,#C8843C,#9c6328); }
  .wrap { padding: 28px 36px; }
  h1 { font-size: 23px; margin: 0 0 4px; }
  .sub { color:#7a6f64; font-size: 13px; margin-bottom: 18px; }
  .warn { background:#fdf0e3; border:1px solid #f0c89a; color:#92560f; border-radius:10px; padding:10px 14px; font-size:12px; margin-bottom:16px; }
  h2 { font-size:14px; margin: 20px 0 8px; padding-right:10px; border-right:3px solid #C8843C; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:8px 12px; border-bottom:1px solid #eee3d6; vertical-align:top; }
  td.lbl { color:#7a6f64; width:38%; }
  td.val { color:#1f1a16; }
  td.val.strong { font-weight:700; font-size:15px; color:#9c6328; }
  .ltr { direction:ltr; unicode-bidi:isolate; }
  .amounts { margin-top:6px; border:1px solid #ece2d5; border-radius:12px; overflow:hidden; }
  .amounts td { border-bottom:1px solid #f1e8db; }
  .amounts tr:last-child td { border-bottom:0; background:#faf6f0; }
  .note { margin-top:22px; background:#faf6f0; border:1px solid #ece2d5; border-radius:12px; padding:14px 18px; font-size:12px; color:#5f564d; line-height:1.7; }
  .sign { margin-top:30px; display:flex; justify-content:space-between; gap:24px; }
  .sign div { flex:1; border-top:1px solid #c9bcab; padding-top:6px; font-size:12px; color:#7a6f64; text-align:center; }
  .foot { margin-top:26px; text-align:center; color:#9a8d7e; font-size:11px; }
</style></head><body>
  <div class="header">${logo ? `<img src="${logo}" alt="logo"/>` : ''}<div class="brand">דיווח עסקת אקראי<b>ניהול הורדות פלוס</b></div></div>
  <div class="accent"></div>
  <div class="wrap">
    <h1>דיווח עסקת אקראי — טופס 8356</h1>
    <div class="sub">עסקה מס׳ ${esc(row.seq)} · הופק בתאריך ${esc(today)}</div>
    ${infoMissing}

    <h2>פרטי המדווח</h2>
    <table>
      ${rowHtml('שם מלא', esc(fullName || dash))}
      ${rowHtml('מספר תעודת זהות', `<span class="ltr">${esc(business.idNumber || dash)}</span>`)}
      ${rowHtml('כתובת', esc(address || dash))}
      ${rowHtml('טלפון', `<span class="ltr">${esc(business.phone || dash)}</span>`)}
    </table>

    <h2>פרטי העסקה</h2>
    <table>
      ${rowHtml('תאריך העסקה', `<span class="ltr">${esc(fmtDateOnly(row.at))}</span>`)}
      ${rowHtml('מועד דיווח אחרון (30 יום)', `<span class="ltr">${esc(deadline.label || dash)}</span>${deadline.overdue ? ' · <b style="color:#b4231f">חלף המועד</b>' : ''}`)}
      ${rowHtml('תיאור השירות', esc(row.description || 'שירות דיגיטלי'))}
      ${rowHtml('שם הצד השני (הלקוח)', esc(row.name || dash))}
      ${rowHtml('דוא״ל הלקוח', `<span class="ltr">${esc(row.email || dash)}</span>`)}
    </table>

    <h2>פירוט סכומים</h2>
    <table class="amounts">
      ${rowHtml('מטבע', esc(row.currency))}
      ${rowHtml('סכום לפני מע״מ', `<span class="ltr">${money(row.net)}</span>`)}
      ${rowHtml('שיעור מע״מ', `${esc(casualVatPercent)}%`)}
      ${rowHtml('סכום המע״מ', `<span class="ltr">${money(row.vat)}</span>`)}
      ${rowHtml('סכום כולל מע״מ', `<span class="ltr">${money(row.gross)}</span>`, true)}
    </table>

    <div class="note">
      עסקת אקראי מדווחת לכל עסקה בנפרד בטופס 8356, ויש לדווח ולשלם את המע״מ
      תוך 30 יום ממועד העסקה. נותן השירות הוא החייב בתשלום המע״מ. ניתן
      להגיש את הדיווח באתר רשות המסים או בסניף מע״מ.
    </div>

    <div class="sign">
      <div>חתימת המדווח</div>
      <div>תאריך</div>
    </div>

    <div class="foot">הופק ע״י ניהול הורדות פלוס · dmplus.net · ${esc(today)}</div>
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
</body></html>`

    const w = window.open('', '_blank', 'width=900,height=1200')
    if (!w) {
      setError('הדפדפן חסם את חלון ההדפסה — אפשר חלונות קופצים ונסה שוב')
      return
    }
    w.document.open()
    w.document.write(html)
    w.document.close()
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">קבלות</h2>
          <p className="mt-1 text-sm text-fg-muted">
            ניהול הפקת הקבלות האוטומטית ודוח עסקת אקראי לדיווח למע"מ.
          </p>
        </div>
      </header>

      {/* Master switch — SUMIT pipeline on/off */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">
              הפקת קבלות אוטומטית דרך SUMIT
            </div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              כשהמתג כבוי — המערכת לא מפיקה קבלות ולא שולחת ל-SUMIT שום
              מידע על לקוחות. כל הגבייה ממשיכה כרגיל, פשוט בלי קבלה
              אוטומטית. כשהוא דלוק — כל קבלה מופקת ונשלחת ללקוח בדיוק כמו
              עכשיו.
            </p>
            {!sumitConfigured && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                שים לב: חשבון SUMIT לא מוגדר בשרת, אז גם אם תדליק לא יופקו
                קבלות עד שיוגדר.
              </p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={sumitEnabled === true}
            disabled={sumitEnabled === null || savingToggle}
            onClick={() => void toggleSumit(!(sumitEnabled === true))}
            className={
              'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ' +
              (sumitEnabled ? 'bg-success' : 'bg-border')
            }
          >
            <span
              className={
                'inline-block h-5 w-5 transform rounded-full bg-white transition-transform ' +
                (sumitEnabled ? '-translate-x-6' : '-translate-x-1')
              }
            />
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 rounded-xl border border-border bg-card p-1">
        <button
          type="button"
          onClick={() => setSubTab('receipts')}
          className={
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
            (subTab === 'receipts'
              ? 'bg-primary text-primary-foreground'
              : 'text-fg-muted hover:text-fg')
          }
        >
          <Receipt className="h-4 w-4" />
          קבלות
        </button>
        <button
          type="button"
          onClick={() => setSubTab('casual')}
          className={
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
            (subTab === 'casual'
              ? 'bg-primary text-primary-foreground'
              : 'text-fg-muted hover:text-fg')
          }
        >
          <FileText className="h-4 w-4" />
          עסקת אקראי
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {subTab === 'receipts' ? (
        <ReceiptsList rows={rows} loading={loading} onReload={load} />
      ) : (
        <CasualReport
          month={month}
          setMonth={setMonth}
          rows={casualRows}
          totals={casualTotals}
          loading={casualLoading}
          onReload={loadCasual}
          onDownload={downloadCasualCsv}
          vat={casualVat}
          setVat={setCasualVat}
          savedVat={vatRate}
          onSaveVat={saveVat}
          vatAuto={vatAuto}
          currentIlVat={currentIlVat}
          onSetVatMode={setVatMode}
          onMark={markReported}
          marking={marking}
          onDownloadPdf={downloadCasualPdf}
          business={business}
          setBusiness={setBusiness}
          onSaveBusiness={saveBusiness}
          savingBusiness={savingBusiness}
          businessSaved={businessSaved}
        />
      )}
    </div>
  )
}

/* ── Receipts log (SUMIT) ─────────────────────────────────────── */
function ReceiptsList({
  rows,
  loading,
  onReload,
}: {
  rows: ReceiptRow[] | null
  loading: boolean
  onReload: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg-muted">
          כל קבלות SUMIT שהופקו אוטומטית בעקבות תשלום או חידוש מנוי, מהחדש לישן.
        </p>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          רענון
        </button>
      </div>

      {rows === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-fg-muted">
          עדיין לא הופקו קבלות.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full text-right text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-fg-muted">
                <th className="px-4 py-3 font-medium">תאריך</th>
                <th className="px-4 py-3 font-medium">לקוח</th>
                <th className="px-4 py-3 font-medium">סכום</th>
                <th className="px-4 py-3 font-medium">מס׳ קבלה</th>
                <th className="px-4 py-3 font-medium">קישור</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-border/30 last:border-0 text-fg-muted"
                >
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {fmtDate(row.at)}
                  </td>
                  <td className="break-all px-4 py-3" dir="ltr">
                    <span className="inline-flex items-center gap-1.5">
                      {row.test && (
                        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                          בדיקה
                        </span>
                      )}
                      {row.email || '—'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {row.amount != null ? `${row.amount} ${row.currency}` : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {row.documentNumber ?? (row.draft ? 'טיוטה' : '—')}
                  </td>
                  <td className="px-4 py-3">
                    {row.url ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        פתח
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── Casual-transaction (עסקת אקראי) monthly report ───────────── */
function CasualReport({
  month,
  setMonth,
  rows,
  totals,
  loading,
  onReload,
  onDownload,
  vat,
  setVat,
  savedVat,
  onSaveVat,
  vatAuto,
  currentIlVat,
  onSetVatMode,
  onMark,
  marking,
  onDownloadPdf,
  business,
  setBusiness,
  onSaveBusiness,
  savingBusiness,
  businessSaved,
}: {
  month: string
  setMonth: (m: string) => void
  rows: CasualRow[] | null
  totals: Record<string, CasualTotals>
  loading: boolean
  onReload: () => void
  onDownload: () => void
  vat: number
  setVat: (n: number) => void
  savedVat: number
  onSaveVat: (n: number) => void
  vatAuto: boolean
  currentIlVat: number
  onSetVatMode: (auto: boolean) => void
  onMark: (row: CasualRow, reported: boolean) => void
  marking: string | null
  onDownloadPdf: (row: CasualRow) => void
  business: CasualBusiness
  setBusiness: (b: CasualBusiness) => void
  onSaveBusiness: () => void
  savingBusiness: boolean
  businessSaved: boolean
}) {
  const hasRows = rows && rows.length > 0
  const reportedCount = rows ? rows.filter((r) => r.reported).length : 0
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-xs leading-relaxed text-fg-muted">
        <p className="text-fg">
          עסקת אקראי מדווחת <strong>לכל עסקה בנפרד</strong> בטופס 8356, ויש
          לדווח ולשלם את המע"מ <strong>תוך 30 יום</strong> מהעסקה — לא פעם
          בחודש. הדוח כאן הוא יומן מרוכז לנוחותך; עמודת "מועד דיווח אחרון"
          מראה עד מתי לדווח כל שורה.
        </p>
        <p className="mt-2">
          המספרים מחושבים לפי מחיר הכולל מע"מ בשיעור הנוכחי. נותן השירות
          הוא החייב בתשלום המע"מ. שים לב: מכירה חוזרת ושיטתית של מנויים
          עלולה להיחשב "עסק" ולא עסקת אקראי — נקודה לבדוק מול רואה החשבון.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          חודש
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          מע"מ %
          <div className="flex items-center gap-2">
            {/* Auto = always the current Israeli statutory rate; Manual
                = a fixed rate you set. */}
            <div className="flex overflow-hidden rounded-md border border-border">
              <button
                type="button"
                onClick={() => onSetVatMode(true)}
                className={
                  'px-2.5 py-1.5 text-xs transition-colors ' +
                  (vatAuto
                    ? 'bg-primary text-primary-foreground'
                    : 'text-fg-muted hover:text-fg')
                }
              >
                אוטומטי
              </button>
              <button
                type="button"
                onClick={() => onSetVatMode(false)}
                className={
                  'px-2.5 py-1.5 text-xs transition-colors ' +
                  (!vatAuto
                    ? 'bg-primary text-primary-foreground'
                    : 'text-fg-muted hover:text-fg')
                }
              >
                ידני
              </button>
            </div>
            {vatAuto ? (
              <span className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg">
                {currentIlVat}%
              </span>
            ) : (
              <input
                type="number"
                value={vat}
                min={1}
                max={99}
                step={0.5}
                onChange={(e) => setVat(Number(e.target.value))}
                onBlur={() => {
                  if (vat !== savedVat) onSaveVat(vat)
                }}
                className="w-20 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg"
              />
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          רענון
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={!hasRows}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          הורדת הדוח
        </button>
      </div>

      {/* Reporter ("עוסק") details — used on every per-row 8356 PDF.
          Fill once; reused for all transactions. */}
      <BusinessDetailsCard
        business={business}
        setBusiness={setBusiness}
        onSave={onSaveBusiness}
        saving={savingBusiness}
        saved={businessSaved}
      />

      {/* Totals */}
      {Object.keys(totals).length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries(totals).map(([cur, t]) => (
            <div key={cur} className="rounded-2xl border border-border bg-card p-4">
              <div className="text-[11px] uppercase tracking-wider text-fg-muted">
                סה"כ {cur} · {t.count} עסקאות
              </div>
              <div className="mt-2 space-y-1 text-sm text-fg">
                <div className="flex justify-between">
                  <span className="text-fg-muted">כולל מע"מ</span>
                  <span dir="ltr">{t.gross.toLocaleString('he-IL')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-fg-muted">מתוכו מע"מ</span>
                  <span dir="ltr">{t.vat.toLocaleString('he-IL')}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span className="text-fg-muted">לפני מע"מ</span>
                  <span dir="ltr">{t.net.toLocaleString('he-IL')}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reporting progress */}
      {hasRows && (
        <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-2.5 text-xs">
          <span className="text-fg-muted">מעקב דיווח למע"מ</span>
          <span
            className={
              'font-medium ' +
              (reportedCount === (rows ? rows.length : 0)
                ? 'text-emerald-400'
                : 'text-fg')
            }
          >
            דווחו {reportedCount} מתוך {rows ? rows.length : 0}
          </span>
        </div>
      )}

      {/* Rows */}
      {rows === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-fg-muted">
          אין חיובים בחודש הזה.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full text-right text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-fg-muted">
                <th className="whitespace-nowrap px-4 py-3 font-medium">מס׳</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">תאריך עסקה</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">דיווח עד</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">לקוח</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">מטבע</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">כולל מע"מ</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">מע"מ</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">לפני מע"מ</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">מסמך</th>
                <th className="whitespace-nowrap px-4 py-3 font-medium">דיווח</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-border/30 last:border-0 text-fg-muted"
                >
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums" dir="ltr">
                    {row.seq}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {fmtDateOnly(row.at)}
                  </td>
                  <td
                    className={
                      'whitespace-nowrap px-4 py-3 ' +
                      (reportDeadline(row.at).overdue
                        ? 'font-medium text-destructive'
                        : '')
                    }
                    dir="ltr"
                  >
                    {reportDeadline(row.at).label}
                  </td>
                  <td className="px-4 py-3">
                    <div className="whitespace-nowrap text-fg">
                      {row.name || '—'}
                    </div>
                    <div
                      className="whitespace-nowrap text-[11px] text-fg-muted"
                      dir="ltr"
                    >
                      {row.email || ''}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {row.currency}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {row.gross.toLocaleString('he-IL')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {row.vat.toLocaleString('he-IL')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {row.net.toLocaleString('he-IL')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onDownloadPdf(row)}
                      title="הורד מסמך PDF לדיווח מע״מ (טופס 8356)"
                      className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15"
                    >
                      <FileDown className="h-3 w-3" />
                      PDF
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {row.reported ? (
                      <button
                        type="button"
                        onClick={() => onMark(row, false)}
                        disabled={marking === row.eventId}
                        title="בטל סימון דיווח"
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/15 disabled:opacity-50"
                      >
                        {marking === row.eventId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Check className="h-3 w-3" />
                        )}
                        דווח
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onMark(row, true)}
                        disabled={marking === row.eventId}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:border-primary/40 hover:text-fg disabled:opacity-50"
                      >
                        {marking === row.eventId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : null}
                        דיווחתי
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── Reporter ("עוסק") details form ───────────────────────────── */
function BusinessDetailsCard({
  business,
  setBusiness,
  onSave,
  saving,
  saved,
}: {
  business: CasualBusiness
  setBusiness: (b: CasualBusiness) => void
  onSave: () => void
  saving: boolean
  saved: boolean
}) {
  const set = (patch: Partial<CasualBusiness>) =>
    setBusiness({ ...business, ...patch })
  const field = (
    label: string,
    key: keyof CasualBusiness,
    opts: { ltr?: boolean; placeholder?: string } = {},
  ) => (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      {label}
      <input
        type="text"
        value={(business[key] as string) || ''}
        onChange={(e) =>
          set({ [key]: e.target.value } as Partial<CasualBusiness>)
        }
        placeholder={opts.placeholder}
        dir={opts.ltr ? 'ltr' : undefined}
        className="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg"
      />
    </label>
  )
  return (
    <details className="group rounded-2xl border border-border bg-card">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-fg">
        <span className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" />
          פרטי המדווח לדיווח (טופס 8356)
        </span>
        <span className="text-[11px] font-normal text-fg-muted">
          מופיעים בכל מסמך PDF · לחצו לעריכה
        </span>
      </summary>
      <div className="border-t border-border p-4">
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">
          אלה הפרטים שטופס 8356 מבקש על המדווח (נותן השירות). עסקת אקראי
          מדווחת על ידי אדם פרטי — לא דרושים פרטי עוסק. הפרטים נשמרים
          אצלך בלבד (לא חשופים לאפליקציה) ומשובצים אוטומטית בכל מסמך
          שתורידו. מלאו פעם אחת.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('שם פרטי', 'firstName')}
          {field('שם משפחה', 'lastName')}
          {field('מספר תעודת זהות', 'idNumber', {
            ltr: true,
            placeholder: '000000000',
          })}
          {field('טלפון', 'phone', { ltr: true, placeholder: '050-0000000' })}
          {field('יישוב', 'city')}
          {field('רחוב', 'street')}
          {field('מספר בית', 'houseNumber')}
          {field('מיקוד', 'zip', { ltr: true })}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            שמירת פרטי המדווח
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              נשמר
            </span>
          )}
        </div>
      </div>
    </details>
  )
}
