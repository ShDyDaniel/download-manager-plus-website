import { motion } from 'framer-motion'

const STEPS = [
  {
    title: 'יצירת פרויקט',
    body: 'בלחיצה על "הוסף פרויקט" בחר תיקייה ראשית בדיסק שלך (למשל "פרויקט-קיץ-2026").',
  },
  {
    title: 'בחרו את הפרוייקט',
    body: 'כל הקבצים שיגיעו לתיקיית ההורדות מעכשיו ינותבו לתיקיית הפרוייקט אוטומטית.',
  },
  {
    title: 'בדקו את החוקים',
    body: 'בכרטיסיית ההגדרות אפשר לראות איזה קובץ הולך לאיזו תיקייה. אפשר לשנות לפי הצורך.',
  },
  {
    title: 'תורידו משהו',
    body: 'תורידו קובץ כרגיל (דפדפן, יוטיוב, כל מקור) — תראו אותו עובר לתיקייה המתאימה אוטומטית בתוך שניות.',
  },
]

export function QuickStart() {
  return (
    <section className="px-6 pb-20">
      <div className="mx-auto max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
          className="mb-10 text-center"
        >
          <h2 className="text-3xl font-bold gradient-text md:text-4xl">
            איך מתחילים תוך 30 שניות
          </h2>
          <p className="mt-3 text-sm text-white/60">
            לא צריך הגדרות מורכבות, לא צריך הרשמה ארוכה.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.35, delay: i * 0.07 }}
              className="glass relative rounded-2xl p-5"
            >
              <div className="mb-2 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white">
                  {i + 1}
                </div>
                <h3 className="text-base font-semibold">{s.title}</h3>
              </div>
              <p className="text-sm leading-relaxed text-white/80">{s.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
