import {
  Check,
  Download,
  Laptop,
  Loader2,
  Lock,
  Monitor,
  Package,
  RefreshCw,
  Share,
  Shield,
  Smartphone,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getSession } from '../lib/webSession'
import { FlPage } from '../components/site/FlPage'
import { Seg } from '../components/site/Seg'
import { useDownload } from '../components/site/DownloadGate'
import '../styles/pages/install.css'

/**
 * Install / first-launch page, reached right after the account gate (see
 * DownloadGate). The download starts AUTOMATICALLY here — but via a location
 * navigation to the file, NOT a programmatic anchor click. Chrome flags a
 * scripted `a.click()` cross-origin download as "Unverified download
 * blocked"; a navigation to a URL that the server serves with
 * Content-Disposition: attachment (GitHub does) downloads exactly like a
 * normal click and isn't flagged. The page also shows the one-time
 * first-launch steps per platform, and a real download button (a plain link
 * the visitor clicks) in case the automatic one was blocked or cancelled.
 * The download is gated behind a logged-in session.
 */
// Last-resort download URLs, used ONLY if the live latest-release lookup
// fails entirely (e.g. the network is down). In normal operation the page
// ALWAYS resolves the newest published version live from appReleases/latest,
// so these are just a safety net — not the thing users usually get.
// NOTE: newest release that actually exists on GitHub. Releases built after
// the rename are named Frameline-<version>-<arch>.<ext>; point these at one
// once it is published.
const FALLBACK_MAC =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases/download/1.9.511/Download.Manager.Plus-1.9.511-arm64.pkg'
const FALLBACK_WIN =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases/download/1.9.511/Download.Manager.Plus-1.9.511-x64.exe'

const MARK = '/logo-mark.svg?v=1'
const HELP = 'help.frameline@gmail.com'

type Platform = 'mac' | 'win'
type Release = { macUrl: string; winUrl: string; version: string }

function urlFor(rel: Release | null, p: Platform): string {
  if (!rel) return ''
  return p === 'mac' ? rel.macUrl || FALLBACK_MAC : rel.winUrl || FALLBACK_WIN
}

/** "Frameline-1.9.530-arm64.pkg" from the release URL. */
function fileNameOf(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').pop() || ''
    return decodeURIComponent(last)
  } catch {
    return ''
  }
}

/** Version from GitHub's /releases/download/<version>/ path. */
function versionOf(url: string): string {
  const m = /\/releases\/download\/v?([^/]+)\//.exec(url)
  return m ? decodeURIComponent(m[1]) : ''
}

/** Phones and tablets can't run the app. iPadOS Safari reports a Mac UA, so
 *  a "Macintosh" with a touch screen is an iPad. */
function isPhoneOrTablet(): boolean {
  const ua = navigator.userAgent
  return (
    /iPhone|iPad|iPod|Android/i.test(ua) ||
    (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1)
  )
}

