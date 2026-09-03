import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { LifeBuoy, ExternalLink, Copy, Check } from 'lucide-react'

/**
 * Live remote-support landing. The admin sends this to a user with a
 * misbehaving app. Opening it launches the desktop app via the dmplus://
 * deep link; the app then shows a consent window explaining exactly what
 * will be shared, and — only after the user approves — streams its log
 * files to the admin panel until either side stops.
 */
export default function SupportPage() {
  const { code = '' } = useParams()
  const cleanCode = useMemo(() => code.trim().toUpperCase(), [code])
  const [opened, setOpened] = useState(false)
  const [copied, setCopied] = useState(false)

  function openApp() {
    setOpened(true)
    window.location.href = `dmplus://support?code=${encodeURIComponent(cleanCode)}`
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(cleanCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked — the code is visible anyway */
    }
  }

  return (
    <div
      dir="rtl"
      className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10 text-foreground"
    >
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-7 text-center shadow-2xl shadow-black/30">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <LifeBuoy className="h-6 w-6" />
        </div>

        <h1 className="mt-4 text-2xl font-bold">תמיכה מרחוק</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          לחיצה על הכפתור תפתח את התוכנה. בתוכנה יופיע חלון שמסביר בדיוק מה
          ישותף עם צוות התמיכה — ורק אחרי שתאשרו, החיבור יתחיל. תוכלו לעצור אותו
          בכל רגע.
        </p>

        <button
          type="button"
          onClick={openApp}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <ExternalLink className="h-4 w-4" />
          פתח את התוכנה
        </button>

        {opened && (
          <p className="mt-3 text-xs text-muted-foreground">
            נפתח חלון "האם לפתוח את Download Manager Plus?". אשרו אותו, ואז אשרו
            את חלון התמיכה בתוכנה.
          </p>
        )}

        <div className="mt-7 border-t border-border pt-5 text-right">
          <p className="text-sm font-medium">התוכנה לא נפתחה?</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            פתחו את התוכנה ידנית, היכנסו להגדרות ← "תמיכה מרחוק", והדביקו את הקוד:
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code
              dir="ltr"
              className="flex-1 select-all rounded-xl border border-border bg-background px-3 py-2.5 text-center font-mono text-lg tracking-widest"
            >
              {cleanCode}
            </code>
            <button
              type="button"
              onClick={copyCode}
              aria-label="העתק קוד"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      <p className="mt-5 text-center text-[11px] text-muted-foreground/70">
        Download Manager Plus · קישור זה נשלח אליך על ידי צוות התמיכה
      </p>
    </div>
  )
}
