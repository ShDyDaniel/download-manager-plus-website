import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Check, Crown, Loader2 } from 'lucide-react'

/**
 * Pricing / purchase section. Renders the single "Pro" tier card
 * with PayPal Smart Buttons embedded inline — no redirect to
 * PayPal's site; the popup PayPal opens stays on top of our page
 * and closes back into it after the customer approves.
 *
 * The flow:
 *   1. PayPal SDK loads via the public script tag in `index.html`
 *      (rendered conditionally so non-buyers don't pay the perf
 *      cost on every page load).
 *   2. `createOrder` defines the order client-side — a one-shot
 *      60 ₪ charge tagged as "Pro license — 365 days". We
 *      intentionally don't use Subscriptions because they require a
 *      PayPal Business Account; one-time renewals once a year keep
 *      us inside the free Personal-account envelope while testing
 *      market fit.
 *   3. `onApprove` posts the orderID + buyer email to our Vercel
 *      function `/api/capture` which (a) captures the payment via
 *      PayPal REST, (b) mints a fresh license key in Firestore,
 *      and (c) emails the buyer the key via Resend.
 *   4. UI flips to a "success — check your email" state.
 *
 * No customer-facing key generation here — that's all backend, so
 * a tampered frontend can't mint a free key.
 */

const PRICE_ILS = '60.00'
const CURRENCY = 'ILS'

type Status =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'success'; email: string }
  | { kind: 'error'; message: string }

// PayPal SDK globals — the SDK script attaches `paypal` to window.
// We don't bundle their types because the script is loaded at
// runtime, not via npm.
type PayPalActions = {
  order: {
    create: (config: {
      purchase_units: { amount: { value: string; currency_code: string }; description: string }[]
      application_context: { brand_name: string; user_action: string; shipping_preference: string }
    }) => Promise<string>
    capture: () => Promise<{ id: string }>
  }
}
type PayPalButton = {
  render: (selector: string) => Promise<void>
}
declare global {
  interface Window {
    paypal?: {
      Buttons: (opts: {
        style?: { layout?: string; color?: string; shape?: string; label?: string; height?: number }
        createOrder: (data: unknown, actions: PayPalActions) => Promise<string>
        onApprove: (data: { orderID: string }, actions: PayPalActions) => Promise<void>
        onError: (err: unknown) => void
        onCancel: () => void
      }) => PayPalButton
    }
  }
}

