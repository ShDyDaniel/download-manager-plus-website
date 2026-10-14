// The money rules, proven. Run: npm run test:billing
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billing } from './load-billing.ts'

const { addCalendarSubscriptionPeriod, cancelMath, checkoutQuote, couponPriceFrom, upgradeProration, withVatS, DAY_MS } = billing
type TierS = 'free' | 'basic' | 'pro' | 'ultra'
type TierConfigS = Record<'priceMonthly' | 'priceMonthlySale' | 'priceYearly' | 'priceYearlySale', number> &
  Record<string, number | null>
type QuoteArgs = {
  tiers: Record<TierS, TierConfigS>
  plan: 'monthly' | 'yearly'
  tier: TierS
  currentTier: TierS | null
  currentPlan: 'monthly' | 'yearly' | null
  currentExpiresAtMs: number | null
  renewal: boolean
  coupon: { pct: number; duration: 'forever' | 'first' } | null
  nowMs: number
}
type CancelArgs = {
  plan: 'monthly' | 'yearly'
  tier: TierS
  charge: { amount: number; currency: string; at: string }
  completedCount: number
  priorCharges: number
  subscriptionPrice?: number
  regularMonthly: number
  feePct: number
  nowMs: number
  expiresAt: string | null
}

const limits = {
  quotesPerMonth: null,
  maxDownloadProjects: null,
  transcriptionMonthlySec: null,
  storageGb: null,
  maxRevisionProjects: null,
  maxDeliveryProjects: null,
  aiMonthlyTokens: null,
}
const tier = (m: number, y: number, ms = 0, ys = 0): TierConfigS => ({
  priceMonthly: m,
  priceMonthlySale: ms,
  priceYearly: y,
  priceYearlySale: ys,
  ...limits,
})
// Prices as the admin types them (incl. VAT).
const TIERS: Record<TierS, TierConfigS> = {
  free: tier(0, 0),
  basic: tier(29.9, 299),
  pro: tier(49.9, 499),
  ultra: tier(89.9, 899),
}

const T0 = Date.parse('2026-10-14T12:00:00Z')

/* ── calendar periods ── */
test('monthly = next calendar month, same day', () => {
  const d = addCalendarSubscriptionPeriod(new Date(2026, 0, 15, 10, 0), 30)
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 1, 15, 10])
})
test('yearly = same date next year', () => {
  const d = addCalendarSubscriptionPeriod(new Date(2026, 9, 14), 365)
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2027, 9, 14])
})
test('Jan 31 + month overflows into March (customer gets the extra days)', () => {
  const d = addCalendarSubscriptionPeriod(new Date(2027, 0, 31), 30)
  assert.deepEqual([d.getMonth(), d.getDate()], [2, 3])
})
test('Feb 29 + year → Mar 1', () => {
  const d = addCalendarSubscriptionPeriod(new Date(2028, 1, 29), 365)
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2029, 2, 1])
})
test('7-day grant = exactly 7×24h', () => {
  const from = new Date(2026, 9, 14)
  assert.equal(addCalendarSubscriptionPeriod(from, 7).getTime() - from.getTime(), 7 * DAY_MS)
})

/* ── VAT ── */
test('prices typed incl. VAT are untouched', () => {
  assert.equal(withVatS(TIERS, { pricesIncludeVat: true, vatPercent: 18, cancelFeePct: 10 }), TIERS)
})
test('prices typed excl. VAT get +18% to the agora; 0 stays 0', () => {
  const t = withVatS(
    { ...TIERS, pro: tier(100, 999.9, 0, 850) },
    { pricesIncludeVat: false, vatPercent: 18, cancelFeePct: 10 },
  )
  assert.equal(t.pro.priceMonthly, 118)
  assert.equal(t.pro.priceYearly, 1179.88)
  assert.equal(t.pro.priceMonthlySale, 0)
  assert.equal(t.pro.priceYearlySale, 1003)
  assert.equal(t.basic.priceMonthly, 35.28) // 29.9 × 1.18 = 35.282
  assert.equal(t.free.priceMonthly, 0)
  assert.equal(TIERS.pro.priceMonthly, 49.9, 'the stored prices are not mutated')
})
test('VAT 0% = untouched', () => {
  assert.equal(withVatS(TIERS, { pricesIncludeVat: false, vatPercent: 0, cancelFeePct: 10 }), TIERS)
})

