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
  Crown,
  ChevronDown,
  Terminal,
  Fingerprint,
} from 'lucide-react'
import {
  adminApi,
  listPasskeys,
  registerPasskey,
  deletePasskey,
  type PasskeyInfo,
} from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'

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
  { kind: 'capture-key', label: 'מפתח לאחר רכישה (legacy)' },
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
        <h2 className="text-3xl font-bold font-display text-fg">הגדרות</h2>
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
      <PasskeysCard onErr={handleErr} />
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
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </div>
  )
}

/* Beta + plan-mode cards — ported 1:1 from the desktop admin panel
 * (optimistic UI, gradient icons, Switch, segmented buttons). Config
 * is loaded once here and shared by both cards. */
function AppConfigCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [beta, setBeta] = useState(false)
  const [plan, setPlan] = useState<'hybrid' | 'subscription'>('hybrid')
  const [loading, setLoading] = useState(true)
  const [betaBusy, setBetaBusy] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [betaOptimistic, setBetaOptimistic] = useState<boolean | null>(null)
  const [planOptimistic, setPlanOptimistic] = useState<
    'hybrid' | 'subscription' | null
  >(null)
  const [betaErr, setBetaErr] = useState('')
  const [planErr, setPlanErr] = useState('')
  const [logsPw, setLogsPw] = useState('')
  const [logsBusy, setLogsBusy] = useState(false)
  const [logsMsg, setLogsMsg] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await adminApi<{
          betaMode: boolean
          planMode: 'hybrid' | 'subscription'
          logsPassword?: string
        }>('admin-get-app-config')
        setBeta(r.betaMode)
        setPlan(r.planMode)
        setLogsPw(r.logsPassword || '')
      } catch (e) {
        onErr(e)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveLogsPw() {
    setLogsBusy(true)
    setLogsMsg('')
    try {
      await adminApi('admin-set-app-config', { logsPassword: logsPw.trim() })
      setLogsMsg('נשמר ✓')
      setTimeout(() => setLogsMsg(''), 2500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setLogsMsg(err.message || 'שמירה נכשלה')
    } finally {
      setLogsBusy(false)
    }
  }

  const betaActive = betaOptimistic !== null ? betaOptimistic : beta
  const planCurrent = planOptimistic ?? plan
  const isSub = planCurrent === 'subscription'

  async function toggleBeta(next?: boolean) {
    const target = typeof next === 'boolean' ? next : !betaActive
    if (betaBusy || target === betaActive) return
    setBetaBusy(true)
    setBetaErr('')
    setBetaOptimistic(target)
    try {
      await adminApi('admin-set-app-config', { betaMode: target })
      setBeta(target)
      setBetaOptimistic(null)
    } catch (e) {
      setBetaOptimistic(null)
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setBetaErr(err.message || 'שינוי המצב נכשל')
    } finally {
      setBetaBusy(false)
    }
  }

  async function pickPlan(mode: 'hybrid' | 'subscription') {
    if (planBusy || mode === planCurrent) return
    setPlanBusy(true)
    setPlanErr('')
    setPlanOptimistic(mode)
    try {
      await adminApi('admin-set-app-config', { planMode: mode })
      setPlan(mode)
      setPlanOptimistic(null)
    } catch (e) {
      setPlanOptimistic(null)
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setPlanErr(err.message || 'שינוי המצב נכשל')
    } finally {
      setPlanBusy(false)
    }
  }

  return (
    <>
      {/* Beta mode */}
      <div
        className={cn(
          'flex w-full items-stretch gap-4 rounded-2xl border p-4 text-right transition-all',
          betaActive
            ? 'border-success/30 bg-success/[0.08]'
            : 'border-border bg-card',
        )}
      >
        <div className="flex flex-1 items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-md transition-all',
              betaActive
                ? 'from-success to-success shadow-success/40'
                : 'from-popover to-popover shadow-lg',
            )}
          >
            {betaBusy || loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <Sparkles className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              מצב בטא
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                  betaActive
                    ? 'bg-success/20 text-success'
                    : 'bg-popover text-muted-foreground',
                )}
              >
                {loading ? 'טוען...' : betaBusy ? 'מעדכן...' : betaActive ? 'פעיל' : 'כבוי'}
              </span>
              {betaOptimistic !== null && (
                <span className="text-[10px] text-muted-foreground">
                  ⚡ ממתין לאישור Firestore
                </span>
              )}
            </div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {betaActive
                ? 'כל המשתמשים מחוברים מקבלים גישה לתכונות Pro בחינם. כיבוי יחזיר כל משתמש למנוי האמיתי שלו באופן מיידי.'
                : 'מצב רגיל — כל משתמש מקבל את התכונות לפי המנוי שלו. הפעלה תעניק לכולם Pro חינם בזמן שהוא דולק.'}
            </p>
            {betaErr && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {betaErr}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center self-center">
          <Switch
            checked={betaActive}
            onCheckedChange={(v) => toggleBeta(v)}
            disabled={betaBusy || loading}
          />
        </div>
      </div>

      {/* Plan mode */}
      <div
        className={cn(
          'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
          isSub ? 'border-primary/30 bg-primary/[0.05]' : 'border-border bg-card',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary shadow-md shadow-primary/40">
            {planBusy ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <Crown className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              תוכנית התשלום
              <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                {loading ? 'טוען...' : planBusy ? 'מעדכן...' : isSub ? 'מנויים' : 'משולבת'}
              </span>
              {planOptimistic !== null && (
                <span className="text-[10px] text-muted-foreground">
                  ⚡ ממתין לאישור Firestore
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {isSub
                ? 'מצב מנויים — רק משתמשים עם מנוי Pro יכולים להפעיל פיצ׳רים. משתמשים חינמיים יראו את התוכנה אבל לא יוכלו לעשות כלום בלי לשדרג.'
                : 'מצב משולב — חלק מהפיצ׳רים פתוחים בחינם, חלק דורשים Pro. ברירת המחדל המקורית.'}
            </p>
            {planErr && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {planErr}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(['hybrid', 'subscription'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => pickPlan(m)}
              disabled={planBusy || loading}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-sm font-medium transition-all',
                planCurrent === m
                  ? 'border-primary/40 bg-gradient-to-br from-primary/20 to-primary/10 text-foreground shadow-md shadow-primary/30'
                  : 'border-border bg-card text-muted-foreground hover:bg-card',
              )}
            >
              {m === 'hybrid' ? 'תוכנית משולבת' : 'תוכנית מנויים'}
            </button>
          ))}
        </div>
      </div>

      {/* Logs password — unlocks the desktop Ctrl+Shift+1 logs window */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary shadow-md shadow-primary/40">
            <Terminal className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-foreground">סיסמת לוגים (תוכנה)</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              הסיסמה שפותחת את חלון הלוגים בתוכנה דרך הקיצור הסודי
              Ctrl+Shift+1. אם ריק — נעשה שימוש בסיסמת ברירת המחדל המובנית.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={logsPw}
            onChange={(e) => setLogsPw(e.target.value)}
            placeholder="סיסמת לוגים"
            className="flex-1"
          />
          <Button onClick={saveLogsPw} disabled={logsBusy} size="sm">
            {logsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            שמור
          </Button>
        </div>
        {logsMsg && <div className="text-xs text-success">{logsMsg}</div>}
      </div>
    </>
  )
}

function PasskeysCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [list, setList] = useState<PasskeyInfo[] | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      setList(await listPasskeys())
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setMsg(err.message || 'טעינה נכשלה')
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function register() {
    if (busy) return
    setBusy(true)
    setMsg('')
    const name =
      deviceName.trim() ||
      (/iphone|ipad|android/i.test(navigator.userAgent)
        ? 'טלפון'
        : /mac/i.test(navigator.userAgent)
          ? 'Mac'
          : 'מחשב')
    const r = await registerPasskey(name)
    setBusy(false)
    if (r.ok) {
      setDeviceName('')
      setMsg('המכשיר נרשם ✓')
      setTimeout(() => setMsg(''), 2500)
      void load()
    } else {
      setMsg(r.error || 'הרישום נכשל/בוטל')
    }
  }

  async function remove(id: string) {
    if (!window.confirm('להסיר את המכשיר הזה? לא תוכל להיכנס איתו יותר.')) return
    try {
      await deletePasskey(id)
      void load()
    } catch (e) {
      onErr(e)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent shadow-md shadow-primary/40">
          <Fingerprint className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-foreground">
            מפתחות גישה (Passkeys)
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            רשום את המכשיר הזה (Touch ID במק / Face ID באייפון / Windows Hello)
            כדי להיכנס בלי קוד מייל. אפשר לרשום כמה מכשירים — אחד למחשב ואחד
            לטלפון. קוד המייל יישאר כגיבוי.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="שם המכשיר (אופציונלי)"
          className="flex-1"
        />
        <Button onClick={register} disabled={busy} size="sm">
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Fingerprint className="h-3.5 w-3.5" />
          )}
          רשום מכשיר זה
        </Button>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}

      {list === null ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען…
        </div>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          עדיין לא נרשמו מכשירים — תיכנס עם קוד מייל עד שתרשום אחד.
        </p>
      ) : (
        <div className="space-y-1.5">
          {list.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-xs"
            >
              <span className="flex items-center gap-2 text-foreground">
                <Fingerprint className="h-3.5 w-3.5 text-accent" />
                {p.deviceName}
                <span className="text-muted-foreground">
                  · {new Date(p.createdAt).toLocaleDateString('he-IL')}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="text-muted-foreground transition-colors hover:text-destructive"
                title="הסר"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
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
  const [liveVersion, setLiveVersion] = useState(0)
  const [lastUpdated, setLastUpdated] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [dragSrc, setDragSrc] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  // Sections collapsed by default — the legal docs are long, so the
  // editor stays compact until the admin opens a specific section.
  const [openSections, setOpenSections] = useState<Set<number>>(new Set())
  function toggleSection(i: number) {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function moveSection(from: number, to: number) {
    if (from === to) return
    setSections((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    // Keep collapse state attached to the right section after the move.
    setOpenSections((prev) => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx === from) next.add(to)
        else if (from < to && idx > from && idx <= to) next.add(idx - 1)
        else if (to < from && idx >= to && idx < from) next.add(idx + 1)
        else next.add(idx)
      }
      return next
    })
  }

  function removeSection(i: number) {
    setSections(sections.filter((_, j) => j !== i))
    // Re-index open sections so the wrong one doesn't appear expanded.
    setOpenSections((prev) => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx < i) next.add(idx)
        else if (idx > i) next.add(idx - 1)
      }
      return next
    })
  }

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/paypal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: `get-${kind}` }),
        })
        const j = (await r.json()) as {
          ok: boolean
          version?: number
          lastUpdated?: string
          sections?: Section[]
        }
        setVersion(j.version || 0)
        setLiveVersion(j.version || 0)
        setLastUpdated(j.lastUpdated || '')
        setSections(j.sections || [])
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [kind])

  async function save() {
    // Bumping the version forces every user to re-accept on next login —
    // confirm before doing that, like the desktop does.
    if (
      version > liveVersion &&
      !window.confirm(
        'העלאת מספר הגרסה תכריח את כל המשתמשים לאשר מחדש את המסמך בכניסה הבאה. להמשיך?',
      )
    ) {
      return
    }
    setBusy(true)
    setMsg('')
    try {
      await adminApi(`admin-set-${kind}`, {
        version,
        sections,
        lastUpdated: lastUpdated.trim() || undefined,
      })
      setLiveVersion(version)
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
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span>גרסה:</span>
        <input
          type="number"
          value={version}
          onChange={(e) => setVersion(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className="w-20 rounded-lg border border-border bg-transparent px-2 py-1 text-sm text-fg outline-none focus:border-primary"
        />
        {version > liveVersion && (
          <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
            מצריך אישור מחדש
          </span>
        )}
        <span className="text-fg-faint">(העלאת הגרסה תכריח אישור מחדש)</span>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span>תאריך עדכון (מוצג למשתמש):</span>
        <input
          value={lastUpdated}
          onChange={(e) => setLastUpdated(e.target.value)}
          placeholder="לדוגמה: 20 במאי 2026"
          className="flex-1 rounded-lg border border-border bg-transparent px-2 py-1 text-sm text-fg outline-none focus:border-primary"
        />
      </label>

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
                : 'border-border')
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
                onClick={() => toggleSection(i)}
                title={openSections.has(i) ? 'כיווץ' : 'פתיחה'}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                <ChevronDown
                  className={
                    'h-4 w-4 transition-transform ' +
                    (openSections.has(i) ? 'rotate-180' : '')
                  }
                />
              </button>
              <button
                type="button"
                onClick={() => removeSection(i)}
                className="text-fg-muted hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {openSections.has(i) ? (
              <textarea
                value={s.paragraphs.join('\n\n')}
                onChange={(e) => {
                  const next = [...sections]
                  next[i] = {
                    ...s,
                    paragraphs: e.target.value
                      .split(/\n\s*\n/)
                      .map((p) => p.trim())
                      .filter(Boolean),
                  }
                  setSections(next)
                }}
                rows={6}
                placeholder="פסקאות (שורה ריקה מפרידה בין פסקאות)"
                className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
              />
            ) : (
              <div className="px-1 text-[11px] text-fg-faint">
                {s.paragraphs.length} פסקאות — לחצו לפתיחה
              </div>
            )}
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
      const j = await adminApi('admin-test-sumit', { targetEmail: target.trim() })
      setResult(j as never)
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
        const r = await fetch('/api/paypal?action=get-pricing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        })
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
      //    Routed through adminApi() so the full admin gate (idToken +
      //    12h adminToken + gateKey) is attached — sync-plans is a
      //    sensitive PayPal catalog mutation, not an idToken-only call.
      try {
        await adminApi('sync-plans')
      } catch (e) {
        const err = e as Error & { code?: string }
        if (err.code === 'auth') return onErr(err)
        setError(
          `המחיר נשמר אבל סנכרון ל-PayPal נכשל (${err.message || 'שגיאה'}). הסנכרון יתבצע אוטומטית בעת הרכישה הבאה.`,
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
      await adminApi('admin-send-test-email', { targetEmail: target.trim(), kind })
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
