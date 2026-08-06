import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  Ban,
  AlertTriangle,
  RotateCcw,
  MonitorSmartphone,
  Copy,
  Check,
  Link2,
  CheckCircle2,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'

interface UserDoc {
  uid: string
  email: string
  name?: string
  subscription?: string
  trialStatus?: string
  trialExpiresAt?: string
}

function isTrialActive(u: UserDoc): boolean {
  if (u.trialStatus !== 'approved' || !u.trialExpiresAt) return false
  const e = new Date(u.trialExpiresAt).getTime()
  return Number.isFinite(e) && e > Date.now()
}
/** A trial was issued to this user at some point (active or not). */
function hasTrialGranted(u: UserDoc): boolean {
  return !!u.trialExpiresAt
}
function fmtDate(s?: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('he-IL')
}
function daysLeft(s?: string): number | null {
  if (!s) return null
  const ms = new Date(s).getTime() - Date.now()
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86400000)) : null
}

interface DeviceCheck {
  id: string
  code: string
  status: string
  url?: string
  expiresAt?: string
  deviceId?: string
  reportedAt?: string
  reportedByEmail?: string | null
  matched?: boolean
  matchedUid?: string | null
  matchedEmail?: string | null
  matchedName?: string | null
  matchedTrialAt?: string | null
}

/**
 * Support tool: generate a one-time link the user opens to report their
 * machine's device signature, then see whether an old account already took
 * a trial on that machine — and reset it so they can trial again.
 */
