import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Cpu,
  Activity,
  BarChart3,
  ExternalLink,
} from 'lucide-react'
import { getAdminIdToken } from '../../lib/adminApi'

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
  vercel: { configured: boolean; dashboardUrl: string }
  fetchedAt: number
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
          <h2 className="font-display text-2xl font-medium text-fg">דשבורד שרתים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            שימוש חי במכסות — דאטאבייס, Cloudflare ו-Vercel.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
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
          <Section icon={<Cpu className="h-5 w-5" />} title="דאטאבייס" sub="Firestore · 24 שעות אחרונות">
            {usage.firestore.configured ? (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <UsageBar label="קריאות" used={usage.firestore.reads || 0} limit={usage.firestore.readsLimit || 50000} />
                <UsageBar label="כתיבות" used={usage.firestore.writes || 0} limit={usage.firestore.writesLimit || 20000} />
              </div>
            ) : (
              <NotConfigured
                error={usage.firestore.error}
                hint="הפעל את Cloud Monitoring API בפרויקט Firebase והגדר GOOGLE_APPLICATION_CREDENTIALS / מפתח שירות כדי לראות שימוש חי."
              />
            )}
          </Section>

          <Section icon={<Activity className="h-5 w-5" />} title="Cloudflare Worker" sub="בקשות · 24 שעות אחרונות">
            {usage.cloudflare.configured ? (
              <UsageBar label="בקשות" used={usage.cloudflare.requests || 0} limit={usage.cloudflare.requestsLimit || 100000} />
            ) : (
              <NotConfigured
                error={usage.cloudflare.error}
                hint="הגדר CF_API_TOKEN ו-CF_ACCOUNT_ID במשתני הסביבה של Vercel כדי לראות את מספר הבקשות ל-Worker."
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
    <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-5">
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
}: {
  label: string
  used: number
  limit: number
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
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={'h-full rounded-full ' + tone} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function NotConfigured({ error, hint }: { error?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-white/[0.02] px-4 py-3">
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
