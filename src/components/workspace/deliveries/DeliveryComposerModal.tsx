import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Upload,
  Loader2,
  Copy,
  Check,
  CheckCircle2,
  Lock,
  X,
  FileVideo,
  Link2,
  AlertTriangle,
} from 'lucide-react'
import { Portal } from '../../ui/Portal'
import {
  createDelivery,
  formatBytes,
  importDriveLinkToR2,
  readVideoDims,
} from '../../../lib/revisionsApi'
import { uploadFileToR2 } from '../../../lib/r2Upload'
import { SITE_ORIGIN } from '../../../lib/site'

/* ══════════════════════════════════════════════════════════════
 *  Composer modal — opened by the "שליחת סרטון" button on /deliveries.
 *
 *  Same markup + classes as the desktop app's composer (DeliveriesPage
 *  in the app repo): a segmented "upload / import-from-link" source
 *  toggle, a large drag-and-drop zone, segmented expiry tabs and an
 *  optional password. Supports MULTIPLE videos per delivery — each can
 *  be a local upload (straight from the browser to R2) OR a public
 *  Google-Drive link (imported into {uid}/finals/ by Cloudflare, no
 *  re-upload).
 *
 *  Web-only parts (the app has no equivalent), styled with the same app
 *  vocabulary: the browser playability check + its "use the desktop app"
 *  note (the browser can't convert ProRes/HEVC), and the upload progress
 *  view's copy (the upload can't be cancelled from here).
 *
 *  Rendered through a Portal (outside the page's `.app-ui` root), so it
 *  carries its own `.app-ui` wrapper.
 * ══════════════════════════════════════════════════════════════ */

const SITE = SITE_ORIGIN

const EXPIRY_OPTIONS: Array<{ days: 3 | 7 | 14; label: string }> = [
  { days: 3, label: '3 ימים' },
  { days: 7, label: 'שבוע' },
  { days: 14, label: 'שבועיים' },
]

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

