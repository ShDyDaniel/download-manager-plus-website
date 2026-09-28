import { useEffect, useState } from 'react'
import { ArrowDown, ArrowLeft, BookOpen, CircleCheckBig, Layers, Plus, X } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { useDownload } from '../components/site/DownloadGate'
import { IC, LandingCta } from '../components/landings/LandingBits'
import '../styles/pages/glossary.css'

/**
 * /glossary — קטלוג חבילות-המונחים לתמלול.
 *
 * הדף הוא *תצוגה* בלבד: ההפעלה עצמה קורית בתוך התוכנה, כי שם נשמרת
 * ההגדרה ושם רץ המנוע. התפקיד של הדף הוא להראות מה קיים ומה בדיוק ייכנס
 * — שקיפות מלאה, כי חבילה משנה את הטקסט שהמשתמש מקבל.
 *
 * הנתונים נמשכים מאותו endpoint שהאפליקציה קוראת, כדי שלא תהיה גרסה
 * שנייה של הרשימה שתתיישן. כל חבילה שהשרת מחזיר מוצגת — אין סינון בקוד.
 */
interface Pack {
  id: string
  name: string
  description: string
  terms: string[]
}

/** How many terms a card shows before "הצגת כל המונחים". */
const PREVIEW = 10

export function GlossaryPacksPage() {
  const { requestDownload } = useDownload()
  const [packs, setPacks] = useState<Pack[] | null>(null)
  // One full list open at a time.
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/revisions?action=glossary-packs')
      .then((r) => r.json())
      .then((j) => setPacks(Array.isArray(j?.packs) ? j.packs : []))
      .catch(() => setPacks([]))
  }, [])

  // The app-panel sketch shows a real pack (the first one) once the list is in.
  const sample = packs?.[0]
  const sampleName = sample?.name ?? 'יהדות'
  const sampleCount = sample?.terms.length ?? 318

  return (
    <FlPage name="glossary" title="חבילות מונחים לתמלול">
      <div className="wrap">
        <div className="phero">
          <span className="pill">
            חלק מהתמלול המתקדם, בתוכנית <b>Pro</b> ומעלה
          </span>
          <span className="eyebrow">תמלול חכם</span>
          <h1 className="display">חבילות מונחים לתמלול</h1>
          <p className="lead">
            מנוע תמלול גנרי לא מכיר את המונחים של התחום שלכם, ולכן הוא מנחש אותם לפי הצליל, ושם נופלות רוב
            השגיאות. חבילה היא רשימה מתוחזקת של שמות ומונחים; הפעלה אחת בתוכנה, וכל התמלולים הבאים מכירים
            אותם.
          </p>
        </div>
      </div>

      <div className="wrap">
        {packs === null && (
          <div className="loading" role="status" aria-label="טוען את הקטלוג">
            <span className="spin" />
          </div>
        )}

        {packs?.length === 0 && <p className="empty muted center">הקטלוג אינו זמין כרגע. נסו לרענן בעוד רגע.</p>}

        {packs && packs.length > 0 && (
          <>
            <div className="grid g2 packs">
              {packs.map((p) => {
                const phrases = p.terms.filter((t) => t.trim().split(/\s+/).length > 1).length
                const isOpen = open === p.id
                const more = p.terms.length - PREVIEW
                const listId = `gl-terms-${p.id}`
                return (
                  <article className={`card pack${isOpen ? ' open' : ''}`} key={p.id}>
                    <div className="ph">
                      <span className="tile">
                        <Layers {...IC} />
                      </span>
                      <div className="nm">
                        <h2 className="h3">{p.name}</h2>
                        <p>{p.description}</p>
                      </div>
                      {/* פותח את התוכנה ומפעיל את הקטגוריה. הקישור נושא מזהה
                          בלבד — המונחים נמשכים מהשרת, כך שאי-אפשר להזריק
                          מילים למילון דרך URL. */}
                      <a className="btn btn-p btn-sm add" href={`dmplus://glossary?pack=${encodeURIComponent(p.id)}`}>
                        <Plus {...IC} />
                        הוספה לתוכנה
                      </a>
                    </div>
                    <div className="stats">
                      <span className="chip mu">
                        <bdi dir="ltr" className="num">
                          {p.terms.length}
                        </bdi>{' '}
                        מונחים
                      </span>
                      <span className="chip mu">
                        <bdi dir="ltr" className="num">
                          {phrases}
                        </bdi>{' '}
                        צירופים
                      </span>
                    </div>
                    {!isOpen && (
                      <div className="prev">
                        {p.terms.slice(0, PREVIEW).map((t, i) => (
                          <span className="term" key={i}>
                            {t}
                          </span>
                        ))}
                        {more > 0 && (
                          <span className="more">
                            ועוד{' '}
                            <bdi dir="ltr" className="num">
                              {more}
                            </bdi>
                          </span>
                        )}
                      </div>
                    )}
                    {more > 0 && (
                      <div className="toggle">
                        <button
                          type="button"
                          className="tg"
                          aria-expanded={isOpen}
                          aria-controls={listId}
                          onClick={() => setOpen(isOpen ? null : p.id)}
                        >
                          {isOpen ? 'הסתרת הרשימה' : 'הצגת כל המונחים'}
                          <ArrowDown {...IC} />
                        </button>
                        {isOpen && (
                          <ul className="all" id={listId} aria-label={`כל המונחים בחבילה ${p.name}`}>
                            {p.terms.map((t, i) => (
                              <li className="term" key={i}>
                                {t}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
            <p className="hint small muted center">
              הכפתור ״הוספה לתוכנה״ פותח את פריימליין במחשב ומוסיף את החבילה. עוד אין לכם את התוכנה?{' '}
              <button type="button" className="link" onClick={() => requestDownload()}>
                להורדה
              </button>
            </p>
          </>
        )}
      </div>

      <div className="wrap sec">
        <div className="card how">
          <div className="howtxt">
            <h2 className="h3">איך מפעילים</h2>
            <p className="muted small alias">בתוכנה, חבילת מונחים נקראת ״קטגוריה״.</p>
            <ol className="steps">
              <li>פותחים בתוכנה את הטאב ״תמלול חכם״.</li>
              <li>לוחצים כאן על ״הוספה לתוכנה״, או, בתוך התוכנה, על ״מתקדם״ ואז על הכפתור ״קטגוריה״.</li>
              <li>הקטגוריה מופיעה כתגית אחת במילון האישי, בלי למלא אותו במאות מונחים.</li>
            </ol>
            <p className="fineok">
              <CircleCheckBig {...IC} />
              <span>
                הקטגוריות מתעדכנות מהשרת. כשמונח נוסף או מתוקן ברשימה, הוא מגיע אליכם אוטומטית, בלי להוסיף את
                הקטגוריה מחדש.
              </span>
            </p>
          </div>

          {/* The app's "מילון אישי" panel, as it looks after a pack is added from the site. */}
          <div className="mini dict" aria-hidden="true">
            <div className="dh">
              <span className="dt">
                <BookOpen {...IC} />
              </span>
              <div>
                <b>מילון אישי</b>
                <small>שמות ומונחים שחוזרים אצלכם. המערכת תעדיף את הכתיב הזה במקום לנחש לפי הצליל.</small>
              </div>
              <em>2 מונחים</em>
            </div>
            <div className="din">
              <span className="inp">שם או מונח, ואז Enter</span>
              <span className="kb">
                <Layers {...IC} />
                קטגוריה
              </span>
              <span className="ad">הוספה</span>
            </div>
            <div className="added">
              <div className="dtags">
                <span className="ptag">
                  <X {...IC} />
                  <Layers {...IC} />
                  קטגוריה: {sampleName}{' '}
                  <i>
                    (<bdi dir="ltr">{sampleCount}</bdi>)
                  </i>
                </span>
              </div>
              <div className="dok">הקטגוריה "{sampleName}" נוספה למילון.</div>
            </div>
            <div className="dterms">
              <span>פריימליין</span>
              <span>דה וינצ׳י</span>
            </div>
          </div>
        </div>
      </div>

      <LandingCta
        title="חבילות המונחים מחכות בתוכנה"
        text="הן חלק מהתמלול המתקדם של פריימליין, שכלול בתוכנית Pro ומעלה."
        primary={
          <button type="button" className="btn btn-p btn-lg" onClick={() => requestDownload()}>
            להורדת התוכנה
            <ArrowLeft {...IC} />
          </button>
        }
      />
    </FlPage>
  )
}
