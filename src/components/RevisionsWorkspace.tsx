/** No hard per-file upload cap — the only limit is the account's
 *  storage quota (enforced server-side at r2-upload-init). Kept as
 *  Infinity so the existing `> MAX_UPLOAD_BYTES` guards compile and
 *  simply never trigger; the quota gate does the real work. */
const MAX_UPLOAD_BYTES = Number.POSITIVE_INFINITY

/**
 * RevisionsWorkspace — the editor side of the Revisions feature
 * for the web. Replaces the WorkspacePlaceholder once the user
 * is authenticated AND Pro.
 *
 * LOOK: this is a markup/class port of the DESKTOP app's revisions tab
 * (src/pages/RevisionsPage.tsx + src/components/revisions/* in the app
 * repo). Everything renders inside `.app-ui`, which switches on the
 * app's own Tailwind build (tailwind.app.config.js + styles/app-ui.css),
 * so the desktop classes (bg-primary/15, text-muted-foreground,
 * border-white/5 …) resolve to the app's exact values. Web-only pieces
 * (browser upload progress, Drive-link import, Drive OAuth in a new tab)
 * are drawn in the same vocabulary.
 *
 * LOGIC: unchanged from the previous web workspace — same API calls and
 * payloads, uploads, OAuth signals, live listener + fetch fallback,
 * optimistic note status, keyboard shortcuts.
 *
 * Three top-level states:
 *
 *   1. Drive backend, not connected → ConnectDriveEmptyState (single
 *      CTA that pops the OAuth flow, polls for return).
 *   2. Connected, no projects → empty state with "צרו את הפרויקט הראשון".
 *   3. Connected, with projects → project cards + storage footer, and
 *      the round detail view (notes browser) when a round is opened.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import '../styles/app-ui.css'
import { VoiceNotePlayer } from './workspace/revisions/VoiceNotePlayer'
import { renderNoteText } from '../lib/noteFormat'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Circle,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileVideo,
  FolderClosed,
  FolderOpen,
  HardDrive,
  Hash,
  History,
  Link2 as LinkIcon,
  Loader2,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Replace,
  Shield,
  Stamp,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { pickVideoFromDrive, type PickedDriveFile } from '../lib/drivePicker'
import {
  addRoundToGroup,
  buildOauthStartUrl,
  buildShareUrl,
  createEmptyProjectGroup,
  createProjectGroup,
  deleteGroup,
  deleteLegacyProject,
  deleteRound,
  disconnectDrive,
  fetchDriveAccessToken,
  fetchDriveStorage,
  fetchOAuthStatus,
  fetchStorageState,
  importDriveLinkToR2,
  fetchNoteMediaAsObjectUrl,
  formatBytes,
  formatStorageSize,
  listGroupsForOwner,
  listRoundsForOwner,
  listNotesAsOwner,
  readVideoDims,
  touchWebSeenOnce,
  replaceProjectVideo,
  updateGroup,
  updateNoteStatus,
  updateProjectLock,
  type DriveIntegration,
  type DriveStorage,
  type GroupRoundSummary,
  type LegacyProjectSummary,
  type NoteStatus,
  type OwnerNote,
  type RevisionGroup,
} from '../lib/revisionsApi'
import {
  ensureProjectFolders,
  setShareablePermissions,
  uploadFileToDrive,
  type UploadProgress,
} from '../lib/driveUpload'
import { uploadFileToR2 } from '../lib/r2Upload'

/* ──────────────────────────────────────────────────────────────
 *  Dual-backend upload helper — uploads one round's video to the
 *  user's storage backend and returns the pointer to store on the
 *  round doc (r2Key for R2, driveFileId+driveFolderId for Drive)
 *  plus the file metadata. Shared by the create / add-round /
 *  replace flows so the per-backend branching lives in one place.
 * ────────────────────────────────────────────────────────────── */
type UploadPointer = {
  r2Key?: string
  driveFileId?: string
  driveFolderId?: string
}

async function uploadRoundVideo(
  backend: 'r2' | 'drive',
  source: VideoSource,
  signal: AbortSignal,
  setProgress: (p: UploadProgress | null) => void,
): Promise<{
  pointer: UploadPointer
  videoFileName: string
  videoSizeBytes: number
  videoMime: string
  videoWidth?: number
  videoHeight?: number
}> {
  if (backend === 'drive') {
    const at = await fetchDriveAccessToken()
    if (signal.aborted) throw new Error('ההעלאה בוטלה')
    const folders = await ensureProjectFolders(at.accessToken)
    if (signal.aborted) throw new Error('ההעלאה בוטלה')
    if (source.kind === 'upload') {
      const dims = await readVideoDims(source.file)
      const upload = await uploadFileToDrive({
        accessToken: at.accessToken,
        file: source.file,
        folderId: folders.videosFolderId,
        onProgress: setProgress,
        signal,
      })
      await setShareablePermissions(at.accessToken, upload.driveFileId)
      return {
        pointer: {
          driveFileId: upload.driveFileId,
          driveFolderId: folders.videosFolderId,
        },
        videoFileName: source.file.name,
        videoSizeBytes: source.file.size,
        videoMime: source.file.type || 'video/mp4',
        videoWidth: dims.width || undefined,
        videoHeight: dims.height || undefined,
      }
    }
    if (source.kind === 'drive') {
      await setShareablePermissions(at.accessToken, source.picked.id)
      return {
        pointer: {
          driveFileId: source.picked.id,
          driveFolderId: folders.videosFolderId,
        },
        videoFileName: source.picked.name,
        videoSizeBytes: source.picked.sizeBytes,
        videoMime: source.picked.mimeType || 'video/mp4',
      }
    }
    throw new Error('לא נבחר קובץ')
  }

  // R2 backend (default): import-by-link runs entirely server/worker
  // side (Drive → Cloudflare → R2), so there's nothing to stream from
  // the browser. Report indeterminate progress while it runs.
  if (source.kind === 'link') {
    setProgress({ bytesUploaded: 0, totalBytes: 0, fraction: 0 })
    const imported = await importDriveLinkToR2(source.url)
    setProgress({ bytesUploaded: 1, totalBytes: 1, fraction: 1 })
    return {
      pointer: { r2Key: imported.r2Key },
      videoFileName: imported.videoFileName,
      videoSizeBytes: imported.videoSizeBytes,
      videoMime: imported.videoMime,
      videoWidth: imported.videoWidth || undefined,
      videoHeight: imported.videoHeight || undefined,
    }
  }
  if (source.kind !== 'upload') {
    throw new Error(
      'ייבוא מ-Drive זמין רק במצב Google Drive. העלו קובץ מהמחשב',
    )
  }
  // Show the progress bar IMMEDIATELY so the click gives instant
  // feedback. This first sliver is the storage-space check, not real
  // bytes — only after it passes does the actual upload move the bar.
  setProgress({
    bytesUploaded: 0,
    totalBytes: source.file.size,
    fraction: 0.03,
  })
  // Pre-flight quota check BEFORE any bytes leave the browser, so a
  // too-big file is rejected up front instead of "starting" then
  // failing. Best-effort: if we can't read the quota we fall through and
  // let the server's r2-upload-init gate decide.
  try {
    const st = await fetchStorageState()
    if (st && typeof st.limitBytes === 'number') {
      const free = Math.max(0, st.limitBytes - st.usedBytes)
      if (source.file.size > free) {
        const GB = 1024 * 1024 * 1024
        throw new Error(
          `אין מספיק מקום אחסון. הקובץ שוקל ${(source.file.size / GB).toFixed(
            2,
          )}GB, ובשימוש כבר ${(st.usedBytes / GB).toFixed(2)}GB מתוך ${(
            st.limitBytes / GB
          ).toFixed(2)}GB. מחקו סבבים ישנים ונסו שוב.`,
        )
      }
    }
  } catch (e) {
    // A real quota rejection (our Error above) must propagate; only a
    // failure to FETCH the quota should be swallowed.
    if (e instanceof Error && e.message.includes('אין מספיק מקום')) throw e
  }
  const dims = await readVideoDims(source.file)
  const up = await uploadFileToR2(source.file, {
    signal,
    onProgress: (f) =>
      setProgress({
        bytesUploaded: Math.round(f * source.file.size),
        totalBytes: source.file.size,
        fraction: f,
      }),
  })
  return {
    pointer: { r2Key: up.key },
    videoFileName: source.file.name,
    videoSizeBytes: up.sizeBytes || source.file.size,
    videoMime: source.file.type || 'video/mp4',
    videoWidth: dims.width || undefined,
    videoHeight: dims.height || undefined,
  }
}

/* ══════════════════════════════════════════════════════════════
 *  ROOT
 * ══════════════════════════════════════════════════════════════ */

export function RevisionsWorkspace() {
  // `.app-ui` switches on the desktop app's Tailwind build for
  // everything inside. Utilities placed on this element itself don't
  // apply (they're emitted as `.app-ui .x`), so all layout lives on
  // children.
  return (
    <div className="app-ui">
      <RevisionsWorkspaceContent />
    </div>
  )
}

function RevisionsWorkspaceContent() {
  // `undefined` = still loading. `null` = not connected. Object = connected.
  // Three-state split prevents the empty-state from flashing during the
  // initial fetch on a returning user who's already connected.
  const [drive, setDrive] = useState<DriveIntegration | null | undefined>(undefined)
  const [backend, setBackend] = useState<'r2' | 'drive' | undefined>(undefined)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // ONE oauth-status request returns both the Drive integration and
      // the storage backend (was two separate POSTs — the main driver of
      // /api/revisions request volume).
      const { drive: d, backend: b } = await fetchOAuthStatus()
      if (!cancelled) {
        setDrive(d)
        setBackend(b)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const requestRefresh = useCallback(() => {
    setRefreshKey((n) => n + 1)
  }, [])

  if (drive === undefined || backend === undefined) {
    return <LoadingState />
  }

  // Only the Google-Drive backend requires a connected Drive account.
  // R2 users (the default) go straight to the workspace — their videos
  // upload to our own storage, no Google account needed.
  if (backend === 'drive' && drive === null) {
    return <ConnectDriveEmptyState onRequestRefresh={requestRefresh} />
  }

  return (
    <ConnectedWorkspace
      drive={drive}
      backend={backend}
      onDisconnected={() => setDrive(null)}
    />
  )
}

/* Quick spinner while oauth-status resolves (desktop: LoadingState). */
function LoadingState() {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="טוען" />
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ConnectDriveEmptyState — Drive backend, not connected yet.
 *  Markup = the desktop's ConnectDriveEmptyState; logic = the web's
 *  (OAuth in a new tab + BroadcastChannel / storage / focus signals +
 *  a slow fallback poll).
 * ────────────────────────────────────────────────────────────── */

function ConnectDriveEmptyState({
  onRequestRefresh,
}: {
  onRequestRefresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When true, fires `onRequestRefresh` every 8s for up to 5min
  // after we open the OAuth tab. Once the parent sees `connected`
  // it unmounts us, automatically clearing the polling effect.
  const [waitingForOAuth, setWaitingForOAuth] = useState(false)

  // OAuth-completion listeners — wired ALWAYS, not just while
  // waitingForOAuth is true. Reason: it's racy to only start
  // listening AFTER the popup opens. If the popup runs its
  // window.close() broadcast before this effect's setup completes
  // (or before React re-renders after setWaitingForOAuth(true)),
  // the message arrives in a tab with no listener and gets lost
  // forever. Setting them up on mount means they're already in
  // place by the time any popup can fire. Cost is near-zero —
  // these are passive listeners, not polling.
  useEffect(() => {
    // BroadcastChannel: ideal path. Popup posts {kind:'connected'}
    // right before window.close() (see pages/RevisionsPage.tsx).
    const channel = (() => {
      try {
        return new BroadcastChannel('dmplus-revisions-oauth')
      } catch {
        return null
      }
    })()
    if (channel) {
      channel.onmessage = (e) => {
        if ((e.data as { kind?: string })?.kind === 'connected') {
          onRequestRefresh()
        }
      }
    }
    // localStorage 'storage' event: backup for BroadcastChannel
    // (fires in OTHER tabs of the same origin when a value is set).
    // Works even when BroadcastChannel is unavailable (old Safari),
    // and even when the popup's React bundle is a stale cached
    // version that knows about localStorage but not BroadcastChannel.
    // We use a transient key so we don't accumulate localStorage
    // garbage — set then immediately delete in the popup.
    function onStorage(e: StorageEvent) {
      if (e.key === 'dmplus.revisions.oauth.signal' && e.newValue) {
        onRequestRefresh()
      }
    }
    window.addEventListener('storage', onStorage)
    // visibilitychange + focus: user returning to this tab from
    // the popup (whether the popup auto-closed cleanly or they
    // closed it manually). Two separate events because browsers
    // fire them inconsistently — Firefox fires only focus on tab
    // switch, Chrome fires both. Cover both to be safe.
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        onRequestRefresh()
      }
    }
    function onFocus() {
      onRequestRefresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      if (channel) channel.close()
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [onRequestRefresh])

  // Active polling — only while waitingForOAuth, as a last-ditch
  // fallback if all the event-based mechanisms above somehow miss
  // the connection signal. Capped at 5 minutes so the polling
  // dies if the user abandons the flow. Interval kept deliberately
  // slow (8s): OAuth completion is normally caught instantly by the
  // event listeners above, so this only exists for the rare miss —
  // no need to hammer oauth-status every 2s.
  useEffect(() => {
    if (!waitingForOAuth) return
    const interval = window.setInterval(() => onRequestRefresh(), 8000)
    const timeout = window.setTimeout(
      () => {
        setWaitingForOAuth(false)
        setBusy(false)
      },
      5 * 60_000,
    )
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(timeout)
    }
  }, [waitingForOAuth, onRequestRefresh])

  function handleConnect() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const url = buildOauthStartUrl()
      // Open in a new tab so the workspace tab stays mounted and
      // the polling effect below can detect the connection flip
      // without a full page navigation. noopener so the OAuth tab
      // can't reach back into ours (defence in depth).
      const popup = window.open(url, '_blank', 'noopener')
      if (!popup) {
        throw new Error(
          'הדפדפן חסם פתיחה של חלון חדש. אפשרו חלונות קופצים לאתר הזה ונסו שוב.',
        )
      }
      setWaitingForOAuth(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'פתיחת החלון נכשלה')
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-8 text-center">
      <div className="mx-auto flex max-w-2xl flex-col items-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="mb-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"
        >
          <MessageSquare className="h-8 w-8" strokeWidth={1.8} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
        >
          — סבבי תיקונים
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-4 font-display text-3xl font-extrabold tracking-tight text-foreground md:text-4xl"
          style={{ letterSpacing: '-0.02em' }}
        >
          <span className="block">קבלו תיקונים מלקוחות</span>
          <span className="block text-primary">בלי כאבי ראש</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.15 }}
          className="mb-10 max-w-lg text-base leading-relaxed text-muted-foreground md:text-lg"
        >
          שולחים ללקוח קישור אחד. הוא רואה את הסרטון, עוצר
          איפה שיש בעיה, ומסמן בדיוק מה הוא רוצה לתקן.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.25 }}
          className="mb-10 w-full max-w-md space-y-4 text-right"
        >
          <TrustRow
            icon={Cloud}
            title="הכל מאוחסן אצלכם"
            body="הסרטונים עולים ל-Google Drive שלכם, ואצלנו לא נשמר שום קובץ. החומר תמיד שלכם, מאובטח ומסודר במקום אחד שאתם שולטים בו."
          />
          <TrustRow
            icon={Shield}
            title="הגנה על הסרטון"
            body="watermark אוטומטי עם המייל של הלקוח, ואופציה להוסיף סיסמה לקישור. אף אחד לא יוכל להפיץ את הוידאו לפני התשלום."
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="flex flex-col items-center gap-3"
        >
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="group inline-flex min-h-[48px] items-center gap-2.5 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-background shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30 disabled:cursor-not-allowed disabled:bg-primary/50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            {waitingForOAuth
              ? 'ממתינים לאישור Google…'
              : busy
                ? 'פותח חלון…'
                : 'התחברו עם Google Drive'}
          </button>

          {waitingForOAuth && (
            <p className="text-[12px] text-muted-foreground">
              השלימו את החיבור בחלון שנפתח. החיבור יזוהה כאן אוטומטית.
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden />
            ההרשאה היחידה שנבקש: גישה לקבצים שהאפליקציה יוצרת.
          </p>
        </motion.div>
      </div>
    </div>
  )
}

