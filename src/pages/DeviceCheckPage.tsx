import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { MonitorSmartphone, ExternalLink, Copy, Check } from 'lucide-react'

/**
 * Support device-check landing. A user who can't get a free trial (because
 * an OLD account on the same machine already used one) gets this link from
 * support. Two ways to report the machine's signature:
 *   1. Click "open the app" → the dmplus:// deep link launches the desktop
 *      app, which reports the device signature automatically.
 *   2. Backup — copy the code and paste it into the app's
 *      "אימות מחשב לתמיכה" screen.
 * The matched account shows up only in the admin panel, never here.
 */
export default function DeviceCheckPage() {
  const { code = '' } = useParams()
  const cleanCode = useMemo(() => code.trim().toUpperCase(), [code])
  const [opened, setOpened] = useState(false)
  const [copied, setCopied] = useState(false)

  function openApp() {
    setOpened(true)
    // Trigger the custom-protocol deep link. The OS asks the user to
    // confirm opening the desktop app; if it's not installed nothing
    // happens and they fall back to the manual code below.
    window.location.href = `dmplus://device-check?code=${encodeURIComponent(
      cleanCode,
    )}`
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
          <MonitorSmartphone className="h-6 w-6" />
        </div>

        <h1 className="mt-4 text-2xl font-bold">אימות לתמיכה</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          חתימת המחשב תישלח למערכת כדי לבדוק אם נפתח חשבון על המחשב הזה בעבר.
        </p>

        <button
          type="button"
          onClick={openApp}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <ExternalLink className="h-4 w-4" />
          פתח את התוכנה ושלח אוטומטית
        </button>

        {opened && (
          <p className="mt-3 text-xs text-muted-foreground">
            נפתח חלון "האם לפתוח את Download Manager Plus?" — אשרו אותו כדי
            לשלוח. אפשר לסגור את הדף הזה לאחר מכן.
          </p>
        )}

        {/* ── Backup: manual code ── */}
        <div className="mt-7 border-t border-border pt-5 text-right">
          <p className="text-sm font-medium">התוכנה לא נפתחה?</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            פתחו את התוכנה ידנית, היכנסו להגדרות ← "אימות לתמיכה",
            והדביקו את הקוד הבא:
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
              {copied ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
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
