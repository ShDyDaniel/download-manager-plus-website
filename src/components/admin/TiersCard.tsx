import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Layers, Save, Check } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'
import {
  TIER_ORDER,
  TIER_LABEL,
  DEFAULT_TIER_CONFIG,
  type Tier,
  type TierConfig,
} from '@/lib/tiers'

/**
 * Per-TIER config editor (Free / Basic / Pro / Ultra) — the admin panel is the
 * source of truth for prices + storage GB + every numeric quota, persisted to
 * appConfig/tiers via `admin-set-tiers` (step-up gated). Mirrors how the single
 * price is edited elsewhere, generalized to four tiers.
 *
 * Nullable fields (quotes / download-projects / transcription) use an EMPTY
 * input to mean "unlimited". Prices only show for paid tiers (Free is never
 * bought). Transcription is edited in MINUTES and stored as seconds.
 */

type Cfg = Record<Tier, TierConfig>

/** Fields whose empty value means "unlimited" (stored as null). */
const NULLABLE = new Set<keyof TierConfig>([
  'quotesPerMonth',
  'maxDownloadProjects',
  'transcriptionMonthlySec',
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
      if (raw.trim() === '') {
        value = NULLABLE.has(field) ? null : 0
      } else {
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

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Layers className="h-6 w-6 text-primary" />
        <div>
          <h3 className="text-lg font-bold font-display text-fg">מנויים (Free / Basic / Pro / Ultra)</h3>
          <p className="text-xs text-fg-muted">
            מחיר, אחסון וכל המכסות לכל מנוי. שדה ריק במכסות מסומנות = ללא הגבלה.
            השמירה מאובטחת ב-Face ID / Touch ID.
          </p>
        </div>
      </div>

      {err && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {!cfg ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {TIER_ORDER.map((tier) => (
              <TierColumn key={tier} tier={tier} cfg={cfg[tier]} onSet={set} />
            ))}
          </div>

          <div className="flex items-center gap-3 pt-1">
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
            {DEFAULT_TIER_CONFIG.basic.priceMonthly === 0 && (
              <span className="text-[11px] text-fg-muted">
                מחיר 0 = עדיין לא הוגדר. הזן מחירים לפני פתיחת המכירה.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function TierColumn({
  tier,
  cfg,
  onSet,
}: {
  tier: Tier
  cfg: TierConfig
  onSet: (tier: Tier, field: keyof TierConfig, raw: string) => void
}) {
  const paid = tier !== 'free'
  // Transcription is edited in MINUTES (stored as seconds).
  const minutes =
    cfg.transcriptionMonthlySec == null ? '' : String(Math.round(cfg.transcriptionMonthlySec / 60))
  const numOrEmpty = (v: number | null) => (v == null ? '' : String(v))

  return (
    <div
      className={cn(
        'space-y-2.5 rounded-xl border p-3',
        paid ? 'border-primary/25 bg-primary/[0.04]' : 'border-border bg-bg-elevated',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-fg">{TIER_LABEL[tier]}</span>
        {!paid && <span className="text-[10px] text-fg-muted">ללא תשלום</span>}
      </div>

      {paid && (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="מחיר חודשי"
            value={numOrEmpty(cfg.priceMonthly)}
            onChange={(v) => onSet(tier, 'priceMonthly', v)}
          />
          <Field
            label="מחיר שנתי"
            value={numOrEmpty(cfg.priceYearly)}
            onChange={(v) => onSet(tier, 'priceYearly', v)}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field
          label="אחסון (GB)"
          value={numOrEmpty(cfg.storageGb)}
          onChange={(v) => onSet(tier, 'storageGb', v)}
        />
        <Field
          label="תמלול (דק׳/חודש)"
          value={minutes}
          placeholder="∞"
          onChange={(v) =>
            onSet(tier, 'transcriptionMonthlySec', v.trim() === '' ? '' : String(Number(v) * 60))
          }
        />
        <Field
          label="הצעות מחיר/חודש"
          value={numOrEmpty(cfg.quotesPerMonth)}
          placeholder="∞"
          onChange={(v) => onSet(tier, 'quotesPerMonth', v)}
        />
        <Field
          label="הורדות במקביל"
          value={numOrEmpty(cfg.maxDownloadProjects)}
          placeholder="∞"
          onChange={(v) => onSet(tier, 'maxDownloadProjects', v)}
        />
        <Field
          label="תיקונים במקביל"
          value={numOrEmpty(cfg.maxRevisionProjects)}
          onChange={(v) => onSet(tier, 'maxRevisionProjects', v)}
        />
        <Field
          label="מסירות במקביל"
          value={numOrEmpty(cfg.maxDeliveryProjects)}
          onChange={(v) => onSet(tier, 'maxDeliveryProjects', v)}
        />
        <Field
          label="טוקני AI/חודש"
          value={numOrEmpty(cfg.aiMonthlyTokens)}
          onChange={(v) => onSet(tier, 'aiMonthlyTokens', v)}
        />
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
