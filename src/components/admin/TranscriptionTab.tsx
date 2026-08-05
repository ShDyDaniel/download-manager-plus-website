import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  Layers,
  FileText,
  Plus,
  Trash2,
  Save,
  X,
  ThumbsUp,
  ThumbsDown,
  Minus,
  Download,
  FilterX,
} from 'lucide-react'
import { getAdminIdToken } from '../../lib/adminApi'
import { Portal } from '@/components/ui/Portal'
import { buildZip } from '@/lib/zip'

/**
 * טאב "תמלול" — שני חלקים:
 *   1. קובצי ה-SRT שנאספו (בהסכמה) מהתוכנה, עם המטא-דאטה והדירוג.
 *   2. עריכת חבילות-המונחים שהמשתמשים מפעילים.
 *
 * שתי הפעולות עוברות דרך api/revisions.ts עם ה-idToken של האדמין; שם
 * נבדק שהמייל נמצא ברשימת האדמינים. הקבצים אנונימיים מלכתחילה — שם
 * הקובץ מקודד רק מדדים, בלי זהות משתמש.
 */
interface SrtFile {
  key: string
  size: number
  at: number
  maxWords: string
  seconds: string
  speakers: string
  rating: string
  device: string
  version: string
}
interface Pack {
  id: string
  name: string
  description: string
  terms: string[]
}

/**
 * קריאת-אדמין ל-api/revisions. תמיד POST: ה-idToken נשלח בגוף ולא
 * ב-URL, כי הוא אישור-גישה ו-URL נרשם בלוגים.
 */
