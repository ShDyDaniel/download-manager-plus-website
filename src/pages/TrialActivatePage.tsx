import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Gift,
  Loader2,
  Mail,
  Unlink,
} from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import '../styles/pages/trial.css'

/**
 * Trial activation landing — opened from the desktop app's user menu
 * ("קבלת 7 ימי ניסיון חינם"). The app passes the Firebase ID token AND the
 * OS device id on the URL fragment (#t=…&d=…) — the fragment never reaches
 * the server, and we scrub it immediately. We POST both to /api/start-trial
 * (the device id is required for the trial's device fingerprint, which a
 * browser can't read on its own), then show the result here. The app itself
 * shows no activation toast — this page is the single confirmation surface.
 */
type State =
  | { kind: 'loading' }
  | { kind: 'success'; expiresAt: string | null }
  | { kind: 'again'; date: string }
  | { kind: 'used'; msg: string; once: boolean }
  | { kind: 'error'; msg: string }
  | { kind: 'invalid' }

/** Remembers a successful activation for this tab only, so a refresh (the
 *  fragment is gone by then) says "already active" instead of "invalid link".
 *  Holds only the expiry date — never the token or the device id. */
const ACTIVATED_KEY = 'fl.trialActivated.v1'
const HELP = 'help.frameline@gmail.com'
const MARK = '/logo-mark.svg?v=1'

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
}

