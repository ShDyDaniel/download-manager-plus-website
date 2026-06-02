import { useEffect, useRef, useState } from 'react'
import { pickVideoFromDrive } from '../lib/drivePicker'

/**
 * DrivePickerPage — a minimal, chromeless surface whose ONLY job is
 * to run the Google Picker and hand the result back to the desktop
 * app. The desktop opens this route inside a frameless, modal
 * BrowserWindow so the user never sees a browser or a URL — it looks
 * and feels like a native in-app dialog. The Picker grid itself is
 * Google's (unavoidable under the privacy-minimal `drive.file`
 * scope), but everything around it is ours.
 *
 * Handshake with the Electron host (all via the URL hash + an
 * injected global — no tokens ever travel through query strings or
 * the server):
 *
 *   1. On mount we define `window.__dmplusDrivePickerInit` and set
 *      `location.hash = 'ready'` to tell the host we're listening.
 *   2. The host injects the Drive access token by calling
 *      `window.__dmplusDrivePickerInit({ accessToken })` via
 *      executeJavaScript (stays in-process; never logged).
 *   3. We open the Picker. On selection we set
 *      `location.hash = 'result=' + encodeURIComponent(JSON)`.
 *      On cancel: `location.hash = 'cancel'`. On error:
 *      `location.hash = 'error=' + encodeURIComponent(message)`.
 *   4. The host reads the hash (did-navigate-in-page), resolves its
 *      IPC promise, and closes the window.
 *
 * If opened directly in a normal browser (no host injecting a token),
 * it just shows a short explanation and does nothing destructive.
 */

declare global {
  interface Window {
    __dmplusDrivePickerInit?: (cfg: { accessToken: string }) => void
  }
}

function setHash(value: string) {
  // Assign via location.hash so Electron's did-navigate-in-page fires.
  window.location.hash = value
}

export default function DrivePickerPage() {
  const [status, setStatus] = useState<'waiting' | 'picking' | 'done'>(
    'waiting',
  )
  const [message, setMessage] = useState('פותח את בורר הקבצים…')
  const startedRef = useRef(false)

  useEffect(() => {
    async function run(accessToken: string) {
      if (startedRef.current) return
      startedRef.current = true
      setStatus('picking')
      try {
        const picked = await pickVideoFromDrive(accessToken)
        setStatus('done')
        if (picked) {
          setHash('result=' + encodeURIComponent(JSON.stringify(picked)))
        } else {
          setHash('cancel')
        }
      } catch (err) {
        setStatus('done')
        const msg =
          err instanceof Error ? err.message : 'בחירת הקובץ נכשלה'
        setMessage(msg)
        setHash('error=' + encodeURIComponent(msg))
      }
    }

    window.__dmplusDrivePickerInit = (cfg) => {
      if (cfg?.accessToken) void run(cfg.accessToken)
    }

    // Tell the host we're ready to receive the token.
    setHash('ready')

    return () => {
      delete window.__dmplusDrivePickerInit
    }
  }, [])

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      <p className="text-sm text-fg-muted">
        {status === 'done' ? message : 'פותח את בורר הקבצים של Google Drive…'}
      </p>
    </div>
  )
}
