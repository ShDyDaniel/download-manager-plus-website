import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Plus, Trash2, Ticket } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'

/* Coupons tab — discount codes for the /buy checkout.
 *
 * SECURITY: the client only ever sends the CODE; the discount %, the
 * final price and the PayPal plan are all resolved server-side, capped
 * at 50% with a price floor — a forged request can never buy Pro at 0.
 * This tab just manages the code list; all mutations are step-up gated. */

interface AdminCoupon {
  code: string
  pct: number
  plans: 'monthly' | 'yearly' | 'both'
  duration: 'forever' | 'first'
  active: boolean
  expiresAt: number | null
  maxUses: number | null
  usedCount: number
  note: string
  createdAt: string
}

export default function CouponsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [coupons, setCoupons] = useState<AdminCoupon[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // create form
  const [code, setCode] = useState('')
  const [pct, setPct] = useState('20')
  const [plans, setPlans] = useState<'monthly' | 'yearly' | 'both'>('both')
  const [duration, setDuration] = useState<'forever' | 'first'>('forever')
  const [maxUses, setMaxUses] = useState('')
  const [expiresDays, setExpiresDays] = useState('')
  const [note, setNote] = useState('')

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err instanceof Error ? err.message : 'שגיאה')
  }

  const load = async () => {
    setError('')
    try {
      const r = await adminApi<{ coupons: AdminCoupon[] }>('admin-list-coupons')
      setCoupons(r.coupons || [])
    } catch (e) {
      handleErr(e)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      await adminApi('admin-create-coupon', {
        code: code.trim().toUpperCase(),
        pct: Number(pct) || 0,
        plans,
        duration,
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresDays
          ? Date.now() + Number(expiresDays) * 86400000
          : null,
        note: note.trim(),
      })
      setCode('')
      setPct('20')
      setMaxUses('')
      setExpiresDays('')
      setNote('')
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (c: AdminCoupon) => {
    try {
      await adminApi('admin-set-coupon-active', {
        code: c.code,
        active: !c.active,
      })
      await load()
    } catch (e) {
      handleErr(e)
    }
  }
  const remove = async (c: AdminCoupon) => {
    if (!window.confirm(`למחוק את הקופון ${c.code}? הפעולה אינה הפיכה.`)) return
    try {
      await adminApi('admin-delete-coupon', { code: c.code })
      await load()
    } catch (e) {
      handleErr(e)
    }
  }

  const planLabel = (p: string) =>
    p === 'monthly' ? 'חודשי' : p === 'yearly' ? 'שנתי' : 'שניהם'

  return (
    <div className="space-y-5">
      <header>
        <h2 className="flex items-center gap-2 text-3xl font-bold font-display text-fg">
          <Ticket className="h-7 w-7 text-primary" />
          קופונים
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          קודי הנחה לעמוד הרכישה. ההנחה מוגבלת ל-50%, המחיר תמיד מחושב בשרת,
          ולא מצטברת עם מבצע פעיל (הלקוח מקבל את הזול מביניהם).
        </p>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* create */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-fg">יצירת קופון חדש</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <label className="text-xs text-fg-secondary">
            קוד
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="SUMMER20"
              dir="ltr"
              className="mt-1"
            />
          </label>
          <label className="text-xs text-fg-secondary">
            אחוז הנחה (עד 50)
            <Input
              type="number"
              min={1}
              max={50}
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              dir="ltr"
              className="mt-1"
            />
          </label>
          <label className="text-xs text-fg-secondary">
            תוכניות
            <select
              value={plans}
              onChange={(e) => setPlans(e.target.value as typeof plans)}
              className="mt-1 w-full rounded-lg border border-border bg-bg-elevated px-2 py-2 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="both">שניהם</option>
              <option value="monthly">חודשי בלבד</option>
              <option value="yearly">שנתי בלבד</option>
            </select>
          </label>
        </div>

        {/* duration — the headline choice */}
        <div>
          <div className="mb-1.5 text-xs text-fg-secondary">משך ההנחה</div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                [
                  'forever',
                  'קבוע לתמיד',
                  'ההנחה חלה על כל חיוב — גם על החידושים.',
                ],
                [
                  'first',
                  'תקופה ראשונה בלבד',
                  'רק החודש/שנה הראשונים מוזלים, אחר כך מחיר מלא.',
                ],
              ] as const
            ).map(([val, title, sub]) => (
              <button
                key={val}
                type="button"
                onClick={() => setDuration(val)}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-right transition-colors',
                  duration === val
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-bg-elevated hover:bg-popover',
                )}
              >
                <div
                  className={cn(
                    'text-sm font-semibold',
                    duration === val ? 'text-primary' : 'text-fg',
                  )}
                >
                  {title}
                </div>
                <div className="mt-0.5 text-[11px] text-fg-muted">{sub}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <label className="text-xs text-fg-secondary">
            מגבלת שימושים (ריק=ללא)
            <Input
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="∞"
              dir="ltr"
              className="mt-1"
            />
          </label>
          <label className="text-xs text-fg-secondary">
            תוקף בימים (ריק=ללא)
            <Input
              type="number"
              min={1}
              value={expiresDays}
              onChange={(e) => setExpiresDays(e.target.value)}
              placeholder="∞"
              dir="ltr"
              className="mt-1"
            />
          </label>
          <label className="text-xs text-fg-secondary">
            הערה (פנימית)
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1"
            />
          </label>
        </div>

        <Button
          onClick={() => void create()}
          disabled={busy || !code.trim() || !(Number(pct) >= 1)}
          className="w-full"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          יצירת קופון
        </Button>
      </div>

      {/* list */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-fg">קופונים קיימים</h3>
        {coupons === null ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
          </div>
        ) : coupons.length === 0 ? (
          <div className="py-4 text-center text-xs text-fg-muted">
            אין קופונים עדיין.
          </div>
        ) : (
          <div className="space-y-2">
            {coupons.map((c) => (
              <div
                key={c.code}
                className={cn(
                  'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2.5 text-xs',
                  c.active
                    ? 'border-border bg-bg-elevated'
                    : 'border-border bg-card opacity-60',
                )}
              >
                <span className="font-mono text-sm font-bold text-fg" dir="ltr">
                  {c.code}
                </span>
                <span className="rounded-md bg-primary/15 px-2 py-0.5 font-semibold text-primary">
                  {c.pct}%
                </span>
                <span className="rounded-md bg-popover px-2 py-0.5 text-fg-secondary">
                  {c.duration === 'first' ? 'תקופה ראשונה' : 'קבוע'}
                </span>
                <span className="text-fg-muted">{planLabel(c.plans)}</span>
                <span className="text-fg-muted">
                  נוצל <bdi dir="ltr">{c.usedCount}</bdi>
                  {c.maxUses ? (
                    <>
                      {' / '}
                      <bdi dir="ltr">{c.maxUses}</bdi>
                    </>
                  ) : (
                    ''
                  )}
                </span>
                {c.expiresAt && (
                  <span className="text-fg-muted">
                    עד{' '}
                    <bdi dir="ltr">
                      {new Date(c.expiresAt).toLocaleDateString('he-IL')}
                    </bdi>
                  </span>
                )}
                {c.note && <span className="text-fg-faint">· {c.note}</span>}
                <div className="ms-auto flex items-center gap-2">
                  <Switch
                    checked={c.active}
                    onCheckedChange={() => void toggle(c)}
                  />
                  <button
                    type="button"
                    onClick={() => void remove(c)}
                    className="rounded-md p-1 text-fg-muted transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="מחיקה"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
