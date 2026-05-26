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
  Mic,
  Square,
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
  /** Number = pinned to this moment in the video. null/undefined =
   *  general note not tied to any specific timestamp. The "+ הערה
   *  כללית" button creates one of these. */
  timeSeconds: number | null
  text: string
  /** Legacy: base64 data URL stored directly in the note doc.
   *  Pre-Drive-migration notes still come down with this field set.
   *  New notes ship with screenshotDriveFileId instead, and the
   *  renderer falls back to whichever is present. */
  screenshotDataUrl?: string | null
  /** Drive file ID of the screenshot (post-migration storage). */
  screenshotDriveFileId?: string | null
  /** Drive file ID of the voice recording attached to this note. */
  audioDriveFileId?: string | null
  status: 'new' | 'resolved' | 'question' | 'not-possible'
  /** Editor's text response — populated when status is 'question'
   *  (the clarifying question) or 'not-possible' (why it can't be
   *  done). Cleared when status moves back to new/resolved. */
  editorResponse?: string | null
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

/** Strip the `data:<mime>;base64,` prefix off a data URL so we can
 *  send just the base64 payload to upload-note-media. The server
 *  rebuilds the buffer from the raw bytes. */
function stripDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  return { mime: m[1], base64: m[2] }
}

/** Read a Blob into base64 (without the data: prefix). MediaRecorder
 *  hands us a Blob for audio; the only way to send it as JSON to the
 *  upload endpoint is to base64-encode the bytes. */
