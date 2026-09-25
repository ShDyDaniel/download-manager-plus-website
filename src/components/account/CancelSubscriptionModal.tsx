import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react'
import { TIER_LABEL, type Tier } from '@/lib/tiers'

/**
 * Cancel-subscription dialog. Before anything happens it asks the server what
 * cancelling NOW means — the refund, the months counted, the fee, when access
 * ends — and shows exactly that. "כן, ביטול המנוי" sends back the refund the
 * customer saw; if the server's number moved meanwhile, nothing happens and
 * the fresh numbers are shown for a re-confirm. "התחרטתי" closes and changes
 * nothing. Refund rules live server-side (cancelMath in api/paypal.ts).
 */

type Terms = {
  plan: 'monthly' | 'yearly'
  tier: Tier
  mode: 'refund' | 'no-refund' | 'manual'
  coolingOff: boolean
  charge: { amount: number; currency: string; at: string } | null
  monthsUsed: number
  monthlyPrice: number
  usedValue: number
  fee: number
  refund: number
  accessEndsAt: string | null
}

type Done = { refundStatus: 'done' | 'manual' | 'none'; refunded: number; accessEndsAt: string | null }

const money = (n: number, currency = 'ILS') =>
  `${currency === 'ILS' ? '₪' : `${currency} `}${Number.isInteger(n) ? n : n.toFixed(2)}`

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Jerusalem',
      })
    : '—'

