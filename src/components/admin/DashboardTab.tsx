import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Cpu,
  Activity,
  BarChart3,
  ExternalLink,
  Cloud,
  ShieldAlert,
  Power,
} from 'lucide-react'
import { adminApi, getAdminIdToken } from '../../lib/adminApi'

interface AdminUsage {
  firestore: {
    configured: boolean
    reads?: number
    readsLimit?: number
    writes?: number
    writesLimit?: number
    error?: string
  }
  cloudflare: {
    configured: boolean
    requests?: number
    requestsLimit?: number
    error?: string
  }
  r2?: {
    configured: boolean
    usedBytes?: number
    usedGb?: number
    roundCount?: number
    freeStorageGb?: number
    costStorage?: number
    costTotal?: number
    error?: string
  }
  vercel: { configured: boolean; dashboardUrl: string }
  protection?: {
    killSwitch: boolean
    autoKill: boolean
    dailyReadCeiling: number
    dailyWriteCeiling: number
    autoTripped: boolean
  }
  fetchedAt: number
}

function fmtGb(gb?: number): string {
  return (gb || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
function fmtUsd(v?: number): string {
  return (v || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export default function DashboardTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [usage, setUsage] = useState<AdminUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const idToken = await getAdminIdToken()
      if (!idToken) return onAuthExpired()
      const r = await fetch('/api/revisions?action=admin-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (r.status === 403 || r.status === 401) return onAuthExpired()
      const j = (await r.json()) as AdminUsage & { ok?: boolean }
      setUsage(j)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'טעינה נכשלה')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">דשבורד שרתים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            שימוש חי במכסות — דאטאבייס, Cloudflare ו-Vercel.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-50"
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} />
          רענן
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {loading && !usage ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
        </div>
      ) : usage ? (
        <div className="space-y-3.5">
          {usage.protection?.killSwitch && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <div className="font-semibold">המערכת כרגע בתחזוקה (Kill-switch פעיל)</div>
                <div className="mt-0.5 text-[12px] text-destructive/90">
                  משתמשים חסומים מהאתר והתוכנה — רק פאנל הניהול עובד.
                  {usage.protection.autoTripped
                    ? ' המתג הופעל אוטומטית בעקבות חציית התקרה.'
                    : ''}{' '}
                  כבה אותו בכרטיס "מתג חירום והגנת עלות" כדי להחזיר את השירות.
                </div>
              </div>
            </div>
          )}

          <ProtectionCard
            protection={usage.protection}
            firestore={usage.firestore}
            onSaved={load}
            onAuthExpired={onAuthExpired}
          />

          <Section icon={<Cpu className="h-5 w-5" />} title="דאטאבייס" sub="Firestore · 24 שעות אחרונות">
            {usage.firestore.configured ? (
              <>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <UsageBar label="קריאות (היום)" used={usage.firestore.reads || 0} limit={usage.firestore.readsLimit || 50000} freeTier />
                  <UsageBar label="כתיבות (היום)" used={usage.firestore.writes || 0} limit={usage.firestore.writesLimit || 20000} freeTier />
                </div>
                <p className="mt-3 text-[10px] leading-relaxed text-fg-faint">
                  המספרים הם השימוש בפועל מול מכסת החינם היומית. אתה בתוכנית
                  בתשלום — <strong className="text-fg-muted">אין חסימה</strong> במכסה;
                  מעבר אליה החיוב הוא לפי שימוש (~$0.03 ל-100K קריאות, ~$0.18 ל-100K
                  כתיבות). ההגנה מפני הפתעות היא ה-kill-switch, לא המכסה הזו.
                </p>
              </>
            ) : (
              <NotConfigured
                error={usage.firestore.error}
                hint="הפעל את Cloud Monitoring API בפרויקט Firebase והגדר GOOGLE_APPLICATION_CREDENTIALS / מפתח שירות כדי לראות שימוש חי."
              />
            )}
          </Section>

          <Section icon={<Activity className="h-5 w-5" />} title="Cloudflare Worker" sub="בקשות · 24 שעות (100K כלולים בחינם ליום)">
            {usage.cloudflare.configured ? (
              <UsageBar label="בקשות (היום)" used={usage.cloudflare.requests || 0} limit={usage.cloudflare.requestsLimit || 100000} freeTier />
            ) : (
              <NotConfigured
                error={usage.cloudflare.error}
                hint="הגדר CF_API_TOKEN ו-CF_ACCOUNT_ID במשתני הסביבה של Vercel כדי לראות את מספר הבקשות ל-Worker."
              />
            )}
          </Section>

          <Section
            icon={<Cloud className="h-5 w-5" />}
            title="Cloudflare R2 — אחסון ועלות"
            sub="שטח בשימוש + עלות חודשית צפויה"
          >
            {usage.r2?.configured ? (
              <R2Panel r2={usage.r2} />
            ) : (
              <NotConfigured
                error={usage.r2?.error}
                hint="לא ניתן לחשב את האחסון כרגע."
              />
            )}
          </Section>

          <Section icon={<BarChart3 className="h-5 w-5" />} title="Vercel" sub="אין API ציבורי ב-Hobby">
            <a
              href={usage.vercel.dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <ExternalLink className="h-3.5 w-3.5" /> פתח את דשבורד Vercel
            </a>
          </Section>

          <p className="pt-1 text-center text-[10px] text-fg-faint">
            עודכן{' '}
            {new Date(usage.fetchedAt).toLocaleTimeString('he-IL', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
      ) : null}
    </div>
  )
}

function Section({
  icon,
  title,
  sub,
  children,
}: {
  icon: React.ReactNode
  title: string
  sub: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="text-[11px] text-fg-faint">{sub}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

function UsageBar({
  label,
  used,
  limit,
  freeTier,
}: {
  label: string
  used: number
  limit: number
  /** When true, `limit` is the FREE-tier allowance (not a hard cap) —
   *  the value reads "used / limit חינם" and the bar shows how much of
   *  the free allowance is used, never implying a wall. */
  freeTier?: boolean
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const tone =
    pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-accent' : 'bg-primary'
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums text-fg" dir="ltr">
          {used.toLocaleString()} / {limit.toLocaleString()}
          {freeTier ? ' ' : ''}
          {freeTier ? <span className="text-fg-faint">חינם</span> : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={'h-full rounded-full ' + tone} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function R2Panel({ r2 }: { r2: NonNullable<AdminUsage['r2']> }) {
  const usedGb = r2.usedGb || 0
  const freeGb = r2.freeStorageGb || 10
  const pct = Math.min(100, freeGb > 0 ? (usedGb / freeGb) * 100 : 0)
  const overFree = usedGb > freeGb
  const tone = overFree ? 'bg-accent' : pct >= 70 ? 'bg-accent' : 'bg-primary'
  return (
    <div className="space-y-4">
      {/* GB in use, relative to the free 10GB */}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-fg-muted">אחסון בשימוש</span>
          <span className="tabular-nums text-fg" dir="ltr">
            {fmtGb(usedGb)} GB
            {r2.roundCount != null && (
              <span className="text-fg-faint"> · {r2.roundCount} סבבים</span>
            )}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div className={'h-full rounded-full ' + tone} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-[10px] text-fg-faint">
          {freeGb}GB ראשונים חינם
          {overFree
            ? ` · חורגים ב-${fmtGb(usedGb - freeGb)}GB בתשלום`
            : ' · עדיין בתוך החינם'}
        </p>
      </div>

      {/* Projected monthly cost breakdown */}
      <div className="rounded-xl border border-border bg-background p-3 text-xs">
        <div className="flex items-center justify-between py-1">
          <span className="text-fg-muted">תוכנית R2 Paid (בסיס)</span>
          <span className="tabular-nums text-fg" dir="ltr">
            $0.00 · לפי שימוש
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-fg-muted">אחסון (מעבר ל-{freeGb}GB)</span>
          <span className="tabular-nums text-fg" dir="ltr">
            ${fmtUsd(r2.costStorage)}
          </span>
        </div>
        <div className="my-2 border-t border-border" />
        <div className="flex items-center justify-between py-1">
          <span className="font-semibold text-fg">עלות חודשית צפויה</span>
          <span className="tabular-nums text-base font-bold text-primary" dir="ltr">
            ${fmtUsd(r2.costTotal)}
          </span>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-fg-faint">
        אתה על R2 Paid — אין דמי-מנוי קבועים, משלמים רק לפי שימוש. תעבורה
        (egress) חינם, ופעולות קריאה/כתיבה בדרך כלל בתוך החינם — לכן כל עוד
        אתה מתחת ל-{freeGb}GB העלות היא $0. החשבונית המדויקת תמיד ב-Cloudflare.
      </p>
    </div>
  )
}

function NotConfigured({ error, hint }: { error?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
        <AlertTriangle className="h-3.5 w-3.5 text-primary" /> עדיין לא מוגדר
      </div>
      {hint && <p className="text-[11px] leading-relaxed text-fg-muted">{hint}</p>}
      {error && (
        <p className="mt-1.5 text-[10px] text-fg-faint" dir="ltr">
          {error}
        </p>
      )}
    </div>
  )
}

/* ── Cost protection / emergency kill switch ────────────────────────
 *  The control the operator asked for: a master maintenance switch, an
 *  optional daily reads/writes ceiling, and an opt-in auto-trip that
 *  flips the switch when a ceiling is crossed. Setting any of these is
 *  a step-up (passkey) mutation. The switch itself costs ~0 DB ops: the
 *  flag is cached server-side per instance and the ceiling is checked
 *  against the free Cloud Monitoring numbers, not Firestore. */
function Toggle({
  on,
  onClick,
  disabled,
  danger,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ' +
        (on ? (danger ? 'bg-destructive' : 'bg-primary') : 'bg-white/[0.12]')
      }
    >
      <span
        className={
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
          (on ? 'translate-x-[-22px]' : 'translate-x-[-2px]')
        }
      />
    </button>
  )
}

function ProtectionCard({
  protection,
  firestore,
  onSaved,
  onAuthExpired,
}: {
  protection?: AdminUsage['protection']
  firestore: AdminUsage['firestore']
  onSaved: () => void
  onAuthExpired: () => void
}) {
  const [kill, setKill] = useState(false)
  const [autoKill, setAutoKill] = useState(false)
  const [readCeiling, setReadCeiling] = useState('0')
  const [writeCeiling, setWriteCeiling] = useState('0')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Sync local editor state whenever the server values arrive/refresh.
  useEffect(() => {
    setKill(protection?.killSwitch === true)
    setAutoKill(protection?.autoKill === true)
    setReadCeiling(String(protection?.dailyReadCeiling || 0))
    setWriteCeiling(String(protection?.dailyWriteCeiling || 0))
  }, [
    protection?.killSwitch,
    protection?.autoKill,
    protection?.dailyReadCeiling,
    protection?.dailyWriteCeiling,
  ])

  async function save(fields: Record<string, unknown>) {
    setSaving(true)
    setErr('')
    try {
      await adminApi('admin-set-app-config', fields)
      onSaved()
    } catch (e) {
      const error = e as Error & { code?: string }
      if (error.code === 'auth') return onAuthExpired()
      setErr(error.message || 'שמירה נכשלה')
    } finally {
      setSaving(false)
    }
  }

  function toggleKill() {
    const next = !kill
    if (
      next &&
      !window.confirm(
        'להפעיל מצב תחזוקה? כל המשתמשים ייחסמו מהאתר ומהתוכנה (פאנל הניהול ימשיך לעבוד) עד שתכבה ידנית.',
      )
    )
      return
    setKill(next)
    void save({ killSwitch: next })
  }

  function saveSettings() {
    const rc = Math.max(0, Math.floor(Number(readCeiling) || 0))
    const wc = Math.max(0, Math.floor(Number(writeCeiling) || 0))
    void save({ autoKill, dailyReadCeiling: rc, dailyWriteCeiling: wc })
  }

  const reads = firestore.configured ? firestore.reads || 0 : 0
  const writes = firestore.configured ? firestore.writes || 0 : 0
  const rc = Math.max(0, Math.floor(Number(readCeiling) || 0))
  const wc = Math.max(0, Math.floor(Number(writeCeiling) || 0))

  return (
    <div
      className={
        'overflow-hidden rounded-2xl border bg-card ' +
        (kill ? 'border-destructive/50' : 'border-border')
      }
    >
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div
          className={
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ' +
            (kill
              ? 'bg-destructive/15 text-destructive'
              : 'bg-primary/10 text-primary')
          }
        >
          <Power className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">מתג חירום והגנת עלות</h3>
          <p className="text-[11px] text-fg-faint">
            עצירת חירום של המערכת + תקרת קריאות/כתיבות יומית
          </p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* Master kill switch */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <ShieldAlert
                className={'h-4 w-4 ' + (kill ? 'text-destructive' : 'text-fg-muted')}
              />
              מצב תחזוקה (Kill-switch)
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
              {kill
                ? 'פעיל — האתר והתוכנה חסומים למשתמשים. לחיצה תכבה ותחזיר את השירות.'
                : 'כבוי — הכל עובד כרגיל. הפעלה חוסמת מיידית את כל המשתמשים (פאנל הניהול ממשיך לעבוד).'}
            </p>
          </div>
          <Toggle on={kill} onClick={toggleKill} disabled={saving} danger />
        </div>

        {/* Daily ceilings + auto-trip */}
        <div className="rounded-xl border border-border bg-background px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">
                חסימה אוטומטית בחציית תקרה
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                כשמופעל — אם השימוש היומי חוצה תקרה, מצב התחזוקה נדלק אוטומטית.
                בודק מול נתוני הניטור (חינם), לא מבצע קריאות למסד.
              </p>
            </div>
            <Toggle on={autoKill} onClick={() => setAutoKill((v) => !v)} disabled={saving} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CeilingInput
              label="תקרת קריאות ליום"
              value={readCeiling}
              onChange={setReadCeiling}
              used={reads}
              ceiling={rc}
            />
            <CeilingInput
              label="תקרת כתיבות ליום"
              value={writeCeiling}
              onChange={setWriteCeiling}
              used={writes}
              ceiling={wc}
            />
          </div>
          <p className="mt-2 text-[10px] text-fg-faint">
            0 = ללא תקרה. התקרה רק מתריעה/חוסמת לפי הבחירה למעלה — היא לא משנה את
            החיוב בפועל.
          </p>

          <div className="mt-3 flex items-center justify-end gap-2">
            {err && <span className="text-[11px] text-destructive">{err}</span>}
            <button
              type="button"
              onClick={saveSettings}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              שמור הגדרות
            </button>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-fg-faint">
          זו עצירה ברמת האפליקציה (תחזוקה) — מיידית והפיכה, מצוינת לפיתוח או
          לחסימת ניצול לרעה. כגיבוי-אסון מוחלט מול עלות בלתי-צפויה קיים גם
          ה-kill-switch ברמת החיוב של Google Cloud (Budget → Cloud Function שמכבה
          חיוב), שמתואר ב-<span dir="ltr">docs/killswitch</span>.
        </p>
      </div>
    </div>
  )
}

function CeilingInput({
  label,
  value,
  onChange,
  used,
  ceiling,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  used: number
  ceiling: number
}) {
  const pct = ceiling > 0 ? Math.min(100, (used / ceiling) * 100) : 0
  const tone =
    pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-accent' : 'bg-primary'
  return (
    <div>
      <label className="mb-1 block text-[11px] text-fg-muted">{label}</label>
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        dir="ltr"
        className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg tabular-nums outline-none focus:border-primary"
      />
      {ceiling > 0 ? (
        <>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={'h-full rounded-full ' + tone}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-fg-faint" dir="ltr">
            {used.toLocaleString()} / {ceiling.toLocaleString()} היום
          </p>
        </>
      ) : (
        <p className="mt-1 text-[10px] text-fg-faint">ללא תקרה</p>
      )}
    </div>
  )
}
