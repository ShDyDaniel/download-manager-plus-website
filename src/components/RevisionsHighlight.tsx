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
    body: 'מעלים את הסרטון — מהמחשב או ישירות מ-Google Drive שלכם.',
  },
  {
    num: '02',
    title: 'משתפים את הקישור',
    body: 'שולחים קישור לצפייה. הלקוחות יוכלו לצפות בסרטון, יש בעיה בסרטון? עוצרים את הסרטון ולוחצים על הכפתור ‘’הוספת תיקון’’ הזמן של התיקון יכנס אוטומטית + אופציה לצלם ולסמן את התיקון שרוצים ככה שהכל מסודר וברור',
  },
  {
    num: '03',
    title: 'מקבלים את כל התיקונים',
    body: 'ההערות מופיעות אצלכם אוטומטית, מסודרות לפי סבב. עם אופציה לסמן איזה תוקן הושלם ואיזה לא, הלקוחות יראו אצלם ישר את תהליך התיקונים',
  },
  {
    num: '04',
    title: 'מוסרים ללקוח',
    body: 'כשהגרסה מאושרת — שולחים את הקובץ הסופי בקישור מאובטח עם תוקף מוגבל (3 / 7 / 14 ימים). הלקוח מוריד ישירות, בלי קבצים כבדים במייל ובלי תוכנות נוספות.',
  },
]

type Stat = { stat: string; label: string }

const STATS: Stat[] = [
  { stat: '100GB', label: 'נפח אחסון לסבבי התיקונים ולמסירות' },
  { stat: '4K', label: 'תמיכה בסרטונים באיכות גבוהה' },
  { stat: 'ללא הגבלה', label: 'מספר הפרויקטים שתוכלו לפתוח' },
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
              maxWidth: '820px',
            }}
          >
מערכות סבבי תיקונים ומסירה <span className="accent-word">מלאות</span>
          </h2>

          <p
            className="mt-6 max-w-2xl text-fg-secondary"
            style={{ fontSize: '17px', lineHeight: 1.6 }}
          >
            כל תהליך העבודה מול הלקוח במקום אחד — שולחים קישור ביקורת, הלקוח
            מסמן הערות ותיקונים, והכל חוזר אליכם מסודר. ובסיום — מוסרים את
            הקובץ הסופי בקישור מאובטח עם תוקף מוגבל.
          </p>
        </motion.div>

        {/* 4-step flow: 3 revision steps + the final delivery step */}
        <div className="grid grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-2 md:gap-y-12">
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

        {/* Capability stats — what the plan actually includes for the
            revisions system. Mirrors the steps' hair-line style so it
            reads as one section: big accent figure + a short label. */}
        <div className="mt-14 grid grid-cols-1 gap-x-16 gap-y-8 sm:grid-cols-3 sm:gap-y-0 md:mt-24">
          {STATS.map((s, idx) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: Math.min(idx * 0.08, 0.24) }}
            >
              <div className="border-t border-border pt-5">
                <div className="font-display text-3xl text-fg md:text-4xl">
                  <span className="accent-word">
                    {/* <bdi> defaults to dir="auto": "100GB"/"4K" render
                        LTR, "ללא הגבלה" stays RTL — each correct. */}
                    <bdi>{s.stat}</bdi>
                  </span>
                </div>
                <div
                  className="mt-2 text-[15px] text-fg-secondary"
                  style={{ lineHeight: 1.6 }}
                >
                  {s.label}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
