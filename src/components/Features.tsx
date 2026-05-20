import { motion } from 'framer-motion'
import {
  FolderTree,
  Wand2,
  Sparkles,
  Youtube,
  ArrowRightLeft,
  Minimize2,
  FileText,
  Film,
  Power,
  RefreshCw,
  Shield,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

/**
 * Features section — editorial layout. Two intentional moves to
 * escape the AI-default vibe:
 *
 *   1. No multi-color gradient icon backgrounds. Every icon uses
 *      the same single accent stroke color. AI landings default to
 *      a different gradient per icon to "look colorful" — which
 *      reads as random and amateur. One color = one product.
 *
 *   2. Numbered items (01, 02, …) in tabular figures as a visual
 *      anchor. Number prefixes are a magazine/editorial convention
 *      that immediately separates this from the "card grid of
 *      generic icons" pattern.
 *
 * The 13-feature count is preserved — the product does that much
 * work and trimming it would misrepresent the app. We compensate
 * with a 2-column layout and plenty of vertical rhythm so it
 * scans rather than overwhelms.
 */

type FeatureDef = {
  // LucideIcon = the upstream type for any `lucide-react` icon
  // component. Using it directly lets us pass `strokeWidth`,
  // `style`, etc. without TS rejecting the prop shape (the icons
  // are forwardRef components and accept `string | number` for
  // stroke width — our own ad-hoc typing was too narrow).
  icon: LucideIcon
  title: string
  body: React.ReactNode
}

const FEATURES: FeatureDef[] = [
  {
    icon: FolderTree,
    title: 'מיון אוטומטי של הורדות',
    body: (
      <>
        <p>
          ברגע שמורידים קובץ למחשב, המערכת מזהה אותו, מבינה לאיזה סוג הוא שייך
          (וידאו, מוזיקה, תמונה, אפקט קולי, מסמך וכו') ומעבירה אותו אוטומטית
          לתיקייה המתאימה בפרויקט הפעיל. בלי לחשוב, בלי לגרור.
        </p>
        <p className="text-fg-muted">
          תיקייה ריקה שיוצרים ידנית בתיקיית ההורדות — נשארת במקום.
        </p>
      </>
    ),
  },
  {
    icon: Wand2,
    title: 'חוקי ניתוב מותאמים אישית',
    body: (
      <p>
        בהגדרות אפשר להוסיף, לערוך או למחוק חוקי ניתוב — להגדיר בדיוק איזו
        סיומת קובץ נכנסת לאיזו תיקייה. אם רוצים תיקייה ייעודית למסמכים,
        פונטים, או לכל דבר אחר — מוסיפים בלחיצה. המערכת מזהה קובץ? הקובץ עובר.
        ירד קובץ שלא מוגדר? הקובץ עובר ל-other (אפשר לכבות גם את זה ולהשאיר
        קבצים לא מסווגים במקום).
      </p>
    ),
  },
  {
    icon: Sparkles,
    title: 'זיהוי חכם של מוזיקה לעומת אפקטים',
    body: (
      <p>
        מערכת חכמה שמבחינה אוטומטית בין קובץ אודיו של מוזיקה לקובץ של אפקט
        קולי (SFX), גם אם הסיומת זהה. ככה ששירים נכנסים ל-Music ואפקטים ל-Sfx
        — בלי שצריך להגדיר שום דבר מיוחד.
      </p>
    ),
  },
  {
    icon: Youtube,
    title: 'הורדה מסרטוני וידאו',
    body: (
      <p>
        מדביקים קישור מיוטיוב ובוחרים: וידאו ב-MP4 (כולל בחירת איכות — 4K,
        1080p, 720p ועוד) או אודיו ב-MP3 בלבד. ההורדה רצה ברקע עם בר התקדמות
        חי, ואחר כך הקובץ מנותב אוטומטית לפרויקט הפעיל.
      </p>
    ),
  },
  {
    icon: ArrowRightLeft,
    title: 'המרת קבצים בין פורמטים',
    body: (
      <>
        <p>
          ארבעה סוגי המרה מובנים: <strong>אודיו</strong>{' '}
          (MP3 ↔ WAV ↔ FLAC ↔ M4A), <strong>תמונות</strong>{' '}
          (JPG ↔ PNG ↔ WebP ↔ HEIC), <strong>PDF לתמונות</strong> (כל עמוד
          הופך לתמונה), ו-<strong>וידאו</strong> (MP4 ↔ MOV ↔ MKV ↔ WebM).
        </p>
        <p className="text-fg-muted">
          גוררים קבצים, בוחרים פורמט יעד, לוחצים המרה. אפשר להמיר עשרות קבצים
          בבת אחת.
        </p>
      </>
    ),
  },
  {
    icon: Minimize2,
    title: 'דחיסת וידאו לגודל יעד',
    body: (
      <p>
        צריך להעלות סרטון לרשת חברתית עם הגבלת גודל? כותבים למערכת את הגודל
        המבוקש והיא עושה את זה אוטומטית — עם איכות אופטימלית למשקל היעד.
      </p>
    ),
  },
  {
    icon: FileText,
    title: 'בניית הצעות מחיר מקצועיות',
    body: (
      <p>
        מנהלים פרופיל מחירונים אישי, יוצרים הצעת מחיר חדשה תוך כמה לחיצות,
        ושומרים אותה כ-PDF מעוצב מוכן לשליחה ללקוח. תומך בהמרת מטבע חיה
        (USD, EUR, ILS) ועיגול לסכומים שלמים.
      </p>
    ),
  },
  {
    icon: Wallet,
    title: 'ניהול תשלומים והכנסות',
    body: (
      <>
        <p>
          כל ההכנסות במקום אחד — תשלום בודד, תשלומים בתשלומים, סכומים חלקיים
          שכבר התקבלו, ותוספות שנוספו תוך כדי הפרויקט. רואים בכל רגע כמה
          התקבל, כמה ממתין וכמה באיחור, מסומן בצבעים לפי סטטוס.
        </p>
        <p className="text-fg-muted">
          מספר מטבעות (₪ / $ / €), מעקב מע"מ ומעשר, התראות ללקוחות בוואטסאפ.
          כל המידע נשמר רק אצלך, מוצפן ונעול בסיסמה או טביעת אצבע.
        </p>
      </>
    ),
  },
  {
    icon: Film,
    title: 'אינטגרציה עם תוכנת עריכה',
    body: (
      <>
        <p>
          אפשר לחבר את התוכנה לעורך שלך (Premiere Pro, DaVinci Resolve, Final
          Cut). ברגע שמפעילים את העריכה, התוכנה עולה ברקע אוטומטית עם הניתוב
          פעיל — כך שכל קובץ שיורד תוך כדי עבודה ממוין מיד לפרויקט.
        </p>
        <p className="text-fg-muted">
          הפעלת את העריכה והניתוב כבוי? תקבל התראה.
        </p>
      </>
    ),
  },
  {
    icon: FolderTree,
    title: 'ניהול פרויקטים מרובים',
    body: (
      <p>
        יוצרים פרויקט חדש, בוחרים תיקיית בסיס, וכל הקבצים המנותבים נכנסים
        לתת-תיקיות תחתיו. מחליפים בין פרויקטים בלחיצה — הניתוב תמיד הולך
        לפעיל בלבד.
      </p>
    ),
  },
  {
    icon: Power,
    title: 'הפעלה אוטומטית בהדלקה',
    body: (
      <p>
        אפשר להגדיר שהתוכנה תעלה עם המחשב, כך שהיא מוכנה לנתב ברגע
        ההתחברות — בלי לפתוח חלון בעצמך.
      </p>
    ),
  },
  {
    icon: RefreshCw,
    title: 'עדכונים אוטומטיים',
    body: (
      <p>
        המערכת בודקת באופן אוטומטי אם יצא עדכון חדש ומציגה כפתור "עדכן עכשיו".
        בלחיצה אחת ההורדה מתחילה, ההתקנה מתקדמת מיד אחריה, ואז התוכנה
        המעודכנת נפתחת.
      </p>
    ),
  },
  {
    icon: Shield,
    title: 'אבטחה ופרטיות',
    body: (
      <p>
        כל הנתונים שלך (למעט מייל ושם) מאוחסנים אצלך בלבד. אין לנו גישה.
        הנתונים הרגישים מוצפנים מקומית ונעולים מאחורי סיסמה או טביעת אצבע.
      </p>
    ),
  },
]

export function Features() {
  return (
    <section id="features" className="relative px-6 py-24 md:py-32">
      <div className="mx-auto max-w-6xl">
        {/* Section header — editorial layout: label + serif heading
            with italic accent on a single keyword. The right-aligned
            heading + left-floated meta line mimics a magazine
            article opening spread. */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.45 }}
          className="mb-16 md:mb-20"
        >
          <div className="label mb-5">— הפיצ'רים</div>
          <h2
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(34px, 5vw, 60px)',
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              maxWidth: '720px',
            }}
          >
            כל מה שצריך כדי לעבוד{' '}
            <span className="italic-serif" style={{ color: 'var(--accent)' }}>
              מהר
            </span>
            , ולא לבזבז זמן על סידור.
          </h2>
        </motion.div>

        {/* Feature grid — 2 columns on desktop (more breathing room
            than the usual 3), single column on mobile. Items
            separated by a hair-line border for a print/editorial
            feel. */}
        <div className="grid grid-cols-1 gap-x-12 gap-y-10 md:grid-cols-2 md:gap-y-12">
          {FEATURES.map((f, idx) => (
            <FeatureItem key={f.title} feature={f} index={idx} />
          ))}
        </div>
      </div>
    </section>
  )
}

function FeatureItem({
  feature,
  index,
}: {
  feature: FeatureDef
  index: number
}) {
  const Icon = feature.icon
  // Numeric prefix with leading zero — tabular figures for vertical
  // alignment across rows. The "01.." prefix is the strongest
  // signal that something was intentionally designed rather than
  // dropped into a feature-grid template.
  const num = String(index + 1).padStart(2, '0')

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.03, 0.3) }}
      className="group"
    >
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span
            className="tabular text-xs font-medium"
            style={{ color: 'var(--fg-faint)' }}
          >
            {num}
          </span>
          <h3 className="font-display text-2xl text-fg">{feature.title}</h3>
        </div>
        {/* Icon — single accent color, thin stroke. Sits next to
            the title at baseline rather than being a focal element. */}
        <Icon
          className="h-4 w-4 shrink-0 transition-colors"
          strokeWidth={1.5}
          style={{ color: 'var(--fg-faint)' }}
        />
      </div>
      <div
        className="space-y-2.5 border-t border-border pt-4 text-[15px] leading-relaxed text-fg-secondary"
        style={{ lineHeight: 1.65 }}
      >
        {feature.body}
      </div>
    </motion.article>
  )
}