function TrustRow({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Cloud
  title: string
  body: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {body}
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ConnectedWorkspace — project list + round detail + modals
 * ────────────────────────────────────────────────────────────── */

interface Projects {
  groups: RevisionGroup[]
  legacy: LegacyProjectSummary[]
}

function ConnectedWorkspace({
  drive,
  backend,
  onDisconnected,
}: {
  // null when the user is on the R2 backend and hasn't connected Drive
  // (which is fine — Drive isn't needed for R2 uploads).
  drive: DriveIntegration | null
  backend: 'r2' | 'drive'
  onDisconnected: () => void
}) {
  const [projects, setProjects] = useState<Projects | null>(null)
  const [storage, setStorage] = useState<DriveStorage | null>(null)
  const [r2Storage, setR2Storage] = useState<{
    usedBytes: number
    limitBytes: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [showNewProject, setShowNewProject] = useState(false)
  const [editingGroup, setEditingGroup] = useState<RevisionGroup | null>(null)
  const [addingRoundTo, setAddingRoundTo] = useState<RevisionGroup | null>(null)
  // When set, the list swaps to the round detail view (notes browser).
  // The `round` and `group` give it enough context to fetch notes,
  // render the share URL, and toggle the round's lock state.
  const [viewingRound, setViewingRound] = useState<
    | { group: RevisionGroup; round: GroupRoundSummary }
    | { legacy: LegacyProjectSummary }
    | null
  >(null)
  // Replace-video modal — opened from inside the round detail
  // view. The projectId is the round id (or the legacy project id);
  // the modal handles the upload + replace-project-video call.
  const [replacingProject, setReplacingProject] = useState<{
    projectId: string
    currentName: string
  } | null>(null)

  const reload = useCallback(() => setRefreshTick((n) => n + 1), [])

  // ── Project list — real-time PUSH listener ────────────────────
  //
  // Stamp the website "last seen" once on entering the workspace
  // (covers users already logged in who just open revisions). The
  // helper itself is guarded to fire at most once per tab session.
  useEffect(() => {
    touchWebSeenOnce()
  }, [])

  // Mirrors the desktop: one read on attach (tab entry), one read per
  // changed doc, zero at idle. No polling. A viewer adding a note or
  // a round being added pushes straight here. If the live session
  // can't be established (custom-token mint failed, etc.) we fall
  // back to a single fetch so the list still loads. Keyed on
  // refreshTick so the error-retry button + post-mutation reload()
  // re-attach with fresh data.
  useEffect(() => {
    let cancelled = false
    let gotLive = false
    let unsub: (() => void) | null = null
    // Dynamically import the live layer so the Firebase Web SDK is
    // code-split into its own chunk — it loads only when the editor
    // opens the workspace, keeping every other page (home, /buy, …)
    // free of the ~110KB Firebase weight.
    void (async () => {
      const { watchOwnerRevisionsLive } = await import('../lib/revisionsLive')
      if (cancelled) return
      unsub = watchOwnerRevisionsLive(
        (data) => {
          if (cancelled) return
          gotLive = true
          setError(null)
          setProjects({ groups: data.groups, legacy: data.legacyProjects })
        },
        (err) => {
          // Live unavailable — one-shot fetch fallback (unless a live
          // snapshot already landed before the error).
          console.warn('[workspace] live unavailable, falling back to fetch:', err)
          if (cancelled || gotLive) return
          void (async () => {
            try {
              const data = await listGroupsForOwner()
              if (cancelled) return
              setProjects({ groups: data.groups, legacy: data.legacyProjects })
            } catch (e) {
              if (cancelled) return
              setError(e instanceof Error ? e.message : 'טעינה נכשלה')
            }
          })()
        },
      )
    })()
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [refreshTick])

  // ── Drive storage number ──────────────────────────────────────
  // Fetched on mount + after mutations (reload bumps refreshTick).
  // Not on the live listener — it only changes on upload/delete.
  useEffect(() => {
    // Drive storage quota only applies to the Drive backend.
    if (!drive) return
    let cancelled = false
    void (async () => {
      const s = await fetchDriveStorage()
      if (!cancelled) setStorage(s)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshTick, drive])

  // R2 storage usage + quota (our own storage). Refreshed after every
  // upload/delete via refreshTick.
  useEffect(() => {
    if (backend !== 'r2') return
    let cancelled = false
    void (async () => {
      const s = await fetchStorageState()
      if (!cancelled) setR2Storage(s)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshTick, backend])

  const isEmpty =
    !!projects && projects.groups.length === 0 && projects.legacy.length === 0

  // Project list body — loading / error / empty / populated.
  let listBody: React.ReactNode
  if (error) {
    listBody = (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-center text-xs text-destructive">
        <div>{error}</div>
        <button
          type="button"
          onClick={reload}
          className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white/[0.06]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          ניסיון נוסף
        </button>
      </div>
    )
  } else if (!projects) {
    listBody = (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="טוען" />
      </div>
    )
  } else if (isEmpty) {
    listBody = (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-14 text-center">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <MessageSquare className="h-6 w-6" strokeWidth={1.8} />
        </div>
        <h2 className="mb-2 text-base font-medium text-foreground">
          אין עדיין פרויקטים
        </h2>
        <p className="mb-6 max-w-md text-xs leading-relaxed text-muted-foreground">
          לחצו על "פרויקט חדש" כדי להעלות סרטון ולקבל קישור
          לשליחה ללקוח.
        </p>
        <button
          type="button"
          onClick={() => setShowNewProject(true)}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white/[0.06]"
        >
          <Plus className="h-3.5 w-3.5" />
          צרו את הפרויקט הראשון
        </button>
      </div>
    )
  } else {
    listBody = (
      <ProjectList
        projects={projects}
        backend={backend}
        onEditGroup={(g) => setEditingGroup(g)}
        onAddRound={(g) => setAddingRoundTo(g)}
        onOpenRound={(g, round) => setViewingRound({ group: g, round })}
        onOpenLegacy={(p) => setViewingRound({ legacy: p })}
        onMutated={reload}
      />
    )
  }

  // When the editor opened a round to browse its notes, the
  // workspace area swaps to a full-page detail view. AnimatePresence
  // handles the two-way transition so going BACK to the list also
  // animates instead of snapping.
  return (
    <div className="relative">
      <AnimatePresence mode="wait" initial={false}>
        {viewingRound ? (
          <motion.div
            key="detail"
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <RoundDetailView
              target={viewingRound}
              liveNotesCount={(() => {
                // Live note count for THIS round, read from the
                // push-updated projects state. When a viewer adds a
                // note the rounds listener bumps this, and the detail
                // view re-fetches its notes so the new one appears
                // without a manual refresh.
                if (!projects) return undefined
                if ('legacy' in viewingRound) {
                  return projects.legacy.find(
                    (p) => p.id === viewingRound.legacy.id,
                  )?.notesCount
                }
                // The list listener is groups-only now (lazy-load), so
                // the group object usually has no loaded rounds. When it
                // does (a recently opened card), use the live count;
                // otherwise undefined → the detail view keeps the count
                // it fetched on open.
                return projects.groups
                  .find((g) => g.id === viewingRound.group.id)
                  ?.rounds?.find((r) => r.id === viewingRound.round.id)
                  ?.notesCount
              })()}
              onBack={() => setViewingRound(null)}
              onLockChanged={() => {
                reload()
                setViewingRound(null)
              }}
              onRequestReplaceVideo={(projectId, currentName) =>
                setReplacingProject({ projectId, currentName })
              }
            />
          </motion.div>
        ) : (
          <motion.div
            key="list"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="mx-auto w-full max-w-4xl px-6 pb-8 pt-2 md:pb-10 md:pt-4">
              {/* Header — title on the right (RTL start), primary CTA
                  on the left. The storage usage sits as one slim line
                  under the title (part of the page, not a floating bar). */}
              <header className="mb-8">
                <div className="flex items-end justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      — סבבי תיקונים
                    </div>
                    <h1
                      className="font-display text-2xl font-extrabold tracking-tight text-foreground md:text-3xl"
                      style={{ letterSpacing: '-0.02em' }}
                    >
                      הפרויקטים שלכם
                    </h1>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowNewProject(true)}
                    className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90"
                  >
                    <Plus className="h-4 w-4" strokeWidth={2.5} />
                    פרויקט חדש
                  </button>
                </div>
                <StorageMeter
                  backend={backend}
                  drive={drive}
                  driveStorage={storage}
                  r2Storage={r2Storage}
                  onDisconnected={onDisconnected}
                />
              </header>

              {listBody}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modals — wrapped in AnimatePresence so they fade out
          cleanly when dismissed. The conditional render inside
          determines mount/unmount; framer-motion handles the
          transition lifecycle. */}
      <AnimatePresence>
        {showNewProject && (
          <NewProjectModal
            key="new"
            backend={backend}
            onClose={() => setShowNewProject(false)}
            onCreated={() => {
              setShowNewProject(false)
              reload()
            }}
          />
        )}
        {editingGroup && (
          <EditGroupModal
            key="edit"
            group={editingGroup}
            backend={backend}
            onClose={() => setEditingGroup(null)}
            onSaved={() => {
              setEditingGroup(null)
              reload()
            }}
          />
        )}
        {addingRoundTo && (
          <AddRoundModal
            key="addround"
            backend={backend}
            group={addingRoundTo}
            onClose={() => setAddingRoundTo(null)}
            onAdded={() => {
              setAddingRoundTo(null)
              reload()
            }}
          />
        )}
        {replacingProject && (
          <ReplaceVideoModal
            key="replace"
            backend={backend}
            projectId={replacingProject.projectId}
            currentName={replacingProject.currentName}
            onClose={() => setReplacingProject(null)}
            onReplaced={() => {
              setReplacingProject(null)
              reload()
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ProjectList — groups + legacy in one chronological list
 * ────────────────────────────────────────────────────────────── */

function ProjectList({
  projects,
  backend,
  onEditGroup,
  onAddRound,
  onOpenRound,
  onOpenLegacy,
  onMutated,
}: {
  projects: Projects
  backend: 'r2' | 'drive'
  onEditGroup: (g: RevisionGroup) => void
  onAddRound: (g: RevisionGroup) => void
  onOpenRound: (g: RevisionGroup, round: GroupRoundSummary) => void
  onOpenLegacy: (p: LegacyProjectSummary) => void
  /** A delete succeeded — the parent reloads the list + storage. */
  onMutated: () => void
}) {
  // Merge groups + legacy into a single chronological list. We
  // sort by updatedAt DESC, same as the server-side ordering, but
  // re-sorting in JS lets us interleave the two collections.
  type Item =
    | { kind: 'group'; group: RevisionGroup; ts: number }
    | { kind: 'legacy'; project: LegacyProjectSummary; ts: number }
  const items: Item[] = [
    ...projects.groups.map(
      (g): Item => ({ kind: 'group', group: g, ts: g.updatedAt }),
    ),
    ...projects.legacy.map(
      (p): Item => ({ kind: 'legacy', project: p, ts: p.updatedAt }),
    ),
  ].sort((a, b) => b.ts - a.ts)

  return (
    <ul className="space-y-3">
      {items.map((item) =>
        item.kind === 'group' ? (
          <li key={`g-${item.group.id}`}>
            <GroupCard
              group={item.group}
              backend={backend}
              onEdit={() => onEditGroup(item.group)}
              onAddRound={() => onAddRound(item.group)}
              onOpenRound={(round) => onOpenRound(item.group, round)}
              onMutated={onMutated}
            />
          </li>
        ) : (
          <li key={`l-${item.project.id}`}>
            <LegacyCard
              project={item.project}
              onOpen={() => onOpenLegacy(item.project)}
              onMutated={onMutated}
            />
          </li>
        ),
      )}
    </ul>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  Shared bits — copy-to-clipboard + the app's icon button
 * ────────────────────────────────────────────────────────────── */

function useCopyLink(url: string) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Older browsers or insecure contexts — fall back to
      // selecting the URL so the user can copy manually.
      window.prompt('העתיקו את הקישור:', url)
    }
  }
  return { copied, copy }
}

const ICON_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors '
const ICON_BTN_IDLE = 'text-muted-foreground hover:bg-white/5 hover:text-foreground '
const ICON_BTN_OK = 'bg-success/15 text-success '

/* ──────────────────────────────────────────────────────────────
 *  GroupCard — one project, share link always visible, expandable
 *  rounds tray (desktop: ProjectGroupCard).
 * ────────────────────────────────────────────────────────────── */

function GroupCard({
  group,
  backend,
  onEdit,
  onAddRound,
  onOpenRound,
  onMutated,
}: {
  group: RevisionGroup
  backend: 'r2' | 'drive'
  onEdit: () => void
  onAddRound: () => void
  onOpenRound: (round: GroupRoundSummary) => void
  onMutated: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shareUrl = buildShareUrl(group.shareToken)
  const { copied, copy } = useCopyLink(shareUrl)
  const [confirmingProjectDelete, setConfirmingProjectDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // LAZY-LOAD: the list listener delivers groups WITHOUT their rounds
  // (only a denormalised `group.roundCount`). We fetch this project's
  // rounds the first time it's expanded, and re-fetch whenever the
  // group's updatedAt changes while open (add-round / delete-round
  // bump it) so the list never shows a stale round.
  // Start "not loaded" — the list ships groups WITHOUT real rounds
  // (live: undefined, REST: []), so we always fetch on first expand.
  const [rounds, setRounds] = useState<GroupRoundSummary[] | null>(
    group.rounds && group.rounds.length > 0 ? group.rounds : null,
  )
  const [loadingRounds, setLoadingRounds] = useState(false)
  const [roundsError, setRoundsError] = useState<string | null>(null)
  const loadedForRef = useRef<number | null>(null)

  // Note: re-opening a finalized round (undoing the client's "ready
  // to fix" marker) is NOT a list-level action. The editor does it
  // from inside the round itself, via the red/green lock button in
  // the detail view — unlocking there also clears the "ready" marker
  // server-side.

  useEffect(() => {
    if (!expanded) return
    // Already have the rounds for this exact group revision — skip.
    if (rounds !== null && loadedForRef.current === group.updatedAt) return
    let cancelled = false
    setLoadingRounds(true)
    setRoundsError(null)
    void (async () => {
      try {
        const rs = await listRoundsForOwner(group.id)
        if (cancelled) return
        setRounds(rs)
        loadedForRef.current = group.updatedAt
      } catch (e) {
        if (cancelled) return
        setRoundsError(e instanceof Error ? e.message : 'טעינת הסבבים נכשלה')
      } finally {
        if (!cancelled) setLoadingRounds(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, group.id, group.updatedAt])

  // Count for the header: prefer the freshly loaded rounds, fall back
  // to the denormalised count the list already carries.
  const roundCount = rounds?.length ?? group.roundCount
  // Badges are driven off loaded rounds — hidden until the card has
  // been expanded at least once (no extra reads to populate them).
  const totalNotes = (rounds ?? []).reduce((sum, r) => sum + r.notesCount, 0)
  const anyLocked = (rounds ?? []).some((r) => r.locked)

  // Decide the project-delete UX from what's ACTUALLY being deleted,
  // not the account's current backend:
  //   'r2'    → everything is in our storage; one irreversible confirm.
  //   'drive' → it's on Google Drive; offer the Drive-trash opt-in.
  //   'mixed' → a project with BOTH kinds of rounds; delete everything
  //             (including Drive) and just say so.
  const groupStorages = (rounds ?? [])
    .map((r) => r.storage)
    .filter((s): s is 'r2' | 'drive' => Boolean(s))
  const hasR2 = groupStorages.includes('r2')
  const hasDrive = groupStorages.includes('drive')
  const projectDeleteMode: 'r2' | 'drive' | 'mixed' =
    hasR2 && hasDrive ? 'mixed' : hasR2 ? 'r2' : 'drive'

  async function handleDeleteGroup(deleteDrive: boolean) {
    if (busy) return
    setBusy(true)
    setActionError(null)
    // Force Drive trash for mixed projects; never for pure-R2; user's
    // choice for pure-Drive.
    const effectiveDeleteDrive =
      projectDeleteMode === 'mixed'
        ? true
        : projectDeleteMode === 'r2'
          ? false
          : deleteDrive
    const result = await deleteGroup(group.id, effectiveDeleteDrive)
    setBusy(false)
    if (!result.ok) {
      setActionError(result.error || 'המחיקה נכשלה')
      return
    }
    setConfirmingProjectDelete(false)
    onMutated()
  }

  async function handleDeleteRound(
    round: GroupRoundSummary,
    deleteDrive: boolean,
  ): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setActionError(null)
    // R2 rounds never touch Drive; Drive rounds follow the user's pick.
    const effectiveDeleteDrive = round.storage === 'r2' ? false : deleteDrive
    const result = await deleteRound(round.id, effectiveDeleteDrive)
    setBusy(false)
    if (!result.ok) {
      setActionError(result.error || 'המחיקה נכשלה')
      return false
    }
    onMutated()
    return true
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden rounded-xl border border-white/5 bg-white/[0.02]"
    >
      {/* Header — clickable, toggles expanded state. Whole-row hit
          area so the editor doesn't have to aim at a tiny chevron. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'כיווץ פרויקט' : 'הרחבת פרויקט'}
        className="block w-full cursor-pointer rounded-t-xl px-4 pb-2 pt-4 text-right transition-colors hover:bg-white/[0.015]"
      >
        {/* flex-wrap + a minimum title width only matter on phones: the
            badges drop under the title instead of squeezing it away. */}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 sm:flex-nowrap">
          <div className="min-w-[60%] flex-1 sm:min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <FolderClosed className="h-3 w-3" strokeWidth={2} />
              </span>
              <h3 className="truncate text-sm font-medium text-foreground">
                {group.title || 'ללא שם'}
              </h3>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                · {roundCount} {roundCount === 1 ? 'סבב' : 'סבבים'}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              עודכן {formatRelative(group.updatedAt)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {anyLocked && (
              <span
                title="לפחות סבב אחד נעול לתיקונים"
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400"
              >
                <Lock className="h-2.5 w-2.5" />
                נעול
              </span>
            )}
            {group.hasPassword && (
              <span
                title="הפרויקט מוגן בסיסמה"
                className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent"
              >
                <Lock className="h-2.5 w-2.5" />
                סיסמה
              </span>
            )}
            {totalNotes > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                <MessageSquare className="h-2.5 w-2.5" />
                {totalNotes}
              </span>
            )}
            {!expanded && (
              <span className="hidden text-[11px] font-medium text-primary/80 sm:inline">
                לפתיחת הפרויקט לחצו כאן
              </span>
            )}
            <ChevronDown
              className={
                'h-3.5 w-3.5 text-muted-foreground/40 transition-transform ' +
                (expanded ? 'rotate-180' : '')
              }
              aria-hidden
            />
          </div>
        </div>
      </button>

      {/* Share URL + copy / open / edit — always visible (the URL is
          the single most-used affordance, hiding it behind expand is
          friction). */}
      <div className="px-4 pb-3">
        <div className="mt-2 flex items-center justify-between gap-2">
          <div
            dir="ltr"
            className="min-w-0 flex-1 truncate rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-mono text-[11px]"
            title={shareUrl}
          >
            {shareUrl}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={copied ? 'הועתק' : 'העתקת קישור'}
              title={copied ? 'הועתק' : 'העתקת קישור'}
              className={ICON_BTN + (copied ? ICON_BTN_OK : ICON_BTN_IDLE)}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="פתיחת קישור"
              title="פתיחת קישור"
              className={ICON_BTN + ICON_BTN_IDLE}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={onEdit}
              aria-label="עריכת פרויקט"
              title="עריכת פרויקט"
              className={ICON_BTN + ICON_BTN_IDLE}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Expanded body — rounds list + add-round / delete-project row.
          AnimatePresence keeps the exit animation alive long enough to
          collapse the height smoothly. */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="expanded"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/5 px-4 py-3">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                סבבי תיקונים
              </div>
              {loadingRounds && rounds === null ? (
                <div className="flex items-center justify-center rounded-lg border border-white/5 bg-white/[0.015] px-3 py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : roundsError ? (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-4 text-center text-[11px] text-destructive">
                  {roundsError}
                </div>
              ) : (rounds ?? []).length === 0 ? (
                <div className="rounded-lg border border-white/5 bg-white/[0.015] px-3 py-4 text-center text-[11px] text-muted-foreground">
                  אין סבבים בפרויקט. לחצו "סבב חדש" כדי להוסיף אחד.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {[...(rounds ?? [])]
                    .sort((a, b) => b.roundNumber - a.roundNumber)
                    .map((round) => (
                      <li key={round.id}>
                        <RoundRow
                          round={round}
                          backend={backend}
                          onOpen={() => onOpenRound(round)}
                          onDelete={(includeDrive) =>
                            handleDeleteRound(round, includeDrive)
                          }
                          busy={busy}
                        />
                      </li>
                    ))}
                </ul>
              )}

              {actionError && (
                <div
                  role="alert"
                  className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
                >
                  {actionError}
                </div>
              )}

              {/* Action row — add round + delete project. Delete has a
                  confirm step (inline, like the app). */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={onAddRound}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-white/[0.08]"
                >
                  <Plus className="h-3 w-3" />
                  סבב חדש
                </button>

                {confirmingProjectDelete ? (
                  projectDeleteMode === 'drive' ? (
                    // All Drive — let the editor opt into Drive trash.
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-destructive">למחוק את הפרויקט?</span>
                      <button
                        type="button"
                        onClick={() => setConfirmingProjectDelete(false)}
                        disabled={busy}
                        className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                      >
                        ביטול
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteGroup(false)}
                        disabled={busy}
                        title="הקבצים נשארים ב-Drive שלכם"
                        className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-white/[0.08] disabled:opacity-50"
                      >
                        מהמערכת בלבד
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteGroup(true)}
                        disabled={busy}
                        title="גם הסרטונים יעברו לפח של Drive (שחזור עד 30 יום)"
                        className="inline-flex items-center gap-1 rounded-md bg-destructive/90 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-destructive disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                        גם מ-Drive
                      </button>
                    </div>
                  ) : (
                    // R2 or mixed — single irreversible confirm. Mixed
                    // forces Drive trash too.
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-destructive">
                        {projectDeleteMode === 'mixed'
                          ? 'יש סבבים גם ב-Drive וגם באחסון. הכל יימחק. לא ניתן לשחזר.'
                          : 'למחוק את הפרויקט? לא ניתן לשחזר.'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmingProjectDelete(false)}
                        disabled={busy}
                        className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                      >
                        ביטול
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteGroup(projectDeleteMode === 'mixed')}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md bg-destructive/90 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-destructive disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                        כן, מחק
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setActionError(null)
                      setConfirmingProjectDelete(true)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                    מחיקת פרויקט
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Round row — one row inside the expanded group card. Click the
 *  row → round detail view. Trash icon → inline confirm strip.
 * ───────────────────────────────────────────────────────────── */
function RoundRow({
  round,
  backend,
  onOpen,
  onDelete,
  busy,
}: {
  round: GroupRoundSummary
  backend: 'r2' | 'drive'
  onOpen: () => void
  /** Resolves true when the delete went through. */
  onDelete: (includeDrive: boolean) => Promise<boolean>
  busy: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  // Badge a round whose video lives on a backend different from the
  // user's current one (e.g. a Drive round shown to an R2 user).
  const offBackend = Boolean(round.storage) && round.storage !== backend
  // R2 round → single irreversible-delete confirm (no Drive opt-in).
  // When the round's storage is unknown (older summaries without the
  // field) treat it as Drive — the safe default that keeps the Drive
  // opt-in so a real Drive file is never silently left behind.
  const isR2Round = round.storage === 'r2'

  async function del(includeDrive: boolean) {
    const ok = await onDelete(includeDrive)
    if (ok) setConfirming(false)
  }

  return (
    <div className="group flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.015] px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-right"
        aria-label={`פתיחת סבב ${round.roundNumber}`}
      >
        <span
          title={`סבב ${round.roundNumber}`}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary"
        >
          <Hash className="h-2.5 w-2.5" />
          {round.roundNumber}
        </span>
        <span
          className="truncate text-[12px] text-foreground"
          dir="ltr"
          title={round.videoFileName}
        >
          {round.videoFileName}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          · <bdi dir="ltr">{formatBytes(round.videoSizeBytes)}</bdi> · {formatRelative(round.createdAt)}
        </span>
        {/* Affordance hint — fills the empty left side of the row so
            it's obvious the whole row opens the revision round. */}
        <span className="ms-auto hidden shrink truncate ps-2 text-[11px] font-medium text-primary/70 sm:inline">
          לפתיחת סבב התיקונים לחצו כאן
        </span>
      </button>

      {offBackend && (
        <span
          title="הסבב הזה לא אוחסן במערכת שאתם משתמשים בה כעת"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] text-amber-400"
        >
          {round.storage === 'drive' ? (
            <HardDrive className="h-2.5 w-2.5" />
          ) : (
            <Cloud className="h-2.5 w-2.5" />
          )}
          {round.storage === 'drive' ? 'Google Drive' : 'CL'}
        </span>
      )}
      {round.clientFinalized && (
        <span
          title={
            round.clientFinalizedBy
              ? `סומן כמוכן על ידי ${round.clientFinalizedBy}`
              : 'הסבב מוכן לתיקונים'
          }
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400"
        >
          <Check className="h-2.5 w-2.5" />
          מוכן לתיקונים
        </span>
      )}
      {round.locked && !round.clientFinalized && (
        <span
          title="סבב נעול"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400"
        >
          <Lock className="h-2.5 w-2.5" />
        </span>
      )}
      {round.notesCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          <MessageSquare className="h-2.5 w-2.5" />
          {round.notesCount}
        </span>
      )}

      {confirming ? (
        isR2Round ? (
          // R2 round: the video + all its media always delete and can't
          // be restored — no Drive opt-in, so a single confirm.
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => void del(false)}
              disabled={busy}
              title="הסרטון וכל מה שקשור אליו יימחקו ולא ניתן לשחזר"
              className="inline-flex items-center gap-0.5 rounded bg-destructive/90 px-2 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-destructive disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Trash2 className="h-2.5 w-2.5" />
              )}
              כן, מחק
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => void del(false)}
              disabled={busy}
              title="הקובץ נשאר ב-Drive"
              className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-foreground transition-colors hover:bg-white/[0.08] disabled:opacity-50"
            >
              מהמערכת
            </button>
            <button
              type="button"
              onClick={() => void del(true)}
              disabled={busy}
              title="גם מ-Drive (לפח, שחזור 30 יום)"
              className="inline-flex items-center gap-0.5 rounded bg-destructive/90 px-1.5 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-destructive disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Trash2 className="h-2.5 w-2.5" />
              )}
              גם מ-Drive
            </button>
          </div>
        )
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="מחיקת סבב"
          title="מחיקת סבב"
          // Hover-revealed like the app; always visible on touch
          // screens (no hover there) and when focused by keyboard.
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  LegacyCard — pre-group-refactor single-round project
 *  (desktop: ProjectCard).
 * ────────────────────────────────────────────────────────────── */

function LegacyCard({
  project,
  onOpen,
  onMutated,
}: {
  project: LegacyProjectSummary
  onOpen: () => void
  onMutated: () => void
}) {
  const shareUrl = buildShareUrl(project.shareToken)
  const { copied, copy } = useCopyLink(shareUrl)
  const [deleteMode, setDeleteMode] = useState<'none' | 'choosing'>('none')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Legacy single-round projects predate R2 — always Drive, so the
  // Drive-trash choice is always offered.
  async function handleDelete(includeDriveFile: boolean) {
    if (deleting) return
    setDeleting(true)
    setError(null)
    const ok = await deleteLegacyProject(project.id, includeDriveFile)
    setDeleting(false)
    if (!ok) {
      setError('המחיקה נכשלה')
      return
    }
    setDeleteMode('none')
    onMutated()
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="group rounded-xl border border-white/5 bg-white/[0.02] transition-colors hover:bg-white/[0.04]"
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full cursor-pointer rounded-t-xl px-4 pb-2 pt-4 text-right transition-colors hover:bg-white/[0.015]"
        aria-label="פתיחת הסבב לתיקונים"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                title={`סבב מספר ${project.roundNumber}`}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary"
              >
                <Hash className="h-2.5 w-2.5" />
                {project.roundNumber}
              </span>
              <h3 className="truncate text-sm font-medium text-foreground">
                {project.title || 'ללא שם'}
              </h3>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="truncate" dir="ltr" title={project.videoFileName}>
                {project.videoFileName}
              </span>
              <span aria-hidden>·</span>
              <span dir="ltr">{formatBytes(project.videoSizeBytes)}</span>
              <span aria-hidden>·</span>
              <span>{formatRelative(project.createdAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {project.locked && (
              <span
                title="הסבב סגור לתיקונים. הלקוח לא יכול להוסיף תיקונים חדשים"
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400"
              >
                <Lock className="h-2.5 w-2.5" />
                נעול
              </span>
            )}
            {project.hasPassword && (
              <span
                title="הסבב מוגן בסיסמה"
                className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent"
              >
                <Lock className="h-2.5 w-2.5" />
                סיסמה
              </span>
            )}
            {project.notesCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                <MessageSquare className="h-2.5 w-2.5" />
                {project.notesCount}
              </span>
            )}
            <span className="hidden text-[11px] font-medium text-primary/80 sm:inline">
              לפתיחת סבב התיקונים לחצו כאן
            </span>
            <ChevronLeft
              className="h-3.5 w-3.5 text-muted-foreground/40 transition-all group-hover:translate-x-[-2px] group-hover:text-muted-foreground"
              aria-hidden
            />
          </div>
        </div>
      </button>

      <div className="px-4 pb-4">
        <div className="mt-3 flex items-center justify-between gap-2">
          <div
            dir="ltr"
            className="min-w-0 flex-1 truncate rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-mono text-[11px]"
            title={shareUrl}
          >
            {shareUrl}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={copied ? 'הועתק' : 'העתקת קישור'}
              title={copied ? 'הועתק' : 'העתקת קישור'}
              className={ICON_BTN + (copied ? ICON_BTN_OK : ICON_BTN_IDLE)}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="פתיחת קישור"
              title="פתיחת קישור"
              className={ICON_BTN + ICON_BTN_IDLE}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={() => {
                setError(null)
                setDeleteMode('choosing')
              }}
              aria-label="מחיקה"
              title="מחיקה"
              className={
                ICON_BTN +
                'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {deleteMode === 'choosing' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mt-3 overflow-hidden"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <div className="text-[11px] leading-relaxed text-destructive">
                <strong className="font-semibold">למחוק את הסבב?</strong>
                <span className="ms-1 text-destructive/80">
                  הקישור יפסיק לעבוד מיד.
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setDeleteMode('none')}
                  disabled={deleting}
                  className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(false)}
                  disabled={deleting}
                  title="הקובץ עצמו נשאר ב-Drive שלכם"
                  className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-white/[0.08] disabled:opacity-50"
                >
                  מהמערכת בלבד
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(true)}
                  disabled={deleting}
                  title="מעביר את הקובץ לפח של Drive, לשחזור עד 30 יום"
                  className="inline-flex items-center gap-1 rounded-md bg-destructive/90 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-destructive disabled:opacity-50"
                >
                  {deleting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  גם מ-Drive
                </button>
              </div>
            </div>
            {error && (
              <div role="alert" className="mt-2 text-[11px] text-destructive">
                {error}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </motion.div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  StorageMeter — one slim line under the page title.
 *    Drive backend: "Google Drive · <email> · used / total ▬ · ניתוק"
 *      (desktop: ConnectionFooter + StorageIndicator), with the inline
 *      disconnect confirm.
 *    R2 backend:    "שטח אחסון בחשבון · used / total ▬"
 *      (desktop: R2StorageFooter's data, drawn as the same compact chip).
 *  Drive details show ONLY for the Drive backend — like the app; an R2
 *  user with an old saved Drive integration sees just our storage.
 * ────────────────────────────────────────────────────────────── */

function StorageMeter({
  backend,
  drive,
  driveStorage,
  r2Storage,
  onDisconnected,
}: {
  backend: 'r2' | 'drive'
  drive: DriveIntegration | null
  driveStorage: DriveStorage | null
  r2Storage: { usedBytes: number; limitBytes: number } | null
  onDisconnected: () => void
}) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDisconnect() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await disconnectDrive()
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'הניתוק נכשל')
      return
    }
    // Even if disconnectDrive's internal try/catch swallowed an
    // error and we got here without throwing, we still flip the UI —
    // the worst case is the user reconnects and overrides the stale
    // Firestore doc. The fail-safe is "the user is OUT of this Drive
    // integration locally", which is what the confirm promised.
    setBusy(false)
    setConfirmingDisconnect(false)
    onDisconnected()
  }

  if (backend === 'drive' && drive) {
    return (
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <HardDrive className="h-3 w-3" aria-hidden />
          <span>Google Drive</span>
          <span aria-hidden>·</span>
          <span dir="ltr" className="font-mono">
            {drive.email}
          </span>
          {driveStorage && <StorageIndicator storage={driveStorage} />}
          <span aria-hidden>·</span>
          {confirmingDisconnect ? (
            <span className="inline-flex items-center gap-1.5">
              <span>לנתק את החיבור?</span>
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={busy}
                className="rounded px-2 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                {busy ? 'מנתק…' : 'כן, נתק'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(false)}
                disabled={busy}
                className="rounded px-2 py-0.5 text-muted-foreground hover:bg-white/5"
              >
                ביטול
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDisconnect(true)}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              ניתוק
            </button>
          )}
        </div>
        {error && (
          <div role="alert" className="mt-1 text-[11px] text-destructive">
            {error}
          </div>
        )}
      </div>
    )
  }

  if (backend === 'r2' && r2Storage) {
    const { usedBytes, limitBytes } = r2Storage
    const pct = limitBytes ? Math.min(100, (usedBytes / limitBytes) * 100) : 0
    const high = pct >= 95
    const med = pct >= 80
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <Cloud className="h-3 w-3" aria-hidden />
        <span>שטח אחסון בחשבון</span>
        <span aria-hidden>·</span>
        <UsageChip
          usedBytes={usedBytes}
          limitBytes={limitBytes}
          pct={pct}
          tone={high ? 'text-destructive' : med ? 'text-amber-400' : 'text-foreground'}
          barTone={high ? 'bg-destructive' : med ? 'bg-amber-400' : 'bg-primary'}
        />
        {high && (
          <span className="text-destructive">
            · האחסון כמעט מלא. מחקו סבבים ישנים כדי לפנות מקום.
          </span>
        )}
      </div>
    )
  }

  return null
}

/** "used / total" + a slim bar, LTR as one unit so the slash and the two
 *  sizes don't get reordered by the surrounding RTL text. */
function UsageChip({
  usedBytes,
  limitBytes,
  pct,
  tone,
  barTone,
}: {
  usedBytes: number
  limitBytes: number
  pct: number
  tone: string
  barTone: string
}) {
  return (
    <span
      dir="ltr"
      className={'inline-flex items-center gap-1.5 ' + tone}
      title={`${formatStorageSize(usedBytes)} בשימוש מתוך ${formatStorageSize(
        limitBytes,
      )} (${pct.toFixed(0)}%)`}
    >
      <span className="font-mono">
        {formatStorageSize(usedBytes)} / {formatStorageSize(limitBytes)}
      </span>
      <span className="relative h-1 w-16 overflow-hidden rounded-full bg-white/10">
        <span className={'absolute inset-y-0 left-0 ' + barTone} style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

/** Drive quota chip (desktop: StorageIndicator). Amber over 80%, red
 *  over 95%. No limit (unlimited Workspace plan) → just the usage. */
function StorageIndicator({ storage }: { storage: DriveStorage }) {
  if (!storage.limitBytes) {
    return (
      <>
        <span aria-hidden>·</span>
        <span title="חשבון Google Workspace ללא הגבלת אחסון">
          <span dir="ltr" className="font-mono">
            {formatStorageSize(storage.usageBytes)}
          </span>{' '}
          בשימוש
        </span>
      </>
    )
  }
  const pct = Math.min(100, (storage.usageBytes / storage.limitBytes) * 100)
  const high = pct >= 95
  const med = pct >= 80
  return (
    <>
      <span aria-hidden>·</span>
      <UsageChip
        usedBytes={storage.usageBytes}
        limitBytes={storage.limitBytes}
        pct={pct}
        tone={high ? 'text-destructive' : med ? 'text-amber-400' : ''}
        barTone={high ? 'bg-destructive' : med ? 'bg-amber-400' : 'bg-primary/70'}
      />
    </>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  MODALS — the app's modal chrome (backdrop + panel animation)
 * ══════════════════════════════════════════════════════════════ */

function AppModal({
  onClose,
  size = 'md',
  children,
}: {
  onClose: () => void
  size?: 'md' | 'lg'
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // The backdrop scrolls (tall modals on short phone screens) while the
  // inner min-h-full flexbox keeps the panel vertically centred.
  const closeOnBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }
  return (
    <motion.div
      className="fixed inset-0 z-[100] overflow-y-auto bg-black/60 backdrop-blur-sm"
      onClick={closeOnBackdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div
        className="flex min-h-full items-center justify-center py-6"
        onClick={closeOnBackdrop}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className={
            'relative mx-4 w-full overflow-hidden rounded-2xl border border-white/10 bg-background shadow-2xl ' +
            (size === 'lg' ? 'max-w-lg' : 'max-w-md')
          }
        >
          {children}
        </motion.div>
      </div>
    </motion.div>
  )
}

/** Header of the create / add-round modals (kicker + title + ✕). The ✕
 *  turns red while an upload runs — clicking it then cancels it. */
function CreateModalHeader({
  kicker,
  title,
  uploading,
  onClose,
}: {
  kicker: string
  title: string
  uploading: boolean
  onClose: () => void
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          {kicker}
        </div>
        <div className="mt-1 text-base font-medium text-foreground">{title}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={uploading ? 'ביטול' : 'סגירה'}
        className={
          'flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors ' +
          (uploading
            ? 'hover:bg-destructive/10 hover:text-destructive'
            : 'hover:bg-white/5 hover:text-foreground')
        }
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

/** Inline form error — the app's destructive alert box. */
function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      {message}
    </div>
  )
}

/** Progress panel shown while a video uploads / imports / swaps
 *  (desktop: NewRevisionModal's ProgressStep). */
function ProgressStep({
  label,
  fileName,
  pct,
  backend,
  showBar = true,
}: {
  label: string
  fileName: string
  pct: number
  backend: 'r2' | 'drive'
  showBar?: boolean
}) {
  const p = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="space-y-5 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Loader2 className="h-7 w-7 animate-spin" strokeWidth={1.8} />
      </div>
      <div>
        <h3 className="text-base font-medium text-foreground">{label}</h3>
        {fileName && (
          <p className="mt-1 truncate text-xs text-muted-foreground" dir="ltr">
            {fileName}
          </p>
        )}
      </div>
      {showBar && (
        <div className="space-y-1.5">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
            <motion.div
              className="absolute inset-y-0 right-0 rounded-full bg-primary"
              animate={{ width: `${p}%` }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            <span dir="ltr">{p}%</span>
          </p>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        {backend === 'drive'
          ? 'הסרטון מועלה ישירות ל-Drive שלכם. לחיצה על ✕ תבטל את ההעלאה.'
          : 'הסרטון מועלה ונשמר באחסון שלכם. לחיצה על ✕ תבטל את ההעלאה.'}
      </p>
    </div>
  )
}

/** The label the progress panel shows, derived from the source being
 *  uploaded + the progress the upload helper reports. */
function uploadLabel(
  source: VideoSource,
  progress: UploadProgress | null,
  backend: 'r2' | 'drive',
): string {
  if (source.kind === 'link') return 'מייבא מ-Google Drive...'
  if (source.kind === 'drive') return 'מגדיר הרשאות שיתוף...'
  if (!progress) return 'מתכונן להעלאה...'
  if (backend === 'r2' && progress.bytesUploaded === 0) {
    return progress.fraction > 0 ? 'בודק מקום פנוי...' : 'מתכונן להעלאה...'
  }
  return backend === 'drive' ? 'מעלה ל-Google Drive...' : 'מעלה את הוידאו...'
}

/* ──────────────────────────────────────────────────────────────
 *  NewProjectModal — name + password + optional first video + toggles
 * ────────────────────────────────────────────────────────────── */

function NewProjectModal({
  backend,
  onClose,
  onCreated,
}: {
  backend: 'r2' | 'drive'
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [watermark, setWatermark] = useState(true)
  const [allowDownload, setAllowDownload] = useState(false)
  const [openInDrive, setOpenInDrive] = useState(false)
  const [source, setSource] = useState<VideoSource>({ kind: 'none' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Per-upload AbortController. We swap it on every submit so a
  // user who cancels mid-upload and tries again gets a fresh
  // signal (the old one stays aborted). Kept in a ref because
  // we don't want abort to trigger a re-render — we just need
  // to call .abort() on the current controller from the
  // close/cancel handlers.
  const abortRef = useRef<AbortController | null>(null)

  /** Handle close / cancel — aborts any in-flight upload first
   *  so the XHRs stop sending bytes, then unmounts the modal via
   *  the parent. */
  function handleClose() {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    onClose()
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!title.trim()) {
      setError('יש לתת שם לפרויקט')
      return
    }
    // Defence-in-depth: file picker already validates on pick,
    // but a determined user could swap the file via devtools.
    const chosenSize =
      source.kind === 'upload'
        ? source.file.size
        : source.kind === 'drive'
          ? source.picked.sizeBytes
          : 0
    if (chosenSize > MAX_UPLOAD_BYTES) {
      setError(
        `הקובץ גדול מהמותר (מקסימום ${formatBytes(MAX_UPLOAD_BYTES)}). בחרו קובץ קטן יותר.`,
      )
      return
    }
    setError(null)
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      // If the user didn't pick a video, create an empty group
      // (they can add a round later via the project card).
      if (source.kind === 'none') {
        await createEmptyProjectGroup({
          title: title.trim(),
          password: password || undefined,
          watermark,
          allowDownload,
          openInDrive,
        })
        onCreated()
        return
      }

      // Got a video — full flow: upload (or reuse a Drive-picked /
      // link-imported file) → create group with the resulting pointer.
      // Each step checks abort so a click on cancel exits at the next
      // yield.
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')

      const loc = await uploadRoundVideo(backend, source, controller.signal, setProgress)

      await createProjectGroup({
        ...loc.pointer,
        title: title.trim(),
        videoFileName: loc.videoFileName,
        videoSizeBytes: loc.videoSizeBytes,
        videoMime: loc.videoMime,
        videoWidth: loc.videoWidth,
        videoHeight: loc.videoHeight,
        password: password || undefined,
        roundNumber: 1,
        watermark,
        allowDownload,
        openInDrive,
      })
      onCreated()
    } catch (err) {
      setBusy(false)
      setProgress(null)
      // Suppress the error when the user explicitly aborted — they
      // triggered the cancel, surfacing an error would be noise.
      if (controller.signal.aborted) {
        return
      }
      setError(err instanceof Error ? err.message : 'יצירת הפרויקט נכשלה')
    }
  }

  const uploading = busy && source.kind !== 'none'

  return (
    <AppModal onClose={handleClose} size="md">
      <CreateModalHeader
        kicker="— פרויקט חדש"
        title="פרויקט חדש"
        uploading={uploading}
        onClose={handleClose}
      />
      <form onSubmit={submit} className="p-6">
        {/* The form stays mounted (just hidden) while busy so every
            field keeps its state if the upload fails. */}
        <div className={busy ? 'hidden' : 'space-y-5'}>
          <div>
            <label htmlFor="proj-title" className="mb-1.5 block text-xs text-muted-foreground">
              שם הפרויקט
            </label>
            <input
              id="proj-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="לדוגמה: סרטון חתונה משפחת כהן"
              autoFocus
              className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div>
            <label htmlFor="proj-pwd" className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" />
              סיסמה (אופציונלי)
            </label>
            <div className="relative">
              <input
                id="proj-pwd"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="block w-full rounded-lg border border-white/10 bg-white/[0.02] py-2.5 pe-3 ps-10 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'הסתרת סיסמה' : 'הצגת סיסמה'}
                className="absolute inset-y-0 start-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              הסיסמה תופעל על כל סבבי התיקונים של הפרויקט.
            </p>
          </div>

          {/* Web-only: the first round's video can be attached right
              here (optional — leave empty to create an empty project). */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileVideo className="h-3 w-3" />
              סרטון לסבב הראשון (אופציונלי)
            </div>
            <VideoSourceField
              value={source}
              onChange={setSource}
              onError={setError}
              inputRef={fileInputRef}
              disabled={busy}
              backend={backend}
              compact
            />
          </div>

          <div className="space-y-2">
            <ToggleRow
              icon={Stamp}
              title="סימן מים על הסרטון"
              body="המייל של הלקוח יוצג מעל הוידאו (מומלץ, מרתיע הפצה)."
              value={watermark}
              onChange={setWatermark}
            />
            <ToggleRow
              icon={Download}
              title="לאפשר הורדה של הסרטון"
              body="הלקוח יראה כפתור הורדה מתחת לנגן."
              value={allowDownload}
              onChange={setAllowDownload}
            />
            {backend === 'drive' && (
              <ToggleRow
                icon={FolderOpen}
                title="לאפשר פתיחה ב-Google Drive"
                body="הלקוח יקבל קישור ישיר לקובץ ב-Drive שלכם."
                value={openInDrive}
                onChange={setOpenInDrive}
              />
            )}
          </div>

          {error && <FormError message={error} />}

          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
          >
            {source.kind === 'none' ? (
              <FolderClosed className="h-4 w-4" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            יצירת פרויקט
          </button>

          {source.kind === 'none' && (
            <p className="text-center text-[11px] text-muted-foreground">
              אחרי היצירה תוכלו להוסיף סבבי תיקונים מתוך כרטיס הפרויקט.
            </p>
          )}
        </div>

        {busy &&
          (source.kind === 'none' ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <div className="text-sm text-muted-foreground">יוצר פרויקט…</div>
            </div>
          ) : (
            <ProgressStep
              label={uploadLabel(source, progress, backend)}
              fileName={
                source.kind === 'upload'
                  ? source.file.name
                  : source.kind === 'drive'
                    ? source.picked.name
                    : source.kind === 'link'
                      ? source.url
                      : ''
              }
              pct={(progress?.fraction ?? 0) * 100}
              backend={backend}
              showBar={source.kind !== 'drive'}
            />
          ))}
      </form>
    </AppModal>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  AddRoundModal — upload a new round into an existing group
 * ────────────────────────────────────────────────────────────── */

function AddRoundModal({
  backend,
  group,
  onClose,
  onAdded,
}: {
  backend: 'r2' | 'drive'
  group: RevisionGroup
  onClose: () => void
  onAdded: () => void
}) {
  const [source, setSource] = useState<VideoSource>({ kind: 'none' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  function handleClose() {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    onClose()
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || source.kind === 'none') return
    const chosenSize =
      source.kind === 'upload'
        ? source.file.size
        : source.kind === 'drive'
          ? source.picked.sizeBytes
          : 0 // link import — size is validated server-side
    if (chosenSize > MAX_UPLOAD_BYTES) {
      setError(
        `הקובץ גדול מהמותר (מקסימום ${formatBytes(MAX_UPLOAD_BYTES)}). בחרו קובץ קטן יותר.`,
      )
      return
    }
    setError(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')

      const loc = await uploadRoundVideo(
        backend,
        source,
        controller.signal,
        setProgress,
      )

      await addRoundToGroup({
        groupId: group.id,
        ...loc.pointer,
        videoFileName: loc.videoFileName,
        videoSizeBytes: loc.videoSizeBytes,
        videoMime: loc.videoMime,
        videoWidth: loc.videoWidth,
        videoHeight: loc.videoHeight,
      })
      onAdded()
    } catch (err) {
      setBusy(false)
      setProgress(null)
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : 'הוספת הסבב נכשלה')
    }
  }

  return (
    <AppModal onClose={handleClose} size="lg">
      <CreateModalHeader
        kicker={`— ${group.title || 'ללא שם'}`}
        title="סבב חדש"
        uploading={busy}
        onClose={handleClose}
      />
      <form onSubmit={submit} className="p-6">
        <div className={busy ? 'hidden' : 'space-y-5'}>
          <VideoSourceField
            value={source}
            onChange={setSource}
            onError={setError}
            inputRef={fileInputRef}
            disabled={busy}
            backend={backend}
          />
          {source.kind !== 'none' && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              הסבב יישלח באותו קישור של הפרויקט. הלקוח יראה גרסה חדשה לבחירה.
            </p>
          )}
          {error && <FormError message={error} />}
          {source.kind !== 'none' && (
            <button
              type="submit"
              disabled={busy}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
            >
              <Upload className="h-4 w-4" />
              הוספת סבב
            </button>
          )}
        </div>
        {busy && (
          <ProgressStep
            label={uploadLabel(source, progress, backend)}
            fileName={
              source.kind === 'upload'
                ? source.file.name
                : source.kind === 'drive'
                  ? source.picked.name
                  : source.kind === 'link'
                    ? source.url
                    : ''
            }
            pct={(progress?.fraction ?? 0) * 100}
            backend={backend}
            showBar={source.kind !== 'drive'}
          />
        )}
      </form>
    </AppModal>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ReplaceVideoModal — swap the video on an existing round.
 *
 *  Same upload pipeline as AddRound, but the final server call is
 *  `replace-project-video`. Notes + share token + lock state on the
 *  round are preserved across the swap; only the video changes.
 * ────────────────────────────────────────────────────────────── */

function ReplaceVideoModal({
  backend,
  projectId,
  currentName,
  onClose,
  onReplaced,
}: {
  backend: 'r2' | 'drive'
  projectId: string
  currentName: string
  onClose: () => void
  onReplaced: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  function handleClose() {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    onClose()
  }

  function pick(f: File | null) {
    if (f && f.size > MAX_UPLOAD_BYTES) {
      setFile(null)
      setError(`הקובץ גדול מהמותר. המקסימום הוא ${formatBytes(MAX_UPLOAD_BYTES)}.`)
      return
    }
    setError(null)
    setFile(f)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !file) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `הקובץ גדול מהמותר (מקסימום ${formatBytes(MAX_UPLOAD_BYTES)}).`,
      )
      return
    }
    setError(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const loc = await uploadRoundVideo(
        backend,
        { kind: 'upload', file },
        controller.signal,
        setProgress,
      )
      const r = await replaceProjectVideo({
        projectId,
        ...loc.pointer,
        videoFileName: loc.videoFileName,
        videoSizeBytes: loc.videoSizeBytes,
        videoMime: loc.videoMime,
        videoWidth: loc.videoWidth,
        videoHeight: loc.videoHeight,
      })
      if (!r.ok) throw new Error(r.error)
      onReplaced()
    } catch (err) {
      setBusy(false)
      setProgress(null)
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : 'החלפת הוידאו נכשלה')
    }
  }

  const replaceLabel =
    progress && progress.fraction >= 1
      ? 'מחליף את הסרטון...'
      : !progress || (backend === 'r2' && progress.bytesUploaded === 0)
        ? progress && progress.fraction > 0
          ? 'בודק מקום פנוי...'
          : 'מתכונן להעלאה...'
        : backend === 'drive'
          ? 'מעלה ל-Google Drive...'
          : 'מעלה את הסרטון החדש...'

  return (
    <AppModal onClose={handleClose} size="lg">
      <div className="flex items-start justify-between gap-3 border-b border-white/5 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            החלפת סרטון
          </div>
          <h2 className="mt-1 truncate text-base font-medium text-foreground" title={currentName}>
            {currentName}
          </h2>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label={busy ? 'ביטול' : 'סגירה'}
          className={
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors ' +
            (busy
              ? 'hover:bg-destructive/10 hover:text-destructive'
              : 'hover:bg-white/5 hover:text-foreground')
          }
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={submit} className="space-y-4 p-5">
        <div className={busy ? 'hidden' : 'space-y-4'}>
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {backend === 'drive'
              ? 'הסרטון הקיים יוחלף בקובץ החדש. הקישור ללקוח, התיקונים שכבר נשלחו, הסיסמה ומספר הסבב, כולם יישמרו. הקובץ הישן יעבור לפח של Drive.'
              : 'הסרטון הקיים יוחלף בקובץ החדש. הקישור ללקוח, התיקונים שכבר נשלחו, הסיסמה ומספר הסבב, כולם יישמרו.'}
          </p>
          {file ? (
            <FileChip
              name={file.name}
              sub={formatBytes(file.size)}
              onChange={() => fileInputRef.current?.click()}
            />
          ) : (
            <UploadZone
              onPick={pick}
              inputRef={fileInputRef}
              disabled={busy}
              title="גררו סרטון חדש לכאן"
              dragTitle="שחררו כדי להחליף"
              body="או לחצו לבחירת קובץ מהמחשב."
              cta="בחירת סרטון חדש"
            />
          )}
          {/* One hidden input for both the zone and the chip's
              "החלפה" button. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => pick(e.target.files?.[0] || null)}
          />
          {error && <FormError message={error} />}
          {file && (
            <button
              type="submit"
              disabled={busy || !file}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
            >
              <Upload className="h-4 w-4" />
              החלפת סרטון
            </button>
          )}
        </div>
        {busy && (
          <ProgressStep
            label={replaceLabel}
            fileName={file?.name || ''}
            pct={(progress?.fraction ?? 0) * 100}
            backend={backend}
          />
        )}
      </form>
    </AppModal>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  EditGroupModal — password + toggles (desktop: EditProjectGroupModal)
 * ────────────────────────────────────────────────────────────── */

function EditGroupModal({
  group,
  backend,
  onClose,
  onSaved,
}: {
  group: RevisionGroup
  backend: 'r2' | 'drive'
  onClose: () => void
  onSaved: () => void
}) {
  // Password input starts BLANK by design — we never show the
  // existing password (we don't even have it; only the hash lives
  // on the server). The "מוגדרת" pill tells the editor whether one
  // is currently set. Submitting blank = keep existing; submitting
  // a value = replace; "הסר סיסמה לחלוטין" marks it for removal on
  // save.
  const [password, setPassword] = useState('')
  const [clearPw, setClearPw] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [watermark, setWatermark] = useState(group.watermark)
  const [allowDownload, setAllowDownload] = useState(group.allowDownload)
  const [openInDrive, setOpenInDrive] = useState(group.openInDrive)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const changes: {
      password?: string
      watermark?: boolean
      allowDownload?: boolean
      openInDrive?: boolean
    } = {
      watermark,
      allowDownload,
      openInDrive,
    }
    if (clearPw) changes.password = ''
    else if (password) changes.password = password
    const r = await updateGroup(group.id, changes)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onSaved()
  }

  return (
    <AppModal onClose={onClose} size="md">
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            עריכת פרויקט
          </div>
          <h2 className="mt-1 truncate text-base font-medium text-foreground" title={group.title}>
            {group.title || 'ללא שם'}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="סגירה"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={submit}>
        <div className="space-y-5 border-t border-white/5 px-5 py-5">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <label
                htmlFor="grp-pwd"
                className="flex items-center gap-1.5 text-xs font-medium text-foreground"
              >
                <Lock className="h-3 w-3 text-muted-foreground" />
                סיסמה לפרויקט
              </label>
              <span
                className={
                  'rounded-full px-2 py-0.5 text-[10px] ' +
                  (group.hasPassword
                    ? 'bg-accent/15 text-accent'
                    : 'bg-muted-foreground/10 text-muted-foreground')
                }
              >
                {group.hasPassword ? 'מוגדרת' : 'ללא סיסמה'}
              </span>
            </div>
            <div className="relative">
              <input
                id="grp-pwd"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (e.target.value) setClearPw(false)
                }}
                autoComplete="new-password"
                placeholder={
                  clearPw
                    ? 'הסיסמה תוסר בשמירה'
                    : group.hasPassword
                      ? 'סיסמה חדשה (השאר ריק אם לא משנים)'
                      : 'סיסמה חדשה (4 תווים מינימום)'
                }
                className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 pe-10 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                disabled={busy || clearPw}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                disabled={clearPw}
                aria-label={showPassword ? 'הסתרת סיסמה' : 'הצגת סיסמה'}
                className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                tabIndex={-1}
              >
                {showPassword ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              לקוחות שכבר נכנסו עם הסיסמה הקודמת יישארו בפנים עד 6 שעות.
            </p>
          </div>

          <div className="space-y-2">
            <ToggleRow
              icon={Stamp}
              title="סימן מים על הסרטון"
              body="המייל של הלקוח יוצג מעל הוידאו (מומלץ, מרתיע הפצה)."
              value={watermark}
              onChange={setWatermark}
              disabled={busy}
            />
            <ToggleRow
              icon={Download}
              title="לאפשר הורדה של הסרטון"
              body="הלקוח יראה כפתור הורדה רגיל בנגן הוידאו."
              value={allowDownload}
              onChange={setAllowDownload}
              disabled={busy}
            />
            {backend === 'drive' && (
              <ToggleRow
                icon={FolderOpen}
                title="לאפשר פתיחה ב-Google Drive"
                body="הלקוח יקבל קישור ישיר לקובץ ב-Drive שלכם (עוקף את ה-watermark)."
                value={openInDrive}
                onChange={setOpenInDrive}
                disabled={busy}
              />
            )}
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 bg-white/[0.015] px-5 py-3">
          {group.hasPassword ? (
            <button
              type="button"
              onClick={() => {
                const next = !clearPw
                setClearPw(next)
                if (next) setPassword('')
              }}
              disabled={busy}
              aria-pressed={clearPw}
              className={
                'text-xs transition-colors hover:text-destructive disabled:opacity-50 ' +
                (clearPw ? 'text-destructive' : 'text-muted-foreground')
              }
            >
              {clearPw ? 'ביטול הסרת הסיסמה' : 'הסר סיסמה לחלוטין'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
            >
              ביטול
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              שמירה
            </button>
          </div>
        </div>
      </form>
    </AppModal>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  ROUND DETAIL — notes browser for a single round
 *  (desktop: ProjectDetailView)
 *
 *  Takes either a {group, round} pair (new-style) or a legacy
 *  standalone project. Both resolve to the same notes endpoint —
 *  the only API difference is which `projectId` we send.
 * ══════════════════════════════════════════════════════════════ */

function RoundDetailView({
  target,
  liveNotesCount,
  onBack,
  onLockChanged,
  onRequestReplaceVideo,
}: {
  target:
    | { group: RevisionGroup; round: GroupRoundSummary }
    | { legacy: LegacyProjectSummary }
  /** Live note count for this round from the push listener. When it
   *  changes (a viewer added a note), we re-fetch the notes so the
   *  new one shows without a manual refresh. */
  liveNotesCount: number | undefined
  onBack: () => void
  onLockChanged: () => void
  /** Pop the Replace-Video modal for the round currently being
   *  viewed. The parent handles the actual modal mount. */
  onRequestReplaceVideo: (projectId: string, currentName: string) => void
}) {
  // Resolve the common fields once so the rest of the view doesn't
  // have to switch over `target` on every read.
  const isLegacy = 'legacy' in target
  const projectId = isLegacy ? target.legacy.id : target.round.id
  const title = (isLegacy ? target.legacy.title : target.group.title) || 'ללא שם'
  const roundNumber = isLegacy ? target.legacy.roundNumber : target.round.roundNumber
  const videoFileName = isLegacy ? target.legacy.videoFileName : target.round.videoFileName
  const videoSizeBytes = isLegacy ? target.legacy.videoSizeBytes : target.round.videoSizeBytes
  const shareUrl = isLegacy
    ? buildShareUrl(target.legacy.shareToken)
    : `${buildShareUrl(target.group.shareToken)}?r=${target.round.id}`
  const locked = isLegacy ? target.legacy.locked : target.round.locked
  const { copied, copy } = useCopyLink(shareUrl)

  const [notes, setNotes] = useState<OwnerNote[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyLock, setBusyLock] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setNotes(null)
    setLoadError(null)
    void (async () => {
      try {
        const list = await listNotesAsOwner(projectId)
        if (!cancelled) setNotes(list)
      } catch (err) {
        if (cancelled) return
        setLoadError(
          err instanceof Error ? err.message : 'טעינת ההערות נכשלה',
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, refreshKey])

  // Live re-fetch: when the push listener reports a different note
  // count for this round (a viewer just added/removed one), reload
  // the notes so the new content appears without a manual refresh.
  // The ref skips the first observed value so we don't double-fetch
  // on mount (the effect above already did the initial load).
  const prevLiveCountRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (liveNotesCount === undefined) return
    if (prevLiveCountRef.current === undefined) {
      prevLiveCountRef.current = liveNotesCount
      return
    }
    if (liveNotesCount !== prevLiveCountRef.current) {
      prevLiveCountRef.current = liveNotesCount
      setRefreshKey((k) => k + 1)
    }
  }, [liveNotesCount])

  // Esc → back to project list. Same shortcut the editor expects
  // from any "drill-into" surface across the app. Skipped while one
  // of this view's own overlays (image lightbox / response dialog)
  // is open — Esc closes that overlay instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-rev-overlay]')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  async function toggleLock() {
    if (busyLock) return
    setBusyLock(true)
    const r = await updateProjectLock(projectId, !locked)
    setBusyLock(false)
    if (r.ok) {
      // Parent reloads the project list with the new lock state.
      onLockChanged()
    } else {
      alert(r.error)
    }
  }

  /** Apply a new status to a note in-place. Optimistic — flips
   *  the local copy first, then mirrors to the server; reverts
   *  on failure. Editor response payload is required for the two
   *  statuses that surface text back to the reviewer. */
  async function applyStatus(
    noteId: string,
    status: NoteStatus,
    editorResponse?: string,
  ) {
    if (!notes) return
    const prev = notes
    setNotes(
      notes.map((n) =>
        n.id === noteId
          ? {
              ...n,
              status,
              editorResponse: editorResponse ?? n.editorResponse,
            }
          : n,
      ),
    )
    try {
      await updateNoteStatus(projectId, noteId, status, editorResponse)
    } catch (err) {
      setNotes(prev)
      alert(err instanceof Error ? err.message : 'עדכון הסטטוס נכשל')
    }
  }

  const refreshing = notes === null && !loadError
  const resolvedCount = notes?.filter((n) => n.status === 'resolved').length ?? 0
  // "לא אפשרי" is a final decision — count it as closed, not open.
  const notPossibleCount =
    notes?.filter((n) => n.status === 'not-possible').length ?? 0
  const totalCount = notes?.length ?? 0
  const openCount = totalCount - resolvedCount - notPossibleCount

  return (
    <div className="mx-auto w-full max-w-4xl px-6 pb-8 pt-2 md:pb-10 md:pt-4">
      {/* Top bar — back button on the right (RTL), refresh on left */}
      <div className="mb-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
        >
          <ArrowRight className="h-3.5 w-3.5" />
          חזרה לרשימה
        </button>
        <button
          type="button"
          onClick={() => setRefreshKey((n) => n + 1)}
          disabled={refreshing}
          title="רענון התיקונים"
          aria-label="רענון"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Project header — title + round + meta + share link strip */}
      <div className="mb-6 rounded-2xl border border-white/5 bg-white/[0.02] p-5">
        {/* On phones the lock button wraps under the title instead of
            squeezing it (flex-wrap + minimum title width). */}
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
          <div className="min-w-[60%] flex-1 sm:min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <span
                title={`סבב מספר ${roundNumber}`}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-primary/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary"
              >
                <Hash className="h-3 w-3" />
                {roundNumber}
              </span>
              <h1
                className="truncate text-xl font-medium tracking-tight text-foreground"
                style={{ letterSpacing: '-0.01em' }}
                title={title}
              >
                {title}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span dir="ltr" className="truncate" title={videoFileName}>
                {videoFileName}
              </span>
              <span aria-hidden>·</span>
              <span dir="ltr">{formatBytes(videoSizeBytes)}</span>
            </div>
          </div>
          {/* Lock toggle — red "סגירת סבב התיקונים" when open, green
              "פתיחת סבב התיקונים" when closed. */}
          <button
            type="button"
            onClick={() => void toggleLock()}
            disabled={busyLock}
            className={
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ' +
              (locked
                ? 'border-success/40 bg-success/10 text-success hover:bg-success/20'
                : 'border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20')
            }
          >
            {busyLock ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : locked ? (
              <LockOpen className="h-3.5 w-3.5" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            {locked ? 'פתיחת סבב התיקונים' : 'סגירת סבב התיקונים'}
          </button>
        </div>

        {/* Primary action — plays the round on its public review page
            in a new tab (the page the client sees). Secondary — replace
            the round's video. */}
        <div className="mb-3 flex gap-2">
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-background shadow-sm transition-all hover:bg-primary/90"
          >
            <PlayCircle className="h-4 w-4" strokeWidth={2.2} />
            הפעלת הסרטון
            <span className="hidden text-[11px] font-normal opacity-70 sm:inline">· בחלון חדש</span>
          </a>
          <button
            type="button"
            onClick={() => onRequestReplaceVideo(projectId, title)}
            title="העלאת קובץ חדש במקום הסרטון הקיים"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-white/[0.06]"
          >
            <Replace className="h-4 w-4" />
            החלפת סרטון
          </button>
        </div>

        {/* Share URL strip with copy + open icons. */}
        <div className="flex items-center gap-2">
          <div
            dir="ltr"
            className="min-w-0 flex-1 truncate rounded-md border border-white/5 bg-white/[0.015] px-3 py-2 font-mono text-[11px]"
            title={shareUrl}
          >
            {shareUrl}
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            title={copied ? 'הועתק' : 'העתקת קישור'}
            aria-label="העתקת קישור"
            className={
              'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ' +
              (copied
                ? 'bg-success/15 text-success'
                : 'text-muted-foreground hover:bg-white/5 hover:text-foreground')
            }
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="פתיחת קישור"
            aria-label="פתיחת קישור"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Notes section header */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          תיקונים
          {totalCount > 0 && (
            <span className="text-[11px] font-normal text-muted-foreground">
              ·{' '}
              <span className="font-mono text-primary">{openCount}</span> פתוחים
              {resolvedCount > 0 && (
                <>
                  {' · '}
                  <span className="font-mono text-success">{resolvedCount}</span>{' '}
                  טופלו
                </>
              )}
            </span>
          )}
        </h2>
      </div>

      {/* Body — error / loading / empty / list. The whole page
          scrolls naturally when there are many notes. */}
      {loadError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-center text-xs text-destructive">
          {loadError}
          <button
            type="button"
            onClick={() => setRefreshKey((n) => n + 1)}
            className="ms-3 underline underline-offset-2"
          >
            ניסיון נוסף
          </button>
        </div>
      ) : !notes ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="טוען" />
        </div>
      ) : notes.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-white/10 bg-white/[0.01] px-6 py-14 text-center">
          <MessageSquare className="mb-3 h-6 w-6 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">
            עדיין אין תיקונים. כשהלקוח יוסיף תיקון בעמוד ה-review הוא יופיע
            כאן.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              projectId={projectId}
              onApplyStatus={(status, payload) =>
                void applyStatus(note.id, status, payload)
              }
              onExpandImage={(url) => setLightbox(url)}
            />
          ))}
        </ul>
      )}

      <AnimatePresence>
        {lightbox && (
          <ImageLightbox key="lightbox" url={lightbox} onClose={() => setLightbox(null)} />
        )}
      </AnimatePresence>
    </div>
  )
}

/** Single note row — screenshot thumbnail / voice / text, timestamp,
 *  viewer, status menu. Lazy-loads the media via the owner-auth proxy
 *  when the row mounts. */
function NoteRow({
  note,
  projectId,
  onApplyStatus,
  onExpandImage,
}: {
  note: OwnerNote
  projectId: string
  onApplyStatus: (status: NoteStatus, editorResponse?: string) => void
  onExpandImage: (url: string) => void
}) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [screenshotFailed, setScreenshotFailed] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Open the popover UPWARD when the pill sits low in the viewport, so
  // the menu isn't clipped off the bottom of the window.
  const [menuUp, setMenuUp] = useState(false)
  // Anchor the popover to the pill's left edge (the app's placement —
  // the pill sits at the row's left end) unless that would run off the
  // right of a narrow screen, where the pill wraps to the right side.
  const [menuFromLeft, setMenuFromLeft] = useState(true)
  const [responseModal, setResponseModal] = useState<
    null | { kind: 'question' | 'not-possible' }
  >(null)
  // Disclosure for the note's edit history (what the client wrote before).
  const [showHistory, setShowHistory] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Fetch screenshot once on mount (or when the file id changes).
  useEffect(() => {
    if (!note.screenshotDriveFileId && !note.screenshotR2Key) return
    let url: string | null = null
    let cancelled = false
    void (async () => {
      try {
        const u = await fetchNoteMediaAsObjectUrl(
          projectId,
          note.id,
          'image',
        )
        if (cancelled) {
          URL.revokeObjectURL(u)
          return
        }
        url = u
        setScreenshotUrl(u)
      } catch {
        // Don't error-toast — just don't render the screenshot.
        if (!cancelled) setScreenshotFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [projectId, note.id, note.screenshotDriveFileId, note.screenshotR2Key])

  // Same for audio.
  useEffect(() => {
    if (!note.audioDriveFileId && !note.audioR2Key) return
    let url: string | null = null
    let cancelled = false
    void (async () => {
      try {
        const u = await fetchNoteMediaAsObjectUrl(
          projectId,
          note.id,
          'audio',
        )
        if (cancelled) {
          URL.revokeObjectURL(u)
          return
        }
        url = u
        setAudioUrl(u)
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [projectId, note.id, note.audioDriveFileId, note.audioR2Key])

  // Close the menu when the user clicks anywhere else.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  function toggleMenu() {
    if (!menuOpen) {
      // ~180px tall menu (4 items). Flip it up when there's less room
      // than that below the trigger.
      const rect = menuRef.current?.getBoundingClientRect()
      const spaceBelow = rect ? window.innerHeight - rect.bottom : 999
      setMenuUp(spaceBelow < 200)
      setMenuFromLeft(!rect || rect.left + 184 <= window.innerWidth)
    }
    setMenuOpen((v) => !v)
  }

  function pickStatus(s: NoteStatus) {
    setMenuOpen(false)
    if (s === 'question' || s === 'not-possible') {
      // These statuses need editor text — open the dialog first.
      setResponseModal({ kind: s })
    } else {
      onApplyStatus(s)
    }
  }

  const imageSrc = screenshotUrl || note.screenshotDataUrl || null
  const imagePending =
    !imageSrc &&
    !screenshotFailed &&
    Boolean(note.screenshotDriveFileId || note.screenshotR2Key)
  const hasAudio = Boolean(note.audioDriveFileId || note.audioR2Key)
  const ts = formatTimestamp(note.timeSeconds)
  const isGeneral = !ts
  const resolved = note.status === 'resolved'
  const isQuestion = note.status === 'question'
  const isNotPossible = note.status === 'not-possible'

  // Whole-card color reflects the note's status (same palette as the
  // public /review page): resolved = yellow, question = sky,
  // not-possible = red, new = neutral.
  const containerClass = resolved
    ? 'border-yellow-500/30 bg-yellow-500/[0.07]'
    : isQuestion
      ? 'border-sky-500/20 bg-sky-500/[0.04]'
      : isNotPossible
        ? 'border-red-500/30 bg-red-500/[0.06]'
        : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.035]'

  return (
    <li className={'rounded-xl border p-3 transition-colors ' + containerClass}>
      <div className="flex gap-3">
        {imageSrc ? (
          <button
            type="button"
            onClick={() => onExpandImage(imageSrc)}
            title="הגדלת התמונה"
            className="group/thumb relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-white/10 transition-transform hover:scale-[1.03]"
          >
            <img
              src={imageSrc}
              alt=""
              className={'h-full w-full object-cover ' + (resolved ? 'opacity-60' : '')}
            />
            <div className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover/thumb:bg-black/20" />
          </button>
        ) : imagePending ? (
          <div
            aria-hidden
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-muted-foreground/60"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : hasAudio ? (
          <div
            aria-hidden
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/[0.04] text-primary/70"
          >
            <Mic className="h-5 w-5" />
          </div>
        ) : (
          <div
            aria-hidden
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-white/10 bg-white/[0.02] text-muted-foreground/50"
          >
            <MessageSquare className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              {isGeneral ? (
                <span
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground/80"
                  title="הערה כללית, לא מקושרת לזמן ספציפי בסרטון"
                >
                  <MessageSquare className="h-2.5 w-2.5" />
                  כללי
                </span>
              ) : (
                <span
                  className={
                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ' +
                    (resolved
                      ? 'text-yellow-400'
                      : isQuestion
                        ? 'text-sky-400'
                        : isNotPossible
                          ? 'text-red-400'
                          : 'text-primary')
                  }
                >
                  <PlayCircle className="h-3 w-3 opacity-70" />
                  {ts}
                </span>
              )}
              <span
                dir="ltr"
                className="truncate text-[10px] text-muted-foreground/80"
                title={note.viewerEmail}
              >
                {note.viewerEmail}
              </span>
              <span dir="ltr" className="text-[10px] text-muted-foreground/60">
                {formatShortDateTime(note.createdAt)}
              </span>
            </div>

            {/* Status menu — popover with the four states. The trigger
                pill shows the current state. Question / not-possible
                open the response dialog first so the editor can type
                the message the reviewer will see. */}
            <div className="relative" ref={menuRef}>
              <StatusPill status={note.status} onClick={toggleMenu} />
              {menuOpen && (
                <div
                  className={
                    'absolute z-20 w-44 overflow-hidden rounded-lg border border-white/10 bg-background shadow-2xl ' +
                    (menuFromLeft ? 'left-0 ' : 'right-0 ') +
                    (menuUp ? 'bottom-full mb-1' : 'top-full mt-1')
                  }
                >
                  <StatusMenuItem
                    label="חדש"
                    icon={Circle}
                    onClick={() => pickStatus('new')}
                    active={note.status === 'new'}
                    tone="muted"
                  />
                  <StatusMenuItem
                    label="טופל"
                    icon={CheckCircle2}
                    onClick={() => pickStatus('resolved')}
                    active={resolved}
                    tone="yellow"
                  />
                  <StatusMenuItem
                    label="שאלה ללקוח"
                    icon={MessageSquare}
                    onClick={() => pickStatus('question')}
                    active={isQuestion}
                    tone="sky"
                  />
                  <StatusMenuItem
                    label="לא אפשרי"
                    icon={AlertTriangle}
                    onClick={() => pickStatus('not-possible')}
                    active={isNotPossible}
                    tone="red"
                  />
                </div>
              )}
            </div>
          </div>
          {note.text && (
            <p
              className={
                'whitespace-pre-wrap break-words text-xs leading-relaxed ' +
                (resolved ? 'text-foreground/75' : 'text-foreground')
              }
            >
              {renderNoteText(note.text)}
            </p>
          )}
          {/* Edit history — the client can revise a note; here the editor
              sees that it was edited and can expand every prior version so
              nothing the client originally wrote is lost. */}
          {note.editedAt && (
            <div className="mt-1.5">
              {Array.isArray(note.history) && note.history.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <History className="h-3 w-3" />
                  נערך ·{' '}
                  {note.history.length === 1
                    ? 'גרסה קודמת אחת'
                    : `${note.history.length} גרסאות קודמות`}
                  {showHistory ? ' — הסתרה' : ' — הצגה'}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <History className="h-3 w-3" />
                  נערך
                </span>
              )}
              {showHistory && Array.isArray(note.history) && (
                <ol className="mt-1.5 space-y-1.5 border-r-2 border-white/10 pr-3">
                  {note.history.map((h, i) => (
                    <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">
                      <span className="whitespace-pre-wrap break-words">
                        {h.text ? renderNoteText(h.text) : '(ריק)'}
                      </span>
                      <span className="ms-1.5 text-muted-foreground/60" dir="ltr">
                        {formatShortDateTime(h.at)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {audioUrl && <VoiceNotePlayer src={audioUrl} dimmed={resolved} />}
          {/* Editor's response — visible on the reviewer side too. */}
          {note.editorResponse && (isQuestion || isNotPossible) && (
            <div
              className={
                'mt-2 rounded-md border-r-2 px-2.5 py-1.5 text-[11px] leading-relaxed ' +
                (isQuestion
                  ? 'border-sky-500/60 bg-sky-500/[0.06] text-sky-100/90'
                  : 'border-red-500/60 bg-red-500/[0.06] text-red-100/90')
              }
            >
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide opacity-70">
                {isQuestion ? 'השאלה שתישלח ללקוח' : 'ההסבר שיישלח ללקוח'}
              </div>
              <div className="whitespace-pre-wrap break-words">
                {note.editorResponse}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Response dialog — appears when picking question / not-possible.
          Captures the message and forwards it to applyStatus. */}
      <AnimatePresence>
        {responseModal && (
          <ResponseModal
            key="response"
            kind={responseModal.kind}
            initial={note.editorResponse || ''}
            onCancel={() => setResponseModal(null)}
            onSave={(text) => {
              const kind = responseModal.kind
              setResponseModal(null)
              onApplyStatus(kind, text)
            }}
          />
        )}
      </AnimatePresence>
    </li>
  )
}

/** Current-state badge that doubles as the status-menu trigger. */
function StatusPill({
  status,
  onClick,
}: {
  status: NoteStatus
  onClick: () => void
}) {
  const tone =
    status === 'resolved'
      ? 'border-yellow-500/40 bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/20'
      : status === 'question'
        ? 'border-sky-500/40 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15'
        : status === 'not-possible'
          ? 'border-red-500/40 bg-red-500/15 text-red-400 hover:bg-red-500/20'
          : 'border-white/10 bg-white/[0.02] text-muted-foreground hover:border-white/20 hover:text-foreground'
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
          : Circle
  return (
    <button
      type="button"
      onClick={onClick}
      title="שינוי סטטוס תיקון"
      aria-haspopup="menu"
      className={
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ' +
        tone
      }
    >
      <Icon className="h-3 w-3" />
      {label}
      <ChevronDown className="h-2.5 w-2.5 opacity-60" />
    </button>
  )
}

function StatusMenuItem({
  label,
  icon: Icon,
  onClick,
  active,
  tone,
}: {
  label: string
  icon: typeof CheckCircle2
  onClick: () => void
  active: boolean
  tone: 'muted' | 'yellow' | 'sky' | 'red'
}) {
  const toneClass =
    tone === 'yellow'
      ? 'text-yellow-400'
      : tone === 'sky'
        ? 'text-sky-400'
        : tone === 'red'
          ? 'text-red-400'
          : 'text-muted-foreground'
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center gap-2 px-3 py-2 text-right text-[11px] transition-colors ' +
        (active ? 'bg-white/[0.04] ' : '') +
        'hover:bg-white/[0.05]'
      }
    >
      <Icon className={'h-3.5 w-3.5 shrink-0 ' + toneClass} />
      <span className="flex-1 text-foreground">{label}</span>
      {active && <Check className="h-3 w-3 text-muted-foreground/70" />}
    </button>
  )
}

/** Response dialog — opened when the editor picks "שאלה ללקוח" or
 *  "לא אפשרי". The text is shown to the reviewer on the public review
 *  page; it's required for these statuses, so save stays disabled
 *  until something is typed. */
function ResponseModal({
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
      data-rev-overlay=""
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div
              className={
                'text-[10px] font-medium uppercase tracking-[0.16em] ' +
                (isQuestion ? 'text-sky-400' : 'text-amber-400')
              }
            >
              {isQuestion ? 'שאלה ללקוח' : 'תיקון לא אפשרי'}
            </div>
            <div className="mt-1 text-sm font-medium text-foreground">
              {isQuestion ? 'מה תרצו לשאול את הלקוח?' : 'הסבירו למה לא ניתן לבצע'}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="סגירה"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground"
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
                ? 'לדוגמה: באיזה גוון בדיוק להחליף את הצבע? יש לכם דוגמה?'
                : 'לדוגמה: הפריים המבוקש לא קיים בחומר הגולמי. צריך לצלם מחדש.'
            }
            className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            הטקסט הזה יופיע ללקוח ב-/review מתחת לתיקון.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/5 bg-white/[0.015] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={() => onSave(text.trim())}
            disabled={!text.trim()}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/40"
          >
            <Check className="h-4 w-4" />
            שמירה ושליחה
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** Screenshot lightbox — click outside or Esc closes. */
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <motion.div
      data-rev-overlay=""
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="סגירה"
        className="absolute right-4 top-12 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
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

/* ══════════════════════════════════════════════════════════════
 *  SHARED PRIMITIVES
 * ══════════════════════════════════════════════════════════════ */

/**
 * VideoSource — the unified result of the video chooser. The editor
 * either uploads a fresh file from their computer, OR picks one that
 * already lives in their Google Drive (via the Google Picker). The
 * Drive path is far cheaper: nothing is uploaded — we just record the
 * existing driveFileId and let the streaming worker serve it.
 */
export type VideoSource =
  | { kind: 'none' }
  | { kind: 'upload'; file: File }
  | { kind: 'drive'; picked: PickedDriveFile }
  // R2 backend only: import a PUBLIC Drive link — Cloudflare streams
  // the bytes Drive → R2, the user never downloads/uploads anything.
  | { kind: 'link'; url: string }

/**
 * VideoSourceField — two-way video chooser used by the new-project and
 * add-round modals (desktop: NewRevisionModal's IdleStep). A segmented
 * toggle switches between:
 *   - "העלאת קובץ": drag-and-drop / click uploader.
 *   - Drive backend: "בחירה מ-Google Drive" (Google Picker, no re-upload).
 *   - R2 backend:    "ייבוא מקישור" (public Drive link → our storage).
 *
 * Switching tabs clears the current selection so the submit button
 * never acts on a stale value from the other source. `compact` is the
 * smaller variant used inside the new-project form.
 */
function VideoSourceField({
  value,
  onChange,
  onError,
  disabled = false,
  inputRef,
  backend,
  compact = false,
}: {
  value: VideoSource
  onChange: (v: VideoSource) => void
  onError: (msg: string | null) => void
  disabled?: boolean
  inputRef: React.RefObject<HTMLInputElement>
  backend: 'r2' | 'drive'
  compact?: boolean
}) {
  // The second tab differs by backend: Drive users pick an existing
  // Drive file (Picker); R2 users paste a public Drive link that
  // Cloudflare streams into our storage.
  const secondMode: 'drive' | 'link' = backend === 'drive' ? 'drive' : 'link'
  const [mode, setMode] = useState<'upload' | 'drive' | 'link'>('upload')
  const [picking, setPicking] = useState(false)

  function switchMode(next: 'upload' | 'drive' | 'link') {
    if (next === mode || disabled) return
    setMode(next)
    onError(null)
    // Drop any cross-mode selection so the parent's submit logic
    // only ever sees a source that matches the visible tab.
    if (value.kind !== 'none') onChange({ kind: 'none' })
  }

  async function openPicker() {
    if (disabled || picking) return
    setPicking(true)
    onError(null)
    try {
      const at = await fetchDriveAccessToken()
      const picked = await pickVideoFromDrive(at.accessToken)
      // null = user cancelled the picker; leave the current state.
      if (!picked) return
      // Enforce the same cap as the upload path. The Picker reports
      // the file's real size, so we can reject oversize files before
      // they're ever wired into a project.
      if (picked.sizeBytes > 0 && picked.sizeBytes > MAX_UPLOAD_BYTES) {
        onError(
          `הקובץ גדול מהמותר (מקסימום ${formatBytes(MAX_UPLOAD_BYTES)}). בחרו קובץ קטן יותר.`,
        )
        return
      }
      onChange({ kind: 'drive', picked })
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : 'בחירת קובץ מ-Google Drive נכשלה',
      )
    } finally {
      setPicking(false)
    }
  }

  function pickFile(f: File | null) {
    if (!f) {
      onChange({ kind: 'none' })
      return
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      onChange({ kind: 'none' })
      onError(
        `הקובץ גדול מהמותר. המקסימום הוא ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
          'לקבצים גדולים יותר בחרו אותם ישירות מ-Google Drive.',
      )
      return
    }
    onError(null)
    onChange({ kind: 'upload', file: f })
  }

  const driveFile = value.kind === 'drive' ? value.picked : null
  const uploadFile = value.kind === 'upload' ? value.file : null

  return (
    <div>
      {/* Segmented source toggle with a sliding copper indicator */}
      <div
        className={
          'relative grid grid-cols-2 rounded-lg border border-white/10 bg-white/[0.02] p-1 ' +
          (compact ? 'mb-3' : 'mb-5')
        }
      >
        {(['upload', secondMode] as const).map((m) => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => switchMode(m)}
              className="relative flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium disabled:cursor-not-allowed"
            >
              {active && (
                <motion.span
                  layoutId={compact ? 'vs-tab-indicator-compact' : 'vs-tab-indicator'}
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  className="absolute inset-0 rounded-md bg-primary"
                />
              )}
              <span
                className={
                  'relative z-10 flex items-center gap-2 transition-colors ' +
                  (active ? 'text-background' : 'text-muted-foreground hover:text-foreground')
                }
              >
                {m === 'upload' ? (
                  <Upload className="h-3.5 w-3.5" />
                ) : m === 'link' ? (
                  <LinkIcon className="h-3.5 w-3.5" />
                ) : (
                  <HardDrive className="h-3.5 w-3.5" />
                )}
                {m === 'upload'
                  ? 'העלאת קובץ'
                  : m === 'link'
                    ? 'ייבוא מקישור'
                    : 'בחירה מ-Google Drive'}
              </span>
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0, x: mode === 'upload' ? -10 : 10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: mode === 'upload' ? 10 : -10 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className={compact ? '' : 'text-center'}
        >
          {mode === 'link' ? (
            compact ? (
              <div>
                <input
                  type="url"
                  dir="ltr"
                  inputMode="url"
                  placeholder="https://drive.google.com/file/d/..."
                  disabled={disabled}
                  value={value.kind === 'link' ? value.url : ''}
                  onChange={(e) => {
                    const url = e.target.value.trim()
                    onError(null)
                    onChange(url ? { kind: 'link', url } : { kind: 'none' })
                  }}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left text-sm text-foreground outline-none focus:border-primary"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  קישור לסרטון המשותף ל"כל מי שיש לו את הקישור". המערכת תבדוק
                  את הגודל ואת המקום הפנוי ותעביר אותו לאחסון שלנו.
                </p>
              </div>
            ) : (
              <>
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <LinkIcon className="h-7 w-7" strokeWidth={1.8} />
                </div>
                <h3 className="text-base font-medium text-foreground">
                  ייבוא מקישור Google Drive
                </h3>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  הדביקו קישור לסרטון המשותף ל"כל מי שיש לו את הקישור".
                  המערכת תבדוק את הגודל ואת המקום הפנוי ותעביר אותו לאחסון
                  שלנו, בלי להוריד ולהעלות מחדש. כל גודל שנכנס במכסה.
                </p>
                <input
                  type="url"
                  dir="ltr"
                  inputMode="url"
                  placeholder="https://drive.google.com/file/d/..."
                  disabled={disabled}
                  value={value.kind === 'link' ? value.url : ''}
                  onChange={(e) => {
                    const url = e.target.value.trim()
                    onError(null)
                    onChange(url ? { kind: 'link', url } : { kind: 'none' })
                  }}
                  className="mt-5 w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left text-sm text-foreground outline-none focus:border-primary"
                />
              </>
            )
          ) : mode === 'upload' ? (
            <>
              {uploadFile ? (
                <FileChip
                  name={uploadFile.name}
                  sub={formatBytes(uploadFile.size)}
                  onChange={() => inputRef.current?.click()}
                  disabled={disabled}
                />
              ) : (
                <UploadZone
                  onPick={pickFile}
                  inputRef={inputRef}
                  disabled={disabled}
                  compact={compact}
                  title="גררו סרטון לכאן"
                  dragTitle="שחררו כדי להעלות"
                  body="או לחצו לבחירת קובץ מהמחשב. הסרטון יעלה לאחסון, כל גודל שנכנס במכסה."
                  cta="בחירת קובץ"
                />
              )}
              <input
                ref={inputRef}
                type="file"
                accept="video/*"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => pickFile(e.target.files?.[0] || null)}
              />
            </>
          ) : driveFile ? (
            <FileChip
              name={driveFile.name}
              sub={driveFile.sizeBytes > 0 ? formatBytes(driveFile.sizeBytes) : 'מ-Google Drive'}
              onChange={() => void openPicker()}
              disabled={disabled}
            />
          ) : compact ? (
            <button
              type="button"
              disabled={disabled || picking}
              onClick={() => void openPicker()}
              className="group flex w-full items-center gap-3 rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-3.5 text-right transition-colors hover:border-primary/50 hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {picking ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {picking ? 'פותח את Google Drive…' : 'בחירה מ-Google Drive'}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  בחרו סרטון שכבר נמצא ב-Drive שלכם, בלי להעלות מחדש.
                </span>
              </span>
            </button>
          ) : (
            <>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <HardDrive className="h-7 w-7" strokeWidth={1.8} />
              </div>
              <h3 className="text-base font-medium text-foreground">
                בחירה מ-Google Drive
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                בחרו סרטון שכבר נמצא ב-Drive שלכם, בלי להעלות מחדש.
              </p>
              <button
                type="button"
                disabled={disabled || picking}
                onClick={() => void openPicker()}
                className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {picking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <HardDrive className="h-4 w-4" />
                )}
                {picking ? 'פותח את Google Drive…' : 'בחירה מ-Drive'}
              </button>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/** Drag-and-drop / click video picker (desktop: the IdleStep drop
 *  zone). The whole zone is the affordance — click anywhere opens the
 *  file picker, drop anywhere accepts the file. The CTA is a <span> so
 *  a click on it bubbles to the zone (one picker, not two). The
 *  hidden <input type=file> lives with the caller (`inputRef`). */
function UploadZone({
  onPick,
  inputRef,
  disabled = false,
  compact = false,
  title,
  dragTitle,
  body,
  cta,
}: {
  onPick: (f: File | null) => void
  inputRef: React.RefObject<HTMLInputElement>
  disabled?: boolean
  compact?: boolean
  title: string
  dragTitle: string
  body: string
  cta: string
}) {
  const [dragOver, setDragOver] = useState(false)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (disabled) return
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onPick(dropped)
  }

  const zoneProps = {
    role: 'button' as const,
    tabIndex: disabled ? -1 : 0,
    'aria-disabled': disabled || undefined,
    onClick: () => {
      if (!disabled) inputRef.current?.click()
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (disabled) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        inputRef.current?.click()
      }
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled) setDragOver(true)
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled) setDragOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.currentTarget === e.target) setDragOver(false)
    },
    onDrop: handleDrop,
  }

  if (compact) {
    return (
      <div
        {...zoneProps}
        className={
          'group flex cursor-pointer items-center gap-3 rounded-xl border border-dashed px-4 py-3.5 text-right transition-colors ' +
          (dragOver
            ? 'border-primary bg-primary/[0.06]'
            : 'border-white/15 bg-white/[0.02] hover:border-primary/50 hover:bg-white/[0.03]')
        }
      >
        <span
          className={
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-primary transition-colors ' +
            (dragOver ? 'bg-primary/20' : 'bg-primary/10')
          }
        >
          <FileVideo className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {dragOver ? dragTitle : title}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            או לחצו לבחירת קובץ מהמחשב
          </span>
        </span>
      </div>
    )
  }

  return (
    <div
      {...zoneProps}
      className={
        'group flex cursor-pointer flex-col items-center rounded-2xl border border-dashed px-6 py-8 text-center transition-colors ' +
        (dragOver
          ? 'border-primary bg-primary/[0.06]'
          : 'border-white/15 bg-white/[0.02] hover:border-primary/50 hover:bg-white/[0.03]')
      }
    >
      <div
        className={
          'mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-primary transition-colors ' +
          (dragOver ? 'bg-primary/20' : 'bg-primary/10')
        }
      >
        <FileVideo className="h-7 w-7" strokeWidth={1.8} />
      </div>
      <h3 className="text-base font-medium text-foreground">
        {dragOver ? dragTitle : title}
      </h3>
      <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {body}
      </p>
      <span className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all group-hover:bg-primary/90">
        <Upload className="h-4 w-4" />
        {cta}
      </span>
    </div>
  )
}

/** Picked-file chip with a "החלפה" action (desktop: ReadyStep chip). */
function FileChip({
  name,
  sub,
  onChange,
  disabled,
}: {
  name: string
  sub: string
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-right">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <FileVideo className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" dir="ltr">
          {name}
        </div>
        <div className="text-[11px] text-muted-foreground">
          <bdi dir="ltr">{sub}</bdi>
        </div>
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
        >
          החלפה
        </button>
      )}
    </div>
  )
}

/** Icon + title/body + the app's Switch. The whole row flips the
 *  switch; the switch itself stays a real control for keyboard /
 *  screen-reader users. */
function ToggleRow({
  icon: Icon,
  title,
  body,
  value,
  onChange,
  disabled,
}: {
  icon: typeof Lock
  title: string
  body: string
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div
      onClick={() => !disabled && onChange(!value)}
      className={
        'flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 transition-colors ' +
        (disabled
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer hover:border-white/10 hover:bg-white/[0.04]')
      }
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      </div>
      <Switch
        checked={value}
        onChange={onChange}
        disabled={disabled}
        label={title}
      />
    </div>
  )
}

/** The app's squared switch (desktop: components/ui/Switch.tsx, a Radix
 *  Switch) redrawn as a plain <button role="switch"> with the same
 *  classes. RTL: the thumb starts on the right and slides left. */
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        // The row's onClick already flips on a wrapper click; stop the
        // bubble so a click exactly on the switch doesn't double-toggle.
        e.stopPropagation()
        if (!disabled) onChange(!checked)
      }}
      className={
        'peer relative inline-flex h-5 w-10 shrink-0 cursor-pointer items-center rounded-md border transition-colors duration-300 ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        'before:absolute before:inset-0 before:rounded-md before:bg-primary/40 before:blur-md before:transition-opacity before:duration-300 ' +
        (checked
          ? 'border-primary bg-primary before:opacity-100'
          : 'border-border bg-white/[0.04] before:opacity-0')
      }
    >
      <span
        className={
          'pointer-events-none relative z-10 block h-3.5 w-3.5 rounded-sm shadow-lg ring-0 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ' +
          (checked ? '-translate-x-5 bg-background' : 'translate-x-0 bg-foreground/95')
        }
      />
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  Misc utilities
 * ══════════════════════════════════════════════════════════════ */

/** "ממש עכשיו" / "לפני 5 דק׳" / "לפני 3 ימים" / "12 בספט׳" — the
 *  app's relative time format for cards and round rows. */
function formatRelative(ts: number): string {
  if (!ts) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return 'ממש עכשיו'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `לפני ${diffMin} דק׳`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `לפני ${diffH} שע׳`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 7) return `לפני ${diffD} ימים`
  try {
    return new Date(ts).toLocaleDateString('he-IL', {
      day: 'numeric',
      month: 'short',
    })
  } catch {
    return ''
  }
}

/** "28.09, 14:05" — note + note-history timestamps (app format). */
function formatShortDateTime(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** "M:SS" / "H:MM:SS" — for note timestamps tied to a specific
 *  second in the video. Returns empty string when timeSeconds
 *  is null (general note not pinned to a moment). */
function formatTimestamp(seconds: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return ''
  }
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  return `${m}:${String(sec).padStart(2, '0')}`
}
