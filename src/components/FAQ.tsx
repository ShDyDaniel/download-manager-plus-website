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
    a: 'כן, בשניהם, באופן מלא.',
  },
  {
    q: 'התוכנה חינם?',
    a: 'יש גרסה חינמית חלקית. שימוש בכל הפיצרים של התוכנה דורשות מנוי Pro.',
  },
  {
    q: 'איך התוכנה יודעת לאן להעביר כל קובץ?',
    a: 'מערכת חוקי ניתוב מובנית לפי סיומת. אפשר לערוך הכל בהגדרות.',
  },
  {
    q: 'מה קורה אם אצור תיקייה ריקה בתיקיית ההורדות?',
    a: 'יצרת תיקיה ריקה בתיקית ההורדות? המערכת לא תיגע בה.',
  },
  {
    q: 'האם הנתונים שלי נשמרים בענן?',
    a: 'רוב העבודה אצלך מקומית: ההורדות, המיון, ההמרה ונתוני התשלומים נשמרים במחשב שלך בלבד. בשרתים שלנו נשמרים פרטי החשבון ונתוני שימוש לשיפור התוכנה (כמפורט בתנאי השימוש). היוצא מן הכלל: אם אתם משתמשים ב"סבבי תיקונים" או "מסירה ללקוח", הסרטונים מאוחסנים מאובטח בענן שלנו כדי לאפשר את קישורי השיתוף ללקוח.',
  },
  {
    q: 'אפשר להשתמש באותו חשבון בכמה מחשבים?',
    a: 'לא. חשבון אחד למחשב אחד. החלפת מחשב? פנה לתמיכה לשחרור הנעילה.',
  },
  {
    q: 'איך מקבלים עדכונים?',
    a: 'התוכנה בודקת אוטומטית אם יצא עדכון בכל הפעלה. כשיש עדכון המערכת תתריע על זה וכפתור "עדכן עכשיו" יהיה זמין, בלחיצה עליו התוכנה תעודכן לגירסה האחרונה.',
  },
  {
    q: 'מה האינטגרציה עם תוכנת עריכה עושה?',
    a: 'ברגע שפותחים את Premiere / DaVinci / Final Cut (או כל תוכנה אחרת שתוגדר), התוכנה תעלה אוטומטית כדי שכל הקבצים שתורידו ימויינו כמו שצריך.',
  },
]

export function FAQ() {
  // All questions collapsed by default. Earlier this defaulted to
  // openIdx=0 so the first row would expand on render for visual
  // density, but the user found the auto-open distracting on a
  // page that already has a lot going on above the fold. Starting
  // closed lets the user pick what they want to read.
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  return (
    <section className="relative border-t border-border px-5 py-16 md:px-6 md:py-32">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-8 md:mb-12"
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
            <span className="accent-word">
              שתרצו לדעת
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