export function Pricing() {
  const buttonContainer = useRef<HTMLDivElement>(null)
  const [email, setEmail] = useState('')
  const [emailLocked, setEmailLocked] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const emailRef = useRef(email)
  emailRef.current = email

  // Render the PayPal button once the SDK is on the page. The
  // SDK injects a global `paypal` object; we poll briefly because
  // the <script> tag in index.html loads async.
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const tryRender = () => {
      if (cancelled) return
      if (!window.paypal) {
        attempts += 1
        // Give up after ~5s. Most browsers/networks load the SDK in
        // under 1s; anything slower than 5s is a network issue and
        // the user will see the "loading" state.
        if (attempts > 50) return
        setTimeout(tryRender, 100)
        return
      }
      if (!buttonContainer.current) return
      // Wipe any prior render — useful on hot reload during dev.
      buttonContainer.current.innerHTML = ''
      window.paypal
        .Buttons({
          style: {
            layout: 'vertical',
            color: 'gold',
            shape: 'rect',
            label: 'pay',
            height: 48,
          },
          createOrder: (_data, actions) => {
            return actions.order.create({
              purchase_units: [
                {
                  amount: { value: PRICE_ILS, currency_code: CURRENCY },
                  description: 'ניהול הורדות פלוס — Pro (365 ימים)',
                },
              ],
              application_context: {
                brand_name: 'ניהול הורדות פלוס',
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
              },
            })
          },
          onApprove: async (data) => {
            setStatus({ kind: 'processing' })
            try {
              const r = await fetch('/api/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  orderID: data.orderID,
                  email: emailRef.current,
                }),
              })
              const json = (await r.json()) as { ok: boolean; error?: string }
              if (!r.ok || !json.ok) {
                throw new Error(
                  json.error || 'התשלום אושר אך יצירת המפתח נכשלה',
                )
              }
              setStatus({ kind: 'success', email: emailRef.current })
            } catch (err) {
              const message =
                err instanceof Error ? err.message : 'שגיאה לא ידועה'
              setStatus({ kind: 'error', message })
            }
          },
          onError: (err) => {
            console.error('PayPal error', err)
            setStatus({
              kind: 'error',
              message: 'התרחשה שגיאה בתהליך התשלום. נסה שוב.',
            })
          },
          onCancel: () => {
            setStatus({ kind: 'idle' })
            setEmailLocked(false)
          },
        })
        .render('#paypal-button-container')
        .catch((err) => console.error('PayPal render failed', err))
    }
    tryRender()
    return () => {
      cancelled = true
    }
  }, [emailLocked])

  // Lock the email field once the user submits — they can't change
  // it mid-checkout, otherwise the backend would email the key to
  // the wrong address.
  function confirmEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus({ kind: 'error', message: 'הזן כתובת מייל תקינה' })
      return
    }
    setStatus({ kind: 'idle' })
    setEmailLocked(true)
  }

  return (
    <section id="pricing" className="px-6 pb-20 pt-10">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
          className="mb-10 text-center"
        >
          <h2 className="text-3xl font-bold gradient-text md:text-4xl">
            קנה Pro
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-white/60 md:text-base">
            כל הפיצ'רים פתוחים, ללא הגבלות. תשלום שנתי בודד דרך PayPal.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.4 }}
          className="glass relative overflow-hidden rounded-3xl border border-amber-400/20 p-8 md:p-10"
        >
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 shadow-lg">
              <Crown className="h-6 w-6 text-white" />
            </div>
            <div>
              <h3 className="text-2xl font-bold">Pro</h3>
              <p className="text-xs text-white/60">רישיון ל-365 ימים</p>
            </div>
          </div>

          <div className="mb-6 flex items-baseline gap-2" dir="ltr">
            <span className="text-5xl font-bold tabular-nums">60</span>
            <span className="text-2xl text-white/70">₪</span>
            <span className="text-sm text-white/50">/ שנה</span>
          </div>

          <ul className="mb-8 space-y-2.5 text-sm">
            {[
              'מיון אוטומטי + חוקי ניתוב מותאמים אישית',
              'הורדה מסרטוני וידאו באיכויות 4K / 1080p / MP3',
              'המרת קבצים בין כל הפורמטים',
              'דחיסת וידאו לגודל יעד',
              'הצעות מחיר עם יועץ AI ופלט PDF',
              'ניהול תשלומים והכנסות',
              'עדכונים אוטומטיים ותמיכה מועדפת',
            ].map((t) => (
              <li key={t} className="flex items-start gap-2 text-white/85">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <span>{t}</span>
              </li>
            ))}
          </ul>

          {status.kind === 'success' ? (
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-center">
              <div className="mb-2 text-base font-semibold text-emerald-200">
                התשלום הושלם בהצלחה ✓
              </div>
              <p className="text-sm text-white/75">
                שלחנו לך מייל ל-
                <span dir="ltr" className="font-mono text-white/90">
                  {' '}
                  {status.email}{' '}
                </span>
                עם מפתח המוצר. פתח את התוכנה, לחץ "מימוש מפתח מוצר" והדבק.
              </p>
            </div>
          ) : status.kind === 'processing' ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-5 text-amber-200">
              <Loader2 className="h-4 w-4 animate-spin" />
              מייצר עבורך מפתח ושולח במייל...
            </div>
          ) : !emailLocked ? (
            <form onSubmit={confirmEmail} className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs text-white/70">
                  כתובת מייל לקבלת המפתח
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  dir="ltr"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-base placeholder:text-white/30 focus:border-amber-400/50 focus:outline-none"
                />
              </label>
              <button
                type="submit"
                className="w-full rounded-xl bg-gradient-to-l from-amber-500 to-orange-500 px-6 py-3 text-base font-semibold text-white shadow-lg transition-transform hover:scale-[1.01]"
              >
                המשך לתשלום
              </button>
            </form>
          ) : (
            <>
              <div className="mb-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-2.5 text-sm">
                <span className="text-white/50">המפתח יישלח ל-</span>
                <span dir="ltr" className="font-mono text-white/90">
                  {' '}
                  {email}{' '}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEmailLocked(false)
                    setStatus({ kind: 'idle' })
                  }}
                  className="float-left text-xs text-amber-300/80 hover:text-amber-200"
                >
                  שינוי
                </button>
              </div>
              {status.kind === 'error' && (
                <div className="mb-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
                  {status.message}
                </div>
              )}
              <div id="paypal-button-container" ref={buttonContainer} />
              <p className="mt-4 text-center text-[11px] text-white/50">
                התשלום מאובטח דרך PayPal. אתה לא מועבר לאתר חיצוני — חלון
                התשלום נפתח כאן באתר.
              </p>
            </>
          )}
        </motion.div>
      </div>
    </section>
  )
}
