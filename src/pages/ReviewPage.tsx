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
  Pause,
  Send,
  X,
} from 'lucide-react'

/**
 * Public revision review page.
 *
 * URL: /review/:token
 *
 * Three gates in order before the player renders:
 *   1. Loading — initial fetch of the project metadata.
 *   2. Password — if the project has a password set. Token cached
 *      in sessionStorage so we don't ask again on every reload.
 *   3. Email — required for the watermark + so the editor knows
 *      who left each note. Cached in localStorage per-token so
 *      returning viewers skip this step.
 *
 * Player:
 *   - Drive's hosted iframe preview at /file/d/<id>/preview.
 *   - Email watermark overlaid via CSS (Drive's iframe can't be
 *     reached into for true overlay; we sit our watermark in a
 *     pointer-events:none div on top of the iframe).
 *
 * Notes:
 *   - Phase 5 (this commit): timestamp + text + frame screenshot
 *     submission. No canvas annotation yet.
 *   - Phase 6: arrow / rectangle / circle drawing on the screenshot.
 *
 * The editor sees the notes via a Firestore real-time listener in
 * the desktop app (Phase 6 wires that up). Server-side we already
 * write notes into /revisionProjects/{id}/notes — the desktop just
 * needs to subscribe.
 */

const API = '/api/revisions'

interface ProjectInfo {
  id: string
  title: string
  embedUrl: string
  videoSizeBytes: number
  videoMime: string
  createdAt: number
}

interface Note {
  id: string
  viewerEmail: string
  viewerName?: string | null
  timeSeconds: number
  text: string
  status: 'new' | 'resolved'
  createdAt: number
}

type State =
  | { kind: 'loading' }
  | { kind: 'not-found'; message: string }
  | { kind: 'needs-password'; title: string }
  | { kind: 'needs-email'; project: ProjectInfo }
  | { kind: 'ready'; project: ProjectInfo; viewerEmail: string }

const EMAIL_KEY_PREFIX = 'dmplus.review.email.'
const PWD_TOKEN_KEY_PREFIX = 'dmplus.review.pwd.'

