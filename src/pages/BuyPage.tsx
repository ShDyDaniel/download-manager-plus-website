import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Crown, Loader2 } from 'lucide-react'

/**
 * Dedicated purchase page at `/buy`. The buyer picks a plan
 * (monthly vs yearly), types their email, and pays via PayPal
 * Smart Buttons that render inline — the popup PayPal opens stays
 * on top of our page so the customer never feels they've left.
 *
 * Pricing decision:
 *   - Yearly: 60 ₪ → 365 days. Equivalent to 5 ₪/month.
 *   - Monthly: 9 ₪ → 30 days. The 9-vs-5 gap is the discount that
 *     pushes most buyers toward yearly.
 *
 * The "monthly" plan is technically a one-shot 30-day pass, not a
 * recurring PayPal Subscription — auto-renewing subs need a PayPal
 * Business account, which we're explicitly avoiding for the MVP.
 * The buyer comes back and re-pays each month if they want to
 * extend. The UI calls this out under the monthly card so nobody
 * is surprised.
 */

type Plan = 'monthly' | 'yearly'

const PLANS: Record<Plan, { price: string; days: number; label: string }> = {
  monthly: { price: '9.00', days: 30, label: 'חודשי' },
  yearly: { price: '60.00', days: 365, label: 'שנתי' },
}
const CURRENCY = 'ILS'

type Status =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'success'; email: string }
  | { kind: 'error'; message: string }

type PayPalActions = {
  order: {
    create: (config: {
      purchase_units: { amount: { value: string; currency_code: string }; description: string }[]
      application_context: { brand_name: string; user_action: string; shipping_preference: string }
    }) => Promise<string>
    capture: () => Promise<{ id: string }>
  }
}
type PayPalButton = { render: (selector: string) => Promise<void> }
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

export function BuyPage() {
  const [plan, setPlan] = useState<Plan>('yearly')
  const [email, setEmail] = useState('')
  const [emailLocked, setEmailLocked] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const planRef = useRef(plan)
  planRef.current = plan
  const emailRef = useRef(email)
  emailRef.current = email
  const buttonContainer = useRef<HTMLDivElement>(null)

  // Render the PayPal button once the SDK is on the page AND the
  // user has committed to a plan + email. The SDK polls because
  // it loads async from the CDN.
  useEffect(() => {
    if (!emailLocked) return
    let cancelled = false
    let attempts = 0
    const tryRender = () => {
      if (cancelled) return
      if (!window.paypal) {
        attempts += 1
        if (attempts > 50) return
        setTimeout(tryRender, 100)
        return
      }
      if (!buttonContainer.current) return
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
            const p = PLANS[planRef.current]
            return actions.order.create({
              purchase_units: [
                {
                  amount: { value: p.price, currency_code: CURRENCY },
                  description: `ניהול הורדות פלוס — Pro ${p.label} (${p.days} ימים)`,
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
                  plan: planRef.current,
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
          onCancel: () => setStatus({ kind: 'idle' }),
        })
        .render('#paypal-button-container')
        .catch((err) => console.error('PayPal render failed', err))
    }
    tryRender()
    return () => {
      cancelled = true
    }
  }, [emailLocked])

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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen px-6 py-12 md:py-20"
    >
      <div className="mx-auto max-w-3xl">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-white/60 transition-colors hover:text-white"
        >
          <ArrowRight className="h-4 w-4" />
          חזרה לדף הבית
        </Link>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="mb-10 text-center"
        >
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-300">
            <Crown className="h-3 w-3" />
            Pro
          </div>
          <h1 className="text-3xl font-bold gradient-text md:text-4xl">
            בחר את התוכנית שלך
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-white/60 md:text-base">
            כל הפיצ'רים פתוחים, ללא הגבלות. תוכל לעבור בין התוכניות מתי שתרצה.
          </p>
        </motion.div>

        {/* Plan toggle — two cards side by side, click to select.
            Yearly is preselected because it's the better deal and we
            want most buyers to land there by default. */}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <PlanCard
            plan="monthly"
            active={plan === 'monthly'}
            onSelect={() => setPlan('monthly')}
            title="חודשי"
            price="9"
            cycle="לחודש"
            note="מתחדש ידנית מדי 30 יום"
          />
          <PlanCard
            plan="yearly"
            active={plan === 'yearly'}
            onSelect={() => setPlan('yearly')}
            title="שנתי"
            price="60"
            cycle="לשנה"
            note="שווה ערך ל-5 ₪/חודש"
            badge="חיסכון 44%"
          />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="glass rounded-3xl border border-white/10 p-6 md:p-8"
        >
          <h2 className="mb-4 text-sm font-semibold text-white/90">
            הכל פתוח עם Pro:
          </h2>
          <ul className="mb-7 space-y-2 text-sm">
            {[
              'מיון אוטומטי + חוקי ניתוב מותאמים אישית',
              'הורדה מסרטוני וידאו ב-4K / 1080p / MP3',
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
                המשך לתשלום — {PLANS[plan].price.replace('.00', '')} ₪
              </button>
            </form>
          ) : (
            <>
              <div className="mb-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="text-white/50">מייל: </span>
                    <span dir="ltr" className="font-mono text-white/90">
                      {email}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEmailLocked(false)
                      setStatus({ kind: 'idle' })
                    }}
                    className="text-xs text-amber-300/80 hover:text-amber-200"
                  >
                    שינוי
                  </button>
                </div>
                <div className="mt-1 text-xs text-white/40">
                  תוכנית: {PLANS[plan].label} · {PLANS[plan].price.replace('.00', '')} ₪
                </div>
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
    </motion.div>
  )
}

function PlanCard({
  active,
  onSelect,
  title,
  price,
  cycle,
  note,
  badge,
}: {
  plan: Plan
  active: boolean
  onSelect: () => void
  title: string
  price: string
  cycle: string
  note: string
  badge?: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative rounded-2xl border p-5 text-right transition-all ${
        active
          ? 'border-amber-400/50 bg-amber-500/[0.08] shadow-lg shadow-amber-900/20'
          : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
      }`}
    >
      {badge && (
        <span className="absolute left-3 top-3 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
          {badge}
        </span>
      )}
      <div className="mb-3 flex items-center gap-2">
        <div
          className={`h-4 w-4 shrink-0 rounded-full border-2 transition-colors ${
            active ? 'border-amber-400 bg-amber-400' : 'border-white/30'
          }`}
        >
          {active && (
            <div className="m-auto mt-[3px] h-1.5 w-1.5 rounded-full bg-zinc-950" />
          )}
        </div>
        <span className="text-base font-semibold">{title}</span>
      </div>
      <div className="mb-1 flex items-baseline gap-1.5" dir="ltr">
        <span className="text-4xl font-bold tabular-nums">{price}</span>
        <span className="text-lg text-white/70">₪</span>
        <span className="text-xs text-white/50">/ {cycle}</span>
      </div>
      <div className="text-[11px] text-white/50">{note}</div>
    </button>
  )
}
