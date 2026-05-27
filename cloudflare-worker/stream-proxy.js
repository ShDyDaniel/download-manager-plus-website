/**
 * Cloudflare Worker — zero-bandwidth Drive video proxy
 * for the ניהול הורדות פלוס Revisions feature.
 *
 * Flow per video request:
 *   1. Browser → Worker (with ?token=<shareToken>&t=<passwordToken?>)
 *   2. Worker → Vercel (action=auth-stream, X-Worker-Secret header)
 *      Vercel validates the share token + password, refreshes the
 *      project owner's Drive token, returns:
 *          { ok, accessToken, driveFileId }
 *      We cache that for 50 min per (shareToken, passwordToken) so
 *      subsequent Range requests don't hit Vercel again.
 *   3. Worker → Drive (alt=media, with Authorization + Range)
 *   4. Worker streams Drive's body straight back to the browser.
 *
 * Because every video byte traverses Cloudflare (not Vercel), and
 * Cloudflare Workers have UNLIMITED free egress, hosting cost stays
 * at zero regardless of how many people view how many revisions.
 *
 * Env vars required (set in Worker Settings → Variables):
 *   WORKER_SECRET — shared with Vercel's WORKER_SHARED_SECRET env
 *                   var so this endpoint can't be hit by random
 *                   browsers (which would let them mint Drive
 *                   access tokens for any project).
 */

const VERCEL_AUTH_URL =
  'https://dm-plus.vercel.app/api/revisions?action=auth-stream'

// In-memory cache: key = `${shareToken}|${passwordToken}` → entry.
// Lives only within a single Worker isolate; cold starts re-auth.
// Drive access tokens live ~60 min; we cache for 50 min so a token
// fetched at the very start of the cache window is still valid when
// we serve the last request from it.
const authCache = new Map()
const AUTH_TTL_MS = 50 * 60 * 1000

function corsHeaders(extra) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, content-type',
    'access-control-expose-headers':
      'accept-ranges, content-length, content-range, content-type',
    // Default disposition is "inline" — the <video> tag plays the
    // response without Chrome triggering a Downloads-tray entry
    // for video/quicktime (and some other formats) the moment
    // streaming starts. Callers that want to FORCE a download
    // (the explicit "הורדה" link, when the editor enabled the
    // allowDownload toggle) override this to "attachment" via
    // the d=1 query param — see the dispositionFor() helper.
    'content-disposition': 'inline',
    ...(extra || {}),
  }
}

/** Pick the Content-Disposition header value based on the request's
 *  `d` query param. `d=1` switches to `attachment` + the original
 *  filename so the browser saves the response instead of playing
 *  it inline. Anything else falls through to `inline`. */
function dispositionFor(url) {
  if (url.searchParams.get('d') !== '1') return 'inline'
  // We don't know the real filename here — Vercel builds the URL
  // and could include a filename hint in the future, but for now
  // just use a generic name. The browser still respects the
  // editor's "save as" rename either way.
  return 'attachment; filename="video.mp4"'
}

async function fetchAuth(env, shareToken, passwordToken, roundId) {
  const r = await fetch(VERCEL_AUTH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-secret': env.WORKER_SECRET || '',
    },
    // roundId is needed for new-style project-group share tokens
    // (one token, many rounds). Legacy single-round tokens ignore
    // it. Both pass through with the same JSON body shape.
    body: JSON.stringify({ shareToken, passwordToken, roundId }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`auth ${r.status}: ${text.slice(0, 200)}`)
  }
  const json = await r.json()
  if (!json || !json.ok || !json.accessToken || !json.driveFileId) {
    throw new Error('auth response malformed')
  }
  return {
    accessToken: json.accessToken,
    driveFileId: json.driveFileId,
    expiresAt: Date.now() + AUTH_TTL_MS,
  }
}

async function getAuth(env, shareToken, passwordToken, roundId) {
  // Cache key includes roundId so a project's different rounds
  // don't accidentally collide. Without it, the first viewed round
  // would shadow every later one for ~50 min.
  const cacheKey = `${shareToken}|${passwordToken || ''}|${roundId || ''}`
  const hit = authCache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) return hit
  const fresh = await fetchAuth(env, shareToken, passwordToken, roundId)
  authCache.set(cacheKey, fresh)
  return fresh
}

async function fetchDrive(auth, request) {
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${auth.driveFileId}?alt=media`
  const headers = new Headers({
    authorization: `Bearer ${auth.accessToken}`,
  })
  const rangeHeader = request.headers.get('range')
  if (rangeHeader) headers.set('range', rangeHeader)
  return fetch(driveUrl, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
  })
}

export default {
  async fetch(request, env) {
    // CORS preflight — browsers send this before a Range request.
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
    const shareToken = url.searchParams.get('token')
    const passwordToken = url.searchParams.get('t') || ''
    // roundId — required for new-style project-group share tokens
    // (one token, many rounds). Legacy tokens that point at a single
    // round ignore it. Forwarded to Vercel so the auth-stream action
    // can resolve which round's video is being requested.
    const roundId = url.searchParams.get('r') || ''
    if (!shareToken) {
      return new Response('token required', {
        status: 400,
        headers: corsHeaders(),
      })
    }

    // Get a Drive access token (cached). Retry once on auth failure
    // — covers the rare case where a cached token expires between
    // cache check and Drive call.
    let auth
    try {
      auth = await getAuth(env, shareToken, passwordToken, roundId)
    } catch (err) {
      return new Response(`auth failed: ${err.message || err}`, {
        status: 403,
        headers: corsHeaders(),
      })
    }

    let driveResp = await fetchDrive(auth, request)
    if (driveResp.status === 401 || driveResp.status === 403) {
      // Cached token might be stale — invalidate and retry once.
      authCache.delete(`${shareToken}|${passwordToken || ''}|${roundId || ''}`)
      try {
        auth = await getAuth(env, shareToken, passwordToken, roundId)
        driveResp = await fetchDrive(auth, request)
      } catch (_err) {
        // Fall through — return original error response.
      }
    }

    // Stream Drive's body back to the browser. The body is a
    // ReadableStream so nothing is buffered in the Worker — we just
    // pipe bytes through. Forward the headers the <video> tag needs.
    const respHeaders = corsHeaders({
      // Override the default `inline` disposition when the caller
      // asked for a download (d=1) — see dispositionFor() comment.
      'content-disposition': dispositionFor(url),
    })
    const passthrough = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
    ]
    for (const h of passthrough) {
      const v = driveResp.headers.get(h)
      if (v) respHeaders[h] = v
    }
    // Drive sometimes omits accept-ranges even though it supports
    // byte ranges; advertise support so the player enables seeking.
    if (!respHeaders['accept-ranges']) {
      respHeaders['accept-ranges'] = 'bytes'
    }

    return new Response(driveResp.body, {
      status: driveResp.status,
      statusText: driveResp.statusText,
      headers: respHeaders,
    })
  },
}
