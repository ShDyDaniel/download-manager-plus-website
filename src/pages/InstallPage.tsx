import {
  ShieldCheck,
  Settings,
  MousePointerClick,
  RefreshCw,
  Lock,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getSession } from '../lib/webSession'

/**
 * Install / first-launch page, reached right after the account gate (see
 * Hero). The download starts AUTOMATICALLY here — but via a location
 * navigation to the file, NOT a programmatic anchor click. Chrome flags a
 * scripted `a.click()` cross-origin download as "Unverified download
 * blocked"; a navigation to a URL that the server serves with
 * Content-Disposition: attachment (GitHub does) downloads exactly like a
 * normal click and isn't flagged. The page also shows the one-time
 * first-launch steps per platform. The download is gated behind a
 * logged-in session.
 */
export default function InstallPage() {
  const location = useLocation()
  // Gate the download behind a real account — a visitor who just opens
  // /install directly (no session) gets a "please sign in" view instead of
  // the file. The download is tied to being logged in, not to knowing the URL.
  const loggedIn = Boolean(getSession())
  const [dl, setDl] = useState<string>(
    (location.state as { dl?: string } | null)?.dl || '',
  )
  const isMac = dl
    ? /\.(pkg|dmg)(\?|#|$)/i.test(dl)
    : /Mac/i.test(navigator.userAgent)

  // Direct visit / refresh → no state. Pull the latest published release —
  // only when logged in (no point fetching for a visitor who can't download).
  useEffect(() => {
    if (!loggedIn || dl) return
    fetch('/api/paypal?action=get-latest-release')
      .then((r) => r.json())
      .then((d: { release?: { macUrl?: string; winUrl?: string } }) => {
        const u = isMac ? d?.release?.macUrl : d?.release?.winUrl
        if (u) setDl(u)
      })
      .catch(() => {})
  }, [loggedIn, dl, isMac])

  // Auto-start the download once we have the URL — ONLY for a logged-in user,
  // via navigation (not a scripted anchor click). The attachment response
  // downloads the file and leaves this page in place.
  const started = useRef(false)
  useEffect(() => {
    if (!loggedIn || !dl || started.current) return
    started.current = true
    const t = setTimeout(() => {
      window.location.href = dl
    }, 600)
    return () => clearTimeout(t)
  }, [loggedIn, dl])

  if (!loggedIn) {
    return (
      <div
        dir="rtl"
        className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 text-foreground"
      >
        <div className="w-full max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Lock className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-2xl font-bold">צריך להתחבר כדי להוריד</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            ההורדה זמינה רק לאחר התחברות לחשבון. עברו לדף הבית, התחברו או צרו
            חשבון, וההורדה תתחיל אוטומטית.
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex items-center justify-center rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            למעבר לדף הבית
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div
      dir="rtl"
      className="flex min-h-dvh flex-col items-center bg-background px-4 py-12 text-foreground"
    >
      <div className="w-full max-w-lg">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>

        <h1 className="mt-4 text-center text-2xl font-bold">
          {isMac
            ? 'פתיחת התוכנה בפעם הראשונה ב-Mac'
            : 'התקנת התוכנה ב-Windows'}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground">
          ההורדה מתחילה אוטומטית ✓ — רק שלב קטן וחד-פעמי לפני שמתחילים.
        </p>

        {isMac ? <MacSteps /> : <WindowsSteps />}

        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-success/30 bg-success/[0.06] p-4">
          <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="text-sm leading-relaxed text-foreground">
            <span className="font-semibold">זה קורה פעם אחת בלבד.</span>{' '}
            כל העדכונים הבאים יותקנו אוטומטית ובצורה חלקה — בלי ההודעה הזו.
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">
          Download Manager Plus
        </p>
      </div>
    </div>
  )
}

function MacSteps() {
  return (
    <>
      <div className="mt-6 rounded-2xl border border-border bg-card p-5">
        <p className="text-sm font-medium leading-relaxed text-foreground">
          בפתיחה הראשונה ייתכן שתראו "Apple could not verify…". זה תקין לחלוטין.
          ההודעה מופיעה רק בגלל שהיא לא מוגדרת בשרתים של אפל. התוכנה עצמה בטוחה
          לשימוש.
        </p>
      </div>
      <div className="mt-4 space-y-3">
        <Step
          icon={<MousePointerClick className="h-4 w-4 text-accent" />}
          title="1. פתחו את קובץ ההתקנה"
          body="לחצו פעמיים על הקובץ שהורד (‎.pkg‎). אם הוא נפתח רגיל — מצוין, סיימתם."
        />
        <Step
          icon={<MousePointerClick className="h-4 w-4 text-accent" />}
          title='2. אם הופיעה ההודעה "Apple could not verify"'
          body='לחצו "Done" (לא "Move to Trash"). זה לא מוחק כלום — רק סוגר את ההודעה.'
        />
        <Step
          icon={<Settings className="h-4 w-4 text-accent" />}
          title="3. אשרו את הפתיחה בהגדרות"
          body='הגדרות מערכת ← פרטיות ואבטחה ← גללו לתחתית הדף לאזור "אבטחה" (Security) ← לחצו "פתח בכל זאת" (Open Anyway) ← אשרו ב"פתח בכל זאת" שוב (Open Anyway) והזדהו עם Touch ID או סיסמה.'
        />
      </div>
    </>
  )
}

function WindowsSteps() {
  return (
    <>
      <div className="mt-6 rounded-2xl border border-border bg-card p-5">
        <div className="text-sm font-semibold">
          למה תופיע הודעה של Windows?
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          בהפעלה הראשונה ייתכן שיופיע "Windows protected your PC". זה תקין —
          התוכנה בטוחה, וההודעה מופיעה רק מכיוון שהיא עדיין לא חתומה ב-Microsoft.
        </p>
      </div>
      <div className="mt-4 space-y-3">
        <Step
          icon={<MousePointerClick className="h-4 w-4 text-accent" />}
          title="1. פתחו את קובץ ההתקנה"
          body="לחצו פעמיים על הקובץ שהורד (‎.exe‎)."
        />
        <Step
          icon={<Settings className="h-4 w-4 text-accent" />}
          title='2. אם הופיע "Windows protected your PC"'
          body='לחצו "More info" (מידע נוסף) ← ואז "Run anyway" (הפעל בכל זאת).'
        />
      </div>
    </>
  )
}

function Step({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </div>
  )
}
