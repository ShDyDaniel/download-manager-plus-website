import { Link } from 'react-router-dom'
import { Accessibility, ArrowRight } from 'lucide-react'

/**
 * הצהרת נגישות — accessibility statement page, required for Israeli
 * websites under the Equal Rights for Persons with Disabilities
 * regulations (תקנות שוויון זכויות לאנשים עם מוגבלות). Reachable from
 * the footer and from the accessibility widget.
 */
export default function AccessibilityStatementPage() {
  return (
    <div dir="rtl">
      {/* Back-to-home sits on the SiteHeader's max-w-6xl rail (not the
          narrower max-w-2xl article column), so its right edge reaches
          the same far-right position as the rest of the top chrome —
          mirroring the left-anchored "סבבי תיקונים · החשבון שלי" nav
          on the opposite side. */}
      <div className="mx-auto max-w-6xl px-5 pt-12 md:px-6 md:pt-[5.5rem]">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] text-fg-muted transition-colors hover:text-fg"
        >
          דף הבית
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 md:pb-24 md:pt-14">

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Accessibility className="h-5 w-5" />
        </span>
        <h1
          className="font-display text-fg"
          style={{ fontSize: 'clamp(26px,4vw,34px)', fontWeight: 500 }}
        >
          הצהרת נגישות
        </h1>
      </div>

      <div className="space-y-7 text-sm leading-relaxed text-fg-secondary">
        <Section title="המחויבות שלנו">
          אתר "ניהול הורדות פלוס" (dmplus.net) רואה חשיבות רבה במתן שירות
          שוויוני לכלל המשתמשים, ופועל להנגיש את האתר כך שיהיה נגיש גם
          לאנשים עם מוגבלות. אנו משקיעים מאמצים ומשאבים על מנת לאפשר
          גלישה נוחה ושוויונית ככל הניתן.
        </Section>

        <Section title="רמת הנגישות באתר">
          האתר הונגש בהתאם להוראות תקנות שוויון זכויות לאנשים עם מוגבלות
          (התאמות נגישות לשירות), התשע"ג–2013, ובכפוף לתקן הישראלי{' '}
          <strong className="text-fg">ת"י 5568</strong> המבוסס על הנחיות{' '}
          <strong className="text-fg">WCAG 2.0</strong> ברמה{' '}
          <strong className="text-fg">AA</strong>, ככל שניתן.
        </Section>

        <Section title="מה הונגש באתר">
          <ul className="list-disc space-y-1.5 pr-5">
            <li>תפריט נגישות צף הזמין מכל עמוד באתר.</li>
            <li>
              התאמות הניתנות להפעלה: הגדלת/הקטנת טקסט, ניגודיות גבוהה,
              היפוך צבעים, גווני אפור, הדגשת קישורים, גופן קריא, ריווח
              טקסט מוגדל, עצירת אנימציות, סמן עכבר גדול והדגשת מיקוד
              מקלדת.
            </li>
            <li>ניווט מלא באמצעות מקלדת וסדר טאבים הגיוני.</li>
            <li>מבנה כותרות סמנטי ותוויות לרכיבי הטופס.</li>
            <li>תאימות לקוראי מסך נפוצים.</li>
            <li>שמירת ההעדפות של המשתמש בין עמודים וביקורים.</li>
          </ul>
        </Section>

        <Section title="הסתייגות ומגבלות ידועות">
          למרות מאמצינו להנגיש את כלל הדפים והרכיבים, ייתכן שיימצאו חלקים
          שטרם הונגשו במלואם או שאינם נתמכים באופן מיטבי בכל הדפדפנים
          והטכנולוגיות המסייעות. אנו ממשיכים לפעול לשיפור הנגישות באופן
          שוטף.
        </Section>

        <Section title="פנייה בנושא נגישות">
          נתקלתם בבעיית נגישות, או שיש לכם הצעה לשיפור? נשמח לקבל פנייה בכתובת{' '}
          <a
            href="mailto:help.dm.plus@gmail.com"
            className="text-primary hover:underline"
            dir="ltr"
          >
            help.dm.plus@gmail.com
          </a>{' '}
          — ונטפל בה בהקדם.
        </Section>

        <p className="border-t border-border/60 pt-6 text-xs text-fg-muted">
          הצהרת הנגישות עודכנה לאחרונה ביוני 2026.
        </p>
      </div>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-fg">{title}</h2>
      <div>{children}</div>
    </section>
  )
}
