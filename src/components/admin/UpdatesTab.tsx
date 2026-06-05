import { useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  RefreshCw,
  UploadCloud,
  Trash2,
  Eye,
  X,
  DownloadCloud,
  Pencil,
  Save,
  CheckCircle,
  Plus,
} from 'lucide-react'
import {
  getAdminIdToken,
  getStoredAdminToken,
  getGateKey,
} from '../../lib/adminApi'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Portal } from '@/components/ui/Portal'
import { cn } from '@/lib/cn'

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
  mandatoryExemptVersions?: string[]
}

const FALLBACK: ReleaseDoc = {
  version: '1.6.5',
  notes: '',
  macUrl: '',
  winUrl: '',
  macUrlBackup: '',
  winUrlBackup: '',
  draft: true,
  mandatory: false,
  mandatoryExemptVersions: [],
}

export default function UpdatesTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [release, setRelease] = useState<ReleaseDoc | null>(null)
  const [draftRelease, setDraftRelease] = useState<ReleaseDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTarget, setEditingTarget] = useState<null | 'release' | 'draft'>(
    null,
  )
  const [draft, setDraft] = useState<ReleaseDoc | null>(null)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<ReleaseDoc | null>(null)

  async function call(
    action: 'load' | 'save' | 'delete' | 'publish' | 'save-latest',
    payload?: { release?: ReleaseDoc; publish?: boolean },
  ) {
    const idToken = await getAdminIdToken()
    const adminToken = getStoredAdminToken()
    // Both factors are required server-side now (full admin gate).
    // Missing either means the 2FA session lapsed → bounce to login.
    if (!idToken || !adminToken) {
      onAuthExpired()
      throw new Error('auth')
    }
    const r = await fetch('/api/admin/draft-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken,
        adminToken,
        gateKey: getGateKey(),
        action,
        ...payload,
      }),
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
      setRelease(j.latest ? { ...FALLBACK, ...j.latest } : FALLBACK)
      setDraftRelease(j.draft ? { ...FALLBACK, ...j.draft } : null)
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

  function startEditRelease() {
    if (!release) return
    setDraft({ ...release })
    setEditingTarget('release')
    setSuccess('')
    setError('')
  }

  function startEditDraft() {
    let seed: ReleaseDoc | null = null
    if (draftRelease) {
      seed = { ...draftRelease }
    } else if (release) {
      const { publishedAt: _omit, ...rest } = release
      void _omit
      seed = { ...rest, notes: '', draft: true }
    }
    if (!seed) return
    setDraft(seed)
    setEditingTarget('draft')
    setSuccess('')
    setError('')
  }

  function cancelEdit() {
    setEditingTarget(null)
    setDraft(null)
    setError('')
  }

  function patch<K extends keyof ReleaseDoc>(key: K, value: ReleaseDoc[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function saveRelease(asDraft: boolean) {
    if (!draft || busy) return
    setBusy(true)
    setError('')
    try {
      const j = await call('save-latest', { release: draft, publish: !asDraft })
      if (j.release) setRelease(j.release)
      setEditingTarget(null)
      setDraft(null)
      setSuccess(asDraft ? 'נשמר כטיוטה (גלוי רק לאדמין)' : 'העדכון פורסם')
      setTimeout(() => setSuccess(''), 2500)
    } catch (e) {
      if ((e as Error).message !== 'auth')
        setError((e as Error).message || 'שמירה נכשלה')
    } finally {
      setBusy(false)
    }
  }

  async function saveDraftWorkspace() {
    if (!draft || busy) return
    setBusy(true)
    setError('')
    try {
      const j = await call('save', { release: draft })
      setDraftRelease(j.draft ?? draft)
      setEditingTarget(null)
      setDraft(null)
      setSuccess('הטיוטה נשמרה')
      setTimeout(() => setSuccess(''), 2500)
    } catch (e) {
      if ((e as Error).message !== 'auth')
        setError((e as Error).message || 'שמירה נכשלה')
    } finally {
      setBusy(false)
    }
  }

  async function publishDraft() {
    if (!draftRelease || busy) return
    if (!window.confirm('לפרסם את הטיוטה לכל המשתמשים?')) return
    setBusy(true)
    setError('')
    try {
      const j = await call('publish')
      if (j.release) setRelease(j.release)
      setDraftRelease(null)
      setSuccess('הטיוטה פורסמה למשתמשים')
      setTimeout(() => setSuccess(''), 2500)
    } catch (e) {
      if ((e as Error).message !== 'auth')
        setError((e as Error).message || 'פרסום הטיוטה נכשל')
    } finally {
      setBusy(false)
    }
  }

  async function discardDraft() {
    if (busy) return
    if (!window.confirm('למחוק את הטיוטה?')) return
    setBusy(true)
    setError('')
    try {
      await call('delete')
      setDraftRelease(null)
      setSuccess('הטיוטה נמחקה')
      setTimeout(() => setSuccess(''), 2000)
    } catch (e) {
      if ((e as Error).message !== 'auth')
        setError((e as Error).message || 'מחיקת הטיוטה נכשלה')
    } finally {
      setBusy(false)
    }
  }

  const editing = editingTarget !== null
  const isEditingDraft = editingTarget === 'draft'

  if (loading || !release) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (editing && draft) {
    return (
      <div className="space-y-5">
        <header className="flex items-start justify-between">
          <div>
            <h2 className="text-3xl font-bold font-display text-fg">
              {isEditingDraft ? 'עריכת טיוטה' : 'עריכת עדכון'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isEditingDraft
                ? 'טיוטה לעדכון הבא — לא נראה למשתמשים עד שתלחץ "פרסם טיוטה" בכרטיס הטיוטה.'
                : 'שמור כטיוטה כדי להמשיך מאוחר יותר, או פרסם כדי שכל המשתמשים יקבלו את הגרסה הזאת.'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={cancelEdit}>
            <X className="h-4 w-4" />
            ביטול
          </Button>
        </header>

        <Card className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">גרסה</span>
            <Input
              value={draft.version}
              onChange={(e) => patch('version', e.target.value)}
              dir="ltr"
              className="text-left"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">תיאור / מה חדש</span>
            <textarea
              value={draft.notes}
              onChange={(e) => patch('notes', e.target.value)}
              rows={6}
              placeholder={'• ...\n• ...'}
              className="w-full rounded-lg border border-border bg-input/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <div className="space-y-3">
            <div className="text-xs font-semibold text-foreground">
              קישורי הורדה אוטומטית
              <span className="mr-2 font-normal text-muted-foreground">
                — מומלץ GitHub Releases (יציב, בלי הגבלת גודל)
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <UrlField label="macOS (.dmg)" value={draft.macUrl} onChange={(v) => patch('macUrl', v)} placeholder="https://github.com/.../...dmg" />
              <UrlField label="Windows (.exe)" value={draft.winUrl} onChange={(v) => patch('winUrl', v)} placeholder="https://github.com/.../...exe" />
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="text-xs font-semibold text-foreground">
              קישורי גיבוי להתקנה ידנית
              <span className="mr-2 font-normal text-muted-foreground">
                — אופציונלי, נפתח בדפדפן כשהמשתמש לוחץ "התקן ידנית"
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <UrlField label="macOS — קישור גיבוי" value={draft.macUrlBackup} onChange={(v) => patch('macUrlBackup', v)} placeholder="https://drive.google.com/file/d/..." />
              <UrlField label="Windows — קישור גיבוי" value={draft.winUrlBackup} onChange={(v) => patch('winUrlBackup', v)} placeholder="https://drive.google.com/file/d/..." />
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/[0.04] p-3">
            <Switch
              checked={draft.mandatory === true}
              onCheckedChange={(v) => patch('mandatory', v)}
            />
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                עדכון חובה
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                כשמופעל — המשתמש לא יוכל לסגור את חלון העדכון או להשתמש בתוכנה
                בגרסה הישנה. שמור ל-bug-fix קריטיים או שינויים שוברי-תאימות.
              </p>
            </div>
          </label>

          {draft.mandatory && (
            <ExemptVersionsField
              value={draft.mandatoryExemptVersions ?? []}
              onChange={(list) => patch('mandatoryExemptVersions', list)}
            />
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            {isEditingDraft ? (
              <Button variant="default" onClick={saveDraftWorkspace} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                שמור טיוטה
              </Button>
            ) : (
              <>
                <Button variant="default" onClick={() => saveRelease(false)} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  שמור ופרסם
                </Button>
                <Button variant="secondary" onClick={() => saveRelease(true)} disabled={busy}>
                  שמור כטיוטה
                </Button>
              </>
            )}
          </div>
        </Card>

        <PreviewModal release={preview} onClose={() => setPreview(null)} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">עדכונים והודעות</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            ערוך את הגרסה הזמינה למשתמשים. שינוי נכנס מיד לתוקף לכולם.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
          רענן
        </Button>
      </header>

      {success && (
        <div className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
          <CheckCircle className="h-3.5 w-3.5" />
          {success}
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Published release card */}
      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-2xl font-bold tabular-nums text-foreground" dir="ltr">
                {release.version}
              </h3>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                  release.draft
                    ? 'border border-primary/30 bg-primary/10 text-primary'
                    : 'border border-success/30 bg-success/10 text-success',
                )}
              >
                {release.draft ? 'טיוטה' : 'פורסם'}
              </span>
              {release.mandatory && (
                <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-bold text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  חובה
                </span>
              )}
              {release.mandatory &&
                (release.mandatoryExemptVersions?.length ?? 0) > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-bold text-primary"
                    dir="ltr"
                    title={`חריגות: ${(release.mandatoryExemptVersions ?? []).join(', ')}`}
                  >
                    {release.mandatoryExemptVersions!.length} חריגות
                  </span>
                )}
            </div>
            {release.publishedAt && (
              <div className="mt-1 text-xs text-muted-foreground">
                עודכן ב-
                {new Date(release.publishedAt).toLocaleString('he-IL', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="secondary" size="sm" onClick={() => setPreview(release)}>
              <Eye className="h-3.5 w-3.5" />
              תצוגה מקדימה
            </Button>
            <Button variant="secondary" size="sm" onClick={startEditRelease}>
              <Pencil className="h-3.5 w-3.5" />
              ערוך
            </Button>
          </div>
        </div>

        {release.notes ? (
          <pre className="whitespace-pre-wrap rounded-xl border border-border bg-card p-3 text-xs leading-relaxed text-foreground/85">
            {release.notes}
          </pre>
        ) : (
          <p className="text-xs italic text-muted-foreground">אין תיאור עדיין.</p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UrlPreview label="macOS (.dmg)" url={release.macUrl} />
          <UrlPreview label="Windows (.exe)" url={release.winUrl} />
          <UrlPreview label="macOS גיבוי" url={release.macUrlBackup} />
          <UrlPreview label="Windows גיבוי" url={release.winUrlBackup} />
        </div>
      </Card>

      {/* Draft workspace OR start-new-draft CTA */}
      {draftRelease ? (
        <Card className="space-y-4 border-primary/20 bg-primary/[0.02]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-2xl font-bold tabular-nums text-foreground" dir="ltr">
                  {draftRelease.version || '(ללא גרסה)'}
                </h3>
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                  טיוטה
                </span>
                {draftRelease.mandatory && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-bold text-destructive">
                    <AlertTriangle className="h-3 w-3" />
                    חובה
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                עדכון בעבודה — נראה רק לאדמין עד שיתפרסם.
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="secondary" size="sm" onClick={() => setPreview(draftRelease)}>
                <Eye className="h-3.5 w-3.5" />
                תצוגה מקדימה
              </Button>
              <Button variant="secondary" size="sm" onClick={startEditDraft}>
                <Pencil className="h-3.5 w-3.5" />
                ערוך
              </Button>
            </div>
          </div>

          {draftRelease.notes ? (
            <pre className="whitespace-pre-wrap rounded-xl border border-border bg-card p-3 text-xs leading-relaxed text-foreground/85">
              {draftRelease.notes}
            </pre>
          ) : (
            <p className="text-xs italic text-muted-foreground">
              עדיין לא הוזן תיאור לטיוטה.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UrlPreview label="macOS (.dmg)" url={draftRelease.macUrl} />
            <UrlPreview label="Windows (.exe)" url={draftRelease.winUrl} />
            <UrlPreview label="macOS גיבוי" url={draftRelease.macUrlBackup} />
            <UrlPreview label="Windows גיבוי" url={draftRelease.winUrlBackup} />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button variant="default" size="sm" onClick={publishDraft} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
              פרסם טיוטה למשתמשים
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={discardDraft}
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              מחק טיוטה
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-dashed border-border bg-card">
          <div>
            <div className="text-sm font-semibold text-foreground">
              להתחיל לעבוד על הגרסה הבאה?
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              טיוטה נשמרת בנפרד ולא משנה את העדכון שכבר פורסם. תוכל לחזור אליה מתי
              שתרצה ולפרסם רק כשהיא מוכנה.
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={startEditDraft}>
            <Plus className="h-3.5 w-3.5" />
            התחל טיוטה חדשה
          </Button>
        </Card>
      )}

      <PreviewModal release={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

function UrlPreview({ label, url }: { label: string; url: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      <div
        className={cn(
          'truncate rounded-lg border px-2.5 py-1.5 text-xs',
          url
            ? 'border-border bg-card text-muted-foreground'
            : 'border-dashed border-border bg-transparent text-muted-foreground/50',
        )}
        dir="ltr"
        title={url}
      >
        {url || '— לא הוגדר'}
      </div>
    </div>
  )
}

function UrlField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        dir="ltr"
        className="text-left text-xs"
      />
    </label>
  )
}

function ExemptVersionsField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (list: string[]) => void
}) {
  const [text, setText] = useState(value.join(', '))
  return (
    <div className="space-y-1.5 rounded-xl border border-border bg-card p-3">
      <span className="text-xs font-semibold text-foreground">
        גרסאות פטורות מעדכון החובה (מופרדות בפסיק)
      </span>
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(
            e.target.value
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }}
        dir="ltr"
        placeholder="1.7.40, 1.7.41"
        className="text-left"
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {value.map((v) => (
            <span
              key={v}
              className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground"
              dir="ltr"
            >
              v{v}
            </span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/70">
        משתמשים שמריצים גרסה מהרשימה יראו את חלון העדכון כאופציונלי (לא חוסם).
      </p>
    </div>
  )
}

function PreviewModal({
  release,
  onClose,
}: {
  release: ReleaseDoc | null
  onClose: () => void
}) {
  if (!release) return null
  return (
    <Portal>
      <div
        dir="rtl"
        onClick={onClose}
        className="fixed inset-0 z-[260] flex items-center justify-center bg-black/80 p-6 backdrop-blur-md"
        role="dialog"
        aria-modal="true"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute left-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-popover hover:text-foreground"
            aria-label="סגירה"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="p-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/40">
              <DownloadCloud className="h-6 w-6 text-white" />
            </div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              כך המשתמש יראה את חלון העדכון
            </div>
            <h3 className="mt-2 text-lg font-bold text-foreground">גרסה חדשה זמינה</h3>
            <div className="mt-0.5 text-sm text-muted-foreground" dir="ltr">
              v{release.version || '—'}
            </div>
            {release.mandatory && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                <AlertTriangle className="h-3 w-3" /> עדכון חובה
              </span>
            )}
            {release.notes && (
              <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background/40 p-3 text-right text-xs text-foreground">
                {release.notes}
              </pre>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <div className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                הורד והתקן
              </div>
              {!release.mandatory && (
                <div className="text-xs text-muted-foreground">אחר כך</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}
