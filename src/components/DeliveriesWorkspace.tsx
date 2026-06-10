import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Send,
  Upload,
  Loader2,
  Copy,
  Check,
  CheckCircle2,
  Trash2,
  Lock,
  Clock,
  Plus,
  X,
  FileVideo,
  Link2,
  HardDrive,
  Mail,
  AlertTriangle,
} from 'lucide-react'
import { Portal } from './ui/Portal'
import {
  createDelivery,
  deleteDelivery,
  fetchStorageBackend,
  fetchStorageState,
  formatBytes,
  importDriveLinkToR2,
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
  const totalHours = Math.floor(ms / (60 * 60 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  const dPart = days > 0 ? `${days} ${days === 1 ? 'יום' : 'ימים'}` : ''
  const hPart = hours > 0 ? `${hours} ${hours === 1 ? 'שעה' : 'שעות'}` : ''
  if (dPart && hPart) return `עוד ${dPart} ו-${hPart}`
  if (dPart) return `עוד ${dPart}`
  if (hPart) return `עוד ${hPart}`
  return 'עוד פחות משעה'
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
  // Storage backend — deliveries are R2-only, so Drive accounts get a
  // "contact support" panel instead of the workspace. null = not known
  // yet (don't flash the workspace before we've confirmed).
  const [backend, setBackend] = useState<'r2' | 'drive' | null>(null)

  const refresh = useCallback(async () => {
    const [b, s, d] = await Promise.all([
      fetchStorageBackend().catch(() => 'r2' as const),
      fetchStorageState().catch(() => null),
      listDeliveries().catch(() => []),
    ])
    setBackend(b)
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

  if (backend === 'drive') {
    return <DriveNoAccessPanel />
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
          שליחת סרטון
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
            עדיין אין מסירות. לחצו "שליחת סרטון" כדי להעלות סרטון
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

/** Shown when the account's storage backend is Google Drive. Deliveries
 *  are built on our own R2 storage, so Drive accounts can't use the tab —
 *  point them to support. */
function DriveNoAccessPanel() {
  return (
    <div
      dir="rtl"
      className="mx-auto flex max-w-md flex-col items-center py-20 text-center"
    >
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <HardDrive className="h-7 w-7" />
      </div>
      <h1 className="font-display text-2xl font-medium text-fg">
        הטאב אינו זמין בחשבון הזה
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">
        מערכת המסירה ללקוח עובדת מול האחסון שלנו. החשבון שלך מוגדר
        לאחסון ב‑Google Drive, ולכן אין גישה לטאב הזה. כדי לפתוח אותו —
        אפשר לפנות לתמיכה.
      </p>
      <a
        href="mailto:dyshalts@gmail.com?subject=פתיחת%20טאב%20מסירה%20ללקוח"
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover"
      >
        <Mail className="h-4 w-4" />
        פנייה לתמיכה
      </a>
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
          שטח אחסון בחשבון
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

/* ══════════════════════════════════════════════════════════════
 *  Composer modal — opened by the "מסירה חדשה" button.
 *
 *  Same design language as the revisions new-project modal: a
 *  segmented "upload / import-from-link" source toggle, a big
 *  drag-and-drop zone, copper Switch toggles, and a clean staged
 *  list. Supports MULTIPLE videos per delivery — each can be a
 *  local upload OR a public Google-Drive link (imported straight
 *  into {uid}/finals/ by Cloudflare, no re-upload).
 * ══════════════════════════════════════════════════════════════ */

/** One queued video — either a local File or a Drive link to import. */
type StagedItem =
  | {
      kind: 'file'
      id: string
      file: File
      /** Browser-playability check (async after staging). */
      probing?: boolean
      unsupported?: boolean
    }
  | { kind: 'link'; id: string; url: string }

/** Resolve true if this browser can decode the file enough to show a
 *  picture. Loads only metadata via an object URL; times out to "yes"
 *  so a slow probe never blocks the user. */
function canBrowserPlay(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
      v.removeAttribute('src')
      resolve(ok)
    }
    const timer = setTimeout(() => done(true), 8000)
    v.onloadedmetadata = () => {
      if (v.videoWidth > 0) done(true)
    }
    v.onloadeddata = () => done(true)
    v.onerror = () => done(false)
    v.src = url
  })
}

function DeliveryComposerModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const [staged, setStaged] = useState<StagedItem[]>([])
  const [mode, setMode] = useState<'upload' | 'link'>('upload')
  const [linkUrl, setLinkUrl] = useState('')
  const [title, setTitle] = useState('')
  const [expiryDays, setExpiryDays] = useState<3 | 7 | 14>(7)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{
    idx: number
    total: number
    frac: number
    importing?: boolean
  } | null>(null)
  const [error, setError] = useState('')
  // After a successful create the modal body swaps to a success view
  // with the shareable link (mirrors the revisions modal).
  const [done, setDone] = useState<{ shareUrl: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const idRef = useRef(0)
  const nextId = () => `s${(idRef.current += 1)}`

  function reset() {
    setStaged([])
    setMode('upload')
    setLinkUrl('')
    setTitle('')
    setExpiryDays(7)
    setPassword('')
    setProgress(null)
    setError('')
    setDone(null)
    setCopied(false)
  }

  async function copyShareLink() {
    if (!done) return
    try {
      await navigator.clipboard.writeText(done.shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore */
    }
  }

  function close() {
    if (busy) return
    reset()
    onClose()
  }

  function addFiles(files: File[]) {
    if (files.length === 0) return
    const added: Array<{ id: string; file: File }> = []
    setStaged((prev) => {
      const next = [...prev]
      for (const f of files) {
        // Dedup by name+size so re-picking the same file is a no-op.
        if (
          !next.some(
            (x) => x.kind === 'file' && x.file.name === f.name && x.file.size === f.size,
          )
        ) {
          const id = nextId()
          next.push({ kind: 'file', id, file: f, probing: true })
          added.push({ id, file: f })
        }
      }
      return next
    })
    setError('')
    // Check (in this browser) whether each file is actually playable.
    for (const a of added) void probeStaged(a.id, a.file)
  }

  /** Best-effort: try to load the file's metadata in a hidden <video>.
   *  If the browser can't decode it (ProRes/HEVC/…), it fires `error`
   *  and we flag the file as unsupported for browser preview. */
  async function probeStaged(id: string, file: File) {
    const playable = await canBrowserPlay(file)
    setStaged((prev) =>
      prev.map((x) =>
        x.id === id && x.kind === 'file'
          ? { ...x, probing: false, unsupported: !playable }
          : x,
      ),
    )
  }

  function addLink() {
    const url = linkUrl.trim()
    if (!url) return
    setStaged((prev) =>
      prev.some((x) => x.kind === 'link' && x.url === url)
        ? prev
        : [...prev, { kind: 'link', id: nextId(), url }],
    )
    setLinkUrl('')
    setError('')
  }

  function removeItem(id: string) {
    setStaged((prev) => prev.filter((x) => x.id !== id))
  }

  async function handleCreate() {
    if (busy) return
    if (staged.length === 0) return setError('הוסיפו לפחות סרטון אחד.')
    const pw = password.trim()
    if (pw && pw.length < 4) {
      return setError('סיסמה קצרה מדי (4 תווים מינימום).')
    }
    setBusy(true)
    setError('')
    setProgress({ idx: 0, total: staged.length, frac: 0 })
    try {
      const uploaded: Array<{
        r2Key: string
        name: string
        sizeBytes: number
        mime: string
      }> = []
      for (let i = 0; i < staged.length; i++) {
        const item = staged[i]
        if (item.kind === 'file') {
          setProgress({ idx: i, total: staged.length, frac: 0 })
          const { key, sizeBytes } = await uploadFileToR2(item.file, {
            initAction: 'delivery-upload-init',
            onProgress: (frac) =>
              setProgress({ idx: i, total: staged.length, frac }),
          })
          uploaded.push({
            r2Key: key,
            name: item.file.name,
            sizeBytes,
            mime: item.file.type || 'application/octet-stream',
          })
        } else {
          // Drive link → Cloudflare streams it straight into finals/.
          setProgress({ idx: i, total: staged.length, frac: 0, importing: true })
          const imp = await importDriveLinkToR2(item.url, 'finals')
          uploaded.push({
            r2Key: imp.r2Key,
            name: imp.videoFileName,
            sizeBytes: imp.videoSizeBytes,
            mime: imp.videoMime,
          })
        }
      }
      const created = await createDelivery({
        title: title.trim(),
        expiryDays,
        password: pw || undefined,
        videos: uploaded,
      })
      await onCreated()
      // Success → swap the modal body to the share-link view (the user
      // closes it themselves with "סיום").
      setDone({ shareUrl: `${SITE}/deliver/${created.shareToken}` })
    } catch (e) {
      setError((e as Error)?.message || 'ההעלאה נכשלה. נסו שוב.')
      // Stay in the (still-open) modal so the error + inputs show.
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const totalStagedBytes = staged.reduce(
    (s, it) => s + (it.kind === 'file' ? it.file.size : 0),
    0,
  )

  // Closed → render NOTHING. The Portal is rendered DIRECTLY (no
  // AnimatePresence wrapping it) — wrapping a Portal in AnimatePresence
  // left the fixed-inset overlay stuck at opacity 0, an invisible
  // click-blocker that froze the page. (The inner source-mode
  // AnimatePresence below is fine: returning null here force-unmounts
  // it on close, so it can never linger.)
  if (!open) return null

  return (
    <Portal>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        dir="rtl"
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
        onClick={close}
      >
        <motion.div
          initial={{ scale: 0.96, y: 14, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 360, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-border p-4">
                <h2 className="text-base font-medium text-fg">שליחת סרטון</h2>
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

              <div className="flex-1 space-y-5 overflow-y-auto p-5">
                {done ? (
                  <DeliverySuccessView
                    shareUrl={done.shareUrl}
                    copied={copied}
                    onCopy={copyShareLink}
                    onClose={close}
                  />
                ) : busy && progress ? (
                  <DeliveryProgressView
                    idx={progress.idx}
                    total={progress.total}
                    frac={progress.frac}
                    importing={progress.importing}
                  />
                ) : (
                  <>
                    {/* Source toggle — upload from computer OR import a
                        public Drive link (same control as revisions). */}
                    <SourceTabs
                      mode={mode}
                      onChange={(m) => {
                        setMode(m)
                        setError('')
                      }}
                      disabled={busy}
                    />

                    {/* Source content slides between upload / Drive-link.
                        Safe: the whole modal unmounts on close (return
                        null above), so this inner AnimatePresence is
                        force-unmounted and can never linger. */}
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={mode}
                        initial={{ opacity: 0, x: mode === 'upload' ? -10 : 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: mode === 'upload' ? 10 : -10 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {mode === 'upload' ? (
                          <MultiDropZone onAdd={addFiles} disabled={busy} />
                        ) : (
                          <div className="rounded-xl border-2 border-border bg-bg-card px-5 py-5">
                            <label className="mb-2 block text-xs font-medium text-fg">
                              קישור Google Drive ציבורי
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="url"
                                dir="ltr"
                                inputMode="url"
                                placeholder="https://drive.google.com/file/d/..."
                                disabled={busy}
                                value={linkUrl}
                                onChange={(e) => setLinkUrl(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    addLink()
                                  }
                                }}
                                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-left text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
                              />
                              <button
                                type="button"
                                onClick={addLink}
                                disabled={busy || !linkUrl.trim()}
                                className="shrink-0 rounded-md bg-primary px-3 py-2 text-xs font-medium text-bg transition-opacity hover:bg-primary-hover disabled:opacity-40"
                              >
                                הוסף
                              </button>
                            </div>
                            <p className="mt-2 text-xs leading-relaxed text-fg-muted">
                              הסרטון חייב להיות משותף ל"כל מי שיש לו את
                              הקישור". המערכת תעביר אותו לאחסון שלנו — בלי
                              להוריד ולהעלות מחדש.
                            </p>
                          </div>
                        )}
                      </motion.div>
                    </AnimatePresence>

                    {/* Staged videos */}
                    {staged.length > 0 && (
                      <div className="space-y-2">
                        {staged.map((item) => (
                          <div
                            key={item.id}
                            className="overflow-hidden rounded-lg border border-border bg-bg/50"
                          >
                            <div className="flex items-center justify-between gap-2.5 px-3 py-2">
                              {/* Right group: name (far right) then size.
                                  dir=ltr so neither flips. */}
                              <div className="flex min-w-0 items-baseline gap-2">
                                <span
                                  dir="ltr"
                                  className="min-w-0 truncate text-sm text-fg"
                                >
                                  {item.kind === 'file' ? item.file.name : item.url}
                                </span>
                                <span
                                  dir="ltr"
                                  className="shrink-0 text-[11px] text-fg-muted"
                                >
                                  {item.kind === 'file'
                                    ? formatBytes(item.file.size)
                                    : 'קישור Drive'}
                                </span>
                              </div>
                              {/* Left group: type icon + remove. */}
                              <div className="flex shrink-0 items-center gap-1.5">
                                {item.kind === 'file' ? (
                                  <FileVideo className="h-4 w-4 text-primary" />
                                ) : (
                                  <Link2 className="h-4 w-4 text-primary" />
                                )}
                                {!busy && (
                                  <button
                                    type="button"
                                    onClick={() => removeItem(item.id)}
                                    className="rounded p-1 text-fg-muted hover:text-destructive"
                                    aria-label="הסר"
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Unsupported codec → the browser can't convert
                                locally; point the user to the desktop app. */}
                            {item.kind === 'file' && item.unsupported && (
                              <div className="border-t border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5">
                                <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-200/90">
                                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                  <span>
                                    הפורמט של הסרטון לא מתנגן בדפדפן. כדי
                                    שהמערכת תמיר אותו אוטומטית ל-MP4, העלו אותו
                                    דרך אפליקציית המחשב. אפשר גם לשלוח כמו שהוא —
                                    הלקוח יוכל רק להוריד אותו.
                                  </span>
                                </p>
                              </div>
                            )}
                          </div>
                        ))}
                        <p className="text-[11px] text-fg-muted">
                          {staged.length} סרטונים
                          {totalStagedBytes > 0 && (
                            <>
                              {' · '}
                              <span dir="ltr">{formatBytes(totalStagedBytes)}</span>
                            </>
                          )}
                        </p>
                      </div>
                    )}

                    {/* Title */}
                    <div>
                      <label className="mb-1.5 block text-xs text-fg-muted">
                        שם המסירה (אופציונלי — יוצג ללקוח)
                      </label>
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="למשל: הקאט הסופי — קמפיין קיץ"
                        disabled={busy}
                        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
                      />
                    </div>

                    {/* Expiry — segmented control, same style as the
                        upload/link source toggle above. */}
                    <div>
                      <label className="mb-1.5 block text-xs text-fg-muted">
                        הקישור יהיה פעיל למשך
                      </label>
                      <div className="relative grid grid-cols-3 rounded-md border border-border bg-bg-card p-1">
                        {EXPIRY_OPTIONS.map((o) => {
                          const active = expiryDays === o.days
                          return (
                            <button
                              key={o.days}
                              type="button"
                              disabled={busy}
                              onClick={() => setExpiryDays(o.days)}
                              className="relative flex items-center justify-center rounded px-3 py-2 text-xs font-medium disabled:cursor-not-allowed"
                            >
                              {active && (
                                <motion.span
                                  layoutId="dlv-expiry-indicator"
                                  transition={{
                                    type: 'spring',
                                    stiffness: 420,
                                    damping: 34,
                                  }}
                                  className="absolute inset-0 rounded bg-primary"
                                />
                              )}
                              <span
                                className={
                                  'relative z-10 transition-colors ' +
                                  (active ? 'text-bg' : 'text-fg-muted hover:text-fg')
                                }
                              >
                                {o.label}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {/* Password — leave empty for no password (same as
                        the revisions modal). */}
                    <div>
                      <label className="mb-1.5 block text-xs text-fg-muted">
                        סיסמה (אופציונלי)
                      </label>
                      <input
                        type="text"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="ריק = ללא סיסמה. אחרת תישלח ללקוח בנפרד"
                        disabled={busy}
                        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary disabled:opacity-60"
                      />
                    </div>

                    {error && (
                      <p className="text-xs font-medium text-destructive">
                        {error}
                      </p>
                    )}
                  </>
                )}
              </div>

              {!busy && !done && (
                <div className="border-t border-border p-4">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={
                      staged.length === 0 ||
                      staged.some((s) => s.kind === 'file' && s.probing)
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-medium text-bg transition-opacity hover:bg-primary-hover disabled:opacity-40"
                  >
                    <Upload className="h-4 w-4" />
                    צור קישור לשליחה
                  </button>
                </div>
              )}
        </motion.div>
      </motion.div>
    </Portal>
  )
}

/* ── In-modal success view — shown after a delivery is created. Gives
 *    the shareable link + a copy button (mirrors the revisions modal).
 *    The user closes it themselves with "סיום". ─────────────────────── */
function DeliverySuccessView({
  shareUrl,
  copied,
  onCopy,
  onClose,
}: {
  shareUrl: string
  copied: boolean
  onCopy: () => void
  onClose: () => void
}) {
  return (
    <div className="space-y-5 py-2 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success/15 text-success">
        <CheckCircle2 className="h-7 w-7" strokeWidth={1.8} />
      </div>
      <div>
        <h3 className="text-base font-medium text-fg">
          הסרטון הועלה והקישור מוכן
        </h3>
        <p className="mt-2 text-xs text-fg-muted">
          שלחו את הקישור הזה ללקוח — הוא יוכל לצפות בסרטון ולהוריד אותו.
        </p>
      </div>

      {/* Share URL + copy */}
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={shareUrl}
          dir="ltr"
          className="block flex-1 truncate rounded-md border border-border bg-bg px-3 py-2.5 text-xs text-fg"
          onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
        <button
          type="button"
          onClick={onCopy}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-2.5 text-xs font-medium text-bg transition-all hover:bg-primary-hover"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? 'הועתק' : 'העתק'}
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="w-full rounded-md border border-border px-4 py-2.5 text-sm text-fg transition-colors hover:bg-bg-card"
      >
        סיום
      </button>
    </div>
  )
}

/* ── In-modal upload progress — the composer body swaps to THIS while
 *    the upload/import runs (mirrors the revisions modal). The modal
 *    stays open the whole time; closes itself on success. ─────────── */
function DeliveryProgressView({
  idx,
  total,
  frac,
  importing,
}: {
  idx: number
  total: number
  frac: number
  importing?: boolean
}) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)))
  return (
    <div className="space-y-5 py-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Loader2 className="h-7 w-7 animate-spin" strokeWidth={1.8} />
      </div>
      <div>
        <h3 className="text-base font-medium text-fg">
          {importing ? 'מייבא את הסרטון מ-Drive…' : 'מעלה את הסרטון…'}
        </h3>
        {total > 1 && (
          <p className="mt-1 text-xs text-fg-muted">
            סרטון {idx + 1} מתוך {total}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
          {importing ? (
            <div className="absolute inset-y-0 right-0 w-1/3 animate-pulse rounded-full bg-primary/60" />
          ) : (
            <motion.div
              className="absolute inset-y-0 right-0 rounded-full bg-primary"
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            />
          )}
        </div>
        {!importing && (
          <p className="text-[11px] text-fg-muted" dir="ltr">
            {pct}%
          </p>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-fg-muted">
        הסרטון נשמר באחסון שלכם. אל תסגרו את החלון.
      </p>
    </div>
  )
}

/* ── Source toggle — segmented "upload / import-link" with a sliding
 *    copper indicator (same pattern as the revisions modal). ──────── */
function SourceTabs({
  mode,
  onChange,
  disabled,
}: {
  mode: 'upload' | 'link'
  onChange: (m: 'upload' | 'link') => void
  disabled?: boolean
}) {
  return (
    <div className="relative grid grid-cols-2 rounded-md border border-border bg-bg-card p-1">
      {(['upload', 'link'] as const).map((m) => {
        const active = mode === m
        return (
          <button
            key={m}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onChange(m)}
            className="relative flex items-center justify-center gap-2 rounded px-3 py-2 text-xs font-medium disabled:cursor-not-allowed"
          >
            {active && (
              <motion.span
                layoutId="dlv-src-indicator"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded bg-primary"
              />
            )}
            <span
              className={
                'relative z-10 flex items-center gap-2 transition-colors ' +
                (active ? 'text-bg' : 'text-fg-muted hover:text-fg')
              }
            >
              {m === 'upload' ? (
                <Upload className="h-3.5 w-3.5" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              {m === 'upload' ? 'העלאת קובץ' : 'ייבוא מקישור'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ── Multi-file drag-and-drop zone. Drop or click adds the picked
 *    files to the staged list (always shows the empty prompt; the
 *    staged list lives separately, so this can add many). ────────── */
function MultiDropZone({
  onAdd,
  disabled = false,
}: {
  onAdd: (files: File[]) => void
  disabled?: boolean
}) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (disabled) return
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) onAdd(files)
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => {
          if (!disabled) inputRef.current?.click()
        }}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!disabled) setDragOver(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
        }}
        onDrop={handleDrop}
        className={
          'group relative flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed px-6 py-5 text-center transition-all ' +
          (disabled
            ? 'cursor-not-allowed border-border bg-bg-card/40 opacity-60'
            : dragOver
              ? 'scale-[1.01] border-primary bg-primary/10'
              : 'cursor-pointer border-border bg-bg-card hover:border-fg/30 hover:bg-bg-elevated')
        }
      >
        <div
          className={
            'flex h-10 w-10 items-center justify-center rounded-xl transition-colors ' +
            (dragOver
              ? 'bg-primary/20 text-primary'
              : 'bg-bg-elevated text-fg-muted group-hover:bg-primary/10 group-hover:text-primary')
          }
        >
          <Upload className="h-5 w-5" />
        </div>
        <div>
          <div className="text-sm font-medium text-fg">
            {dragOver ? 'שחרר כאן' : 'גרור קבצי וידאו לכאן'}
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            או <span className="text-primary">לחץ כדי לבחור</span> · כל גודל
            שנכנס במכסה
          </div>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          if (files.length) onAdd(files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

