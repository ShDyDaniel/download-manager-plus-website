/**
 * Cloudflare Worker — zero-egress video proxy for the
 * ניהול הורדות פלוס Revisions feature.
 *
 * VIDEO (?token=...) now streams straight from our own Cloudflare R2
 * bucket via the Worker's R2 binding — no access tokens, no Drive,
 * no Vercel egress. Flow per request:
 *   1. Browser → Worker (?token=<shareToken>&t=<passwordToken?>&r=<roundId?>)
 *   2. Worker → Vercel (action=auth-stream, X-Worker-Secret header).
 *      Vercel validates the share token + password + round and returns
 *      { ok, r2Key }. We cache that mapping for 50 min per
 *      (shareToken, passwordToken, roundId).
 *   3. Worker → R2 (env.BUCKET.get(r2Key, { range })) and pipes the
 *      bytes back, honoring HTTP Range so the player can seek.
 *
 * NOTE-MEDIA (?m=...) still rides the Drive path during the storage
 * migration — screenshots/audio are tiny and will move to R2 in a
 * follow-up. That branch is unchanged.
 *
 * Bindings/vars required (Worker Settings):
 *   WORKER_SECRET — shared with Vercel's WORKER_SHARED_SECRET.
 *   BUCKET        — R2 bucket binding (the dmplus-revisions bucket).
 */

const VERCEL_AUTH_URL = 'https://dmplus.net/api/revisions?action=auth-stream'
const VERCEL_AUTH_MEDIA_URL =
  'https://dmplus.net/api/revisions?action=auth-media'

// In-memory cache: key = `${shareToken}|${passwordToken}|${roundId}` →
// { r2Key, expiresAt }. Lives within one isolate; cold starts re-auth.
const authCache = new Map()
const AUTH_TTL_MS = 50 * 60 * 1000

function corsHeaders(extra) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, content-type',
    'access-control-expose-headers':
      'accept-ranges, content-length, content-range, content-type',
    'content-disposition': 'inline',
    ...(extra || {}),
  }
}

function dispositionFor(url) {
  if (url.searchParams.get('d') !== '1') return 'inline'
  return 'attachment; filename="video.mp4"'
}

// Resolve a share token → R2 object key via Vercel (password/round
// validated server-side). Cached per (token, pwd, round).
async function fetchAuth(env, shareToken, passwordToken, roundId) {
  const r = await fetch(VERCEL_AUTH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-secret': env.WORKER_SECRET || '',
    },
    body: JSON.stringify({ shareToken, passwordToken, roundId }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`auth ${r.status}: ${text.slice(0, 200)}`)
  }
  const json = await r.json()
  // Dual backend: an R2 round returns { r2Key }; a Drive round returns
  // { accessToken, driveFileId }. Accept either.
  const okR2 = json && json.ok && json.r2Key
  const okDrive = json && json.ok && json.accessToken && json.driveFileId
  if (!okR2 && !okDrive) {
    throw new Error('auth response malformed')
  }
  return {
    r2Key: json.r2Key || '',
    accessToken: json.accessToken || '',
    driveFileId: json.driveFileId || '',
    expiresAt: Date.now() + AUTH_TTL_MS,
  }
}

