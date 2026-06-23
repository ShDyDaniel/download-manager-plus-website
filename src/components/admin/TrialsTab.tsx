import { useEffect, useState } from 'react'
import { RefreshCw, Loader2, Ban, AlertTriangle, RotateCcw } from 'lucide-react'
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
              מהרשימה מאפסת את הזכאות שלהם — הם יוכלו לקבל ניסיון חינם מחדש.
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
