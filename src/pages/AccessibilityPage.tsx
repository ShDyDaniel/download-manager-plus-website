import '../styles/pages/accessibility.css'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Accessibility } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import {
  BUILTIN_A11Y_SECTIONS,
  BUILTIN_A11Y_UPDATED,
  renderA11yRich,
  useAccessibilityStatement,
} from '../components/AccessibilityModal'
import { openAccessibilityMenu } from '../components/AccessibilityWidget'
import { layoutLegalDoc } from '../components/legalText'
import { LegalArticle } from '../components/LegalDoc'

/**
 * /accessibility — the accessibility statement (הצהרת נגישות). Same
 * content as AccessibilityModal: the statement the admin published
 * (appConfig/accessibility) when there is one, otherwise the built-in
 * statement. The built-in text shows right away and is replaced only if
 * a published statement arrives.
 */
export default function AccessibilityPage() {
  const { sections, lastUpdated } = useAccessibilityStatement()
  const published = useMemo(
    () => (sections && sections.length > 0 ? layoutLegalDoc(sections, 'a') : null),
    [sections],
  )
  // Same wording as the modal: "…עודכנה לאחרונה ב<date>."
  const updated = published ? (lastUpdated ? `ב${lastUpdated}` : '') : BUILTIN_A11Y_UPDATED

  return (
    <FlPage name="accessibility" title="הצהרת נגישות">
      <div className="narrow ldoc">
        <header className="phero dhead">
          <span className="eyebrow">נגישות</span>
          <h1 className="display">הצהרת נגישות</h1>
          <p className="meta">{updated && <>הצהרת הנגישות עודכנה לאחרונה {updated}.</>}</p>
        </header>

        <div className="note info fabnote">
          <span className="fabi">
            <Accessibility className="ic" aria-hidden />
          </span>
          <div>
            <b>תפריט הנגישות נמצא בכל עמוד באתר.</b> הכפתור העגול בפינה התחתונה של המסך פותח
            אותו: גודל טקסט, ניגודיות, גופן קריא, עצירת אנימציות ועוד.
          </div>
          <button
            type="button"
            className="btn btn-s btn-sm"
            aria-label="פתיחת תפריט הנגישות"
            onClick={openAccessibilityMenu}
          >
            פתיחת התפריט
          </button>
        </div>

        {published ? (
          <LegalArticle sections={published} />
        ) : (
          <article className="doc">
            {BUILTIN_A11Y_SECTIONS.map((s) => (
              <section key={s.id} className="sec-d" aria-labelledby={s.id}>
                <h2 id={s.id} className="sec-h">
                  <span>{s.title}</span>
                </h2>
                {s.list ? (
                  <ul>
                    {s.list.map((li, i) => (
                      <li key={i}>{li}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {renderA11yRich(s.text ?? [], {
                      bold: (b, ltr) => <b>{ltr ? <bdi>{b}</bdi> : b}</b>,
                      email: (a) => (
                        <bdi>
                          <a className="link" href={`mailto:${a}`}>
                            {a}
                          </a>
                        </bdi>
                      ),
                    })}
                  </p>
                )}
              </section>
            ))}
          </article>
        )}

        <footer className="dfoot">
          <div className="actions">
            <span className="muted small">מסמכים נוספים:</span>
            <Link className="btn btn-g btn-sm" to="/terms">
              תנאי שימוש
            </Link>{' '}
            <Link className="btn btn-g btn-sm" to="/privacy">
              מדיניות פרטיות
            </Link>
          </div>
        </footer>
      </div>
    </FlPage>
  )
}
