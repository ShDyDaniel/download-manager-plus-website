import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  DownloadCloud,
  X,
  ChevronLeft,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

interface UsageStatsDoc {
  uid: string
  date: string
  counts?: Record<string, number>
  seconds?: Record<string, number>
  total?: number
  totalSeconds?: number
}
interface UserDoc {
  uid: string
  email: string
  name?: string
}

const TAB_LABELS: Record<string, string> = {
  downloads: 'ניהול הורדות',
  youtube: 'הורדת קבצים',
  quotes: 'הצעות מחיר',
  payments: 'ניהול תשלומים',
  convert: 'המרת קבצים',
  settings: 'הגדרות',
}
const TAB_ORDER = ['downloads', 'youtube', 'quotes', 'payments', 'convert', 'settings']

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} שנ׳`
  if (sec < 3600) return `${Math.floor(sec / 60)} דק׳`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m ? `${h} שע׳ ${m} דק׳` : `${h} שע׳`
}

export default function DataTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [stats, setStats] = useState<UsageStatsDoc[] | null>(null)
  const [users, setUsers] = useState<UserDoc[]>([])
  const [error, setError] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullMsg, setPullMsg] = useState<string | null>(null)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'טעינה נכשלה')
  }

  async function load() {
    setError('')
    try {
      const [s, u] = await Promise.all([
        adminApi<{ stats: UsageStatsDoc[] }>('admin-list-usage-stats'),
        adminApi<{ users: UserDoc[] }>('admin-list-users'),
      ])
      setStats(s.stats)
      setUsers(u.users)
    } catch (e) {
      handleErr(e)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function pull() {
    if (pulling) return
    setPulling(true)
    setPullMsg(null)
    try {
      await adminApi('admin-issue-usage-pull')
      await new Promise((r) => setTimeout(r, 4000))
      await load()
      setPullMsg('הנתונים נמשכו ✓')
      setTimeout(() => setPullMsg(null), 3000)
    } catch (e) {
      handleErr(e)
    } finally {
      setPulling(false)
    }
  }

  // ── Aggregations ──
  const nameByUid = new Map(users.map((u) => [u.uid, u.name || u.email || u.uid]))
  const tabCounts = new Map<string, number>()
  const tabSeconds = new Map<string, number>()
  const userRollup = new Map<
    string,
    { counts: number; seconds: number; lastDate: string }
  >()
  let totalCounts = 0
  let totalSeconds = 0
  const cutoff7 = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })()
  const active7 = new Set<string>()

  for (const s of stats ?? []) {
    const visits = s.total ?? 0
    totalCounts += visits
    if (s.date >= cutoff7) active7.add(s.uid)
    for (const [t, n] of Object.entries(s.counts ?? {}))
      tabCounts.set(t, (tabCounts.get(t) ?? 0) + n)
    const secs = s.seconds ?? {}
    const docSecs =
      s.totalSeconds ?? Object.values(secs).reduce((a, n) => a + n, 0)
    totalSeconds += docSecs
    for (const [t, n] of Object.entries(secs))
      tabSeconds.set(t, (tabSeconds.get(t) ?? 0) + n)
    const cur = userRollup.get(s.uid) ?? { counts: 0, seconds: 0, lastDate: '' }
    cur.counts += visits
    cur.seconds += docSecs
    if (s.date > cur.lastDate) cur.lastDate = s.date
    userRollup.set(s.uid, cur)
  }

  const tabIds = [
    ...TAB_ORDER,
    ...[...tabCounts.keys()].filter((t) => !TAB_ORDER.includes(t)),
  ]
  const maxTabCount = Math.max(1, ...tabIds.map((t) => tabCounts.get(t) ?? 0))
  const userRows = [...userRollup.entries()]
    .map(([uid, r]) => ({ uid, ...r }))
    .sort((a, b) => b.counts - a.counts)

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-medium text-fg">
            נתוני שימוש
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            שימוש בפיצ׳רים של התוכנה (לפי טאב, זמן, ומשתמש). לחצו על משתמש לפירוט מלא.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={pull}
            disabled={pulling}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
            title="בקש ממשתמשים מחוברים לשלוח את נתוני השימוש העכשוויים"
          >
            {pulling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <DownloadCloud className="h-3.5 w-3.5" />
            )}
            משוך נתונים
          </button>
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
          >
            <RefreshCw className="h-3.5 w-3.5" /> רענן
          </button>
        </div>
      </header>

      {pullMsg && <div className="text-xs text-success">{pullMsg}</div>}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {stats === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border/60 py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="סך כניסות" value={totalCounts.toLocaleString()} />
            <Stat label="סך זמן" value={fmtDuration(totalSeconds)} />
            <Stat label="פעילים (7 ימים)" value={String(active7.size)} />
          </div>

          {/* Per-tab usage */}
          <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-5">
            <div className="mb-3 text-sm font-medium text-fg">שימוש לפי טאב</div>
            <div className="space-y-2.5">
              {tabIds.map((t) => {
                const c = tabCounts.get(t) ?? 0
                const sec = tabSeconds.get(t) ?? 0
                return (
                  <div key={t}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-fg">{TAB_LABELS[t] ?? t}</span>
                      <span className="text-fg-muted">
                        {c.toLocaleString()} כניסות · {fmtDuration(sec)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(c / maxTabCount) * 100}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Per-user table */}
          <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-5">
            <div className="mb-3 text-sm font-medium text-fg">
              לפי משתמש ({userRows.length})
            </div>
            {userRows.length === 0 ? (
              <p className="text-xs text-fg-muted">אין עדיין נתוני שימוש.</p>
            ) : (
              <div className="space-y-1.5">
                {userRows.map((r) => (
                  <button
                    key={r.uid}
                    type="button"
                    onClick={() => setSelectedUid(r.uid)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-right text-sm transition-colors hover:bg-white/[0.06]"
                    title="לחצו לפירוט מלא"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-fg">
                      <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                      <span className="truncate">
                        {nameByUid.get(r.uid) ?? r.uid}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-muted">
                      {r.counts.toLocaleString()} כניסות · {fmtDuration(r.seconds)}
                      {r.lastDate && ` · ${r.lastDate}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <UserUsageModal
        uid={selectedUid}
        users={users}
        stats={stats}
        onClose={() => setSelectedUid(null)}
      />
    </div>
  )
}

