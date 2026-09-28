import { Cloud } from 'lucide-react'
import { formatStorageSize } from '../../lib/revisionsApi'

/**
 * Account storage as one slim line under the workspace title (/deliveries —
 * the same line /revisions draws for our own storage). The app pins a full
 * storage bar to the bottom of its window; on a web page that read as "a
 * window inside a window", so the data sits under the title instead.
 * App classes (rendered inside `.app-ui`).
 */
export function StorageMeter({ usedBytes, limitBytes }: { usedBytes: number; limitBytes: number }) {
  const pct = limitBytes ? Math.min(100, (usedBytes / limitBytes) * 100) : 0
  const high = pct >= 95
  const med = pct >= 80
  const tone = high ? 'text-destructive' : med ? 'text-amber-400' : 'text-foreground'
  const barTone = high ? 'bg-destructive' : med ? 'bg-amber-400' : 'bg-primary'
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <Cloud className="h-3 w-3" aria-hidden />
      <span>שטח אחסון בחשבון</span>
      <span aria-hidden>·</span>
      {/* LTR as one unit so the slash and the two sizes keep their order */}
      <span
        dir="ltr"
        className={'inline-flex items-center gap-1.5 ' + tone}
        title={`${formatStorageSize(usedBytes)} בשימוש מתוך ${formatStorageSize(limitBytes)} (${pct.toFixed(0)}%)`}
      >
        <span className="font-mono">
          {formatStorageSize(usedBytes)} / {formatStorageSize(limitBytes)}
        </span>
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-white/10">
          <span className={'absolute inset-y-0 left-0 ' + barTone} style={{ width: `${pct}%` }} />
        </span>
      </span>
      {high && <span className="text-destructive">· האחסון כמעט מלא. מחקו מסירות ישנות כדי לפנות מקום.</span>}
    </div>
  )
}
