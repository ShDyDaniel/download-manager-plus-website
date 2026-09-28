import { Link } from 'react-router-dom'
import {
  ArrowDown,
  AudioWaveform,
  CircleCheckBig,
  Download,
  File,
  Film,
  FolderOpen,
  Music,
  RotateCcw,
} from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { useDownload } from '../components/site/DownloadGate'
import { IC, LandingCta, WinTop, scrollToSection } from '../components/landings/LandingBits'
import { EQ_BARS, RULER, SKETCH_WAVE, SYNC_GROUPS } from '../components/landings/syncDemo'
import '../styles/pages/sync.css'

/**
 * /sync — landing page for the desktop app's "סנכרון אוטומטי" tab.
 *
 * The centerpiece is a looping mock of the real timeline: six clips sit
 * stacked at the start, an equaliser-style progress bar runs, then the clips
 * snap onto their synced positions and the export button appears. Pure CSS
 * (src/styles/pages/sync.css); under reduced motion or the site's "stop
 * animations" setting the demo is pinned to its settled, synced state.
 */
export function SyncLandingPage() {
  const { requestDownload } = useDownload()
  const download = (
    <button type="button" className="btn btn-p btn-lg" onClick={() => requestDownload()}>
      <Download {...IC} />
      הורדת המערכת
    </button>
  )

  return (
    <FlPage name="sync" title="סנכרון אוטומטי">
      <div className="wrap">
        <div className="phero">
          <span className="pill">
            כלול בתוכנית <b>Pro</b> ומעלה
          </span>
          <h1 className="display">
            סנכרון אוטומטי<span className="chip">בטא</span>
          </h1>
          <p className="lead">
            טוענים טיימליין עם הסרטות מכמה מצלמות וממיקרופונים חיצוניים, והמערכת מסנכרנת את כולם לפי
            הסאונד על ציר זמן אחד, אוטומטית.
          </p>
          <div className="actions">
            {download}
            <button type="button" className="btn btn-s btn-lg" onClick={() => scrollToSection('how')}>
              <ArrowDown {...IC} />
              איך זה עובד?
            </button>
          </div>
        </div>
      </div>

      <SyncDemo />

      <div className="wrap sec" id="how">
        <div className="sec-head">
          <span className="eyebrow">שלושה צעדים</span>
          <h2 className="h2">ככה זה עובד</h2>
        </div>
        <ol className="grid g3 stepgrid">
          <li className="card step">
            <span className="no">1</span>
            <h3 className="h3">הכנסת חומרים</h3>
            <p>
              מכניסים לטיימליין בתוכנת העריכה את הקליפים מכל המצלמות והמיקרופונים, בלי לסדר, ומייבאים
              אותו לפריימליין כקובץ <bdi dir="ltr">XML</bdi> או <bdi dir="ltr">FCPXML</bdi>.
            </p>
            <div className="mini mload" aria-hidden="true">
              <div className="dz">
                <FolderOpen {...IC} />
                <span>
                  גררו לכאן טיימליין מתוכנת העריכה, <bdi dir="ltr">FCPXML</bdi> או <bdi dir="ltr">XML</bdi>
                </span>
              </div>
              <div className="frow">
                <File {...IC} />
                <bdi dir="ltr">wedding_multicam.fcpxml</bdi>
                <em>6 קבצים · 3 ערוצים</em>
              </div>
            </div>
          </li>
          <li className="card step">
            <span className="no">2</span>
            <h3 className="h3">המערכת מסנכרנת</h3>
            <p>קצב הפריימים מזוהה אוטומטית, והסאונד של כל קליפ מנותח ומסונכרן מול השאר.</p>
            <div className="mini msync" aria-hidden="true">
              <div className="fps">
                <span>קצב פריימים</span>
                <b>
                  <bdi dir="ltr">25 fps</bdi>
                </b>
                <em>זוהה אוטומטית</em>
              </div>
              {(
                [
                  ['מצלמה 1', 'k1 v'],
                  ['מצלמה 2', 'k2 v'],
                  ['מיקרופון', 'k3 a'],
                ] as const
              ).map(([label, cls]) => (
                <div className="lane" key={label}>
                  <span>{label}</span>
                  <div className="track">
                    <div className={`clip ${cls}`}>
                      <svg viewBox="0 0 120 20" preserveAspectRatio="none">
                        <path d={SKETCH_WAVE} />
                      </svg>
                    </div>
                  </div>
                </div>
              ))}
              <div className="ok">
                <i />
                מסונכרן לפי הסאונד<span className="tag">בטא</span>
              </div>
            </div>
          </li>
          <li className="card step">
            <span className="no">3</span>
            <h3 className="h3">ייצוא</h3>
            <p>
              כל הקליפים מיושרים על ציר זמן אחד. מייצאים טיימליין מוכן ופותחים אותו ב־DaVinci Resolve או
              ב־Premiere.
            </p>
            <div className="mini mexp" aria-hidden="true">
              <div className="frow">
                <File {...IC} />
                <bdi dir="ltr">wedding_multicam - FramelineSync.xml</bdi>
              </div>
              <div className="to">
                <span>נפתח ב־</span>
                <b>
                  <bdi dir="ltr">DaVinci Resolve</bdi>
                </b>
                <b>
                  <bdi dir="ltr">Premiere Pro</bdi>
                </b>
              </div>
              <div className="okl">
                <CircleCheckBig {...IC} />
                הכול מסונכרן
              </div>
            </div>
          </li>
        </ol>
      </div>

      <div className="wrap sec">
        <div className="sec-head">
          <span className="eyebrow">מה מקבלים</span>
          <h2 className="h2">הכל אוטומטי, בלי לגרור קליפים ידנית</h2>
        </div>
        <div className="card caps">
          <ul className="checks">
            <li>סנכרון בין כמה מצלמות שצילמו את אותו אירוע, מולטיקאם</li>
            <li>סאונד נקי ממיקרופון חיצוני, מסונכרן אוטומטית לווידאו</li>
            <li>זיהוי קצב פריימים אוטומטי</li>
            <li>התאמה לפי הסאונד עצמו, בלי קלאפר</li>
            <li>ייצוא טיימליין מסונכרן ל־DaVinci Resolve ול־Premiere</li>
            <li>
              ייבוא טיימליין קיים מקובץ <bdi dir="ltr">XML</bdi> או <bdi dir="ltr">FCPXML</bdi>, וסנכרון
              ישירות ממנו בלי לייבא קבצים נוספים
            </li>
          </ul>
        </div>
        <div className="note info beta">
          <AudioWaveform {...IC} />
          <span>
            <b>הסנכרון האוטומטי עדיין בבטא.</b> הוא עובד, ואנחנו ממשיכים לשפר אותו. נתקלתם בקליפ שלא
            הסתנכרן נכון?{' '}
            <Link className="link" to="/contact">
              ספרו לנו
            </Link>
            .
          </span>
        </div>
      </div>

      <LandingCta
        title="שנתחיל לסנכרן?"
        text="הסנכרון האוטומטי הוא חלק מפריימליין, מערכת ליוצרי תוכן ולעורכי וידאו. כלול בתוכנית Pro ומעלה."
        primary={download}
      />
    </FlPage>
  )
}

