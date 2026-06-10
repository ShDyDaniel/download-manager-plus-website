import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Send,
  Upload,
  Loader2,
  Copy,
  Check,
  Trash2,
  Lock,
  Clock,
  Plus,
  X,
  FileVideo,
  Link2,
  HardDrive,
} from 'lucide-react'
import { Portal } from './ui/Portal'
import {
  createDelivery,
  deleteDelivery,
  fetchStorageState,
  formatBytes,
  listDeliveries,
  type DeliveryRow,
} from '../lib/revisionsApi'
import { uploadFileToR2 } from '../lib/r2Upload'
import { cn } from '../lib/cn'

/**
 * DeliveriesWorkspace — the web editor side of "מסירה ללקוח".
 * Mounted by /deliveries once ProWorkspaceShell confirms the user
 * is signed in + Pro. Mirrors the desktop DeliveriesPage one-to-one
 * (add button → composer modal → list → storage bar) but uploads
 * from the browser (uploadFileToR2 with initAction
 * 'delivery-upload-init') and authenticates with the website
 * session JWT instead of a Firebase ID token.
 */

const SITE = 'https://www.dmplus.net'

const EXPIRY_OPTIONS: Array<{ days: 3 | 7 | 14; label: string }> = [
  { days: 3, label: '3 ימים' },
  { days: 7, label: 'שבוע' },
  { days: 14, label: 'שבועיים' },
]

function expiryLabel(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'פג'
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days >= 1) return `עוד ${days} ${days === 1 ? 'יום' : 'ימים'}`
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)))
  return `עוד ${hours} שעות`
}

export function DeliveriesWorkspace() {
  const [storage, setStorage] = useState<{
    usedBytes: number
    limitBytes: number
  } | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [composerOpen, setComposerOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [s, d] = await Promise.all([
      fetchStorageState().catch(() => null),
      listDeliveries().catch(() => []),
    ])
    setStorage(s)
    setDeliveries(d)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function copyLink(link: string, id: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800)
    } catch {
      /* ignore */
    }
  }

  async function confirmDelete(id: string) {
    setPendingDelete(null)
    try {
      await deleteDelivery(id)
      await refresh()
    } catch {
      /* ignore */
    }
  }

  return (
    <div dir="rtl" className="space-y-6">
      {/* Header row — feature chip + the single "add" CTA. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
            — מסירה ללקוח
          </div>
          <h1 className="font-display text-2xl font-medium text-fg md:text-3xl">
            שליחת הסרטון הסופי
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-fg-muted">
            העלו את הסרטון הסופי, בחרו לכמה זמן הקישור יהיה פעיל
            (3 ימים / שבוע / שבועיים), וקבלו קישור אחד לשליחה ללקוח.
            הוא צופה ומוריד, והקובץ נמחק אוטומטית בתום התוקף.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover"
        >
          <Plus className="h-4 w-4" />
          מסירה חדשה
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : deliveries.length === 0 ? (
        <div className="mx-auto mt-6 max-w-md rounded-2xl border border-dashed border-border p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Send className="h-6 w-6" />
          </div>
          <p className="text-sm leading-relaxed text-fg-muted">
            עדיין אין מסירות. לחצו "מסירה חדשה" כדי להעלות סרטון
            סופי ולקבל קישור לשליחה ללקוח.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {deliveries.map((d) => {
            const link = `${SITE}/deliver/${d.shareToken}`
            const expired = d.expiresAt <= Date.now()
            return (
              <div
                key={d.id}
                className="rounded-xl border border-border bg-bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-fg">
                        {d.title || 'מסירה ללקוח'}
                      </p>
                      {d.hasPassword && (
                        <Lock className="h-3 w-3 shrink-0 text-fg-muted" />
                      )}
                    </div>
                    <p className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-muted">
                      <span dir="ltr">
                        {d.videoCount} · {formatBytes(d.sizeBytes)}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1',
                          expired && 'text-destructive',
                        )}
                      >
                        <Clock className="h-3 w-3" />
                        {expired ? 'פג' : expiryLabel(d.expiresAt)}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!expired && (
                      <button
                        type="button"
                        onClick={() => copyLink(link, d.id)}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-primary/50"
                      >
                        {copied === d.id ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copied === d.id ? 'הועתק' : 'העתק קישור'}
                      </button>
                    )}
                    {pendingDelete === d.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => confirmDelete(d.id)}
                          className="rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground"
                        >
                          מחק
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(null)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-fg-muted"
                        >
                          ביטול
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(d.id)}
                        className="rounded-md p-1.5 text-fg-muted transition-colors hover:text-destructive"
                        aria-label="מחק מסירה"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Storage bar at the bottom — same principle as the revisions
          tab's R2StorageBar. Quota is shared with revisions. */}
      <StorageBar storage={storage} />

      <DeliveryComposerModal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={refresh}
      />
    </div>
  )
}

