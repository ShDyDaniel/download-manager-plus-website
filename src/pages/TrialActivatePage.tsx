import { useEffect, useRef, useState } from 'react'
import { Gift, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'

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
  | { kind: 'error'; msg: string }
  | { kind: 'invalid' }

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
      setState({ kind: 'invalid' })
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
          setState({ kind: 'success', expiresAt: json.expiresAt ?? null })
        } else {
          setState({
            kind: 'error',
            msg: json.error || 'הפעלת הניסיון נכשלה. נסו שוב מאוחר יותר.',
          })
        }
      } catch {
        setState({
          kind: 'error',
          msg: 'שגיאת רשת — בדקו את החיבור ונסו שוב.',
        })
      }
    })()
  }, [])

  return (
    <div
      dir="rtl"
      className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10 text-foreground"
    >
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-8 text-center shadow-2xl shadow-black/30">
        {state.kind === 'loading' && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">מפעילים את הניסיון…</h1>
            <p className="mt-2 text-sm text-muted-foreground">רגע אחד.</p>
          </>
        )}

        {state.kind === 'success' && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-success/15 text-success">
              <Gift className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">הניסיון הופעל! 🎉</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              קיבלת 7 ימי Pro
              {state.expiresAt ? ` — בתוקף עד ${fmtDate(state.expiresAt)}` : ''}.
              אפשר לחזור לתוכנה וליהנות מכל היכולות.
            </p>
            <div className="mt-6 flex items-center justify-center gap-2 rounded-xl border border-success/30 bg-success/[0.06] px-4 py-3 text-sm text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              אפשר לסגור את הדף ולחזור לתוכנה.
            </div>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/15 text-destructive">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">לא ניתן להפעיל ניסיון</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {state.msg}
            </p>
            <div className="mt-6 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
              אפשר לסגור את הדף ולחזור לתוכנה.
            </div>
          </>
        )}

        {state.kind === 'invalid' && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/15 text-destructive">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h1 className="mt-4 text-2xl font-bold">קישור לא תקין</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              יש לפתוח את הקבלת הניסיון מתוך התוכנה (תפריט המשתמש ← "קבלת 7 ימי
              ניסיון חינם").
            </p>
          </>
        )}
      </div>

      <p className="mt-5 text-center text-[11px] text-muted-foreground/70">
        Download Manager Plus
      </p>
    </div>
  )
}
