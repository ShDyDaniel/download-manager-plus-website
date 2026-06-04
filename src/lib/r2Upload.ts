/**
 * Browser → Cloudflare R2 multipart upload client.
 *
 * Replaces the old Google-Drive resumable uploader. Bytes go DIRECTLY
 * from the browser to R2 via presigned part URLs minted by our Vercel
 * backend — nothing transits Vercel. Flow:
 *   1. r2-upload-init      → { key, uploadId }
 *   2. for each ~16MB part: r2-upload-part-url → presigned PUT URL,
 *      then PUT the slice straight to R2 (XHR, for progress + ETag).
 *   3. r2-upload-complete  → finalizes, returns the real object size.
 * On any error we best-effort r2-upload-abort so no half-upload lingers.
 *
 * ⚠️ Requires a CORS policy on the R2 bucket that allows PUT from the
 * site origin and EXPOSES the ETag response header (see setup docs) —
 * otherwise the browser can't read each part's ETag and completion
 * fails. The desktop app uploads from Node and isn't affected by CORS.
 */

import { getSessionToken } from './webSession'

const API = '/api/revisions'
// 16 MB parts: comfortably above R2's 5 MB multipart minimum, few
// enough requests for multi-GB videos, small enough for smooth
// progress + cheap retries on flaky lines.
const PART_SIZE = 16 * 1024 * 1024

export interface R2UploadResult {
  key: string
  sizeBytes: number
}

export interface R2UploadOptions {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

async function postAction<T>(
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const sessionToken = getSessionToken()
  if (!sessionToken) throw new Error('לא מחובר')
  const r = await fetch(`${API}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken, ...body }),
    signal,
  })
  const json = (await r.json()) as { ok: boolean; error?: string } & T
  if (!json.ok) throw new Error(json.error || `${action} failed`)
  return json
}

function putPart(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onLoaded: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(e.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag =
          xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag')
        if (!etag) {
          reject(
            new Error(
              'לא הצלחתי לקרוא ETag מההעלאה (כנראה הגדרת CORS חסרה ב-R2)',
            ),
          )
          return
        }
        resolve(etag)
      } else {
        reject(new Error(`חלק נכשל בהעלאה (HTTP ${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('שגיאת רשת בזמן ההעלאה'))
    xhr.onabort = () => reject(new Error('ההעלאה בוטלה'))
    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(blob)
  })
}

export async function uploadFileToR2(
  file: File,
  opts: R2UploadOptions,
): Promise<R2UploadResult> {
  const { onProgress, signal } = opts

  const init = await postAction<{ key: string; uploadId: string }>(
    'r2-upload-init',
    {
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
    },
    signal,
  )
  const { key, uploadId } = init

  try {
    const totalParts = Math.max(1, Math.ceil(file.size / PART_SIZE))
    const parts: Array<{ partNumber: number; etag: string }> = []
    let uploadedBase = 0

    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1
      const start = i * PART_SIZE
      const end = Math.min(file.size, start + PART_SIZE)
      const blob = file.slice(start, end)

      const { url } = await postAction<{ url: string }>(
        'r2-upload-part-url',
        { key, uploadId, partNumber },
        signal,
      )

      const etag = await putPart(url, blob, signal, (loaded) => {
        if (onProgress && file.size > 0) {
          onProgress(Math.min(1, (uploadedBase + loaded) / file.size))
        }
      })
      uploadedBase += blob.size
      parts.push({ partNumber, etag })
      if (onProgress && file.size > 0) {
        onProgress(Math.min(1, uploadedBase / file.size))
      }
    }

    const done = await postAction<{ key: string; sizeBytes: number }>(
      'r2-upload-complete',
      { key, uploadId, parts },
      signal,
    )
    return { key, sizeBytes: done.sizeBytes || file.size }
  } catch (err) {
    // Best-effort cleanup so a cancelled/failed upload doesn't leave a
    // dangling multipart upload accruing storage.
    try {
      await postAction('r2-upload-abort', { key, uploadId })
    } catch {
      /* ignore */
    }
    throw err
  }
}