async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const idToken = await getAdminIdToken()
  if (!idToken) {
    const e = new Error('admin-auth-required') as Error & { code?: string }
    e.code = 'auth'
    throw e
  }
  const res = await fetch(`/api/revisions?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  })
  const j = (await res.json()) as { ok?: boolean; error?: string }
  if (!res.ok || !j.ok) {
    const e = new Error(j.error || 'שגיאה') as Error & { code?: string }
    if (res.status === 401) e.code = 'auth'
    throw e
  }
  return j as T
}

export default function TranscriptionTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [view, setView] = useState<'files' | 'packs'>('files')
  const [error, setError] = useState('')
  const handleErr = useCallback(
    (e: unknown) => {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setError(err.message || 'שגיאה')
    },
    [onAuthExpired],
  )

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-border bg-card p-1">
        {(
          [
            ['files', 'קבצים שנאספו', FileText],
            ['packs', 'קטגוריות מונחים', Layers],
          ] as const
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => {
              setView(k)
              setError('')
            }}
            className={
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (view === k
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {view === 'files' ? (
        <FilesView onError={handleErr} />
      ) : (
        <PacksView onError={handleErr} />
      )}
    </div>
  )
}

/* ── קבצים שנאספו ─────────────────────────────────────────────── */

/** מוריד Blob בשם נתון. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const EMPTY_FILTERS = {
  rating: '',
  device: '',
  version: '',
  maxWords: '',
  speakers: '',
  from: '',
  to: '',
  minSec: '',
  maxSec: '',
}
type Filters = typeof EMPTY_FILTERS

function FilesView({ onError }: { onError: (e: unknown) => void }) {
  const [files, setFiles] = useState<SrtFile[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(0)
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)
  const [f, setF] = useState<Filters>(EMPTY_FILTERS)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api<{ files: SrtFile[] }>('srt-list')
      setFiles(r.files)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  /** הערכים שקיימים בפועל — כדי שלא יוצעו מסננים שלא יחזירו כלום. */
  const options = useMemo(() => {
    const uniq = (pick: (x: SrtFile) => string) =>
      Array.from(new Set((files ?? []).map(pick).filter((v) => v && v !== 'x'))).sort()
    return {
      device: uniq((x) => x.device),
      version: uniq((x) => x.version),
      maxWords: uniq((x) => x.maxWords),
      speakers: uniq((x) => x.speakers),
    }
  }, [files])

  /**
   * הסינון. "הרשימה בפועל" היא זו שמוצגת כאן — וגם זו שיורדת בייצוא,
   * כדי שלא תהיה אי-התאמה בין מה שרואים למה שמקבלים.
   */
  const shown = useMemo(() => {
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    const fromMs = f.from ? new Date(f.from).getTime() : null
    const toMs = f.to ? new Date(f.to).getTime() + 86_400_000 : null
    const minS = num(f.minSec)
    const maxS = num(f.maxSec)
    return (files ?? []).filter((x) => {
      const rated = x.rating === 'good' || x.rating === 'bad'
      if (f.rating === 'none' && rated) return false
      if (f.rating && f.rating !== 'none' && x.rating !== f.rating) return false
      if (f.device && x.device !== f.device) return false
      if (f.version && x.version !== f.version) return false
      if (f.maxWords && x.maxWords !== f.maxWords) return false
      if (f.speakers && x.speakers !== f.speakers) return false
      if (fromMs !== null && x.at < fromMs) return false
      if (toMs !== null && x.at >= toMs) return false
      const sec = Number(x.seconds)
      if (minS !== null && (!Number.isFinite(sec) || sec < minS)) return false
      if (maxS !== null && (!Number.isFinite(sec) || sec > maxS)) return false
      return true
    })
  }, [files, f])

  const active = Object.values(f).some((v) => v !== '')
  const good = shown.filter((x) => x.rating === 'good').length
  const bad = shown.filter((x) => x.rating === 'bad').length

  async function removeOne(key: string) {
    if (!confirm('למחוק את הקובץ? הפעולה בלתי הפיכה.')) return
    try {
      await api('srt-delete', { keys: [key] })
      setFiles((prev) => (prev ?? []).filter((x) => x.key !== key))
    } catch (e) {
      onError(e)
    }
  }

  async function downloadOne(key: string) {
    try {
      const r = await api<{ text: string }>('srt-get', { key })
      saveBlob(new Blob([r.text], { type: 'application/x-subrip' }), key.slice(4))
    } catch (e) {
      onError(e)
    }
  }

  /**
   * ייצוא של הרשימה המסוננת ל-ZIP. השרת מגביל 40 קבצים לקריאה כדי
   * לא לחרוג ממגבלת גודל-התשובה, ולכן נמשך בקבוצות.
   */
  async function downloadFiltered() {
    if (!shown.length) return
    setExporting(1)
    try {
      const enc = new TextEncoder()
      const entries: { name: string; data: Uint8Array }[] = []
      for (let i = 0; i < shown.length; i += 40) {
        const chunk = shown.slice(i, i + 40).map((x) => x.key)
        const r = await api<{ files: { key: string; text: string }[] }>('srt-bulk', {
          keys: chunk,
        })
        for (const it of r.files) {
          entries.push({ name: it.key.slice(4), data: enc.encode(it.text) })
        }
        setExporting(Math.min(i + 40, shown.length))
      }
      const stamp = new Date().toISOString().slice(0, 10)
      saveBlob(buildZip(entries), `srt-${stamp}-${entries.length}.zip`)
    } catch (e) {
      onError(e)
    } finally {
      setExporting(0)
    }
  }

  const sel =
    'rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void load()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          רענון
        </button>
        <button
          onClick={() => void downloadFiltered()}
          disabled={!shown.length || exporting > 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {exporting > 0 ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {exporting > 0
            ? `${exporting}/${shown.length}`
            : `הורדת הרשימה (${shown.length})`}
        </button>
        {files && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md bg-secondary px-2 py-1">
              {active ? `${shown.length} מתוך ${files.length}` : `${files.length} קבצים`}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2 py-1 text-success">
              <ThumbsUp className="h-3 w-3" />
              {good}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-1 text-destructive">
              <ThumbsDown className="h-3 w-3" />
              {bad}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-muted-foreground">
              <Minus className="h-3 w-3" />
              {shown.length - good - bad} ללא דירוג
            </span>
          </div>
        )}
      </div>

      {/* מסננים — הייצוא והמחיקה פועלים על מה שמוצג אחריהם. */}
      {!!files?.length && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">דירוג</span>
            <select
              value={f.rating}
              onChange={(e) => setF({ ...f, rating: e.target.value })}
              className={sel}
            >
              <option value="">הכל</option>
              <option value="good">חיובי</option>
              <option value="bad">שלילי</option>
              <option value="none">ללא דירוג</option>
            </select>
          </label>
          {(
            [
              ['device', 'מכשיר', options.device],
              ['version', 'גרסה', options.version],
              ['maxWords', 'מילים/כתובית', options.maxWords],
              ['speakers', 'דוברים', options.speakers],
            ] as const
          ).map(([key, label, opts]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{label}</span>
              <select
                value={f[key]}
                onChange={(e) => setF({ ...f, [key]: e.target.value })}
                className={sel}
              >
                <option value="">הכל</option>
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">מתאריך</span>
            <input
              type="date"
              value={f.from}
              onChange={(e) => setF({ ...f, from: e.target.value })}
              className={sel}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">עד תאריך</span>
            <input
              type="date"
              value={f.to}
              onChange={(e) => setF({ ...f, to: e.target.value })}
              className={sel}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">אורך מ־ (שניות)</span>
            <input
              type="number"
              min={0}
              value={f.minSec}
              onChange={(e) => setF({ ...f, minSec: e.target.value })}
              className={`${sel} w-24`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">עד (שניות)</span>
            <input
              type="number"
              min={0}
              value={f.maxSec}
              onChange={(e) => setF({ ...f, maxSec: e.target.value })}
              className={`${sel} w-24`}
            />
          </label>
          {active && (
            <button
              onClick={() => setF(EMPTY_FILTERS)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary"
            >
              <FilterX className="h-3.5 w-3.5" />
              ניקוי
            </button>
          )}
        </div>
      )}

      {files === null && (
        <div className="py-8 text-center text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      )}
      {files?.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          עדיין לא נאספו קבצים. משתמשים משתפים רק אחרי אישור מפורש בתוכנה.
        </p>
      )}
      {!!files?.length && shown.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          אין קבצים שתואמים לסינון.
        </p>
      )}

      {!!shown.length && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-right text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                {['תאריך', 'דירוג', 'אורך', 'מילים/כתובית', 'דוברים', 'מכשיר', 'גרסה', ''].map(
                  (h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.key} className="border-t border-border">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {x.at ? new Date(x.at).toLocaleString('he-IL') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {x.rating === 'good' ? (
                      <ThumbsUp className="h-3.5 w-3.5 text-success" />
                    ) : x.rating === 'bad' ? (
                      <ThumbsDown className="h-3.5 w-3.5 text-destructive" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {x.seconds && x.seconds !== 'x' ? `${x.seconds}ש׳` : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">{x.maxWords || '—'}</td>
                  <td className="px-3 py-2 text-xs">{x.speakers || '—'}</td>
                  <td className="px-3 py-2 text-xs">{x.device || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{x.version || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={async () => {
                          try {
                            const r = await api<{ text: string }>('srt-get', {
                              key: x.key,
                            })
                            setPreview({ key: x.key, text: r.text })
                          } catch (e) {
                            onError(e)
                          }
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        צפייה
                      </button>
                      <button
                        onClick={() => void downloadOne(x.key)}
                        title="הורדה"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => void removeOne(x.key)}
                        title="מחיקה"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setPreview(null)}
          >
            <div
              className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="truncate text-sm font-medium">{preview.key}</span>
                <button onClick={() => setPreview(null)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap p-4 text-xs leading-relaxed">
                {preview.text}
              </pre>
            </div>
          </div>
        </Portal>
      )}
    </div>
  )
}

/* ── עריכת קטגוריות ───────────────────────────────────────────── */
function PacksView({ onError }: { onError: (e: unknown) => void }) {
  const [packs, setPacks] = useState<Pack[] | null>(null)
  const [edit, setEdit] = useState<Pack | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/revisions?action=glossary-packs')
      const j = (await r.json()) as { packs?: Pack[] }
      setPacks(j.packs ?? [])
    } catch (e) {
      onError(e)
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  async function save(p: Pack) {
    setSaving(true)
    try {
      await api('glossary-pack-save', p as unknown as Record<string, unknown>)
      setEdit(null)
      await load()
    } catch (e) {
      onError(e)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    if (!confirm(`למחוק את הקטגוריה "${id}"? הפעולה בלתי הפיכה.`)) return
    try {
      await api('glossary-pack-delete', { id })
      await load()
    } catch (e) {
      onError(e)
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={() =>
          setEdit({ id: '', name: '', description: '', terms: [] })
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        קטגוריה חדשה
      </button>

      {packs === null && <Loader2 className="mx-auto h-5 w-5 animate-spin" />}

      <div className="grid gap-3 sm:grid-cols-2">
        {packs?.map((p) => {
          const phrases = p.terms.filter((t) => t.trim().split(/\s+/).length > 1).length
          return (
            <div key={p.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.description}
                  </div>
                </div>
                <button
                  onClick={() => remove(p.id)}
                  title="מחיקה"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-secondary px-2 py-0.5">
                  {p.terms.length} מונחים
                </span>
                <span className="rounded bg-secondary px-2 py-0.5">
                  {phrases} צירופים
                </span>
                {p.terms.length - phrases > 0 && (
                  <span
                    className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-600"
                    title="מונח בן מילה אחת מתוקן רק בהתאמה מדויקת, ולכן מילה עם הומופון נפוץ עלולה לדרוס טקסט תקין"
                  >
                    {p.terms.length - phrases} מילים בודדות
                  </span>
                )}
              </div>
              <button
                onClick={() => setEdit({ ...p })}
                className="mt-3 text-sm text-primary hover:underline"
              >
                עריכה
              </button>
            </div>
          )
        })}
      </div>

      {edit && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-semibold">
                  {packs?.some((p) => p.id === edit.id) ? 'עריכת קטגוריה' : 'קטגוריה חדשה'}
                </h3>
                <button onClick={() => setEdit(null)}>
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3">
                <label className="block">
                  <span className="text-xs text-muted-foreground">
                    מזהה (אנגלית, ללא רווחים)
                  </span>
                  <input
                    dir="ltr"
                    value={edit.id}
                    onChange={(e) => setEdit({ ...edit, id: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted-foreground">שם לתצוגה</span>
                  <input
                    value={edit.name}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted-foreground">תיאור קצר</span>
                  <input
                    value={edit.description}
                    onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </label>

                <div>
                  <span className="text-xs text-muted-foreground">
                    מונחים — עדיפו צירופים על מילים בודדות
                  </span>
                  <div className="mt-1 flex gap-2">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        const fresh = draft
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean)
                        if (!fresh.length) return
                        setEdit({
                          ...edit,
                          terms: Array.from(new Set([...edit.terms, ...fresh])),
                        })
                        setDraft('')
                      }}
                      placeholder="מונח, ואז Enter"
                      className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="mt-2 flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
                    {edit.terms.map((t) => (
                      <span
                        key={t}
                        className={
                          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ' +
                          (t.trim().split(/\s+/).length > 1
                            ? 'bg-secondary'
                            : 'bg-amber-500/15 text-amber-700')
                        }
                      >
                        <button
                          onClick={() =>
                            setEdit({ ...edit, terms: edit.terms.filter((x) => x !== t) })
                          }
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setEdit(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm"
                >
                  ביטול
                </button>
                <button
                  onClick={() => void save(edit)}
                  disabled={saving || !edit.id.trim() || edit.terms.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  שמירה
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  )
}
