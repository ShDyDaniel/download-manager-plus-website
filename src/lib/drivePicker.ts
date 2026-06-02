/**
 * Google Picker integration — lets the editor pick an EXISTING video
 * from their Google Drive instead of uploading a fresh copy.
 *
 * Why the Picker (and not files.list): our OAuth scope is the minimal
 * `drive.file`, under which the app can only see files it created.
 * The Google Picker is the one mechanism Google provides that works
 * with `drive.file` — when the user selects a file through it, that
 * specific file becomes accessible to the app's token. No broad scope,
 * no security audit.
 *
 * Requires (one-time, in Google Cloud for project n-plus-64549):
 *   - The "Google Picker API" enabled.
 *   - An API key (we reuse the project's public web key — the same one
 *     Firebase uses; it's already shipped in the client).
 *   - The GCP project NUMBER as appId.
 */

declare global {
  interface Window {
    // gapi + google.picker are injected by the Google Picker script.
    // Typed as `any` — there are no first-party types and the surface
    // we touch is tiny.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gapi?: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google?: any
  }
}

// Dedicated browser API key for the Google Picker, restricted to the
// Picker API in GCP project n-plus-64549. Google API keys are not
// secrets (access is gated by the OAuth token + API restriction), but
// it's still supplied via env so it can be rotated without a code
// change. MUST be named with the `VITE_` prefix — Vite only exposes
// VITE_-prefixed vars to the client bundle. Set it in Vercel and
// redeploy (Vite inlines env at BUILD time).
//
// Note: the Firebase web key does NOT work here — Firebase restricts
// it to Firebase APIs only, so the Picker rejects it as "invalid API
// key". That's why this needs its own key.
const PICKER_API_KEY =
  (import.meta.env.VITE_GOOGLE_PICKER_KEY as string | undefined)?.trim() || ''
// GCP project NUMBER (not the ID) — required by the Picker.
const PICKER_APP_ID = '1005271902300'

export interface PickedDriveFile {
  id: string
  name: string
  sizeBytes: number
  mimeType: string
}

let pickerLoad: Promise<void> | null = null

/** Load apis.google.com/js/api.js and the 'picker' module once. */
function loadPickerApi(): Promise<void> {
  if (pickerLoad) return pickerLoad
  pickerLoad = new Promise<void>((resolve, reject) => {
    const onApiReady = () => {
      try {
        window.gapi.load('picker', {
          callback: () => resolve(),
          onerror: () => reject(new Error('טעינת Google Picker נכשלה')),
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error('טעינת Google Picker נכשלה'))
      }
    }
    if (window.gapi?.load) {
      onApiReady()
      return
    }
    const s = document.createElement('script')
    s.src = 'https://apis.google.com/js/api.js'
    s.async = true
    s.onload = onApiReady
    s.onerror = () => reject(new Error('טעינת Google Picker נכשלה'))
    document.head.appendChild(s)
  })
  return pickerLoad
}

/** Open the Drive picker filtered to videos. Resolves with the chosen
 *  file, or null if the user cancelled. Rejects on load/config error. */
export async function pickVideoFromDrive(
  oauthToken: string,
): Promise<PickedDriveFile | null> {
  if (!PICKER_API_KEY) {
    throw new Error(
      'בחירה מ-Google Drive עדיין לא הוגדרה (חסר מפתח Picker). נסו שוב מאוחר יותר או השתמשו בהעלאת קובץ.',
    )
  }
  await loadPickerApi()
  const google = window.google
  if (!google?.picker) throw new Error('Google Picker לא זמין')
  return new Promise<PickedDriveFile | null>((resolve, reject) => {
    try {
      const view = new google.picker.DocsView(
        google.picker.ViewId.DOCS_VIDEOS,
      )
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false)
        .setOwnedByMe(true)
      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(oauthToken)
        .setDeveloperKey(PICKER_API_KEY)
        .setAppId(PICKER_APP_ID)
        .setLocale('he')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setCallback((data: any) => {
          const action = data?.[google.picker.Response.ACTION]
          if (action === google.picker.Action.PICKED) {
            const doc = data[google.picker.Response.DOCUMENTS]?.[0]
            if (!doc) {
              resolve(null)
              return
            }
            resolve({
              id: String(doc[google.picker.Document.ID] || ''),
              name: String(doc[google.picker.Document.NAME] || 'video'),
              sizeBytes: Number(doc.sizeBytes || doc.fileSize || 0) || 0,
              mimeType: String(
                doc[google.picker.Document.MIME_TYPE] || 'video/mp4',
              ),
            })
          } else if (action === google.picker.Action.CANCEL) {
            resolve(null)
          }
        })
        .build()
      picker.setVisible(true)
    } catch (err) {
      reject(err instanceof Error ? err : new Error('פתיחת Google Picker נכשלה'))
    }
  })
}
