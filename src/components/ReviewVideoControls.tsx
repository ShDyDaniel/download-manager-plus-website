import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import {
  Play,
  Pause,
  Rewind,
  FastForward,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
} from 'lucide-react'

/**
 * Custom, branded control bar for the client-review player. Replaces the
 * browser's native <video controls> so the review surface matches the site
 * (dark + copper) and — crucially for reviewing an edit — adds ±15s skip,
 * playback-speed, and single-frame stepping. It drives an existing <video>
 * element (owned by ReviewPage, so note-capture / seek-to-note keep using
 * the same ref); this component only reads/writes that element.
 *
 * The bar is an overlay pinned to the bottom of the video box, so it lives
 * inside the fullscreen wrapper and stays visible over the watermark in
 * every mode. Fullscreen itself stays owned by the parent (it must wrap the
 * element that also holds the watermark), passed in as onToggleFullscreen.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ReviewVideoControls({
  videoRef,
  fsActive,
  onToggleFullscreen,
  showFullscreen = true,
  fps = 25,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  fsActive: boolean
  onToggleFullscreen: () => void
  /** Hide our FS button where element-fullscreen isn't available (iPhone). */
  showFullscreen?: boolean
  /** Frames-per-second for the single-frame step buttons. */
  fps?: number
}) {
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  const [scrubbing, setScrubbing] = useState(false)

  // Mirror the <video> element's state into React so the bar re-renders.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => {
      if (!scrubbing) setCurrent(v.currentTime)
    }
    const onDur = () => setDuration(v.duration || 0)
    const onProg = () => {
      try {
        setBuffered(v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0)
      } catch {
        /* buffered can throw if empty */
      }
    }
    const onVol = () => {
      setMuted(v.muted)
      setVolume(v.volume)
    }
    const onRate = () => setRate(v.playbackRate)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('durationchange', onDur)
    v.addEventListener('loadedmetadata', onDur)
    v.addEventListener('progress', onProg)
    v.addEventListener('volumechange', onVol)
    v.addEventListener('ratechange', onRate)
    // Seed initial state (metadata may already be loaded).
    setPlaying(!v.paused)
    setDuration(v.duration || 0)
    setMuted(v.muted)
    setVolume(v.volume)
    setRate(v.playbackRate)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('durationchange', onDur)
      v.removeEventListener('loadedmetadata', onDur)
      v.removeEventListener('progress', onProg)
      v.removeEventListener('volumechange', onVol)
      v.removeEventListener('ratechange', onRate)
    }
  }, [videoRef, scrubbing])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }, [videoRef])

  const skip = useCallback(
    (delta: number) => {
      const v = videoRef.current
      if (!v) return
      v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta))
    },
    [videoRef],
  )

  const stepFrame = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current
      if (!v) return
      if (!v.paused) v.pause()
      v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + dir / Math.max(1, fps)))
    },
    [videoRef, fps],
  )

  const cycleSpeed = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const i = SPEEDS.indexOf(v.playbackRate)
    v.playbackRate = SPEEDS[(i + 1) % SPEEDS.length] ?? 1
  }, [videoRef])

  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
  }, [videoRef])

  const onVolumeInput = useCallback(
    (val: number) => {
      const v = videoRef.current
      if (!v) return
      v.volume = val
      v.muted = val === 0
    },
    [videoRef],
  )

  const seekTo = useCallback(
    (t: number) => {
      const v = videoRef.current
      if (!v) return
      const clamped = Math.max(0, Math.min(v.duration || 0, t))
      v.currentTime = clamped
      setCurrent(clamped)
    },
    [videoRef],
  )

  // Keyboard: space = play/pause, ←/→ = ∓15s. Ignored while the user is
  // typing in a field (e.g. the note composer) so we never hijack input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement)?.isContentEditable) return
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowRight') {
        skip(15)
      } else if (e.key === 'ArrowLeft') {
        skip(-15)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [togglePlay, skip])

  const pct = duration > 0 ? (current / duration) * 100 : 0
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0

  return (
    <>
      {/* Center play button when paused — big, obvious affordance. */}
      {!playing && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="נגן"
          className="absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70">
            <Play className="h-7 w-7 translate-x-0.5" fill="currentColor" />
          </span>
        </button>
      )}

      {/* Control bar — bottom overlay with a scrim so it reads over any frame. */}
      <div
        dir="ltr"
        className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pb-2 pt-8"
      >
        {/* Scrubber */}
        <div className="group relative flex h-3 items-center">
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-all group-hover:h-1.5">
            <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${bufPct}%` }} />
            <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pct}%` }} />
          </div>
          {/* Thumb */}
          <div
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
          {/* Invisible range on top for accessible drag/click seeking */}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={current}
            aria-label="מיקום בסרטון"
            onPointerDown={() => setScrubbing(true)}
            onPointerUp={() => setScrubbing(false)}
            onChange={(e) => seekTo(Number(e.target.value))}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
          />
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-1 text-white">
          <CtrlBtn label={playing ? 'השהה' : 'נגן'} onClick={togglePlay}>
            {playing ? <Pause className="h-5 w-5" fill="currentColor" /> : <Play className="h-5 w-5" fill="currentColor" />}
          </CtrlBtn>

          <CtrlBtn label="אחורה 15 שניות" onClick={() => skip(-15)}>
            <span className="relative flex items-center justify-center">
              <Rewind className="h-5 w-5" />
            </span>
          </CtrlBtn>
          <CtrlBtn label="קדימה 15 שניות" onClick={() => skip(15)}>
            <FastForward className="h-5 w-5" />
          </CtrlBtn>

          <CtrlBtn label="פריים אחורה" onClick={() => stepFrame(-1)}>
            <StepBack className="h-4 w-4" />
          </CtrlBtn>
          <CtrlBtn label="פריים קדימה" onClick={() => stepFrame(1)}>
            <StepForward className="h-4 w-4" />
          </CtrlBtn>

          {/* Volume */}
          <div className="group/vol flex items-center">
            <CtrlBtn label={muted || volume === 0 ? 'בטל השתקה' : 'השתק'} onClick={toggleMute}>
              {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </CtrlBtn>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="עוצמת שמע"
              onChange={(e) => onVolumeInput(Number(e.target.value))}
              className="ml-0.5 h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/30 opacity-0 transition-all [transition:width_0.15s,opacity_0.15s] group-hover/vol:w-16 group-hover/vol:opacity-100 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            />
          </div>

          <span className="mx-1 select-none font-mono text-[11px] tabular-nums text-white/85">
            {fmt(current)} / {fmt(duration)}
          </span>

          <div className="ml-auto flex items-center gap-1">
            {/* Playback speed */}
            <button
              type="button"
              onClick={cycleSpeed}
              title="מהירות נגינה"
              aria-label="מהירות נגינה"
              className="min-w-[2.5rem] rounded-md px-1.5 py-1 text-center font-mono text-[11px] font-semibold tabular-nums text-white/85 transition-colors hover:bg-white/15 hover:text-white"
            >
              {rate}×
            </button>
            {showFullscreen && (
              <CtrlBtn label={fsActive ? 'יציאה ממסך מלא' : 'מסך מלא'} onClick={onToggleFullscreen}>
                {fsActive ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
              </CtrlBtn>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function CtrlBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-white/85 transition-colors hover:bg-white/15 hover:text-white"
    >
      {children}
    </button>
  )
}
