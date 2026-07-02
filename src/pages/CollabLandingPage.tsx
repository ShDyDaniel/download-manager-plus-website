import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  MessageSquare,
  Camera,
  Mic,
  Play,
  Lock,
  Clock,
  Download,
  ArrowDown,
  CheckCircle2,
  Layers,
  ShieldCheck,
  Link2,
} from 'lucide-react'
import { Footer } from '../components/Footer'

/**
 * /collab — marketing landing page for the two client-collaboration features:
 *   • סבבי תיקונים (revision rounds): a private review link where the client
 *     leaves time-stamped notes / screenshots / voice notes on the video, and
 *     the editor uploads new rounds.
 *   • מסירה ללקוח (client delivery): send the final cut behind an expiring,
 *     optionally password-protected link.
 *
 * The centerpiece is a self-contained, looping mock of the real review player:
 * a playhead sweeps the timeline and time-stamped notes pop in as it passes
 * their marker. Pure CSS + framer-motion (no screenshots); honors the site's
 * global reduced-motion config + a local rAF guard.
 */
export function CollabLandingPage() {
  return (
    <div className="relative">
      <Hero />
      <ReviewDemo />
      <Pillars />
      <HowItWorks />
      <CapabilityList />
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
          — עבודה מול לקוחות
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.05 }}
          className="font-display text-fg"
          style={{
            fontSize: 'clamp(40px, 8vw, 64px)',
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            textWrap: 'balance',
          }}
        >
          מסבב ראשון <span className="accent-word">למסירה סופית</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mx-auto mt-6 max-w-2xl text-fg-secondary"
          style={{ fontSize: '17px', lineHeight: 1.6 }}
        >
          שולחים ללקוח קישור לצפייה, והוא מעיר ישירות על הסרטון — על השנייה
          המדויקת. אתם מעלים סבב חדש, ובסוף מוסרים את הגרסה הסופית בקישור מאובטח.
          הכול במקום אחד, בלי קבצים שמסתובבים בוואטסאפ.
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

/* ── Review demo — the centerpiece ─────────────────────────────────────── */
type NoteKind = 'comment' | 'shot' | 'voice'
interface DemoNote {
  /** position on the timeline, 0..1 */
  at: number
  time: string
  kind: NoteKind
  text: string
}

const NOTES: DemoNote[] = [
  { at: 0.13, time: '0:08', kind: 'comment', text: 'האינטרו ארוך מדי — לחתוך פה' },
  { at: 0.37, time: '0:24', kind: 'shot', text: 'הצבע חם מדי בפריים הזה' },
  { at: 0.61, time: '0:39', kind: 'voice', text: 'הערה קולית · 0:07' },
  { at: 0.84, time: '0:54', kind: 'comment', text: 'להחליף את המוזיקה מכאן' },
]

const NOTE_ICON: Record<NoteKind, typeof MessageSquare> = {
  comment: MessageSquare,
  shot: Camera,
  voice: Mic,
}
const NOTE_LABEL: Record<NoteKind, string> = {
  comment: 'תיקון',
  shot: 'צילום מסך',
  voice: 'הערה קולית',
}

const SWEEP_MS = 9000
const HOLD_MS = 1400

