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
} from 'lucide-react'

type FeatureDef = {
  icon: React.ComponentType<{ className?: string }>
  title: string
  hue: string
  body: React.ReactNode
}

const FEATURES: FeatureDef[] = [
  {
    icon: FolderTree,
    title: 'מיון אוטומטי של הורדות',
    hue: 'from-violet-500 to-indigo-500',
    body: (
      <>
        <p>
          ברגע שמורידים קובץ למחשב, המערכת מזהה אותו, מבינה לאיזה סוג הוא שייך
          (וידאו, מוזיקה, תמונה, אפקט קולי, מסמך וכו') ומעבירה אותו אוטומטית
          לתיקייה המתאימה בפרויקט הפעיל. בלי לחשוב, בלי לגרור.
        </p>
        <p className="text-white/60">
          תיקייה ריקה שיוצרים ידנית בתיקיית ההורדות — נשארת במקום.
        </p>
      </>
    ),
  },
  {
    icon: Wand2,
    title: 'חוקי ניתוב מותאמים אישית',
    hue: 'from-amber-500 to-orange-500',
    body: (
      <p>
        בהגדרות אפשר להוסיף, לערוך או למחוק חוקי ניתוב — להגדיר בדיוק איזו
        סיומת קובץ נכנסת לאיזו תיקייה. אם רוצים תיקייה ייעודית למסמכים,
        פונטים, או לכל דבר אחר — מוסיפים בלחיצה. המערכת מזהה קובץ? הקובץ עובר.
        ירד קובץ שלא מוגדר? הקובץ עובר ל"other" (אפשר לכבות גם את זה ולהשאיר קבצים
        לא מסווגים במקום).
      </p>
    ),
  },
  {
    icon: Sparkles,
    title: 'זיהוי חכם של מוזיקה לעומת אפקטים',
    hue: 'from-fuchsia-500 to-rose-500',
    body: (
      <p>
        מערכת חכמה שמבחינה אוטומטית בין קובץ אודיו של מוזיקה לקובץ של
        אפקט קולי (SFX), גם אם הסיומת זהה. ככה ששירים נכנסים ל-Music ואפקטים
        ל-Sfx — בלי שצריך להגדיר שום דבר מיוחד.
      </p>
    ),
  },
  {
    icon: Youtube,
    title: 'הורדה מסרטוני וידאו',
    hue: 'from-rose-500 to-red-600',
    body: (
      <p>
        מדביקים קישור מיוטיוב ובוחרים: וידאו ב-MP4 (כולל בחירת איכות
        — 4K, 1080p, 720p ועוד) או אודיו ב-MP3 בלבד. ההורדה רצה ברקע עם בר
        התקדמות חי, ואחר כך הקובץ מנותב אוטומטית לפרויקט הפעיל.
      </p>
    ),
  },
  {
    icon: ArrowRightLeft,
    title: 'המרת קבצים בין פורמטים',
    hue: 'from-cyan-500 to-blue-600',
    body: (
      <>
        <p>
          ארבעה סוגי המרה מובנים: <strong>אודיו</strong> (MP3 ↔ WAV ↔ FLAC ↔ M4A),
          <strong> תמונות</strong> (JPG ↔ PNG ↔ WebP ↔ HEIC ועוד),
          <strong> PDF לתמונות</strong> (כל עמוד הופך לתמונה), ו-
          <strong>וידאו</strong> (MP4 ↔ MOV ↔ MKV ↔ WebM וכל שילוב).
        </p>
        <p className="text-white/60">
          גוררים קבצים, בוחרים פורמט יעד, לוחצים המרה. אפשר להמיר עשרות
          קבצים בבת אחת.
        </p>
      </>
    ),
  },
  {
    icon: Minimize2,
    title: 'דחיסת וידאו לגודל יעד',
    hue: 'from-emerald-500 to-teal-600',
    body: (
      <p>
        צריך להעלות סרטון לרשת חברתית עם הגבלת גודל? אין בעיה! כותבים למערכת את הגודל המבוקש והיא עושה את זה אוטומטית — עם איכות אופטימלית
      </p>
    ),
  },
  {
    icon: FileText,
    title: 'בניית הצעות מחיר מקצועיות',
    hue: 'from-indigo-500 to-purple-600',
    body: (
      <p>
        מנהלים פרופיל מחירונים אישי , יוצרים הצעת
        מחיר חדשה תוך כמה לחיצות, ושומרים אותה כ-PDF מעוצב מוכן לשליחה
        ללקוח. תומך בהמרת מטבע חיה (USD, EUR, ILS וכו') ועיגול לסכומים שלמים.
      </p>
    ),
  },
  {
    icon: Wallet,
    title: 'ניהול תשלומים והכנסות',
    hue: 'from-green-500 to-emerald-600',
    body: (
      <>
        <p>
          כל ההכנסות במקום אחד — תשלום בודד, תשלומים בתשלומים, סכומים חלקיים
          שכבר התקבלו, ותוספות שנוספו תוך כדי הפרויקט. רואים בכל רגע כמה
          התקבל, כמה ממתין וכמה באיחור, מסומן בצבעים לפי סטטוס.
        </p>
        <p className="text-white/60">
          תומך במספר מטבעות (₪ / $ / €), מעקב מע"מ ומעשר אוטומטי, התראות
          ללקוחות בוואטסאפ ישירות מהאפליקציה. כל המידע נשמר רק אצלך, מוצפן
          ונעול בסיסמה או טביעת אצבע.
        </p>
      </>
    ),
  },
  {
    icon: Film,
    title: 'אינטגרציה עם תוכנת עריכה',
    hue: 'from-pink-500 to-fuchsia-600',
    body: (
      <>
        <p>
          אפשר לחבר את תוכנת העריכה שלך לאפליקציית (Premiere Pro, DaVinci
          Resolve, Final Cut וכו'). ברגע שמפעילים את תוכנת העריכה, התוכנה
          שלנו עולה ברקע אוטומטית עם הניתוב פעיל — כך שכל קובץ שמוריד תוך כדי
          עבודה ממוין מיד לפרויקט.
        </p>
        <p className="text-white/60">
          הפעלת את תוכנת העריכה והגדרת את התוכנה על מצב ׳׳כבוי׳׳? אל תדאג המערכת תתריאה לך על זה
        </p>
      </>
    ),
  },
  {
    icon: FolderTree,
    title: 'ניהול פרויקטים מרובים',
    hue: 'from-amber-500 to-rose-500',
    body: (
      <p>
        יוצרים פרויקט חדש, בוחרים את תיקיית הפרוייקט, וכל הקבצים המנותבים
        ייכנסו לתת-תיקיות תחתיו. אפשר להחליף בין פרויקטים בלחיצה — הניתוב
        תמיד הולך לפרויקט הפעיל בלבד.
      </p>
    ),
  },
  {
    icon: Power,
    title: 'הפעלה אוטומטית בהדלקת המחשב',
    hue: 'from-sky-500 to-cyan-600',
    body: (
      <p>
        אפשר להגדיר שהתוכנה תיפתח בכל פעם שמדליקים את המחשב, ככה שהיא תהיה מוכנה להורדות כדי
        לנתב אותן בלי לפתוח את החלון בעצמך.
      </p>
    ),
  },
  {
    icon: RefreshCw,
    title: 'עדכונים אוטומטיים',
    hue: 'from-violet-500 to-purple-600',
    body: (
      <p>
        המערכת בודקת באופן אוטומטי אם יצא עדכון חדש ומראה לך כפתור "עדכן
        עכשיו" — בלחיצה אחת ההורדה מתחילה, תהליך ההתקנה יפתח מיד אחרי,
        בסיום ההתקנה תוכלו להיכנס לתוכנה המעודכנת.
      </p>
    ),
  },
  {
    icon: Shield,
    title: 'אבטחה ופרטיות',
    hue: 'from-teal-500 to-emerald-600',
    body: (
      <p>
        כל הנתונים שאתם מכניסים (למעט מייל ושם) מאוחסנים אצלכם בלבד, אין לנו גישה אליהם
      </p>
    ),
  },
]

export function Features() {
  return (
    <section id="features" className="px-6 pb-20">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
          className="mb-12 text-center"
        >
          <h2 className="text-3xl font-bold gradient-text md:text-4xl">
            כל מה שצריך כדי לייעל את העבודה שלך
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-white/60 md:text-base">
            מה יש לנו במערכת בעצם?
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, idx) => {
            const Icon = f.icon
            return (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ duration: 0.35, delay: idx * 0.03 }}
                className="glass relative overflow-hidden rounded-2xl p-5 transition-all hover:bg-white/[0.04]"
              >
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${f.hue} shadow-lg`}
                  >
                    <Icon className="h-5 w-5 text-white" />
                  </div>
                  <h3 className="text-base font-semibold">{f.title}</h3>
                </div>
                <div className="space-y-2 text-sm leading-relaxed text-white/85">
                  {f.body}
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