async function getAuth(env, shareToken, passwordToken, roundId) {
  const cacheKey = `${shareToken}|${passwordToken || ''}|${roundId || ''}`
  const hit = authCache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) return hit
  const fresh = await fetchAuth(env, shareToken, passwordToken, roundId)
  authCache.set(cacheKey, fresh)
  return fresh
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', {
        status: 405,
        headers: corsHeaders(),
      })
    }

    const url = new URL(request.url)

    // ── Note-media path (?m=<encrypted token>) — still on Drive ──
    const mediaToken = url.searchParams.get('m')
    if (mediaToken) {
      let authR
      try {
        authR = await fetch(VERCEL_AUTH_MEDIA_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-worker-secret': env.WORKER_SECRET || '',
          },
          body: JSON.stringify({ m: mediaToken }),
        })
      } catch (err) {
        return new Response(`auth fetch failed: ${err}`, {
          status: 502,
          headers: corsHeaders(),
        })
      }
      if (!authR.ok) {
        const t = await authR.text().catch(() => '')
        return new Response(`media auth ${authR.status}: ${t.slice(0, 200)}`, {
          status: 403,
          headers: corsHeaders(),
        })
      }
      const authJson = await authR.json().catch(() => null)
      if (
        !authJson ||
        !authJson.ok ||
        !authJson.accessToken ||
        !authJson.driveFileId
      ) {
        return new Response('media auth malformed', {
          status: 403,
          headers: corsHeaders(),
        })
      }
      const driveResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${authJson.driveFileId}?alt=media`,
        { headers: { authorization: `Bearer ${authJson.accessToken}` } },
      )
      const respHeaders = corsHeaders({
        'cache-control': 'private, max-age=3600',
        'content-disposition': 'inline',
      })
      for (const h of ['content-type', 'content-length', 'last-modified', 'etag']) {
        const v = driveResp.headers.get(h)
        if (v) respHeaders[h] = v
      }
      return new Response(driveResp.body, {
        status: driveResp.status,
        statusText: driveResp.statusText,
        headers: respHeaders,
      })
    }

    // ── Video path (?token=...) — streams from R2 ───────────────
    const shareToken = url.searchParams.get('token')
    const passwordToken = url.searchParams.get('t') || ''
    const roundId = url.searchParams.get('r') || ''
    if (!shareToken) {
      return new Response('token required', {
        status: 400,
        headers: corsHeaders(),
      })
    }

    let auth
    try {
      auth = await getAuth(env, shareToken, passwordToken, roundId)
    } catch (err) {
      return new Response(`auth failed: ${err.message || err}`, {
        status: 403,
        headers: corsHeaders(),
      })
    }

    // ── Drive-backed round → stream from Google Drive (pre-R2 path,
    // for users the admin keeps on the Drive backend) ──────────────
    if (!auth.r2Key && auth.driveFileId) {
      const driveUrl = `https://www.googleapis.com/drive/v3/files/${auth.driveFileId}?alt=media`
      const dh = new Headers({ authorization: `Bearer ${auth.accessToken}` })
      const range = request.headers.get('range')
      if (range) dh.set('range', range)
      const driveResp = await fetch(driveUrl, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: dh,
      })
      const respHeaders = corsHeaders({ 'content-disposition': dispositionFor(url) })
      for (const h of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'last-modified',
        'etag',
      ]) {
        const v = driveResp.headers.get(h)
        if (v) respHeaders[h] = v
      }
      if (!respHeaders['accept-ranges']) respHeaders['accept-ranges'] = 'bytes'
      return new Response(driveResp.body, {
        status: driveResp.status,
        statusText: driveResp.statusText,
        headers: respHeaders,
      })
    }

    // ── R2-backed round ─────────────────────────────────────────
    if (!env.BUCKET) {
      return new Response('R2 binding (BUCKET) not configured', {
        status: 500,
        headers: corsHeaders(),
      })
    }

    const key = auth.r2Key

    // HEAD — metadata only (some players probe with HEAD first).
    // NOTE: writeHttpMetadata() needs a real Headers instance (it calls
    // .set()), so we build one from the plain CORS object.
    if (request.method === 'HEAD') {
      const head = await env.BUCKET.head(key)
      if (!head) {
        return new Response('not found', { status: 404, headers: corsHeaders() })
      }
      const headers = new Headers(
        corsHeaders({ 'content-disposition': dispositionFor(url) }),
      )
      head.writeHttpMetadata(headers)
      headers.set('etag', head.httpEtag)
      headers.set('accept-ranges', 'bytes')
      headers.set('content-length', String(head.size))
      return new Response(null, { status: 200, headers })
    }

    // GET — stream the bytes, honoring the Range header for seeking.
    const object = await env.BUCKET.get(key, { range: request.headers })
    if (!object) {
      return new Response('not found', { status: 404, headers: corsHeaders() })
    }

    const headers = new Headers(
      corsHeaders({ 'content-disposition': dispositionFor(url) }),
    )
    object.writeHttpMetadata(headers) // content-type etc. from stored metadata
    headers.set('etag', object.httpEtag)
    headers.set('accept-ranges', 'bytes')

    let status = 200
    if (object.range && typeof object.range.offset === 'number') {
      const offset = object.range.offset || 0
      const length =
        typeof object.range.length === 'number'
          ? object.range.length
          : object.size - offset
      const end = offset + length - 1
      headers.set('content-range', `bytes ${offset}-${end}/${object.size}`)
      headers.set('content-length', String(length))
      status = 206
    } else {
      headers.set('content-length', String(object.size))
    }

    return new Response(object.body, { status, headers })
  },
}
