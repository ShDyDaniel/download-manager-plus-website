// Preframe's accounts server on this computer, for trying the app without Firebase or Vercel:
// the same PREFRAME section of api/paypal.ts, with a database in memory (empty at every start)
// and development tokens "dev.<uid>.<email>" instead of real sign-in.
//
//   node --experimental-strip-types tests/preframe-dev.ts        → http://127.0.0.1:8792/api/paypal
//
// Never deployed. Preframe's dev app and its sync Worker point here (VITE_ACCOUNTS_URL /
// ACCOUNTS_URL default to it in development).
import { createServer } from 'node:http'
import { memStore, pf } from './load-preframe.ts'

const store = memStore()
const PORT = Number(process.env.PORT) || 8792
/** Milliseconds every room check waits, to try the app as it feels against the real site
 *  (a server instance that has to wake up). PREFRAME_DEV_DELAY=1500 npm run preframe:dev */
const DELAY = Number(process.env.PREFRAME_DEV_DELAY) || 0

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  if (req.method === 'OPTIONS') return void res.writeHead(204).end()
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/api/paypal' || url.searchParams.get('action') !== 'preframe' || req.method !== 'POST') return void res.writeHead(404).end()
  let text = ''
  for await (const chunk of req) text += chunk
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text || '{}')
  } catch {
    /* empty */
  }
  const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
  // Frameline's sign-up, as far as the sign-in page needs it: an address with "taken" in it
  // already has an account; any six digits are the right code.
  if (body.op === 'signup-request-code' || body.op === 'signup-verify-code') {
    const taken = String(body.email ?? '').includes('taken')
    const out = taken ? { status: 409, body: { ok: false, error: 'כתובת המייל כבר רשומה. התחבר עם הסיסמה שלך.' } } : { status: 200, body: { ok: true } }
    return void res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(out.body))
  }
  if (DELAY && body.op === 'room') await new Promise((r) => setTimeout(r, DELAY))
  const out = await pf.pfHandle(body, token, {
    store,
    verify: async (t: string) => {
      const dev = /^dev\.([a-z0-9]{2,40})\.(\S+@\S+)$/.exec(t)
      return dev ? { uid: dev[1], email: dev[2].toLowerCase(), emailVerified: true, name: dev[1] } : null
    },
    resetPassword: async (email: string) => console.log(`(a reset email would go to ${email})`),
    // The local sync server (Preframe's sync/ npm run dev), as the real site tells the real one.
    notify: async (projectId: string, uid: string) => {
      await fetch('http://127.0.0.1:8790/notify', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId, uid }) }).catch(() => undefined)
    },
    now: Date.now(),
  })
  res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(out.body))
}).listen(PORT, '127.0.0.1', () => console.log(`Preframe accounts (dev, in memory): http://127.0.0.1:${PORT}/api/paypal?action=preframe`))