export default function InstallPage() {
  const location = useLocation()
  const { requestDownload } = useDownload()
  // Gate the download behind a real account — a visitor who just opens
  // /install directly (no session) gets a "please sign in" view instead of
  // the file. The download is tied to being logged in, not to knowing the URL.
  const loggedIn = Boolean(getSession())
  const [phone] = useState(isPhoneOrTablet)

  // The chosen platform is passed from the download button. Previously the
  // Hero passed a concrete URL (pre-fetched or a hardcoded fallback), which
  // meant a user who clicked before the home page's fetch landed got a STALE
  // version — the reported "sometimes downloads an old version" bug. Now the
  // button passes only the platform and THIS page resolves the URL fresh, so
  // the newest published version is served every time. Fall back to a UA
  // sniff for a direct /install visit with no state.
  const state = location.state as { platform?: Platform } | null
  const detected: Platform =
    state?.platform === 'mac'
      ? 'mac'
      : state?.platform === 'win'
        ? 'win'
        : /Mac/i.test(navigator.userAgent)
          ? 'mac'
          : 'win'
  // The Mac / Windows switch. Until the visitor uses it, follow `detected`.
  const [chosen, setChosen] = useState<Platform | null>(null)
  const platform = chosen ?? detected
  const platformRef = useRef(platform)
  platformRef.current = platform

  // ALWAYS resolve the latest published release at download time — never a
  // value pre-fetched on another page. This is what guarantees the newest
  // version. Only when logged in on a computer (no point fetching for a
  // visitor who can't download). If the lookup fails, use the safety-net URL.
  const [release, setRelease] = useState<Release | null>(null)
  // URL of the automatic download: the platform at the moment the release
  // resolved. Set once, so flipping the switch never restarts it.
  const [autoUrl, setAutoUrl] = useState('')
  useEffect(() => {
    if (!loggedIn || phone) return
    let active = true
    const done = (rel: Release) => {
      if (!active) return
      setRelease(rel)
      setAutoUrl((cur) => cur || urlFor(rel, platformRef.current))
    }
    fetch('/api/paypal?action=get-latest-release')
      .then((r) => r.json())
      .then((d: { release?: { macUrl?: string; winUrl?: string; version?: string } }) =>
        done({
          macUrl: d?.release?.macUrl || '',
          winUrl: d?.release?.winUrl || '',
          version: d?.release?.version || '',
        }),
      )
      .catch(() => done({ macUrl: '', winUrl: '', version: '' }))
    return () => {
      active = false
    }
  }, [loggedIn, phone])

  // Auto-start the download once we have the URL — ONLY for a logged-in user,
  // via navigation (not a scripted anchor click). The attachment response
  // downloads the file and leaves this page in place.
  const started = useRef(false)
  useEffect(() => {
    if (!loggedIn || !autoUrl || started.current) return
    started.current = true
    const t = setTimeout(() => {
      window.location.href = autoUrl
    }, 600)
    return () => clearTimeout(t)
  }, [loggedIn, autoUrl])

  if (!loggedIn) {
    return (
      <FlPage name="install" chrome="min" title="התקנת התוכנה">
        <div className="in-wrap">
          <div className="in-state">
            <div className="card in-card in-small">
              <div className="in-mark">
                <img src={MARK} alt="" width={68} height={68} />
                <span className="in-badge">
                  <Lock className="ic" aria-hidden />
                </span>
              </div>
              <h1 className="in-h">צריך להתחבר כדי להוריד</h1>
              <p className="in-lead">
                ההורדה זמינה רק לחשבון מחובר. התחברו או צרו חשבון, וההורדה תתחיל אוטומטית.
              </p>
              <div className="in-btns">
                <button
                  type="button"
                  className="btn btn-p btn-block btn-lg"
                  onClick={() => requestDownload(state?.platform)}
                >
                  התחברות או הרשמה
                </button>
                <Link className="btn btn-g btn-block" to="/">
                  למעבר לדף הבית
                </Link>
              </div>
              <p className="in-fine">פתחתם את העמוד בלשונית חדשה? צריך להתחבר גם בה.</p>
            </div>
          </div>
        </div>
      </FlPage>
    )
  }

  if (phone) {
    return (
      <FlPage name="install" chrome="min" title="התקנת התוכנה">
        <div className="in-wrap">
          <div className="in-state">
            <PhoneCard />
          </div>
        </div>
      </FlPage>
    )
  }

  const mac = platform === 'mac'
  const url = urlFor(release, platform)
  const fileName = url ? fileNameOf(url) : ''
  const version = release ? release.version || versionOf(url) : ''
  const isAuto = !chosen || chosen === detected
  // The installed app is called Frameline only from the renamed builds on.
  const framelineBuild = /^frameline/i.test(fileName)

  return (
    <FlPage name="install" chrome="min" title="התקנת התוכנה">
      <div className="in-wrap">
        <div className="in-state">
          <div className="card in-card">
            <div className="in-mark">
              <img src={MARK} alt="" width={68} height={68} />
              <span className="in-badge ok">
                <Check className="ic" aria-hidden />
              </span>
            </div>
            {isAuto && (
              <span className="chip ok in-started" role="status">
                <Check className="ic" aria-hidden />
                ההורדה מתחילה אוטומטית
              </span>
            )}
            <h1 className="in-h">
              {mac ? 'התקנת התוכנה בפעם הראשונה ב-Mac' : 'התקנת התוכנה בפעם הראשונה ב-Windows'}
            </h1>
            <p className="in-lead">רק שלב קטן וחד-פעמי לפני שמתחילים.</p>

            <div className="in-dl">
              <div className="in-os">
                <span>המחשב שלכם</span>
                <Seg
                  value={platform}
                  onChange={(v) => setChosen(v)}
                  label="המחשב שלכם"
                  options={[
                    { value: 'mac', label: 'Mac' },
                    { value: 'win', label: 'Windows' },
                  ]}
                />
              </div>
              <div className="in-file">
                <span className="in-fico">
                  <Package className="ic" aria-hidden />
                </span>
                <div className="in-fname">
                  <bdi>{fileName || (mac ? 'קובץ ההתקנה ל-Mac' : 'קובץ ההתקנה ל-Windows')}</bdi>
                  <small>
                    {version && (
                      <>
                        גרסה <bdi className="num">{version}</bdi> ·{' '}
                      </>
                    )}
                    {mac ? (
                      'Mac עם שבב M1 ומעלה'
                    ) : (
                      <>
                        <bdi>Windows 10/11</bdi> · 64 ביט
                      </>
                    )}
                  </small>
                </div>
                {url ? (
                  <a className="btn btn-p in-dlbtn" href={url}>
                    <Download className="ic" aria-hidden />
                    {mac ? 'הורדה ל-Mac' : 'הורדה ל-Windows'}
                  </a>
                ) : (
                  <span className="btn btn-p in-dlbtn in-wait" aria-disabled="true">
                    <Loader2 className="ic in-spin" aria-hidden />
                    {mac ? 'הורדה ל-Mac' : 'הורדה ל-Windows'}
                  </span>
                )}
              </div>
            </div>
            {isAuto && <p className="in-fine">ההורדה לא התחילה? לחצו על הכפתור.</p>}
          </div>

          {mac ? <MacSetup fileName={fileName} /> : <WindowsSetup fileName={fileName} />}

          <p className="in-after">
            {framelineBuild && (
              <>
                אחרי ההתקנה התוכנה תופיע במחשב בשם <bdi className="in-name">Frameline</bdi>.
                <br />
              </>
            )}
            נתקעתם? כתבו לנו:{' '}
            <a className="link" href={`mailto:${HELP}`}>
              {HELP}
            </a>
          </p>
        </div>
      </div>
    </FlPage>
  )
}