/* ── coupons ── */
test('coupon price: whole shekels, never below ₪1', () => {
  assert.equal(couponPriceFrom(100, 10), 90)
  assert.equal(couponPriceFrom(49.9, 15), 42) // 42.415
  assert.equal(couponPriceFrom(49.9, 50), 25) // 24.95 → 25
  assert.equal(couponPriceFrom(100, 100), 1)
  assert.equal(couponPriceFrom(5, 95), 1)
})

/* ── checkout ── */
const q = (o: Partial<QuoteArgs>) =>
  checkoutQuote({ tiers: TIERS, plan: 'monthly', tier: 'pro', currentTier: null, currentPlan: null, currentExpiresAtMs: null, nowMs: T0, renewal: false, coupon: null, ...o })

test('new purchase, every tier and plan = the list price', () => {
  for (const t of ['basic', 'pro', 'ultra'] as const)
    for (const plan of ['monthly', 'yearly'] as const) {
      const r = q({ tier: t, plan })!
      const price = plan === 'monthly' ? TIERS[t].priceMonthly : TIERS[t].priceYearly
      assert.deepEqual([r.firstCharge, r.recurring, r.shape], [price, price, 'single'], `${t}/${plan}`)
    }
})
test('a tier without a price cannot be bought', () => {
  assert.equal(q({ tier: 'free' }), null)
})
test('sale wins only when positive and below regular', () => {
  const tiers = { ...TIERS, pro: tier(49.9, 499, 39.9, 0) }
  assert.equal(checkoutQuote({ tiers, plan: 'monthly', tier: 'pro', currentTier: null, currentPlan: null, currentExpiresAtMs: null, nowMs: T0, renewal: false, coupon: null })!.firstCharge, 39.9)
  const bad = { ...TIERS, pro: tier(49.9, 499, 59.9, 0) }
  assert.equal(checkoutQuote({ tiers: bad, plan: 'monthly', tier: 'pro', currentTier: null, renewal: false, coupon: null })!.firstCharge, 49.9)
})
test('coupon "first": discounted first cycle, then the full price', () => {
  const r = q({ coupon: { pct: 20, duration: 'first' } })!
  assert.deepEqual([r.firstCharge, r.recurring, r.shape, r.couponUsed], [40, 49.9, 'intro', true])
})
test('coupon "forever": discounted every cycle', () => {
  const r = q({ plan: 'yearly', coupon: { pct: 20, duration: 'forever' } })!
  assert.deepEqual([r.firstCharge, r.recurring, r.shape], [399, 399, 'single'])
})
test('coupon "forever" never stacks with a sale — the cheaper wins', () => {
  const tiers = { ...TIERS, pro: tier(49.9, 499, 34.9, 0) }
  const base = { tiers, plan: 'monthly' as const, tier: 'pro' as const, currentTier: null, currentPlan: null, currentExpiresAtMs: null, nowMs: T0, renewal: false }
  const small = checkoutQuote({ ...base, coupon: { pct: 10, duration: 'forever' } })! // 45 > 34.9
  assert.deepEqual([small.firstCharge, small.couponUsed], [34.9, false])
  const big = checkoutQuote({ ...base, coupon: { pct: 50, duration: 'forever' } })! // 25 < 34.9
  assert.deepEqual([big.firstCharge, big.couponUsed], [25, true])
})
test('coupon "first" stacks on top of a sale (applied to the effective price)', () => {
  const tiers = { ...TIERS, pro: tier(49.9, 499, 39.9, 0) }
  const r = checkoutQuote({ tiers, plan: 'monthly', tier: 'pro', currentTier: null, currentPlan: null, currentExpiresAtMs: null, nowMs: T0, renewal: false, coupon: { pct: 50, duration: 'first' } })!
  assert.deepEqual([r.firstCharge, r.recurring], [20, 39.9])
})
test('coupons are ignored on renewals and plan changes', () => {
  const r = q({ renewal: true, currentTier: 'pro', currentPlan: 'monthly', currentExpiresAtMs: T0 + 10 * DAY_MS, coupon: { pct: 50, duration: 'forever' } })!
  assert.deepEqual([r.firstCharge, r.couponUsed, r.change], [49.9, false, 'renew'])
})

