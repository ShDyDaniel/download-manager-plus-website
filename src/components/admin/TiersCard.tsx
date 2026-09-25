import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Layers, Tag, SlidersHorizontal, Save, Check } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import {
  TIER_ORDER,
  PAID_TIERS,
  TIER_LABEL,
  DEFAULT_TIER_CONFIG,
  type Tier,
  type TierConfig,
} from '@/lib/tiers'

/**
 * Per-TIER config editor — the admin panel is the source of truth for prices
 * + storage + quotas (appConfig/tiers, saved via `admin-set-tiers`, step-up
 * gated). Two SEPARATE sections: PRICES (monthly/yearly regular + sale per
 * paid tier) and QUOTAS/FEATURES (per tier). One save persists both.
 *
 * Nullable quota fields use an EMPTY input to mean "unlimited". Transcription
 * is edited in MINUTES and stored as seconds. Price 0 = unset ("בקרוב").
 */

type Cfg = Record<Tier, TierConfig>

/** Whether the typed prices already include VAT. When they don't, the server
 *  adds VAT to every customer-facing price and charge (Israeli consumers must
 *  see the full price); the typed values are stored as they are. */
type VatSettings = {
  pricesIncludeVat: boolean
  vatPercent: number
  /** Cancellation fee, % of the tier's regular monthly price. The server also
   *  caps it at 5% of the charge or ₪100 (the statutory maximum). */
  cancelFeePct: number
}

/** What the customer pays for a typed price — mirrors withVatS in api/paypal.ts. */
function customerPrice(v: number, vat: VatSettings): number {
  if (vat.pricesIncludeVat || vat.vatPercent <= 0 || v <= 0) return v
  return Math.round(v * (1 + vat.vatPercent / 100) * 100) / 100
}

// Empty input on any of these = "unlimited" (stored as null).
const NULLABLE = new Set<keyof TierConfig>([
  'quotesPerMonth',
  'maxDownloadProjects',
  'transcriptionMonthlySec',
  'storageGb',
  'maxRevisionProjects',
  'maxDeliveryProjects',
  'aiMonthlyTokens',
])

