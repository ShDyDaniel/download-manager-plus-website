import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Loader2,
  Lock,
  Mail,
  AlertTriangle,
  Plus,
  MessageSquare,
  Send,
  X,
  Camera,
} from 'lucide-react'

/**
 * Public revision review page.
 *
 * URL: /review/:token
 *
 * Architecture (zero-cost streaming via Drive direct URL):
 *   1. Page mounts → POST get-stream-token to our backend.
 *   2. Backend authenticates (share token + password) and returns
 *      a short-lived Drive access token + the Drive fileId.
 *   3. Page builds a direct URL:
 *      https://www.googleapis.com/drive/v3/files/{id}?alt=media&access_token={token}
 *   4. <video src={driveUrl}> — the browser streams DIRECTLY from
 *      Google's CDN. Zero bandwidth through our server, full
 *      Range/seek support, full HTML5 event API.
 *   5. When token expires (1h), we refetch transparently.
 *
 * That direct-URL trick is what unblocks all the features Drive's
 * iframe blocks: currentTime access, auto-pause detection, frame
 * screenshot capture, custom controls — everything.
 */

const API = '/api/revisions'

interface ProjectInfo {
  title: string
  driveFileId: string
  videoMime: string
}

interface Note {
  id: string
  viewerEmail: string
  viewerName?: string | null
  timeSeconds: number
  text: string
  screenshotDataUrl?: string | null
  status: 'new' | 'resolved'
  createdAt: number
}

type State =
  | { kind: 'loading' }
  | { kind: 'not-found'; message: string }
  | { kind: 'needs-password'; title?: string }
  | { kind: 'needs-email'; title: string }
  | { kind: 'ready'; project: ProjectInfo; viewerEmail: string }

const EMAIL_KEY_PREFIX = 'dmplus.review.email.'
const PWD_TOKEN_KEY_PREFIX = 'dmplus.review.pwd.'

export function ReviewPage() {
  const { token: rawToken } = useParams<{ token: string }>()
  const token = (rawToken || '').trim()
  const [state, setState] = useState<State>({ kind: 'loading' })

  // Initial decision tree — figure out which gate (if any) to show.
  useEffect(() => {
    if (!token) {
      setState({ kind: 'not-found', message: 'הקישור לא תקין.' })
      return
    }
    void load()
    async function load() {
      // Step 1 — fetch project metadata (lightweight) to know if it
      // exists + whether a password is required. We can't request a
      // stream token until we know the password situation.
      try {
        const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
        const r = await fetch(`${API}?action=get-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareToken: token, passwordToken }),
        })
        const json = (await r.json()) as
          | { ok: true; needsPassword: true; title: string }
          | { ok: true; needsPassword: false; project: { title: string } }
          | { ok: false; error: string }

        if (!json.ok) {
          setState({ kind: 'not-found', message: json.error || 'הקישור לא נמצא.' })
          return
        }
        if (json.needsPassword) {
          setState({ kind: 'needs-password', title: json.title })
          return
        }
        // Need viewer email next (for watermark + note attribution).
        const storedEmail = localStorage.getItem(EMAIL_KEY_PREFIX + token)
        if (storedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(storedEmail)) {
          // We have everything; load the stream token.
          await loadStream(storedEmail, json.project.title)
        } else {
          setState({ kind: 'needs-email', title: json.project.title })
        }
      } catch (err) {
        console.error('[review] load failed:', err)
        setState({
          kind: 'not-found',
          message: 'אירעה שגיאה בטעינת הפרויקט. נסו לרענן את הדף.',
        })
      }
    }

    async function loadStream(viewerEmail: string, title: string) {
      const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
      const r = await fetch(`${API}?action=get-stream-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken: token, passwordToken }),
      })
      const json = (await r.json()) as
        | { ok: true; accessToken: string; expiresIn: number; driveFileId: string; videoMime: string; title: string }
        | { ok: false; error: string }
      if (!json.ok) {
        setState({ kind: 'not-found', message: json.error || 'שגיאה בקבלת הסרטון' })
        return
      }
      setState({
        kind: 'ready',
        project: {
          title,
          driveFileId: json.driveFileId,
          videoMime: json.videoMime,
        },
        viewerEmail,
      })
    }
  }, [token])

  if (state.kind === 'loading') return <CenterCard><LoadingState /></CenterCard>
  if (state.kind === 'not-found')
    return (
      <CenterCard>
        <NotFoundState message={state.message} />
      </CenterCard>
    )
  if (state.kind === 'needs-password')
    return (
      <CenterCard>
        <PasswordGate
          token={token}
          title={state.title || 'סבב מוגן'}
          onVerified={() => {
            // Simplest: reload, the effect will pick up the password
            // token from localStorage and proceed past the gate.
            window.location.reload()
          }}
        />
      </CenterCard>
    )
  if (state.kind === 'needs-email')
    return (
      <CenterCard>
        <EmailGate
          title={state.title}
          onEntered={(email) => {
            localStorage.setItem(EMAIL_KEY_PREFIX + token, email)
            // Same pattern: reload so the effect re-runs and lands
            // on the ready state with the new email.
            window.location.reload()
          }}
        />
      </CenterCard>
    )

  return (
    <ReviewWorkspace
      token={token}
      project={state.project}
      viewerEmail={state.viewerEmail}
    />
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Shared shells
 * ───────────────────────────────────────────────────────────── */

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center px-4 py-8" dir="rtl">
      <div className="w-full max-w-md">{children}</div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <Loader2 className="h-6 w-6 animate-spin text-fg-muted" />
      <p className="text-xs text-fg-muted">טוען את הפרויקט...</p>
    </div>
  )
}

