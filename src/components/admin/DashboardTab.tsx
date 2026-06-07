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
} from 'lucide-react'
import { getAdminIdToken } from '../../lib/adminApi'

interface AdminUsage {
  firestore: {
    configured: boolean
    reads?: number
    readsLimit?: number
    writes?: number
    writesLimit?: number
    costReads?: number
    costWrites?: number
    costTotal?: number
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
                  כבה אותו ב"הגדרות → מתג חירום והגנת עלות" כדי להחזיר את השירות.
                </div>
              </div>
            </div>
          )}

          <Section
            icon={<Cpu className="h-5 w-5" />}
            title="דאטאבייס — שימוש ועלות"
            sub="Firestore · 24 שעות אחרונות"
          >
            {usage.firestore.configured ? (
              <DbPanel firestore={usage.firestore} protection={usage.protection} />
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

/* ── Database (Firestore) usage + projected cost ──────────────────
 *  Mirrors the R2 panel: live read/write bars + a monthly cost
 *  breakdown box. When a daily ceiling is configured (in Settings →
 *  מתג חירום והגנת עלות) the bar fills against that ceiling; otherwise
 *  against the free daily allowance. */
function DbPanel({
  firestore,
  protection,
}: {
  firestore: AdminUsage['firestore']
  protection?: AdminUsage['protection']
}) {
  const reads = firestore.reads || 0
  const writes = firestore.writes || 0
  const freeReads = firestore.readsLimit || 50000
  const freeWrites = firestore.writesLimit || 20000
  const readCeiling = protection?.dailyReadCeiling || 0
  const writeCeiling = protection?.dailyWriteCeiling || 0
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <DbBar
          label="קריאות (היום)"
          used={reads}
          freeLimit={freeReads}
          ceiling={readCeiling}
        />
        <DbBar
          label="כתיבות (היום)"
          used={writes}
          freeLimit={freeWrites}
          ceiling={writeCeiling}
        />
      </div>

      {/* Projected monthly cost — same layout as the R2 cost box */}
      <div className="rounded-xl border border-border bg-background p-3 text-xs">
        <div className="flex items-center justify-between py-1">
          <span className="text-fg-muted">תוכנית Blaze (בסיס)</span>
          <span className="tabular-nums text-fg" dir="ltr">
            $0.00 · לפי שימוש
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-fg-muted">
            קריאות (מעבר ל-{freeReads.toLocaleString()}/יום)
          </span>
          <span className="tabular-nums text-fg" dir="ltr">
            ${fmtUsd(firestore.costReads)}
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-fg-muted">
            כתיבות (מעבר ל-{freeWrites.toLocaleString()}/יום)
          </span>
          <span className="tabular-nums text-fg" dir="ltr">
            ${fmtUsd(firestore.costWrites)}
          </span>
        </div>
        <div className="my-2 border-t border-border" />
        <div className="flex items-center justify-between py-1">
          <span className="font-semibold text-fg">עלות חודשית צפויה</span>
          <span className="tabular-nums text-base font-bold text-primary" dir="ltr">
            ${fmtUsd(firestore.costTotal)}
          </span>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-fg-faint">
        אתה בתוכנית בתשלום (Blaze) — מכסת החינם היומית (
        {freeReads.toLocaleString()} קריאות · {freeWrites.toLocaleString()} כתיבות){' '}
        <strong className="text-fg-muted">אינה חוסמת</strong>; מעבר אליה החיוב לפי
        שימוש (~$0.03 ל-100K קריאות, ~$0.18 ל-100K כתיבות). העלות היא הערכה לפי 24
        השעות האחרונות × 30. שליטה ותקרת חסימה נמצאות ב"הגדרות → מתג חירום והגנת
        עלות".
      </p>
    </div>
  )
}

function DbBar({
  label,
  used,
  freeLimit,
  ceiling,
}: {
  label: string
  used: number
  freeLimit: number
  ceiling: number
}) {
  // When a ceiling is set, the bar measures progress toward the ceiling
  // (the auto-block point); otherwise toward the free daily allowance
  // (the point where cost begins).
  const limit = ceiling > 0 ? ceiling : freeLimit
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const tone =
    pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-accent' : 'bg-primary'
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums text-fg" dir="ltr">
          {used.toLocaleString()} / {limit.toLocaleString()}
          {ceiling > 0 ? null : <span className="text-fg-faint"> חינם</span>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={'h-full rounded-full ' + tone} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[10px] text-fg-faint">
        {ceiling > 0
          ? `מכסת חינם ${freeLimit.toLocaleString()} · תקרת חסימה ${ceiling.toLocaleString()}`
          : `${freeLimit.toLocaleString()} חינם ליום · מעבר לכך תשלום לפי שימוש`}
      </p>
    </div>
  )
}
