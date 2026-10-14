// Firestore-emulator helpers for the sandbox runs (never production: the
// emulator host is required, and the project is a demo- id).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeApp, cert, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const here = dirname(fileURLToPath(import.meta.url))
for (const line of readFileSync(join(here, '.env.sandbox'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^'(.*)'$/s, '$1')
}
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('emulator only')

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!)) })
export const db = getFirestore()

const limits = {
  quotesPerMonth: null, maxDownloadProjects: null, transcriptionMonthlySec: null, storageGb: 10,
  maxRevisionProjects: 1, maxDeliveryProjects: 1, aiMonthlyTokens: 0,
}
const t = (m: number, y: number, ms = 0, ys = 0) => ({ priceMonthly: m, priceMonthlySale: ms, priceYearly: y, priceYearlySale: ys, ...limits })

/** Test prices, incl. VAT (same as tests/billing.test.ts). */
export async function seedConfig() {
  await db.doc('appConfig/tiers').set({
    tiers: { free: t(0, 0), basic: t(29.9, 299), pro: t(49.9, 499), ultra: t(89.9, 899) },
    pricesIncludeVat: true,
    vatPercent: 18,
    cancelFeePct: 10,
  })
  await db.doc('appConfig/pricing').set({ monthly: { regular: 49.9 }, yearly: { regular: 499 }, currency: 'ILS' })
}

if (process.argv[2] === 'seed') {
  await seedConfig()
  console.log('seeded appConfig/tiers + appConfig/pricing')
}
