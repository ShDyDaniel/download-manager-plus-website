import { motion } from 'framer-motion'

/**
 * QuickStart — editorial timeline. Replaces the 2x2 card grid with
 * a vertical numbered list. Each step is a horizontal row with the
 * step number large and serifed on the left (visually anchoring
 * the eye to the sequence), and the explanation on the right.
 *
 * Why vertical instead of grid: a 4-step onboarding IS a sequence,
 * and a grid hides the sequence by suggesting "pick any". A
 * numbered vertical list is the honest representation. It also
 * gives each step room to breathe and reads more like a magazine
 * "How to" sidebar than a SaaS landing page.
 */

const STEPS = [
  {
    title: 'יצירת פרויקט',
    body: 'בוחרים תיקיית בסיס לפרויקט.',
  },
  {
    title: 'הגדרה כפעיל',
    body: 'מעכשיו כל הורדה חדשה תנותב אוטומטית לתיקייה הזו.',
  },
  {
    title: 'התאמת חוקים',
    body: 'חוקי הניתוב מוכנים מראש. שינוי או הוספה — בהגדרות.',
  },
  {
    title: 'הורדה ראשונה',
    body: 'תורידו קובץ. הוא יגיע למקום הנכון לבד.',
  },
]

export function QuickStart() {
  return (
    <section className="relative border-t border-border px-6 py-24 md:py-32">
      <div className="mx-auto max-w-4xl">
        {/* Section header — same editorial pattern as Features. */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-16"
        >
          <div className="label mb-5">— איך מתחילים</div>
          <h2
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              maxWidth: '640px',
            }}
          >
            פחות מ
            <span className="accent-word">
              ־30 שניות
            </span>{' '}
            מהרגע שהתקנת.
          </h2>
        </motion.div>

        {/* Timeline — vertical list, numeric anchor on the right
            (RTL means visual-right = first child in DOM). The
            border between steps is a hair-line, not a card edge,
            keeping the editorial feel. */}
        <div className="space-y-0">
          {STEPS.map((s, i) => (
            <Step
              key={s.title}
              num={i + 1}
              title={s.title}
              body={s.body}
              isLast={i === STEPS.length - 1}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function Step({
  num,
  title,
  body,
  isLast,
}: {
  num: number
  title: string
  body: string
  isLast: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, delay: Math.min((num - 1) * 0.06, 0.24) }}
      className={`flex items-baseline gap-6 py-8 md:gap-10 md:py-10 ${
        isLast ? '' : 'border-b border-border'
      }`}
    >
      {/* Number — serif, large, muted color so it anchors the row
          without competing with the step title. Tabular figures
          keep "01" and "10" the same visual width. */}
      <span
        className="font-display tabular shrink-0"
        style={{
          fontSize: 'clamp(40px, 5vw, 72px)',
          lineHeight: 1,
          color: 'var(--primary)',
          fontFeatureSettings: '"tnum"',
        }}
      >
        {String(num).padStart(2, '0')}
      </span>

      {/* Content column — title in serif, body in Inter. The serif
          step title at 2xl size matches the rhythm of the Features
          rows so the page reads as one document. */}
      <div className="flex-1">
        <h3 className="font-display text-2xl text-fg md:text-3xl">{title}</h3>
        <p
          className="mt-2 text-[15px] text-fg-secondary md:text-base"
          style={{ lineHeight: 1.65 }}
        >
          {body}
        </p>
      </div>
    </motion.div>
  )
}
