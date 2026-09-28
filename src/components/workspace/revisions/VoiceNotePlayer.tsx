import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'

/* Voice-note player for the /revisions workspace — a 1:1 copy of the
 * desktop app's src/components/revisions/VoiceNotePlayer.tsx (markup +
 * classes), so it renders with the app's look inside `.app-ui`.
 * Kept separate from src/components/VoiceNotePlayer.tsx, which the
 * public review page uses with the site's own classes.
 *   • play / pause only — ALWAYS full volume, no volume UI
 *   • a slim seekable progress bar in the brand colour
 *   • a tiny monospace time readout
 * dir="ltr" so it reads like a standard media player inside the RTL UI. */
function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const ss = String(Math.floor(s % 60)).padStart(2, '0')
  return `${m}:${ss}`
}

export function VoiceNotePlayer({
  src,
  dimmed,
  className,
}: {
  src: string
  dimmed?: boolean
  className?: string
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = 1
  }, [src])

  function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      a.volume = 1
      void a.play()
    } else {
      a.pause()
    }
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    const a = audioRef.current
    if (!a || !(duration > 0)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    a.currentTime = ratio * duration
    setCurrent(a.currentTime)
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div
      dir="ltr"
      onClick={(e) => e.stopPropagation()}
      className={
        'mt-1.5 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.06] px-2 py-1.5 ' +
        (dimmed ? 'opacity-60 ' : '') +
        (className || '')
      }
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'השהיה' : 'ניגון'}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {playing ? (
          <Pause className="h-3.5 w-3.5" />
        ) : (
          <Play className="h-3.5 w-3.5 ps-0.5" />
        )}
      </button>
      <div
        onClick={seek}
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-primary/15"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {fmtTime(current)} / {fmtTime(duration)}
      </span>
    </div>
  )
}
