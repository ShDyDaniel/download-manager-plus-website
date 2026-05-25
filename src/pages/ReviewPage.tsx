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
  ArrowUpLeft,
} from 'lucide-react'

/**
 * Public revision review page.
 *
 * URL: /review/:token
 *
 * This page is the END CLIENT'S touchpoint with the system — the
 * person who got a share link from a video editor. They are NOT a
 * paying user, may never have heard of ניהול הורדות פלוס, and
 * shouldn't have to figure out the rest of the marketing site. So:
 *
 *   - The global SiteHeader is hidden on /review (handled in
 *     SiteHeader.tsx) — no "החשבון שלי" link confusing the viewer.
 *   - Local ReviewChrome header + footer ARE shown — they introduce
 *     the brand subtly ("מופעל על ידי ניהול הורדות פלוס") without
 *     pushing the viewer to convert mid-task.
 *   - The video player intentionally does NOT force 16:9. Drive-hosted
 *     content is often portrait (TikTok / Reels exports) and forcing
 *     wide aspect leaves huge black bars on the sides.
 *
 * Streaming architecture (zero-cost via Cloudflare Worker):
 *   browser → CF Worker → Vercel auth-stream (validates share token +
 *   password, returns Drive access token) → Drive direct fetch.
 *   All video bytes flow through Cloudflare (unlimited free egress);
 *   Vercel only authenticates. See /cloudflare-worker/stream-proxy.js.
 */

const API = '/api/revisions'

interface ProjectInfo {
  title: string
  streamUrl: string
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

