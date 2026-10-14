// renew-token.ts <KEY>                         — a renew token for a sandbox key
// renew-token.ts session <email> <subId>...     — a customer session token
// (same HMAC scheme as api/paypal.ts)
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync(new URL('./.env.sandbox', import.meta.url), 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m![1], m![2]]))
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
const now = Math.floor(Date.now() / 1000)
const claims =
  process.argv[2] === 'session'
    ? { uid: 'sandbox-uid', email: process.argv[3], subscriptionIds: process.argv.slice(4), iat: now, exp: now + 3600 }
    : { uid: 'sandbox-uid', key: process.argv[2], exp: now + 3600 }
const p = b64(JSON.stringify(claims))
const s = b64(crypto.createHmac('sha256', env.RENEW_TOKEN_SECRET).update(`${h}.${p}`).digest())
console.log(`${h}.${p}.${s}`)
