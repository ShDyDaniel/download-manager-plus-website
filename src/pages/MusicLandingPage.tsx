import { Link } from 'react-router-dom'
import {
  Apple,
  ArrowDown,
  AudioLines,
  CircleCheckBig,
  Download,
  Drum,
  FileAudio,
  Film,
  Headphones,
  Info,
  Mic2,
  Monitor,
  Music2,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Speech,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { useDownload } from '../components/site/DownloadGate'
import { IC, LandingCta, WinTop, scrollToSection } from '../components/landings/LandingBits'
import { BARS, EQ, MIX_WAVE, STEMS, type StemKey } from '../components/landings/musicDemo'
import '../styles/pages/music.css'

/**
 * /music — landing page for the desktop app's "עריכת מוזיקה" tab and its tool,
 * "הפרדת ערוצים": split a song into stems, then listen, mix and export.
 *
 * The centerpiece is a looping mock of the app's own screens: the song's
 * waveform while the engine separates it, the four stem lanes unfolding out
 * of it, then the mixer (StemMixer in the app) coming alive — the playhead
 * sweeps, "סולו" lights on vocals, drums get muted, the vocal fader comes
 * down and "ייצוא מיקס" pulses. Pure CSS (src/styles/pages/music.css). Every
 * element's resting (non-animated) style IS the finished state, so under
 * reduced motion or the site's "stop animations" setting the demo freezes on
 * the settled mixer instead of snapping back to the start.
 */

const STEM_ICON: Record<StemKey, LucideIcon> = { v: Mic2, d: Drum, b: AudioLines, o: Music2 }

/** The app's "לכמה ערוצים לפרק?" options (STEM_LABELS in the app). */
const STEM_OPTIONS: [number, string][] = [
  [2, 'שירה · ליווי'],
  [4, 'שירה · תופים · בס · שאר'],
  [6, 'שירה · תופים · בס · גיטרה · פסנתר · שאר'],
]

const USES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Speech,
    title: 'מוזיקה מתחת לדיבור',
    text: 'מנמיכים את השירה או מעלימים אותה, כדי שהשיר לא יתחרה בקריינות או בראיון.',
  },
  {
    icon: Mic2,
    title: 'רק השירה',
    text: 'מבודדים את הקול מתוך השיר, כשצריך את השירה בלי הליווי.',
  },
  {
    icon: Drum,
    title: 'ביט לחיתוכים',
    text: 'משאירים רק תופים ובס, ומקבלים בסיס קצבי לחתוך עליו.',
  },
  {
    icon: Film,
    title: 'מוזיקה מתוך סרטון',
    text: 'יש לכם רק קובץ וידאו? מכניסים אותו כמו שהוא, והמערכת לוקחת ממנו את הסאונד ומפרקת אותו לערוצים.',
  },
]

