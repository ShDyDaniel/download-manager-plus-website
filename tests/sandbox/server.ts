// Local stand-in for Vercel: runs the real api/*.ts handlers on
// http://localhost:3001 against the Firestore emulator and PayPal's SANDBOX,
// so the whole payment flow can be exercised without touching production.
//   node --experimental-strip-types tests/sandbox/server.ts
// Reads tests/sandbox/.env.sandbox (git-ignored). Refuses to start unless
// that file points at the sandbox and the emulator — never at live data.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

for (const line of readFileSync(join(here, '.env.sandbox'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m) process.env[m[1]] = m[2].replace(/^'(.*)'$/s, '$1')
}
if (process.env.PAYPAL_ENV !== 'sandbox') throw new Error('PAYPAL_ENV must be sandbox')
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST must be set')
for (const k of ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SUMIT_API_KEY', 'TELEGRAM_ALERT_BOT_TOKEN', 'CF_API_TOKEN']) {
  if (process.env[k]) throw new Error(`${k} must not be set in the sandbox`)
}

// Replays of future events (a renewal next month, a scheduled plan change
// taking over) can't come from PayPal today. tests/sandbox/replay.ts posts
// them with a LOCAL-REPLAY- transmission id, and only for those this local
// server answers PayPal's signature check itself. Real PayPal events are
// still verified by PayPal.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.includes('/v1/notifications/verify-webhook-signature') && typeof init?.body === 'string') {
    const b = JSON.parse(init.body) as { transmission_id?: string }
    if (b.transmission_id?.startsWith('LOCAL-REPLAY-')) {
      return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
  return realFetch(input, init)
}) as typeof fetch

type Handler = (req: unknown, res: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
async function handlerFor(path: string): Promise<Handler | null> {
  const parts = path.replace(/^\/api\//, '').split('/').filter(Boolean)
  for (const cand of [parts.join('/'), parts[0]]) {
    const file = join(root, 'api', `${cand}.ts`)
    if (!cand || !existsSync(file)) continue
    if (!handlers.has(file)) handlers.set(file, (await import(file)).default as Handler)
    return handlers.get(file)!
  }
  return null
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function wrapRes(res: ServerResponse) {
  const r = res as ServerResponse & Record<string, unknown>
  r.status = (code: number) => {
    res.statusCode = code
    return r
  }
  r.json = (obj: unknown) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
    return r
  }
  r.send = (body: unknown) => {
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    return r
  }
  r.redirect = (a: number | string, b?: string) => {
    res.statusCode = typeof a === 'number' ? a : 302
    res.setHeader('Location', String(typeof a === 'number' ? b : a))
    res.end()
    return r
  }
  return r
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const started = Date.now()
  try {
    const h = await handlerFor(url.pathname)
    if (!h) {
      res.statusCode = 404
      return res.end('no handler')
    }
    const vreq = Object.assign(req, {
      query: Object.fromEntries(url.searchParams),
      body: req.method === 'GET' ? undefined : await readBody(req),
      cookies: {},
    })
    await h(vreq, wrapRes(res))
  } catch (err) {
    console.error('[sandbox] handler threw:', err)
    if (!res.headersSent) res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: String(err) }))
  } finally {
    console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`)
  }
}).listen(3001, () => console.log('[sandbox] API on http://localhost:3001 (PayPal SANDBOX, Firestore emulator)'))
