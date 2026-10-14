// replay.ts sale <subscriptionId> <amount>      — a PAYMENT.SALE.COMPLETED (renewal / scheduled start)
// replay.ts ended <subscriptionId> [CANCELLED|EXPIRED]
// Posts a PayPal-shaped webhook to the LOCAL sandbox server only.
import crypto from 'node:crypto'
const [kind, subId, arg] = process.argv.slice(2)
const id = `WH-LOCAL-${crypto.randomBytes(6).toString('hex')}`
const event =
  kind === 'sale'
    ? {
        id,
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: {
          id: `SALE-LOCAL-${crypto.randomBytes(4).toString('hex')}`,
          amount: { total: Number(arg).toFixed(2), currency: 'ILS' },
          billing_agreement_id: subId,
          transaction_fee: { value: (Number(arg) * 0.034 + 1.2).toFixed(2), currency: 'ILS' },
          state: 'completed',
        },
      }
    : { id, event_type: `BILLING.SUBSCRIPTION.${arg || 'CANCELLED'}`, resource: { id: subId } }
const r = await fetch('http://localhost:3001/api/paypal?action=webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'paypal-transmission-id': `LOCAL-REPLAY-${id}`,
    'paypal-transmission-time': new Date().toISOString(),
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/local',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'local',
  },
  body: JSON.stringify(event),
})
console.log(r.status, await r.text())
