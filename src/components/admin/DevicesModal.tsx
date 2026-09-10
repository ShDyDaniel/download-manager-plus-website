import { useCallback, useEffect, useState } from 'react'
import { Monitor, X, Loader2, Trash2, Minus, Plus, ShieldCheck, Ban, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Portal } from '@/components/ui/Portal'
import { adminApi } from '../../lib/adminApi'

/** One machine holding (or waiting for) a seat on an account. */
interface SeatDevice {
  deviceId: string
  claimedAt: string | null
  lastSeenAt: string | null
  platform: string | null
  appVersion: string | null
  model: string | null
  /** Barred from the account: holds no seat and can't sign in again. */
  blocked: boolean
  blockedAt: string | null
  /** False when a downgrade pushed this machine past the allowance. */
  active: boolean
}
interface DeviceInfo {
  tier: string
  seats: number
  baseSeats: number
  extraSeats: number
  exempt: boolean
  devices: SeatDevice[]
}

function fmtDateTime(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
/** "לפני 3 שעות" — the quickest way to see whether a machine is still in use. */
function ago(s?: string | null): string {
  if (!s) return ''
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) return ''
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'עכשיו'
  if (m < 60) return `לפני ${m} דק׳`
  const h = Math.floor(m / 60)
  if (h < 24) return `לפני ${h} שע׳`
  const d = Math.floor(h / 24)
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`
}

/**
 * The machines signed in to one account, and the seat maths behind them.
 *
 * Revoking here frees the seat immediately: the desktop keeps a live listener
 * on its own user document, so the machine that lost its seat is signed out
 * within seconds rather than at its next launch.
 */
export function DevicesModal({
  uid,
  email,
  onClose,
  onChanged,
}: {
  uid: string
  email?: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setInfo(await adminApi<DeviceInfo>('admin-device-list', { uid }))
    } catch (e) {
      setError((e as Error).message || 'טעינה נכשלה')
    }
  }, [uid])

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: string, deviceId: string, failMsg: string) {
    setBusy(deviceId)
    setError('')
    try {
      await adminApi(action, { uid, deviceId })
      await load()
      onChanged?.()
    } catch (e) {
      setError((e as Error).message || failMsg)
    } finally {
      setBusy('')
    }
  }
  const revoke = (id: string) => act('admin-device-revoke', id, 'השחרור נכשל')
  const block = (id: string) => act('admin-device-block', id, 'החסימה נכשלה')
  const unblock = (id: string) => act('admin-device-unblock', id, 'ביטול החסימה נכשל')

  async function setExtra(next: number) {
    if (next < 0 || next > 20) return
    setBusy('seats')
    setError('')
    try {
      await adminApi('admin-set-device-seats', { uid, extraSeats: next })
      await load()
      onChanged?.()
    } catch (e) {
      setError((e as Error).message || 'העדכון נכשל')
    } finally {
      setBusy('')
    }
  }

  const used = info?.devices.filter((d) => d.active).length ?? 0

  return (
    <Portal>
      <AnimatePresence>
        <motion.div
          key="devices-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
          onClick={onClose}
          dir="rtl"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl border border-border bg-card shadow-2xl"
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Monitor className="h-4 w-4 text-primary" />
                  מחשבים מחוברים
                </h3>
                <p className="mt-0.5 truncate text-[11px] text-fg-faint">{email || uid}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-popover hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {error && (
              <p className="mx-5 mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            {info === null ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> טוען…
              </div>
            ) : info.exempt ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-fg-muted">
                <ShieldCheck className="h-4 w-4 text-primary" />
                חשבון אדמין — פטור ממגבלת המחשבים.
              </div>
            ) : (
              <div className="px-5 py-4">
                {/* Seat maths — where the allowance comes from */}
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background px-3 py-2.5">
                  <div className="text-xs text-fg-muted">
                    <span className="font-medium text-fg">
                      {used} מתוך {info.seats}
                    </span>{' '}
                    מחשבים בשימוש
                    <span className="text-fg-faint">
                      {' '}
                      · {info.tier} = {info.baseSeats}
                      {info.extraSeats > 0 ? ` + ${info.extraSeats} החרגה` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-fg-muted">כיסאות נוספים</span>
                    <button
                      type="button"
                      disabled={busy === 'seats' || info.extraSeats <= 0}
                      onClick={() => void setExtra(info.extraSeats - 1)}
                      className="rounded-md border border-border p-1 text-fg-muted transition-colors hover:bg-popover disabled:opacity-40"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="min-w-[1.5rem] text-center text-sm font-medium tabular-nums text-fg">
                      {busy === 'seats' ? '…' : info.extraSeats}
                    </span>
                    <button
                      type="button"
                      disabled={busy === 'seats' || info.extraSeats >= 20}
                      onClick={() => void setExtra(info.extraSeats + 1)}
                      className="rounded-md border border-border p-1 text-fg-muted transition-colors hover:bg-popover disabled:opacity-40"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {info.devices.length === 0 ? (
                  <p className="py-8 text-center text-sm text-fg-muted">
                    אין מחשבים מחוברים.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {info.devices.map((d) => (
                      <div
                        key={d.deviceId}
                        className={`rounded-xl border px-3 py-2.5 ${
                          d.blocked
                            ? 'border-destructive/30 bg-destructive/[0.06]'
                            : d.active
                              ? 'border-border bg-background'
                              : 'border-border/60 bg-background/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-fg">
                                {d.model || 'מחשב ללא שם'}
                              </span>
                              {d.blocked ? (
                                <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] text-destructive">
                                  חסום
                                </span>
                              ) : (
                                !d.active && (
                                  <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] text-destructive">
                                    מעל המכסה
                                  </span>
                                )
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-fg-muted">
                              נכנס לאחרונה: {fmtDateTime(d.lastSeenAt)}
                              {ago(d.lastSeenAt) ? ` · ${ago(d.lastSeenAt)}` : ''}
                            </p>
                            <p className="text-[11px] text-fg-faint">
                              נתפס ב־{fmtDateTime(d.claimedAt)}
                              {d.platform ? ` · ${d.platform}` : ''}
                              {d.appVersion ? ` · v${d.appVersion}` : ''}
                            </p>
                            <p className="mt-0.5 truncate font-mono text-[10px] text-fg-faint" dir="ltr">
                              {d.deviceId}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {busy === d.deviceId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-muted" />
                            ) : d.blocked ? (
                              <button
                                type="button"
                                onClick={() => void unblock(d.deviceId)}
                                title="בטל חסימה — המחשב יוכל להתחבר שוב"
                                className="rounded-lg border border-border p-1.5 text-fg-muted transition-colors hover:bg-popover hover:text-fg"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void block(d.deviceId)}
                                title="חסום — מפנה את המושב ומונע מהמחשב הזה להתחבר שוב"
                                className="rounded-lg border border-border p-1.5 text-fg-muted transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy === d.deviceId}
                              onClick={() => void revoke(d.deviceId)}
                              title="הסר מהחשבון — מפנה את המושב, והמחשב יוכל להתחבר שוב"
                              className="rounded-lg border border-border p-1.5 text-fg-muted transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <p className="mt-4 text-[10px] leading-relaxed text-fg-faint">
                  שתי הפעולות מנתקות את המחשב תוך שניות, גם אם התוכנה פתוחה
                  אצלו, ומפנות את המושב. ההבדל: <strong className="text-fg">הסרה</strong>{' '}
                  (פח) מאפשרת למחשב להתחבר שוב ולתפוס מושב פנוי, ואילו{' '}
                  <strong className="text-fg">חסימה</strong> מונעת ממנו להתחבר
                  לחשבון הזה בכלל. מושב מתפנה רק ביוזמה — אין פקיעה אוטומטית.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </Portal>
  )
}
