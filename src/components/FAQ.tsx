import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

const QA: { q: string; a: string }[] = [
  {
    q: 'התוכנה עובדת על Mac ו-Windows?',
    a: 'כן, המערכת תומכת בווינדוס ובמק באופן מלא',
  },
  {
    q: 'התוכנה חינם?',
    a: 'כן, יש גרסה חינמית מלאה. חלק מהתכונות המתקדמות (כמו דחיסת וידאו והורדה ב-MP4 איכותי) זמינים לבעלי מנוי Pro.',
  },
  {
    q: 'איך התוכנה יודעת לאן להעביר כל קובץ?',
    a: 'יש מערכת חוקי ניתוב מובנית: כל סיומת קובץ מנותבת לתיקייה לפי הקטגוריה שלה (וידאו, מוזיקה, תמונה וכו\'). אפשר להוסיף או לשנות את החוקים בהגדרות.',
  },
  {
    q: 'מה קורה אם אני יוצר תיקייה ריקה בתיקיית ההורדות?',
    a: 'התוכנה מזהה שהיא ריקה ולא נוגעת בה. רק תיקיות עם תוכן מנוטבות לפרויקט.',
  },
  {
    q: 'האם הנתונים שלי נשמרים בענן?',
    a: 'הגדרות הניתוב, רשימת הפרויקטים שלך והקבצים שמועברים אצלך בלבד. רק פרטי החשבון (מייל, שם, סטטוס מנוי) מאוחסנים בענן לצורך אימות.',
  },
  {
    q: 'אפשר להשתמש באותו חשבון בכמה מחשבים?',
    a: 'לא — חשבון אחד נעול למחשב אחד. אם החלפת מחשב, צור קשר עם תמיכה לשחרור הנעילה.',
  },
  {
    q: 'איך מקבלים עדכונים?',
    a: 'התוכנה בודקת אוטומטית בכל הפעלה אם יצא עדכון. כשיש עדכון, מופיע כפתור "עדכן עכשיו" — בלחיצה אחת ההורדה מתחילה וההתקנה נפתחת.',
  },
  {
    q: 'מה בדיוק עושה האינטגרציה עם תוכנת עריכה?',
    a: 'אם אתה מגדיר את התוכנה לעבוד עם Premiere/DaVinci/Final Cut, ברגע שתפתח את העורך — התוכנה שלנו עולה ברקע אוטומטית. כך שכל קובץ שתוריד תוך כדי עבודה יישלח ישירות לפרויקט.',
  },
]

export function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0)
  return (
    <section className="px-6 pb-20">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
          className="mb-10 text-center"
        >
          <h2 className="text-3xl font-bold gradient-text md:text-4xl">
            שאלות נפוצות
          </h2>
        </motion.div>

        <div className="space-y-2">
          {QA.map((item, idx) => {
            const open = openIdx === idx
            return (
              <motion.div
                key={item.q}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ duration: 0.3, delay: idx * 0.04 }}
                className="glass overflow-hidden rounded-xl"
              >
                <button
                  onClick={() => setOpenIdx(open ? null : idx)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-4 text-right transition-colors hover:bg-white/[0.02]"
                >
                  <span className="font-medium">{item.q}</span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-white/50 transition-transform ${
                      open ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="overflow-hidden"
                    >
                      <div className="px-5 pb-4 text-sm leading-relaxed text-white/75">
                        {item.a}
                      </div>
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
