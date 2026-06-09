import { useEffect, useRef, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Database,
  Download,
  RotateCcw,
  Trash2,
  Plus,
  Upload,
  ShieldCheck,
  ChevronDown,
  Save,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

interface BackupItem {
  key: string
  type: string // manual | auto | prerestore | uploaded
  sizeBytes: number
  createdAt: string | null
}
interface BackupSummary {
  createdAt: string | null
  type: string | null
  docCount: number
  collections: Array<{ name: string; count: number }>
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
  uploaded: { label: 'הועלה', cls: 'bg-success/15 text-success' },
}

// Friendly Hebrew names for the collections, so the breakdown is readable.
const COLLECTION_LABELS: Record<string, string> = {
  productKeys: 'מפתחות / רישיונות',
  users: 'משתמשים',
  appConfig: 'הגדרות מערכת',
  referralPartners: 'שותפים',
  receipts: 'קבלות',
  trialFingerprints: 'טביעות ניסיון',
  usageStats: 'סטטיסטיקות שימוש',
  feedback: 'פניות ודיווחים',
  integrations: 'אינטגרציות',
  pendingSubscriptions: 'מנויים בהמתנה',
  adminCredentials: 'מפתחות אדמין (Passkey)',
  adminSecurity: 'אבטחת אדמין',
  revisionProjects: 'סבבי תיקונים',
  revisionGroups: 'קבוצות סבבים',
  notes: 'הערות',
}

// Cadence options — value in MINUTES so the schedule can go below a day
// (multiple-per-day and quick testing), not just whole days.
const INTERVALS = [
  { v: 5, label: 'כל 5 דקות · לבדיקה' },
  { v: 15, label: 'כל 15 דקות' },
  { v: 30, label: 'כל 30 דקות' },
  { v: 60, label: 'כל שעה' },
  { v: 360, label: 'כל 6 שעות' },
  { v: 720, label: 'כל 12 שעות' },
  { v: 1440, label: 'כל יום' },
  { v: 4320, label: 'כל 3 ימים' },
  { v: 10080, label: 'כל שבוע' },
  { v: 20160, label: 'כל שבועיים' },
  { v: 43200, label: 'כל חודש' },
]

function intervalLabel(min: number): string {
  const found = INTERVALS.find((o) => o.v === min)
  if (found) return found.label.replace(' · לבדיקה', '')
  if (min < 60) return `כל ${min} דקות`
  if (min < 1440) return `כל ${Math.round(min / 60)} שעות`
  return `כל ${Math.round(min / 1440)} ימים`
}

function fmtRel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} שניות`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} דקות`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} שעות`
  return `${Math.round(h / 24)} ימים`
}

export default function BackupTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [backups, setBackups] = useState<BackupItem[] | null>(null)
  const [totalBytes, setTotalBytes] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [busyAction, setBusyAction] = useState<'restore' | 'delete' | 'download' | ''>('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Expand-to-inspect
  const [expanded, setExpanded] = useState('')
  const [summaries, setSummaries] = useState<Record<string, BackupSummary>>({})
  const [summaryLoading, setSummaryLoading] = useState('')

  // Settings (frequency in MINUTES + telegram notify)
  const [intervalMinutes, setIntervalMinutes] = useState(1440)
  const [notify, setNotify] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsMsg, setSettingsMsg] = useState('')

  // In-panel auto-backup scheduler status (see the polling effect below).
  const [lastAutoCheck, setLastAutoCheck] = useState(0)
  const [nextDueMs, setNextDueMs] = useState<number | null>(null)

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }
  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'הפעולה נכשלה')
  }

  async function load() {
    setError('')
    try {
      const r = await adminApi<{
        backups: BackupItem[]
        totalBytes: number
      }>('admin-list-backups')
      setBackups(r.backups || [])
      setTotalBytes(r.totalBytes || 0)
    } catch (e) {
      handleErr(e)
      setBackups([])
    }
  }
  async function loadSettings() {
    try {
      const r = await adminApi<{
        backupIntervalMinutes?: number
        backupIntervalDays?: number
        backupNotify?: boolean
      }>('admin-get-app-config')
      setIntervalMinutes(
        r.backupIntervalMinutes ||
          (r.backupIntervalDays ? r.backupIntervalDays * 1440 : 1440),
      )
      setNotify(r.backupNotify === true)
    } catch (e) {
      handleErr(e)
    }
  }

  useEffect(() => {
    void load()
    void loadSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // In-panel auto-backup scheduler. The Vercel cron only runs once a day,
  // so sub-daily / minute cadences (and quick testing) are driven from
  // here: while this tab is open we ask the server every minute whether a
  // backup is due, and it creates one if so. The due-logic lives entirely
  // server-side (admin-run-auto-backup) — this is just the heartbeat.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const r = await adminApi<{
          created?: boolean
          nextDueInMs?: number
          backup?: { docCount: number; sizeBytes: number }
        }>('admin-run-auto-backup')
        if (cancelled) return
        setLastAutoCheck(Date.now())
        if (r.created) {
          setNextDueMs(null)
          flash('בוצע גיבוי אוטומטי ✓')
          void load()
        } else if (typeof r.nextDueInMs === 'number') {
          setNextDueMs(r.nextDueInMs)
        }
      } catch {
        /* silent — background heartbeat; visible actions surface errors */
      }
    }
    void tick()
    const id = setInterval(tick, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveSettings() {
    setSettingsSaving(true)
    setSettingsMsg('')
    try {
      const r = await adminApi<{
        backupCron?: { synced: boolean; cron: string; error?: string }
      }>('admin-set-app-config', {
        backupIntervalMinutes: intervalMinutes,
        backupNotify: notify,
      })
      if (r.backupCron?.synced) {
        setSettingsMsg('נשמר ✓ · לוח הזמנים עודכן')
      } else if (r.backupCron && !r.backupCron.synced) {
        setSettingsMsg('נשמר ✓ · עדכון לוח הזמנים בוורקר ידני')
      } else {
        setSettingsMsg('נשמר ✓')
      }
      setTimeout(() => setSettingsMsg(''), 3500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setSettingsMsg(err.message || 'שמירה נכשלה')
    } finally {
      setSettingsSaving(false)
    }
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

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const content = await file.text()
      const r = await adminApi<{ docCount: number }>('admin-upload-backup', {
        content,
      })
      flash(`קובץ הועלה ✓ (${r.docCount.toLocaleString()} מסמכים)`)
      await load()
    } catch (e2) {
      handleErr(e2)
    } finally {
      setUploading(false)
    }
  }

  async function toggleExpand(item: BackupItem) {
    if (expanded === item.key) {
      setExpanded('')
      return
    }
    setExpanded(item.key)
    if (summaries[item.key]) return
    setSummaryLoading(item.key)
    try {
      const r = await adminApi<BackupSummary>('admin-backup-summary', {
        key: item.key,
      })
      setSummaries((s) => ({ ...s, [item.key]: r }))
    } catch (e) {
      handleErr(e)
      setExpanded('')
    } finally {
      setSummaryLoading('')
    }
  }

  async function restore(item: BackupItem) {
    if (
      !window.confirm(
        'שחזור יחזיר את המידע למצב המדויק שבזמן הגיבוי: מסמכים יידרסו, ' +
          'ופריטים שנוצרו אחרי הגיבוי (למשל פרויקטים חדשים) יימחקו. ' +
          'מפתחות הכניסה של האדמין לא נמחקים. ' +
          'לפני השחזור נשמר אוטומטית גיבוי בטיחות של המצב הנוכחי. להמשיך?',
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
      const a = document.createElement('a')
      a.href = r.url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyKey('')
      setBusyAction('')
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">גיבוי</h2>
          <p className="mt-1 text-sm text-fg-muted">
            גיבוי מלא של מסד הנתונים נשמר ב-Cloudflare R2. אפשר ליצור, לשחזר,
            להוריד, להעלות ולמחוק — ולקבוע כל כמה זמן רץ גיבוי אוטומטי.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 py-2 text-xs text-fg transition-colors hover:bg-popover"
          >
            <RefreshCw className="h-3.5 w-3.5" /> רענן
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-3 py-2 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            העלה קובץ
          </button>
          <button
            type="button"
            onClick={createNow}
            disabled={creating}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            צור גיבוי עכשיו
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={onFilePicked}
            className="hidden"
          />
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

      {/* Settings: frequency + telegram notify */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <h3 className="mb-3 text-sm font-semibold text-fg">הגדרות גיבוי אוטומטי</h3>
        <div className="flex flex-wrap items-end gap-5">
          <div>
            <label className="mb-1 block text-[11px] text-fg-muted">
              כל כמה זמן לגבות אוטומטית
            </label>
            <select
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-fg outline-none focus:border-primary"
            >
              {/* If the saved value isn't a preset, show it so it isn't lost. */}
              {!INTERVALS.some((o) => o.v === intervalMinutes) && (
                <option value={intervalMinutes}>
                  {intervalLabel(intervalMinutes)}
                </option>
              )}
              {INTERVALS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            שלח עדכון בטלגרם כשמתבצע גיבוי אוטומטי
          </label>
          <div className="flex items-center gap-3 pb-1">
            {settingsMsg && (
              <span className="text-xs text-fg-muted">{settingsMsg}</span>
            )}
            <button
              type="button"
              onClick={saveSettings}
              disabled={settingsSaving}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {settingsSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              שמור הגדרות
            </button>
          </div>
        </div>
        {/* Status: server-side daily guarantee + live in-panel accelerator */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px] text-fg-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-success" />
            רץ בצד השרת · {intervalLabel(intervalMinutes)}
          </span>
          {lastAutoCheck > 0 && (
            <span className="text-fg-faint">
              נבדק לפני {fmtRel(Date.now() - lastAutoCheck)}
            </span>
          )}
          {nextDueMs !== null && (
            <span className="text-fg-faint">
              הבא בעוד ~{fmtRel(nextDueMs)}
            </span>
          )}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-fg-faint">
          הגיבוי רץ אוטומטית בצד השרת לפי התדירות שבחרת — גם אם אף אחד לא מחובר
          ושום דף לא פתוח. בעת שמירה, לוח הזמנים נשלח אוטומטית למתזמן בקלאודפלייר
          כך שנשלחת בקשה אחת בדיוק בזמנים הנדרשים, בלי בדיקות מיותרות. בנוסף, כל
          עוד דף הניהול פתוח המערכת בודקת גם בעצמה לתצוגה חיה. נשמרים 30 העותקים
          האחרונים.
        </p>
      </div>

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
            const isOpen = expanded === b.key
            const sum = summaries[b.key]
            return (
              <div
                key={b.key}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(b)}
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
                    <span className="min-w-0">
                      <span className="block text-sm text-fg">
                        {fmtDate(b.createdAt)}
                      </span>
                      <span className="block text-[11px] text-fg-faint" dir="ltr">
                        {fmtBytes(b.sizeBytes)}
                      </span>
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => download(b)}
                      disabled={rowBusy}
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

                {/* Expanded: what's inside this backup */}
                {isOpen && (
                  <div className="border-t border-border bg-background/40 px-4 py-3">
                    {summaryLoading === b.key ? (
                      <div className="flex items-center gap-2 text-xs text-fg-muted">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען תוכן…
                      </div>
                    ) : sum ? (
                      <>
                        <div className="mb-2 text-xs text-fg-muted">
                          סה״כ <strong className="text-fg">{sum.docCount.toLocaleString()}</strong> מסמכים
                        </div>
                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                          {sum.collections.map((c) => (
                            <div
                              key={c.name}
                              className="flex items-center justify-between rounded-md bg-card px-3 py-1.5 text-xs"
                            >
                              <span className="text-fg-muted">
                                {COLLECTION_LABELS[c.name] || c.name}
                              </span>
                              <span className="tabular-nums text-fg">
                                {c.count.toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-fg-faint">אין מידע.</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-fg-faint">
        הגיבוי כולל את כל המידע החשוב (לקוחות, מנויים, מפתחות, הגדרות, סבבי
        תיקונים והערות). שחזור דורש אישור ביומטרי, וכ"רשת ביטחון" הוא תמיד שומר
        אוטומטית גיבוי של המצב הנוכחי לפני הדריסה. השחזור מחזיר את המידע למצב
        המדויק שבזמן הגיבוי — כולל מחיקה של פריטים שנוצרו אחריו (פרט למפתחות
        הכניסה של האדמין, שלא נמחקים כדי למנוע נעילה החוצה).
      </p>
    </div>
  )
}
