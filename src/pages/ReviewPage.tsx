import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AnnotationCanvas } from '../components/AnnotationCanvas'
import {
  Loader2,
  Lock,
  LogOut,
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
  Check,
  CheckCircle2,
  Mic,
  Square,
  ChevronLeft,
  FolderClosed,
  FileVideo,
  Download as DownloadIcon,
  RefreshCw,
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
  /** Firestore document ID of the ROUND. In legacy single-round
   *  projects this is also the share-token-resolved document. In
   *  new-style project groups, this is the round the viewer
   *  picked from the round picker (or the only round, if the
   *  group has exactly one). Owner-side actions (update-note-
   *  status etc.) target this id. */
  projectId: string
  title: string
  streamUrl: string
  /** Separate URL the explicit "הורדה" link points at. Differs
   *  from streamUrl only in the trailing `&d=1` flag, which
   *  tells the Cloudflare Worker to send `Content-Disposition:
   *  attachment` instead of `inline` so the browser saves the
   *  file rather than playing it. Null when allowDownload is
   *  false on the project. */
  downloadUrl: string | null
  /** Filename to suggest in the browser's save dialog. */
  downloadFileName: string
  videoMime: string
  roundNumber: number
  /** True when the editor closed the round to new feedback. The
   *  video + existing notes stay visible; the add-note buttons
   *  disappear and a friendly banner explains why. */
  locked: boolean
  /** Public-review-page toggles, inherited from the project group
   *  (or default values for legacy single-round projects).
   *
   *  - watermark      : render the animated viewer-email overlay
   *                     on top of the video. Defaults to true.
   *  - allowDownload  : let the browser show its native download
   *                     button on the <video> tag. Defaults to
   *                     false (we keep `controlsList="nodownload"`
   *                     then).
   *  - driveViewUrl   : present when the editor explicitly turned
   *                     on "open in Drive" — null otherwise. When
   *                     set, the workspace surfaces a small link
   *                     that opens the raw Drive file in a new tab.
   */
  watermark: boolean
  allowDownload: boolean
  driveViewUrl: string | null
  /** Present when this round is part of a multi-round group. The
   *  workspace uses it to render the "back to picker" affordance
   *  and so subsequent fetches that need a roundId can grab it
   *  without a separate ref. Null for legacy single-round projects
   *  and for groups that the user reached via the auto-select
   *  shortcut (single-round groups). */
  groupContext?: {
    groupId: string
    totalRounds: number
  }
}

/** One round inside a group, as returned by the get-project
 *  response. Drives the round picker UI. */
interface PickerRound {
  id: string
  roundNumber: number
  locked: boolean
  notesCount: number
  videoFileName: string
  createdAt: number
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
  /** R2 keys — equivalents for R2-backed rounds. */
  screenshotR2Key?: string | null
  audioR2Key?: string | null
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
  | {
      kind: 'needs-round-picker'
      group: { id: string; title: string; rounds: PickerRound[] }
    }
  | { kind: 'ready'; project: ProjectInfo; viewerEmail: string }
  // Owner's Pro subscription has lapsed — viewer should contact
  // the editor directly. We surface their email so the viewer
  // has a one-tap way to reach out.
  | { kind: 'owner-inactive'; ownerEmail: string }

const EMAIL_KEY_PREFIX = 'dmplus.review.email.'
const PWD_TOKEN_KEY_PREFIX = 'dmplus.review.pwd.'

/** Upload a note's screenshot / voice-note STRAIGHT to R2 and return
 *  the R2 key (the server never touches the bytes — zero Vercel
 *  egress, same as the video parts).
 *
 *  Two hops:
 *    1. ask the server for a short-lived presigned PUT URL
 *       (note-media-upload-url) — a tiny JSON round-trip.
 *    2. PUT the blob to that URL → the bytes flow browser → R2.
 *  The browser sets Content-Type from the blob automatically; R2
 *  stores it, so note-media-url can serve it back with the right type.
 *
 *  `roundId` is required for new-style project groups (one share
 *  token, many rounds). Legacy single-round projects ignore it. */
async function uploadNoteMedia(
  shareToken: string,
  passwordToken: string | null,
  roundId: string | null,
  kind: 'image' | 'audio',
  blob: Blob,
): Promise<{ r2Key: string }> {
  const r = await fetch(`${API}?action=note-media-upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shareToken,
      passwordToken,
      roundId,
      kind,
      contentType: blob.type || (kind === 'image' ? 'image/jpeg' : 'audio/webm'),
      sizeBytes: blob.size,
    }),
  })
  const json = (await r.json()) as
    | { ok: true; url: string; key: string }
    | { ok: false; error: string }
  if (!json.ok) throw new Error(json.error || 'העלאה נכשלה')
  // Bytes go browser → R2 directly. Never through Vercel.
  const put = await fetch(json.url, { method: 'PUT', body: blob })
  if (!put.ok) {
    throw new Error(`העלאת המדיה ל-R2 נכשלה (${put.status})`)
  }
  return { r2Key: json.key }
}

/** Resolve a note's media to a URL used DIRECTLY as <img>/<audio> src.
 *  note-media-url hands back either a presigned R2 GET (for R2-backed
 *  notes) or a Cloudflare Worker URL (for legacy Drive notes) — both
 *  serve the bytes straight to the browser with ZERO Vercel transfer.
 *
 *  We return the URL as-is (no fetch-to-blob): a plain <img src>/<audio
 *  src> needs no CORS, and there is deliberately NO Vercel byte-proxy
 *  fallback — if the signed URL can't be minted we surface the error
 *  (broken media) rather than ever routing the bytes through Vercel. */
async function fetchNoteMediaSrc(
  shareToken: string,
  noteId: string,
  kind: 'image' | 'audio',
  passwordToken: string | null,
  roundId: string | null,
): Promise<string> {
  const r = await fetch(`${API}?action=note-media-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shareToken,
      noteId,
      kind,
      passwordToken: passwordToken || undefined,
      roundId: roundId || undefined,
    }),
  })
  if (!r.ok) throw new Error(`note-media-url ${r.status}`)
  const j = (await r.json()) as { ok: boolean; url?: string }
  if (!j.ok || !j.url) throw new Error('note-media-url failed')
  return j.url
}
/** localStorage flag — true once the viewer has seen the "how this
 *  works" onboarding for this specific share token + viewer email.
 *  We don't show it again on subsequent visits because the second
 *  time the viewer already knows the drill. Per-token so different
 *  reviewers (sharing the same browser) each get the explainer once
 *  on their first project. */