/* ── The demo window ─────────────────────────────────────────────────────── */
function SyncDemo() {
  let n = 0 // running clip index → staggered animation-delay
  return (
    <div className="wrap demo-wrap">
      <div
        className="win"
        role="img"
        aria-label="הדגמה: שישה קליפים משתי מצלמות וממיקרופון חיצוני מסתדרים לבד על ציר זמן אחד לפי הסאונד, ואז מופיע כפתור ייצוא"
      >
        <WinTop icon={AudioWaveform} title="סנכרון אוטומטי" extra={<span className="tag">בטא</span>} />
        <div className="sy" aria-hidden="true">
          <div className="tl">
            <div className="tli">
              <div className="ruler">
                {RULER.map(([x, t]) => (
                  <span key={t} style={{ left: `${x}%` }}>
                    {t}
                  </span>
                ))}
              </div>
              <div className="gridl">
                {[25, 50, 75].map((x) => (
                  <i key={x} style={{ left: `${x}%` }} />
                ))}
              </div>
              {SYNC_GROUPS.map((g) => (
                <div className="grp" key={g.name}>
                  <div className="gh">
                    {g.kind === 'video' ? <Film {...IC} /> : <Music {...IC} />}
                    {g.name}
                  </div>
                  {g.clips.map((c) => {
                    const style = {
                      '--a': `${c.a}%`,
                      '--b': `${c.b}%`,
                      width: `${c.width}%`,
                      animationDelay: `${(n++ * 0.05).toFixed(2)}s`,
                    } as React.CSSProperties
                    return (
                      <div className="ln" key={c.file + c.kind}>
                        <div className={`tclip ${c.kind}`} style={style}>
                          <span className="nm">
                            {c.kind === 'v' && <Film {...IC} />}
                            <span>{c.file}</span>
                          </span>
                          {c.kind === 'v' ? (
                            <span className="fs" />
                          ) : (
                            <svg className="wv" viewBox="0 0 200 20" preserveAspectRatio="none">
                              <polygon points={c.wave} />
                            </svg>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="act">
            <div className="prog">
              <span className="stop">
                <svg viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                </svg>
              </span>
              <div className="bar">
                <div className="eq">
                  {EQ_BARS.map((b, k) => (
                    <i key={k} style={{ '--d': `${b.d}s`, '--o': `${b.o}s`, '--t': `${b.t}s` } as React.CSSProperties} />
                  ))}
                </div>
                <span className="lbl">
                  <span className="spin" />
                  <span className="w">
                    <span className="l1">טעינת קבצים</span>
                    <span className="l2">מסנכרן</span>
                  </span>
                  <span className="sep">·</span>
                  <bdi dir="ltr" className="n" />
                </span>
              </div>
            </div>
            <div className="done">
              <span className="fbtn p">
                <Download {...IC} />
                <bdi dir="ltr">
                  <span className="lg">XML · </span>Resolve / Premiere
                </bdi>
              </span>
              <span className="st">
                <CircleCheckBig {...IC} />6 סונכרנו
              </span>
              <span className="fbtn t rs">
                <RotateCcw {...IC} />
                איפוס
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SyncLandingPage