  useEffect(() => {
    if (!token) {
      setState({ kind: 'not-found', message: 'הקישור לא תקין.' })
      return
    }
    void load()
    async function load() {
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
        const storedEmail = localStorage.getItem(EMAIL_KEY_PREFIX + token)
        if (storedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(storedEmail)) {
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
        | { ok: true; streamUrl: string; videoMime: string; title: string }
        | { ok: false; error: string }
      if (!json.ok) {
        setState({ kind: 'not-found', message: json.error || 'שגיאה בקבלת הסרטון' })
        return
      }
      setState({
        kind: 'ready',
        project: {
          title,
          streamUrl: json.streamUrl,
          videoMime: json.videoMime,
        },
        viewerEmail,
      })
    }
  }, [token])

  if (state.kind === 'loading')
    return (
      <ReviewShell>
        <CenterCard>
          <LoadingState />
        </CenterCard>
      </ReviewShell>
    )
  if (state.kind === 'not-found')
    return (
      <ReviewShell>
        <CenterCard>
          <NotFoundState message={state.message} />
        </CenterCard>
      </ReviewShell>
    )
  if (state.kind === 'needs-password')
    return (
      <ReviewShell>
        <CenterCard>
          <PasswordGate
            token={token}
            title={state.title || 'סבב מוגן'}
            onVerified={() => window.location.reload()}
          />
        </CenterCard>
      </ReviewShell>
    )
  if (state.kind === 'needs-email')
    return (
      <ReviewShell>
        <CenterCard>
          <EmailGate
            title={state.title}
            onEntered={(email) => {
              localStorage.setItem(EMAIL_KEY_PREFIX + token, email)
              window.location.reload()
            }}
          />
        </CenterCard>
      </ReviewShell>
    )

  return (
    <ReviewShell viewerEmail={state.viewerEmail}>
      <ReviewWorkspace
        token={token}
        project={state.project}
        viewerEmail={state.viewerEmail}
      />
    </ReviewShell>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Page shell: ReviewHeader + content + ReviewFooter
 *
 *  Used on every state (loading / gates / workspace) so the
 *  branding is consistent and the page never looks like a stray
 *  fragment. flex-col + min-h-screen pins the footer to the
 *  bottom even when content is short.
 * ───────────────────────────────────────────────────────────── */
function ReviewShell({
  children,
  viewerEmail,
}: {
  children: React.ReactNode
  viewerEmail?: string
}) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg" dir="rtl">
      <ReviewHeader viewerEmail={viewerEmail} />
      <main className="flex-1">{children}</main>
      <ReviewFooter />
    </div>
  )
}

function ReviewHeader({ viewerEmail }: { viewerEmail?: string }) {
  return (
    <header className="border-b border-white/5 bg-white/[0.015]">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        {/* Brand — links to the marketing site so a curious viewer
            can find the tool. Opens in a new tab so it doesn't
            disrupt the review flow. */}
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-2.5 transition-opacity"
          aria-label="ניהול הורדות פלוס — דף הבית"
        >
          <img
            src="/icon.png"
            alt=""
            aria-hidden
            className="h-8 w-8 rounded-lg ring-1 ring-white/5"
          />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-fg group-hover:text-primary transition-colors">
              ניהול הורדות פלוס
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-fg-muted">
              סבב תיקונים
            </span>
          </div>
        </a>

        {/* Viewer email pill — shown only when a viewer is signed in.
            On mobile we collapse to just the icon to save space. */}
        {viewerEmail && (
          <div
            className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-white/[0.02] px-2.5 py-1 text-[11px] text-fg-muted"
            title={viewerEmail}
          >
            <Mail className="h-3 w-3 shrink-0" />
            <span dir="ltr" className="hidden font-mono sm:inline">
              {viewerEmail}
            </span>
          </div>
        )}
      </div>
    </header>
  )
}

function ReviewFooter() {
  return (
    <footer className="border-t border-white/5 bg-white/[0.01]">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          <span>מופעל על ידי</span>
          <img
            src="/icon.png"
            alt=""
            aria-hidden
            className="h-4 w-4 rounded ring-1 ring-white/5"
          />
          <span className="font-semibold text-fg/85 group-hover:text-primary transition-colors">
            ניהול הורדות פלוס
          </span>
          <span className="text-fg-muted/50">—</span>
          <span>תוכנה לעורכי וידאו ויוצרי תוכן</span>
          <ArrowUpLeft className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
      </div>
    </footer>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Shared shells for the gate states
 * ───────────────────────────────────────────────────────────── */
function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center px-4 py-12 sm:py-20">
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
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          הזינו את כתובת המייל שלכם כדי לצפות בסרטון.
          המייל יוצג כסימן מים על הוידאו ויצורף לכל תיקון שתוסיפו.
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
 *
 *  Layout (RTL — visually the player is on the RIGHT, notes on
 *  the LEFT on desktop because the second grid column lands on
 *  the visual left in RTL flow):
 *
 *  ┌────────────────────────────┐ ┌────────────────┐
 *  │     [project title]        │ │  תיקונים (N)   │
 *  │  ┌──────────────────────┐  │ │  ┌──────────┐  │
 *  │  │                      │  │ │  │ 0:06     │  │
 *  │  │   VIDEO PLAYER       │  │ │  │ [📷] note│  │
 *  │  │   (own aspect)       │  │ │  └──────────┘  │
 *  │  └──────────────────────┘  │ │                │
 *  │  [+ תיקון] [📷 צלם+תיקון] │ │                │
 *  └────────────────────────────┘ └────────────────┘
 *
 *  Mobile: single column, sidebar below the player.
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
  const streamUrl = project.streamUrl

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
  const [lightbox, setLightbox] = useState<string | null>(null)

  function openNoteWithCurrentTime() {
    const v = videoRef.current
    if (!v) return
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
    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">
      {/* Title row */}
      <div className="mb-4 sm:mb-5">
        <h1 className="truncate text-lg font-medium text-fg sm:text-xl">
          {project.title}
        </h1>
      </div>

      <div className="grid gap-4 sm:gap-5 md:grid-cols-[1fr_340px]">
        {/* Player column */}
        <div className="space-y-3">
          {/* Player surface — black bg + centered video. We do NOT
              force aspect-video; instead we cap height and let the
              video define its own width/height via object-contain.
              This means portrait videos look natural (small centered
              rectangle on a black backdrop) instead of huge wasted
              side-bars. */}
          <div className="relative overflow-hidden rounded-2xl border border-white/5 bg-black">
            <div className="flex max-h-[72vh] items-center justify-center">
              <video
                ref={videoRef}
                src={streamUrl}
                controls
                crossOrigin="anonymous"
                playsInline
                controlsList="nodownload"
                onContextMenu={(e) => e.preventDefault()}
                className="block max-h-[72vh] w-auto max-w-full"
              />
            </div>
            <Watermark email={viewerEmail} />
          </div>

          {/* Action strip — placed UNDER the video, not floating in
              the header. Clear visual grouping with the player. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openNoteWithCurrentTime}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-bg shadow-md shadow-primary/20 transition-all hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" strokeWidth={2.5} />
              תיקון חדש
            </button>
            <button
              type="button"
              onClick={openNoteWithScreenshot}
              title="צלם פריים והוסף תיקון"
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-white/[0.06]"
            >
              <Camera className="h-4 w-4" />
              צלם + תיקון
            </button>
            <p className="ml-auto text-[11px] text-fg-muted/80">
              לחיצה על שעון בהערה קופצת לאותה נקודה בסרטון
            </p>
          </div>
        </div>

        {/* Notes sidebar */}
        <aside className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
          <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-3">
            <MessageSquare className="h-4 w-4 text-fg-muted" />
            <h2 className="text-sm font-medium text-fg">תיקונים</h2>
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-fg-muted">
              {notes.length}
            </span>
          </div>
          {notesLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />
            </div>
          ) : notes.length === 0 ? (
            <EmptyNotesState />
          ) : (
            <ul className="max-h-[calc(72vh-3rem)] space-y-2 overflow-y-auto pr-1">
              {[...notes]
                .sort((a, b) => a.timeSeconds - b.timeSeconds)
                .map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    onSeek={seekTo}
                    onExpandImage={(url) => setLightbox(url)}
                  />
                ))}
            </ul>
          )}
        </aside>
      </div>

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
        {lightbox && (
          <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />
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
    const targetW = Math.min(1280, video.videoWidth)
    const scale = targetW / video.videoWidth
    canvas.width = targetW
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.75)
  } catch (err) {
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
    <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.01] px-3 py-8 text-center">
      <MessageSquare className="mx-auto mb-2 h-5 w-5 text-fg-muted/60" />
      <p className="text-[11px] leading-relaxed text-fg-muted">
        עדיין אין תיקונים. עצרו את הסרטון ולחצו על
        <strong className="font-semibold text-fg/80"> "תיקון חדש" </strong>
        — הזמן ייכנס אוטומטית.
      </p>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Note item — compact card with small thumbnail. Clicking the
 *  thumb opens a lightbox; clicking the timestamp seeks the
 *  video. Layout uses a fixed 56px-wide thumb on the right (RTL)
 *  + flexible content area on the left.
 * ───────────────────────────────────────────────────────────── */
function NoteItem({
  note,
  onSeek,
  onExpandImage,
}: {
  note: Note
  onSeek: (t: number) => void
  onExpandImage: (url: string) => void
}) {
  const mm = Math.floor(note.timeSeconds / 60)
  const ss = Math.floor(note.timeSeconds % 60).toString().padStart(2, '0')
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 transition-colors hover:bg-white/[0.04]">
      <div className="flex gap-2.5">
        {note.screenshotDataUrl ? (
          <button
            type="button"
            onClick={() => onExpandImage(note.screenshotDataUrl!)}
            title="הגדלת התמונה"
            className="group/thumb relative shrink-0 overflow-hidden rounded-md border border-white/10 transition-transform hover:scale-[1.03]"
          >
            <img
              src={note.screenshotDataUrl}
              alt=""
              className="h-14 w-14 object-cover"
            />
            <div className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover/thumb:bg-black/20" />
          </button>
        ) : (
          <div
            aria-hidden
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-white/10 bg-white/[0.02] text-fg-muted/50"
          >
            <MessageSquare className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onSeek(note.timeSeconds)}
              title="קפיצה לזמן בסרטון"
              className="font-mono rounded px-1.5 py-0.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/10"
            >
              {mm}:{ss}
            </button>
            <span
              dir="ltr"
              className="truncate text-[10px] text-fg-muted/80"
              title={note.viewerEmail}
            >
              {note.viewerEmail}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg">
            {note.text}
          </p>
        </div>
      </div>
    </li>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Image lightbox — click-to-expand for note screenshots. Click
 *  outside the image or hit X to close. Esc support handled by
 *  the focus on the close button.
 * ───────────────────────────────────────────────────────────── */
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="סגירה"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      <motion.img
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.18 }}
        src={url}
        alt="צילום פריים מוגדל"
        className="max-h-[88vh] max-w-[92vw] rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </motion.div>
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
              className="max-h-64 w-full rounded-lg border border-white/10 object-contain bg-black/40"
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