export function DeliveryComposerModal({
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
        width?: number
        height?: number
      }> = []
      for (let i = 0; i < staged.length; i++) {
        const item = staged[i]
        if (item.kind === 'file') {
          setProgress({ idx: i, total: staged.length, frac: 0 })
          // Read the pixel dimensions before upload so the player can reserve
          // the right aspect ratio (no layout jump when the video loads).
          const dims = await readVideoDims(item.file)
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
            ...(dims.width && dims.height
              ? { width: dims.width, height: dims.height }
              : {}),
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
      {/* The app's theme (the portal renders outside the page's .app-ui). */}
      <div className="app-ui">
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
            role="dialog"
            aria-modal="true"
            aria-labelledby="dlv-composer-title"
            className="flex max-h-[90vh] w-[min(33.75rem,94vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-background shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/5 p-4">
              <h2
                id="dlv-composer-title"
                className="text-base font-medium text-foreground"
              >
                שליחת סרטון
              </h2>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground disabled:opacity-40"
                aria-label="סגירה"
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
                        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-5">
                          <label
                            htmlFor="dlv-drive-link"
                            className="mb-2 block text-xs font-medium text-foreground"
                          >
                            קישור Google Drive ציבורי
                          </label>
                          <div className="flex gap-2">
                            <input
                              id="dlv-drive-link"
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
                              className="w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                            />
                            <button
                              type="button"
                              onClick={addLink}
                              disabled={busy || !linkUrl.trim()}
                              className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background transition-opacity hover:bg-primary/90 disabled:opacity-40"
                            >
                              הוספה
                            </button>
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                            הסרטון חייב להיות משותף ל"כל מי שיש לו את הקישור".
                            המערכת תעביר אותו לאחסון שלנו, בלי להוריד ולהעלות
                            מחדש.
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
                          className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]"
                        >
                          <div className="flex items-center justify-between gap-2.5 px-3 py-2">
                            {/* Right group: name (far right) then size.
                                dir=ltr so neither flips. */}
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span
                                dir="ltr"
                                className="min-w-0 truncate text-sm text-foreground"
                              >
                                {item.kind === 'file' ? item.file.name : item.url}
                              </span>
                              <span
                                dir="ltr"
                                className="shrink-0 text-[0.6875rem] text-muted-foreground"
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
                                  className="rounded p-1 text-muted-foreground hover:text-destructive"
                                  aria-label="הסרה"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Browser compatibility check (local, fast). */}
                          {item.kind === 'file' && item.probing && (
                            <div className="flex items-center gap-1.5 border-t border-white/5 px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              בודק תאימות לנגן…
                            </div>
                          )}

                          {/* Web-only: the browser can't transcode, so an
                              unplayable file points to the desktop app
                              (which converts automatically). Same strip as
                              the app's "will be converted" note. */}
                          {item.kind === 'file' && item.unsupported && (
                            <div className="flex items-start gap-2 border-t border-white/5 bg-primary/[0.06] px-3 py-2">
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                              <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                                הפורמט של הסרטון אינו נתמך לצפייה בדפדפן. כדי
                                שהמערכת תמיר אותו אוטומטית ל-MP4 באיכות מלאה,
                                העלו אותו דרך אפליקציית המחשב.
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                      <p className="text-[0.6875rem] text-muted-foreground">
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
                    <label
                      htmlFor="dlv-title"
                      className="mb-1.5 block text-xs text-muted-foreground"
                    >
                      שם המסירה (אופציונלי, יוצג ללקוח)
                    </label>
                    <input
                      id="dlv-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="למשל: הקאט הסופי לקמפיין קיץ"
                      disabled={busy}
                      className="w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                    />
                  </div>

                  {/* Expiry — segmented tabs, same style as the source
                      toggle above. */}
                  <div>
                    <label className="mb-1.5 block text-xs text-muted-foreground">
                      הקישור יהיה פעיל למשך
                    </label>
                    <div className="relative grid grid-cols-3 rounded-lg border border-white/10 bg-white/[0.02] p-1">
                      {EXPIRY_OPTIONS.map((o) => {
                        const active = expiryDays === o.days
                        return (
                          <button
                            key={o.days}
                            type="button"
                            disabled={busy}
                            aria-pressed={active}
                            onClick={() => setExpiryDays(o.days)}
                            className="relative flex items-center justify-center rounded-md px-3 py-2 text-xs font-medium disabled:cursor-not-allowed"
                          >
                            {active && (
                              <motion.span
                                layoutId="dlv-expiry-indicator"
                                transition={{
                                  type: 'spring',
                                  stiffness: 420,
                                  damping: 34,
                                }}
                                className="absolute inset-0 rounded-md bg-primary"
                              />
                            )}
                            <span
                              className={
                                'relative z-10 transition-colors ' +
                                (active
                                  ? 'text-background'
                                  : 'text-muted-foreground hover:text-foreground')
                              }
                            >
                              {o.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Password — leave empty for no password. */}
                  <div>
                    <label
                      htmlFor="dlv-password"
                      className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      סיסמה (אופציונלי)
                    </label>
                    <input
                      id="dlv-password"
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="ריק = ללא סיסמה. אחרת תישלח ללקוח בנפרד"
                      disabled={busy}
                      className="w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                    />
                  </div>

                  {error && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {error}
                    </p>
                  )}
                </>
              )}
            </div>

            {!busy && !done && (
              <div className="border-t border-white/5 p-4">
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={
                    staged.length === 0 ||
                    staged.some((s) => s.kind === 'file' && s.probing)
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-background transition-opacity hover:bg-primary/90 disabled:opacity-40"
                >
                  <Upload className="h-4 w-4" />
                  יצירת קישור לשליחה
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      </div>
    </Portal>
  )
}

/* ── In-modal upload progress — the composer body swaps to THIS while
 *    the upload/import runs (mirrors the app). Web: the bytes go from
 *    this browser tab, so it must stay open (the X is disabled while
 *    busy). ─────────────────────────────────────────────────────────── */
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
        <h3 className="text-base font-medium text-foreground">
          {importing ? 'מייבא את הסרטון מ-Drive…' : 'מעלה את הסרטון…'}
        </h3>
        {total > 1 && (
          <p className="mt-1 text-xs text-muted-foreground">
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
          <p className="text-[0.6875rem] text-muted-foreground">
            <span dir="ltr">{pct}%</span>
          </p>
        )}
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        הסרטון נשמר באחסון שלכם. אל תסגרו את החלון.
      </p>
    </div>
  )
}

/* ── In-modal success view — shown after a delivery is created. Gives
 *    the shareable link + a copy button (mirrors the app). The user
 *    closes it themselves with "סיום". ────────────────────────────── */
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
        <h3 className="text-base font-medium text-foreground">
          הסרטון הועלה והקישור מוכן
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          שלחו את הקישור הזה ללקוח. הוא יוכל לצפות בסרטון ולהוריד אותו.
        </p>
      </div>

      {/* Share URL + copy */}
      <div className="flex items-stretch gap-2">
        <input
          readOnly
          value={shareUrl}
          dir="ltr"
          aria-label="הקישור לשליחה ללקוח"
          className="block flex-1 truncate rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-xs text-foreground"
          onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
        <button
          type="button"
          onClick={onCopy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-xs font-semibold text-background transition-all hover:bg-primary/90"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? 'הועתק' : 'העתקה'}
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="w-full rounded-lg border border-white/10 px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-white/5"
      >
        סיום
      </button>
    </div>
  )
}

/* ── Source toggle — segmented "upload / import-link" with a sliding
 *    copper indicator (matches the app). ────────────────────────────── */
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
    <div className="relative grid grid-cols-2 rounded-lg border border-white/10 bg-white/[0.02] p-1">
      {(['upload', 'link'] as const).map((m) => {
        const active = mode === m
        return (
          <button
            key={m}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => !disabled && onChange(m)}
            className="relative flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium disabled:cursor-not-allowed"
          >
            {active && (
              <motion.span
                layoutId="dlv-src-indicator"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded-md bg-primary"
              />
            )}
            <span
              className={
                'relative z-10 flex items-center gap-2 transition-colors ' +
                (active
                  ? 'text-background'
                  : 'text-muted-foreground hover:text-foreground')
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
 *    staged list lives separately, so this can add many). The app's
 *    look; the browser's own file input behind it. ────────────────── */
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
          'group flex cursor-pointer flex-col items-center rounded-2xl border border-dashed px-6 py-5 text-center transition-colors ' +
          (disabled
            ? 'cursor-not-allowed border-white/10 opacity-60'
            : dragOver
              ? 'border-primary bg-primary/[0.06]'
              : 'border-white/15 bg-white/[0.02] hover:border-primary/50 hover:bg-white/[0.03]')
        }
      >
        <div
          className={
            'mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl text-primary transition-colors ' +
            (dragOver ? 'bg-primary/20' : 'bg-primary/10')
          }
        >
          <Upload className="h-5 w-5" strokeWidth={1.8} />
        </div>
        <h3 className="text-sm font-medium text-foreground">
          {dragOver ? 'שחררו כדי להעלות' : 'גררו סרטונים לכאן'}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          או לחצו לבחירה · אפשר כמה · כל גודל שנכנס במכסה
        </p>
        {/* The app's second line promises automatic conversion; the
            browser can't convert, so the web says where it happens. */}
        <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground/70">
          נתמך לצפייה ישירה בדפדפן: MP4, MOV, WEBM בקידוד H.264.
          <br />
          פורמטים אחרים, כמו ProRes או HEVC, מומרים אוטומטית ל-MP4 רק
          בהעלאה מאפליקציית המחשב.
        </p>
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
