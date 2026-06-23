import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  AudioWaveform,
  Download,
  Film,
  Music,
  CheckCircle2,
  Loader2,
  ArrowDown,
  Square,
  RotateCcw,
} from 'lucide-react'
import { Footer } from '../components/Footer'

/**
 * /sync — marketing landing page for the desktop app's audio-sync tab
 * ("סנכרון אוטומטי"). The centerpiece is a self-contained animated mock of
 * the real timeline: clips drop in stacked, an equalizer-style progress bar
 * runs, then the clips snap onto a shared timeline — looped. The single CTA
 * sends the visitor to the home page where the actual download lives (per the
 * operator's request — one download surface, not two).
 *
 * Pure CSS + framer-motion, no screenshots. framer respects the site's
 * "stop animations" accessibility toggle via the global MotionConfig.
 */
export function SyncLandingPage() {
  return (
    <div className="relative">
      <Hero />
      <DemoSection />
      <HowItWorks />
      <FeatureGrid />
      <FinalCta />
      <Footer />
    </div>
  )
}

/* ── Hero ──────────────────────────────────────────────────────────────── */
function Hero() {
  const scrollToHow = () => {
    const el = document.getElementById('how')
    if (!el) return
    // Offset so the section lands a touch below the top (header + breathing
    // room) instead of overshooting to the very top.
    const top = el.getBoundingClientRect().top + window.scrollY - 90
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }

  return (
    <section className="relative overflow-hidden px-5 pt-24 pb-10 md:px-6 md:pt-32 md:pb-16">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[460px] w-[680px] -translate-x-1/2 rounded-full"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(212,165,116,0.16) 0%, transparent 65%)',
        }}
      />
      <div className="relative mx-auto max-w-3xl text-center">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="label mb-5"
        >
          — סנכרון אוטומטי מבוסס אודיו
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.05 }}
          className="font-display text-fg"
          style={{ fontSize: 'clamp(40px, 8vw, 64px)', lineHeight: 1.05, letterSpacing: '-0.02em' }}
        >
          סנכרון <span className="accent-word">אוטומטי</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mx-auto mt-6 max-w-2xl text-fg-secondary"
          style={{ fontSize: '17px', lineHeight: 1.6 }}
        >
          טוענים הסרטות מכמה מצלמות וממיקרופונים חיצוניים — והמערכת תסנכרן את כולם
          על ציר זמן אחד בצורה מדוייקת ואוטומטית.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.25 }}
          className="mt-8 flex flex-wrap items-center justify-center gap-5"
        >
          <Link
            to="/"
            onClick={() => window.scrollTo(0, 0)}
            className="btn-primary min-h-[44px] justify-center px-6"
          >
            <Download className="h-[18px] w-[18px]" />
            הורדת המערכת
          </Link>
          <button
            type="button"
            onClick={scrollToHow}
            className="inline-flex items-center gap-2 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            איך זה עובד?
          </button>
        </motion.div>
      </div>
    </section>
  )
}

/* ── Animated demo ─────────────────────────────────────────────────────── */
type Kind = 'video' | 'camera' | 'mic'
interface DemoClip {
  id: string
  kind: Kind
  lane: number
  name: string
  un: { x: number; w: number }
  sy: { x: number; w: number }
  seed: number
}

const SECTIONS: { key: Kind; label: string; icon: typeof Film }[] = [
  { key: 'video', label: 'וידיאו', icon: Film },
  { key: 'camera', label: 'סאונד פנימי', icon: Music },
  { key: 'mic', label: 'סאונד חיצוני', icon: Music },
]

const CLIPS: DemoClip[] = [
  { id: 'v1', kind: 'video', lane: 0, name: 'CAM_A_0125.MP4', un: { x: 2, w: 46 }, sy: { x: 5, w: 46 }, seed: 11 },
  { id: 'v2', kind: 'video', lane: 1, name: 'CAM_B_0048.MP4', un: { x: 2, w: 40 }, sy: { x: 43, w: 40 }, seed: 7 },
  { id: 'c1', kind: 'camera', lane: 0, name: 'CAM_A_0125', un: { x: 2, w: 46 }, sy: { x: 5, w: 46 }, seed: 3 },
  { id: 'c2', kind: 'camera', lane: 1, name: 'CAM_B_0048', un: { x: 2, w: 40 }, sy: { x: 43, w: 40 }, seed: 5 },
  { id: 'm1', kind: 'mic', lane: 0, name: 'DJI_03_172445.WAV', un: { x: 2, w: 60 }, sy: { x: 2, w: 60 }, seed: 9 },
  { id: 'm2', kind: 'mic', lane: 1, name: 'DJI_02_175539.WAV', un: { x: 2, w: 44 }, sy: { x: 36, w: 44 }, seed: 13 },
]