function OnceNote() {
  return (
    <div className="note ok">
      <RefreshCw className="ic" aria-hidden />
      <span>
        <b>זה קורה פעם אחת בלבד.</b> כל העדכונים הבאים יותקנו אוטומטית ובצורה חלקה, בלי ההודעה הזו.
      </span>
    </div>
  )
}

function MacSetup({ fileName }: { fileName: string }) {
  const f = fileName || 'Frameline.pkg'
  return (
    <section className="card in-card in-setup" aria-labelledby="in-mac-setup-h">
      <h2 className="in-h2" id="in-mac-setup-h">
        פתיחה ראשונה
      </h2>
      <div className="note info">
        <Shield className="ic" aria-hidden />
        <span>
          בפתיחה הראשונה ייתכן שתראו <bdi className="nw">“Apple could not verify…”</bdi>. זה תקין לחלוטין.
          ההודעה מופיעה רק כי התוכנה עדיין לא רשומה בשרתים של אפל. התוכנה עצמה בטוחה לשימוש.
        </span>
      </div>

      <ol className="steps in-steps">
        <li>
          <b>פתחו את קובץ ההתקנה</b>
          <p>
            {fileName ? (
              <>
                לחצו פעמיים על הקובץ שהורד, <bdi className="in-code">{fileName}</bdi>.
              </>
            ) : (
              <>
                לחצו פעמיים על הקובץ שהורד (<bdi className="in-code">.pkg</bdi>).
              </>
            )}{' '}
            אם ההתקנה נפתחת כרגיל, מצוין, סיימתם.
          </p>
        </li>
        <li>
          <b>
            אם הופיעה ההודעה <bdi className="nw">“Apple could not verify”</bdi>
          </b>
          <p>
            לחצו על <bdi className="ui">Done</bdi>, לא על <bdi className="ui">Move to Trash</bdi>. זה לא מוחק
            כלום, רק סוגר את ההודעה.
          </p>
          <div
            className="mk-mac"
            role="img"
            aria-label="דוגמה להודעה של macOS: Apple could not verify, עם הכפתורים Done ו-Move to Trash. לוחצים על Done."
          >
            <div className="mm-ico">
              <Package className="ic" aria-hidden />
            </div>
            <div className="mm-t">“{f}” Not Opened</div>
            <div className="mm-p">
              Apple could not verify “{f}” is free of malware that may harm your Mac or compromise your
              privacy.
            </div>
            <div className="mm-btns">
              <span className="mm-b">Move to Trash</span>
              <span className="mm-b def hl">Done</span>
            </div>
          </div>
        </li>
        <li>
          <b>אשרו את הפתיחה בהגדרות</b>
          <p>
            פתחו את <span className="ui">הגדרות מערכת</span> ← <span className="ui">פרטיות ואבטחה</span>, וגללו
            לתחתית הדף, לאזור <span className="ui">אבטחה</span>. לחצו על <span className="ui">פתח בכל זאת</span>,
            אשרו שוב ב<span className="ui">פתח בכל זאת</span>, והזדהו עם Touch ID או סיסמה.
          </p>
          <p className="in-en">
            אם המחשב באנגלית:{' '}
            <bdi className="in-path">System Settings → Privacy &amp; Security → Open Anyway</bdi>
          </p>
          <div
            className="mk-set"
            role="img"
            aria-label="דוגמה למסך פרטיות ואבטחה ב-macOS: הקובץ נחסם, ולידו הכפתור Open Anyway."
          >
            <div className="ms-bar">
              <i />
              <i />
              <i />
              <span>Privacy &amp; Security</span>
            </div>
            <div className="ms-body">
              <div className="ms-sec">Security</div>
              <div className="ms-row">
                <span>“{f}” was blocked to protect your Mac.</span>
                <span className="mm-b hl">Open Anyway</span>
              </div>
            </div>
          </div>
        </li>
      </ol>

      <OnceNote />
    </section>
  )
}

