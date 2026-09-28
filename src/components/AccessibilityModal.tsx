import { Fragment, useEffect, useState, type ReactNode } from 'react'
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
 * The same statement is the /accessibility page (src/pages/
 * AccessibilityPage.tsx): the built-in text and the fetch below are
 * shared with it. This modal keeps its original look — it is still
 * opened from the old footer and from the accessibility widget on the
 * admin routes.
 */
export interface A11ySection {
  title: string
  paragraphs: string[]
}

/* ── The built-in statement (shown when the admin hasn't published one).
 *  Kept as data so the modal and the /accessibility page render the very
 *  same words. A text run is a string, a bold run { b } (`ltr` = a Latin
 *  term kept left-to-right), or the contact address { email }. */
export type A11yRich = string | { b: string; ltr?: boolean } | { email: string }
export interface BuiltinA11ySection {
  id: string
  title: string
  text?: A11yRich[]
  list?: string[]
}

export const A11Y_CONTACT_EMAIL = 'help.frameline@gmail.com'
/** "הצהרת הנגישות עודכנה לאחרונה <this>." */
export const BUILTIN_A11Y_UPDATED = 'ביוני 2026'

export const BUILTIN_A11Y_SECTIONS: BuiltinA11ySection[] = [
  {
    id: 'a-commit',
    title: 'המחויבות שלנו',
    text: [
      'אתר פריימליין רואה חשיבות רבה במתן שירות שוויוני לכלל המשתמשים, ופועל להנגיש את האתר כך שיהיה נגיש גם לאנשים עם מוגבלות. אנו משקיעים מאמצים ומשאבים על מנת לאפשר גלישה נוחה ושוויונית ככל הניתן.',
    ],
  },
  {
    id: 'a-level',
    title: 'רמת הנגישות באתר',
    text: [
      'האתר הונגש בהתאם להוראות תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע"ג–2013, ובכפוף לתקן הישראלי ',
      { b: 'ת"י 5568' },
      ' המבוסס על הנחיות ',
      { b: 'WCAG 2.0', ltr: true },
      ' ברמה ',
      { b: 'AA' },
      ', ככל שניתן.',
    ],
  },
  {
    id: 'a-done',
    title: 'מה הונגש באתר',
    list: [
      'תפריט נגישות צף הזמין מכל עמוד באתר.',
      'התאמות הניתנות להפעלה: הגדלת/הקטנת טקסט, ניגודיות גבוהה, היפוך צבעים, גווני אפור, הדגשת קישורים, גופן קריא, ריווח טקסט מוגדל, עצירת אנימציות, סמן עכבר גדול והדגשת מיקוד מקלדת.',
      'ניווט מלא באמצעות מקלדת וסדר טאבים הגיוני.',
      'מבנה כותרות סמנטי ותוויות לרכיבי הטופס.',
      'תאימות לקוראי מסך נפוצים.',
      'שמירת ההעדפות של המשתמש בין עמודים וביקורים.',
    ],
  },
  {
    id: 'a-limits',
    title: 'הסתייגות ומגבלות ידועות',
    text: [
      'למרות מאמצינו להנגיש את כלל הדפים והרכיבים, ייתכן שיימצאו חלקים שטרם הונגשו במלואם או שאינם נתמכים באופן מיטבי בכל הדפדפנים והטכנולוגיות המסייעות. אנו ממשיכים לפעול לשיפור הנגישות באופן שוטף.',
    ],
  },
  {
    id: 'a-contact',
    title: 'פנייה בנושא נגישות',
    text: [
      'נתקלתם בבעיית נגישות, או שיש לכם הצעה לשיפור? נשמח לקבל פנייה בכתובת ',
      { email: A11Y_CONTACT_EMAIL },
      ' ונטפל בה בהקדם.',
    ],
  },
]

/** Render a built-in text with the caller's markup for bold runs and the
 *  e-mail link (the modal and the page each keep their own look). */
export function renderA11yRich(
  text: A11yRich[],
  marks: {
    bold: (s: string, ltr: boolean) => ReactNode
    email: (address: string) => ReactNode
  },
): ReactNode {
  return text.map((r, i) => (
    <Fragment key={i}>
      {typeof r === 'string'
        ? r
        : 'email' in r
          ? marks.email(r.email)
          : marks.bold(r.b, !!r.ltr)}
    </Fragment>
  ))
}

/** The admin-published statement (appConfig/accessibility, action
 *  get-accessibility). `sections` is null while loading and [] when there
 *  is none (or the request failed) → use the built-in text. */
export function useAccessibilityStatement(): {
  sections: A11ySection[] | null
  lastUpdated: string
} {
  // null = still loading; [] = loaded-but-empty (→ use the fallback).
  const [sections, setSections] = useState<A11ySection[] | null>(null)
  const [lastUpdated, setLastUpdated] = useState('')

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

  return { sections, lastUpdated }
}

export function AccessibilityModal({ onClose }: { onClose: () => void }) {
  const { sections, lastUpdated } = useAccessibilityStatement()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
        {BUILTIN_A11Y_SECTIONS.map((sec) => (
          <Section key={sec.id} title={sec.title}>
            {sec.list ? (
              <ul className="list-disc space-y-1.5 pr-5">
                {sec.list.map((li, i) => (
                  <li key={i}>{li}</li>
                ))}
              </ul>
            ) : (
              renderA11yRich(sec.text ?? [], {
                bold: (b) => <strong className="text-fg">{b}</strong>,
                email: (a) => (
                  <a href={`mailto:${a}`} className="text-primary hover:underline" dir="ltr">
                    {a}
                  </a>
                ),
              })
            )}
          </Section>
        ))}

        <p className="border-t border-border/60 pt-6 text-xs text-fg-muted">
          הצהרת הנגישות עודכנה לאחרונה {BUILTIN_A11Y_UPDATED}.
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
