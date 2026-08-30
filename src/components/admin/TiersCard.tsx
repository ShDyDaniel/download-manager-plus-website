import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Layers, Tag, SlidersHorizontal, Save, Check } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
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
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await adminApi<{ tiers: Cfg }>('admin-get-tiers')
        setCfg(r.tiers)
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
      const r = await adminApi<{ tiers: Cfg }>('admin-set-tiers', { tiers: cfg })
      setCfg(r.tiers)
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
        <div className="grid gap-3 md:grid-cols-3">
          {PAID_TIERS.map((tier) => (
            <PriceColumn key={tier} tier={tier} cfg={cfg[tier]} onSet={set} />
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
  onSet,
}: {
  tier: Tier
  cfg: TierConfig
  onSet: (tier: Tier, field: keyof TierConfig, raw: string) => void
}) {
  const numOrEmpty = (v: number) => (v ? String(v) : '')
  return (
    <div className="space-y-2.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 text-primary" />
        <span className="text-sm font-bold text-fg">{TIER_LABEL[tier]}</span>
      </div>
      <div className="text-[11px] font-semibold text-fg-secondary">חודשי</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="רגיל (₪)" value={numOrEmpty(cfg.priceMonthly)} onChange={(v) => onSet(tier, 'priceMonthly', v)} />
        <Field label="מבצע (₪)" value={numOrEmpty(cfg.priceMonthlySale)} placeholder="—" onChange={(v) => onSet(tier, 'priceMonthlySale', v)} />
      </div>
      <div className="text-[11px] font-semibold text-fg-secondary">שנתי</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="רגיל (₪)" value={numOrEmpty(cfg.priceYearly)} onChange={(v) => onSet(tier, 'priceYearly', v)} />
        <Field label="מבצע (₪)" value={numOrEmpty(cfg.priceYearlySale)} placeholder="—" onChange={(v) => onSet(tier, 'priceYearlySale', v)} />
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
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
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
    </label>
  )
}
