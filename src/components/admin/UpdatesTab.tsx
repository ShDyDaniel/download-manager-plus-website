import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, RefreshCw, UploadCloud, Trash2 } from 'lucide-react'
import { getAdminIdToken } from '../../lib/adminApi'

interface ReleaseDoc {
  version: string
  notes: string
  macUrl: string
  winUrl: string
  macUrlBackup: string
  winUrlBackup: string
  draft: boolean
  publishedAt?: string
  mandatory?: boolean
}

const EMPTY: ReleaseDoc = {
  version: '',
  notes: '',
  macUrl: '',
  winUrl: '',
  macUrlBackup: '',
  winUrlBackup: '',
  draft: true,
  mandatory: false,
}

export default function UpdatesTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [draft, setDraft] = useState<ReleaseDoc>(EMPTY)
  const [latest, setLatest] = useState<ReleaseDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  async function call(action: 'load' | 'save' | 'delete' | 'publish', release?: ReleaseDoc) {
    const idToken = await getAdminIdToken()
    if (!idToken) {
      onAuthExpired()
      throw new Error('auth')
    }
    const r = await fetch('/api/admin/draft-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, action, release }),
    })
    if (r.status === 401 || r.status === 403) {
      onAuthExpired()
      throw new Error('auth')
    }
    const j = (await r.json()) as {
      ok: boolean
      draft?: ReleaseDoc | null
      latest?: ReleaseDoc | null
      release?: ReleaseDoc
      error?: string
    }
    if (!j.ok) throw new Error(j.error || 'הפעולה נכשלה')
    return j
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const j = await call('load')
      setDraft(j.draft ? { ...EMPTY, ...j.draft } : EMPTY)
      setLatest(j.latest ?? null)
    } catch (e) {
      if ((e as Error).message !== 'auth')
        setError((e as Error).message || 'טעינה נכשלה')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function act(action: 'save' | 'delete' | 'publish') {
    if (busy) return
    if (action === 'publish' && !window.confirm('לפרסם את הטיוטה לכל המשתמשים?'))
      return
    if (action === 'delete' && !window.confirm('למחוק את הטיוטה?')) return
    setBusy(action)
    setError('')
    setMsg('')
    try {
      if (action === 'save') {
        await call('save', draft)
        setMsg('הטיוטה נשמרה ✓')
      } else if (action === 'delete') {
        await call('delete')
        setMsg('הטיוטה נמחקה')
      } else {
        await call('publish', draft)
        setMsg('פורסם! ✓')
      }
      await load()
    } catch (e) {
      if ((e as Error).message !== 'auth')
        setError((e as Error).message || 'הפעולה נכשלה')
    } finally {
      setBusy('')
    }
  }

  function set<K extends keyof ReleaseDoc>(k: K, v: ReleaseDoc[K]) {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-medium text-fg">עדכונים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            ניהול טיוטת גרסה ופרסום עדכון למשתמשים.
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

      {latest && (
        <div className="rounded-2xl border border-border/60 bg-white/[0.015] px-4 py-3 text-sm">
          <span className="text-fg-muted">גרסה מפורסמת כעת: </span>
          <span className="font-medium text-fg" dir="ltr">
            v{latest.version}
          </span>
          {latest.publishedAt && (
            <span className="text-fg-faint">
              {' '}· {new Date(latest.publishedAt).toLocaleDateString('he-IL')}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      {msg && <div className="text-xs text-success">{msg}</div>}

      <div className="space-y-3 rounded-2xl border border-border/60 bg-white/[0.015] p-4">
        <div className="text-sm font-semibold text-fg">טיוטת גרסה</div>
        <Row label="מספר גרסה">
          <In value={draft.version} onChange={(v) => set('version', v)} ltr placeholder="1.7.42" />
        </Row>
        <Row label="הערות גרסה (changelog)">
          <textarea
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
          />
        </Row>
        <Row label="קישור macOS">
          <In value={draft.macUrl} onChange={(v) => set('macUrl', v)} ltr />
        </Row>
        <Row label="קישור Windows">
          <In value={draft.winUrl} onChange={(v) => set('winUrl', v)} ltr />
        </Row>
        <Row label="קישור גיבוי macOS (Drive)">
          <In value={draft.macUrlBackup} onChange={(v) => set('macUrlBackup', v)} ltr />
        </Row>
        <Row label="קישור גיבוי Windows (Drive)">
          <In value={draft.winUrlBackup} onChange={(v) => set('winUrlBackup', v)} ltr />
        </Row>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={draft.mandatory === true}
            onChange={(e) => set('mandatory', e.target.checked)}
            className="h-4 w-4 accent-[var(--color-primary,#d4a574)]"
          />
          עדכון חובה (חוסם את האפליקציה עד התקנה)
        </label>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => act('save')}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm text-fg transition-colors hover:bg-white/[0.04] disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            שמור טיוטה
          </button>
          <button
            type="button"
            onClick={() => act('publish')}
            disabled={!!busy || !draft.version}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {busy === 'publish' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            פרסם עכשיו
          </button>
          <button
            type="button"
            onClick={() => act('delete')}
            disabled={!!busy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> מחק טיוטה
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-fg-muted">{label}</label>
      {children}
    </div>
  )
}
function In({
  value,
  onChange,
  ltr,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  ltr?: boolean
  placeholder?: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      dir={ltr ? 'ltr' : undefined}
      placeholder={placeholder}
      className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
    />
  )
}
