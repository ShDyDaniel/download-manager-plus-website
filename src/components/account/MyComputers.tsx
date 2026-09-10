import { useCallback, useEffect, useState } from 'react'
import { Monitor, Loader2, Check } from 'lucide-react'

interface SeatDevice {
  deviceId: string
  claimedAt: string | null
  lastSeenAt: string | null
  platform: string | null
  appVersion: string | null
  model: string | null
  blocked: boolean
  active: boolean
}

function ago(s: string | null): string {
  if (!s) return '—'
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) return '—'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'עכשיו'
  if (m < 60) return `לפני ${m} דק׳`
  const h = Math.floor(m / 60)
  if (h < 24) return `לפני ${h} שע׳`
  const d = Math.floor(h / 24)
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`
}

async function api<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/paypal?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await r.json().catch(() => ({}))) as T
}

/**
 * "The computers on my account", in the personal area.
 *
 * Reading is free; RELEASING deliberately isn't. It needs a code sent to the
 * account's email, because being signed in to this page proves only that
 * someone has a session — not that they're the person paying for the plan. A
 * borrowed laptop must not be able to evict the owner's machine.
 */
export function MyComputers({ token }: { token: string }) {
  const [devices, setDevices] = useState<SeatDevice[] | null>(null)
  const [seats, setSeats] = useState<number | null>(null)
  const [exempt, setExempt] = useState(false)
  const [error, setError] = useState('')
  const [target, setTarget] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [released, setReleased] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const j = await api<{
        ok?: boolean
        error?: string
        exempt?: boolean
        seats?: number | null
        devices?: SeatDevice[]
      }>('device-list', { sessionToken: token })
      if (!j.ok) {
        setError(j.error === 'unauthorized' ? '' : j.error || 'טעינה נכשלה')
        setDevices([])
        return
      }
      setExempt(j.exempt === true)
      setSeats(j.seats ?? null)
      setDevices(j.devices || [])
    } catch {
      setError('טעינה נכשלה')
      setDevices([])
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  async function startRelease(deviceId: string) {
    setBusy(true)
    setError('')
    const j = await api<{ ok?: boolean; error?: string }>(
      'device-release-request-code',
      { sessionToken: token },
    )
    setBusy(false)
    if (!j.ok) {
      setError(j.error || 'שליחת הקוד נכשלה.')
      return
    }
    setTarget(deviceId)
    setCode('')
  }

  async function confirm() {
    setBusy(true)
    setError('')
    const j = await api<{ ok?: boolean; error?: string }>('device-release-confirm', {
      sessionToken: token,
      code: code.trim(),
      deviceId: target,
    })
    setBusy(false)
    if (!j.ok) {
      setError(j.error || 'השחרור נכשל.')
      return
    }
    setTarget('')
    setCode('')
    setReleased(true)
    setTimeout(() => setReleased(false), 3000)
    await load()
  }

  // Nothing to manage (no desktop installs yet, or an exempt admin account).
  if (devices !== null && (exempt || devices.length === 0)) return null

  return (
    <section className="rounded-2xl border border-border/60 bg-white/[0.015] p-6 md:p-8">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-fg">
        <Monitor className="h-4 w-4 text-accent" />
        המחשבים שלי
      </h2>
      <p className="mb-5 text-sm text-fg-muted">
        {seats != null
          ? `${devices?.length ?? 0} מתוך ${seats} מחשבים בשימוש. מושב מתפנה רק כשמשחררים אותו.`
          : 'המחשבים שהתוכנה מותקנת ומחוברת בהם.'}
      </p>

      {error && (
        <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {released && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-accent">
          <Check className="h-3.5 w-3.5" /> המחשב שוחרר.
        </p>
      )}

      {devices === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : (
        <div className="space-y-2">
          {devices.map((d) => (
            <div
              key={d.deviceId}
              className={`rounded-xl border px-4 py-3 ${
                d.active ? 'border-border bg-bg-elevated' : 'border-border/50 bg-bg-elevated/50'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-fg">
                    {d.model || 'מחשב ללא שם'}
                    {d.blocked ? (
                      <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] text-destructive">
                        נחסם
                      </span>
                    ) : (
                      !d.active && (
                        <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] text-destructive">
                          מעל המכסה
                        </span>
                      )
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    נכנס לאחרונה {ago(d.lastSeenAt)}
                    {d.platform ? ` · ${d.platform}` : ''}
                    {d.appVersion ? ` · v${d.appVersion}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy || d.blocked}
                  title={d.blocked ? 'נחסם על ידי מנהל המערכת' : undefined}
                  onClick={() => void startRelease(d.deviceId)}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
                >
                  {busy && target === d.deviceId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    'שחרור'
                  )}
                </button>
              </div>

              {target === d.deviceId && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-2 text-xs text-fg-muted">
                    שלחנו קוד בן 6 ספרות למייל של החשבון (תקף ל-15 דקות).
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      inputMode="numeric"
                      placeholder="000000"
                      dir="ltr"
                      className="w-40 rounded-md border border-border bg-bg px-3 py-2 text-center tracking-[0.3em] text-fg outline-none focus:border-accent/50"
                    />
                    <button
                      type="button"
                      disabled={busy || code.length < 6}
                      onClick={() => void confirm()}
                      className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? 'משחרר…' : 'אישור'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTarget('')
                        setCode('')
                        setError('')
                      }}
                      className="rounded-md border border-border px-3 py-2 text-sm text-fg-muted transition-colors hover:text-fg"
                    >
                      ביטול
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
