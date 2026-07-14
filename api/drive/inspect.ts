import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Drive URL inspector — parses a Google Drive share URL and either
 * returns the metadata of a single file or the full recursive tree
 * of a folder. The Electron client uses this to know what it's
 * about to download (one file or many, total bytes, folder layout)
 * before kicking off /api/drive/download requests file-by-file.
 *
 * Auth: server-side API key only (GOOGLE_DRIVE_API_KEY). This means
 * we can only see PUBLIC content ("Anyone with the link can view").
 * Restricted files return 404 from Drive's API; we surface that as
 * a clear Hebrew error.
 *
 * Google native files (Docs/Sheets/Slides) are flagged but NOT
 * blocked here — the download endpoint exports them as PDF.
 *
 * Folder traversal pagination + recursion happen entirely on the
 * server so the client only needs one round trip to learn the
 * whole tree. We cap recursion depth and total file count to keep
 * the inspect call within Vercel's serverless budget.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
const MAX_FILES = 5000
const MAX_DEPTH = 20
const FOLDER_MIME = 'application/vnd.google-apps.folder'

type DriveFile = {
  id: string
  name: string
  mimeType: string
  /** Bytes, as a string (Drive API returns strings to support >2^53). */
  size?: string
  /** Drive's MD5 of the file content — lets the client verify the
   *  download bit-for-bit (catches size-preserving corruption from a
   *  bad range-resume). Absent for Google-native docs (no binary blob). */
  md5Checksum?: string
}

type TreeNode = {
  id: string
  name: string
  mimeType: string
  size: number
  /** Content MD5 (binary files only) — for post-download verification. */
  md5?: string
  /** Present only when this node is a folder. */
  children?: TreeNode[]
}

/** Pull a file or folder id out of any Drive share URL form. */
function parseDriveUrl(url: string): {
  kind: 'file' | 'folder' | 'unknown'
  id: string | null
} {
  try {
    const u = new URL(url.trim())
    // drive.google.com/file/d/{ID}/view
    let m = u.pathname.match(/\/file\/d\/([^/]+)/)
    if (m) return { kind: 'file', id: m[1] }
    // drive.google.com/drive/folders/{ID}
    m = u.pathname.match(/\/drive\/folders\/([^/]+)/)
    if (m) return { kind: 'folder', id: m[1] }
    // drive.google.com/drive/u/0/folders/{ID}
    m = u.pathname.match(/\/drive\/u\/\d+\/folders\/([^/]+)/)
    if (m) return { kind: 'folder', id: m[1] }
    // drive.google.com/open?id={ID} (kind unknown — must probe)
    const openId = u.searchParams.get('id')
    if (openId) return { kind: 'unknown', id: openId }
    // docs.google.com/document/d/{ID}/...
    m = u.pathname.match(/\/(document|spreadsheets|presentation)\/d\/([^/]+)/)
    if (m) return { kind: 'file', id: m[2] }
    return { kind: 'unknown', id: null }
  } catch {
    return { kind: 'unknown', id: null }
  }
}

function apiKey(): string {
  const k = process.env.GOOGLE_DRIVE_API_KEY
  if (!k) throw new Error('GOOGLE_DRIVE_API_KEY env var not set')
  return k
}

async function fetchFileMeta(id: string): Promise<DriveFile | null> {
  const url = `${DRIVE_API}/${encodeURIComponent(id)}?fields=id,name,mimeType,size,md5Checksum&supportsAllDrives=true&key=${apiKey()}`
  const r = await fetch(url)
  if (r.status === 404 || r.status === 403) return null
  if (!r.ok) {
    throw new Error(`Drive metadata fetch ${r.status}: ${await r.text()}`)
  }
  return (await r.json()) as DriveFile
}

/** List the immediate children of a folder, paginating until we
 *  collect them all (Drive caps at 1000 per page). */
async function listChildren(folderId: string): Promise<DriveFile[]> {
  const all: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey(),
    })
    if (pageToken) params.set('pageToken', pageToken)
    const r = await fetch(`${DRIVE_API}?${params.toString()}`)
    if (!r.ok) {
      throw new Error(`Drive list ${r.status}: ${await r.text()}`)
    }
    const body = (await r.json()) as {
      files?: DriveFile[]
      nextPageToken?: string
    }
    if (body.files) all.push(...body.files)
    pageToken = body.nextPageToken
  } while (pageToken)
  return all
}

/** BFS down the folder tree. Caps on total files and depth keep
 *  pathological folders from blowing the function budget. Returns
 *  the populated root node and a fileCount tally. */
async function buildTree(
  root: DriveFile,
): Promise<{ tree: TreeNode; fileCount: number; totalBytes: number }> {
  let fileCount = 0
  let totalBytes = 0

  async function recurse(file: DriveFile, depth: number): Promise<TreeNode> {
    if (file.mimeType !== FOLDER_MIME) {
      fileCount++
      const size = file.size ? Number(file.size) : 0
      totalBytes += size
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size,
        ...(file.md5Checksum ? { md5: file.md5Checksum } : {}),
      }
    }
    // Folder.
    if (depth >= MAX_DEPTH) {
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: 0,
        children: [],
      }
    }
    const node: TreeNode = {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: 0,
      children: [],
    }
    const kids = await listChildren(file.id)
    for (const kid of kids) {
      if (fileCount >= MAX_FILES) break
      node.children!.push(await recurse(kid, depth + 1))
    }
    return node
  }

  const tree = await recurse(root, 0)
  return { tree, fileCount, totalBytes }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const body = req.body as { url?: string }
  const url = (body.url || '').trim()
  if (!url) {
    return res
      .status(400)
      .json({ ok: false, error: 'יש להזין קישור Google Drive' })
  }

  const { kind, id } = parseDriveUrl(url)
  if (!id) {
    return res.status(400).json({
      ok: false,
      error: 'הקישור לא נראה כמו קישור Google Drive תקף',
    })
  }

  try {
    if (kind === 'file') {
      const meta = await fetchFileMeta(id)
      if (!meta) {
        return res.status(404).json({
          ok: false,
          error:
            'הקובץ לא נמצא או שאין הרשאת ציבורית — ודאו שהשיתוף הוא "כל מי שיש לו הקישור"',
        })
      }
      return res.status(200).json({
        ok: true,
        kind: 'file',
        file: {
          id: meta.id,
          name: meta.name,
          mimeType: meta.mimeType,
          size: meta.size ? Number(meta.size) : 0,
          ...(meta.md5Checksum ? { md5: meta.md5Checksum } : {}),
        },
      })
    }

    // folder OR unknown (probe to find out)
    const meta = await fetchFileMeta(id)
    if (!meta) {
      return res.status(404).json({
        ok: false,
        error:
          'הקישור לא נמצא או שאין הרשאת ציבורית — ודאו שהשיתוף הוא "כל מי שיש לו הקישור"',
      })
    }

    if (meta.mimeType !== FOLDER_MIME) {
      // It's actually a file — promote to file response.
      return res.status(200).json({
        ok: true,
        kind: 'file',
        file: {
          id: meta.id,
          name: meta.name,
          mimeType: meta.mimeType,
          size: meta.size ? Number(meta.size) : 0,
          ...(meta.md5Checksum ? { md5: meta.md5Checksum } : {}),
        },
      })
    }

    const { tree, fileCount, totalBytes } = await buildTree(meta)
    return res.status(200).json({
      ok: true,
      kind: 'folder',
      tree,
      fileCount,
      totalBytes,
      truncated: fileCount >= MAX_FILES,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('drive/inspect failed', err)
    return res.status(500).json({ ok: false, error: message })
  }
}