async function blobToBase64(blob: Blob): Promise<string> {
  const arr = new Uint8Array(await blob.arrayBuffer())
  // btoa needs a binary string. Chunk to avoid stack overflow on
  // large blobs (>~125 KB) — String.fromCharCode(...arr) blows up
  // with "Maximum call stack size exceeded" past a few hundred KB.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** POST a media blob/data-URL to upload-note-media. Returns the
 *  Drive fileId the server stored it under. */
async function uploadNoteMedia(
  shareToken: string,
  passwordToken: string | null,
  kind: 'image' | 'audio',
  mimeType: string,
  base64: string,
): Promise<string> {
  const r = await fetch(`${API}?action=upload-note-media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shareToken,
      passwordToken,
      kind,
      mimeType,
      dataBase64: base64,
    }),
  })
  const json = (await r.json()) as
    | { ok: true; driveFileId: string; mimeType: string }
    | { ok: false; error: string }
  if (!json.ok) throw new Error(json.error || 'העלאה נכשלה')
  return json.driveFileId
}

/** Build a URL the browser can use to fetch a note's media. Goes
 *  through the Vercel proxy which re-auths server-side per request
 *  (the file itself is private to the editor's Drive). */
function noteMediaUrl(
  shareToken: string,
  noteId: string,
  kind: 'image' | 'audio',
  passwordToken: string | null,
): string {
  const params = new URLSearchParams({
    action: 'note-media',
    token: shareToken,
    note: noteId,
    kind,
  })
  if (passwordToken) params.set('t', passwordToken)
  return `${API}?${params.toString()}`
}
/** localStorage flag — true once the viewer has seen the "how this
 *  works" onboarding for this specific share token + viewer email.
 *  We don't show it again on subsequent visits because the second
 *  time the viewer already knows the drill. Per-token so different
 *  reviewers (sharing the same browser) each get the explainer once
 *  on their first project. */
const ONBOARDED_KEY_PREFIX = 'dmplus.review.onboarded.'

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
      <ReadyOrOnboarding
        token={token}
        project={state.project}
        viewerEmail={state.viewerEmail}
      />
    </ReviewShell>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Onboarding gate — shown ONCE per (token, viewer) pair on the
 *  first visit. The workspace itself is intuitive once you know
 *  the buttons, but the first-time viewer has no idea what's
 *  expected of them — many clients have never used a review tool
 *  before. The explainer cuts the "wait what does this do" round-
 *  trip with the editor entirely.
 * ───────────────────────────────────────────────────────────── */
function ReadyOrOnboarding({
  token,
  project,
  viewerEmail,
}: {
  token: string
  project: ProjectInfo
  viewerEmail: string
}) {
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem(ONBOARDED_KEY_PREFIX + token) === 'true'
      )
    } catch {
      return false
    }
  })

  if (!onboarded) {
    return (
      <OnboardingScreen
        projectTitle={project.title}
        roundNumber={project.roundNumber}
        locked={project.locked}
        onContinue={() => {
          try {
            localStorage.setItem(ONBOARDED_KEY_PREFIX + token, 'true')
          } catch {
            // ignore — quota / private browsing
          }
          setOnboarded(true)
        }}
      />
    )
  }

  return (
    <ReviewWorkspace
      token={token}
      project={project}
      viewerEmail={viewerEmail}
    />
  )
}

function OnboardingScreen({
  projectTitle,
  roundNumber,
  locked,
  onContinue,
}: {
  projectTitle: string
  roundNumber: number
  locked: boolean
  onContinue: () => void
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="space-y-6"
      >
        {/* Header */}
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-[10px] font-mono font-semibold text-primary">
            <Hash className="h-3 w-3" />
            סבב {roundNumber}
          </div>
          <h1 className="text-2xl font-medium tracking-tight text-fg sm:text-3xl">
            ברוכים הבאים לסבב התיקונים
          </h1>
          <p
            className="mt-1 truncate text-sm text-fg-muted"
            title={projectTitle}
          >
            {projectTitle}
          </p>
        </div>

        {/* Steps card */}
        <div className="space-y-3 rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <h2 className="mb-1 text-sm font-medium text-fg">
            איך זה עובד —
          </h2>
          <Step
            number="1"
            title="צפו בסרטון"
            body="הסרטון יתנגן בעמוד. עוצרים אותו בכל רגע שיש משהו לתקן."
          />
          <Step
            number="2"
            title="הוסיפו תיקון"
            body={
              <>
                שני כפתורים מתחת לסרטון:
                <br />
                <strong className="font-semibold text-fg/90">
                  • תיקון חדש
                </strong>{' '}
                — סתם להכניס הערה בטקסט.
                <br />
                <strong className="font-semibold text-fg/90">
                  • צלם + תיקון
                </strong>{' '}
                — צילום של הקטע מהסרטון + אופציה לסמן על ידי ציור את התיקון.
                <br />
                בשני המקרים — הזמן בסרטון נשמר אוטומטית.
              </>
            }
          />
          <Step
            number="3"
            title="כל תיקון מקושר לרגע בסרטון"
            body="לחיצה על השעון של כל תיקון תקפיץ אותך לאותו רגע בדיוק. ככה אפשר לעבור על כל ההערות בסדר נכון."
          />
          <Step
            number="4"
            title="העורך רואה הכל בזמן אמת"
            body={
              <>
                התיקונים שלכם מופיעים אצל העורך באופן אוטומטי. כשהטיפול
                בתיקון מסויים יסתיים תראו ליד התיקון אחת משלוש תוויות:
                <br />
                <span className="mt-1 inline-flex items-center gap-0.5 rounded bg-success/15 px-1 py-0 text-[10px] font-medium text-success">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  טופל
                </span>{' '}
                — התיקון נכנס לסרטון.
                <br />
                <span className="mt-1 inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1 py-0 text-[10px] font-medium text-sky-400">
                  <MessageSquare className="h-2.5 w-2.5" />
                  שאלה
                </span>{' '}
                — העורך לא בטוח מה התכוונתם, ויראה לכם שאלה ליד.
                <br />
                <span className="mt-1 inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0 text-[10px] font-medium text-amber-400">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  לא אפשרי
                </span>{' '}
                — אי אפשר לבצע את התיקון, והעורך יסביר למה ליד.
              </>
            }
          />
        </div>

        {/* Locked notice — only when relevant. The viewer arriving
            on a locked round needs to understand BEFORE going in why
            they can't add notes, otherwise they'll think the page is
            broken. */}
        {locked && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              הסבב הזה <strong className="font-semibold">סגור לתיקונים</strong>.
              אתם תוכלו לראות את הסרטון ואת התיקונים הקודמים, אבל לא להוסיף
              חדשים.
            </span>
          </div>
        )}

        {/* Continue CTA */}
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-bg shadow-md shadow-primary/20 transition-all hover:bg-primary/90 sm:w-auto"
        >
          הבנתי, בואו נתחיל
          <ArrowUpLeft className="h-4 w-4" />
        </button>
      </motion.div>
    </div>
  )
}

function Step({
  number,
  title,
  body,
}: {
  number: string
  title: string
  body: React.ReactNode
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-white/5 bg-white/[0.015] p-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-fg">{title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
          {body}
        </div>
      </div>
    </div>
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
  /** Fetch the canonical note list from the server. Lifted out of
   *  the initial-load useEffect so submitNote / deleteNote can call
   *  it for a post-write sync, ensuring viewers see exactly what
   *  the server stored (with the real server-generated noteId, any
   *  concurrent notes from other reviewers, etc.) rather than only
   *  the optimistic local copy. */
  const refreshNotes = useCallback(
    async (opts: { showSpinner?: boolean } = {}): Promise<void> => {
      if (opts.showSpinner) setNotesLoading(true)
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
        if (opts.showSpinner) setNotesLoading(false)
      }
    },
    [token],
  )
  useEffect(() => {
    void refreshNotes({ showSpinner: true })
  }, [refreshNotes])

  const videoRef = useRef<HTMLVideoElement>(null)

  const [composer, setComposer] = useState<
    | null
    | {
        /** null = general note not tied to a specific moment. Number
         *  = pinned to that second in the video. */
        timeSeconds: number | null
        /** Captured frame as a data URL — null if the viewer opened
         *  the composer via "תיקון חדש" (text-only) or "הקלט קול". */
        screenshotDataUrl: string | null
        /** Recorded voice memo. Null until the user actually records.
         *  Either or both of screenshot/audio can be present alongside
         *  the required text. */
        audioBlob: Blob | null
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
      audioBlob: null,
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
      audioBlob: null,
    })
    setNoteText('')
    setSubmitError(null)
  }

  /** Open the composer for a "general" note — one that isn't pinned
   *  to a specific moment in the video. Useful when the feedback is
   *  about the cut overall ("the music is too loud throughout",
   *  "could you add a brand logo at the end"), not a specific frame.
   *  We don't pause the video here — the viewer isn't reacting to
   *  what they're watching, so interrupting playback would be rude. */
  function openGeneralNote() {
    setComposer({
      timeSeconds: null,
      screenshotDataUrl: null,
      audioBlob: null,
    })
    setNoteText('')
    setSubmitError(null)
  }

  /** Submit a new note. The composer can carry up to two media
   *  attachments — an (optionally annotated) screenshot and a voice
   *  recording — both of which are uploaded to the editor's Drive
   *  BEFORE the note doc itself is created. The note ends up storing
   *  only Drive fileIds, never the raw bytes; that way the user's
   *  storage constraint ("everything in Drive") is satisfied, and
   *  Firestore's 1 MB doc limit isn't a factor on note size.
   *
   *  finalScreenshotDataUrl: if the AnnotationCanvas drew on top of
   *  the captured frame, this is the baked-in final image. Falls
   *  back to the raw capture if the viewer skipped annotation. */
  async function submitNote(finalScreenshotDataUrl: string | null) {
    if (!composer || submitting) return
    const text = noteText.trim()
    const screenshotToSave =
      finalScreenshotDataUrl ?? composer.screenshotDataUrl
    const audioBlob = composer.audioBlob
    // Require at least one of: text, screenshot, audio. Server also
    // enforces this but rejecting early avoids a wasted upload.
    if (!text && !screenshotToSave && !audioBlob) {
      setSubmitError('חובה לכתוב, לצרף תמונה או להקליט')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)

      // ── Phase 1: upload media to Drive ──
      // Done sequentially because each call hits the editor's
      // refresh-token rotation; parallel calls would race on token
      // refresh and waste quota.
      let screenshotDriveFileId: string | null = null
      let audioDriveFileId: string | null = null
      if (screenshotToSave) {
        const parsed = stripDataUrl(screenshotToSave)
        if (parsed) {
          screenshotDriveFileId = await uploadNoteMedia(
            token,
            passwordToken,
            'image',
            parsed.mime,
            parsed.base64,
          )
        }
      }
      if (audioBlob) {
        const base64 = await blobToBase64(audioBlob)
        audioDriveFileId = await uploadNoteMedia(
          token,
          passwordToken,
          'audio',
          audioBlob.type || 'audio/webm',
          base64,
        )
      }

      // ── Phase 2: create the note pointing at the fileIds ──
      const r = await fetch(`${API}?action=add-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareToken: token,
          passwordToken,
          viewerEmail,
          timeSeconds: composer.timeSeconds,
          text,
          screenshotDriveFileId,
          audioDriveFileId,
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
      // Optimistic insert — the viewer sees their note appear before
      // the network round-trip below completes, so the submit feels
      // instant. Then refreshNotes() pulls the canonical list which
      // overwrites this entry with the server's stored copy +
      // catches anything new other reviewers added in the meantime.
      setNotes((prev) => [
        ...prev,
        {
          id: json.noteId,
          viewerEmail,
          timeSeconds: composer.timeSeconds,
          text,
          screenshotDriveFileId,
          audioDriveFileId,
          status: 'new',
          createdAt: Date.now(),
        },
      ])
      setComposer(null)
      setNoteText('')
      setSubmitting(false)
      // Fire-and-forget — already showed the optimistic version,
      // any drift gets reconciled when this resolves.
      void refreshNotes()
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'שגיאת רשת',
      )
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
              <button
                type="button"
                onClick={openGeneralNote}
                title="הערה לא קשורה לזמן ספציפי בסרטון"
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-white/[0.06]"
              >
                <MessageSquare className="h-4 w-4" />
                הערה כללית
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
            // Custom thin scrollbar — the default WebKit chrome is a
            // chunky grey strip that looks out of place against the
            // dark UI. The arbitrary [&::-webkit-scrollbar*] classes
            // target the WebKit pseudo-elements directly so we don't
            // need a Tailwind plugin or a global stylesheet. Firefox
            // uses the [scrollbar-*] properties on the element itself.
            <ul
              className="max-h-[calc(72vh-3rem)] space-y-2 overflow-y-auto pr-1
                         [scrollbar-color:rgba(255,255,255,0.12)_transparent]
                         [scrollbar-width:thin]
                         [&::-webkit-scrollbar]:w-1.5
                         [&::-webkit-scrollbar-track]:bg-transparent
                         [&::-webkit-scrollbar-thumb]:rounded-full
                         [&::-webkit-scrollbar-thumb]:bg-white/10
                         [&::-webkit-scrollbar-thumb:hover]:bg-white/25"
            >
              {[...notes]
                // Sort general notes first (they apply to the cut
                // as a whole, so they belong at the top of the list
                // — viewers scanning notes will see "high-level
                // feedback" before "this specific frame"). Within
                // each group, ascending by timestamp.
                .sort((a, b) => {
                  const aGeneral = a.timeSeconds === null || a.timeSeconds === undefined
                  const bGeneral = b.timeSeconds === null || b.timeSeconds === undefined
                  if (aGeneral && !bGeneral) return -1
                  if (!aGeneral && bGeneral) return 1
                  return (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0)
                })
                .map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    shareToken={token}
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
            audioBlob={composer.audioBlob}
            setAudioBlob={(audioBlob) =>
              setComposer((c) => (c ? { ...c, audioBlob } : c))
            }
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
  shareToken,
  onSeek,
  onExpandImage,
  onDelete,
}: {
  note: Note
  /** True when the current viewer's email matches the note's
   *  stored viewerEmail — controls whether the trash icon shows.
   *  Server still enforces the same check on delete-note. */
  isOwn: boolean
  /** Needed to build Drive-media URLs for screenshot + audio. */
  shareToken: string
  onSeek: (t: number) => void
  onExpandImage: (url: string) => void
  onDelete: () => void
}) {
  const isGeneral = note.timeSeconds === null || note.timeSeconds === undefined
  const mm = isGeneral ? 0 : Math.floor((note.timeSeconds as number) / 60)
  const ss = isGeneral
    ? '00'
    : Math.floor((note.timeSeconds as number) % 60).toString().padStart(2, '0')
  // Two-step confirm — first click reveals "אישור / ביטול", second
  // click commits. Same pattern as the desktop ProjectCard. Inline
  // is a better fit than a modal for a sidebar full of small cards.
  const [confirming, setConfirming] = useState(false)
  const resolved = note.status === 'resolved'
  const isQuestion = note.status === 'question'
  const isNotPossible = note.status === 'not-possible'

  // Resolve the screenshot URL — prefer the Drive-backed proxy URL
  // for new notes; fall back to the inline data URL for legacy notes
  // created before the Drive migration. Both display the same way.
  const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + shareToken)
  const screenshotUrl = note.screenshotDriveFileId
    ? noteMediaUrl(shareToken, note.id, 'image', passwordToken)
    : note.screenshotDataUrl || null
  const audioUrl = note.audioDriveFileId
    ? noteMediaUrl(shareToken, note.id, 'audio', passwordToken)
    : null

  // Border + bg color per status — picked so the four states are
  // distinguishable at a glance when scrolling a long list.
  const containerClass = resolved
    ? 'border-success/20 bg-success/[0.04] hover:bg-success/[0.06]'
    : isQuestion
      ? 'border-sky-500/20 bg-sky-500/[0.04] hover:bg-sky-500/[0.06]'
      : isNotPossible
        ? 'border-amber-500/20 bg-amber-500/[0.04] hover:bg-amber-500/[0.06]'
        : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'

  return (
    <li
      className={
        'group rounded-lg border p-2.5 transition-colors ' + containerClass
      }
    >
      <div className="flex gap-2.5">
        {screenshotUrl ? (
          <button
            type="button"
            onClick={() => onExpandImage(screenshotUrl)}
            title="הגדלת התמונה"
            className="group/thumb relative shrink-0 overflow-hidden rounded-md border border-white/10 transition-transform hover:scale-[1.03]"
          >
            <img
              src={screenshotUrl}
              alt=""
              className={
                'h-14 w-14 object-cover ' + (resolved ? 'opacity-60' : '')
              }
            />
            <div className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover/thumb:bg-black/20" />
          </button>
        ) : audioUrl ? (
          <div
            aria-hidden
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/5 text-primary/70"
          >
            <Mic className="h-5 w-5" />
          </div>
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
              {isGeneral ? (
                // General notes have no associated time — render a
                // static "כללי" pill so the viewer knows the comment
                // applies to the cut as a whole, not a specific
                // moment. Not clickable because there's nowhere to
                // seek to.
                <span
                  title="הערה כללית — לא מקושרת לזמן ספציפי בסרטון"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-fg-muted/80"
                >
                  <MessageSquare className="h-2.5 w-2.5" />
                  כללי
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSeek(note.timeSeconds as number)}
                  title="קפיצה לזמן בסרטון"
                  className={
                    'font-mono rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ' +
                    (resolved
                      ? 'text-success/70 hover:bg-success/10'
                      : isQuestion
                        ? 'text-sky-400 hover:bg-sky-500/10'
                        : isNotPossible
                          ? 'text-amber-400 hover:bg-amber-500/10'
                          : 'text-primary hover:bg-primary/10')
                  }
                >
                  {mm}:{ss}
                </button>
              )}
              {/* Status badge — three colours for three editor
                  responses. Shown read-only; viewers can't change
                  status (that's the editor's workflow). */}
              {resolved && (
                <span
                  title="הסטודיו סימן את התיקון כטופל"
                  className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[9px] font-medium text-success"
                >
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  טופל
                </span>
              )}
              {isQuestion && (
                <span
                  title="העורך מבקש הבהרה — ראו את הטקסט בתוך התיקון"
                  className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-400"
                >
                  <MessageSquare className="h-2.5 w-2.5" />
                  שאלה
                </span>
              )}
              {isNotPossible && (
                <span
                  title="העורך הסביר למה לא ניתן לבצע — ראו את הטקסט בתוך התיקון"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  לא אפשרי
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
          {note.text && (
            <p
              className={
                'whitespace-pre-wrap break-words text-xs leading-relaxed ' +
                (resolved ? 'text-fg/60 line-through decoration-fg/30' : 'text-fg')
              }
            >
              {note.text}
            </p>
          )}
          {audioUrl && (
            <audio
              controls
              src={audioUrl}
              preload="metadata"
              className={
                'mt-1.5 block h-8 w-full rounded-md ' +
                (resolved ? 'opacity-60' : '')
              }
            />
          )}
          {/* Editor response — the question or "can't do" reason.
              Sits visually distinct from the original note text
              (light border + label) so the viewer immediately sees
              this is the editor talking back, not their own copy. */}
          {note.editorResponse && (isQuestion || isNotPossible) && (
            <div
              className={
                'mt-2 rounded-md border-r-2 px-2 py-1.5 text-[11px] leading-relaxed ' +
                (isQuestion
                  ? 'border-sky-500/60 bg-sky-500/[0.04] text-sky-100/90'
                  : 'border-amber-500/60 bg-amber-500/[0.04] text-amber-100/90')
              }
            >
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide opacity-70">
                {isQuestion ? 'שאלה מהעורך' : 'תגובת העורך'}
              </div>
              <div className="whitespace-pre-wrap break-words">
                {note.editorResponse}
              </div>
            </div>
          )}
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
  audioBlob,
  setAudioBlob,
  text,
  setText,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  /** null = general note (not tied to a moment); number = pinned. */
  timeSeconds: number | null
  screenshotDataUrl: string | null
  audioBlob: Blob | null
  setAudioBlob: (b: Blob | null) => void
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
  const isGeneral = timeSeconds === null
  const minutes = useMemo(
    () => (isGeneral ? 0 : Math.floor(timeSeconds! / 60)),
    [timeSeconds, isGeneral],
  )
  const seconds = useMemo(
    () =>
      isGeneral
        ? '00'
        : Math.floor(timeSeconds! % 60)
            .toString()
            .padStart(2, '0'),
    [timeSeconds, isGeneral],
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
            <h3 className="text-sm font-medium text-fg">
              {isGeneral ? 'הערה כללית' : 'תיקון חדש'}
            </h3>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              {isGeneral ? (
                <>הערה לסבב כולו, לא לרגע ספציפי בסרטון</>
              ) : (
                <>
                  בנקודה{' '}
                  <span dir="ltr" className="font-mono">
                    {minutes}:{seconds}
                  </span>
                  {screenshotDataUrl && (
                    <span className="ms-2 text-fg-muted/70">
                      · ניתן לסמן על התמונה למטה
                    </span>
                  )}
                </>
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
              placeholder="לדוגמה: צבע הירק לא מתאים, להוריד את הווליום של המוזיקה ברקע... (אפשר גם להקליט הסבר קולי למטה)"
              className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <AudioRecorder
            blob={audioBlob}
            onChange={setAudioBlob}
            disabled={submitting}
          />
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
            // Allow submit when ANY of: text, screenshot (always
            // present if composer opened via "צלם") or audio is
            // provided. Server enforces the same rule but this gives
            // immediate feedback in the disabled state.
            disabled={
              submitting ||
              (!text.trim() && !screenshotDataUrl && !audioBlob)
            }
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

/* ─────────────────────────────────────────────────────────────
 *  AudioRecorder — capture a voice memo via MediaRecorder.
 *
 *  Three visual states:
 *    1. Idle: a single "🎙 הקלט הסבר קולי" button.
 *    2. Recording: red pulsing indicator + elapsed seconds + stop
 *       button. Auto-stops at MAX_SECONDS so we never produce a
 *       blob bigger than the server upload cap (~5 MB).
 *    3. Done: <audio controls> preview + delete (×) button.
 *
 *  Uses webm/opus on Chrome/Firefox/Edge (~24 KB/sec) and falls
 *  back to whatever MediaRecorder defaults to on Safari (usually
 *  audio/mp4). Both play back via <audio> on every modern browser.
 *
 *  Permission denial / no-microphone gracefully degrades — we show
 *  an explanatory error instead of crashing the composer.
 * ───────────────────────────────────────────────────────────── */
const AUDIO_MAX_SECONDS = 90

function AudioRecorder({
  blob,
  onChange,
  disabled,
}: {
  blob: Blob | null
  onChange: (b: Blob | null) => void
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'error'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Memoize the playback URL so the <audio> tag doesn't re-fetch
  // (and re-create the blob URL) on every render — and revoke it
  // when the blob is cleared so we don't leak memory.
  const previewUrl = useMemo(
    () => (blob ? URL.createObjectURL(blob) : null),
    [blob],
  )
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  // Always tear down the stream + interval on unmount so the mic
  // doesn't stay "in use" if the user closes the composer mid-
  // recording.
  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.state === 'recording' &&
          recorderRef.current.stop()
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [])

  async function start() {
    if (disabled || state === 'recording') return
    setErrMsg(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      // Let MediaRecorder pick the best mime; Chrome → webm/opus,
      // Safari → audio/mp4. The blob.type ends up reflecting what
      // was actually used, which we pass to the server so it stores
      // the correct extension in Drive.
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        const mimeType = rec.mimeType || 'audio/webm'
        const out = new Blob(chunksRef.current, { type: mimeType })
        onChange(out)
        // Release the mic AFTER the blob is assembled — stopping the
        // tracks before onstop fires can drop the trailing buffer on
        // some browsers.
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        setState('idle')
        setElapsed(0)
        if (tickRef.current) {
          clearInterval(tickRef.current)
          tickRef.current = null
        }
      }
      recorderRef.current = rec
      rec.start()
      setState('recording')
      const startedAt = Date.now()
      tickRef.current = setInterval(() => {
        const e = Math.floor((Date.now() - startedAt) / 1000)
        setElapsed(e)
        if (e >= AUDIO_MAX_SECONDS) stop()
      }, 200)
    } catch (err) {
      console.error('[recorder] getUserMedia failed:', err)
      setErrMsg('לא הצלחנו לגשת למיקרופון. בדקו שאישרתם הרשאה בדפדפן.')
      setState('error')
    }
  }

  function stop() {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }

  function clear() {
    onChange(null)
    setElapsed(0)
  }

  // Done state — preview the recorded audio + clear button.
  if (blob && previewUrl) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2">
        <Mic className="h-4 w-4 shrink-0 text-primary" />
        <audio
          controls
          src={previewUrl}
          className="h-8 flex-1"
          preload="metadata"
        />
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          aria-label="מחק הקלטה"
          title="מחק הקלטה"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // Recording state — red pulsing badge + timer + stop button.
  if (state === 'recording') {
    const remaining = Math.max(0, AUDIO_MAX_SECONDS - elapsed)
    const mm = Math.floor(elapsed / 60)
    const ss = String(elapsed % 60).padStart(2, '0')
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
        </span>
        <span className="font-mono text-xs text-destructive">
          {mm}:{ss}
        </span>
        <span className="text-[10px] text-destructive/70">
          · נשארו {remaining} שנ׳
        </span>
        <button
          type="button"
          onClick={stop}
          className="ms-auto inline-flex items-center gap-1 rounded-md bg-destructive/90 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-destructive"
        >
          <Square className="h-3 w-3" />
          עצור
        </button>
      </div>
    )
  }

  // Idle state — "start recording" button. Wider on its own line.
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => void start()}
        disabled={disabled}
        className="inline-flex w-full min-h-[40px] items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-primary/30 hover:bg-primary/[0.04] hover:text-fg disabled:opacity-50"
      >
        <Mic className="h-4 w-4" />
        הקלט הסבר קולי
        <span className="text-[10px] text-fg-muted/70">· עד 90 שניות</span>
      </button>
      {errMsg && (
        <p className="px-1 text-[11px] text-destructive">{errMsg}</p>
      )}
    </div>
  )
}
