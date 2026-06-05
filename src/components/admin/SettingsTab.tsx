import { useEffect, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  Plus,
  Trash2,
  Send,
  Save,
  Sparkles,
  CheckCircle,
  GripVertical,
} from 'lucide-react'
import { adminApi, getAdminIdToken } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

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
  { kind: 'payment-failed', label: 'כשל בחיוב מנוי' },
  { kind: 'plan-switch', label: 'החלפת מסלול (חודשי/שנתי)' },
  { kind: 'purge-warning-subscription', label: 'אזהרת מחיקת סבבים — מנוי שהסתיים' },
  { kind: 'purge-warning-trial', label: 'אזהרת מחיקת סבבים — ניסיון שהסתיים' },
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
      <PricingCard onErr={handleErr} />
      <LegalCard kind="terms" title="תנאי שימוש" onErr={handleErr} />
      <LegalCard kind="privacy" title="מדיניות פרטיות" onErr={handleErr} />
      <EmailToolsCard onErr={handleErr} />
      <SumitTestCard onErr={handleErr} />
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
  const [dragSrc, setDragSrc] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  function moveSection(from: number, to: number) {
    if (from === to) return
    setSections((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

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
          <div
            key={i}
            onDragOver={(e) => {
              if (dragSrc === null) return
              e.preventDefault()
              setDragOver(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragSrc !== null) moveSection(dragSrc, i)
              setDragSrc(null)
              setDragOver(null)
            }}
            className={
              'rounded-lg border p-3 transition-colors ' +
              (dragOver === i && dragSrc !== null
                ? 'border-primary'
                : 'border-border/60')
            }
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                draggable
                onDragStart={() => setDragSrc(i)}
                onDragEnd={() => {
                  setDragSrc(null)
                  setDragOver(null)
                }}
                title="גרור לסידור מחדש"
                className="cursor-grab text-fg-faint hover:text-fg-muted active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </span>
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

function SumitTestCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [target, setTarget] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    draft?: boolean
    url?: string | null
    documentNumber?: string | number | null
    emailed?: boolean
    error?: string | null
    raw?: unknown
  } | null>(null)

  async function run() {
    setSending(true)
    setResult(null)
    try {
      const idToken = await getAdminIdToken()
      if (!idToken) return onErr({ code: 'auth' })
      const r = await fetch('/api/paypal?action=admin-test-sumit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, targetEmail: target.trim() }),
      })
      const j = await r.json()
      setResult(j)
    } catch (e) {
      onErr(e)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card title="בדיקת קבלה — SUMIT (סאמיט)">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="מייל יעד (ריק = למייל שלך)"
          dir="ltr"
          className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={run}
          disabled={sending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          הפקת קבלת בדיקה
        </button>
      </div>
      {result && (
        <div className="mt-2 space-y-1 text-xs">
          <div className={result.ok ? 'text-success' : 'text-destructive'}>
            {result.ok
              ? `הצליח ${result.draft ? '(טיוטה)' : ''} ${result.emailed ? '— נשלח במייל' : ''}`
              : `נכשל: ${result.error || 'שגיאה'}`}
          </div>
          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              dir="ltr"
              className="block break-all text-primary underline"
            >
              {result.url}
            </a>
          )}
          <details>
            <summary className="cursor-pointer text-fg-faint">תשובת SUMIT הגולמית</summary>
            <pre
              dir="ltr"
              className="mt-1 max-h-60 overflow-auto rounded bg-black/30 p-2 text-[10px] leading-relaxed text-fg-muted"
            >
              {JSON.stringify(result.raw, null, 2)}
            </pre>
          </details>
        </div>
      )}
      <p className="text-[11px] text-fg-faint">
        מפיק מסמך טיוטה ב-SUMIT ושולח אותו מהמייל שלנו. כשהעסק מוגדר —
        הגדר env <code>SUMIT_LIVE=true</code> כדי להפיק מסמכים אמיתיים.
      </p>
    </Card>
  )
}

interface PlanPrice {
  regular: number
  sale: number | null
}
interface PricingDoc {
  monthly: PlanPrice
  yearly: PlanPrice
  currency: string
  saleLabel?: string | null
  updatedAt?: string
}
const DEFAULT_PRICING: PricingDoc = {
  monthly: { regular: 9, sale: null },
  yearly: { regular: 60, sale: null },
  currency: 'ILS',
}

/* Pricing card — ported 1:1 from the desktop admin panel. Loads via
 * the public get-pricing endpoint, saves via admin-set-pricing, then
 * triggers sync-plans so PayPal Plans match the new prices. */
function PricingCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [draft, setDraft] = useState<PricingDoc>(DEFAULT_PRICING)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [monthlySaleOn, setMonthlySaleOn] = useState(false)
  const [yearlySaleOn, setYearlySaleOn] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch('/api/paypal?action=get-pricing')
        const j = (await r.json()) as {
          ok: boolean
          monthly?: PlanPrice
          yearly?: PlanPrice
          currency?: string
          saleLabel?: string | null
        }
        if (!alive) return
        if (j.ok && j.monthly && j.yearly) {
          const p: PricingDoc = {
            monthly: { regular: j.monthly.regular, sale: j.monthly.sale ?? null },
            yearly: { regular: j.yearly.regular, sale: j.yearly.sale ?? null },
            currency: j.currency || 'ILS',
            saleLabel: j.saleLabel ?? null,
          }
          setDraft(p)
          setMonthlySaleOn(p.monthly.sale != null)
          setYearlySaleOn(p.yearly.sale != null)
        }
        setLoaded(true)
      } catch (err) {
        setError((err as Error).message || 'טעינת מחירים נכשלה')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    setError('')
    setSavedAt(null)
    try {
      const payload = {
        monthly: {
          regular: draft.monthly.regular,
          sale: monthlySaleOn ? draft.monthly.sale ?? null : null,
        },
        yearly: {
          regular: draft.yearly.regular,
          sale: yearlySaleOn ? draft.yearly.sale ?? null : null,
        },
        currency: draft.currency || 'ILS',
        saleLabel: draft.saleLabel,
      }
      // 1) Persist the pricing doc (source of truth for site + buy page).
      await adminApi('admin-set-pricing', payload)
      // 2) Sync PayPal Plans server-side. Soft-fail: the price is saved
      //    regardless, and the next subscription attempt lazy-syncs.
      try {
        const idToken = await getAdminIdToken()
        if (idToken) {
          const r = await fetch('/api/paypal?action=sync-plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
          })
          const j = (await r.json()) as { ok: boolean; error?: string }
          if (!r.ok || !j.ok) {
            setError(
              `המחיר נשמר אבל סנכרון ל-PayPal נכשל (${j.error || 'שגיאה'}). הסנכרון יתבצע אוטומטית בעת הרכישה הבאה.`,
            )
          }
        }
      } catch {
        setError(
          'המחיר נשמר אבל סנכרון ל-PayPal נכשל. הסנכרון יתבצע אוטומטית בעת הרכישה הבאה.',
        )
      }
      setSavedAt(new Date().toISOString())
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setError(err.message || 'שמירה נכשלה')
    } finally {
      setSaving(false)
    }
  }

  const anySale =
    (monthlySaleOn && draft.monthly.sale != null) ||
    (yearlySaleOn && draft.yearly.sale != null)

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/40">
          <Sparkles className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-bold text-foreground">
            תמחור מנויים
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              {loaded ? `מטבע ${draft.currency}` : 'טוען...'}
            </span>
            {anySale && (
              <span className="rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
                מבצע פעיל
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            מחירים שמופיעים באתר ושנגבים דרך PayPal. שינויים מתעדכנים מיד באתר.
            המערכת מאמתת בצד שרת שהסכום שאושר ב-PayPal תואם למחיר העכשווי — לקוח
            לא יכול לקנות במחיר ישן או נמוך יותר.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">מנוי חודשי</div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={monthlySaleOn}
              onChange={(e) => setMonthlySaleOn(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            מבצע פעיל
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PriceInput
            label="מחיר רגיל"
            value={draft.monthly.regular}
            onChange={(v) =>
              setDraft((d) => ({ ...d, monthly: { ...d.monthly, regular: v } }))
            }
            currency={draft.currency}
          />
          <PriceInput
            label="מחיר מבצע"
            value={draft.monthly.sale ?? 0}
            onChange={(v) =>
              setDraft((d) => ({ ...d, monthly: { ...d.monthly, sale: v } }))
            }
            currency={draft.currency}
            disabled={!monthlySaleOn}
            error={
              monthlySaleOn &&
              draft.monthly.sale != null &&
              draft.monthly.sale >= draft.monthly.regular
                ? '≥ רגיל'
                : undefined
            }
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">מנוי שנתי</div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={yearlySaleOn}
              onChange={(e) => setYearlySaleOn(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            מבצע פעיל
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PriceInput
            label="מחיר רגיל"
            value={draft.yearly.regular}
            onChange={(v) =>
              setDraft((d) => ({ ...d, yearly: { ...d.yearly, regular: v } }))
            }
            currency={draft.currency}
          />
          <PriceInput
            label="מחיר מבצע"
            value={draft.yearly.sale ?? 0}
            onChange={(v) =>
              setDraft((d) => ({ ...d, yearly: { ...d.yearly, sale: v } }))
            }
            currency={draft.currency}
            disabled={!yearlySaleOn}
            error={
              yearlySaleOn &&
              draft.yearly.sale != null &&
              draft.yearly.sale >= draft.yearly.regular
                ? '≥ רגיל'
                : undefined
            }
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-muted-foreground">
          תווית מבצע (אופציונלי) — מופיעה ככרזת מעל הכרטיס באתר
        </label>
        <Input
          value={draft.saleLabel ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, saleLabel: e.target.value }))}
          placeholder="לדוגמה: ′מבצע חורף′ או ′44% הנחה′"
          disabled={!anySale}
        />
      </div>

      {error && (
        <div className="flex items-center gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
      {savedAt && (
        <div className="flex items-center gap-1 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          <CheckCircle className="h-3.5 w-3.5" /> נשמר ב-
          {new Date(savedAt).toLocaleTimeString('he-IL', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
          . האתר יציג את המחיר החדש בתוך כמה שניות.
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          {draft.updatedAt &&
            `עודכן לאחרונה: ${new Date(draft.updatedAt).toLocaleString('he-IL')}`}
        </div>
        <Button onClick={handleSave} disabled={saving || !loaded} size="sm">
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              שומר...
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              שמור שינויים
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function PriceInput({
  label,
  value,
  onChange,
  currency,
  disabled,
  error,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  currency: string
  disabled?: boolean
  error?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">
        {label}
        {error && <span className="ms-1 text-destructive">({error})</span>}
      </span>
      <div className="relative">
        <Input
          type="number"
          inputMode="decimal"
          step="0.5"
          min={0}
          value={value || ''}
          onChange={(e) => {
            const n = parseFloat(e.target.value)
            onChange(Number.isFinite(n) && n >= 0 ? n : 0)
          }}
          disabled={disabled}
          className="pl-10"
        />
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
          {currency === 'ILS' ? '₪' : currency}
        </span>
      </div>
    </label>
  )
}

function EmailToolsCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [target, setTarget] = useState('')
  const [kind, setKind] = useState(TEST_EMAILS[0].kind)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState('')

  // Marketing broadcast state
  const [bcSubject, setBcSubject] = useState('')
  const [bcHeading, setBcHeading] = useState('')
  const [bcContent, setBcContent] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<{
    kind: 'idle' | 'dry' | 'done' | 'error'
    text: string
  }>({ kind: 'idle', text: '' })

  async function sendBroadcast(dryRun: boolean) {
    if (bcBusy) return
    setBcResult({ kind: 'idle', text: '' })
    if (!bcSubject.trim() || !bcHeading.trim() || !bcContent.trim()) {
      setBcResult({ kind: 'error', text: 'יש למלא subject + heading + תוכן HTML' })
      return
    }
    setBcBusy(true)
    try {
      const j = await adminApi<{
        recipientCount?: number
        sent?: number
        failed?: number
      }>('admin-send-marketing-email', {
        subject: bcSubject.trim(),
        heading: bcHeading.trim(),
        contentHtml: bcContent.trim(),
        dryRun,
      })
      if (dryRun) {
        setBcResult({
          kind: 'dry',
          text: `יש ${j.recipientCount ?? 0} משתמשים ברשימת התפוצה כרגע. לחץ "שלח לכולם" כדי לשלוח להם.`,
        })
      } else {
        setBcResult({
          kind: 'done',
          text: `הסתיים: ${j.sent ?? 0}/${j.recipientCount ?? 0} נשלחו, ${j.failed ?? 0} נכשלו.`,
        })
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setBcResult({ kind: 'error', text: err.message || 'שליחה נכשלה' })
    } finally {
      setBcBusy(false)
    }
  }

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

      {/* ── Marketing broadcast ─────────────────────────────────── */}
      <div className="mt-2 space-y-2.5 rounded-xl border border-border bg-background/40 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Send className="h-3.5 w-3.5 text-accent" />
          שליחת מייל שיווקי
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          נשלח רק למשתמשים שהסכימו לקבל תוכן שיווקי בהרשמה. כל מייל כולל אוטומטית
          קישור "להסרה מרשימת הדיוור" בתחתית.
        </p>
        <Input
          value={bcSubject}
          onChange={(e) => setBcSubject(e.target.value)}
          placeholder="נושא (Subject) — לדוגמה: 50% הנחה לסוף שבוע"
          disabled={bcBusy}
        />
        <Input
          value={bcHeading}
          onChange={(e) => setBcHeading(e.target.value)}
          placeholder="כותרת ראשית במייל (Heading)"
          disabled={bcBusy}
        />
        <textarea
          value={bcContent}
          onChange={(e) => setBcContent(e.target.value)}
          placeholder='<p style="font-size:14px;line-height:1.7;color:#d1d5db;">תוכן ההודעה כאן...</p>'
          rows={5}
          disabled={bcBusy}
          dir="ltr"
          className="block w-full rounded-lg border border-border bg-input/60 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
        {bcResult.kind !== 'idle' && (
          <div
            className={
              bcResult.kind === 'error'
                ? 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive'
                : bcResult.kind === 'dry'
                  ? 'rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent'
                  : 'rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success'
            }
          >
            {bcResult.text}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={bcBusy}
            onClick={() => void sendBroadcast(true)}
            className="flex-1"
          >
            {bcBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            כמה משתמשים יש ברשימה?
          </Button>
          <Button
            variant="gradient"
            size="sm"
            disabled={bcBusy}
            onClick={() => {
              if (
                window.confirm(
                  'לשלוח את המייל לכל המשתמשים ברשימת התפוצה? אי אפשר לבטל אחרי שליחה.',
                )
              ) {
                void sendBroadcast(false)
              }
            }}
            className="flex-1"
          >
            {bcBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            שלח לכולם
          </Button>
        </div>
      </div>
    </Card>
  )
}
