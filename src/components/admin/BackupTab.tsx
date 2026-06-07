import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Database,
  Download,
  RotateCcw,
  Trash2,
  Plus,
  ShieldCheck,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

interface BackupItem {
  key: string
  type: string // manual | auto | prerestore
  sizeBytes: number
  createdAt: string | null
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
function fmtDate(iso: string | null): string {
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

const TYPE_META: Record<string, { label: string; cls: string }> = {
  manual: { label: 'ידני', cls: 'bg-primary/15 text-primary' },
  auto: { label: 'אוטומטי', cls: 'bg-white/[0.08] text-fg-muted' },
  prerestore: { label: 'לפני שחזור', cls: 'bg-accent/15 text-accent' },
}

export default function BackupTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [backups, setBackups] = useState<BackupItem[] | null>(null)
  const [totalBytes, setTotalBytes] = useState(0)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [busyAction, setBusyAction] = useState<'restore' | 'delete' | 'download' | ''>('')
  const [notice, setNotice] = useState('')

  async function load() {
    setError('')
    try {
      const r = await adminApi<{
        backups: BackupItem[]
        count: number
        totalBytes: number
      }>('admin-list-backups')
      setBackups(r.backups || [])
      setTotalBytes(r.totalBytes || 0)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'טעינה נכשלה')
      setBackups([])
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }
  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'הפעולה נכשלה')
  }

  async function createNow() {
    setCreating(true)
    setError('')
    try {
      const r = await adminApi<{ backup: { docCount: number; sizeBytes: number } }>(
        'admin-create-backup',
      )
      flash(
        `גיבוי נוצר ✓ (${r.backup.docCount.toLocaleString()} מסמכים · ${fmtBytes(
          r.backup.sizeBytes,
        )})`,
      )
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setCreating(false)
    }
  }

  async function restore(item: BackupItem) {
    if (
      !window.confirm(
        'שחזור גיבוי יחזיר את המידע למצב שבו היה בזמן הגיבוי וידרוס מסמכים קיימים. ' +
          '(לפני השחזור נשמר אוטומטית גיבוי בטיחות של המצב הנוכחי.) להמשיך?',
      )
    )
      return
    setBusyKey(item.key)
    setBusyAction('restore')
    setError('')
    try {
      const r = await adminApi<{ restored: number }>('admin-restore-backup', {
        key: item.key,
      })
      flash(`שוחזרו ${r.restored.toLocaleString()} מסמכים ✓`)
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyKey('')
      setBusyAction('')
    }
  }

  async function del(item: BackupItem) {
    if (!window.confirm('למחוק את הגיבוי הזה לצמיתות?')) return
    setBusyKey(item.key)
    setBusyAction('delete')
    setError('')
    try {
      await adminApi('admin-delete-backup', { key: item.key })
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyKey('')
      setBusyAction('')
    }
  }

  async function download(item: BackupItem) {
    setBusyKey(item.key)
    setBusyAction('download')
    setError('')
    try {
      const r = await adminApi<{ url: string }>('admin-download-backup', {
        key: item.key,
      })
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyKey('')
      setBusyAction('')
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">גיבוי</h2>
          <p className="mt-1 text-sm text-fg-muted">
            גיבוי מלא של מסד הנתונים נשמר ב-Cloudflare R2. גיבוי אוטומטי רץ פעם
            ביום (נשמרים 30 הימים האחרונים), ואפשר ליצור/לשחזר/למחוק ידנית.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
          >
            <RefreshCw className="h-3.5 w-3.5" /> רענן
          </button>
          <button
            type="button"
            onClick={createNow}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            צור גיבוי עכשיו
          </button>
        </div>
      </header>

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          <ShieldCheck className="h-4 w-4" /> {notice}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* Summary */}
      {backups && (
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card px-5 py-3 text-sm">
          <Database className="h-5 w-5 text-primary" />
          <span className="text-fg">
            <strong>{backups.length}</strong> גיבויים
          </span>
          <span className="text-fg-faint">·</span>
          <span className="text-fg-muted">סה״כ {fmtBytes(totalBytes)}</span>
        </div>
      )}

      {/* List */}
      {backups === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : backups.length === 0 ? (
        <div className="rounded-2xl border border-border py-12 text-center text-sm text-fg-muted">
          אין עדיין גיבויים. לחץ "צור גיבוי עכשיו" כדי ליצור את הראשון.
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((b) => {
            const meta = TYPE_META[b.type] || TYPE_META.auto
            const rowBusy = busyKey === b.key
            return (
              <div
                key={b.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={
                      'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ' +
                      meta.cls
                    }
                  >
                    {meta.label}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm text-fg">{fmtDate(b.createdAt)}</div>
                    <div className="text-[11px] text-fg-faint" dir="ltr">
                      {fmtBytes(b.sizeBytes)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => download(b)}
                    disabled={rowBusy}
                    title="הורד"
                    className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-popover hover:text-fg disabled:opacity-50"
                  >
                    {rowBusy && busyAction === 'download' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    הורד
                  </button>
                  <button
                    type="button"
                    onClick={() => restore(b)}
                    disabled={rowBusy}
                    title="שחזר"
                    className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                  >
                    {rowBusy && busyAction === 'restore' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    שחזר
                  </button>
                  <button
                    type="button"
                    onClick={() => del(b)}
                    disabled={rowBusy}
                    title="מחק"
                    className="flex items-center gap-1 rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {rowBusy && busyAction === 'delete' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    מחק
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-fg-faint">
        הגיבוי כולל את כל המידע החשוב (לקוחות, מנויים, מפתחות, הגדרות, סבבי
        תיקונים והערות). שחזור דורש אישור ביומטרי, וכ"רשת ביטחון" הוא תמיד שומר
        אוטומטית גיבוי של המצב הנוכחי לפני הדריסה. שחזור מחזיר מסמכים מהגיבוי;
        מסמכים שנוצרו אחרי הגיבוי לא נמחקים.
      </p>
    </div>
  )
}