/* plan changes while the paid period runs (Daniel's rules) */
// a yearly period that started on T0 − elapsed days and ends a year later
const yearEnd = (elapsedDays: number) => {
  const start = new Date(T0 - elapsedDays * DAY_MS)
  return addCalendarSubscriptionPeriod(start, 365).getTime()
}
test('proration = the difference × the share of the period left, by time', () => {
  const exp = yearEnd(0)
  assert.equal(upgradeProration({ diff: 200, plan: 'yearly', expiresAtMs: exp, nowMs: T0 }), 200)
  assert.equal(upgradeProration({ diff: 200, plan: 'yearly', expiresAtMs: exp, nowMs: exp }), 0)
  assert.equal(upgradeProration({ diff: 200, plan: 'yearly', expiresAtMs: exp, nowMs: exp + DAY_MS }), 0)
})
test('yearly Basic, upgraded to Pro a day later: pays the difference for 364 of 365 days, now', () => {
  const exp = yearEnd(1)
  const r = q({ tier: 'pro', plan: 'yearly', renewal: true, currentTier: 'basic', currentPlan: 'yearly', currentExpiresAtMs: exp })!
  const days = (exp - (exp - 365 * DAY_MS)) / DAY_MS // T0 is in a non-leap year
  assert.equal(days, 365)
  assert.deepEqual(
    [r.firstCharge, r.recurring, r.shape, r.start, r.change],
    [round((200 * 364) / 365), 499, 'setup', 'period-end', 'prorated'],
  )
  assert.equal(r.firstCharge, 199.45)
})
test('monthly upgrade with 10 of 30 days left pays a third of the difference', () => {
  const start = new Date(2026, 8, 14, 12) // Sep 14 → Oct 14: 30 days
  const exp = addCalendarSubscriptionPeriod(start, 30).getTime()
  const r = q({ tier: 'ultra', plan: 'monthly', renewal: true, currentTier: 'basic', currentPlan: 'monthly', currentExpiresAtMs: exp, nowMs: exp - 10 * DAY_MS })!
  assert.deepEqual([r.firstCharge, r.recurring, r.change], [20, 89.9, 'prorated']) // 60 × 10/30
})
test('upgrading in the last minutes costs (almost) nothing — and buys no extra time', () => {
  const exp = yearEnd(364.99)
  const r = q({ tier: 'pro', plan: 'yearly', renewal: true, currentTier: 'basic', currentPlan: 'yearly', currentExpiresAtMs: exp })!
  assert.ok(r.firstCharge < 0.6)
  assert.equal(r.start, 'period-end', 'the full price starts at the same expiry')
})
test('proration uses both effective (sale) prices', () => {
  const tiers = { ...TIERS, basic: tier(29.9, 299, 19.9, 0) }
  const exp = T0 + 15 * DAY_MS
  const r = checkoutQuote({ tiers, plan: 'monthly', tier: 'pro', currentTier: 'basic', currentPlan: 'monthly', currentExpiresAtMs: exp, renewal: true, coupon: null, nowMs: T0 })!
  assert.equal(r.change, 'prorated')
  assert.ok(Math.abs(r.firstCharge - 15) < 0.6) // 30 × ~half a month
})
test('a "higher" tier that isn\'t dearer (sale) is a plain new period', () => {
  const tiers = { ...TIERS, ultra: tier(89.9, 899, 45, 0) }
  const r = checkoutQuote({ tiers, plan: 'monthly', tier: 'ultra', currentTier: 'pro', currentPlan: 'monthly', currentExpiresAtMs: T0 + 9 * DAY_MS, renewal: true, coupon: null, nowMs: T0 })!
  assert.deepEqual([r.firstCharge, r.change, r.why], [45, 'renew', 'upgrade-full'])
})
test('upgrade monthly → yearly waits for the paid month to end, then the full yearly price', () => {
  const r = q({ tier: 'ultra', plan: 'yearly', renewal: true, currentTier: 'pro', currentPlan: 'monthly', currentExpiresAtMs: T0 + 12 * DAY_MS })!
  assert.deepEqual([r.firstCharge, r.recurring, r.start, r.change, r.why], [0, 899, 'period-end', 'scheduled', 'upgrade-scheduled'])
})
test('upgrade yearly → monthly waits for the paid year to end', () => {
  const r = q({ tier: 'ultra', plan: 'monthly', renewal: true, currentTier: 'pro', currentPlan: 'yearly', currentExpiresAtMs: T0 + 200 * DAY_MS })!
  assert.deepEqual([r.firstCharge, r.recurring, r.change], [0, 89.9, 'scheduled'])
})
test('unknown current interval (old key) → scheduled, never a guessed difference', () => {
  const r = q({ tier: 'ultra', renewal: true, currentTier: 'pro', currentPlan: null, currentExpiresAtMs: T0 + 5 * DAY_MS })!
  assert.equal(r.change, 'scheduled')
})
test('downgrade waits for the paid period to end', () => {
  const r = q({ tier: 'basic', renewal: true, currentTier: 'ultra', currentPlan: 'monthly', currentExpiresAtMs: T0 + 5 * DAY_MS })!
  assert.deepEqual([r.firstCharge, r.recurring, r.change, r.why], [0, 29.9, 'scheduled', 'downgrade-scheduled'])
})
test('expired key: any tier change is just a new period at the full price, now', () => {
  const up = q({ tier: 'ultra', renewal: true, currentTier: 'basic', currentPlan: 'monthly', currentExpiresAtMs: T0 - DAY_MS })!
  assert.deepEqual([up.firstCharge, up.start, up.change], [89.9, 'now', 'renew'])
  const down = q({ tier: 'basic', plan: 'yearly', renewal: true, currentTier: 'ultra', currentPlan: 'yearly', currentExpiresAtMs: null })!
  assert.deepEqual([down.firstCharge, down.start, down.change], [299, 'now', 'renew'])
})
test('same-tier renewal = the plain price now, remaining days kept', () => {
  const r = q({ tier: 'pro', renewal: true, currentTier: 'pro', currentPlan: 'monthly', currentExpiresAtMs: T0 + 3 * DAY_MS })!
  assert.deepEqual([r.firstCharge, r.start, r.change], [49.9, 'now', 'renew'])
})