function DeviceCheckCard({
  onAuthExpired,
  onChanged,
}: {
  onAuthExpired: () => void
  onChanged: () => void
}) {
  const [check, setCheck] = useState<DeviceCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  function handleErr(e: unknown) {
    const x = e as Error & { code?: string }
    if (x.code === 'auth') return onAuthExpired()
    setErr(x.message || 'שגיאה')
  }

  async function create() {
    if (busy) return
    setBusy(true)
    setErr('')
    setResetDone(false)
    try {
      const r = await adminApi<{
        code: string
        url: string
        expiresAt: string
      }>('admin-device-check-create')
      setCheck({
        id: r.code,
        code: r.code,
        status: 'pending',
        url: r.url,
        expiresAt: r.expiresAt,
      })
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  // Poll for the user's report while the check is still pending.
  useEffect(() => {
    if (!check || check.status === 'reported') return
    let alive = true
    const id = setInterval(async () => {
      try {
        const r = await adminApi<{ check: DeviceCheck }>(
          'admin-device-check-get',
          { code: check.code },
        )
        // Merge — the server doc has no `url` (only create returns it),
        // so a plain overwrite would blank out the displayed link.
        if (alive && r.check)
          setCheck((prev) => (prev ? { ...prev, ...r.check } : r.check))
      } catch {
        /* transient — keep polling */
      }
    }, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check?.code, check?.status])

  async function resetMatched() {
    if (busy || !check?.matchedUid) return
    if (
      !window.confirm(
        'לאפס את הזכאות לניסיון של החשבון שנמצא?\nהפעולה תמחק את טביעת המחשב. המחשב יוכל לקבל שוב 7 ימי ניסיון חינם.',
      )
    )
      return
    setBusy(true)
    setErr('')
    try {
      await adminApi('admin-reset-trial', { uid: check.matchedUid })
      setResetDone(true)
      onChanged()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(false)
    }
  }

  async function copyLink() {
    if (!check?.url) return
    try {
      await navigator.clipboard.writeText(check.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  const reported = check?.status === 'reported'

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <MonitorSmartphone className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-fg">בדיקת מחשב לתמיכה</h3>
          <p className="mt-0.5 text-xs text-fg-muted">
            יצרו קישור, שלחו אותו למשתמש, והוא יפתח את התוכנה וישלח את חתימת
            המחשב. כך תדעו אם חשבון אחר כבר ניצל ניסיון על אותו מחשב.
          </p>
        </div>
        {!check && (
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Link2 className="h-3.5 w-3.5" />
            )}
            צור קישור בדיקה
          </button>
        )}
      </div>

      {err && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {err}
        </div>
      )}

      {check && (
        <div className="mt-4 space-y-3">
          {/* Link + code */}
          <div className="flex items-center gap-2">
            <code
              dir="ltr"
              className="flex-1 select-all truncate rounded-lg border border-border bg-bg px-3 py-2 text-xs text-fg"
            >
              {check.url}
            </code>
            <button
              type="button"
              onClick={copyLink}
              aria-label="העתק קישור"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-fg-muted transition-colors hover:text-fg"
            >
              {copied ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
          <div className="text-[11px] text-fg-faint">
            קוד גיבוי להדבקה ידנית בתוכנה:{' '}
            <span dir="ltr" className="font-mono text-fg">
              {check.code}
            </span>
          </div>

          {/* Status / result */}
          {!reported ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2.5 text-xs text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              ממתין לתגובה מהמשתמש… (השאירו את החלון פתוח)
            </div>
          ) : check.matched ? (
            <div className="rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-3">
              <div className="text-xs font-medium text-fg">
                נמצא חשבון שכבר ניצל ניסיון על המחשב הזה:
              </div>
              <div className="mt-1 text-sm font-semibold text-fg">
                {check.matchedName || check.matchedEmail}
              </div>
              {check.matchedEmail && (
                <div className="text-xs text-fg-muted" dir="ltr">
                  {check.matchedEmail}
                </div>
              )}
              {check.matchedTrialAt && (
                <div className="mt-0.5 text-[11px] text-fg-faint">
                  ניסיון נלקח: <bdi>{fmtDate(check.matchedTrialAt)}</bdi>
                </div>
              )}
              {check.reportedByEmail &&
                check.reportedByEmail !== check.matchedEmail && (
                  <div className="mt-1 text-[11px] text-fg-faint">
                    החשבון שמחובר כעת במחשב:{' '}
                    <span dir="ltr">{check.reportedByEmail}</span>
                  </div>
                )}
              {resetDone ? (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> הזכאות אופסה. המחשב
                  יכול לקבל ניסיון מחדש.
                </div>
              ) : (
                <button
                  type="button"
                  onClick={resetMatched}
                  disabled={busy}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-accent/40 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  אפס זכאות למחשב הזה
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-bg px-3 py-3 text-xs text-fg-muted">
              לא נמצא חשבון קודם שניצל ניסיון על המחשב הזה.
              {check.reportedByEmail && (
                <div className="mt-1 text-[11px] text-fg-faint">
                  החשבון שמחובר כעת:{' '}
                  <span dir="ltr">{check.reportedByEmail}</span>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setCheck(null)
              setErr('')
              setResetDone(false)
            }}
            className="text-[11px] text-fg-muted underline-offset-2 hover:underline"
          >
            צור קישור חדש
          </button>
        </div>
      )}
    </div>
  )
}

export default function TrialsTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [users, setUsers] = useState<UserDoc[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  async function load() {
    setError('')
    try {
      const r = await adminApi<{ users: UserDoc[] }>('admin-list-users')
      setUsers(r.users)
    } catch (e) {
      handleErr(e)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function revoke(uid: string) {
    if (busy) return
    setBusy(uid)
    setError('')
    try {
      await adminApi('admin-revoke-trial', { uid })
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(null)
    }
  }

  async function reset(uid: string) {
    if (busy) return
    if (
      !window.confirm(
        'לאפס את הזכאות לניסיון של המשתמש?\nהפעולה תמחק את טביעות המייל והמחשב שלו ותאפשר לו לקבל שוב 7 ימי ניסיון חינם.',
      )
    )
      return
    setBusy(uid)
    setError('')
    try {
      await adminApi('admin-reset-trial', { uid })
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusy(null)
    }
  }

  const all = users ?? []
  const active = all.filter(isTrialActive)
  // "Used up" their trial: a trial was granted, it isn't active anymore, and
  // they aren't Pro (a Pro user has no reason to reset a trial).
  const used = all.filter(
    (u) => hasTrialGranted(u) && !isTrialActive(u) && u.subscription !== 'pro',
  )

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">
            ניסיון 7 יום
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            מי שנמצא כרגע בתקופת ניסיון, ומי שכבר ניצל ניסיון ולא יכול לקבל אותו
            שוב.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
        >
          <RefreshCw className="h-3.5 w-3.5" /> רענן
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <DeviceCheckCard onAuthExpired={onAuthExpired} onChanged={load} />

      {users === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : (
        <>
          {/* ── Active trials ── */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-fg">
              ניסיונות פעילים ({active.length})
            </div>
            {active.length === 0 ? (
              <div className="rounded-2xl border border-border py-8 text-center text-sm text-fg-muted">
                אף משתמש לא בתקופת ניסיון כרגע.
              </div>
            ) : (
              active.map((u) => {
                const left = daysLeft(u.trialExpiresAt)
                return (
                  <div
                    key={u.uid}
                    className="flex flex-col gap-2 rounded-2xl border border-accent/20 bg-accent/[0.04] p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-fg">
                        {u.name || u.email}
                      </div>
                      <div className="truncate text-xs text-fg-muted" dir="ltr">
                        {u.email}
                      </div>
                      {/* Each part is its own flex item (and each number is
                          wrapped in <bdi>) so the LTR date and the LTR
                          day-count don't merge into one bidi run — that bug
                          jammed them together as "5.7.202614". */}
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-faint">
                        <span>
                          עד <bdi>{fmtDate(u.trialExpiresAt)}</bdi>
                        </span>
                        {left != null && (
                          <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-accent">
                            נותרו <bdi>{left}</bdi> ימים
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy === u.uid}
                      onClick={() => revoke(u.uid)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {busy === u.uid ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Ban className="h-3.5 w-3.5" />
                      )}
                      בטל ניסיון
                    </button>
                  </div>
                )
              })
            )}
          </div>

          {/* ── Already used (can't get another) ── */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-fg">
              כבר ניצלו ניסיון ({used.length})
            </div>
            <p className="text-xs text-fg-muted">
              משתמשים אלו כבר קיבלו 7 ימי ניסיון ולא יכולים לקבל שוב. מחיקה
              מהרשימה מאפסת את הזכאות שלהם. הם יוכלו לקבל ניסיון חינם מחדש.
            </p>
            {used.length === 0 ? (
              <div className="rounded-2xl border border-border py-8 text-center text-sm text-fg-muted">
                אין משתמשים שניצלו ניסיון.
              </div>
            ) : (
              used.map((u) => (
                <div
                  key={u.uid}
                  className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-fg">
                      {u.name || u.email}
                    </div>
                    <div className="truncate text-xs text-fg-muted" dir="ltr">
                      {u.email}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-faint">
                      <span>
                        ניסיון הסתיים <bdi>{fmtDate(u.trialExpiresAt)}</bdi>
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy === u.uid}
                    onClick={() => reset(u.uid)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/30 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                  >
                    {busy === u.uid ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    מחק מהרשימה
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
