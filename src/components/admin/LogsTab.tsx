import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Bug,
  ChevronDown,
  Check,
  RotateCcw,
  Trash2,
  Users,
  Hash,
  Download,
  Waves,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { cachedAdminApi, peekAdminCache } from '../../lib/adminCache'
import { buildZip, type ZipEntry } from '../../lib/zip'
import { Switch } from '@/components/ui/Switch'

interface ErrorRow {
  fingerprint: string
  level: string
  message: string
  count: number
  deviceCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  lastVersion: string
  lastPlatform: string
  resolved: boolean
}
interface ErrorSample {
  at?: string
  email?: string
  deviceId?: string
  appVersion?: string
  platform?: string
  message?: string
  stack?: string
  context?: unknown
}
interface ErrorDetail extends ErrorRow {
  samples?: ErrorSample[]
}

function fmtDate(iso: string | null | undefined): string {
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
    return String(iso)
  }
}

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  error: { label: 'שגיאה', cls: 'bg-destructive/15 text-destructive' },
  fatal: { label: 'קריטי', cls: 'bg-destructive/25 text-destructive' },
  warn: { label: 'אזהרה', cls: 'bg-accent/15 text-accent' },
  warning: { label: 'אזהרה', cls: 'bg-accent/15 text-accent' },
  info: { label: 'מידע', cls: 'bg-white/[0.08] text-fg-muted' },
}

