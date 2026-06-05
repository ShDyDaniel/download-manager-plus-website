import { useEffect, useState } from 'react'
import { Accessibility, Loader2 } from 'lucide-react'

/**
 * הצהרת נגישות — accessibility statement, required for Israeli websites
 * under the Equal Rights for Persons with Disabilities regulations
 * (תקנות שוויון זכויות לאנשים עם מוגבלות).
 *
 * Now part of the legal-docs SYSTEM: the admin can edit it in the panel
 * (Settings → הצהרת נגישות), and it's stored in appConfig/accessibility.
 * This modal fetches that doc (get-accessibility); if the admin has
 * published sections we render them, otherwise we fall back to the
 * built-in legally-complete statement below so there's ALWAYS a correct
 * statement visible — even before any customization.
 *
 * Opened from the footer link and the accessibility widget. No
 * standalone route — consistent with the Terms / Privacy modals.
 */
interface A11ySection {
  title: string
  paragraphs: string[]
}

export function AccessibilityModal({ onClose }: { onClose: () => void }) {
  // null = still loading; [] = loaded-but-empty (→ use the fallback).
  const [sections, setSections] = useState<A11ySection[] | null>(null)
  const [lastUpdated, setLastUpdated] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/paypal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-accessibility' }),
        })
        const j = (await r.json()) as {
          sections?: A11ySection[]
          lastUpdated?: string
        }
        if (!alive) return
        setSections(Array.isArray(j.sections) ? j.sections : [])
        setLastUpdated(typeof j.lastUpdated === 'string' ? j.lastUpdated : '')
      } catch {
        if (alive) setSections([]) // network error → built-in fallback
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const hasDbContent = sections !== null && sections.length > 0

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-bg-elevated p-6 md:p-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute left-3 top-3 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-card hover:text-fg"
          aria-label="סגור"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {sections === null ? (
          <div className="flex items-center gap-2 py-10 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> טוען…
          </div>
        ) : hasDbContent ? (
          <DbStatementBody sections={sections} lastUpdated={lastUpdated} />
        ) : (
          <AccessibilityStatementBody />
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
        >
          סגירה
        </button>
      </div>
    </div>
  )
}

/* Admin-published version (from appConfig/accessibility). Same heading
 * hierarchy + look as the built-in fallback. */
function DbStatementBody({
  sections,
  lastUpdated,
}: {
  sections: A11ySection[]
  lastUpdated: string
}) {
  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Accessibility className="h-5 w-5" />
        </span>
        <h2
          className="font-display text-fg"
          style={{ fontSize: 'clamp(24px,4vw,32px)', fontWeight: 500 }}
        >
          הצהרת נגישות
        </h2>
      </div>
      <div className="space-y-7 text-sm leading-relaxed text-fg-secondary">
        {sections.map((s, i) => (
          <Section key={i} title={s.title}>
            <div className="space-y-2.5">
              {s.paragraphs.map((p, pi) => (
                <p key={pi}>{p}</p>
              ))}
            </div>
          </Section>
        ))}
        {lastUpdated && (
          <p className="border-t border-border/60 pt-6 text-xs text-fg-muted">
            הצהרת הנגישות עודכנה לאחרונה ב{lastUpdated}.
          </p>
        )}
      </div>
    </>
  )
}

/* Statement content. Headings start at h2 (panel title) → h3 (sections)
 * so the hierarchy stays valid even when the modal opens over a page
 * that already has its own h1. */
function AccessibilityStatementBody() {
  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Accessibility className="h-5 w-5" />
        </span>
        <h2
          className="font-display text-fg"
          style={{ fontSize: 'clamp(24px,4vw,32px)', fontWeight: 500 }}
        >
          הצהרת נגישות
        </h2>
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
    </>
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
      <h3 className="mb-2 text-base font-semibold text-fg">{title}</h3>
      <div>{children}</div>
    </section>
  )
}
