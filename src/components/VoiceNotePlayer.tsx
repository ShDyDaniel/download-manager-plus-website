import { useEffect, useRef, useState } from 'react'
import { Play, Pause } from 'lucide-react'

/* Branded voice-note player. Replaces the browser's default
 * <audio controls> (the white pill with a volume slider + ⋮ menu) so a
 * recorded review note looks like part of the app. Deliberately minimal:
 *   • play / pause only — playback is ALWAYS at full volume, no volume UI
 *   • a slim seekable progress bar in the brand colour
 *   • a small monospace time readout (kept tiny so it doesn't dominate)
 *   • NO overflow / download menu
 * Laid out dir="ltr" so it reads like a standard media player (play on the
 * left, time flowing right) even inside the RTL review UI. */
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
  /** Fade the player (e.g. on a resolved note) to match the card. */
  dimmed?: boolean
  className?: string
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  // Always play at full volume — there is no volume control by design.
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
        aria-label={playing ? 'השהה' : 'נגן'}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-white transition-colors hover:bg-primary/90"
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
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-muted">
        {fmtTime(current)} / {fmtTime(duration)}
      </span>
    </div>
  )
}