export default function LogsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const logSeed = peekAdminCache<{ errors: ErrorRow[]; open: number }>(
    'admin-list-client-errors',
  )
  const [errors, setErrors] = useState<ErrorRow[] | null>(
    logSeed?.errors ?? null,
  )
  const [open, setOpen] = useState(logSeed?.open ?? 0)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [busyAction, setBusyAction] = useState<'resolve' | 'delete' | ''>('')

  const [expanded, setExpanded] = useState('')
  const [details, setDetails] = useState<Record<string, ErrorDetail>>({})
  const [detailLoading, setDetailLoading] = useState('')

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'הפעולה נכשלה')
  }

  async function load(force = false) {
    setError('')
    if (force) setRefreshing(true)
    try {
      const r = await cachedAdminApi<{ errors: ErrorRow[]; open: number }>(
        'admin-list-client-errors',
        {},
        { force },
      )
      setErrors(r.errors || [])
      setOpen(r.open || 0)
    } catch (e) {
      handleErr(e)
      setErrors([])
    } finally {
      if (force) setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleExpand(fp: string) {
    if (expanded === fp) {
      setExpanded('')
      return
    }
    setExpanded(fp)
    if (details[fp]) return
    setDetailLoading(fp)
    try {
      const r = await adminApi<{ error: ErrorDetail }>('admin-get-client-error', {
        fingerprint: fp,
      })
      setDetails((d) => ({ ...d, [fp]: r.error }))
    } catch (e) {
      handleErr(e)
      setExpanded('')
    } finally {
      setDetailLoading('')
    }
  }

  async function resolve(row: ErrorRow) {
    setBusyKey(row.fingerprint)
    setBusyAction('resolve')
    try {
      await adminApi('admin-resolve-client-error', {
        fingerprint: row.fingerprint,
        resolved: !row.resolved,
      })
      await load(true)
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyKey('')
      setBusyAction('')
    }
  }

  async function del(row: ErrorRow) {
    if (!window.confirm('למחוק את רישום התקלה הזה?')) return
    setBusyKey(row.fingerprint)
    setBusyAction('delete')
    try {
      await adminApi('admin-delete-client-error', { fingerprint: row.fingerprint })
      await load(true)
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyKey('')
      setBusyAction('')
    }
  }

  async function clearAll() {
    if (!window.confirm('למחוק את כל רישומי התקלות? הפעולה לא הפיכה.')) return
    setClearing(true)
    try {
      await adminApi('admin-clear-client-errors')
      await load(true)
    } catch (e) {
      handleErr(e)
    } finally {
      setClearing(false)
    }
  }

  // ── Audio-sync telemetry export (opt-in data from users, for engine tuning) ──
  // The data (per-sync events + gzipped acoustic fingerprints) lives in R2, not
  // Firestore. The server returns a MANIFEST: every object's key + a 6-hour
  // presigned download URL. We save that manifest as JSON — hand it to Claude,
  // which fetches every file from the links and analyzes the dataset.
  const [telDl, setTelDl] = useState(false)
  const [telClr, setTelClr] = useState(false)
  const [telInfo, setTelInfo] = useState('')
  // Global ingestion pause — null until admin-get-app-config answers.
  const [telPaused, setTelPaused] = useState<boolean | null>(null)
  const [telPausing, setTelPausing] = useState(false)
  // Global error-log collection kill-switch (separate from telemetry).
  const [logsOff, setLogsOff] = useState<boolean | null>(null)
  const [logsBusy, setLogsBusy] = useState(false)
  useEffect(() => {
    adminApi<{ syncTelemetryDisabled?: boolean; clientLogsDisabled?: boolean }>(
      'admin-get-app-config',
    )
      .then((c) => {
        setTelPaused(c.syncTelemetryDisabled === true)
        setLogsOff(c.clientLogsDisabled === true)
      })
      .catch(() => {
        setTelPaused(null)
        setLogsOff(null)
      })
  }, [])

  async function toggleLogsOff(next: boolean) {
    setLogsBusy(true)
    setError('')
    try {
      await adminApi('admin-set-app-config', { clientLogsDisabled: next })
      setLogsOff(next)
    } catch (e) {
      handleErr(e)
    } finally {
      setLogsBusy(false)
    }
  }

  async function toggleTelemetryPaused(next: boolean) {
    setTelPausing(true)
    setError('')
    try {
      await adminApi('admin-set-app-config', { syncTelemetryDisabled: next })
      setTelPaused(next)
    } catch (e) {
      handleErr(e)
    } finally {
      setTelPausing(false)
    }
  }

  async function downloadSyncTelemetry() {
    setTelDl(true)
    setError('')
    setTelInfo('')
    try {
      const r = await adminApi<{
        events: { key: string; url: string; size: number }[]
        fingerprints: { hash: string; url: string; size: number }[]
        timelines: { key: string; url: string; size: number }[]
        count: number
        fingerprintCount: number
        timelineCount: number
        truncated: boolean
        urlTtlSeconds: number
        exportedAt: string
      }>('admin-sync-telemetry-export', {})

      // Pull every object straight from R2 (CORS allows GET from the
      // site origin) and pack ONE zip: events/ + timelines/ (gunzipped
      // back to readable .xml) + fingerprints/ (kept .bin.gz) + the
      // manifest itself.
      const canGunzip = typeof DecompressionStream !== 'undefined'
      const jobs = [
        ...r.events.map((e) => ({
          url: e.url,
          path: e.key.replace(/^sync-telemetry\//, ''),
          gunzip: false,
        })),
        ...r.timelines.map((t) => {
          const base = t.key
            .replace(/^sync-telemetry\/timelines\//, '')
            .replace(/\.gz$/, '')
          return canGunzip
            ? { url: t.url, path: `timelines/${base}`, gunzip: true }
            : { url: t.url, path: `timelines/${base}.gz`, gunzip: false }
        }),
        ...r.fingerprints.map((f) => ({
          url: f.url,
          path: `fingerprints/${f.hash}.bin.gz`,
          gunzip: false,
        })),
      ]

      const entries: ZipEntry[] = []
      let done = 0
      let skipped = 0
      const queue = [...jobs]
      // 4 parallel fetches — fingerprint blobs can be several MB each.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (;;) {
            const job = queue.shift()
            if (!job) return
            try {
              const resp = await fetch(job.url)
              if (!resp.ok) throw new Error(String(resp.status))
              let data: Uint8Array
              if (job.gunzip && resp.body) {
                const ds = resp.body.pipeThrough(new DecompressionStream('gzip'))
                data = new Uint8Array(await new Response(ds).arrayBuffer())
              } else {
                data = new Uint8Array(await resp.arrayBuffer())
              }
              entries.push({ name: job.path, data })
            } catch {
              // Object vanished (reset mid-export) or mid-upload — skip.
              skipped += 1
            }
            done += 1
            setTelInfo(`מוריד ${done}/${jobs.length} קבצים…`)
          }
        }),
      )
      entries.sort((a, b) => a.name.localeCompare(b.name))
      entries.push({
        name: 'manifest.json',
        data: new TextEncoder().encode(JSON.stringify(r, null, 2)),
      })

      const blob = buildZip(entries)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dmplus-sync-telemetry-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setTelInfo(
        `${r.count} סנכרונים · ${r.fingerprintCount} טביעות אצבע · ${r.timelineCount ?? 0} קבצי טיימליין · ירדו כקובץ ZIP אחד` +
          (skipped ? ` (${skipped} קבצים דולגו, ייתכן שהעלאה רצה ברקע)` : ''),
      )
    } catch (e) {
      handleErr(e)
    } finally {
      setTelDl(false)
    }
  }

  const clearSyncTelemetry = async () => {
    if (
      !window.confirm(
        'לאפס את כל נתוני הסנכרון שנאספו? כל האירועים, טביעות האצבע וקבצי הטיימליין יימחקו לצמיתות מהאחסון.',
      )
    )
      return
    setTelClr(true)
    setError('')
    setTelInfo('')
    try {
      const r = await adminApi<{ deleted: number }>('admin-sync-telemetry-clear', {})
      setTelInfo(`נמחקו ${r.deleted} קבצים. המערכת נקייה ומוכנה לאיסוף חדש`)
    } catch (e) {
      handleErr(e)
    } finally {
      setTelClr(false)
    }
  }

  const visible = (errors || []).filter((e) => showResolved || !e.resolved)

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">לוגים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            תקלות שהתוכנה דיווחה עליהן, מקובצות לפי סוג. שורה אחת לכל תקלה עם
            מספר הפעמים והמכשירים. לחיצה פותחת את הפרטים.
          </p>
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2">
            <Switch
              checked={logsOff === true}
              onCheckedChange={(v) => toggleLogsOff(v)}
              disabled={logsOff === null || logsBusy}
            />
            <span
              className={
                'text-xs ' +
                (logsOff ? 'font-medium text-rose-400' : 'text-fg-muted')
              }
            >
              {logsOff
                ? 'איסוף שגיאות מושבת · לא נשלחות שגיאות מהמשתמשים'
                : 'השבתת איסוף שגיאות · עצירת שליחת כל השגיאות מהמשתמשים'}
            </span>
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 py-2 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-60"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
            />{' '}
            {refreshing ? 'מרענן…' : 'רענן'}
          </button>
          {(errors?.length || 0) > 0 && (
            <button
              type="button"
              onClick={clearAll}
              disabled={clearing}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {clearing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              נקה הכל
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* Audio-sync telemetry — opt-in data uploaded by users after each sync,
          for tuning the engine. Stored in R2 (events + gzipped fingerprints).
          The button downloads a MANIFEST with 6-hour presigned links to every
          file, to hand off for analysis. */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] px-5 py-4">
        <Waves className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">נתוני סנכרון אוטומטי</div>
          <div className="text-xs text-fg-muted">
            נתונים אנונימיים שמשתמשים שאישרו שולחים בסוף כל סנכרון. כל מועמד
            והציונים שלו, ההקשר, טביעות האצבע האקוסטיות, ומבנה הטיימליין של
            הקלט והפלט (מעוקר, ללא מדיה או שמות קבצים). ההורדה היא קובץ ZIP
            אחד עם כל הקבצים מסודרים בתיקיות.
          </div>
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2">
            <Switch
              checked={telPaused === true}
              onCheckedChange={(v) => toggleTelemetryPaused(v)}
              disabled={telPaused === null || telPausing}
            />
            <span
              className={
                'text-xs ' +
                (telPaused ? 'font-medium text-rose-400' : 'text-fg-muted')
              }
            >
              {telPaused
                ? 'קליטת נתונים מושבתת · משתמשים לא מעלים שום דבר חדש'
                : 'השבתת קליטה · עצירת כל ההעלאות מהמשתמשים'}
            </span>
          </label>
          {telInfo && (
            <div className="mt-1 text-xs font-medium text-primary">{telInfo}</div>
          )}
        </div>
        <button
          type="button"
          onClick={downloadSyncTelemetry}
          disabled={telDl}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {telDl ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {telDl ? 'מוריד…' : 'הורדת הכל (ZIP)'}
        </button>
        <button
          type="button"
          onClick={clearSyncTelemetry}
          disabled={telClr}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-500/20 disabled:opacity-60"
        >
          {telClr ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {telClr ? 'מוחק…' : 'איפוס כל הנתונים'}
        </button>
      </div>

      {/* Summary + filter */}
      {errors && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card px-5 py-3 text-sm">
          <Bug className="h-5 w-5 text-primary" />
          <span className="text-fg">
            <strong>{open}</strong> תקלות פתוחות
          </span>
          <span className="text-fg-faint">·</span>
          <span className="text-fg-muted">{errors.length} סה״כ</span>
          <label className="ms-auto flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            הצג גם תקלות שטופלו
          </label>
        </div>
      )}

      {/* List */}
      {errors === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-border py-12 text-center text-sm text-fg-muted">
          {errors.length === 0
            ? 'אין תקלות מדווחות 🎉'
            : 'אין תקלות פתוחות. (סמן "הצג גם תקלות שטופלו" כדי לראות הכל.)'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((row) => {
            const meta = LEVEL_META[row.level] || LEVEL_META.error
            const isOpen = expanded === row.fingerprint
            const rowBusy = busyKey === row.fingerprint
            const det = details[row.fingerprint]
            return (
              <div
                key={row.fingerprint}
                className={
                  'overflow-hidden rounded-xl border bg-card ' +
                  (row.resolved ? 'border-border opacity-60' : 'border-border')
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(row.fingerprint)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-right"
                  >
                    <ChevronDown
                      className={
                        'h-4 w-4 shrink-0 text-fg-faint transition-transform ' +
                        (isOpen ? 'rotate-180' : '')
                      }
                    />
                    <span
                      className={
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ' +
                        meta.cls
                      }
                    >
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm text-fg"
                        dir="ltr"
                        title={row.message}
                      >
                        {row.message || '(ללא הודעה)'}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-faint">
                        <span className="flex items-center gap-1">
                          <Hash className="h-3 w-3" />
                          {row.count.toLocaleString()} פעמים
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {row.deviceCount} מכשירים
                        </span>
                        <span>אחרון: {fmtDate(row.lastSeenAt)}</span>
                        <span dir="ltr">
                          {row.lastPlatform} · v{row.lastVersion}
                        </span>
                      </span>
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => resolve(row)}
                      disabled={rowBusy}
                      title={row.resolved ? 'החזר לפתוח' : 'סמן כטופל'}
                      className={
                        'flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 ' +
                        (row.resolved
                          ? 'border-border text-fg-muted hover:bg-popover'
                          : 'border-success/40 bg-success/10 text-success hover:bg-success/20')
                      }
                    >
                      {rowBusy && busyAction === 'resolve' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : row.resolved ? (
                        <RotateCcw className="h-3.5 w-3.5" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {row.resolved ? 'פתח מחדש' : 'טופל'}
                    </button>
                    <button
                      type="button"
                      onClick={() => del(row)}
                      disabled={rowBusy}
                      title="מחק"
                      className="flex items-center gap-1 rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {rowBusy && busyAction === 'delete' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Expanded: individual occurrences */}
                {isOpen && (
                  <div className="border-t border-border bg-background/40 px-4 py-3">
                    {detailLoading === row.fingerprint ? (
                      <div className="flex items-center gap-2 text-xs text-fg-muted">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען פרטים…
                      </div>
                    ) : det?.samples && det.samples.length > 0 ? (
                      <div className="space-y-2">
                        <div className="text-[11px] text-fg-faint">
                          מציג {det.samples.length} מקרים אחרונים (מתוך{' '}
                          {row.count.toLocaleString()} בסך הכל):
                        </div>
                        {det.samples.map((s, i) => (
                          <div
                            key={i}
                            className="rounded-lg border border-border bg-card p-3"
                          >
                            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
                              <span>{fmtDate(s.at)}</span>
                              {s.email && s.email !== '?' && (
                                <span dir="ltr">{s.email}</span>
                              )}
                              <span dir="ltr">
                                {s.platform} · v{s.appVersion}
                              </span>
                              {s.deviceId && (
                                <span className="text-fg-faint" dir="ltr">
                                  {String(s.deviceId).slice(0, 12)}
                                </span>
                              )}
                            </div>
                            {s.stack ? (
                              <pre
                                className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px] leading-relaxed text-fg-muted"
                                dir="ltr"
                              >
                                {s.stack}
                              </pre>
                            ) : (
                              <div className="text-[11px] text-fg" dir="ltr">
                                {s.message}
                              </div>
                            )}
                            {s.context != null && (
                              <pre
                                className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px] text-fg-faint"
                                dir="ltr"
                              >
                                {typeof s.context === 'string'
                                  ? s.context
                                  : JSON.stringify(s.context, null, 2)}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-fg-faint">אין פרטים נוספים.</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-fg-faint">
        התקלות מגיעות מהתוכנה במחשבי המשתמשים. היא כותבת אותן לקובץ מקומי
        ומעלה אותו אוטומטית כל כמה שעות. תקלות זהות מקובצות יחד. "טופל" רק מסמן
        ויזואלית; "מחק" מסיר את הרישום.
      </p>
    </div>
  )
}
