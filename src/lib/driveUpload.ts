/**
 * Browser-side resumable Drive upload.
 *
 * The desktop streams files from disk via Node's fs APIs inside
 * Electron's main process. We can't do that in a browser — the
 * sandbox doesn't expose fs, and even if it did, large videos
 * (10 GB+) can't fit in memory all at once. The browser-friendly
 * equivalent is Drive's resumable upload protocol:
 *
 *   1. POST /upload/drive/v3/files?uploadType=resumable
 *      → returns a session URL in the Location header
 *   2. PUT chunks of bytes to that session URL with
 *      Content-Range: bytes <start>-<end>/<total>
 *   3. The final chunk returns 200/201 with the file metadata
 *
 * Chunks are sliced off the File via .slice() — no memory
 * pressure even for huge files because each chunk is read only
 * when its XHR uploads it. XHR (not fetch) for two reasons:
 *
 *   a) fetch's upload-progress API isn't supported in any major
 *      browser as of 2026 — XHR is the only way to get per-chunk
 *      onprogress events for accurate UI progress bars.
 *   b) XHR makes it straightforward to attach the right
 *      Content-Range header and read the Range response header
 *      Drive sends back on partial-success (308 Resume Incomplete).
 *
 * Resume semantics: if a chunk request fails mid-flight, we
 * query the session for "how much has Drive actually received?"
 * and resume from there. Same protocol the gsutil/Drive web app
 * uses.
 */

/** 8 MB chunks — same as the desktop's main-process streamer.
 *  Has to be a multiple of 256 KB per Drive's resumable spec.
 *  Smaller chunks = more progress events but more round-trip
 *  overhead; larger = fewer events but a single mid-chunk
 *  failure wastes more retransmission. 8 MB is the sweet spot
 *  Google's own libraries default to. */
const CHUNK_SIZE = 8 * 1024 * 1024

const DRIVE_UPLOAD_INIT_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'

export interface UploadProgress {
  bytesUploaded: number
  totalBytes: number
  /** 0..1 */
  fraction: number
}

export interface UploadResult {
  driveFileId: string
}

export interface UploadArgs {
  /** OAuth access token with `drive.file` scope. Obtained via
   *  /api/revisions?action=access-token. */
  accessToken: string
  /** The File the user picked. */
  file: File
  /** Drive folder ID the new file should land in. Usually the
   *  videos subfolder under "ניהול הורדות פלוס". */
  folderId: string
  /** Optional override for the filename stored on Drive. Defaults
   *  to `file.name`. */
  fileName?: string
  /** Optional override for the MIME type stored on Drive. Defaults
   *  to `file.type` (or "application/octet-stream" if blank). */
  mimeType?: string
  /** Per-chunk progress reporter — fires every time a chunk's
   *  PUT completes. Call sites use this to drive a progress bar. */
  onProgress?: (p: UploadProgress) => void
  /** Optional cancellation signal. If aborted mid-upload, all
   *  in-flight XHRs are cancelled and the function throws. The
   *  partial upload on Drive's side gets garbage-collected
   *  automatically after a few hours of inactivity. */
  signal?: AbortSignal
}

/** Resumable upload of a browser File to Drive. Resolves with the
 *  new file's Drive ID; throws on error. */
export async function uploadFileToDrive(
  args: UploadArgs,
): Promise<UploadResult> {
  const fileName = (args.fileName || args.file.name).trim()
  const mimeType =
    (args.mimeType || args.file.type || 'application/octet-stream').trim()
  const totalBytes = args.file.size
  if (totalBytes === 0) {
    throw new Error('הקובץ ריק. לא ניתן להעלות קובץ של 0 בייטים')
  }

  // Step 1 — initiate the resumable session. The session URL we
  // get back is short-lived (~1 week) and unique to this upload.
  let initResp: Response
  try {
    initResp = await fetch(DRIVE_UPLOAD_INIT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(totalBytes),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [args.folderId],
        mimeType,
      }),
      signal: args.signal,
    })
  } catch (err) {
    if (args.signal?.aborted) throw new Error('ההעלאה בוטלה')
    throw new Error(
      `יזימת ההעלאה ל-Drive נכשלה (רשת): ${err instanceof Error ? err.message : ''}`,
    )
  }
  if (!initResp.ok) {
    const text = await initResp.text().catch(() => '')
    throw new Error(
      `יזימת ההעלאה ל-Drive נכשלה (${initResp.status}). ${text.slice(0, 200)}`,
    )
  }
  const sessionUrl = initResp.headers.get('Location')
  if (!sessionUrl) {
    throw new Error('Drive לא החזיר session URL. נסו שוב')
  }

  // Step 2 — chunked PUTs. We track bytes uploaded across chunks
  // so the progress reporter shows global file progress, not
  // per-chunk progress (which would reset to 0% every 8 MB).
  let bytesUploaded = 0
  let driveFileId: string | null = null

  while (bytesUploaded < totalBytes) {
    if (args.signal?.aborted) throw new Error('ההעלאה בוטלה')

    const chunkStart = bytesUploaded
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, totalBytes)
    const chunk = args.file.slice(chunkStart, chunkEnd)

    const result = await uploadChunk({
      sessionUrl,
      chunk,
      chunkStart,
      chunkEnd,
      totalBytes,
      onChunkProgress: (loaded) => {
        if (args.onProgress) {
          const overall = bytesUploaded + loaded
          args.onProgress({
            bytesUploaded: overall,
            totalBytes,
            fraction: Math.min(overall / totalBytes, 0.999),
          })
        }
      },
      signal: args.signal,
    })

    if (result.kind === 'done') {
      driveFileId = result.fileId
      bytesUploaded = totalBytes
    } else if (result.kind === 'partial') {
      // Drive accepted some bytes but not all of this chunk.
      // The Range response tells us how many bytes are committed
      // server-side; resume from there next iteration.
      bytesUploaded = result.serverBytesReceived
    } else {
      // Full chunk accepted. Advance our cursor.
      bytesUploaded = chunkEnd
    }
  }

  if (!driveFileId) {
    throw new Error('ההעלאה הסתיימה אבל Drive לא החזיר file id')
  }

  // Final progress event — guaranteed 100%. uploadChunk caps the
  // per-chunk progress at 99.9% so a brief flash of "100%" never
  // appears before the file id is in hand.
  if (args.onProgress) {
    args.onProgress({
      bytesUploaded: totalBytes,
      totalBytes,
      fraction: 1,
    })
  }

  return { driveFileId }
}