const ONBOARDED_KEY_PREFIX = 'dmplus.review.onboarded.'
/** sessionStorage entry holding the project owner's Firebase ID
 *  token after they sign in from the review page. Lets the editor
 *  jump back into a tab and still be able to mark notes without
 *  re-typing the password. TTL pinned to the token's actual exp
 *  (~1h) since Firebase invalidates past that anyway. Stored in
 *  sessionStorage rather than localStorage so the token doesn't
 *  persist past closing the tab — small but meaningful security
 *  win against a shared device. */
const OWNER_TOKEN_KEY_PREFIX = 'dmplus.review.ownerToken.'

interface OwnerSession {
  idToken: string
  expiresAt: number
}

function readOwnerSession(token: string): OwnerSession | null {
  try {
    const raw = sessionStorage.getItem(OWNER_TOKEN_KEY_PREFIX + token)
    if (!raw) return null
    const parsed = JSON.parse(raw) as OwnerSession
    if (
      typeof parsed?.idToken !== 'string' ||
      typeof parsed?.expiresAt !== 'number' ||
      parsed.expiresAt < Date.now()
    ) {
      sessionStorage.removeItem(OWNER_TOKEN_KEY_PREFIX + token)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeOwnerSession(token: string, session: OwnerSession): void {
  try {
    sessionStorage.setItem(
      OWNER_TOKEN_KEY_PREFIX + token,
      JSON.stringify(session),
    )
  } catch {
    /* quota / private browsing — caller continues to work, just no caching */
  }
}

function clearOwnerSession(token: string): void {
  try {
    sessionStorage.removeItem(OWNER_TOKEN_KEY_PREFIX + token)
  } catch {
    /* ignore */
  }
}

export function ReviewPage() {
  const { token: rawToken } = useParams<{ token: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const token = (rawToken || '').trim()
  // ?round=<id> — set by the round picker after the viewer chooses a
  // cut. The presence of this param tells `load()` to drill straight
  // into a specific round of a multi-round group; absence means
  // either a legacy project or "show me the picker". We don't read
  // hash fragments because Vercel + Cloudflare strip those.
  const roundIdFromUrl = (searchParams.get('round') || '').trim() || null
  const [state, setState] = useState<State>({ kind: 'loading' })

  // Allow children (RoundPicker, the workspace header) to navigate
  // between rounds without re-implementing the URL marshalling. They
  // call this with a roundId (drill in) or null (back to picker).
  const navigateToRound = useCallback(
    (roundId: string | null) => {
      const next = new URLSearchParams(searchParams)
      if (roundId) next.set('round', roundId)
      else next.delete('round')
      setSearchParams(next, { replace: false })
    },
    [searchParams, setSearchParams],
  )

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
          body: JSON.stringify({
            shareToken: token,
            passwordToken,
            roundId: roundIdFromUrl,
          }),
        })
        const json = (await r.json()) as
          | {
              ok: true
              ownerInactive: true
              ownerEmail: string
            }
          | {
              ok: true
              needsPassword: true
              title: string
              roundNumber?: number
              locked?: boolean
              kind?: 'group' | 'single'
            }
          | {
              ok: true
              needsPassword: false
              kind: 'single'
              project: {
                id: string
                title: string
                roundNumber?: number
                locked?: boolean
                watermark?: boolean
                allowDownload?: boolean
                driveViewUrl?: string | null
              }
            }
          | {
              ok: true
              needsPassword: false
              kind: 'group'
              group: { id: string; title: string; rounds: PickerRound[] }
              project: {
                id: string
                title: string
                roundNumber?: number
                locked?: boolean
                watermark?: boolean
                allowDownload?: boolean
                driveViewUrl?: string | null
              } | null
            }
          | { ok: false; error: string }

        if (!json.ok) {
          setState({ kind: 'not-found', message: json.error || 'הקישור לא נמצא.' })
          return
        }
        // Owner's Pro subscription has lapsed — show the friendly
        // notice + the editor's email so the viewer can reach
        // out, instead of dumping them into a broken workspace.
        // `'ownerInactive' in json` is the canonical type-guard
        // here (the field only exists on the lapsed-owner variant
        // of the union), so this implicitly narrows json below.
        if ('ownerInactive' in json) {
          setState({
            kind: 'owner-inactive',
            ownerEmail: json.ownerEmail || '',
          })
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
        // Group with no auto-selected round → show the picker. This
        // happens when the group has multiple rounds AND the URL
        // didn't pin a specific one. Single-round groups are
        // auto-selected by the server so they skip straight to the
        // workspace below.
        if (json.kind === 'group' && !json.project) {
          setState({
            kind: 'needs-round-picker',
            group: json.group,
          })
          return
        }
        // Either legacy single-round OR group with auto/explicit
        // round selection. Both reach the workspace via loadStream.
        const proj = json.project!
        const round = proj.roundNumber ?? 1
        const locked = proj.locked === true
        const projectId = proj.id
        // Public-review-page toggles, with safe defaults for any
        // legacy response that doesn't include them (treat
        // watermark as on, download as off, no Drive link).
        const projectFlags = {
          watermark: proj.watermark !== false,
          allowDownload: proj.allowDownload === true,
          driveViewUrl: proj.driveViewUrl ?? null,
        }
        const groupContext =
          json.kind === 'group'
            ? { groupId: json.group.id, totalRounds: json.group.rounds.length }
            : undefined
        const storedEmail = localStorage.getItem(EMAIL_KEY_PREFIX + token)
        if (storedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(storedEmail)) {
          await loadStream(
            storedEmail,
            proj.title,
            round,
            locked,
            projectId,
            groupContext,
            projectFlags,
          )
        } else {
          setState({
            kind: 'needs-email',
            title: proj.title,
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
      projectId: string,
      groupContext: ProjectInfo['groupContext'],
      flags: {
        watermark: boolean
        allowDownload: boolean
        driveViewUrl: string | null
      },
    ) {
      const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
      const r = await fetch(`${API}?action=get-stream-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareToken: token,
          passwordToken,
          // For groups the server needs the roundId to mint the
          // correct stream URL (the URL embeds `&r=<roundId>` so
          // the Worker → auth-stream → Drive flow can pick the
          // right file). Legacy ignores this.
          roundId: groupContext ? projectId : null,
        }),
      })
      const json = (await r.json()) as
        | {
            ok: true
            streamUrl: string
            downloadUrl?: string | null
            downloadFileName?: string
            videoMime: string
            title: string
          }
        | { ok: false; error: string }
      if (!json.ok) {
        setState({ kind: 'not-found', message: json.error || 'שגיאה בקבלת הסרטון' })
        return
      }
      setState({
        kind: 'ready',
        project: {
          projectId,
          title,
          streamUrl: json.streamUrl,
          downloadUrl: json.downloadUrl ?? null,
          downloadFileName: json.downloadFileName || `round-${roundNumber}.mp4`,
          videoMime: json.videoMime,
          roundNumber,
          locked,
          watermark: flags.watermark,
          allowDownload: flags.allowDownload,
          driveViewUrl: flags.driveViewUrl,
          groupContext,
        },
        viewerEmail,
      })
    }
  }, [token, roundIdFromUrl])

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
  if (state.kind === 'owner-inactive')
    return (
      <ReviewShell>
        <CenterCard>
          <OwnerInactiveState ownerEmail={state.ownerEmail} />
        </CenterCard>
      </ReviewShell>
    )
  if (state.kind === 'needs-round-picker')
    return (
      <ReviewShell>
        <RoundPickerScreen
          group={state.group}
          onPick={(roundId) => navigateToRound(roundId)}
        />
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
    <ReviewShell viewerEmail={state.viewerEmail} token={token}>
      <ReadyOrOnboarding
        token={token}
        project={state.project}
        viewerEmail={state.viewerEmail}
        onBackToPicker={
          state.project.groupContext && state.project.groupContext.totalRounds > 1
            ? () => navigateToRound(null)
            : undefined
        }
      />
    </ReviewShell>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Round picker — first screen viewers see when a project has
 *  multiple rounds.
 *
 *  Editorial pattern matches the rest of the review chrome: large
 *  centered card, brand kicker, small explainer above the list.
 *  Each round renders as a tappable row with the cut number, file
 *  name, lock badge if frozen, and notes count. We sort newest
 *  round first so the most recent cut is the easiest tap target
 *  (typical viewer wants to see the latest version).
 * ───────────────────────────────────────────────────────────── */
function RoundPickerScreen({
  group,
  onPick,
}: {
  group: { id: string; title: string; rounds: PickerRound[] }
  onPick: (roundId: string) => void
}) {
  const sorted = useMemo(
    () => [...group.rounds].sort((a, b) => b.roundNumber - a.roundNumber),
    [group.rounds],
  )
  // Single-round projects skip this screen server-side (see
  // handleGetProject). If we ever land here with zero rounds it
  // means the editor archived all of them — surface a friendly
  // message rather than an empty list.
  if (sorted.length === 0) {
    return (
      <CenterCard>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h1 className="text-lg font-medium text-white">אין סבבים זמינים</h1>
          <p className="mt-2 text-sm text-white/60">
            כרגע אין סבבי תיקונים פעילים בפרויקט הזה. צרו קשר עם העורך.
          </p>
        </div>
      </CenterCard>
    )
  }
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm"
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 text-white/70">
            <FolderClosed className="h-6 w-6" strokeWidth={1.8} />
          </div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-white/40">
            — פרויקט
          </div>
          <h1 className="text-lg font-medium text-white">{group.title}</h1>
          <p className="mt-2 text-xs text-white/60">
            בחרו את סבב התיקונים שתרצו לפתוח.
          </p>
        </div>

        <ul className="space-y-2">
          {sorted.map((round) => (
            <li key={round.id}>
              <button
                type="button"
                onClick={() => onPick(round.id)}
                className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-right transition-all hover:border-white/20 hover:bg-white/[0.05]"
              >
                <span
                  title={`סבב ${round.roundNumber}`}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-white/10 px-2 py-1 text-[11px] font-mono font-semibold text-white"
                >
                  <Hash className="h-3 w-3" />
                  {round.roundNumber}
                </span>
                <div className="min-w-0 flex-1">
                  {/* Generic label rather than the upload's filename
                      — file names from the editor's desktop (e.g.
                      "סקיצה-compressed.mp4") are an implementation
                      detail the client doesn't care about, and they
                      vary across rounds for the same project which
                      makes the picker look noisy. The round number
                      is the only thing the client uses to pick. */}
                  <div className="truncate text-sm text-white">
                    סבב תיקונים מס' {round.roundNumber}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/40">
                    {round.notesCount > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="h-2.5 w-2.5" />
                        {round.notesCount} תיקונים
                      </span>
                    )}
                    {round.createdAt > 0 && (
                      <span>{formatRoundDate(round.createdAt)}</span>
                    )}
                  </div>
                </div>
                {round.locked && (
                  <span
                    title="הסבב סגור לתיקונים חדשים"
                    className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400"
                  >
                    <Lock className="h-2.5 w-2.5" />
                    נעול
                  </span>
                )}
                <ChevronLeft
                  className="h-4 w-4 shrink-0 text-white/30 transition-all group-hover:translate-x-[-2px] group-hover:text-white/60"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      </motion.div>
    </div>
  )
}

function formatRoundDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString('he-IL', {
      day: 'numeric',
      month: 'short',
    })
  } catch {
    return ''
  }
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
  onBackToPicker,
}: {
  token: string
  project: ProjectInfo
  viewerEmail: string
  /** When set the workspace shows a small "back to round picker"
   *  affordance in the header. Undefined for legacy projects and
   *  for single-round groups. */
  onBackToPicker?: () => void
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

  // Owner detection — runs once per (token, email) pair. If this
  // viewer's email matches the project owner's, we surface a "log
  // in as editor" overlay so they can mark notes from the website
  // instead of having to switch to the desktop app. Reviewers who
  // share the same browser as the editor (or are not the editor)
  // skip the overlay entirely.
  const [ownerCheck, setOwnerCheck] = useState<
    'idle' | 'is-owner-unauth' | 'authed' | 'not-owner'
  >('idle')
  const [ownerSession, setOwnerSession] = useState<OwnerSession | null>(
    () => readOwnerSession(token),
  )

  useEffect(() => {
    // Already have a valid cached token? Skip the prompt entirely.
    if (ownerSession && ownerSession.expiresAt > Date.now()) {
      setOwnerCheck('authed')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch(`${API}?action=check-owner-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareToken: token, email: viewerEmail }),
        })
        const json = (await r.json()) as
          | { ok: true; isOwner: boolean }
          | { ok: false; error: string }
        if (cancelled) return
        if (json.ok && json.isOwner) setOwnerCheck('is-owner-unauth')
        else setOwnerCheck('not-owner')
      } catch {
        if (!cancelled) setOwnerCheck('not-owner')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, viewerEmail, ownerSession])

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

  // Owner detected but hasn't signed in yet — show the prompt
  // overlay. Editor can sign in OR continue as a regular viewer.
  if (ownerCheck === 'is-owner-unauth') {
    return (
      <OwnerSignInPrompt
        shareToken={token}
        email={viewerEmail}
        projectTitle={project.title}
        onSignedIn={(session) => {
          writeOwnerSession(token, session)
          setOwnerSession(session)
          setOwnerCheck('authed')
        }}
        onSkip={() => setOwnerCheck('not-owner')}
      />
    )
  }

  return (
    <ReviewWorkspace
      token={token}
      project={project}
      viewerEmail={viewerEmail}
      onBackToPicker={onBackToPicker}
      ownerIdToken={
        ownerCheck === 'authed' && ownerSession ? ownerSession.idToken : null
      }
      onOwnerSessionInvalid={() => {
        clearOwnerSession(token)
        setOwnerSession(null)
        setOwnerCheck('is-owner-unauth')
      }}
    />
  )
}

/* ─────────────────────────────────────────────────────────────
 *  OwnerSignInPrompt — full-screen "sign in as editor" form,
 *  shown when the email entered at the gate matches the project
 *  owner. Editor enters their account password; we exchange it
 *  for a Firebase idToken via the server's owner-signin action
 *  and unlock the status-menu UI in NoteItem.
 *
 *  "המשך כצופה רגיל" lets them skip the sign-in if they're not
 *  going to be marking notes this session — useful when an
 *  editor opens their own share link to preview what the client
 *  sees.
 * ───────────────────────────────────────────────────────────── */
function OwnerSignInPrompt({
  shareToken,
  email,
  projectTitle,
  onSignedIn,
  onSkip,
}: {
  shareToken: string
  email: string
  projectTitle: string
  onSignedIn: (session: OwnerSession) => void
  onSkip: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API}?action=owner-signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken, email, password }),
      })
      const json = (await r.json()) as
        | { ok: true; idToken: string; expiresInSec: number }
        | { ok: false; error: string }
      if (!json.ok) {
        setError(json.error || 'ההתחברות נכשלה')
        setBusy(false)
        return
      }
      onSignedIn({
        idToken: json.idToken,
        // Subtract 60s safety margin so we don't try to use a token
        // that's about to expire mid-request.
        expiresAt: Date.now() + (json.expiresInSec - 60) * 1000,
      })
    } catch {
      setError('שגיאת רשת. נסו שוב.')
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-center px-4 py-12 sm:py-20">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-5 rounded-2xl border border-primary/20 bg-primary/[0.04] p-7"
      >
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Lock className="h-5 w-5" />
          </div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-primary">
            זוהיתם כעורך הסבב
          </div>
          <h1 className="text-lg font-medium text-fg">
            התחברו עם סיסמת החשבון
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            אחרי ההתחברות תוכלו לסמן תיקונים כטופלו, לפתוח שאלות ולסמן
            תיקונים שאי אפשר לבצע — הכל ישירות מהאתר, בלי לפתוח את התוכנה.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-fg-muted" htmlFor="owner-pwd">
            סיסמה
          </label>
          <input
            id="owner-pwd"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p
            className="text-[11px] text-fg-muted/70"
            dir="ltr"
          >
            {email}
          </p>
        </div>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={!password || busy}
            className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'התחבר כעורך'}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="text-center text-[11px] text-fg-muted transition-colors hover:text-fg"
          >
            דלגו והמשיכו כצופה רגיל
          </button>
        </div>
        <p
          className="truncate text-center text-[10px] text-fg-muted/60"
          title={projectTitle}
        >
          {projectTitle}
        </p>
      </form>
    </div>
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
                {/* Colors here MUST match the NoteItem badges in the
                    workspace below — otherwise viewers learn one
                    color vocabulary in the onboarding and meet a
                    different one in the actual UI. Resolved=yellow,
                    question=sky, not-possible=red. */}
                <span className="mt-1 inline-flex items-center gap-0.5 rounded bg-yellow-500/15 px-1 py-0 text-[10px] font-medium text-yellow-400">
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
                <span className="mt-1 inline-flex items-center gap-0.5 rounded bg-red-500/15 px-1 py-0 text-[10px] font-medium text-red-400">
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
  token,
}: {
  children: React.ReactNode
  viewerEmail?: string
  /** The /review/:token path param — needed so the header's
   *  logout button knows which (email, password, owner-session)
   *  cache to clear. Absent on shells rendered before we know
   *  the token (loading state), in which case the header just
   *  doesn't show the logout affordance. */
  token?: string
}) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg" dir="rtl">
      <ReviewHeader viewerEmail={viewerEmail} token={token} />
      <main className="flex-1">{children}</main>
      <ReviewFooter />
    </div>
  )
}

