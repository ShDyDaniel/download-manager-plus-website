import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Readable } from 'node:stream'

/**
 * Drive file proxy. Streams a single file's bytes from Google
 * Drive to the caller, keeping the API key on the server side.
 *
 * Why a proxy instead of handing the client a direct Drive URL:
 * Drive's `alt=media` URLs require the API key as a query param,
 * and shipping that key inside the Electron app would let anyone
 * extract it and burn our quota. By proxying through Vercel the
 * key stays in an env var and we get a single throat to choke for
 * rate-limiting / monitoring.
 *
 * Vercel timeout: serverless functions on the Hobby plan are
 * capped at 10s by default. We bump it to 60s with `maxDuration`,
 * which gives us roughly 500 MB at a typical Vercel→client
 * bandwidth. Files larger than that will time out mid-stream;
 * the client falls back to retrying with a Range header for the
 * remainder.
 *
 * Google native files (Docs/Sheets/Slides) are exported as PDF
 * because `alt=media` doesn't work on them — they're stored as
 * structured data, not byte blobs.
 */

export const config = {
  maxDuration: 60,
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'

function apiKey(): string {
  const k = process.env.GOOGLE_DRIVE_API_KEY
  if (!k) throw new Error('GOOGLE_DRIVE_API_KEY env var not set')
  return k
}

/** Map Google's "native" mime types to a reasonable export format. */
function exportTargetFor(mimeType: string): {
  exportMime: string
  extension: string
} | null {
  if (mimeType === 'application/vnd.google-apps.document') {
    return { exportMime: 'application/pdf', extension: 'pdf' }
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return {
      exportMime:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    }
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return { exportMime: 'application/pdf', extension: 'pdf' }
  }
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const id = String(req.query.id || '').trim()
  if (!id) {
    return res.status(400).json({ ok: false, error: 'id חסר' })
  }

  try {
    // First pull metadata so we know name + mime type. Tiny call,
    // adds maybe 100ms, but lets us set Content-Disposition with
    // the real filename instead of the bare Drive ID.
    const metaParams = new URLSearchParams({
      fields: 'id,name,mimeType,size',
      supportsAllDrives: 'true',
      key: apiKey(),
    })
    const metaResp = await fetch(
      `${DRIVE_API}/${encodeURIComponent(id)}?${metaParams.toString()}`,
    )
    if (metaResp.status === 404 || metaResp.status === 403) {
      return res
        .status(404)
        .json({ ok: false, error: 'הקובץ לא נמצא או אינו ציבורי' })
    }
    if (!metaResp.ok) {
      return res.status(metaResp.status).json({
        ok: false,
        error: `Drive metadata ${metaResp.status}: ${await metaResp.text()}`,
      })
    }
    const meta = (await metaResp.json()) as {
      name: string
      mimeType: string
      size?: string
    }

    // Decide download vs. export based on mime type.
    let downloadUrl: string
    let filename = meta.name
    const exportTarget = exportTargetFor(meta.mimeType)
    if (exportTarget) {
      const exportParams = new URLSearchParams({
        mimeType: exportTarget.exportMime,
        key: apiKey(),
      })
      downloadUrl = `${DRIVE_API}/${encodeURIComponent(id)}/export?${exportParams.toString()}`
      filename = `${meta.name}.${exportTarget.extension}`
    } else {
      const dlParams = new URLSearchParams({
        alt: 'media',
        supportsAllDrives: 'true',
        key: apiKey(),
      })
      downloadUrl = `${DRIVE_API}/${encodeURIComponent(id)}?${dlParams.toString()}`
    }

    // Forward Range header if present — lets the client resume
    // interrupted downloads chunk by chunk for files bigger than
    // our 60s function budget.
    const upstreamHeaders: Record<string, string> = {}
    const range = req.headers['range']
    if (typeof range === 'string') {
      upstreamHeaders['Range'] = range
    }

    const upstream = await fetch(downloadUrl, { headers: upstreamHeaders })
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({
        ok: false,
        error: `Drive download ${upstream.status}: ${await upstream.text()}`,
      })
    }

    // Mirror useful headers to the client.
    res.status(upstream.status)
    const passThroughHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
    ]
    for (const h of passThroughHeaders) {
      const v = upstream.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    // Content-Disposition with both a plain `filename=` (for ancient
    // clients) and an RFC 5987 `filename*=` (modern). The trick: Node
    // throws "Invalid character in header content" if ANY byte in a
    // header value is non-ASCII (i.e. > 0x7E). The plain `filename="..."`
    // part therefore can't include Hebrew / emoji / other Unicode —
    // even though it's "just a fallback" the header itself never gets
    // sent because Node refuses to construct it.
    //
    // So we strip non-ASCII (and a couple of other syntax-breaking
    // chars) from the plain part. Modern clients ignore it anyway —
    // they read `filename*=UTF-8''…` and get the real Unicode name.
    // If after stripping nothing is left, we fall back to a generic
    // "download" so the header still parses.
    const asciiFallback =
      filename
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\]/g, '')
        .trim() || 'download'
    const encodedFilename = encodeURIComponent(filename)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`,
    )

    if (req.method === 'HEAD') {
      return res.end()
    }

    if (!upstream.body) {
      return res.status(502).json({ ok: false, error: 'Drive גוף תגובה ריק' })
    }
    // Pipe the Web ReadableStream to the Node response. fromWeb
    // adapts the stream APIs across the two worlds.
    const nodeStream = Readable.fromWeb(
      upstream.body as unknown as import('node:stream/web').ReadableStream,
    )
    nodeStream.on('error', (err) => {
      console.error('drive/download stream error', err)
      if (!res.headersSent) {
        res.status(500).end()
      } else {
        res.destroy(err)
      }
    })
    nodeStream.pipe(res)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה'
    console.error('drive/download failed', err)
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: message })
    }
    res.destroy()
  }
}