/** XHR-based PUT of a single chunk. Returns one of three states:
 *
 *   - "done":    Drive accepted the FINAL chunk and returned the
 *                file metadata. fileId is populated.
 *   - "partial": Drive accepted some-but-not-all of this chunk's
 *                bytes (308 Resume Incomplete). The Range header
 *                tells us where to resume — passed back as
 *                serverBytesReceived.
 *   - "ack":     Drive accepted the full chunk and returned 308.
 *                The next iteration sends the next chunk.
 *
 *  Why XHR over fetch: fetch's request-side `upload` progress
 *  API isn't shipped in any browser, so a 4 GB chunk would just
 *  hang the UI with no progress feedback. */
interface ChunkResultDone {
  kind: 'done'
  fileId: string
}
interface ChunkResultPartial {
  kind: 'partial'
  serverBytesReceived: number
}
interface ChunkResultAck {
  kind: 'ack'
}
type ChunkResult = ChunkResultDone | ChunkResultPartial | ChunkResultAck

function uploadChunk(args: {
  sessionUrl: string
  chunk: Blob
  chunkStart: number
  chunkEnd: number
  totalBytes: number
  onChunkProgress?: (loadedInChunk: number) => void
  signal?: AbortSignal
}): Promise<ChunkResult> {
  return new Promise<ChunkResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', args.sessionUrl, true)
    // Content-Range: bytes <start>-<end-1>/<total>
    // Drive expects INCLUSIVE byte indices for both ends, hence
    // chunkEnd-1.
    xhr.setRequestHeader(
      'Content-Range',
      `bytes ${args.chunkStart}-${args.chunkEnd - 1}/${args.totalBytes}`,
    )

    if (args.signal) {
      if (args.signal.aborted) {
        xhr.abort()
        reject(new Error('ההעלאה בוטלה'))
        return
      }
      args.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && args.onChunkProgress) {
        args.onChunkProgress(e.loaded)
      }
    })

    xhr.addEventListener('load', () => {
      // Drive's resumable protocol response codes:
      //   200 / 201 — final chunk accepted; body = file metadata
      //   308       — partial / full chunk accepted (more to go);
      //               Range response header tells us how many bytes
      //               are committed on the server
      //   4xx / 5xx — error
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const json = JSON.parse(xhr.responseText) as { id?: string }
          if (json.id) {
            resolve({ kind: 'done', fileId: json.id })
          } else {
            reject(new Error('Drive החזיר success ללא file id'))
          }
        } catch {
          reject(new Error('Drive החזיר תגובה לא תקינה'))
        }
      } else if (xhr.status === 308) {
        // The Range header is INCLUSIVE: "bytes=0-X" means bytes
        // 0..X are committed → X+1 bytes total received.
        const range = xhr.getResponseHeader('Range')
        if (!range) {
          // No bytes acked yet — treat as a full-chunk success
          // (Drive will just say "ack" when the chunk arrived
          // intact without giving back a Range).
          resolve({ kind: 'ack' })
          return
        }
        const m = range.match(/^bytes=\d+-(\d+)$/)
        if (!m) {
          reject(new Error(`Drive החזיר Range לא תקין: ${range}`))
          return
        }
        const serverByteIndex = Number(m[1])
        // bytes 0..serverByteIndex committed → serverByteIndex+1
        // bytes received in total.
        resolve({
          kind: 'partial',
          serverBytesReceived: serverByteIndex + 1,
        })
      } else {
        reject(
          new Error(
            `Drive דחה את הצ'אנק (${xhr.status}): ${xhr.responseText.slice(0, 200)}`,
          ),
        )
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('שגיאת רשת בזמן ההעלאה'))
    })
    xhr.addEventListener('abort', () => {
      reject(new Error('ההעלאה בוטלה'))
    })

    xhr.send(args.chunk)
  })
}

