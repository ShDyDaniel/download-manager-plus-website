import {
  ArrowDown,
  Camera,
  Clock,
  Download,
  Layers,
  Link as LinkIcon,
  Lock,
  MessageSquare,
  Mic,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { useDownload } from '../components/site/DownloadGate'
import { IC, LandingCta, WinTop, scrollToSection } from '../components/landings/LandingBits'
import '../styles/pages/collab.css'

/**
 * /collab — landing page for the two client-collaboration features:
 *   • סבבי תיקונים (revision rounds): a private review link where the client
 *     leaves time-stamped notes / screenshots / voice notes on the video, and
 *     the editor uploads new rounds.
 *   • מסירה ללקוח (client delivery): send the final cut behind an expiring,
 *     optionally password-protected link.
 *
 * The centerpiece is a looping mock of the review player: the playhead sweeps
 * the scrubber and each time-stamped note lights up in the player and in the
 * notes list as it's reached. Pure CSS (src/styles/pages/collab.css); under
 * reduced motion or the site's "stop animations" setting it shows the settled
 * end state (all four notes, the last one active, 4 / 4).
 */

const NOTES: { time: string; icon: LucideIcon; type: string; text: React.ReactNode }[] = [
  { time: '0:08', icon: MessageSquare, type: 'תיקון', text: 'האינטרו ארוך מדי, לחתוך פה' },
  { time: '0:24', icon: Camera, type: 'צילום מסך', text: 'הצבע חם מדי בפריים הזה' },
  {
    time: '0:39',
    icon: Mic,
    type: 'הערה קולית',
    text: (
      <>
        הערה קולית · <bdi dir="ltr">0:07</bdi>
      </>
    ),
  },
  { time: '0:54', icon: MessageSquare, type: 'תיקון', text: 'להחליף את המוזיקה מכאן' },
]
/** Where each note sits on the scrubber, in %. */
const MARKS = [13, 37, 61, 84]

const STEPS: [string, string][] = [
  ['שולחים קישור', 'יוצרים פרויקט, מעלים את הסרטון ושולחים ללקוח קישור צפייה פרטי, בלי שהוא צריך להתקין כלום.'],
  [
    'הלקוח מעיר',
    'הוא עוצר על הרגע המדויק ומשאיר הערה: טקסט, צילום מסך מסומן או הקלטה קולית. כל הערה צמודה לזמן שלה.',
  ],
  [
    'מעלים סבב',
    'עוברים על ההערות לפי הזמן, מתקנים ומעלים סבב חדש. סבבים ישנים ננעלים כך שברור מה הגרסה העדכנית.',
  ],
  ['מוסרים סופי', 'כשהכול מאושר, שולחים את הגרסה הסופית בקישור מסירה עם תוקף וסיסמה. נקי ומקצועי.'],
]

export function CollabLandingPage() {
  const { requestDownload } = useDownload()
  const download = (
    <button type="button" className="btn btn-p btn-lg" onClick={() => requestDownload()}>
      <Download {...IC} />
      הורדת המערכת
    </button>
  )

  return (
    <FlPage name="collab" title="סבבי תיקונים ומסירה ללקוח">
      <div className="wrap">
        <div className="phero">
          <span className="pill">
            כלול בתוכנית <b>Basic</b> ומעלה
          </span>
          <span className="eyebrow">עבודה מול לקוחות</span>
          <h1 className="display">מסבב ראשון למסירה סופית</h1>
          <p className="lead">
            שולחים ללקוח קישור לצפייה, והוא מעיר ישירות על הסרטון, על השנייה המדויקת. אתם מעלים סבב חדש,
            ובסוף מוסרים את הגרסה הסופית בקישור מאובטח. הכול במקום אחד, בלי קבצים שמסתובבים בוואטסאפ.
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

      <ReviewDemo />

      <div className="wrap sec">
        <div className="grid g2">
          <div className="card fcard">
            <div className="hd">
              <span className="tile">
                <MessageSquare {...IC} />
              </span>
              <h2 className="h3">סבבי תיקונים</h2>
              <span className="chip mu">Basic ומעלה</span>
            </div>
            <p>
              כל פרויקט מקבל קישור צפייה פרטי. הלקוח רואה את הסרטון, עוצר על הרגע המדויק ומשאיר הערה: בטקסט,
              בצילום מסך מסומן או בהקלטה קולית. אתם רואים הכול לפי הזמן, מעלים סבב חדש, ונועלים סבבים ישנים.
            </p>
            <RoundsMini />
          </div>
          <div className="card fcard">
            <div className="hd">
              <span className="tile g">
                <ShieldCheck {...IC} />
              </span>
              <h2 className="h3">מסירה ללקוח</h2>
              <span className="chip mu">Basic ומעלה</span>
            </div>
            <p>
              הגרסה הסופית מאושרת? שולחים אותה בקישור מסירה, עם תוקף שאתם בוחרים,{' '}
              <bdi dir="ltr">3 / 7 / 14</bdi> ימים, וסיסמה אופציונלית. הלקוח צופה ומוריד בלי אפליקציה, בלי
              הרשמה, גם מהטלפון.
            </p>
            <DeliveryMini />
          </div>
        </div>
      </div>

      <div className="wrap sec" id="how">
        <div className="sec-head">
          <span className="eyebrow">ארבעה צעדים</span>
          <h2 className="h2">ככה זה עובד</h2>
        </div>
        <ol className="grid g4 stepgrid">
          {STEPS.map(([title, text], i) => (
            <li className="card step" key={title}>
              <span className="no">{i + 1}</span>
              <h3 className="h3">{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="wrap sec">
        <div className="sec-head">
          <span className="eyebrow">מה מקבלים</span>
          <h2 className="h2">פחות הלוך ושוב, יותר עריכה</h2>
        </div>
        <div className="card caps">
          <ul className="checks">
            <li>הערות צמודות־זמן: כל פידבק קופץ לרגע המדויק בסרטון</li>
            <li>צילומי מסך מסומנים והקלטות קוליות, לא רק טקסט</li>
            <li>סבבים מרובים עם נעילת גרסאות ישנות</li>
            <li>סימן מים עם המייל של הצופה על כל פריים, פועל כברירת מחדל ואפשר לכבות אותו בכל פרויקט</li>
            <li>נגן שזורם תוך כדי טעינה, בלי לחכות שכל הקובץ יירד, גם בקבצים כבדים</li>
            <li>
              קישור מסירה עם תוקף של <bdi dir="ltr">3 / 7 / 14</bdi> ימים וסיסמה אופציונלית
            </li>
            <li>הכול עובד בדפדפן, גם מהטלפון, בלי הרשמה ללקוח</li>
            <li>הקבצים נשמרים באחסון הענן של פריימליין ונספרים במכסת האחסון של התוכנית שלכם</li>
          </ul>
        </div>
      </div>

      <LandingCta
        title="הלקוח הבא יאהב את זה"
        text="סבבי התיקונים והמסירה ללקוח הם חלק מפריימליין, מערכת ליוצרי תוכן ולעורכי וידאו. כלולים בתוכנית Basic ומעלה."
        primary={download}
      />
    </FlPage>
  )
}

/* ── Review player demo ──────────────────────────────────────────────────── */
function ReviewDemo() {
  return (
    <div className="wrap demo-wrap">
      <div
        className="win"
        role="img"
        aria-label="הדגמה: הסרטון מתנגן, וכל הערה של הלקוח מופיעה ברגע המדויק שלה בסרטון וברשימת התיקונים"
      >
        <WinTop icon={MessageSquare} title="סקירת סבב · קמפיין קיץ" />
        <div className="rvb" aria-hidden="true">
          <div className="vid">
            <div className="frame">
              <SunsetShot />
              <span className="sheen" />
              <span className="wm wm1">client@studio.com</span>
              <span className="wm wm2">PREVIEW · NOT FOR DISTRIBUTION</span>
              {NOTES.map((n, i) => (
                <div className={`bub b${i + 1}`} key={n.time}>
                  <span className="bi">
                    <n.icon {...IC} />
                  </span>
                  <span>{n.text}</span>
                </div>
              ))}
              <div className="scrub">
                <i className="fill" />
                {MARKS.map((m, i) => (
                  <b className={`mk k${i + 1}`} key={m} style={{ left: `${m}%` }} />
                ))}
                <span className="ph" />
              </div>
            </div>
          </div>
          <div className="notes">
            <div className="nh">
              <span>תיקונים</span>
              <span className="cnt">
                <bdi dir="ltr">
                  <span className="n" /> / 4
                </bdi>
              </span>
            </div>
            {NOTES.map((n, i) => (
              <div className={`nr r${i + 1}`} key={n.time}>
                <span className="ni">
                  <n.icon {...IC} />
                </span>
                <div className="nb">
                  <div className="nm">
                    <bdi dir="ltr" className="tc">
                      {n.time}
                    </bdi>
                    <span className="ty">{n.type}</span>
                  </div>
                  <p>{n.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A stand-in "frame" of the client's video: sunset over a lake, with a title card. */
function SunsetShot() {
  return (
    <svg className="shot" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="clSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2342" />
          <stop offset=".55" stopColor="#9a5263" />
          <stop offset=".78" stopColor="#f2a66a" />
        </linearGradient>
        <radialGradient id="clSun" cx="0.62" cy="0.72" r="0.35">
          <stop offset="0" stopColor="#ffe2a8" />
          <stop offset=".25" stopColor="#ffc27a" stopOpacity=".8" />
          <stop offset="1" stopColor="#ffc27a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="clLake" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e0976a" />
          <stop offset="1" stopColor="#2a1f33" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill="url(#clSky)" />
      <rect width="320" height="180" fill="url(#clSun)" />
      <circle cx="198" cy="126" r="13" fill="#fff1cf" />
      <path d="M0 118 L38 92 L70 110 L112 78 L150 104 L186 88 L226 112 L268 86 L320 108 L320 132 L0 132Z" fill="#4a2f4e" />
      <path d="M0 126 L28 112 L64 124 L98 104 L140 124 L176 112 L214 128 L262 108 L320 124 L320 132 L0 132Z" fill="#2c1d33" />
      <rect y="132" width="320" height="48" fill="url(#clLake)" />
      <g stroke="#ffe2b8" strokeOpacity=".55" strokeWidth="1.4" strokeLinecap="round">
        <path d="M178 140h40" />
        <path d="M186 147h26" />
        <path d="M191 154h16" />
      </g>
      <rect x="196" y="18" width="108" height="28" rx="4" fill="#000" fillOpacity=".35" />
      <text x="250" y="37" textAnchor="middle" fontFamily="Heebo,sans-serif" fontWeight="700" fontSize="14" fill="#fff">
        קמפיין קיץ
      </text>
    </svg>
  )
}

/** Rounds stack: a new round slides in on top and the previous one gets locked. */
function RoundsMini() {
  return (
    <div className="mini rounds" aria-hidden="true">
      <div className="rh">
        <span>גרסאות · קמפיין קיץ</span>
        <span className="up">
          <Upload {...IC} />
          סבב חדש
        </span>
      </div>
      <div className="slot">
        <div className="rw cur">
          <b className="rn">3</b>
          <span className="lb">סבב 3 · נוכחי</span>
          <Layers {...IC} />
        </div>
      </div>
      <div className="rw rprev">
        <b className="rn">2</b>
        <span className="lb">
          <span className="x1">סבב 2 · נוכחי</span>
          <span className="x2">סבב 2 · נעול</span>
        </span>
        <span className="sw">
          <Layers className="ic s1" aria-hidden />
          <Lock className="ic s2" aria-hidden />
        </span>
      </div>
      <div className="rw lk">
        <b className="rn">1</b>
        <span className="lb">סבב 1 · נעול</span>
        <Lock {...IC} />
      </div>
    </div>
  )
}

/** The delivery link card as the client receives it. */
function DeliveryMini() {
  return (
    <div className="mini md dcard" aria-hidden="true">
      <div className="f">
        <i />
        <span dir="auto">סרטון_תדמית_סופי.mp4</span>
        <em>2.1 GB</em>
      </div>
      <div className="lnk">
        <LinkIcon {...IC} />
        <bdi dir="ltr">framelineapp.com/deliver/9fb3…</bdi>
      </div>
      <div className="tags">
        <span>
          <Clock {...IC} />
          תוקף 7 ימים
        </span>
        <span>
          <Lock {...IC} />
          מוגן בסיסמה
        </span>
      </div>
      <div className="fbtn p dbtn">
        <Download {...IC} />
        הורדת הסרטון
      </div>
    </div>
  )
}

export default CollabLandingPage
