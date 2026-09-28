import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { pickVideoFromDrive } from '../lib/drivePicker'
import '../styles/pages/drive-picker.css'

/**
 * DrivePickerPage — the system-browser surface the DESKTOP app opens
 * to run the Google Picker.
 *
 * Why the browser (not an in-app window): Google blocks its Picker and
 * OAuth sign-in inside embedded Electron windows ("this browser may not
 * be secure" / disallowed_useragent). The user's real browser already
 * has a Google session, so the Picker works there.
 *
 * Hand-off (see api/revisions.ts picker-* actions):
 *   - The desktop creates a session and opens us at ?session=<nonce>.
 *   - We exchange the nonce for a short-lived Drive token (picker-token).
 *   - We run the Picker (the browser's Google session makes it work).
 *   - We post the chosen file (or a cancel) back (picker-result).
 *   - The desktop is polling and picks the result up.
 *
 * No tokens ever appear in a URL — the nonce is the only thing passed,
 * and it's a single-use capability with a short TTL.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'picking' }
  | { kind: 'done'; message: string; canceled?: boolean }
  | { kind: 'error'; message: string }

async function api<T>(action: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/revisions?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await r.json()) as T
}

export default function DrivePickerPage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const session = new URLSearchParams(window.location.search).get('session')

    void (async () => {
      if (!session) {
        setPhase({
          kind: 'error',
          message: 'הקישור אינו תקין. פתחו את בורר הקבצים מתוך התוכנה.',
        })
        return
      }
      try {
        // 1. Exchange the nonce for a short-lived Drive token.
        const tok = await api<{ ok: boolean; accessToken?: string; error?: string }>(
          'picker-token',
          { session },
        )
        if (!tok.ok || !tok.accessToken) {
          throw new Error(
            tok.error === 'session expired' || tok.error === 'session already used'
              ? 'הבקשה פגה. נסו שוב מהתוכנה.'
              : 'לא ניתן להתחבר ל-Google Drive. נסו שוב מהתוכנה.',
          )
        }

        // 2. Run the Picker (the browser's Google session makes it work).
        setPhase({ kind: 'picking' })
        const picked = await pickVideoFromDrive(tok.accessToken)

        // 3. Relay the result back to the desktop.
        if (!picked) {
          await api('picker-result', { session, canceled: true })
          setPhase({
            kind: 'done',
            message: 'הבחירה בוטלה. אפשר לחזור לתוכנה.',
            canceled: true,
          })
          return
        }
        await api('picker-result', { session, file: picked })
        setPhase({
          kind: 'done',
          message: 'הסרטון נבחר! אפשר לחזור לתוכנה, החלון הזה יכול להיסגר.',
        })
        // Best-effort auto-close (works when the tab was script-opened).
        window.setTimeout(() => {
          try {
            window.close()
          } catch {
            /* ignore — user closes the tab manually */
          }
        }, 1200)
      } catch (err) {
        // Only Hebrew reaches the user: a raw browser/library error (e.g.
        // "Failed to fetch") falls back to the generic Hebrew message.
        const message =
          err instanceof Error && /[\u0590-\u05FF]/.test(err.message)
            ? err.message
            : 'בחירת הקובץ נכשלה'
        if (session) void api('picker-result', { session, canceled: true })
        setPhase({ kind: 'error', message })
      }
    })()
  }, [])

  let box: React.ReactNode
  if (phase.kind === 'loading' || phase.kind === 'picking') {
    box = (
      <div className="dp-box" role="status">
        <Loader2 className="ic spin" aria-hidden />
        <p>{phase.kind === 'loading' ? 'מתחבר ל-Google Drive…' : 'בחרו סרטון מ-Google Drive…'}</p>
      </div>
    )
  } else if (phase.kind === 'done') {
    box = (
      <div className={`dp-box ${phase.canceled ? 'mu' : 'ok'}`} role="status">
        {phase.canceled ? <XCircle className="ic" aria-hidden /> : <CheckCircle2 className="ic" aria-hidden />}
        <p>{phase.message}</p>
      </div>
    )
  } else {
    box = (
      <div className="dp-box err" role="alert">
        <AlertCircle className="ic" aria-hidden />
        <p>{phase.message}</p>
      </div>
    )
  }

  return (
    <FlPage name="drive-picker" chrome="min" title="בחירת סרטון מ-Google Drive">
      <div className="dp">{box}</div>
    </FlPage>
  )
}