export default function TiersCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [vat, setVat] = useState<VatSettings>({ pricesIncludeVat: true, vatPercent: 18, cancelFeePct: 10 })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await adminApi<{ tiers: Cfg } & Partial<VatSettings>>('admin-get-tiers')
        setCfg(r.tiers)
        setVat((v) => ({
          pricesIncludeVat: r.pricesIncludeVat ?? v.pricesIncludeVat,
          vatPercent: r.vatPercent ?? v.vatPercent,
          cancelFeePct: r.cancelFeePct ?? v.cancelFeePct,
        }))
      } catch (e) {
        onErr(e)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function set(tier: Tier, field: keyof TierConfig, raw: string) {
    setSaved(false)
    setCfg((c) => {
      if (!c) return c
      let value: number | null
      if (raw.trim() === '') value = NULLABLE.has(field) ? null : 0
      else {
        const n = Number(raw)
        value = Number.isFinite(n) && n >= 0 ? n : c[tier][field] ?? 0
      }
      return { ...c, [tier]: { ...c[tier], [field]: value } }
    })
  }

  async function save() {
    if (!cfg) return
    setBusy(true)
    setErr('')
    try {
      const r = await adminApi<{ tiers: Cfg } & Partial<VatSettings>>('admin-set-tiers', {
        tiers: cfg,
        ...vat,
      })
      setCfg(r.tiers)
      setVat((v) => ({
        pricesIncludeVat: r.pricesIncludeVat ?? v.pricesIncludeVat,
        vatPercent: r.vatPercent ?? v.vatPercent,
        cancelFeePct: r.cancelFeePct ?? v.cancelFeePct,
      }))
      setSaved(true)
    } catch (e) {
      const error = e as Error & { code?: string }
      if (error.code === 'auth') return onErr(error)
      setErr(error.message || 'השמירה נכשלה')
    } finally {
      setBusy(false)
    }
  }

  if (!cfg) {
    return (
      <div className="flex justify-center rounded-2xl border border-border bg-card py-8">
        <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {/* ── SECTION 1: PRICES ── */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Tag className="h-6 w-6 text-primary" />
          <div>
            <h3 className="text-lg font-bold font-display text-fg">מחירים</h3>
            <p className="text-xs text-fg-muted">
              מחיר חודשי ושנתי לכל מנוי, כולל אפשרות למחיר מבצע. מבצע חל רק כשהוא
              נמוך מהמחיר הרגיל. מחיר 0 = עדיין לא נמכר ("בקרוב").
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-bg-elevated px-3 py-2.5">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-fg">
            <Switch
              checked={vat.pricesIncludeVat}
              onCheckedChange={(on) => {
                setSaved(false)
                setVat((v) => ({ ...v, pricesIncludeVat: on }))
              }}
            />
            המחירים שאני מזין כוללים מע״מ
          </label>
          {!vat.pricesIncludeVat && (
            <label className="flex items-center gap-2 text-[11px] text-fg-secondary">
              שיעור המע״מ באחוזים
              <Input
                type="number"
                min={0}
                max={100}
                value={String(vat.vatPercent)}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n) || n < 0 || n > 100) return
                  setSaved(false)
                  setVat((v) => ({ ...v, vatPercent: n }))
                }}
                dir="ltr"
                className="h-8 w-16 text-sm"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-[11px] text-fg-secondary">
            דמי ביטול באחוזים מהמחיר החודשי
            <Input
              type="number"
              min={0}
              max={100}
              value={String(vat.cancelFeePct)}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (!Number.isFinite(n) || n < 0 || n > 100) return
                setSaved(false)
                setVat((v) => ({ ...v, cancelFeePct: n }))
              }}
              dir="ltr"
              className="h-8 w-16 text-sm"
            />
          </label>
          <p className="w-full text-[11px] text-fg-muted">
            דמי הביטול יורדים מההחזר כשמנוי מבוטל. המערכת לא תגבה יותר מחמישה אחוזים מהחיוב או מאה שקל,
            הנמוך מביניהם — זו התקרה בחוק.
          </p>
          <p className="w-full text-[11px] text-fg-muted">
            {vat.pricesIncludeVat
              ? 'המחיר שמוזן הוא המחיר הסופי שהלקוח רואה ומשלם.'
              : 'המערכת מוסיפה מע״מ לכל מחיר: באתר, בחיוב ובשדרוגים. מתחת לכל שדה מופיע המחיר שהלקוח ישלם. מנויים קיימים ממשיכים במחיר שבו נרשמו.'}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {PAID_TIERS.map((tier) => (
            <PriceColumn key={tier} tier={tier} cfg={cfg[tier]} vat={vat} onSet={set} />
          ))}
        </div>
      </div>

      {/* ── SECTION 2: QUOTAS / FEATURES ── */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-6 w-6 text-primary" />
          <div>
            <h3 className="text-lg font-bold font-display text-fg">מכסות ותכונות</h3>
            <p className="text-xs text-fg-muted">
              אחסון, דקות תמלול, פרויקטים במקביל וטוקני AI לכל מנוי. שדה ריק במכסות
              מסומנות = ללא הגבלה.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {TIER_ORDER.map((tier) => (
            <QuotaColumn key={tier} tier={tier} cfg={cfg[tier]} onSet={set} />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={busy} className="gap-2">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <Check className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saved ? 'נשמר' : 'שמירת כל המנויים'}
        </Button>
        {DEFAULT_TIER_CONFIG.pro.priceMonthly === 0 && (
          <span className="text-[11px] text-fg-muted">
            הזן מחירים לפני פתיחת המכירה — מחיר 0 מציג "בקרוב".
          </span>
        )}
      </div>
    </div>
  )
}

function PriceColumn({
  tier,
  cfg,
  vat,
  onSet,
}: {
  tier: Tier
  cfg: TierConfig
  vat: VatSettings
  onSet: (tier: Tier, field: keyof TierConfig, raw: string) => void
}) {
  const numOrEmpty = (v: number) => (v ? String(v) : '')
  // Only when VAT is added on top — otherwise the typed price IS the price.
  const hint = (v: number) =>
    !vat.pricesIncludeVat && v > 0 ? `ללקוח: ₪${customerPrice(v, vat)}` : undefined
  return (
    <div className="space-y-2.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 text-primary" />
        <span className="text-sm font-bold text-fg">{TIER_LABEL[tier]}</span>
      </div>
      <div className="text-[11px] font-semibold text-fg-secondary">חודשי</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="רגיל (₪)" value={numOrEmpty(cfg.priceMonthly)} hint={hint(cfg.priceMonthly)} onChange={(v) => onSet(tier, 'priceMonthly', v)} />
        <Field label="מבצע (₪)" value={numOrEmpty(cfg.priceMonthlySale)} hint={hint(cfg.priceMonthlySale)} placeholder="—" onChange={(v) => onSet(tier, 'priceMonthlySale', v)} />
      </div>
      <div className="text-[11px] font-semibold text-fg-secondary">שנתי</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="רגיל (₪)" value={numOrEmpty(cfg.priceYearly)} hint={hint(cfg.priceYearly)} onChange={(v) => onSet(tier, 'priceYearly', v)} />
        <Field label="מבצע (₪)" value={numOrEmpty(cfg.priceYearlySale)} hint={hint(cfg.priceYearlySale)} placeholder="—" onChange={(v) => onSet(tier, 'priceYearlySale', v)} />
      </div>
    </div>
  )
}

function QuotaColumn({
  tier,
  cfg,
  onSet,
}: {
  tier: Tier
  cfg: TierConfig
  onSet: (tier: Tier, field: keyof TierConfig, raw: string) => void
}) {
  const minutes =
    cfg.transcriptionMonthlySec == null ? '' : String(Math.round(cfg.transcriptionMonthlySec / 60))
  const numOrEmpty = (v: number | null) => (v == null ? '' : String(v))
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-bg-elevated p-3">
      <span className="text-sm font-bold text-fg">{TIER_LABEL[tier]}</span>
      <p className="text-[10px] text-fg-muted">שדה ריק = ללא הגבלה (∞).</p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="אחסון (GB)" value={numOrEmpty(cfg.storageGb)} placeholder="∞" onChange={(v) => onSet(tier, 'storageGb', v)} />
        <Field
          label="תמלול (דק׳/חודש)"
          value={minutes}
          placeholder="∞"
          onChange={(v) => onSet(tier, 'transcriptionMonthlySec', v.trim() === '' ? '' : String(Number(v) * 60))}
        />
        <Field label="הצעות מחיר/חודש" value={numOrEmpty(cfg.quotesPerMonth)} placeholder="∞" onChange={(v) => onSet(tier, 'quotesPerMonth', v)} />
        <Field label="הורדות במקביל" value={numOrEmpty(cfg.maxDownloadProjects)} placeholder="∞" onChange={(v) => onSet(tier, 'maxDownloadProjects', v)} />
        <Field label="תיקונים במקביל" value={numOrEmpty(cfg.maxRevisionProjects)} placeholder="∞" onChange={(v) => onSet(tier, 'maxRevisionProjects', v)} />
        <Field label="מסירות במקביל" value={numOrEmpty(cfg.maxDeliveryProjects)} placeholder="∞" onChange={(v) => onSet(tier, 'maxDeliveryProjects', v)} />
        <Field label="טוקני AI/חודש" value={numOrEmpty(cfg.aiMonthlyTokens)} placeholder="∞" onChange={(v) => onSet(tier, 'aiMonthlyTokens', v)} />
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  /** A line under the input — the customer-facing price when VAT is added. */
  hint?: string
  onChange: (v: string) => void
}) {
  return (
    <label className="text-[11px] text-fg-secondary">
      {label}
      <Input
        type="number"
        min={0}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        dir="ltr"
        className="mt-0.5 h-8 text-sm"
      />
      {hint && <span className="mt-0.5 block text-[10px] font-medium text-primary">{hint}</span>}
    </label>
  )
}
