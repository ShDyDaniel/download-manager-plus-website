import type { ReactNode } from 'react'
import { Check, Copy, ExternalLink, Info, Settings, ShieldCheck } from 'lucide-react'

/**
 * Shared view of the three support landings (/support, /device-check,
 * /system-check): a wide two-column card — "open the app" on one side,
 * the manual-code fallback on the other. Pure presentation: each page
 * keeps its own deep link, copy and "opened" logic and passes it in.
 * Styles: src/styles/pages/support.css (scoped per page class).
 */

const MARK = '/logo-mark.svg?v=1'

/** The app's real settings path to the code box. */
export function SupportPath() {
  return (
    <>
      <b>הגדרות</b> ← <b>תמיכה</b> ← <b>הזנת קוד תמיכה</b>
    </>
  )
}

/** Small sketch of the app's Settings → "תמיכה" section. */
export function SettingsMini({ caption }: { caption: string }) {
  return (
    <figure className="smini">
      <figcaption>{caption}</figcaption>
      <div className="win">
        <div className="bar">
          <i />
          <i />
          <i />
          <span>
            <Settings className="ic" aria-hidden />
            הגדרות
          </span>
        </div>
        <div className="sec">
          <div className="txt">
            <b>תמיכה</b>
            <small>
              קיבלת קוד מצוות התמיכה? הזינו אותו כאן. התוכנה תבדוק שהכול עובד ותשלח את התוצאה לתמיכה.
            </small>
          </div>
          <span className="fbtn">הזנת קוד תמיכה</span>
        </div>
      </div>
    </figure>
  )
}

/** Preview of the consent windows the app shows before a remote-support
 *  session starts. Text is the app's own consent copy — keep it verbatim. */
export function ConsentPreview() {
  return (
    <details className="more">
      <summary>
        <ShieldCheck className="ic" aria-hidden />
        מה בדיוק ישותף? כך ייראה החלון בתוכנה
      </summary>
      <div className="in">
        <div className="cw">
          <div className="top">
            <i />
            <i />
            <i />
          </div>
          <div className="bd">
            <h3>תמיכה מרחוק</h3>
            <p>מנהל המערכת ביקש להתחבר כדי לעזור לך לפתור תקלה.</p>
            <p>
              כל עוד החיבור פעיל, מנהל המערכת יוכל לראות ולהוריד את קובצי היומן (לוגים) של התוכנה, וכן לראות צילומי
              מסך חיים של חלון התוכנה ושל המסך שלך.
            </p>
            <p>
              כדי לזהות את התקלה מהר יותר, מנהל המערכת יכול להעביר את הלוגים ואת פרטי המחשב — ובמקרים מסוימים גם
              צילום מסך — לניתוח בשירות בינה מלאכותית חיצוני.
            </p>
            <p>מה שלא נכלל: הסיסמאות שלך, הקבצים האישיים שלך, ושליטה כלשהי במחשב מרחוק.</p>
            <p>
              החיבור פעיל רק כל עוד התוכנה פתוחה, ותוכל לעצור אותו בכל רגע בלחיצה אחת. בסיום, כל הנתונים שנאספו
              יימחקו.
            </p>
            <div className="btns">
              <span className="fb p">אני מאשר/ת חיבור תמיכה</span>
              <span className="fb s">ביטול</span>
            </div>
          </div>
        </div>
        <p className="lead-in">אם צוות התמיכה יבקש גם להריץ פקודות, יופיע חלון נפרד:</p>
        <div className="cw">
          <div className="top">
            <i />
            <i />
            <i />
          </div>
          <div className="bd">
            <h3>אישור נוסף — הרצת פקודות</h3>
            <p>מנהל המערכת מבקש הרשאה להריץ פקודות במחשב שלך כדי לאבחן ולתקן את התקלה.</p>
            <p>
              זו הרשאה חזקה: כל עוד היא פעילה, מנהל המערכת יוכל להריץ פקודות מערכת במחשב שלך מרחוק. אשר/י רק אם
              ביקשת תמיכה ואת/ה סומך/ת על מנהל המערכת.
            </p>
            <p>ההרשאה נפרדת משאר החיבור, פעילה רק בסשן הזה, ותיפסק מיד כשתעצור/י את השיתוף.</p>
            <div className="btns">
              <span className="fb p">מאשר/ת הרצת פקודות</span>
              <span className="fb s">לא, תודה</span>
            </div>
          </div>
        </div>
      </div>
    </details>
  )
}

export function SupportLanding({
  badge,
  title,
  body,
  button,
  onOpen,
  opened,
  hint,
  tail,
  code,
  copied,
  onCopy,
  extra,
}: {
  /** Small icon on the logo badge. */
  badge: ReactNode
  title: string
  body: ReactNode
  /** Label of the "open the app" button. */
  button: string
  onOpen: () => void
  /** The button was clicked → show the hint under it. */
  opened: boolean
  hint: ReactNode
  /** End of the fallback sentence, before the code ("והדביקו את הקוד:"). */
  tail: string
  code: string
  copied: boolean
  onCopy: () => void
  /** Extra content under the button (the consent preview on /support). */
  extra?: ReactNode
}) {
  return (
    <div className="wrap sl">
      <div className="card sl-card">
        <div className="sl-main">
          <div className="sl-mark">
            <img src={MARK} alt="" width={56} height={56} />
            <span className="sl-badge">{badge}</span>
          </div>
          <h1 className="sl-h">{title}</h1>
          <p className="sl-body">{body}</p>
          <button type="button" className="btn btn-p btn-lg btn-block" onClick={onOpen}>
            <ExternalLink className="ic" aria-hidden />
            {button}
          </button>
          {opened && (
            <p className="note info sl-hint" role="status">
              <Info className="ic" aria-hidden />
              <span>{hint}</span>
            </p>
          )}
          {extra}
        </div>
        <div className="sl-fb">
          <h2>התוכנה לא נפתחה?</h2>
          <p>
            פתחו את התוכנה ידנית, היכנסו ל<SupportPath />, {tail}
          </p>
          <div className="sl-code">
            <span className="code" dir="ltr">
              {code}
            </span>
            <button
              type="button"
              className={`sl-copy${copied ? ' copied' : ''}`}
              aria-label="העתק קוד"
              onClick={onCopy}
            >
              <Copy className="ic cp" aria-hidden />
              <Check className="ic ok" aria-hidden />
            </button>
          </div>
          <SettingsMini caption="כך זה נראה בהגדרות של התוכנה" />
        </div>
      </div>
      <p className="sl-foot">פריימליין · קישור זה נשלח אליך על ידי צוות התמיכה</p>
    </div>
  )
}