export function CancelSubscriptionModal({
  token,
  subscriptionId,
  onClose,
  onCancelled,
}: {
  token: string
  subscriptionId: string
  onClose: () => void
  onCancelled: () => void
}) {
  const [terms, setTerms] = useState<Terms | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=cancel-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, subscriptionId }),
        })
        const j = (await r.json().catch(() => null)) as { ok?: boolean; terms?: Terms; error?: string } | null
        if (!alive) return
        if (j?.ok && j.terms) setTerms(j.terms)
        else setLoadError(j?.error || 'לא הצלחנו לחשב כרגע את פרטי הביטול. נסו שוב בעוד רגע.')
      } catch {
        if (alive) setLoadError('שגיאת רשת. בדקו את החיבור ונסו שוב.')
      }
    })()
    return () => {
      alive = false
    }
  }, [token, subscriptionId])

  async function confirm() {
    if (!terms) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/paypal?action=cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          subscriptionId,
          reason: reason.trim() || 'user requested',
          expectedRefund: terms.refund,
        }),
      })
      const j = (await r.json().catch(() => null)) as
        | ({ ok?: boolean; error?: string; changed?: boolean; terms?: Terms; alreadyCancelled?: boolean } & Partial<Done>)
        | null
      if (j?.changed && j.terms) {
        // The numbers moved (e.g. a month rolled over) — show them again.
        setTerms(j.terms)
        setError(j.error || 'סכום ההחזר התעדכן. בדקו את הפרטים ואשרו שוב.')
        return
      }
      if (!r.ok || !j?.ok) {
        setError(j?.error || 'הביטול נכשל. נסו שוב.')
        return
      }
      setDone({
        refundStatus: j.refundStatus ?? 'none',
        refunded: j.refunded ?? 0,
        accessEndsAt: j.accessEndsAt ?? terms.accessEndsAt,
      })
      onCancelled()
    } catch {
      setError('שגיאת רשת. בדקו את החיבור ונסו שוב.')
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (!busy) onClose()
  }
  const cur = terms?.charge?.currency || 'ILS'
  const planName = terms
    ? `${TIER_LABEL[terms.tier] ?? ''} ${terms.plan === 'yearly' ? 'שנתי' : 'חודשי'}`
    : ''

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="card-elevated relative w-full max-w-md rounded-2xl border-border p-6 md:p-7">
        <button
          onClick={close}
          className="absolute left-3 top-3 rounded-md p-1 text-fg-muted hover:text-fg"
          aria-label="סגור"
        >
          <X className="h-4 w-4" />
        </button>

        {done ? (
          <>
            <h3 className="mb-3 flex items-center gap-2 text-base font-bold text-fg">
              <CheckCircle2 className="h-4 w-4 text-accent" />
              המנוי בוטל
            </h3>
            <div className="space-y-2 text-sm leading-relaxed text-fg-muted">
              <p>לא תחויב יותר. שלחנו אליך מייל עם אישור הביטול.</p>
              {done.refundStatus === 'done' && (
                <p>
                  הוחזרו <strong className="text-fg"><bdi dir="ltr">{money(done.refunded, cur)}</bdi></strong> לאמצעי
                  התשלום שבו שילמת דרך PayPal. בכרטיס אשראי זה מופיע בדרך כלל תוך כמה ימי עסקים. החשבון חזר
                  למסלול החינמי.
                </p>
              )}
              {done.refundStatus === 'manual' && (
                <p>את ההחזר על החלק שלא נוצל נחשב ונשלח אליך תוך שלושה ימי עסקים.</p>
              )}
              {done.refundStatus !== 'done' && done.accessEndsAt && (
                <p>
                  הגישה למסלול נשארת פעילה עד <bdi dir="ltr">{day(done.accessEndsAt)}</bdi>.
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="mt-5 w-full rounded-md border border-border px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg-elevated"
            >
              סגירה
            </button>
          </>
        ) : (
          <>
            <h3 className="mb-3 flex items-center gap-2 text-base font-bold text-fg">
              <AlertTriangle className="h-4 w-4 text-accent" />
              ביטול המנוי
            </h3>

            {!terms && !loadError && (
              <div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                מחשב מה יקרה בביטול…
              </div>
            )}
            {loadError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {loadError}
              </div>
            )}

            {terms && (
              <>
                <p className="mb-3 text-sm leading-relaxed text-fg-muted">
                  זה מה שיקרה אם תבטל עכשיו את המנוי <strong className="text-fg">{planName}</strong>:
                </p>

                <div className="mb-3 space-y-1.5 rounded-xl border border-border bg-bg-elevated p-3 text-sm">
                  {terms.charge && (
                    <Row label="החיוב האחרון">
                      <bdi dir="ltr">{money(terms.charge.amount, cur)}</bdi> ·{' '}
                      <bdi dir="ltr">{day(terms.charge.at)}</bdi>
                    </Row>
                  )}
                  {terms.mode === 'refund' && terms.coolingOff && (
                    <Row label="ביטול בתוך ארבעה עשר יום מהרכישה">כל הסכום חוזר</Row>
                  )}
                  {terms.mode === 'refund' && !terms.coolingOff && (
                    <Row
                      label="חודשים שנוצלו, לפי המחיר החודשי הרגיל"
                      hint={`${terms.monthsUsed} × ${money(terms.monthlyPrice, cur)}`}
                    >
                      <bdi dir="ltr">−{money(terms.usedValue, cur)}</bdi>
                    </Row>
                  )}
                  {terms.mode === 'refund' && terms.fee > 0 && (
                    <Row label="דמי ביטול">
                      <bdi dir="ltr">−{money(terms.fee, cur)}</bdi>
                    </Row>
                  )}
                  {terms.mode === 'refund' && (
                    <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
                      <span className="font-semibold text-fg">יוחזר אליך</span>
                      <span className="text-base font-bold text-accent">
                        <bdi dir="ltr">{money(terms.refund, cur)}</bdi>
                      </span>
                    </div>
                  )}
                </div>

                <ul className="mb-4 space-y-1.5 text-xs leading-relaxed text-fg-muted">
                  <li>• לא תחויב יותר.</li>
                  {terms.mode === 'refund' && (
                    <>
                      <li>• הגישה למסלול תיפסק מיד, והחשבון יחזור למסלול החינמי.</li>
                      <li>
                        • ההחזר יחזור לאמצעי התשלום שבו שילמת דרך PayPal. בכרטיס אשראי הוא מופיע בדרך כלל תוך כמה
                        ימי עסקים, ולפעמים רק בחיוב החודשי הבא.
                      </li>
                    </>
                  )}
                  {terms.mode === 'no-refund' && terms.plan === 'monthly' && (
                    <li>
                      • הגישה נשארת פעילה עד <bdi dir="ltr">{day(terms.accessEndsAt)}</bdi>, סוף החודש ששולם. אין
                      החזר על חודש שכבר התחיל.
                    </li>
                  )}
                  {terms.mode === 'no-refund' && terms.plan === 'yearly' && (
                    <li>
                      • לא נשאר סכום להחזר: החודשים שנוצלו, לפי המחיר החודשי הרגיל, כבר עוברים את מה ששולם. הגישה
                      נשארת פעילה עד <bdi dir="ltr">{day(terms.accessEndsAt)}</bdi>.
                    </li>
                  )}
                  {terms.mode === 'manual' && (
                    <li>
                      • במנוי שלך יש חיוב מיוחד, כמו שדרוג באמצע התקופה או הנחה. את ההחזר על החלק שלא נוצל נחשב
                      ונשלח אליך ידנית תוך שלושה ימי עסקים. הגישה נשארת פעילה עד אז.
                    </li>
                  )}
                </ul>

                <label className="block">
                  <span className="mb-1 block text-[11px] text-fg-muted">סיבה לביטול (לא חובה)</span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value.slice(0, 500))}
                    rows={2}
                    disabled={busy}
                    className="w-full resize-none rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-60"
                    placeholder="לדוגמה: לא משתמש מספיק, יקר, חסרה תכונה…"
                  />
                </label>
              </>
            )}

            {error && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => void confirm()}
                disabled={busy || !terms}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                כן, ביטול המנוי
              </button>
              <button
                onClick={close}
                disabled={busy}
                className="flex-1 rounded-md border border-border px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg-elevated disabled:opacity-60"
              >
                התחרטתי
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-fg-muted">
        {label}
        {/* No brackets around the numbers: bracketed Latin/digits inside a
            Hebrew line render back to front. */}
        {hint && (
          <span className="mr-1 text-[11px] text-fg-faint">
            · <bdi dir="ltr">{hint}</bdi>
          </span>
        )}
      </span>
      <span className="shrink-0 text-fg">{children}</span>
    </div>
  )
}
