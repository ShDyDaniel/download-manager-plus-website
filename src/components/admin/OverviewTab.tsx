import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Users as UsersIcon,
  Crown,
  Clock,
  CalendarPlus,
  TimerOff,
} from 'lucide-react'
import { cachedAdminApi, peekAdminCache } from '../../lib/adminCache'

interface OverviewStats {
  usersTotal: number | null
  proUsers: number | null
  trialsActive: number | null
  trialsExpired: number | null
  newThisWeek: number | null
}

/** "נתונים כלליים" — the cheap admin landing tab. Reads ONLY aggregate
 *  counters via Firestore count() (a few reads total, no per-doc scan,
 *  no names/emails), so opening the panel doesn't burn the read budget. */
export default function OverviewTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [data, setData] = useState<OverviewStats | null>(
    peekAdminCache<OverviewStats>('admin-overview-stats') ?? null,
  )
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  async function load(force = false) {
    setError('')
    if (force) setRefreshing(true)
    try {
      const r = await cachedAdminApi<OverviewStats>(
        'admin-overview-stats',
        {},
        { force },
      )
      setData(r)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') {
        if (force) setRefreshing(false)
        return onAuthExpired()
      }
      setError(err.message || 'טעינה נכשלה')
    } finally {
      if (force) setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fmt = (n: number | null | undefined) =>
    typeof n === 'number' ? n.toLocaleString('he-IL') : '—'

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">נתונים כלליים</h2>
          <p className="mt-1 text-sm text-fg-muted">
            מבט מהיר במספרים בלבד — בלי לטעון רשימות, כדי לחסוך קריאות.
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'מרענן…' : 'רענן'}
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {data === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              icon={<UsersIcon className="h-5 w-5" />}
              label="סה״כ משתמשים"
              value={fmt(data.usersTotal)}
            />
            <StatCard
              icon={<Crown className="h-5 w-5" />}
              label="מנויי פרו"
              value={fmt(data.proUsers)}
              accent
            />
            <StatCard
              icon={<Clock className="h-5 w-5" />}
              label="בניסיון פעיל"
              value={fmt(data.trialsActive)}
            />
            <StatCard
              icon={<TimerOff className="h-5 w-5" />}
              label="ניסיונות שפגו"
              value={fmt(data.trialsExpired)}
            />
            <StatCard
              icon={<CalendarPlus className="h-5 w-5" />}
              label="חדשים השבוע"
              value={fmt(data.newThisWeek)}
            />
          </div>

          <p className="text-[11px] text-fg-faint">
            המספרים מחושבים בספירה מצרפית — מספר קריאות זעום, ללא טעינת
            הרשומות עצמן. הנתונים נשמרים זמנית, רענון מושך מספרים טריים.
          </p>
        </>
      )}
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent,
  note,
}: {
  icon: React.ReactNode
  label: string
  value: string
  accent?: boolean
  note?: string
}) {
  return (
    <div
      className={
        'rounded-2xl border bg-card p-5 ' +
        (accent ? 'border-primary/30' : 'border-border')
      }
    >
      <div
        className={
          'flex h-9 w-9 items-center justify-center rounded-lg ' +
          (accent
            ? 'bg-primary/15 text-primary'
            : 'bg-bg-elevated text-fg-muted')
        }
      >
        {icon}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span
          className="font-display text-3xl font-bold text-fg tabular-nums"
          dir="ltr"
        >
          {value}
        </span>
        {note && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-500">
            {note}
          </span>
        )}
      </div>
      <div className="mt-1 text-sm text-fg-muted">{label}</div>
    </div>
  )
}
