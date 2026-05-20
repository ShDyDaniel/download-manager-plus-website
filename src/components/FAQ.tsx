import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus } from 'lucide-react'

/**
 * FAQ — magazine-style accordion. Hair-line dividers between items
 * (no card backgrounds), plus icon that rotates 45° to a × on open
 * instead of the chevron-flip that every AI landing uses. Question
 * text in serif at a larger size than usual so it reads like a
 * publication's Q&A column.
 */

const QA: { q: string; a: string }[] = [
  {
    q: 'התוכנה עובדת על Mac ו-Windows?',
    a: 'כן, בשניהם — באופן מלא.',
  },
  {
    q: 'התוכנה חינם?',
    a: 'יש גרסה חינמית מלאה. דחיסת וידאו והורדות MP4 באיכות גבוהה דורשות מנוי Pro.',
  },
  {
    q: 'איך התוכנה יודעת לאן להעביר כל קובץ?',
    a: 'מערכת חוקי ניתוב מובנית לפי סיומת — אפשר לערוך הכל בהגדרות.',
  },
  {
    q: 'מה קורה אם אצור תיקייה ריקה בתיקיית ההורדות?',
    a: 'תיקיות ריקות לא נוגעים בהן. רק קבצים מנותבים.',
  },
  {
    q: 'האם הנתונים שלי נשמרים בענן?',
    a: 'לא. רק פרטי החשבון (מייל ושם) נשמרים בענן. כל השאר — אצלך מקומית בלבד.',
  },
  {
    q: 'אפשר להשתמש באותו חשבון בכמה מחשבים?',
    a: 'לא — חשבון אחד למחשב אחד. החלפת מחשב? פנה לתמיכה לשחרור הנעילה.',
  },
  {
    q: 'איך מקבלים עדכונים?',
    a: 'התוכנה בודקת אוטומטית בכל הפעלה. כשיש עדכון — כפתור "עדכן עכשיו" מופיע, ובלחיצה אחת זה רץ.',
  },
  {
    q: 'מה האינטגרציה עם תוכנת עריכה עושה?',
    a: 'ברגע שפותחים את Premiere / DaVinci / Final Cut — התוכנה עולה ברקע אוטומטית עם הניתוב פעיל.',
  },
]

export function FAQ() {
  // First question open by default — gives the section visual
  // density on first render so it doesn't read as "nothing here".
  const [openIdx, setOpenIdx] = useState<number | null>(0)

  return (
    <section className="relative border-t border-border px-6 py-24 md:py-32">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-12"
        >
          <div className="label mb-5">— שאלות נפוצות</div>
          <h2
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
            }}
          >
            עוד משהו{' '}
            <span className="italic-serif" style={{ color: 'var(--accent)' }}>
              שתרצה לדעת
            </span>
            ?
          </h2>
        </motion.div>

        <div className="border-t border-border">
          {QA.map((item, idx) => {
            const open = openIdx === idx
            return (
              <motion.div
                key={item.q}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ duration: 0.3, delay: Math.min(idx * 0.03, 0.2) }}
                className="border-b border-border"
              >
                <button
                  onClick={() => setOpenIdx(open ? null : idx)}
                  className="flex w-full items-center justify-between gap-4 py-6 text-right transition-colors hover:opacity-80"
                  aria-expanded={open}
                >
                  <span
                    className="font-display text-fg"
                    style={{
                      fontSize: '20px',
                      lineHeight: 1.3,
                    }}
                  >
                    {item.q}
                  </span>
                  {/* Plus that rotates to × on open. The rotation is
                      a subtle alternative to the chevron-flip that
                      every framework component uses. */}
                  <Plus
                    className={`h-5 w-5 shrink-0 transition-transform duration-300 ${
                      open ? 'rotate-45' : ''
                    }`}
                    strokeWidth={1.5}
                    style={{ color: 'var(--primary)' }}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <p
                        className="pb-6 text-[15px] text-fg-secondary md:text-base"
                        style={{ lineHeight: 1.7, maxWidth: '60ch' }}
                      >
                        {item.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