function NotFoundState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h1 className="mb-2 text-lg font-medium text-fg">לא הצלחנו לטעון את הסרטון</h1>
      <p className="text-sm leading-relaxed text-fg-muted">{message}</p>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Password gate
 * ───────────────────────────────────────────────────────────── */
function PasswordGate({
  token,
  title,
  onVerified,
}: {
  token: string
  title: string
  onVerified: () => void
}) {
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!pwd || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API}?action=verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken: token, password: pwd }),
      })
      const json = (await r.json()) as
        | { ok: true; passwordToken: string }
        | { ok: false; error: string }
      if (!json.ok) {
        setError(json.error || 'סיסמה שגויה')
        setBusy(false)
        return
      }
      localStorage.setItem(PWD_TOKEN_KEY_PREFIX + token, json.passwordToken)
      onVerified()
    } catch {
      setError('שגיאת רשת. נסו שוב.')
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-2xl border border-white/5 bg-white/[0.02] p-8"
    >
      <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Lock className="h-5 w-5" />
      </div>
      <div className="text-center">
        <h1 className="text-lg font-medium text-fg">סבב מוגן בסיסמה</h1>
        <p className="mt-1 text-xs text-fg-muted">{title}</p>
      </div>
      <input
        type="password"
        value={pwd}
        onChange={(e) => setPwd(e.target.value)}
        autoFocus
        placeholder="סיסמה"
        className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!pwd || busy}
        className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'אישור'}
      </button>
    </form>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Email gate
 * ───────────────────────────────────────────────────────────── */
function EmailGate({
  title,
  onEntered,
}: {
  title: string
  onEntered: (email: string) => void
}) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const clean = email.trim().toLowerCase()
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setError('כתובת מייל לא תקינה')
      return
    }
    setError(null)
    onEntered(clean)
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-2xl border border-white/5 bg-white/[0.02] p-8"
    >
      <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Mail className="h-5 w-5" />
      </div>
      <div className="text-center">
        <h1 className="text-lg font-medium text-fg">{title}</h1>
        <p className="mt-1 text-xs text-fg-muted">
          הזינו את כתובת המייל שלכם כדי לצפות בסרטון.
          המייל יוצג כ-watermark על הוידאו ויצורף לכל תיקון שתוסיפו.
        </p>
      </div>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
        placeholder="your@email.com"
        dir="ltr"
        className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary/90"
      >
        כניסה
      </button>
    </form>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Workspace — the actual review experience
 * ───────────────────────────────────────────────────────────── */