const HEAD = 18
const ROW = 44
const RULER = 22
const SECTION_H = HEAD + 2 * ROW
const BODY_H = SECTIONS.length * SECTION_H

function sectionTop(kind: Kind): number {
  return SECTIONS.findIndex((s) => s.key === kind) * SECTION_H
}

function DemoSection() {
  // Phase loop: "sync" (analysing) → "done" (aligned) → back. The cycle
  // counter re-keys the progress fill so it restarts cleanly each round.
  const [phase, setPhase] = useState<'sync' | 'done'>('sync')
  const [cycle, setCycle] = useState(0)

  useEffect(() => {
    const t = window.setTimeout(
      () => {
        if (phase === 'sync') setPhase('done')
        else {
          setPhase('sync')
          setCycle((c) => c + 1)
        }
      },
      phase === 'sync' ? 3200 : 4200,
    )
    return () => window.clearTimeout(t)
  }, [phase, cycle])

  return (
    <section id="demo" className="px-5 pb-16 md:px-6 md:pb-24">
      <div className="mx-auto max-w-5xl">
        <div
          className="card-elevated overflow-hidden"
          style={{
            boxShadow:
              '0 32px 80px rgba(13,8,4,0.55), 0 8px 24px rgba(13,8,4,0.4), 0 0 0 1px rgba(245,239,230,0.06)',
          }}
        >
          {/* Window chrome — dir=ltr so the macOS traffic lights sit on the
              LEFT (the platform convention + how the real app renders). */}
          <div
            className="flex items-center gap-2 border-b border-border px-4 py-3"
            style={{ backgroundColor: 'var(--bg-card)' }}
            dir="ltr"
          >
            <span className="h-3 w-3 rounded-full bg-destructive opacity-70" />
            <span className="h-3 w-3 rounded-full opacity-70" style={{ backgroundColor: 'var(--accent)' }} />
            <span className="h-3 w-3 rounded-full bg-success opacity-70" />
            <div className="flex flex-1 items-center justify-center gap-2 text-xs text-fg-muted" dir="rtl">
              <AudioWaveform className="h-3.5 w-3.5 text-primary" />
              סנכרון אוטומטי
            </div>
            <span className="w-12" aria-hidden />
          </div>

          {/* Body */}
          <div className="p-4 md:p-6">
            <Timeline phase={phase} />

            {/* Action area — equalizer progress ⇄ export */}
            <div className="mt-4 min-h-[44px]">
              <AnimatePresence mode="wait" initial={false}>
                {phase === 'sync' ? (
                  <SyncBar key={`bar-${cycle}`} />
                ) : (
                  <ExportRow key="export" />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Timeline({ phase }: { phase: 'sync' | 'done' }) {
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-border"
      style={{ backgroundColor: 'rgba(13,8,4,0.35)' }}
      dir="ltr"
    >
      {/* Ruler */}
      <div className="relative border-b border-border" style={{ height: RULER, backgroundColor: 'var(--bg-card)' }}>
        {['0:00', '15:00', '30:00', '45:00', '1:00:00'].map((t, i) => (
          <span
            key={t}
            className="absolute top-1 text-[9px] tabular text-fg-faint"
            style={{ left: `calc(${(i / 4) * 100}% + 6px)` }}
          >
            {t}
          </span>
        ))}
      </div>

      {/* Lanes + sections */}
      <div className="relative" style={{ height: BODY_H }}>
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((g) => (
          <div
            key={g}
            className="absolute top-0 bottom-0 w-px"
            style={{ left: `${g * 100}%`, backgroundColor: 'rgba(245,239,230,0.05)' }}
          />
        ))}

        {SECTIONS.map((s) => (
          <div
            key={s.key}
            className="absolute left-0 right-0 flex items-center gap-1.5 border-b border-border/60 px-2 text-[9px] font-semibold uppercase tracking-wider text-fg-muted"
            style={{ top: sectionTop(s.key), height: HEAD, backgroundColor: 'rgba(42,33,26,0.6)' }}
          >
            <s.icon className="h-2.5 w-2.5" />
            {s.label}
          </div>
        ))}

        {CLIPS.map((c, i) => (
          <ClipBar key={c.id} clip={c} phase={phase} index={i} />
        ))}
      </div>
    </div>
  )
}

const NAME_H = 17 // height of the top name strip; media pattern sits below it

function ClipBar({ clip, phase, index }: { clip: DemoClip; phase: 'sync' | 'done'; index: number }) {
  const done = phase === 'done'
  const pos = done ? clip.sy : clip.un
  const top = sectionTop(clip.kind) + HEAD + clip.lane * ROW + 5
  const isVideo = clip.kind === 'video'

  // Synced clips read green ("matched"); while analysing they're neutral.
  const tint = done
    ? { border: 'rgba(125,170,107,0.6)', bg: 'rgba(125,170,107,0.14)', wave: 'rgba(125,170,107,0.9)' }
    : { border: 'rgba(245,239,230,0.16)', bg: 'var(--bg-elevated)', wave: 'rgba(245,239,230,0.4)' }

  return (
    <motion.div
      className="absolute overflow-hidden rounded-md border"
      style={{ top, height: ROW - 10, borderColor: tint.border, backgroundColor: tint.bg }}
      initial={false}
      animate={{ left: `${pos.x}%`, width: `${pos.w}%` }}
      transition={{ type: 'spring', stiffness: 120, damping: 18, delay: done ? index * 0.05 : 0 }}
    >
      {/* Media pattern lives BELOW the name strip so the filename always
          stays on a clean band and is readable. */}
      <div className="absolute inset-x-0 bottom-0" style={{ top: NAME_H, color: tint.wave }}>
        {isVideo ? (
          <div
            className="absolute inset-0 opacity-30"
            style={{ background: 'repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 9px)' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center opacity-55">
            <WaveRow seed={clip.seed} />
          </div>
        )}
      </div>
      {/* Name strip — dark scrim + bright text + shadow so it reads on any clip */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 px-1.5"
        style={{
          height: NAME_H,
          background: 'linear-gradient(to bottom, rgba(13,8,4,0.6), rgba(13,8,4,0))',
        }}
      >
        {isVideo && (
          <Film className="h-2.5 w-2.5 shrink-0" style={{ color: 'rgba(245,239,230,0.92)' }} />
        )}
        <span
          className="truncate text-[10px] font-semibold leading-none"
          style={{ direction: 'ltr', color: '#F5EFE6', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
        >
          {clip.name}
        </span>
      </div>
    </motion.div>
  )
}

/** Deterministic pseudo-waveform — a row of bars whose heights follow a
 *  seeded sine so each clip looks distinct but stable across renders. */
function WaveRow({ seed }: { seed: number }) {
  const peaks = useMemo(() => {
    const n = 40
    return Array.from({ length: n }, (_, i) => {
      const v = Math.abs(Math.sin(seed + i * 0.55) * Math.cos(i * 0.23 + seed * 0.7))
      return 0.18 + 0.78 * v
    })
  }, [seed])
  return (
    <div className="flex h-full w-full items-center justify-between px-1">
      {peaks.map((p, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full"
          style={{ height: `${Math.round(p * 70)}%`, backgroundColor: 'currentColor' }}
        />
      ))}
    </div>
  )
}

/** The live "analysing" bar — label + spinner + a pulsing equalizer whose
 *  lit fraction fills left→right over the sync phase. */
function SyncBar() {
  const BARS = 40
  const [pct, setPct] = useState(0)
  useEffect(() => {
    const start = performance.now()
    const DURATION = 3000
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(100, ((now - start) / DURATION) * 100)
      setPct(Math.round(p))
      if (p < 100) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const lit = (BARS * pct) / 100
  // Two user-facing stages like the app: decode ("טעינת קבצים") → correlate.
  const stage = pct < 48 ? 'טעינת קבצים' : 'מסנכרן'

  return (
    <motion.div
      className="flex w-full items-center gap-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      dir="rtl"
    >
      {/* The bar (right): label + spinner on the right, equalizer filling
          right→left. */}
      <div
        className="flex h-11 flex-1 items-center overflow-hidden rounded-xl border"
        style={{ borderColor: 'rgba(212,165,116,0.3)', backgroundColor: 'rgba(13,8,4,0.55)' }}
      >
        <div className="flex shrink-0 items-center gap-2 px-4 text-sm font-semibold text-fg">
          <span className="tabular">
            {stage} · {pct}%
          </span>
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        </div>
        <div className="relative h-full flex-1 border-r border-border/60">
          {/* Inherits the parent's RTL → bar 0 is right-most, so the lit
              fraction fills from the RIGHT leftwards, exactly like the app. */}
          <div className="absolute inset-0 flex items-center justify-between px-3" aria-hidden>
            {Array.from({ length: BARS }).map((_, i) => (
              <motion.span
                key={i}
                className="w-[2px] rounded-full"
                // height lives in `style` (not `initial`) so the bars are
                // always visible — `initial={false}` on the AnimatePresence
                // made the first cycle skip an initial-only height → no bars.
                style={{
                  height: '62%',
                  backgroundColor: i < lit ? 'var(--primary)' : 'rgba(245,239,230,0.08)',
                  transformOrigin: 'center',
                }}
                animate={{ scaleY: [0.32, 1, 0.32] }}
                transition={{
                  duration: 0.7 + (i % 7) * 0.13,
                  repeat: Infinity,
                  ease: 'easeInOut',
                  delay: (i % 13) * 0.07,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      {/* Stop button (left) — the app's destructive square. */}
      <span
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: 'var(--destructive)', color: '#F5EFE6' }}
      >
        <Square className="h-3.5 w-3.5" style={{ fill: 'currentColor' }} />
      </span>
    </motion.div>
  )
}

function ExportRow() {
  return (
    <motion.div
      className="flex flex-wrap items-center gap-x-3 gap-y-2.5"
      initial={{ opacity: 0, scale: 0.94, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      dir="rtl"
    >
      {/* The two export buttons stay on ONE row together (no wrap between
          them). Compact on mobile (smaller size + shorter labels) so both
          fit side by side; full app-style size + labels on desktop. */}
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold sm:h-11 sm:gap-2 sm:rounded-xl sm:px-5 sm:text-[15px]"
          style={{ backgroundColor: 'var(--primary)', color: 'var(--bg)' }}
        >
          <Download className="h-3.5 w-3.5 sm:h-[18px] sm:w-[18px]" />
          <span className="sm:hidden">Resolve / Premiere</span>
          <span className="hidden sm:inline">XML · Resolve / Premiere</span>
        </span>
        <span
          className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium text-fg sm:h-11 sm:gap-2 sm:rounded-xl sm:px-5 sm:text-[15px]"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border)' }}
        >
          <Download className="h-3.5 w-3.5 sm:h-[18px] sm:w-[18px]" />
          <span className="sm:hidden">Final Cut</span>
          <span className="hidden sm:inline">FCPXML · Final Cut</span>
        </span>
      </div>
      <span className="inline-flex h-9 items-center gap-2 px-2 text-sm font-medium text-fg-muted sm:h-11 sm:px-3">
        <RotateCcw className="h-4 w-4" />
        איפוס
      </span>
      <span className="flex items-center gap-1.5 text-sm text-fg-muted">
        <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--success)' }} />
        <bdi>6</bdi> סונכרנו
      </span>
    </motion.div>
  )
}

/* ── How it works — editorial steps (numbers + hair-lines, no cards) ────── */
function HowItWorks() {
  const steps = [
    {
      title: 'הכנסת חומרים',
      body: 'טוענים הסרטות מכמה מצלמות וממיקרופונים חיצוניים, או מייבאים טיימליין שלם.',
    },
    {
      title: 'המערכת מסנכרנת',
      body: 'קצב הפריימים מזוהה אוטומטית, והסאונד של כל קליפ מנותח ומסונכרן בצורה מדוייקת.',
    },
    {
      title: 'ייצוא',
      body: 'כל הקליפים מיושרים על ציר זמן אחד. מייצאים טיימליין מוכן ופותחים אותו ישירות בתוכנת העריכה.',
    },
  ]
  return (
    <section id="how" className="px-5 py-16 md:px-6 md:py-28">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-10 md:mb-16"
        >
          <div className="label mb-5">— שלושה צעדים</div>
          <h2
            className="font-display text-fg"
            style={{ fontSize: 'clamp(34px, 5vw, 60px)', lineHeight: 1.05, letterSpacing: '-0.015em', maxWidth: '720px' }}
          >
            ככה זה <span className="accent-word">עובד</span>
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-3 md:gap-y-0">
          {steps.map((s, idx) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: Math.min(idx * 0.08, 0.24) }}
            >
              <div className="flex items-baseline gap-3">
                <span className="tabular text-xs font-medium" style={{ color: 'var(--fg-faint)' }}>
                  0{idx + 1}
                </span>
                <h3 className="font-display text-2xl text-fg">{s.title}</h3>
              </div>
              <div className="mt-5 border-t border-border pt-5">
                <p className="text-[15px] text-fg-secondary" style={{ lineHeight: 1.6 }}>
                  {s.body}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ── Capabilities — editorial spec list (em-dash bullets, no cards) ─────── */
function FeatureGrid() {
  const items = [
    'סנכרון מדויק בין כמה מצלמות שצילמו את אותו אירוע (מולטיקאם)',
    'סאונד נקי ממיקרופון חיצוני, מסונכרן אוטומטית לוידיאו',
    'זיהוי קצב פריימים אוטומטי',
    'דיוק תת-פריים — התאמה לפי האודיו עצמו, ברמת מילישניות',
    'ייצוא טיימליין ל-DaVinci Resolve, Premiere ו-Final Cut',
    'ייבוא טיימליין קיים וסנכרון ישירות ממנו בלי צורך לייבא קבצים נוספים',
  ]
  return (
    <section className="px-5 py-16 md:px-6 md:py-28">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-10 md:mb-14"
        >
          <div className="label mb-5">— מה מקבלים</div>
          <h2
            className="font-display text-fg"
            style={{ fontSize: 'clamp(34px, 5vw, 60px)', lineHeight: 1.05, letterSpacing: '-0.015em', maxWidth: '760px' }}
          >
            הכל אוטומטי, הכל <span className="accent-word">מדויק</span>
          </h2>
        </motion.div>

        <ul className="grid grid-cols-1 gap-x-16 gap-y-5 md:grid-cols-2">
          {items.map((item, idx) => (
            <motion.li
              key={item}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.35, delay: Math.min(idx * 0.05, 0.2) }}
              className="flex items-baseline gap-3 border-t border-border pt-5 text-[15px] text-fg-secondary"
              style={{ lineHeight: 1.6 }}
            >
              <span aria-hidden className="shrink-0 select-none" style={{ color: 'var(--accent)' }}>
                —
              </span>
              <span>{item}</span>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/* ── Final CTA — editorial, right-aligned, hair-line separator ──────────── */
function FinalCta() {
  return (
    <section className="px-5 pb-24 pt-4 md:px-6 md:pb-32">
      <div className="mx-auto max-w-6xl border-t border-border pt-14 text-center md:pt-20">
        <h2
          className="font-display text-fg"
          style={{ fontSize: 'clamp(30px, 5vw, 52px)', lineHeight: 1.08, letterSpacing: '-0.02em' }}
        >
          שנתחיל <span className="accent-word">לסנכרן</span>?
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-fg-secondary" style={{ fontSize: '17px', lineHeight: 1.6 }}>
          הסנכרון האוטומטי הוא חלק מ"ניהול הורדות פלוס" — מערכת ליוצרי תוכן
          ולעורכי וידאו.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <Link
            to="/"
            onClick={() => window.scrollTo(0, 0)}
            className="btn-primary min-h-[48px] justify-center px-8 text-base"
          >
            <Download className="h-5 w-5" />
            הורדת המערכת
          </Link>
          <span className="text-sm text-fg-muted">תומך macOS ו-Windows</span>
        </div>
      </div>
    </section>
  )
}

export default SyncLandingPage
