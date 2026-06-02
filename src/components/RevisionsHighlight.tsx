import { motion } from 'framer-motion'

/**
 * RevisionsHighlight — a feature spotlight for the new "סבבי תיקונים"
 * (client revision rounds) system. Sits directly above the Features
 * spec sheet and mirrors its editorial language (label → display
 * heading with one accent word, em-dash lists, hair-line rules) so it
 * reads as part of the same page — but leads with a "חדש!" badge to
 * draw the eye to the new capability.
 */

type Step = { num: string; title: string; body: string }

const STEPS: Step[] = [
  {
    num: '01',
    title: 'מעלים סבב',
    body: 'מעלים את העריכה — מהמחשב או ישירות מ-Google Drive. בלי WeTransfer, בלי קבצים כבדים במייל.',
  },
  {
    num: '02',
    title: 'משתפים קישור',
    body: 'שולחים ללקוח קישור לצפייה. הוא מסמן הערות על נקודות זמן מדויקות בסרטון — בלי להתקין כלום.',
  },
  {
    num: '03',
    title: 'מקבלים הערות',
    body: 'ההערות מופיעות אצלכם אוטומטית, מסודרות לפי סבב. מתקנים, מעלים סבב חדש, וסוגרים את הפרויקט.',
  },
]

export function RevisionsHighlight() {
  return (
    <section className="relative px-5 pt-16 md:px-6 md:pt-32">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-10 md:mb-16"
        >
          {/* Label + "new" badge */}
          <div className="mb-5 flex items-center gap-3">
            <span className="label">— חדש במערכת</span>
            <motion.span
              initial={{ scale: 0.9, opacity: 0 }}
              whileInView={{ scale: 1, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.3, delay: 0.1 }}
              className="inline-flex items-center rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-bold tracking-wide text-bg shadow-lg shadow-primary/30"
            >
              חדש!
            </motion.span>
          </div>

          <h2
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              maxWidth: '760px',
            }}
          >
            סבבי תיקונים <span className="accent-word">עם הלקוחות</span>.
          </h2>

          <p
            className="mt-6 max-w-2xl text-fg-secondary"
            style={{ fontSize: '17px', lineHeight: 1.6 }}
          >
            כל תהליך התיקונים מול הלקוח במקום אחד — שולחים קישור לצפייה,
            הלקוח מסמן הערות לפי דקה ושנייה, וההערות חוזרות אליכם מסודרות.
            הכל דרך ה-Google Drive שלכם, בלי עלות אחסון.
          </p>
        </motion.div>

        {/* 3-step flow */}
        <div className="grid grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-3 md:gap-y-0">
          {STEPS.map((step, idx) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: Math.min(idx * 0.08, 0.24) }}
            >
              <div className="flex items-baseline gap-3">
                <span
                  className="tabular text-xs font-medium"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  {step.num}
                </span>
                <h3 className="font-display text-2xl text-fg">{step.title}</h3>
              </div>
              <div className="mt-5 border-t border-border pt-5">
                <p
                  className="text-[15px] text-fg-secondary"
                  style={{ lineHeight: 1.6 }}
                >
                  {step.body}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