function readActivated(): { expiresAt: string | null } | null {
  try {
    const raw = sessionStorage.getItem(ACTIVATED_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { expiresAt?: unknown }
    return { expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : null }
  } catch {
    return null
  }
}

function rememberActivated(expiresAt: string | null) {
  try {
    sessionStorage.setItem(ACTIVATED_KEY, JSON.stringify({ expiresAt }))
  } catch {
    /* storage blocked — a refresh just shows the invalid-link card */
  }
}

/** The server's answer → the approved Hebrew wording and the right card.
 *  Raw English (a server crash) never reaches the visitor. */
function fromServer(raw: string | undefined): State {
  const s = (raw || '').trim()
  const has = (x: string) => s.includes(x)
  if (has('מנוי Pro פעיל')) return { kind: 'used', msg: 'כבר יש לכם מנוי Pro פעיל, אז אין צורך בניסיון.', once: false }
  if (has('ניסיון פעיל עד')) {
    const m = /(\d{1,2}[./]\d{1,2}[./]\d{4})/.exec(s)
    return { kind: 'again', date: m ? m[1] : '' }
  }
  if (has('המייל הזה כבר ניצל')) return { kind: 'used', msg: 'המייל הזה כבר ניצל ניסיון חינם בעבר.', once: true }
  if (has('המחשב הזה כבר ניצל')) return { kind: 'used', msg: 'המחשב הזה כבר ניצל ניסיון חינם בעבר.', once: true }
  if (has('לאמת את כתובת המייל'))
    return { kind: 'used', msg: 'צריך לאמת את כתובת המייל לפני שמתחילים את תקופת הניסיון.', once: false }
  if (has('אימות נכשל')) return { kind: 'error', msg: 'האימות נכשל. התחברו מחדש בתוכנה ונסו שוב.' }
  if (has('אסימון אימות חסר')) return { kind: 'error', msg: 'חסרים פרטי אימות בקישור. פתחו אותו שוב מתוך התוכנה.' }
  if (has('לא ניתן לאמת את המחשב'))
    return { kind: 'error', msg: 'לא הצלחנו לזהות את המחשב. הפעילו מחדש את התוכנה ונסו שוב.' }
  if (has('לא נמצא מייל')) return { kind: 'error', msg: `לא מצאנו מייל בחשבון. כתבו לנו: ${HELP}` }
  if (has('המשתמש לא נמצא')) return { kind: 'error', msg: 'החשבון לא נמצא. התחברו מחדש בתוכנה ונסו שוב.' }
  // Unknown Hebrew text is shown as-is; anything else gets the generic line.
  if (s && /[֐-׿]/.test(s)) return { kind: 'error', msg: s }
  return { kind: 'error', msg: 'הפעלת הניסיון נכשלה. נסו שוב מאוחר יותר.' }
}

export default function TrialActivatePage() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const raw = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash
    const params = new URLSearchParams(raw)
    const idToken = params.get('t') || ''
    const deviceId = params.get('d') || ''
    // Scrub the token + device id from the address bar right away.
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* ignore */
    }

    if (!idToken || !deviceId) {
      // A refresh after a successful activation lands here (the fragment is
      // gone): say it's already active rather than "invalid link".
      const prev = readActivated()
      setState(prev ? { kind: 'again', date: fmtDate(prev.expiresAt) } : { kind: 'invalid' })
      return
    }

    ;(async () => {
      try {
        const res = await fetch('/api/start-trial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, deviceId }),
        })
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          expiresAt?: string
        }
        if (res.ok && json.ok) {
          rememberActivated(json.expiresAt ?? null)
          setState({ kind: 'success', expiresAt: json.expiresAt ?? null })
        } else {
          setState(fromServer(json.error))
        }
      } catch {
        setState({
          kind: 'error',
          msg: 'שגיאת רשת. בדקו את החיבור לאינטרנט, ואז פתחו שוב את הקישור מתוך התוכנה.',
        })
      }
    })()
  }, [])

  const badge = (cls: string, icon: React.ReactNode) => (
    <div className="tr-mark">
      <img src={MARK} alt="" width={68} height={68} />
      <span className={`tr-badge ${cls}`}>{icon}</span>
    </div>
  )

  return (
    <FlPage name="trial" chrome="min" title="שבוע ניסיון">
      <div className="tr-wrap">
        {state.kind === 'loading' && (
          <div className="card tr-card" role="status" aria-live="polite">
            {badge('spin', <Loader2 className="ic" aria-hidden />)}
            <h1 className="tr-h">מפעילים את הניסיון…</h1>
            <p className="tr-p">רגע אחד.</p>
          </div>
        )}

        {state.kind === 'success' && (
          <div className="card tr-card">
            {badge('ok', <Gift className="ic" aria-hidden />)}
            <h1 className="tr-h">שבוע הניסיון הופעל</h1>
            <p className="tr-p">
              {fmtDate(state.expiresAt) ? (
                <>
                  קיבלתם 7 ימי Pro, בתוקף עד <bdi className="num tr-date">{fmtDate(state.expiresAt)}</bdi>.
                </>
              ) : (
                'קיבלתם 7 ימי Pro.'
              )}
            </p>
            <div className="note ok tr-note">
              <CheckCircle2 className="ic" aria-hidden />
              <span>
                <b>הכל מוכן.</b> אפשר לסגור את הדף ולחזור לתוכנה.
              </span>
            </div>
          </div>
        )}

        {state.kind === 'again' && (
          <div className="card tr-card">
            {badge('ok', <Check className="ic" aria-hidden />)}
            <h1 className="tr-h">שבוע הניסיון כבר פעיל</h1>
            <p className="tr-p">
              {state.date ? (
                <>
                  הניסיון שלכם בתוקף עד <bdi className="num tr-date">{state.date}</bdi>.
                </>
              ) : (
                'הניסיון שלכם כבר פעיל.'
              )}{' '}
              אין צורך לעשות שום דבר נוסף.
            </p>
            <div className="note tr-note">
              <CheckCircle2 className="ic" aria-hidden />
              <span>אפשר לסגור את הדף ולחזור לתוכנה.</span>
            </div>
          </div>
        )}

        {state.kind === 'used' && (
          <div className="card tr-card">
            {badge('warn', <AlertCircle className="ic" aria-hidden />)}
            <h1 className="tr-h">לא ניתן להפעיל ניסיון</h1>
            <p className="tr-p">{state.msg}</p>
            {state.once && (
              <>
                <p className="tr-fine">שבוע הניסיון ניתן פעם אחת לכל חשבון ולכל מחשב.</p>
                <div className="tr-btns">
                  <Link className="btn btn-p btn-block" to="/buy">
                    למסלולים ולמחירים
                  </Link>
                </div>
              </>
            )}
            <div className="note tr-note">
              <CheckCircle2 className="ic" aria-hidden />
              <span>{state.once ? 'אפשר גם לסגור את הדף ולחזור לתוכנה.' : 'אפשר לסגור את הדף ולחזור לתוכנה.'}</span>
            </div>
          </div>
        )}

        {state.kind === 'invalid' && (
          <div className="card tr-card">
            {badge('err', <Unlink className="ic" aria-hidden />)}
            <h1 className="tr-h">קישור לא תקין</h1>
            <p className="tr-p">את שבוע הניסיון מפעילים מתוך התוכנה:</p>
            <ul className="tr-where">
              <li>
                <Check className="ic" aria-hidden />
                <span>
                  בתפריט המשתמש ← <span className="ui">קבלת 7 ימי ניסיון חינם</span>
                </span>
              </li>
              <li>
                <Check className="ic" aria-hidden />
                <span>
                  או בכפתור <span className="ui">הפעלת 7 ימי ניסיון</span> שמופיע ליד כלי נעול
                </span>
              </li>
            </ul>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="card tr-card">
            {badge('err', <AlertTriangle className="ic" aria-hidden />)}
            <h1 className="tr-h">לא הצלחנו להפעיל את הניסיון</h1>
            <p className="tr-p" role="alert">
              {state.msg}
            </p>
            <div className="note tr-note">
              <Mail className="ic" aria-hidden />
              <span>
                אם זה חוזר, כתבו לנו:{' '}
                <a className="link" href={`mailto:${HELP}`}>
                  {HELP}
                </a>
              </span>
            </div>
          </div>
        )}

        <p className="tr-word">
          <bdi>Frameline</bdi>
        </p>
      </div>
    </FlPage>
  )
}
