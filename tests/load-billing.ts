// Loads the money functions straight out of api/paypal.ts, so the tests prove
// the code that actually runs. They can't live in a shared module: paypal.ts
// must stay self-contained (relative imports from api/ broke production —
// see the note at its top), and importing paypal.ts itself would boot
// Firebase. So the named top-level declarations are cut out by text and run
// on their own.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAMES = [
  'TierS', 'TIER_KEYS_S', 'TierConfigS', 'TierPriceSettingsS', 'PRICE_FIELDS_S',
  'round2', 'addCalendarSubscriptionPeriod', 'withVatS', 'couponPriceFrom',
  'tierPrice', 'upgradeProration', 'CheckoutQuote', 'checkoutQuote',
  'COOLING_OFF_DAYS', 'DAY_MS', 'AVG_MONTH_DAYS', 'CancelTerms', 'cancelMath',
]
const RUNTIME = [
  'TIER_KEYS_S', 'PRICE_FIELDS_S', 'round2', 'addCalendarSubscriptionPeriod', 'withVatS',
  'couponPriceFrom', 'tierPrice', 'upgradeProration', 'checkoutQuote', 'COOLING_OFF_DAYS', 'DAY_MS',
  'AVG_MONTH_DAYS', 'cancelMath',
]

function extract(src: string[], name: string): string {
  const head = new RegExp(`^(function|const|type|interface) ${name}\\b`)
  const hits = src.flatMap((l, i) => (head.test(l) ? [i] : []))
  if (hits.length !== 1) throw new Error(`api/paypal.ts: expected one top-level ${name}, found ${hits.length}`)
  const start = hits[0]
  if (!/[{(]\s*$/.test(src[start])) return src[start]
  const end = src.findIndex((l, i) => i > start && l === '}')
  return src.slice(start, end + 1).join('\n')
}

const src = readFileSync(new URL('../api/paypal.ts', import.meta.url), 'utf8').split('\n')
const code = NAMES.map((n) => extract(src, n)).join('\n\n') + `\nexport { ${RUNTIME.join(', ')} }\n`
const file = join(mkdtempSync(join(tmpdir(), 'billing-')), 'billing.ts')
writeFileSync(file, code)

export const billing = await import(file)
