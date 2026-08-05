import { useCallback, useEffect, useState } from 'react'
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
} from 'lucide-react'
import { getAdminIdToken } from '../../lib/adminApi'
import { Portal } from '@/components/ui/Portal'

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
function FilesView({ onError }: { onError: (e: unknown) => void }) {
  const [files, setFiles] = useState<SrtFile[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)

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

  const good = files?.filter((f) => f.rating === 'good').length ?? 0
  const bad = files?.filter((f) => f.rating === 'bad').length ?? 0

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
        {files && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-md bg-secondary px-2 py-1">
              {files.length} קבצים
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
              {files.length - good - bad} ללא דירוג
            </span>
          </div>
        )}
      </div>

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

      {!!files?.length && (
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
              {files.map((f) => (
                <tr key={f.key} className="border-t border-border">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {f.at ? new Date(f.at).toLocaleString('he-IL') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {f.rating === 'good' ? (
                      <ThumbsUp className="h-3.5 w-3.5 text-success" />
                    ) : f.rating === 'bad' ? (
                      <ThumbsDown className="h-3.5 w-3.5 text-destructive" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {f.seconds && f.seconds !== 'x' ? `${f.seconds}ש׳` : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">{f.maxWords || '—'}</td>
                  <td className="px-3 py-2 text-xs">{f.speakers || '—'}</td>
                  <td className="px-3 py-2 text-xs">{f.device || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{f.version || '—'}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={async () => {
                        try {
                          const r = await api<{ text: string }>('srt-get', {
                            key: f.key,
                          })
                          setPreview({ key: f.key, text: r.text })
                        } catch (e) {
                          onError(e)
                        }
                      }}
                      className="text-xs text-primary hover:underline"
                    >
                      צפייה
                    </button>
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
