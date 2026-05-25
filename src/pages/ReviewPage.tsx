import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
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
  Hash,
  Trash2,
  CheckCircle2,
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
  roundNumber: number
  /** True when the editor closed the round to new feedback. The
   *  video + existing notes stay visible; the add-note buttons
   *  disappear and a friendly banner explains why. */
  locked: boolean
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
  | { kind: 'needs-password'; title?: string; roundNumber?: number }
  | { kind: 'needs-email'; title: string; roundNumber: number }
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
          | {
              ok: true
              needsPassword: true
              title: string
              roundNumber?: number
              locked?: boolean
            }
          | {
              ok: true
              needsPassword: false
              project: {
                title: string
                roundNumber?: number
                locked?: boolean
              }
            }
          | { ok: false; error: string }

        if (!json.ok) {
          setState({ kind: 'not-found', message: json.error || 'הקישור לא נמצא.' })
          return
        }
        if (json.needsPassword) {
          setState({
            kind: 'needs-password',
            title: json.title,
            roundNumber: json.roundNumber ?? 1,
          })
          return
        }
        const round = json.project.roundNumber ?? 1
        const locked = json.project.locked === true
        const storedEmail = localStorage.getItem(EMAIL_KEY_PREFIX + token)
        if (storedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(storedEmail)) {
          await loadStream(storedEmail, json.project.title, round, locked)
        } else {
          setState({
            kind: 'needs-email',
            title: json.project.title,
            roundNumber: round,
          })
        }
      } catch (err) {
        console.error('[review] load failed:', err)
        setState({
          kind: 'not-found',
          message: 'אירעה שגיאה בטעינת הפרויקט. נסו לרענן את הדף.',
        })
      }
    }

    async function loadStream(
      viewerEmail: string,
      title: string,
      roundNumber: number,
      locked: boolean,
    ) {
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
          roundNumber,
          locked,
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

  /** Submit a new note. The composer can supply an annotated version
   *  of the screenshot — drawn-on with the pen/arrow/rectangle tools
   *  — which we prefer over the original capture. Passing null means
   *  the viewer didn't add annotations, so we send the raw frame. */
  async function submitNote(finalScreenshotDataUrl: string | null) {
    if (!composer || !noteText.trim() || submitting) return
    const screenshotToSave = finalScreenshotDataUrl ?? composer.screenshotDataUrl
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
          screenshotDataUrl: screenshotToSave,
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
          screenshotDataUrl: screenshotToSave,
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

  /** Delete a note the current viewer authored. Server-side check
   *  enforces viewerEmail match — we don't trust the client to
   *  decide on its own (a stale localStorage could let someone
   *  click "מחיקה" on a stranger's note); we just hide the icon
   *  to make the surface obvious. Optimistic update: drop the
   *  note from local state immediately and roll back if the
   *  server complains. */
  async function deleteNote(noteId: string) {
    const previous = notes
    setNotes((prev) => prev.filter((n) => n.id !== noteId))
    try {
      const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
      const r = await fetch(`${API}?action=delete-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareToken: token,
          passwordToken,
          noteId,
          viewerEmail,
        }),
      })
      const json = (await r.json()) as { ok: boolean; error?: string }
      if (!json.ok) {
        // Roll back — show the note again so the viewer can see
        // their attempt didn't take.
        setNotes(previous)
        console.warn('[review] delete-note failed:', json.error)
      }
    } catch (err) {
      setNotes(previous)
      console.warn('[review] delete-note network failure:', err)
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">
      {/* Title row — round badge + project name. Badge first so the
          eye lands on "סבב N" before the title (the round is what
          tells the client whether they're looking at the latest
          version of the cut). */}
      <div className="mb-4 flex items-center gap-2.5 sm:mb-5">
        <span
          title={`סבב מספר ${project.roundNumber}`}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-primary/15 px-2 py-1 text-xs font-mono font-semibold text-primary"
        >
          <Hash className="h-3 w-3" />
          {project.roundNumber}
        </span>
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
              the header. When the editor locks the round we hide
              the add buttons and show a friendly banner instead, so
              the client knows the silence is intentional (editor is
              working on the changes) rather than a bug. */}
          {project.locked ? (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
              <Lock className="h-4 w-4 shrink-0" />
              <span>
                <strong className="font-semibold">הסבב נסגר לתיקונים.</strong>{' '}
                אתם עדיין יכולים לצפות בסרטון ובתיקונים הקודמים, אבל לא להוסיף חדשים.
              </span>
            </div>
          ) : (
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
          )}
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
                    // Hide the trash icon entirely when the project
                    // is locked — the server enforces the same rule
                    // but showing a button that always errors makes
                    // the UI feel broken. The "טופל" badge stays
                    // visible read-only.
                    isOwn={
                      !project.locked &&
                      (note.viewerEmail || '').toLowerCase() ===
                        viewerEmail.toLowerCase()
                    }
                    onSeek={seekTo}
                    onExpandImage={(url) => setLightbox(url)}
                    onDelete={() => deleteNote(note.id)}
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
  isOwn,
  onSeek,
  onExpandImage,
  onDelete,
}: {
  note: Note
  /** True when the current viewer's email matches the note's
   *  stored viewerEmail — controls whether the trash icon shows.
   *  Server still enforces the same check on delete-note. */
  isOwn: boolean
  onSeek: (t: number) => void
  onExpandImage: (url: string) => void
  onDelete: () => void
}) {
  const mm = Math.floor(note.timeSeconds / 60)
  const ss = Math.floor(note.timeSeconds % 60).toString().padStart(2, '0')
  // Two-step confirm — first click reveals "אישור / ביטול", second
  // click commits. Same pattern as the desktop ProjectCard. Inline
  // is a better fit than a modal for a sidebar full of small cards.
  const [confirming, setConfirming] = useState(false)
  const resolved = note.status === 'resolved'
  return (
    <li
      className={
        'group rounded-lg border p-2.5 transition-colors ' +
        (resolved
          ? 'border-success/20 bg-success/[0.04] hover:bg-success/[0.06]'
          : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]')
      }
    >
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
              className={
                'h-14 w-14 object-cover ' + (resolved ? 'opacity-60' : '')
              }
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
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSeek(note.timeSeconds)}
                title="קפיצה לזמן בסרטון"
                className={
                  'font-mono rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ' +
                  (resolved
                    ? 'text-success/70 hover:bg-success/10'
                    : 'text-primary hover:bg-primary/10')
                }
              >
                {mm}:{ss}
              </button>
              {/* Resolved badge — server-side status mirrors the
                  editor's "סמן כטופל" toggle. Shown to the viewer
                  read-only so they can see which of their notes
                  the editor has already worked on. */}
              {resolved && (
                <span
                  title="הסטודיו סימן את התיקון כטופל"
                  className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[9px] font-medium text-success"
                >
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  טופל
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <span
                dir="ltr"
                className="truncate text-[10px] text-fg-muted/80"
                title={note.viewerEmail}
              >
                {note.viewerEmail}
              </span>
              {/* Trash icon — visible only on the viewer's own notes.
                  Opacity transition on hover keeps the panel quiet
                  by default and surfaces the action when needed. */}
              {isOwn && !confirming && (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  aria-label="מחיקת התיקון"
                  title="מחיקת התיקון"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted/40 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <p
            className={
              'whitespace-pre-wrap break-words text-xs leading-relaxed ' +
              (resolved ? 'text-fg/60 line-through decoration-fg/30' : 'text-fg')
            }
          >
            {note.text}
          </p>
          {/* Confirm strip — appears below the text only when the
              viewer clicked the trash. Keeps the destructive flow
              from triggering on a single accidental click. */}
          {confirming && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5">
              <span className="text-[10px] text-destructive">
                למחוק את התיקון?
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false)
                    onDelete()
                  }}
                  className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] font-semibold text-destructive hover:bg-destructive/30"
                >
                  כן, מחק
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-white/5"
                >
                  ביטול
                </button>
              </div>
            </div>
          )}
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
  /** Receives the FINAL screenshot to save: the annotated version
   *  if the viewer drew anything, otherwise null (meaning "use the
   *  original capture"). Composer never modifies the original. */
  onSubmit: (finalScreenshotDataUrl: string | null) => void
  onClose: () => void
}) {
  const minutes = useMemo(() => Math.floor(timeSeconds / 60), [timeSeconds])
  const seconds = useMemo(
    () => Math.floor(timeSeconds % 60).toString().padStart(2, '0'),
    [timeSeconds],
  )

  // The annotation canvas reports its baked dataURL up to here on
  // each stroke commit. We stash it and forward it when the viewer
  // hits Send. null = no annotations drawn yet (or all undone) →
  // parent will fall back to the original screenshot.
  const [annotatedDataUrl, setAnnotatedDataUrl] = useState<string | null>(null)
  const handleAnnotationChange = useCallback(
    (url: string | null) => setAnnotatedDataUrl(url),
    [],
  )

  // Wider modal when there's a screenshot — the annotation canvas
  // needs room to breathe. Text-only stays narrow (max-w-lg) so
  // the composer feels lightweight.
  const widthClass = screenshotDataUrl ? 'max-w-2xl' : 'max-w-lg'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 py-6 overflow-y-auto"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={{ duration: 0.18 }}
        className={`w-full ${widthClass} overflow-hidden rounded-2xl border border-white/10 bg-bg shadow-2xl my-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <div>
            <h3 className="text-sm font-medium text-fg">תיקון חדש</h3>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              בנקודה <span dir="ltr" className="font-mono">{minutes}:{seconds}</span>
              {screenshotDataUrl && (
                <span className="ms-2 text-fg-muted/70">
                  · ניתן לסמן על התמונה למטה
                </span>
              )}
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
            <AnnotationCanvas
              imageUrl={screenshotDataUrl}
              onChange={handleAnnotationChange}
            />
          )}
          <div>
            <label className="mb-1.5 block text-[11px] text-fg-muted">
              מה צריך לתקן?
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus={!screenshotDataUrl}
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
            onClick={() => onSubmit(annotatedDataUrl)}
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
