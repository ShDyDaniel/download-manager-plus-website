import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Plus, Trash2, Send, Save } from 'lucide-react'
import { adminApi, getAdminIdToken } from '../../lib/adminApi'

/**
 * Admin → Settings (web). Beta mode, plan mode, terms + privacy
 * editors, and email tools. Pricing is intentionally NOT here — it
 * touches PayPal plan sync and stays in the desktop panel.
 */

interface Section {
  title: string
  paragraphs: string[]
}

const TEST_EMAILS: { kind: string; label: string }[] = [
  { kind: 'verify-signup', label: 'קוד אימות הרשמה' },
  { kind: 'verify-existing', label: 'קוד אימות למשתמש קיים' },
  { kind: 'welcome-subscription', label: 'ברוכים הבאים — מנוי' },
  { kind: 'pro-activated', label: 'אישור הפעלת Pro' },
  { kind: 'cancellation', label: 'אישור ביטול מנוי' },
  { kind: 'reset-password', label: 'איפוס סיסמה' },
  { kind: 'renewal-extension', label: 'הארכת מנוי' },
  { kind: 'expiry-reminder', label: 'תזכורת לפני פקיעה' },
  { kind: 'annual-report', label: 'סיכום חיובים שנתי' },
]

export default function SettingsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [error, setError] = useState('')
  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  return (
    <div className="space-y-5">
      <header>
        <h2 className="font-display text-2xl font-medium text-fg">הגדרות</h2>
        <p className="mt-1 text-sm text-fg-muted">
          מצב בטא, מודל תמחור, מסמכים משפטיים וכלי דיוור.
        </p>
      </header>
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      <AppConfigCard onErr={handleErr} />
      <LegalCard kind="terms" title="תנאי שימוש" onErr={handleErr} />
      <LegalCard kind="privacy" title="מדיניות פרטיות" onErr={handleErr} />
      <EmailToolsCard onErr={handleErr} />
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-2xl border border-border/60 bg-white/[0.015] p-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </div>
  )
}

function AppConfigCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [beta, setBeta] = useState(false)
  const [plan, setPlan] = useState<'hybrid' | 'subscription'>('hybrid')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await adminApi<{ betaMode: boolean; planMode: 'hybrid' | 'subscription' }>(
          'admin-get-app-config',
        )
        setBeta(r.betaMode)
        setPlan(r.planMode)
      } catch (e) {
        onErr(e)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(patch: { betaMode?: boolean; planMode?: string }, label: string) {
    setBusy(label)
    setMsg('')
    try {
      await adminApi('admin-set-app-config', patch)
      setMsg('נשמר ✓')
      setTimeout(() => setMsg(''), 2000)
    } catch (e) {
      onErr(e)
    } finally {
      setBusy('')
    }
  }

  if (loading)
    return (
      <Card title="כללי">
        <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />
      </Card>
    )

  return (
    <Card title="כללי">
      <label className="flex items-center justify-between gap-3 text-sm text-fg">
        <span>
          מצב בטא{' '}
          <span className="text-xs text-fg-muted">(Pro חינם לכולם)</span>
        </span>
        <input
          type="checkbox"
          checked={beta}
          disabled={busy === 'beta'}
          onChange={(e) => {
            setBeta(e.target.checked)
            void save({ betaMode: e.target.checked }, 'beta')
          }}
          className="h-5 w-5 accent-[var(--color-primary,#d4a574)]"
        />
      </label>
      <div className="flex items-center justify-between gap-3 text-sm text-fg">
        <span>
          מודל תמחור{' '}
          <span className="text-xs text-fg-muted">
            (היברידי = חלק חינם · מנוי = הכל ב-Pro)
          </span>
        </span>
        <div className="flex gap-1.5">
          {(['hybrid', 'subscription'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy === 'plan'}
              onClick={() => {
                setPlan(m)
                void save({ planMode: m }, 'plan')
              }}
              className={
                'rounded-lg border px-3 py-1 text-xs transition-colors ' +
                (plan === m
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-fg-muted hover:text-fg')
              }
            >
              {m === 'hybrid' ? 'היברידי' : 'מנוי מלא'}
            </button>
          ))}
        </div>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}
    </Card>
  )
}

function LegalCard({
  kind,
  title,
  onErr,
}: {
  kind: 'terms' | 'privacy'
  title: string
  onErr: (e: unknown) => void
}) {
  const [sections, setSections] = useState<Section[]>([])
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/paypal?action=get-${kind}`, { method: 'GET' })
        const j = (await r.json()) as {
          ok: boolean
          version?: number
          sections?: Section[]
        }
        setVersion(j.version || 0)
        setSections(j.sections || [])
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [kind])

  async function save() {
    setBusy(true)
    setMsg('')
    try {
      await adminApi(`admin-set-${kind}`, { version, sections })
      setMsg('נשמר ופורסם ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  if (loading)
    return (
      <Card title={title}>
        <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />
      </Card>
    )

  return (
    <Card title={title}>
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <span>גרסה:</span>
        <input
          type="number"
          value={version}
          onChange={(e) => setVersion(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className="w-20 rounded-lg border border-border bg-transparent px-2 py-1 text-sm text-fg outline-none focus:border-primary"
        />
        <span className="text-fg-faint">(העלאת הגרסה תכריח אישור מחדש)</span>
      </div>

      <div className="space-y-3">
        {sections.map((s, i) => (
          <div key={i} className="rounded-lg border border-border/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                value={s.title}
                onChange={(e) => {
                  const next = [...sections]
                  next[i] = { ...s, title: e.target.value }
                  setSections(next)
                }}
                placeholder="כותרת הסעיף"
                className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm font-medium text-fg outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => setSections(sections.filter((_, j) => j !== i))}
                className="text-fg-muted hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={s.paragraphs.join('\n\n')}
              onChange={(e) => {
                const next = [...sections]
                next[i] = {
                  ...s,
                  paragraphs: e.target.value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
                }
                setSections(next)
              }}
              rows={4}
              placeholder="פסקאות (שורה ריקה מפרידה בין פסקאות)"
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSections([...sections, { title: '', paragraphs: [] }])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" /> הוסף סעיף
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          שמור ופרסם
        </button>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}
    </Card>
  )
}

function EmailToolsCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [target, setTarget] = useState('')
  const [kind, setKind] = useState(TEST_EMAILS[0].kind)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState('')

  async function sendTest() {
    if (!target.trim()) return
    setSending(true)
    setMsg('')
    try {
      const idToken = await getAdminIdToken()
      if (!idToken) return onErr({ code: 'auth' })
      const r = await fetch('/api/paypal?action=admin-send-test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, targetEmail: target.trim(), kind }),
      })
      const j = (await r.json()) as { ok: boolean; error?: string }
      if (!j.ok) throw new Error(j.error || 'השליחה נכשלה')
      setMsg('נשלח ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      onErr(e)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card title="כלי דיוור — מייל בדיקה">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="מייל יעד"
          dir="ltr"
          className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary"
        >
          {TEST_EMAILS.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={sendTest}
          disabled={sending || !target.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          שלח בדיקה
        </button>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}
      <p className="text-[11px] text-fg-faint">
        דיוור שיווקי המוני נשאר בפאנל של התוכנה (שליחה לכלל המשתמשים).
      </p>
    </Card>
  )
}