export function MusicLandingPage() {
  const { requestDownload } = useDownload()
  const download = (
    <button type="button" className="btn btn-p btn-lg" onClick={() => requestDownload()}>
      <Download {...IC} />
      הורדת המערכת
    </button>
  )

  return (
    <FlPage name="music" title="עריכת מוזיקה">
      <div className="wrap">
        <div className="phero">
          <span className="pill">
            כלול בתוכנית <b>Basic</b> ומעלה
          </span>
          <span className="eyebrow">הפרדת ערוצים</span>
          <h1 className="display">עריכת מוזיקה</h1>
          <p className="lead">
            מפרקים שיר לערוצים נפרדים, שירה, תופים, בס ושאר הכלים, ואז שומעים כל אחד לבד, מערבבים ומייצאים
            בדיוק את מה שהסרטון צריך. הכול רץ על המחשב שלכם.
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

      <MixerDemo />

      <div className="wrap sec" id="how">
        <div className="sec-head">
          <span className="eyebrow">שלושה צעדים</span>
          <h2 className="h2">ככה זה עובד</h2>
        </div>
        <ol className="grid g3 stepgrid">
          <li className="card step">
            <span className="no">1</span>
            <h3 className="h3">בוחרים קובץ</h3>
            <p>
              גוררים לחלון שיר או סרטון, או בוחרים אותו מהמחשב: <bdi dir="ltr">MP3 · WAV · MP4 · MOV</bdi>{' '}
              ועוד. מקובץ וידאו נלקח רק הסאונד.
            </p>
            <DropMini />
          </li>
          <li className="card step">
            <span className="no">2</span>
            <h3 className="h3">בוחרים ערוצים ואיכות</h3>
            <p>
              מחליטים לכמה ערוצים לפרק, 2, 4 או 6, ובאיזו איכות: איכות גבוהה לתוצאה הנקייה ביותר, או מהיר,
              שעובד מהר מאוד ועדיין באיכות טובה.
            </p>
            <PickMini />
          </li>
          <li className="card step">
            <span className="no">3</span>
            <h3 className="h3">שומעים, מערבבים ומייצאים</h3>
            <p>
              כל ערוץ מקבל שורה עם גל הקול שלו. מנגנים הכול יחד, ולכל ערוץ יש סולו, השתקה ועוצמה. בסוף מייצאים
              ערוץ בודד, או את המיקס שבניתם כקובץ <bdi dir="ltr">WAV</bdi>.
            </p>
            <MixMini />
          </li>
        </ol>
      </div>

      <div className="wrap sec">
        <div className="sec-head">
          <span className="eyebrow">שימושים</span>
          <h2 className="h2">מה עושים עם זה בעריכה</h2>
        </div>
        <ul className="grid g4 uses">
          {USES.map((u) => (
            <li className="card use" key={u.title}>
              <span className="tile">
                <u.icon {...IC} />
              </span>
              <h3 className="h3">{u.title}</h3>
              <p>{u.text}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="wrap sec">
        <div className="sec-head">
          <span className="eyebrow">מה מקבלים</span>
          <h2 className="h2">כל כלי בערוץ משלו</h2>
        </div>
        <div className="card caps">
          <ul className="checks">
            <li>פירוק לשניים, ארבעה או שישה ערוצים: משירה וליווי ועד שירה, תופים, בס, גיטרה, פסנתר ושאר הכלים</li>
            <li>
              קובצי מוזיקה וגם וידאו, <bdi dir="ltr">MP3 · WAV · MP4 · MOV</bdi> ועוד. מסרטון נלקח רק הסאונד
            </li>
            <li>שתי רמות: איכות גבוהה, הכי נקייה, או מהיר מאוד ועדיין באיכות טובה</li>
            <li>מיקסר עם גל הקול האמיתי של כל ערוץ, ונגן אחד שמנגן את כולם יחד וקופץ לכל נקודה בשיר</li>
            <li>סולו, השתקה ועוצמה לכל ערוץ בנפרד, ואיפוס המיקס בלחיצה</li>
            <li>
              ייצוא של ערוץ בודד, או של המיקס שבניתם, כקובץ <bdi dir="ltr">WAV</bdi>
            </li>
            <li>ההפרדה רצה על המחשב שלכם, והשיר לא נשלח לשום שרת</li>
            <li>
              ב־<bdi dir="ltr">Mac</bdi> עם שבב <bdi dir="ltr">Apple</bdi>: האצת חומרה אוטומטית עם{' '}
              <bdi dir="ltr" className="nw">Neural Engine + Metal</bdi>
            </li>
          </ul>
        </div>
      </div>

      <div className="wrap sec">
        <div className="sec-head">
          <span className="eyebrow">טוב לדעת</span>
          <h2 className="h2">לפני שמתחילים</h2>
        </div>
        <div className="grid g2 know">
          <div className="card kcard">
            <div className="hd">
              <span className="tile">
                <Monitor {...IC} />
              </span>
              <h3 className="h3">דרישות מערכת</h3>
            </div>
            <div className="reqs">
              <div className="os">
                <div className="osn">
                  <Apple {...IC} />
                  <bdi dir="ltr">Mac</bdi>
                </div>
                <dl>
                  <dt>מעבד</dt>
                  <dd>
                    שבב <bdi dir="ltr">Apple M1</bdi> ומעלה. אין תמיכה במחשבי <bdi dir="ltr">Intel</bdi>
                  </dd>
                  <dt>מערכת</dt>
                  <dd>
                    מומלץ <bdi dir="ltr">macOS 13</bdi> ומעלה
                  </dd>
                  <dt>זיכרון</dt>
                  <dd>
                    מינימום <bdi dir="ltr">8GB</bdi>, מומלץ <bdi dir="ltr">16GB</bdi> ומעלה
                  </dd>
                  <dt>האצת חומרה</dt>
                  <dd>
                    <bdi dir="ltr" className="nw">Neural Engine + Metal</bdi>, אוטומטית
                  </dd>
                </dl>
              </div>
              <div className="os">
                <div className="osn">
                  <Monitor {...IC} />
                  <bdi dir="ltr">Windows</bdi>
                </div>
                <dl>
                  <dt>מעבד</dt>
                  <dd>
                    <bdi dir="ltr">Intel Core</bdi> דור 4 משנת 2013, או <bdi dir="ltr">AMD Ryzen</bdi> משנת 2017
                    ומעלה. מומלץ <bdi dir="ltr">Intel Core i7</bdi> או <bdi dir="ltr">AMD Ryzen 7</bdi> ומעלה
                  </dd>
                  <dt>מערכת</dt>
                  <dd>
                    <bdi dir="ltr">Windows 10</bdi> בגרסת <bdi dir="ltr">64-bit</bdi> ומעלה, מומלץ{' '}
                    <bdi dir="ltr">Windows 11</bdi>
                  </dd>
                  <dt>זיכרון</dt>
                  <dd>
                    מינימום <bdi dir="ltr">8GB</bdi>, מומלץ <bdi dir="ltr">16GB</bdi> ומעלה
                  </dd>
                  <dt>עיבוד</dt>
                  <dd>על המעבד</dd>
                </dl>
              </div>
            </div>
          </div>
          <div className="card kcard">
            <div className="hd">
              <span className="tile">
                <Info {...IC} />
              </span>
              <h3 className="h3">בכנות</h3>
            </div>
            <ul className="facts">
              <li>
                <b>הורדה חד פעמית.</b> בפעם הראשונה המערכת מורידה את מנוע הפרדת הערוצים. מהפעם הבאה הוא כבר
                על המחשב.
              </li>
              <li>
                <b>הזמן תלוי במחשב.</b> ההפרדה רצה אצלכם, כך שמשך הזמן תלוי במחשב, באורך השיר ובאיכות שבחרתם.
                איכות גבוהה מעט יותר איטית.
              </li>
              <li>
                <b>התוצאה תלויה בהקלטה.</b> בשירים עמוסים ייתכן שיישארו שאריות של כלי אחד בערוץ של כלי אחר, אז
                כדאי להאזין לכל ערוץ לפני הייצוא.
              </li>
              <li>
                <b>מכסת הפרדות חודשית לפי התוכנית.</b> הפרדה שבוטלה או נכשלה לא נספרת.
                <small>
                  לפי ברירת המחדל: <bdi dir="ltr">Basic</bdi> עד 10 בחודש, <bdi dir="ltr">Pro</bdi> עד 50,{' '}
                  <bdi dir="ltr">Ultra</bdi> ללא הגבלה. הפרטים המעודכנים ב
                  <Link className="link" to="/buy">
                    עמוד המחירים
                  </Link>
                  .
                </small>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <LandingCta
        title="מוכנים לפרק את השיר הבא?"
        text="עריכת המוזיקה היא חלק מפריימליין, מערכת ליוצרי תוכן ולעורכי וידאו. כלולה בתוכנית Basic ומעלה."
        primary={download}
      />
    </FlPage>
  )
}

/** One waveform drawn like the app's mixer: dim full song + the played part on top. */
function Wave({ d, played = true }: { d: string; played?: boolean }) {
  return (
    <>
      <svg className="w0" viewBox={`0 0 ${BARS} 40`} preserveAspectRatio="none">
        <path d={d} />
      </svg>
      {played && (
        <svg className="w1" viewBox={`0 0 ${BARS} 40`} preserveAspectRatio="none">
          <path d={d} />
        </svg>
      )}
    </>
  )
}

/* ── The demo window ─────────────────────────────────────────────────────── */
function MixerDemo() {
  return (
    <div className="wrap demo-wrap">
      <div
        className="win"
        role="img"
        aria-label="הדגמה: שיר מתפרק לארבעה ערוצים, שירה, תופים, בס ושאר, ואז במיקסר מפעילים סולו על השירה, משתיקים את התופים, מנמיכים את עוצמת השירה ומייצאים מיקס"
      >
        <WinTop icon={SlidersHorizontal} title="הפרדת ערוצים" />
        <div className="mx" aria-hidden="true">
          <div className="mxin">
            <div className="mhd">
              <span className="cnt">
                <Music2 {...IC} />4 ערוצים
              </span>
              <b dir="auto">שיר_פתיחה.mp3</b>
            </div>

            <div className="tp" dir="ltr">
              <span className="play">
                <Play className="ic p1" aria-hidden />
                <Pause className="ic p2" aria-hidden />
              </span>
              <span className="t now" />
              <span className="scr">
                <i className="fill" />
                <b className="knob" />
              </span>
              <span className="t">3:24</span>
              <span className="rst">
                <RotateCcw {...IC} />
              </span>
            </div>

            <div className="lanes">
              <div className="ln full">
                <div className="lni">
                  <div className="id">
                    <span className="ti">
                      <AudioLines {...IC} />
                    </span>
                    <span className="lb">השיר המקורי</span>
                  </div>
                  <div className="wv">
                    <Wave d={MIX_WAVE} played={false} />
                    <i className="scan" />
                  </div>
                </div>
              </div>

              <div className="sep">
                <div className="eqz">
                  {EQ.map((b, k) => (
                    <i key={k} style={{ '--d': `${b.d}s`, '--o': `${b.o}s` } as React.CSSProperties} />
                  ))}
                </div>
                <b>מפריד את הערוצים…</b>
                <span className="bar">
                  <i />
                </span>
                <span className="pct" />
              </div>

              {STEMS.map((s, i) => {
                const Icon = STEM_ICON[s.key]
                return (
                  <div
                    className={`ln st st-${s.key}`}
                    key={s.key}
                    style={{ '--i': i } as React.CSSProperties}
                  >
                    <div className="lni">
                      <div className="id">
                        <span className="ti">
                          <Icon {...IC} />
                        </span>
                        <span className="lb">{s.label}</span>
                      </div>
                      <div className="wv">
                        <Wave d={s.wave} />
                        <i className="ph" />
                      </div>
                      <div className="ctl">
                        <span className="b solo">
                          <Headphones {...IC} />
                        </span>
                        <span className="b mute">
                          <Volume2 className="ic m1" aria-hidden />
                          <VolumeX className="ic m2" aria-hidden />
                        </span>
                        <span className="b exp">
                          <Download {...IC} />
                        </span>
                      </div>
                      <div className="fd">
                        <span className="trk">
                          <i className="lvl" />
                          <b className="kn" />
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="exb">
              <div className="ex-t">
                <b>ייצוא המיקס הסופי</b>
                <span className="desc">מייצא לקובץ אחד את הערוצים הפעילים, לפי העוצמות שקבעתם.</span>
                <span className="saved">
                  <CircleCheckBig {...IC} />
                  המיקס נשמר
                </span>
              </div>
              <span className="act">
                פעילים: <span className="n" />
              </span>
              <span className="fbtn p go">
                <Download {...IC} />
                ייצוא מיקס
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Step sketches ───────────────────────────────────────────────────────── */

/** Step 1: a file dragged onto the app's drop zone. */
function DropMini() {
  return (
    <div className="mini mdrop" aria-hidden="true">
      <div className="dz">
        <span className="ti">
          <FileAudio {...IC} />
        </span>
        <div className="tx">
          <b>
            <span className="a">בחרו או גררו לכאן קובץ</span>
            <span className="h">שחררו כאן…</span>
          </b>
          <span className="sub">
            מוזיקה או וידאו, <bdi dir="ltr">MP3 · WAV · MP4 · MOV</bdi> ועוד. מהווידאו יילקח רק הסאונד
          </span>
        </div>
      </div>
      <div className="frow">
        <FileAudio {...IC} />
        <span dir="auto">שיר_פתיחה.mp3</span>
        <em>מוכן להפרדה</em>
      </div>
      <span className="drag">
        <FileAudio {...IC} />
        <span dir="auto">שיר_פתיחה.mp3</span>
      </span>
    </div>
  )
}

/** Step 2: the stem-count and quality pickers, exactly as in the app. */
function PickMini() {
  return (
    <div className="mini mpick" aria-hidden="true">
      <div className="q">לכמה ערוצים לפרק?</div>
      <div className="opts o3">
        {STEM_OPTIONS.map(([n, labels]) => (
          <span className={`opt${n === 4 ? ' on' : ''}`} key={n}>
            <b>{n}</b>
            <small>{labels.replace(/ · /g, '\u00a0· ')}</small>
          </span>
        ))}
      </div>
      <div className="q">איכות</div>
      <div className="opts o2">
        <span className="opt on qa">
          <b>איכות גבוהה</b>
          <small>הכי נקי, מעט יותר איטי</small>
        </span>
        <span className="opt qa">
          <b>מהיר</b>
          <small>מהיר מאוד, איכות טובה</small>
        </span>
      </div>
      <span className="fbtn p run">
        <SlidersHorizontal {...IC} />
        הפרדת הערוצים
      </span>
    </div>
  )
}

/** Step 3: the mixer lanes, drums muted, vocals soloed off, export at the bottom. */
function MixMini() {
  return (
    <div className="mini mmix" aria-hidden="true">
      {STEMS.map((s) => {
        const Icon = STEM_ICON[s.key]
        const muted = s.key === 'd'
        return (
          <div className={`row st-${s.key}${muted ? ' off' : ''}`} key={s.key}>
            <span className="ti">
              <Icon {...IC} />
            </span>
            <span className="lb">{s.label}</span>
            <span className="wv">
              <svg viewBox={`0 0 ${BARS} 40`} preserveAspectRatio="none">
                <path d={s.wave} />
              </svg>
            </span>
            <span className="b">
              <Headphones {...IC} />
            </span>
            <span className={`b${muted ? ' mt' : ''}`}>
              {muted ? <VolumeX {...IC} /> : <Volume2 {...IC} />}
            </span>
          </div>
        )
      })}
      <div className="foot">
        <span className="rs">
          <RotateCcw {...IC} />
          איפוס המיקס
        </span>
        <span className="fbtn p">
          <Download {...IC} />
          ייצוא מיקס
        </span>
      </div>
    </div>
  )
}

export default MusicLandingPage