function WindowsSetup({ fileName }: { fileName: string }) {
  const f = fileName || 'Frameline.exe'
  return (
    <section className="card in-card in-setup" aria-labelledby="in-win-setup-h">
      <h2 className="in-h2" id="in-win-setup-h">
        פתיחה ראשונה
      </h2>
      <div className="note info">
        <Shield className="ic" aria-hidden />
        <span>
          <b>למה תופיע הודעה של Windows?</b>
          <br />
          בהפעלה הראשונה ייתכן שיופיע <bdi className="nw">“Windows protected your PC”</bdi>. זה תקין, התוכנה
          בטוחה, וההודעה מופיעה רק כי התוכנה עדיין לא חתומה אצל Microsoft.
        </span>
      </div>

      <ol className="steps in-steps">
        <li>
          <b>פתחו את קובץ ההתקנה</b>
          <p>
            {fileName ? (
              <>
                לחצו פעמיים על הקובץ שהורד, <bdi className="in-code">{fileName}</bdi>.
              </>
            ) : (
              <>
                לחצו פעמיים על הקובץ שהורד (<bdi className="in-code">.exe</bdi>).
              </>
            )}
          </p>
        </li>
        <li>
          <b>
            אם הופיע <bdi className="nw">“Windows protected your PC”</bdi>
          </b>
          <p>
            לחצו על <bdi className="ui">More info</bdi>, ואז על <bdi className="ui">Run anyway</bdi>.
          </p>
          <p className="in-en">
            אם המחשב בעברית: <span className="ui">מידע נוסף</span> ← <span className="ui">הפעל בכל זאת</span>
          </p>
          <div className="mk-win2">
            <figure
              className="mk-win"
              role="img"
              aria-label="דוגמה להודעה של Windows: Windows protected your PC, עם הקישור More info."
            >
              <span className="mw-n">1</span>
              <div className="mw-t">Windows protected your PC</div>
              <div className="mw-p">
                Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app
                might put your PC at risk.
              </div>
              <div className="mw-p">
                <span className="mw-link hl">More info</span>
              </div>
              <div className="mw-btns">
                <span className="mw-b">Don’t run</span>
              </div>
            </figure>
            <figure
              className="mk-win"
              role="img"
              aria-label="אחרי הלחיצה על More info מופיע הכפתור Run anyway. לוחצים עליו."
            >
              <span className="mw-n">2</span>
              <div className="mw-t">Windows protected your PC</div>
              <div className="mw-p">
                Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app
                might put your PC at risk.
              </div>
              <dl className="mw-dl">
                <dt>App:</dt>
                <dd>{f}</dd>
                <dt>Publisher:</dt>
                <dd>Unknown publisher</dd>
              </dl>
              <div className="mw-btns">
                <span className="mw-b hl">Run anyway</span>
                <span className="mw-b">Don’t run</span>
              </div>
            </figure>
          </div>
        </li>
      </ol>

      <OnceNote />
    </section>
  )
}

