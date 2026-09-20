/**
 * Show — and carefully extend — the storage bucket's cross-origin rules.
 *
 * The delivery page builds the client's zip IN THEIR BROWSER, pulling each
 * video straight from storage so no bytes pass through our server. For that
 * the browser has to be allowed to READ those objects from our own origin,
 * which is a setting on the bucket, not something the code can grant itself.
 *
 * Uploads already work from the browser, so a policy is almost certainly in
 * place. This script therefore NEVER replaces it: it reads what is there,
 * adds only what is missing, prints the difference, and refuses to write
 * unless asked twice.
 *
 *   node scripts/r2-cors.mjs --show     # print the current rules, change nothing
 *   node scripts/r2-cors.mjs --apply    # add the missing read permission
 *
 * Needs R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 * in the environment — the same four the API uses. With the Vercel CLI:
 *   vercel env pull .env.production --environment=production
 *   set -a && . ./.env.production && set +a && node scripts/r2-cors.mjs --show
 */
import {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3'

const ORIGINS = ['https://www.dmplus.net', 'https://dmplus.net']
const NEEDED_METHODS = ['GET', 'HEAD']

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } =
  process.env

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error(
    'Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET.',
  )
  process.exit(1)
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
})

async function current() {
  try {
    const r = await s3.send(new GetBucketCorsCommand({ Bucket: R2_BUCKET }))
    return r.CORSRules ?? []
  } catch (e) {
    // A bucket with no policy at all answers with an error rather than a
    // blank list, and that is not a failure — it is the answer.
    if (e?.name === 'NoSuchCORSConfiguration' || e?.Code === 'NoSuchCORSConfiguration')
      return []
    throw e
  }
}

const covers = (rule, origin) =>
  (rule.AllowedOrigins ?? []).some((o) => o === '*' || o === origin)

function missing(rules) {
  const gaps = []
  for (const origin of ORIGINS) {
    const forOrigin = rules.filter((r) => covers(r, origin))
    for (const method of NEEDED_METHODS) {
      const allowed = forOrigin.some((r) =>
        (r.AllowedMethods ?? []).includes(method),
      )
      if (!allowed) gaps.push(`${method} from ${origin}`)
    }
  }
  return gaps
}

const rules = await current()
console.log(`bucket: ${R2_BUCKET}`)
console.log(`rules in place: ${rules.length}`)
console.log(JSON.stringify(rules, null, 2))

const gaps = missing(rules)
if (gaps.length === 0) {
  console.log('\nThe browser may already read files from our pages. Nothing to do.')
  process.exit(0)
}
console.log('\nNot allowed yet:')
for (const g of gaps) console.log('  - ' + g)

if (!process.argv.includes('--apply')) {
  console.log('\nRun again with --apply to add a rule for these. Nothing was changed.')
  process.exit(0)
}

// Add, never replace: every existing rule is carried over untouched.
const addition = {
  AllowedOrigins: ORIGINS,
  AllowedMethods: NEEDED_METHODS,
  AllowedHeaders: ['*'],
  // The zip needs to know how big each file is as it streams.
  ExposeHeaders: ['Content-Length', 'Content-Range', 'ETag', 'Content-Type'],
  MaxAgeSeconds: 3600,
}
const next = [...rules, addition]
console.log('\nWriting:')
console.log(JSON.stringify(next, null, 2))
await s3.send(
  new PutBucketCorsCommand({
    Bucket: R2_BUCKET,
    CORSConfiguration: { CORSRules: next },
  }),
)
console.log('\nDone. Re-run with --show to confirm.')
