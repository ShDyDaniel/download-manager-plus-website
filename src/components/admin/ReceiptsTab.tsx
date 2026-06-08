import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Download,
  FileText,
  Receipt,
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
  at: string
  email: string
  currency: string
  gross: number
  vat: number
  net: number
}

interface CasualTotals {
  count: number
  gross: number
  vat: number
  net: number
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
        sumitConfigured: boolean
      }>('admin-get-receipts-settings')
      setSumitEnabled(Boolean(r.receiptsEnabled))
      setSumitConfigured(Boolean(r.sumitConfigured))
      setVatRate(r.vatRate || 18)
      setCasualVat(r.vatRate || 18)
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
    } catch (e) {
      handleErr(e)
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
      'תאריך',
      'לקוח',
      'מטבע',
      'סכום כולל מע"מ',
      'מע"מ',
      'לפני מע"מ',
    ]
    const lines: (string | number)[][] = [header]
    for (const r of casualRows)
      lines.push([fmtDateOnly(r.at), r.email, r.currency, r.gross, r.vat, r.net])
    lines.push([])
    for (const [cur, t] of Object.entries(casualTotals))
      lines.push([
        `סה"כ ${cur}`,
        `${t.count} עסקאות`,
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
}) {
  const hasRows = rows && rows.length > 0
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        דוח חודשי של כל החיובים בפועל לדיווח עסקת אקראי למע"מ. המספרים
        מחושבים לפי מחיר הכולל מע"מ. אפשר להוריד כקובץ ולשלוח.
      </p>

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
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          מע"מ %
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
        </label>
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
                <th className="px-4 py-3 font-medium">תאריך</th>
                <th className="px-4 py-3 font-medium">לקוח</th>
                <th className="px-4 py-3 font-medium">מטבע</th>
                <th className="px-4 py-3 font-medium">כולל מע"מ</th>
                <th className="px-4 py-3 font-medium">מע"מ</th>
                <th className="px-4 py-3 font-medium">לפני מע"מ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-border/30 last:border-0 text-fg-muted"
                >
                  <td className="whitespace-nowrap px-4 py-3" dir="ltr">
                    {fmtDateOnly(row.at)}
                  </td>
                  <td className="break-all px-4 py-3" dir="ltr">
                    {row.email || '—'}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