function ReviewHeader({
  viewerEmail,
  token,
}: {
  viewerEmail?: string
  token?: string
}) {
  /** Wipe every cached identity bit tied to this token + reload
   *  so the viewer lands back on the email gate. We clear:
   *    - the email   (so the gate prompts again)
   *    - the password token (in case the project had one)
   *    - the owner session (sessionStorage; for editor sign-in)
   *  Onboarding state is intentionally LEFT in place — re-seeing
   *  the 5-step explainer on every logout would be annoying for
   *  a viewer who logged out by accident. */
  function logout() {
    if (!token) return
    try {
      localStorage.removeItem(EMAIL_KEY_PREFIX + token)
      localStorage.removeItem(PWD_TOKEN_KEY_PREFIX + token)
      sessionStorage.removeItem(OWNER_TOKEN_KEY_PREFIX + token)
    } catch {
      // ignore — quota / private browsing
    }
    window.location.reload()
  }

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

        {/* Viewer email pill + logout button. The pill collapses to
            just the icon on mobile to save space; the logout button
            stays the same size on every breakpoint because the
            tap target shouldn't change. */}
        {viewerEmail && (
          <div className="flex items-center gap-1.5">
            <div
              className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-white/[0.02] px-2.5 py-1 text-[11px] text-fg-muted"
              title={viewerEmail}
            >
              <Mail className="h-3 w-3 shrink-0" />
              <span dir="ltr" className="hidden font-mono sm:inline">
                {viewerEmail}
              </span>
            </div>
            {token && (
              <button
                type="button"
                onClick={logout}
                title="התנתקות — איפוס המייל והסיסמה השמורים"
                aria-label="התנתקות"
                className="inline-flex h-7 items-center gap-1 rounded-full border border-white/5 bg-white/[0.02] px-2.5 text-[11px] text-fg-muted transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut className="h-3 w-3" />
                <span className="hidden sm:inline">התנתק</span>
              </button>
            )}
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

/** Shown when the project's owner (the editor) doesn't currently
 *  have an active Pro subscription. The viewer can't open the
 *  workspace, but we surface the editor's email as a mailto:
 *  link so they have a one-tap way to ask the editor to renew
 *  or send the material another way. The pre-filled subject
 *  saves the viewer from having to summarize the situation. */
function OwnerInactiveState({ ownerEmail }: { ownerEmail: string }) {
  // Build the mailto URL. We KNOW we're allowed to render a real
  // mailto here (this is a contact action the viewer chose) so
  // the email-detector mitigations we use elsewhere in the page
  // (SafeEmail / format-detection meta) don't apply.
  const mailto = ownerEmail
    ? `mailto:${ownerEmail}?subject=${encodeURIComponent('בקשה לצפייה בסרטון לתיקונים')}`
    : null
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h1 className="mb-3 text-lg font-medium text-fg">
        הקישור לא זמין כרגע
      </h1>
      <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-fg-muted">
        המנוי של העורך שלכם הסתיים, ולכן הסרטון לא נטען. מומלץ
        ליצור איתם קשר ישירות כדי להמשיך בתהליך התיקונים.
      </p>
      {mailto && (
        <a
          href={mailto}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-amber-500/90 px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-amber-500"
        >
          <Mail className="h-4 w-4" />
          שלחו מייל לעורך
        </a>
      )}
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
  ownerIdToken,
  onOwnerSessionInvalid,
  onBackToPicker,
}: {
  token: string
  project: ProjectInfo
  viewerEmail: string
  /** When non-null, the viewer signed in as the project owner.
   *  NoteItem renders the status menu and we forward this token
   *  to update-note-status calls. */
  ownerIdToken: string | null
  /** Called when an owner-side API call fails with 401, meaning
   *  the cached idToken expired or was revoked. Bubbles up so the
   *  parent can clear the cache and re-prompt for sign-in. */
  onOwnerSessionInvalid: () => void
  /** When defined the header shows a small "← לבחירת סבב" link
   *  so the viewer can pop back to the picker mid-session. Only
   *  provided for projects with >1 round. */
  onBackToPicker?: () => void
}) {
  const streamUrl = project.streamUrl
  // For new-style groups every note-side call must include the
  // roundId so the server can route the operation to the correct
  // round doc (group + roundId resolves to a single round). For
  // legacy single-round projects the share token alone identifies
  // the round, so roundId is null. project.projectId IS the round
  // id in both cases — we just only forward it when there's a
  // group context to scope it.
  const roundId = project.groupContext ? project.projectId : null

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
          body: JSON.stringify({ shareToken: token, passwordToken, roundId }),
        })
        const json = (await r.json()) as
          | { ok: true; notes: Note[] }
          | { ok: false; error: string }
        if (json.ok) setNotes(json.notes)
      } finally {
        if (opts.showSpinner) setNotesLoading(false)
      }
    },
    [token, roundId],
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

  // "סיום סבב" — the reviewer declares they're done. Locks the round
  // (no more notes) and emails the editor it's ready to fix.
  const [finalized, setFinalized] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [confirmFinalize, setConfirmFinalize] = useState(false)
  const [finalizeError, setFinalizeError] = useState<string | null>(null)

  async function finalizeRound() {
    if (finalizing) return
    setFinalizing(true)
    setFinalizeError(null)
    try {
      const passwordToken = localStorage.getItem(PWD_TOKEN_KEY_PREFIX + token)
      const r = await fetch(`${API}?action=finalize-round`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareToken: token,
          passwordToken: passwordToken || undefined,
          roundId: roundId || undefined,
          viewerEmail: viewerEmail || undefined,
        }),
      })
      const j = (await r.json()) as { ok: boolean; error?: string }
      if (!j.ok) throw new Error(j.error || 'failed')
      setFinalized(true)
      setConfirmFinalize(false)
    } catch {
      setFinalizeError('שליחת הסיום נכשלה. נסו שוב.')
    } finally {
      setFinalizing(false)
    }
  }

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

      // ── Phase 1: upload media STRAIGHT to R2 ──
      // Note media now always lands in R2 via a presigned PUT — the
      // bytes go browser → R2 and never touch Vercel. Drive file-ids
      // stay null (legacy field kept only for old notes).
      const screenshotDriveFileId: string | null = null
      const audioDriveFileId: string | null = null
      let screenshotR2Key: string | null = null
      let audioR2Key: string | null = null
      if (screenshotToSave) {
        // data URL → Blob so we can PUT the raw bytes to R2.
        const blob = await (await fetch(screenshotToSave)).blob()
        const up = await uploadNoteMedia(
          token,
          passwordToken,
          roundId,
          'image',
          blob,
        )
        screenshotR2Key = up.r2Key
      }
      if (audioBlob) {
        const up = await uploadNoteMedia(
          token,
          passwordToken,
          roundId,
          'audio',
          audioBlob,
        )
        audioR2Key = up.r2Key
      }

      // ── Phase 2: create the note pointing at the fileIds/keys ──
      const r = await fetch(`${API}?action=add-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareToken: token,
          passwordToken,
          roundId,
          viewerEmail,
          timeSeconds: composer.timeSeconds,
          text,
          screenshotDriveFileId,
          audioDriveFileId,
          screenshotR2Key,
          audioR2Key,
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
          screenshotR2Key,
          audioR2Key,
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
          roundId,
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

  /** Owner-side: change a note's workflow status. Optimistic
   *  update with rollback on error. When the server returns 401
   *  the cached idToken is stale — bubble that up so the parent
   *  can re-prompt for sign-in. */
  async function applyOwnerStatus(
    noteId: string,
    newStatus: 'new' | 'resolved' | 'question' | 'not-possible',
    editorResponse?: string,
  ) {
    if (!ownerIdToken) return
    const previous = notes
    setNotes((prev) =>
      prev.map((n) =>
        n.id === noteId
          ? {
              ...n,
              status: newStatus,
              editorResponse:
                newStatus === 'question' || newStatus === 'not-possible'
                  ? editorResponse ?? null
                  : null,
            }
          : n,
      ),
    )
    try {
      const r = await fetch(`${API}?action=update-note-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: ownerIdToken,
          projectId: project.projectId,
          noteId,
          status: newStatus,
          editorResponse,
        }),
      })
      if (r.status === 401) {
        setNotes(previous)
        onOwnerSessionInvalid()
        return
      }
      const json = (await r.json()) as { ok: boolean; error?: string }
      if (!json.ok) {
        setNotes(previous)
        console.warn('[review] update-note-status failed:', json.error)
      }
    } catch (err) {
      setNotes(previous)
      console.warn('[review] update-note-status network failure:', err)
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
        {onBackToPicker && (
          // Push the picker link to the LTR end of the row in RTL,
          // far away from the title so it reads as secondary
          // navigation. The chevron points back-direction-aware:
          // ChevronLeft becomes "next" in RTL — exactly what we
          // want for "switch round".
          <button
            type="button"
            onClick={onBackToPicker}
            className="ms-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white"
            title="חזרה לבחירת סבב בפרויקט"
          >
            <FileVideo className="h-3 w-3" />
            סבב אחר
          </button>
        )}
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
                // We always disable Chrome's built-in download
                // menu — its UX is inconsistent across browsers
                // (Safari hides it, Firefox renders it ugly) and
                // the streaming URL is wrapped in
                // Content-Disposition: inline which would
                // anyway prevent it from working cleanly. The
                // editor's "Allow download" toggle surfaces a
                // dedicated "הורדה" button below the player
                // that hits a SEPARATE attachment-disposition
                // URL for a proper save.
                controlsList="nodownload"
                onContextMenu={(e) => e.preventDefault()}
                className="block max-h-[72vh] w-auto max-w-full"
              />
            </div>
            {/* Watermark is per-project — editor decides whether the
                viewer's email shows over the video. Defaults to on
                for new projects; can be flipped off from the edit
                modal when the editor trusts the client. */}
            {project.watermark && <Watermark email={viewerEmail} />}
          </div>

          {/* Optional toggleable affordances — both render only
              when the editor explicitly enabled the matching
              setting. Wrapped in a single flex row so they sit
              side-by-side instead of stacking. */}
          {(project.driveViewUrl || project.downloadUrl) && (
            <div className="flex flex-wrap items-center gap-2">
              {project.downloadUrl && (
                <DownloadButton
                  url={project.downloadUrl}
                  filename={project.downloadFileName}
                />
              )}
              {project.driveViewUrl && (
                <a
                  href={project.driveViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                >
                  <FolderClosed className="h-3 w-3" />
                  פתח את הקובץ ב-Google Drive
                </a>
              )}
            </div>
          )}

          {/* Action strip — placed UNDER the video, not floating in
              the header. When the editor locks the round we hide
              the add buttons and show a friendly banner instead, so
              the client knows the silence is intentional (editor is
              working on the changes) rather than a bug. */}
          {project.locked || finalized ? (
            finalized ? (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs leading-relaxed text-emerald-200">
                <Check className="h-4 w-4 shrink-0" />
                <span>
                  <strong className="font-semibold">סיימת את הסבב 🎉</strong>{' '}
                  שלחנו לעורך הודעה שהתיקונים מוכנים. הסבב נסגר ולא ניתן להוסיף
                  עוד תיקונים.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
                <Lock className="h-4 w-4 shrink-0" />
                <span>
                  <strong className="font-semibold">הסבב נסגר לתיקונים.</strong>{' '}
                  אתם עדיין יכולים לצפות בסרטון ובתיקונים הקודמים, אבל לא להוסיף
                  חדשים.
                </span>
              </div>
            )
          ) : (
            <div className="space-y-3">
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
              {/* Done — finalize the round + notify the editor. */}
              <div className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                <span className="text-[11px] leading-relaxed text-fg-muted/80">
                  סיימתם לסמן את כל התיקונים? סגרו את הסבב והעורך יקבל הודעה
                  שאפשר להתחיל לתקן.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setFinalizeError(null)
                    setConfirmFinalize(true)
                  }}
                  className="inline-flex shrink-0 min-h-[40px] items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20"
                >
                  <Check className="h-4 w-4" strokeWidth={2.5} />
                  אין עוד תיקונים
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Confirm finalize-round modal. */}
        {confirmFinalize && (
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
            onClick={() => !finalizing && setConfirmFinalize(false)}
          >
            <div
              dir="rtl"
              className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 text-center shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                <Check className="h-5 w-5" strokeWidth={2.5} />
              </div>
              <h3 className="text-lg font-bold text-fg">לסגור את הסבב?</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                בטוח שסיימת לרשום את כל התיקונים? אחרי האישור לא תוכל להוסיף עוד
                תיקונים, והעורך יקבל הודעה שהסבב מוכן לתיקון.
              </p>
              {finalizeError && (
                <p className="mt-3 text-xs text-destructive">{finalizeError}</p>
              )}
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmFinalize(false)}
                  disabled={finalizing}
                  className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onClick={finalizeRound}
                  disabled={finalizing}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-emerald-500/90 disabled:opacity-60"
                >
                  {finalizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" strokeWidth={2.5} />
                  )}
                  {finalizing ? 'שולח…' : 'כן, סיימתי'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Notes sidebar */}
        <aside className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
          <div className="mb-1 flex items-center gap-2 border-b border-white/5 pb-3">
            <MessageSquare className="h-4 w-4 text-fg-muted" />
            <h2 className="text-sm font-medium text-fg">תיקונים</h2>
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-fg-muted">
              {notes.length}
            </span>
            {/* Manual refresh of JUST the notes list (not a page
                reload). The review page has no live listener — viewers
                are anonymous and rounds can be password-gated — so
                notes other people added since the page loaded only show
                up on demand. This button pulls the latest list via the
                server endpoint and swaps in only the notes state. */}
            <button
              type="button"
              onClick={() => void refreshNotes({ showSpinner: true })}
              disabled={notesLoading}
              title="תיקונים שמשתמשים אחרים הוסיפו נטענים בלחיצה כאן (או ברענון הדף)"
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${notesLoading ? 'animate-spin' : ''}`}
              />
              טען תיקונים חדשים
            </button>
          </div>
          {/* One-line hint so it's obvious WHY the button exists —
              new notes from others aren't pushed automatically. */}
          <p className="mb-3 text-[10px] leading-relaxed text-fg-faint">
            תיקונים חדשים של אחרים לא מתעדכנים לבד — לחצו "טען תיקונים חדשים".
          </p>
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
                    roundId={roundId}
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
                    isOwnerMode={ownerIdToken !== null}
                    onSeek={seekTo}
                    onExpandImage={(url) => setLightbox(url)}
                    onDelete={() => deleteNote(note.id)}
                    onApplyStatus={(status, response) =>
                      void applyOwnerStatus(note.id, status, response)
                    }
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

/** Force a real download regardless of the response's Content-
 *  Disposition. The naive `<a download href="..." />` approach
 *  fails when the browser decides the response is "playable" and
 *  opens it in a new tab instead of saving — happens on iOS
 *  Safari and on Chrome when the URL is cross-origin without an
 *  attachment hint.
 *
 *  We fetch the file as a Blob, hand it to a temporary anchor
 *  with the `download` attribute, and revoke the object URL
 *  afterwards. Works in every modern browser regardless of
 *  CORS/Content-Disposition quirks.
 *
 *  Trade-off: the file lives in memory until the save dialog
 *  resolves. Acceptable for review-cut sizes (typically 50–500
 *  MB); a future enhancement could stream via the File System
 *  Access API for big files, but it's a Chrome-only API and the
 *  permission prompt would feel heavier than this approach. */
function DownloadButton({ url, filename }: { url: string; filename: string }) {
  const [state, setState] = useState<'idle' | 'downloading' | 'error'>('idle')

  async function download() {
    if (state === 'downloading') return
    setState('downloading')
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`status ${r.status}`)
      const blob = await r.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Free the blob backing memory shortly after the browser
      // takes over the download. Synchronous revoke would race
      // with some browsers' download workers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      setState('idle')
    } catch (err) {
      console.error('[review] download failed:', err)
      setState('error')
      // Auto-clear the error after a few seconds so the button
      // returns to its idle label and the viewer can retry.
      setTimeout(() => setState('idle'), 3000)
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={state === 'downloading'}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-wait disabled:opacity-60"
    >
      {state === 'downloading' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <DownloadIcon className="h-3 w-3" />
      )}
      {state === 'downloading'
        ? 'מוריד…'
        : state === 'error'
          ? 'נסו שוב'
          : 'הורדה'}
    </button>
  )
}

/** Render an email as visually-identical text that iOS Safari's
 *  data detector CANNOT parse as a mailto: candidate. Splits the
 *  string at the '@' into two adjacent spans — the visual output
 *  is identical, but the DOM no longer contains a single text
 *  node matching the email regex, so iOS stops offering to
 *  compose mail when the user lands on /review. (The global
 *  format-detection meta tag handles most cases; this is
 *  belt-and-suspenders for older iOS versions / WebViews that
 *  ignore the meta hint.) */
function SafeEmail({ email }: { email: string }) {
  const atIdx = email.indexOf('@')
  if (atIdx === -1) return <>{email}</>
  return (
    <>
      <span>{email.slice(0, atIdx)}</span>
      <span>{email.slice(atIdx)}</span>
    </>
  )
}

function Watermark({ email }: { email: string }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 select-none"
      style={{ mixBlendMode: 'overlay' }}
    >
      <div className="absolute top-4 right-4 text-white/40 text-[10px] tracking-wider font-mono">
        <SafeEmail email={email} />
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
        <SafeEmail email={email} />
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
  isOwnerMode,
  shareToken,
  roundId,
  onSeek,
  onExpandImage,
  onDelete,
  onApplyStatus,
}: {
  note: Note
  /** True when the current viewer's email matches the note's
   *  stored viewerEmail — controls whether the trash icon shows.
   *  Server still enforces the same check on delete-note. */
  isOwn: boolean
  /** True when the viewer has signed in as the project owner.
   *  Swaps the read-only status badge for an interactive menu. */
  isOwnerMode: boolean
  /** Needed to build Drive-media URLs for screenshot + audio. */
  shareToken: string
  /** Required for grouped projects so the media proxy can resolve
   *  which round's notes folder this note's attachment lives in.
   *  Null on legacy single-round projects (the share token alone
   *  uniquely identifies the round). */
  roundId: string | null
  onSeek: (t: number) => void
  onExpandImage: (url: string) => void
  onDelete: () => void
  /** Owner-side status change handler. No-op in viewer mode. */
  onApplyStatus: (
    status: 'new' | 'resolved' | 'question' | 'not-possible',
    editorResponse?: string,
  ) => void
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
  // Media src now resolves (async) to a Cloudflare Worker URL so the
  // bytes flow Drive → Cloudflare → browser, never through Vercel.
  // Legacy notes carry an inline data URL — used directly, no fetch.
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(
    note.screenshotDataUrl || null,
  )
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const created: string[] = []
    const revoke = (u: string) => {
      if (u.startsWith('blob:')) URL.revokeObjectURL(u)
    }
    if (note.screenshotDriveFileId || note.screenshotR2Key) {
      void fetchNoteMediaSrc(shareToken, note.id, 'image', passwordToken, roundId)
        .then((u) => {
          if (alive) {
            created.push(u)
            setScreenshotUrl(u)
          } else revoke(u)
        })
        .catch(() => undefined)
    }
    if (note.audioDriveFileId || note.audioR2Key) {
      void fetchNoteMediaSrc(shareToken, note.id, 'audio', passwordToken, roundId)
        .then((u) => {
          if (alive) {
            created.push(u)
            setAudioUrl(u)
          } else revoke(u)
        })
        .catch(() => undefined)
    }
    return () => {
      alive = false
      created.forEach(revoke)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    note.id,
    note.screenshotDriveFileId,
    note.audioDriveFileId,
    note.screenshotR2Key,
    note.audioR2Key,
    shareToken,
    roundId,
  ])

  // Border + bg color per status — picked so the four states are
  // distinguishable at a glance when scrolling a long list. Per
  // user feedback: resolved is now yellow (more celebratory than
  // the previous quiet green), not-possible is red (the previous
  // amber felt too mild for "we can't do this").
  const containerClass = resolved
    ? 'border-yellow-500/30 bg-yellow-500/[0.07] hover:bg-yellow-500/[0.09]'
    : isQuestion
      ? 'border-sky-500/20 bg-sky-500/[0.04] hover:bg-sky-500/[0.06]'
      : isNotPossible
        ? 'border-red-500/30 bg-red-500/[0.06] hover:bg-red-500/[0.08]'
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
                      ? 'text-yellow-400 hover:bg-yellow-500/10'
                      : isQuestion
                        ? 'text-sky-400 hover:bg-sky-500/10'
                        : isNotPossible
                          ? 'text-red-400 hover:bg-red-500/10'
                          : 'text-primary hover:bg-primary/10')
                  }
                >
                  {mm}:{ss}
                </button>
              )}
              {/* Status badge — three colours for three editor
                  responses. In owner mode it becomes an interactive
                  dropdown so the editor can change status from the
                  website without opening the desktop app; in viewer
                  mode it stays read-only. */}
              {isOwnerMode ? (
                <OwnerStatusMenu
                  status={note.status}
                  currentResponse={note.editorResponse || ''}
                  onApply={onApplyStatus}
                />
              ) : (
                <>
                  {resolved && (
                    <span
                      title="העורך סימן את התיקון כטופל"
                      className="inline-flex items-center gap-1 rounded-full border border-yellow-500/40 bg-yellow-500/15 px-1.5 py-0.5 text-[9px] font-medium text-yellow-400 whitespace-nowrap"
                    >
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      טופל
                    </span>
                  )}
                  {isQuestion && (
                    <span
                      title="העורך מבקש הבהרה — ראו את הטקסט בתוך התיקון"
                      className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-400 whitespace-nowrap"
                    >
                      <MessageSquare className="h-2.5 w-2.5" />
                      שאלה
                    </span>
                  )}
                  {isNotPossible && (
                    <span
                      title="העורך הסביר למה לא ניתן לבצע — ראו את הטקסט בתוך התיקון"
                      className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400 whitespace-nowrap"
                    >
                      <AlertTriangle className="h-2.5 w-2.5" />
                      לא אפשרי
                    </span>
                  )}
                </>
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
                  : 'border-red-500/60 bg-red-500/[0.04] text-red-100/90')
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

/* ─────────────────────────────────────────────────────────────
 *  OwnerStatusMenu — interactive pill + popover that the signed-
 *  in editor uses to change a note's workflow status from the
 *  review page (mirrors the desktop's StatusPill UX). Selecting
 *  question / not-possible opens a small modal for the response
 *  text since those states carry user-visible payload.
 * ───────────────────────────────────────────────────────────── */
type NoteStatusValue = 'new' | 'resolved' | 'question' | 'not-possible'

function OwnerStatusMenu({
  status,
  currentResponse,
  onApply,
}: {
  status: NoteStatusValue
  currentResponse: string
  onApply: (status: NoteStatusValue, response?: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [responseModal, setResponseModal] = useState<
    null | { kind: 'question' | 'not-possible' }
  >(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  function pick(s: NoteStatusValue) {
    setMenuOpen(false)
    if (s === 'question' || s === 'not-possible') {
      setResponseModal({ kind: s })
    } else {
      onApply(s)
    }
  }

  const pillClass =
    status === 'resolved'
      ? 'border-yellow-500/40 bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/20'
      : status === 'question'
        ? 'border-sky-500/40 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15'
        : status === 'not-possible'
          ? 'border-red-500/40 bg-red-500/15 text-red-400 hover:bg-red-500/20'
          : 'border-white/10 bg-white/[0.02] text-fg-muted hover:border-white/20 hover:text-fg'
  const label =
    status === 'resolved'
      ? 'טופל'
      : status === 'question'
        ? 'שאלה'
        : status === 'not-possible'
          ? 'לא אפשרי'
          : 'חדש'
  const Icon =
    status === 'resolved'
      ? CheckCircle2
      : status === 'question'
        ? MessageSquare
        : status === 'not-possible'
          ? AlertTriangle
          : Plus

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title="שינוי סטטוס תיקון"
          className={
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium whitespace-nowrap transition-colors ' +
            pillClass
          }
        >
          <Icon className="h-2.5 w-2.5" />
          {label}
          <span aria-hidden className="opacity-60">▾</span>
        </button>
        {menuOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-white/10 bg-bg shadow-2xl">
            <OwnerMenuItem
              label="חדש"
              icon={Plus}
              active={status === 'new'}
              tone="muted"
              onClick={() => pick('new')}
            />
            <OwnerMenuItem
              label="טופל"
              icon={CheckCircle2}
              active={status === 'resolved'}
              tone="yellow"
              onClick={() => pick('resolved')}
            />
            <OwnerMenuItem
              label="שאלה ללקוח"
              icon={MessageSquare}
              active={status === 'question'}
              tone="sky"
              onClick={() => pick('question')}
            />
            <OwnerMenuItem
              label="לא אפשרי"
              icon={AlertTriangle}
              active={status === 'not-possible'}
              tone="red"
              onClick={() => pick('not-possible')}
            />
          </div>
        )}
      </div>
      <AnimatePresence>
        {responseModal && (
          <OwnerResponseModal
            kind={responseModal.kind}
            initial={currentResponse}
            onCancel={() => setResponseModal(null)}
            onSave={(text) => {
              setResponseModal(null)
              onApply(responseModal.kind, text)
            }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

function OwnerMenuItem({
  label,
  icon: Icon,
  active,
  tone,
  onClick,
}: {
  label: string
  icon: typeof CheckCircle2
  active: boolean
  tone: 'muted' | 'yellow' | 'sky' | 'red'
  onClick: () => void
}) {
  const toneClass =
    tone === 'yellow'
      ? 'text-yellow-400'
      : tone === 'sky'
        ? 'text-sky-400'
        : tone === 'red'
          ? 'text-red-400'
          : 'text-fg-muted'
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center gap-2 px-3 py-2 text-right text-[11px] transition-colors hover:bg-white/[0.05] ' +
        (active ? 'bg-white/[0.04]' : '')
      }
    >
      <Icon className={'h-3 w-3 shrink-0 ' + toneClass} />
      <span className="flex-1 text-fg">{label}</span>
      {active && <Check className="h-3 w-3 text-fg-muted/70" />}
    </button>
  )
}

function OwnerResponseModal({
  kind,
  initial,
  onCancel,
  onSave,
}: {
  kind: 'question' | 'not-possible'
  initial: string
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [text, setText] = useState(initial)
  const isQuestion = kind === 'question'
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div
              className={
                'text-[10px] font-medium uppercase tracking-[0.16em] ' +
                (isQuestion ? 'text-sky-400' : 'text-red-400')
              }
            >
              {isQuestion ? 'שאלה ללקוח' : 'תיקון לא אפשרי'}
            </div>
            <div className="mt-1 text-sm font-medium text-fg">
              {isQuestion
                ? 'מה תרצו לשאול את הלקוח?'
                : 'הסבירו למה לא ניתן לבצע'}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="סגירה"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            rows={4}
            placeholder={
              isQuestion
                ? 'לדוגמה: באיזה גוון בדיוק להחליף את הצבע?'
                : 'לדוגמה: הפריים המבוקש לא קיים בחומר הגולמי.'
            }
            className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-[11px] leading-relaxed text-fg-muted">
            הטקסט הזה יוצג ללקוח מתחת לתיקון.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/5 bg-white/[0.015] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={() => onSave(text.trim())}
            disabled={!text.trim()}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
          >
            <Check className="h-4 w-4" />
            שמירה
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