/* ── cancellation ── */
const NOW = Date.parse('2026-10-14T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString()
const c = (o: Partial<CancelArgs> & { amount?: number; days?: number }) =>
  cancelMath({
    plan: 'monthly',
    tier: 'pro',
    charge: { amount: o.amount ?? 49.9, currency: 'ILS', at: ago(o.days ?? 3) },
    completedCount: 1,
    priorCharges: 1,
    regularMonthly: 49.9,
    feePct: 10,
    nowMs: NOW,
    expiresAt: '2026-11-11T12:00:00.000Z',
    ...o,
  })

test('cooling-off: monthly, day 3 → everything back minus the fee (capped at 5%)', () => {
  const r = c({})
  // fee = min(10% × 49.9 = 4.99, 5% × 49.9 = 2.495, 100) = 2.50
  assert.deepEqual([r.mode, r.coolingOff, r.fee, r.refund], ['refund', true, 2.5, 47.4])
  assert.equal(r.accessEndsAt, new Date(NOW).toISOString(), 'access stops now')
})
test('cooling-off ends after exactly 14 days', () => {
  assert.equal(c({ days: 14 }).coolingOff, true)
  const r = c({ days: 14.01 })
  assert.deepEqual([r.coolingOff, r.mode, r.refund], [false, 'no-refund', 0])
  assert.equal(r.accessEndsAt, '2026-11-11T12:00:00.000Z', 'access runs to the end of the paid month')
})
test('no cooling-off on a second charge or a returning customer', () => {
  assert.equal(c({ completedCount: 2 }).coolingOff, false)
  assert.equal(c({ priorCharges: 2 }).coolingOff, false)
})
test('cooling-off: yearly, day 10 → fee is 10% of the monthly price', () => {
  const r = c({ plan: 'yearly', amount: 499, days: 10, subscriptionPrice: 499 })
  assert.deepEqual([r.fee, r.refund], [4.99, 494.01])
})
test('yearly after cooling-off: months used (rounded up) at the monthly price', () => {
  // day 40 → month 2 started → 2 × 49.9 = 99.8 used; 499 − 99.8 − 4.99 fee
  const r = c({ plan: 'yearly', amount: 499, days: 40, completedCount: 1, priorCharges: 2, subscriptionPrice: 499 })
  assert.deepEqual([r.mode, r.monthsUsed, r.usedValue, r.fee, r.refund], ['refund', 2, 99.8, 4.99, 394.21])
})
test('yearly: nothing back once the used months cover the charge', () => {
  // 10 × 49.9 = 499 → the yearly discount is used up after month 10
  const r = c({ plan: 'yearly', amount: 499, days: 290, priorCharges: 2, subscriptionPrice: 499 })
  assert.deepEqual([r.monthsUsed, r.mode, r.refund, r.fee], [10, 'no-refund', 0, 0])
  const r9 = c({ plan: 'yearly', amount: 499, days: 250, priorCharges: 2, subscriptionPrice: 499 })
  assert.deepEqual([r9.monthsUsed, r9.refund], [9, round(499 - 9 * 49.9 - 4.99)])
})
test('yearly charged at a non-standard amount (intro/coupon/upgrade) → manual', () => {
  const r = c({ plan: 'yearly', amount: 200, days: 40, priorCharges: 2, subscriptionPrice: 499 })
  assert.equal(r.mode, 'manual')
})
test('no regular monthly price set → monthly = yearly charge ÷ 12', () => {
  const r = c({ plan: 'yearly', amount: 600, days: 40, priorCharges: 2, regularMonthly: 0 })
  assert.deepEqual([r.monthlyPrice, r.usedValue, r.fee, r.refund], [50, 100, 5, 495])
})
test('fee never above ₪100', () => {
  const r = c({ plan: 'yearly', amount: 6000, days: 40, priorCharges: 2, regularMonthly: 600, feePct: 30 })
  assert.equal(r.fee, 100)
})
test('unreadable charge date → never cooling-off, treated as fully used', () => {
  const r = cancelMath({
    plan: 'yearly', tier: 'pro', charge: { amount: 499, currency: 'ILS', at: 'garbage' },
    completedCount: 1, priorCharges: 1, regularMonthly: 49.9, feePct: 10, nowMs: NOW, expiresAt: null,
  })
  assert.deepEqual([r.coolingOff, r.monthsUsed, r.refund], [false, 12, 0])
})
test('refund is never negative and never more than the charge', () => {
  for (let days = 0; days <= 400; days += 0.5)
    for (const plan of ['monthly', 'yearly'] as const) {
      const amount = plan === 'yearly' ? 499 : 49.9
      const r = c({ plan, amount, days, subscriptionPrice: amount, priorCharges: days > 14 ? 2 : 1 })
      assert.ok(r.refund >= 0 && r.refund <= amount, `${plan} day ${days}: ${r.refund}`)
      assert.ok(r.refund === 0 || r.fee >= 0)
    }
})

function round(n: number) {
  return Math.round(n * 100) / 100
}