export function ReviewPage() {
  const { token: rawToken } = useParams<{ token: string }>()
  const token = (rawToken || '').trim()
  const [state, setState] = useState<State>({ kind: 'loading' })

  // Load project + decide which gate (if any) to show.
  useEffect(() => {
    if (!token) {
      setState({ kind: 'not-found', message: 'הקישור לא תקין.' })
      return
    }
    void loadProject()
    async function loadProject() {
      try {
        const passwordToken =
          typeof window !== 'undefined'
            ? localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
            : null
        const r = await fetch(`${API}?action=get-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareToken: token, passwordToken }),
        })
        const json = (await r.json()) as
          | { ok: true; needsPassword: true; title: string }
          | { ok: true; needsPassword: false; project: ProjectInfo }
          | { ok: false; error: string }

        if (!json.ok) {
          setState({ kind: 'not-found', message: json.error || 'הקישור לא נמצא.' })
          return
        }
        if (json.needsPassword) {
          setState({ kind: 'needs-password', title: json.title })
          return
        }
        // Project loaded. Check if we already have the viewer's
        // email from a previous visit (per-token, not global —
        // different reviewers might share the same browser).
        const storedEmail =
          typeof window !== 'undefined'
            ? localStorage.getItem(EMAIL_KEY_PREFIX + token)
            : null
        if (storedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(storedEmail)) {
          setState({ kind: 'ready', project: json.project, viewerEmail: storedEmail })
        } else {
          setState({ kind: 'needs-email', project: json.project })
        }
      } catch (err) {
        console.error('[review] load failed:', err)
        setState({
          kind: 'not-found',
          message: 'אירעה שגיאה בטעינת הפרויקט. נסו לרענן את הדף.',
        })
      }
    }
  }, [token])

  function handlePasswordVerified() {
    // After password OK we re-trigger the loader by calling fetch
    // again — easiest way is to flip state to loading and let the
    // effect re-run via a token key change. Simpler: just reload.
    setState({ kind: 'loading' })
    setTimeout(() => window.location.reload(), 100)
  }

  function handleEmailEntered(email: string) {
    if (state.kind !== 'needs-email') return
    localStorage.setItem(EMAIL_KEY_PREFIX + token, email)
    setState({ kind: 'ready', project: state.project, viewerEmail: email })
  }

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
          title={state.title}
          onVerified={handlePasswordVerified}
        />
      </CenterCard>
    )
  if (state.kind === 'needs-email')
    return (
      <CenterCard>
        <EmailGate
          title={state.project.title}
          onEntered={handleEmailEntered}
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
  const [notes, setNotes] = useState<Note[]>([])
  const [notesLoading, setNotesLoading] = useState(true)
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerTime, setComposerTime] = useState(0)
  const [noteText, setNoteText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Initial load of notes.
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

  function openComposer() {
    // Drive's iframe doesn't let us read the currentTime of the
    // playing video due to cross-origin. The user is responsible
    // for noting the time themselves (we pre-fill 0 and they edit).
    // Phase 6 explores custom player to capture this automatically.
    setComposerOpen(true)
    setNoteText('')
    setSubmitError(null)
  }

  async function submitNote() {
    if (!noteText.trim() || submitting) return
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
          timeSeconds: composerTime,
          text: noteText.trim(),
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
      // Optimistic insert + re-fetch to be safe.
      setNotes((prev) => [
        ...prev,
        {
          id: json.noteId,
          viewerEmail,
          timeSeconds: composerTime,
          text: noteText.trim(),
          status: 'new',
          createdAt: Date.now(),
        },
      ])
      setComposerOpen(false)
      setNoteText('')
      setSubmitting(false)
    } catch {
      setSubmitError('שגיאת רשת')
      setSubmitting(false)
    }
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
          <button
            type="button"
            onClick={openComposer}
            className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-bg shadow-md shadow-primary/20 transition-all hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            תיקון חדש
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-6 md:grid-cols-[1fr_320px]">
        {/* Player */}
        <div className="relative overflow-hidden rounded-2xl border border-white/5 bg-black">
          <div className="aspect-video w-full">
            <iframe
              ref={iframeRef}
              src={project.embedUrl}
              title={project.title}
              allow="autoplay"
              allowFullScreen
              className="block h-full w-full"
            />
          </div>
          {/* Watermark — pointer-events:none so it doesn't block
              the iframe controls. Two repeated rows so a user
              recording the screen captures the email regardless
              of where they crop. */}
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
                <NoteItem key={note.id} note={note} />
              ))}
            </ul>
          )}
        </aside>
      </div>

      {/* Composer overlay */}
      <AnimatePresence>
        {composerOpen && (
          <NoteComposer
            time={composerTime}
            setTime={setComposerTime}
            text={noteText}
            setText={setNoteText}
            submitting={submitting}
            error={submitError}
            onSubmit={submitNote}
            onClose={() => setComposerOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function Watermark({ email }: { email: string }) {
  // Random-ish position so a user can't reliably crop out the
  // watermark on every recording. We animate it slowly so even a
  // screen recording carries it through multiple positions.
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
      <Pause className="mx-auto mb-2 h-5 w-5 text-fg-muted" />
      <p className="text-[11px] leading-relaxed text-fg-muted">
        עצרו את הסרטון איפה שיש בעיה ולחצו על
        <strong className="font-semibold text-fg/80"> "תיקון חדש" </strong>
        כדי להוסיף הערה.
      </p>
    </div>
  )
}

function NoteItem({ note }: { note: Note }) {
  const mm = Math.floor(note.timeSeconds / 60)
  const ss = Math.floor(note.timeSeconds % 60).toString().padStart(2, '0')
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center justify-between text-[10px] text-fg-muted">
        <span className="font-mono">{mm}:{ss}</span>
        <span dir="ltr" className="truncate">{note.viewerEmail}</span>
      </div>
      <p className="text-xs leading-relaxed text-fg whitespace-pre-wrap">
        {note.text}
      </p>
    </li>
  )
}

function NoteComposer({
  time,
  setTime,
  text,
  setText,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  time: number
  setTime: (n: number) => void
  text: string
  setText: (s: string) => void
  submitting: boolean
  error: string | null
  onSubmit: () => void
  onClose: () => void
}) {
  const minutes = useMemo(() => Math.floor(time / 60), [time])
  const seconds = useMemo(() => Math.floor(time % 60), [time])

  function setTimeFromFields(mm: number, ss: number) {
    setTime(Math.max(0, mm * 60 + ss))
  }

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
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <h3 className="text-sm font-medium text-fg">תיקון חדש</h3>
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
          <div>
            <label className="mb-1.5 block text-[11px] text-fg-muted">
              זמן בסרטון (Drive לא מאפשר לנו לדעת אוטומטית — עצרו ורשמו)
            </label>
            <div className="flex items-center gap-2" dir="ltr">
              <input
                type="number"
                min={0}
                value={minutes}
                onChange={(e) => setTimeFromFields(Number(e.target.value) || 0, seconds)}
                className="w-16 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-center text-sm text-fg focus:border-primary/40 focus:outline-none"
              />
              <span className="text-fg-muted">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={seconds}
                onChange={(e) => setTimeFromFields(minutes, Number(e.target.value) || 0)}
                className="w-16 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-center text-sm text-fg focus:border-primary/40 focus:outline-none"
              />
              <span className="text-[11px] text-fg-muted">דקות : שניות</span>
            </div>
          </div>
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