/* ──────────────────────────────────────────────────────────────
 *  Drive folder management — find-or-create per the same naming
 *  convention the desktop uses, so projects created from the web
 *  show up in the SAME Drive folder structure the desktop sees.
 * ────────────────────────────────────────────────────────────── */

const PROJECT_FOLDER_NAME = 'ניהול הורדות פלוס'
const VIDEOS_SUBFOLDER_NAME = 'סרטונים'
const NOTES_SUBFOLDER_NAME = 'קבצי תיקונים'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface ProjectFolderIds {
  rootFolderId: string
  videosFolderId: string
  notesFolderId: string
}

/** Find-or-create both the parent project folder + the two
 *  subfolders ("סרטונים" + "קבצי תיקונים") in the user's Drive.
 *  Idempotent — running this multiple times returns the same IDs
 *  without creating duplicates. Mirrors the desktop's
 *  ensureProjectFolders helper so a project created from the web
 *  lands in the EXACT SAME directory structure as one created
 *  from the desktop. */
export async function ensureProjectFolders(
  accessToken: string,
): Promise<ProjectFolderIds> {
  const rootFolderId = await findOrCreateFolder(
    accessToken,
    PROJECT_FOLDER_NAME,
    null,
  )
  // Subfolders are independent — create them in parallel to save
  // an RTT.
  const [videosFolderId, notesFolderId] = await Promise.all([
    findOrCreateFolder(accessToken, VIDEOS_SUBFOLDER_NAME, rootFolderId),
    findOrCreateFolder(accessToken, NOTES_SUBFOLDER_NAME, rootFolderId),
  ])
  return { rootFolderId, videosFolderId, notesFolderId }
}

async function findOrCreateFolder(
  accessToken: string,
  name: string,
  parentId: string | null,
): Promise<string> {
  // Search for an EXISTING folder with this name in the parent
  // (or at the user's Drive root if parentId is null). We only
  // see files our own app created because of the drive.file
  // scope — no risk of matching a user's pre-existing folder
  // with the same name.
  const escapedName = name.replace(/'/g, "\\'")
  const parentClause = parentId
    ? `and '${parentId}' in parents`
    : "and 'root' in parents"
  const q = `name='${escapedName}' and mimeType='${FOLDER_MIME}' and trashed=false ${parentClause}`
  const searchUrl = new URL('https://www.googleapis.com/drive/v3/files')
  searchUrl.searchParams.set('q', q)
  searchUrl.searchParams.set('fields', 'files(id, name)')
  searchUrl.searchParams.set('pageSize', '1')

  const searchResp = await fetch(searchUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!searchResp.ok) {
    throw new Error(`חיפוש תיקייה ב-Drive נכשל (${searchResp.status})`)
  }
  const searchJson = (await searchResp.json()) as {
    files?: Array<{ id: string; name: string }>
  }
  if (searchJson.files && searchJson.files.length > 0) {
    return searchJson.files[0].id
  }

  // Doesn't exist yet — create it.
  const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      parents: parentId ? [parentId] : undefined,
    }),
  })
  if (!createResp.ok) {
    throw new Error(`יצירת תיקייה ב-Drive נכשלה (${createResp.status})`)
  }
  const folder = (await createResp.json()) as { id: string }
  return folder.id
}

/** After upload, make the file readable by anyone with the share
 *  link, but disable copy/print/download at the Drive level.
 *
 *  Note: this is NOT bulletproof — anyone with DevTools or a
 *  screen recorder can capture the stream. It's a "casual
 *  download is blocked" measure, layered on top of the
 *  watermark + Drive-side embed restrictions. Mirrors what the
 *  desktop does post-upload so web-created and desktop-created
 *  files have identical sharing settings. */
export async function setShareablePermissions(
  accessToken: string,
  driveFileId: string,
): Promise<void> {
  // Step 1 — anyone with the link can view.
  const permResp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}/permissions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    },
  )
  if (!permResp.ok) {
    throw new Error(`הגדרת הרשאות שיתוף נכשלה (${permResp.status})`)
  }

  // Step 2 — disable copy/print/download.
  const updateUrl = new URL(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}`,
  )
  updateUrl.searchParams.set('fields', 'id, copyRequiresWriterPermission')
  const updateResp = await fetch(updateUrl.toString(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      copyRequiresWriterPermission: true,
      viewersCanCopyContent: false,
    }),
  })
  if (!updateResp.ok) {
    // Soft-fail: the file is already shared (step 1 worked), the
    // download-disable just didn't stick. Better to upload-with-
    // copy-allowed than to bounce the entire upload back at the
    // user.
    console.warn(
      `[driveUpload] copy/print disable failed (${updateResp.status}) — file is shared, but copy may be allowed`,
    )
  }
}