function UserUsageModal({
  uid,
  users,
  stats,
  onClose,
}: {
  uid: string | null
  users: UserDoc[]
  stats: UsageStatsDoc[] | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!uid) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [uid, onClose])

  if (!uid) return null

  const user = users.find((u) => u.uid === uid) ?? null
  const userStats = (stats ?? []).filter((s) => s.uid === uid)

  const tabVisits = new Map<string, number>()
  const tabSeconds = new Map<string, number>()
  let totalVisits = 0
  let totalSeconds = 0
  for (const s of userStats) {
    totalVisits += s.total ?? 0
    const docSeconds =
      s.totalSeconds ??
      Object.values(s.seconds ?? {}).reduce((a, n) => a + n, 0)
    totalSeconds += docSeconds
    for (const [t, n] of Object.entries(s.counts ?? {}))
      tabVisits.set(t, (tabVisits.get(t) ?? 0) + n)
    for (const [t, n] of Object.entries(s.seconds ?? {}))
      tabSeconds.set(t, (tabSeconds.get(t) ?? 0) + n)
  }

  const tabIds = [
    ...TAB_ORDER.filter((t) => tabVisits.has(t) || tabSeconds.has(t)),
    ...[...new Set([...tabVisits.keys(), ...tabSeconds.keys()])].filter(
      (t) => !TAB_ORDER.includes(t),
    ),
  ]
  const tabRows = tabIds
    .map((t) => ({
      id: t,
      label: TAB_LABELS[t] ?? t,
      visits: tabVisits.get(t) ?? 0,
      seconds: tabSeconds.get(t) ?? 0,
      sharePct:
        totalSeconds > 0
          ? Math.round(((tabSeconds.get(t) ?? 0) / totalSeconds) * 100)
          : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds)

  const dayRows = userStats
    .map((s) => {
      const docSeconds =
        s.totalSeconds ??
        Object.values(s.seconds ?? {}).reduce((a, n) => a + n, 0)
      let top: { id: string; seconds: number } | null = null
      for (const [t, n] of Object.entries(s.seconds ?? {}))
        if (!top || n > top.seconds) top = { id: t, seconds: n }
      return {
        date: s.date,
        visits: s.total ?? 0,
        seconds: docSeconds,
        topLabel: top ? TAB_LABELS[top.id] ?? top.id : '—',
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date))

  const daysActive = new Set(userStats.map((s) => s.date)).size

  return (
    <div
      dir="rtl"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 z-[250] flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-10 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-bg shadow-2xl">
        <header className="flex items-start gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-fg">
              {user?.name || user?.email || '(חשבון מחוק)'}
            </h2>
            {user?.email && (
              <div
                className="mt-0.5 text-[11px] text-fg-muted"
                dir="ltr"
                style={{ unicodeBidi: 'plaintext', textAlign: 'right' }}
              >
                {user.email}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-white/5 hover:text-fg"
            aria-label="סגירה"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto p-6">
          <div className="mb-5 grid grid-cols-3 gap-3">
            <Stat label="סך כניסות" value={totalVisits.toLocaleString()} />
            <Stat label="סך זמן" value={fmtDuration(totalSeconds)} />
            <Stat label="ימים פעילים" value={String(daysActive)} />
          </div>

          {userStats.length === 0 ? (
            <div className="rounded-2xl border border-border/60 py-8 text-center text-sm text-fg-muted">
              אין נתונים למשתמש זה.
            </div>
          ) : (
            <>
              <div className="mb-2 text-sm font-medium text-fg">פילוח לפי טאב</div>
              <div className="mb-5 overflow-hidden rounded-2xl border border-border/60">
                <table className="w-full text-right text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-fg-muted">
                      <th className="px-4 py-2.5 font-medium">טאב</th>
                      <th className="px-4 py-2.5 font-medium">כניסות</th>
                      <th className="px-4 py-2.5 font-medium">זמן</th>
                      <th className="px-4 py-2.5 font-medium">% מהזמן</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabRows.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b border-border/30 last:border-0 text-fg-muted"
                      >
                        <td className="px-4 py-2.5 text-fg">{t.label}</td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {t.visits.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {fmtDuration(t.seconds)}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{t.sharePct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mb-2 text-sm font-medium text-fg">פילוח לפי יום</div>
              <div className="overflow-hidden rounded-2xl border border-border/60">
                <table className="w-full text-right text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-fg-muted">
                      <th className="px-4 py-2.5 font-medium">תאריך</th>
                      <th className="px-4 py-2.5 font-medium">כניסות</th>
                      <th className="px-4 py-2.5 font-medium">זמן</th>
                      <th className="px-4 py-2.5 font-medium">טאב מוביל</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayRows.map((d) => (
                      <tr
                        key={d.date}
                        className="border-b border-border/30 last:border-0 text-fg-muted"
                      >
                        <td className="px-4 py-2.5 tabular-nums" dir="ltr">
                          {d.date}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {d.visits.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {fmtDuration(d.seconds)}
                        </td>
                        <td className="px-4 py-2.5 text-fg">{d.topLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-4 text-center">
      <div className="text-xl font-semibold text-fg">{value}</div>
      <div className="mt-1 text-[11px] text-fg-muted">{label}</div>
    </div>
  )
}
