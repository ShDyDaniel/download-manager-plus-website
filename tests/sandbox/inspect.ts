import { db } from './admin.ts'
const ev = await db.collection('paypalEvents').get()
for (const d of ev.docs.sort((a, b) => String(a.data().receivedAt).localeCompare(String(b.data().receivedAt)))) {
  const x = d.data()
  const r = x.rawResource || {}
  console.log(x.receivedAt, x.eventType, '| processed:', x.processed, '|', x.summary, x.error ? '| ERR ' + x.error : '',
    r.amount ? `| amount ${r.amount.total} ${r.amount.currency}` : '', r.billing_agreement_id ? `| sub ${r.billing_agreement_id}` : '', r.id ? `| res ${r.id}` : '')
}
const keys = await db.collection('productKeys').get()
for (const k of keys.docs) {
  const x = k.data()
  console.log('\nKEY', k.id, JSON.stringify({ tier: x.tier, planDays: x.planDays, expiresAt: x.expiresAt, subscriptionId: x.subscriptionId, subscriptionPrice: x.subscriptionPrice, status: x.subscriptionStatus, activationCharge: x.activationCharge, scheduledChange: x.scheduledChange, billingHistory: x.billingHistory, createdAt: x.createdAt }, null, 1))
}
const led = await db.collection('casualLedger').get()
for (const l of led.docs) console.log('LEDGER', l.id, JSON.stringify(l.data()))
process.exit(0)