function ReviewDemo() {
  const reduced = useReducedMotion()
  // playhead position 0..100. When reduced-motion, park it past the last note
  // so the panel shows the full, settled result instead of animating.
  const [pct, setPct] = useState(reduced ? 92 : 0)

  useEffect(() => {
    if (reduced) return
    let raf = 0
    let start = performance.now()
    let holdUntil = 0
    const tick = (now: number) => {
      if (holdUntil) {
        if (now >= holdUntil) {
          holdUntil = 0
          start = now
          setPct(0)
        }
      } else {
        const p = Math.min(100, ((now - start) / SWEEP_MS) * 100)
        setPct(p)
        if (p >= 100) holdUntil = now + HOLD_MS
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  const revealed = NOTES.filter((n) => pct / 100 >= n.at)
  const active = revealed.length ? revealed[revealed.length - 1] : null

  return (
    <section className="px-5 pb-16 md:px-6 md:pb-24">
      <div className="mx-auto max-w-5xl">
        <div
          className="card-elevated overflow-hidden"
          style={{
            boxShadow:
              '0 32px 80px rgba(13,8,4,0.55), 0 8px 24px rgba(13,8,4,0.4), 0 0 0 1px rgba(245,239,230,0.06)',
          }}
        >
          {/* Window chrome */}
          <div
            className="flex items-center gap-2 border-b border-border px-4 py-3"
            style={{ backgroundColor: 'var(--bg-card)' }}
            dir="ltr"
          >
            <span className="h-3 w-3 rounded-full bg-destructive opacity-70" />
            <span
              className="h-3 w-3 rounded-full opacity-70"
              style={{ backgroundColor: 'var(--accent)' }}
            />
            <span className="h-3 w-3 rounded-full bg-success opacity-70" />
            <div
              className="flex flex-1 items-center justify-center gap-2 text-xs text-fg-muted"
              dir="rtl"
            >
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
              סקירת סבב · לויץ
            </div>
            <span className="w-12" aria-hidden />
          </div>

          {/* Body: player (right) + notes panel (left) */}
          <div className="grid gap-0 md:grid-cols-[1.6fr_1fr]">
            <ReviewStage pct={pct} active={active} />
            <NotesPanel revealedCount={revealed.length} activeAt={active?.at ?? null} />
          </div>
        </div>
      </div>
    </section>
  )
}

function ReviewStage({ pct, active }: { pct: number; active: DemoNote | null }) {
  return (
    <div className="relative p-4 md:p-5">
      {/* "Video" surface */}
      <div
        className="relative aspect-video overflow-hidden rounded-xl border border-border"
        style={{
          background:
            'radial-gradient(120% 120% at 70% 20%, #3a2c20 0%, #1a120c 60%, #0d0804 100%)',
        }}
      >
        {/* faint moving sheen so the frame feels "live" */}
        <motion.div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(115deg, transparent 30%, rgba(245,239,230,0.06) 50%, transparent 70%)',
          }}
          animate={{ x: ['-30%', '120%'] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* center play glyph */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'rgba(13,8,4,0.45)',
              boxShadow: '0 0 0 1px rgba(245,239,230,0.12)',
              backdropFilter: 'blur(2px)',
            }}
          >
            <Play
              className="ms-0.5 h-5 w-5"
              style={{ color: '#F5EFE6', fill: '#F5EFE6' }}
            />
          </span>
        </div>

        {/* watermark — viewer email, faint + diagonal, like the real player */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 left-3 font-mono text-[10px] tracking-wider"
          style={{ color: 'rgba(245,239,230,0.32)' }}
          dir="ltr"
        >
          client@studio.com
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-7 left-3 font-mono text-[9px] tracking-[0.2em]"
          style={{ color: 'rgba(245,239,230,0.22)' }}
          dir="ltr"
        >
          PREVIEW · NOT FOR DISTRIBUTION
        </span>

        {/* floating active-note bubble */}
        <div className="pointer-events-none absolute inset-x-3 top-10">
          <AnimatePresence mode="wait">
            {active && (
              <motion.div
                key={active.time}
                initial={{ opacity: 0, y: -6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                className="inline-flex max-w-[88%] items-center gap-2 rounded-lg px-2.5 py-1.5"
                style={{
                  backgroundColor: 'rgba(13,8,4,0.78)',
                  boxShadow: '0 0 0 1px rgba(212,165,116,0.35)',
                  backdropFilter: 'blur(3px)',
                }}
              >
                <NoteGlyph kind={active.kind} />
                <span className="truncate text-[12px] text-fg">{active.text}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* scrubber — LTR so the playhead sweeps left→right with the timecode */}
        <div className="absolute inset-x-0 bottom-0 px-3 pb-2.5" dir="ltr">
          <div
            className="relative h-1.5 rounded-full"
            style={{ backgroundColor: 'rgba(245,239,230,0.14)' }}
          >
            {/* filled portion */}
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${pct}%`, backgroundColor: 'var(--primary)' }}
            />
            {/* note markers */}
            {NOTES.map((n) => {
              const passed = pct / 100 >= n.at
              return (
                <span
                  key={n.time}
                  className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors"
                  style={{
                    left: `${n.at * 100}%`,
                    backgroundColor: passed ? 'var(--accent)' : 'rgba(245,239,230,0.35)',
                    boxShadow: passed ? '0 0 0 3px rgba(212,165,116,0.2)' : 'none',
                  }}
                />
              )
            })}
            {/* playhead */}
            <span
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${pct}%`,
                backgroundColor: '#F5EFE6',
                boxShadow: '0 1px 4px rgba(0,0,0,0.6)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function NoteGlyph({ kind }: { kind: NoteKind }) {
  const Icon = NOTE_ICON[kind]
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
      style={{ backgroundColor: 'rgba(212,165,116,0.16)', color: 'var(--accent)' }}
    >
      <Icon className="h-3 w-3" />
    </span>
  )
}

function NotesPanel({
  revealedCount,
  activeAt,
}: {
  revealedCount: number
  activeAt: number | null
}) {
  return (
    <div className="border-t border-border p-4 md:border-t-0 md:border-r md:p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          תיקונים
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular"
          style={{ backgroundColor: 'rgba(212,165,116,0.14)', color: 'var(--accent)' }}
        >
          <bdi>{revealedCount}</bdi> / <bdi>{NOTES.length}</bdi>
        </span>
      </div>

      <div className="space-y-2">
        {NOTES.map((n, i) => {
          const revealed = i < revealedCount
          const isActive = n.at === activeAt
          return (
            <motion.div
              key={n.time}
              initial={false}
              animate={{
                opacity: revealed ? 1 : 0.32,
                x: revealed ? 0 : 6,
              }}
              transition={{ type: 'spring', stiffness: 280, damping: 26 }}
              className="flex items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors"
              style={{
                borderColor: isActive ? 'rgba(212,165,116,0.45)' : 'var(--border)',
                backgroundColor: isActive
                  ? 'rgba(212,165,116,0.10)'
                  : 'rgba(13,8,4,0.25)',
              }}
            >
              <NoteGlyph kind={n.kind} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold tabular text-accent" dir="ltr">
                    {n.time}
                  </span>
                  <span className="text-[10px] text-fg-faint">{NOTE_LABEL[n.kind]}</span>
                </div>
                <p className="mt-0.5 truncate text-[12px] text-fg-secondary">{n.text}</p>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Two pillars — revisions + delivery, distinct treatments ───────────── */
function Pillars() {
  return (
    <section className="px-5 py-16 md:px-6 md:py-24">
      <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-2 md:gap-16">
        {/* Revisions */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.45 }}
        >
          <div className="mb-4 flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ backgroundColor: 'rgba(212,165,116,0.14)', color: 'var(--accent)' }}
            >
              <MessageSquare className="h-5 w-5" />
            </span>
            <h2 className="font-display text-2xl text-fg md:text-3xl">סבבי תיקונים</h2>
          </div>
          <p className="text-[15px] text-fg-secondary" style={{ lineHeight: 1.65 }}>
            כל פרויקט מקבל קישור צפייה פרטי. הלקוח רואה את הסרטון, עוצר על הרגע
            המדויק ומשאיר הערה — בטקסט, בצילום מסך מסומן או בהקלטה קולית. אתם
            רואים הכול לפי הזמן, מעלים סבב חדש, ונועלים סבבים ישנים.
          </p>
          <RoundsMini />
        </motion.div>

        {/* Delivery */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.45, delay: 0.08 }}
        >
          <div className="mb-4 flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ backgroundColor: 'rgba(125,170,107,0.14)', color: 'var(--success)' }}
            >
              <ShieldCheck className="h-5 w-5" />
            </span>
            <h2 className="font-display text-2xl text-fg md:text-3xl">מסירה ללקוח</h2>
          </div>
          <p className="text-[15px] text-fg-secondary" style={{ lineHeight: 1.65 }}>
            הגרסה הסופית מאושרת? שולחים אותה בקישור מסירה — עם תוקף שאתם בוחרים
            (3 / 7 / 14 ימים) וסיסמה אופציונלית. הלקוח צופה ומוריד בלי אפליקציה,
            בלי הרשמה, גם מהטלפון.
          </p>
          <DeliveryMini />
        </motion.div>
      </div>
    </section>
  )
}

/** Mini visual: three stacked rounds, latest on top + a locked older one. */
function RoundsMini() {
  const rounds = [
    { n: 3, label: 'סבב 3 · נוכחי', tone: 'accent' as const },
    { n: 2, label: 'סבב 2 · נעול', tone: 'muted' as const },
    { n: 1, label: 'סבב 1 · נעול', tone: 'muted' as const },
  ]
  return (
    <div className="mt-6 space-y-2">
      {rounds.map((r, i) => {
        const isCurrent = r.tone === 'accent'
        return (
          <motion.div
            key={r.n}
            initial={{ opacity: 0, x: 10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-30px' }}
            transition={{ duration: 0.35, delay: 0.1 + i * 0.07 }}
            className="flex items-center justify-between rounded-xl border px-3.5 py-3"
            style={{
              borderColor: isCurrent ? 'rgba(212,165,116,0.4)' : 'var(--border)',
              backgroundColor: isCurrent ? 'rgba(212,165,116,0.08)' : 'var(--bg-card)',
            }}
          >
            <span className="flex items-center gap-2.5">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold tabular"
                style={{
                  backgroundColor: isCurrent
                    ? 'var(--primary)'
                    : 'rgba(245,239,230,0.06)',
                  color: isCurrent ? 'var(--bg)' : 'var(--fg-muted)',
                }}
              >
                {r.n}
              </span>
              <span
                className={isCurrent ? 'text-sm font-medium text-fg' : 'text-sm text-fg-muted'}
              >
                {r.label}
              </span>
            </span>
            {isCurrent ? (
              <Layers className="h-4 w-4 text-accent" />
            ) : (
              <Lock className="h-3.5 w-3.5 text-fg-faint" />
            )}
          </motion.div>
        )
      })}
    </div>
  )
}

/** Mini visual: a delivery share-link card with expiry + password + download. */
function DeliveryMini() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-30px' }}
      transition={{ duration: 0.4, delay: 0.12 }}
      className="mt-6 rounded-2xl border border-border p-4"
      style={{ backgroundColor: 'var(--bg-card)' }}
    >
      {/* link row */}
      <div
        className="flex items-center gap-2 rounded-xl border border-border px-3 py-2.5"
        style={{ backgroundColor: 'rgba(13,8,4,0.3)' }}
        dir="ltr"
      >
        <Link2 className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="truncate font-mono text-[12px] text-fg-secondary">
          dmplus.net/deliver/9fb3…
        </span>
      </div>
      {/* meta chips */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-fg-secondary"
          style={{ backgroundColor: 'rgba(245,239,230,0.05)' }}
        >
          <Clock className="h-3 w-3 text-accent" />
          תוקף 7 ימים
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-fg-secondary"
          style={{ backgroundColor: 'rgba(245,239,230,0.05)' }}
        >
          <Lock className="h-3 w-3 text-accent" />
          מוגן בסיסמה
        </span>
      </div>
      {/* download button (mock) */}
      <div
        className="mt-3 flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold"
        style={{ backgroundColor: 'var(--primary)', color: 'var(--bg)' }}
      >
        <Download className="h-4 w-4" />
        הורדת הסרטון
      </div>
    </motion.div>
  )
}

/* ── How it works — editorial numbered steps ───────────────────────────── */
function HowItWorks() {
  const steps = [
    {
      title: 'שולחים קישור',
      body: 'יוצרים פרויקט, מעלים את הסרטון ושולחים ללקוח קישור צפייה פרטי — בלי שהוא צריך להתקין כלום.',
    },
    {
      title: 'הלקוח מעיר',
      body: 'הוא עוצר על הרגע המדויק ומשאיר הערה — טקסט, צילום מסך מסומן או הקלטה קולית. כל הערה צמודה לזמן שלה.',
    },
    {
      title: 'מעלים סבב',
      body: 'עוברים על ההערות לפי הזמן, מתקנים ומעלים סבב חדש. סבבים ישנים ננעלים כך שברור מה הגרסה העדכנית.',
    },
    {
      title: 'מוסרים סופי',
      body: 'כשהכול מאושר — שולחים את הגרסה הסופית בקישור מסירה עם תוקף וסיסמה. נקי ומקצועי.',
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
          <div className="label mb-5">— ארבעה צעדים</div>
          <h2
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              maxWidth: '720px',
              textWrap: 'balance',
            }}
          >
            ככה זה <span className="accent-word">עובד</span>
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 gap-x-14 gap-y-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-y-0">
          {steps.map((s, idx) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: Math.min(idx * 0.08, 0.32) }}
            >
              <div className="flex items-baseline gap-3">
                <span
                  className="tabular text-xs font-medium"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  0{idx + 1}
                </span>
                <h3 className="font-display text-xl text-fg">{s.title}</h3>
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

/* ── Capabilities — editorial spec list (em-dash bullets, no cards) ────── */
function CapabilityList() {
  const items = [
    'הערות צמודות-זמן — כל פידבק קופץ לרגע המדויק בסרטון',
    'צילומי מסך מסומנים והקלטות קוליות, לא רק טקסט',
    'סבבים מרובים עם נעילת גרסאות ישנות',
    'סימן מים עם המייל של הצופה על כל פריים',
    'נגן שמתחיל לרוץ מיד וזורם תוך כדי טעינה — גם לקבצים כבדים',
    'קישור מסירה עם תוקף 3 / 7 / 14 ימים וסיסמה אופציונלית',
    'הכול עובד בדפדפן — גם מהטלפון, בלי הרשמה ללקוח',
    'הקבצים נשמרים באחסון שלכם, תחת השליטה שלכם',
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
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              maxWidth: '760px',
              textWrap: 'balance',
            }}
          >
            פחות הלוך-ושוב, יותר <span className="accent-word">עריכה</span>
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
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0"
                style={{ color: 'var(--success)' }}
              />
              <span>{item}</span>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/* ── Final CTA ─────────────────────────────────────────────────────────── */
function FinalCta() {
  return (
    <section className="px-5 pb-24 pt-4 md:px-6 md:pb-32">
      <div className="mx-auto max-w-6xl border-t border-border pt-14 text-center md:pt-20">
        <h2
          className="font-display text-fg"
          style={{
            fontSize: 'clamp(30px, 5vw, 52px)',
            lineHeight: 1.08,
            letterSpacing: '-0.02em',
            textWrap: 'balance',
          }}
        >
          הלקוח הבא <span className="accent-word">יאהב את זה</span>
        </h2>
        <p
          className="mx-auto mt-5 max-w-2xl text-fg-secondary"
          style={{ fontSize: '17px', lineHeight: 1.6 }}
        >
          סבבי התיקונים והמסירה ללקוח הם חלק מ"ניהול הורדות פלוס" — מערכת ליוצרי
          תוכן ולעורכי וידאו.
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

export default CollabLandingPage