/** Phones and tablets: the app runs on a computer, so point them there. */
function PhoneCard() {
  const [copied, setCopied] = useState(false)
  async function share() {
    // The home page, keeping a partner ?ref= if the address bar carries one.
    const link = `${window.location.origin}/${window.location.search}`
    try {
      if (navigator.share) {
        await navigator.share({ title: 'פריימליין', url: link })
        return
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      /* no share sheet and no clipboard — the address is written on the page */
    }
  }
  return (
    <div className="card in-card in-small">
      <div className="in-mark">
        <img src={MARK} alt="" width={68} height={68} />
        <span className="in-badge">
          <Smartphone className="ic" aria-hidden />
        </span>
      </div>
      <h1 className="in-h">פריימליין רץ על מחשב</h1>
      <p className="in-lead">פתחו את העמוד הזה במחשב Mac או Windows כדי להוריד את התוכנה.</p>
      <div className="in-req">
        <div>
          <Laptop className="ic" aria-hidden />
          <span>Mac עם שבב M1 ומעלה</span>
        </div>
        <div>
          <Monitor className="ic" aria-hidden />
          <span>
            <bdi>Windows 10/11</bdi> בגרסת 64 ביט
          </span>
        </div>
      </div>
      <p className="in-body">
        במחשב, היכנסו ל-<bdi className="in-name">www.framelineapp.com</bdi>, התחברו עם אותו חשבון ולחצו על
        הורדה חינם.
      </p>
      <div className="in-btns">
        <button type="button" className="btn btn-s btn-block" onClick={share}>
          {copied ? <Check className="ic" aria-hidden /> : <Share className="ic" aria-hidden />}
          {copied ? 'הקישור הועתק' : 'שיתוף הקישור'}
        </button>
      </div>
      <p className="in-fine" role="status">
        אפשר לשלוח את הקישור לעצמכם, ולפתוח אותו אחר כך במחשב.
      </p>
    </div>
  )
}