function StorageBar({
  storage,
}: {
  storage: { usedBytes: number; limitBytes: number } | null
}) {
  if (!storage) return null
  const pct = storage.limitBytes
    ? Math.min(100, Math.max(0, (storage.usedBytes / storage.limitBytes) * 100))
    : 0
  const barColor =
    pct >= 95 ? 'bg-destructive' : pct >= 80 ? 'bg-amber-400' : 'bg-primary'
  return (
    <div className="rounded-2xl border border-border/60 bg-white/[0.015] p-4 text-xs text-fg-muted">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <HardDrive className="h-3.5 w-3.5" aria-hidden />
          שטח אחסון בחשבון (משותף עם סבבי התיקונים)
        </span>
        <span dir="ltr" className="font-mono text-fg">
          {formatBytes(storage.usedBytes)} / {formatBytes(storage.limitBytes)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className={`h-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct >= 95 && (
        <div className="mt-2 text-[11px] text-destructive">
          האחסון כמעט מלא — מחקו מסירות/סבבים ישנים כדי לפנות מקום.
        </div>
      )}
    </div>
  )
}

/* ── Composer modal — opened by the "מסירה חדשה" button. Holds the
 *    whole upload + configure flow (browser file input + R2 upload). */
function DeliveryComposerModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const [staged, setStaged] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const [expiryDays, setExpiryDays] = useState<3 | 7 | 14>(7)
  const [usePassword, setUsePassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{
    idx: number
    total: number
    frac: number
  } | null>(null)
  const [error, setError] = useState('')
  const [createdLink, setCreatedLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStaged([])
    setTitle('')
    setExpiryDays(7)
    setUsePassword(false)
    setPassword('')
    setProgress(null)
    setError('')
    setCreatedLink(null)
    setCopied(false)
  }

  function close() {
    if (busy) return
    reset()
    onClose()
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files || [])
    if (picked.length === 0) return
    setStaged((prev) => {
      const next = [...prev]
      for (const f of picked) {
        // Dedup by name+size so re-picking the same file is a no-op.
        if (!next.some((x) => x.name === f.name && x.size === f.size)) {
          next.push(f)
        }
      }
      return next
    })
    setError('')
    // Reset the input so picking the same file again still fires change.
    e.target.value = ''
  }

  async function handleCreate() {
    if (busy) return
    if (staged.length === 0) return setError('הוסיפו לפחות סרטון אחד.')
    if (usePassword && password.trim().length < 4) {
      return setError('סיסמה קצרה מדי (4 תווים מינימום).')
    }
    setBusy(true)
    setError('')
    try {
      const uploaded: Array<{
        r2Key: string
        name: string
        sizeBytes: number
        mime: string
      }> = []
      for (let i = 0; i < staged.length; i++) {
        const file = staged[i]
        setProgress({ idx: i, total: staged.length, frac: 0 })
        const { key, sizeBytes } = await uploadFileToR2(file, {
          initAction: 'delivery-upload-init',
          onProgress: (frac) =>
            setProgress({ idx: i, total: staged.length, frac }),
        })
        uploaded.push({
          r2Key: key,
          name: file.name,
          sizeBytes,
          mime: file.type || 'application/octet-stream',
        })
      }
      const { shareToken } = await createDelivery({
        title: title.trim(),
        expiryDays,
        password: usePassword ? password : undefined,
        videos: uploaded,
      })
      const link = `${SITE}/deliver/${shareToken}`
      setCreatedLink(link)
      try {
        await navigator.clipboard.writeText(link)
        setCopied(true)
      } catch {
        /* ignore */
      }
      await onCreated()
    } catch (e) {
      setError((e as Error)?.message || 'ההעלאה נכשלה. נסו שוב.')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const totalStaged = staged.reduce((s, v) => s + v.size, 0)

  return (
    <AnimatePresence>
      {open && (
        <Portal>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            dir="rtl"
            className="fixed inset-0 z-[200] flex items-center justify-center bg-bg/80 p-4 backdrop-blur-md"
            onClick={close}
          >
            <motion.div
              initial={{ scale: 0.96, y: 14, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.96, y: 14, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 360, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90vh] w-[min(540px,94vw)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-card shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-border p-4">
                <h2 className="text-base font-medium text-fg">מסירה חדשה</h2>
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-elevated hover:text-fg disabled:opacity-40"
                  aria-label="סגור"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                {createdLink ? (
                  /* Success — show the link to copy & send. */
                  <div className="space-y-4 py-2 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-success/15 text-success">
                      <Check className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-fg">
                        המסירה מוכנה!
                      </h3>
                      <p className="mt-1 text-xs text-fg-muted">
                        שלחו את הקישור ללקוח. הוא יוכל לצפות ולהוריד עד
                        שהתוקף יפוג.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2">
                      <Link2 className="h-4 w-4 shrink-0 text-primary" />
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-fg"
                        dir="ltr"
                      >
                        {createdLink}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(createdLink)
                            setCopied(true)
                          } catch {
                            /* ignore */
                          }
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-bg"
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copied ? 'הועתק' : 'העתק'}
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={reset}
                        className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-fg transition-colors hover:border-primary/50"
                      >
                        מסירה נוספת
                      </button>
                      <button
                        type="button"
                        onClick={close}
                        className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-bg"
                      >
                        סיום
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Hidden native file input — driven by the add button. */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*"
                      multiple
                      className="hidden"
                      onChange={onPickFiles}
                    />

                    {/* Staged videos */}
                    <div className="space-y-2">
                      {staged.map((v) => (
                        <div
                          key={`${v.name}-${v.size}`}
                          className="flex items-center gap-3 rounded-lg border border-border bg-bg/50 px-3 py-2"
                        >
                          <FileVideo className="h-4 w-4 shrink-0 text-primary" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-fg" dir="ltr">
                              {v.name}
                            </p>
                            <p className="text-[11px] text-fg-muted" dir="ltr">
                              {formatBytes(v.size)}
                            </p>
                          </div>
                          {!busy && (
                            <button
                              type="button"
                              onClick={() =>
                                setStaged((prev) =>
                                  prev.filter(
                                    (x) =>
                                      !(x.name === v.name && x.size === v.size),
                                  ),
                                )
                              }
                              className="rounded p-1 text-fg-muted hover:text-destructive"
                              aria-label="הסר"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-4 text-sm text-fg-muted transition-colors hover:border-primary/50 hover:text-fg disabled:opacity-40"
                      >
                        <Plus className="h-4 w-4" />
                        {staged.length === 0 ? 'הוסף סרטון' : 'הוסף עוד סרטון'}
                      </button>
                      {staged.length > 0 && (
                        <p className="text-[11px] text-fg-muted">
                          {staged.length} סרטונים · {formatBytes(totalStaged)}{' '}
                          סה"כ
                        </p>
                      )}
                    </div>

                    {/* Title */}
                    <div>
                      <label className="mb-1 block text-xs text-fg-muted">
                        שם המסירה (אופציונלי — יוצג ללקוח)
                      </label>
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="למשל: הקאט הסופי — קמפיין קיץ"
                        disabled={busy}
                        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
                      />
                    </div>

                    {/* Expiry */}
                    <div>
                      <label className="mb-1.5 block text-xs text-fg-muted">
                        הקישור יהיה פעיל למשך
                      </label>
                      <div className="flex gap-2">
                        {EXPIRY_OPTIONS.map((o) => (
                          <button
                            key={o.days}
                            type="button"
                            onClick={() => setExpiryDays(o.days)}
                            disabled={busy}
                            className={cn(
                              'flex-1 rounded-lg border py-2 text-sm font-medium transition-colors disabled:opacity-60',
                              expiryDays === o.days
                                ? 'border-primary bg-primary/15 text-fg'
                                : 'border-border text-fg-muted hover:border-primary/40',
                            )}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Password */}
                    <div>
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
                        <input
                          type="checkbox"
                          checked={usePassword}
                          onChange={(e) => setUsePassword(e.target.checked)}
                          disabled={busy}
                          className="h-4 w-4 accent-current"
                        />
                        <Lock className="h-3.5 w-3.5 text-fg-muted" />
                        הגן בסיסמה
                      </label>
                      {usePassword && (
                        <input
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="סיסמה לשליחה ללקוח בנפרד"
                          disabled={busy}
                          className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
                        />
                      )}
                    </div>

                    {error && (
                      <p className="text-xs font-medium text-destructive">
                        {error}
                      </p>
                    )}

                    {busy && progress && (
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-[11px] text-fg-muted">
                          <span>
                            מעלה סרטון {progress.idx + 1} מתוך {progress.total}
                          </span>
                          <span dir="ltr">
                            {Math.round(progress.frac * 100)}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{
                              width: `${Math.round(progress.frac * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {!createdLink && (
                <div className="border-t border-border p-4">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={busy || staged.length === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover disabled:opacity-40"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    צור מסירה וקבל קישור
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        </Portal>
      )}
    </AnimatePresence>
  )
}