function ReviewWorkspace({
  token,
  project,
  viewerEmail,
}: {
  token: string
  project: ProjectInfo
  viewerEmail: string
}) {
  // Stream token refreshing — token expires in ~55 min (we lied to
  // the client by 5 min vs Google's actual 60 min to avoid mid-Range
  // expiry). We refresh once at ~50 min and rebuild the video src.
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [streamLoading, setStreamLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const refresh = async () => {
      try {
        const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
        const r = await fetch(`${API}?action=get-stream-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareToken: token, passwordToken }),
        })
        const json = (await r.json()) as
          | { ok: true; accessToken: string; expiresIn: number; driveFileId: string }
          | { ok: false; error: string }
        if (cancelled) return
        if (!json.ok) {
          setStreamLoading(false)
          return
        }
        const url = `https://www.googleapis.com/drive/v3/files/${json.driveFileId}?alt=media&access_token=${encodeURIComponent(json.accessToken)}`
        setStreamUrl(url)
        setStreamLoading(false)
        // Refresh slightly before the token expires.
        timer = setTimeout(refresh, Math.max(60, json.expiresIn - 60) * 1000)
      } catch {
        setStreamLoading(false)
      }
    }

    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [token])

  const [notes, setNotes] = useState<Note[]>([])
  const [notesLoading, setNotesLoading] = useState(true)
  useEffect(() => {
    void loadNotes()
    async function loadNotes() {
      try {
        const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
        const r = await fetch(`${API}?action=list-notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareToken: token, passwordToken }),
        })
        const json = (await r.json()) as
          | { ok: true; notes: Note[] }
          | { ok: false; error: string }
        if (json.ok) setNotes(json.notes)
      } finally {
        setNotesLoading(false)
      }
    }
  }, [token])

  const videoRef = useRef<HTMLVideoElement>(null)

  // Composer state — opened by either "add note" button (no
  // screenshot) or "snapshot + note" button (screenshot captured
  // at click time from the video element).
  const [composer, setComposer] = useState<
    | null
    | {
        timeSeconds: number
        screenshotDataUrl: string | null
      }
  >(null)
  const [noteText, setNoteText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function openNoteWithCurrentTime() {
    const v = videoRef.current
    if (!v) return
    // Pause first so the user has a static frame to think about.
    if (!v.paused) v.pause()
    setComposer({
      timeSeconds: Math.max(0, Math.floor(v.currentTime)),
      screenshotDataUrl: null,
    })
    setNoteText('')
    setSubmitError(null)
  }

  function openNoteWithScreenshot() {
    const v = videoRef.current
    if (!v) return
    if (!v.paused) v.pause()
    const data = captureFrame(v)
    setComposer({
      timeSeconds: Math.max(0, Math.floor(v.currentTime)),
      screenshotDataUrl: data,
    })
    setNoteText('')
    setSubmitError(null)
  }

  async function submitNote() {
    if (!composer || !noteText.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
      const r = await fetch(`${API}?action=add-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareToken: token,
          passwordToken,
          viewerEmail,
          timeSeconds: composer.timeSeconds,
          text: noteText.trim(),
          screenshotDataUrl: composer.screenshotDataUrl,
        }),
      })
      const json = (await r.json()) as
        | { ok: true; noteId: string }
        | { ok: false; error: string }
      if (!json.ok) {
        setSubmitError(json.error || 'שליחה נכשלה')
        setSubmitting(false)
        return
      }
      setNotes((prev) => [
        ...prev,
        {
          id: json.noteId,
          viewerEmail,
          timeSeconds: composer.timeSeconds,
          text: noteText.trim(),
          screenshotDataUrl: composer.screenshotDataUrl,
          status: 'new',
          createdAt: Date.now(),
        },
      ])
      setComposer(null)
      setNoteText('')
      setSubmitting(false)
    } catch {
      setSubmitError('שגיאת רשת')
      setSubmitting(false)
    }
  }

  function seekTo(timeSeconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = timeSeconds
  }

  return (
    <div className="min-h-screen bg-bg text-fg" dir="rtl">
      {/* Header */}
      <header className="border-b border-white/5 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.16em] text-fg-muted">
              — סבב תיקונים
            </div>
            <h1 className="mt-1 truncate text-lg font-medium text-fg">
              {project.title}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={openNoteWithScreenshot}
              title="צלם פריים והוסף תיקון"
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-white/[0.06]"
            >
              <Camera className="h-4 w-4" />
              צלם + תיקון
            </button>
            <button
              type="button"
              onClick={openNoteWithCurrentTime}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-bg shadow-md shadow-primary/20 transition-all hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" strokeWidth={2.5} />
              תיקון חדש
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-6 md:grid-cols-[1fr_320px]">
        {/* Player */}
        <div className="relative overflow-hidden rounded-2xl border border-white/5 bg-black">
          <div className="aspect-video w-full">
            {streamLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-fg-muted" />
              </div>
            ) : streamUrl ? (
              <video
                ref={videoRef}
                src={streamUrl}
                controls
                crossOrigin="anonymous"
                playsInline
                controlsList="nodownload"
                onContextMenu={(e) => e.preventDefault()}
                className="block h-full w-full"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">
                לא הצלחנו לטעון את הסרטון.
              </div>
            )}
          </div>
          <Watermark email={viewerEmail} />
        </div>

        {/* Notes sidebar */}
        <aside className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
          <div className="mb-3 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-fg-muted" />
            <h2 className="text-sm font-medium text-fg">תיקונים</h2>
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-fg-muted">
              {notes.length}
            </span>
          </div>
          {notesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />
            </div>
          ) : notes.length === 0 ? (
            <EmptyNotesState />
          ) : (
            <ul className="space-y-2.5 max-h-[60vh] overflow-y-auto">
              {notes.map((note) => (
                <NoteItem key={note.id} note={note} onSeek={seekTo} />
              ))}
            </ul>
          )}
        </aside>
      </div>

      {/* Composer overlay */}
      <AnimatePresence>
        {composer && (
          <NoteComposer
            timeSeconds={composer.timeSeconds}
            screenshotDataUrl={composer.screenshotDataUrl}
            text={noteText}
            setText={setNoteText}
            submitting={submitting}
            error={submitError}
            onSubmit={submitNote}
            onClose={() => setComposer(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** Capture the current video frame to a JPEG data URL. Quality 0.75
 *  is a good balance: under 200KB for 1080p frames, plenty of detail
 *  for the editor to see what the viewer is pointing at. */
function captureFrame(video: HTMLVideoElement): string | null {
  try {
    const canvas = document.createElement('canvas')
    // Cap to 1280×720 — bigger screenshots blow past Firestore's
    // doc size limit (~700KB after base64 + JSON overhead). 720p
    // is plenty to convey "the green color here is off".
    const targetW = Math.min(1280, video.videoWidth)
    const scale = targetW / video.videoWidth
    canvas.width = targetW
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.75)
  } catch (err) {
    // The canvas can get "tainted" if CORS isn't right on the
    // video source. Returning null lets the caller fall back to
    // a text-only note instead of crashing.
    console.warn('[review] captureFrame failed (CORS?):', err)
    return null
  }
}

function Watermark({ email }: { email: string }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 select-none"
      style={{ mixBlendMode: 'overlay' }}
    >
      <div className="absolute top-4 right-4 text-white/40 text-[10px] tracking-wider font-mono">
        {email}
      </div>
      <div className="absolute bottom-4 left-4 text-white/40 text-[10px] tracking-wider font-mono">
        PREVIEW · NOT FOR DISTRIBUTION
      </div>
      <motion.div
        className="absolute text-white/15 text-2xl font-semibold whitespace-nowrap"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
        animate={{
          x: [-40, 40, -40],
          y: [-20, 20, -20],
        }}
        transition={{
          duration: 30,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        {email}
      </motion.div>
    </div>
  )
}

function EmptyNotesState() {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-6 text-center">
      <p className="text-[11px] leading-relaxed text-fg-muted">
        עצרו את הסרטון ולחצו על
        <strong className="font-semibold text-fg/80"> "תיקון חדש" </strong>
        כדי להוסיף הערה — הזמן ייכנס אוטומטית.
      </p>
    </div>
  )
}

function NoteItem({ note, onSeek }: { note: Note; onSeek: (t: number) => void }) {
  const mm = Math.floor(note.timeSeconds / 60)
  const ss = Math.floor(note.timeSeconds % 60).toString().padStart(2, '0')
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center justify-between text-[10px] text-fg-muted">
        <button
          type="button"
          onClick={() => onSeek(note.timeSeconds)}
          title="קפיצה לזמן בסרטון"
          className="font-mono rounded px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/10"
        >
          {mm}:{ss}
        </button>
        <span dir="ltr" className="truncate">{note.viewerEmail}</span>
      </div>
      {note.screenshotDataUrl && (
        <img
          src={note.screenshotDataUrl}
          alt="צילום פריים"
          className="mb-2 w-full rounded border border-white/10"
        />
      )}
      <p className="text-xs leading-relaxed text-fg whitespace-pre-wrap">
        {note.text}
      </p>
    </li>
  )
}

function NoteComposer({
  timeSeconds,
  screenshotDataUrl,
  text,
  setText,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  timeSeconds: number
  screenshotDataUrl: string | null
  text: string
  setText: (s: string) => void
  submitting: boolean
  error: string | null
  onSubmit: () => void
  onClose: () => void
}) {
  const minutes = useMemo(() => Math.floor(timeSeconds / 60), [timeSeconds])
  const seconds = useMemo(
    () => Math.floor(timeSeconds % 60).toString().padStart(2, '0'),
    [timeSeconds],
  )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <div>
            <h3 className="text-sm font-medium text-fg">תיקון חדש</h3>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              בנקודה <span dir="ltr" className="font-mono">{minutes}:{seconds}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירה"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {screenshotDataUrl && (
            <img
              src={screenshotDataUrl}
              alt="צילום פריים"
              className="w-full rounded-lg border border-white/10"
            />
          )}
          <div>
            <label className="mb-1.5 block text-[11px] text-fg-muted">
              מה צריך לתקן?
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              rows={4}
              placeholder="לדוגמה: צבע הירק לא מתאים, להוריד את הווליום של המוזיקה ברקע..."
              className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/5 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!text.trim() || submitting}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            שליחה
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
