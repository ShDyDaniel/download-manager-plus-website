import { useEffect, useState } from 'react'
import { RefreshCw, Loader2, AlertTriangle, ExternalLink } from 'lucide-react'
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

export default function ReceiptsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [rows, setRows] = useState<ReceiptRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'טעינה נכשלה')
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

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">קבלות</h2>
          <p className="mt-1 text-sm text-fg-muted">
            כל קבלות SUMIT שהופקו אוטומטית בעקבות תשלום או חידוש מנוי, מהחדש לישן.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
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
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

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
