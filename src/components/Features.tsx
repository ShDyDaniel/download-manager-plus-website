import { motion } from 'framer-motion'

/**
 * Features — grouped spec sheet. Replaces the 13-card grid of
 * multi-paragraph descriptions with four categorized columns,
 * each item a single short line.
 *
 * The previous version paid for every feature with three or four
 * sentences of body copy — useful detail, but on the landing page
 * it created a wall of text that the eye bounces off. An editorial
 * spec sheet does the same job in roughly a tenth of the words:
 * the reader scans the categories, sees the breadth at a glance,
 * and downloads when convinced. Anyone who needs the explanation
 * either expands a help doc or opens the app.
 *
 * Categories are intentional buckets, not just visual grouping:
 *   01. Organization — the core workflow promise
 *   02. Downloads & conversion — the heavy media tools
 *   03. Business tools — the professional-grade extras
 *   04. System — the always-on background machinery
 */

type Category = {
  num: string
  title: string
  items: string[]
}

const CATEGORIES: Category[] = [
  {
    num: '01',
    title: 'סידור אוטומטי',
    items: [
      'מיון הורדות לפי קטגוריה (מוזיקה, וידאו, אודיו, תמונות ועוד)',
      'חוקי ניתוב מותאמים אישית',
      'זיהוי חכם בין מוזיקה לסאונד אפקטים',
      'עבודה על מספר פרוייקטים — החלפה בלחיצה',
      'אינטגרציה עם תוכנות העריכה שלכם',
    ],
  },
  {
    num: '02',
    title: 'הורדה והמרה',
    items: [
      'הורדת סרטונים וסאונד בקלות ובמהירות',
      'בחירת איכות וידאו (4K · 1080p · 720p)',
      'המרה בין פורמטי אודיו, תמונה, וידאו ו־PDF',
      'דחיסת וידאו לגודל יעד מדויק',
    ],
  },
  {
    num: '03',
    title: 'ניהול עסקי',
    items: [
      'בניית הצעות מחיר מקצועיות וייצאו שלהם במספר פורמטים שונים',
      'מחירון אישי עם המרת מטבע חיה (₪ · $ · €)',
    ],
  },
  {
    num: '04',
    title: 'עבודה מול לקוחות',
    items: [
      'סבבי תיקונים — שליחת קישור ביקורת ללקוח עם הערות ממוקדות־זמן',
      'מסירה ללקוח — שליחת הקובץ הסופי בקישור מאובטח עם תוקף מוגבל',
    ],
  },
]

export function Features() {
  return (
    <section id="features" className="relative px-5 py-16 md:px-6 md:py-32">
      <div className="mx-auto max-w-6xl">
        {/* Section header — same editorial pattern: label + display
            heading with one accent-color word (weight + warm color
            instead of italic, which doesn't work on Hebrew). */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-10 md:mb-20"
        >
          <div className="label mb-5">— מה התוכנה עושה</div>
          <h2
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              maxWidth: '720px',
            }}
          >
            כלים שעובדים -{' '}
            <span className="accent-word">
              עבורך
            </span>
            .
          </h2>
        </motion.div>

        {/* Spec sheet — 2 columns on desktop, single on mobile. Each
            category is its own block with a numeric prefix and a
            hair-line under the title. Items below are bullet-free
            (the hyphen prefix is enough to denote a list — bullet
            dots are an AI-default tell). Smaller gap-y on mobile
            keeps the four categories scannable without scrolling. */}
        <div className="grid grid-cols-1 gap-x-16 gap-y-10 md:grid-cols-2 md:gap-y-14">
          {CATEGORIES.map((cat, idx) => (
            <CategoryBlock key={cat.num} category={cat} index={idx} />
          ))}
        </div>
      </div>
    </section>
  )
}

function CategoryBlock({
  category,
  index,
}: {
  category: Category
  index: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.06, 0.24) }}
    >
      <div className="flex items-baseline gap-3">
        <span
          className="tabular text-xs font-medium"
          style={{ color: 'var(--fg-faint)' }}
        >
          {category.num}
        </span>
        <h3 className="font-display text-2xl text-fg">{category.title}</h3>
      </div>
      <div className="mt-5 border-t border-border pt-5">
        <ul className="space-y-3">
          {category.items.map((item) => (
            <li
              key={item}
              className="flex items-baseline gap-3 text-[15px] text-fg-secondary"
              style={{ lineHeight: 1.55 }}
            >
              {/* The em-dash is the bullet. Tinted to the accent so
                  it threads the warm color across the whole sheet
                  without needing a colored dot per row. */}
              <span
                aria-hidden
                className="shrink-0 select-none"
                style={{ color: 'var(--accent)' }}
              >
                —
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </motion.div>
  )
}
