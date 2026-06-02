/** Hard cap on the file size the web upload flow accepts. Drive
 *  itself can handle 5 TB per file, but a 2 GB cap on the web
 *  side gives us a sane upper bound for browser memory pressure
 *  (each File.slice() into an XHR PUT still holds the chunk in
 *  RAM during transit) and matches the operator's preference of
 *  keeping the per-round footprint modest so the user's Drive
 *  quota lasts. The cap is enforced both at file-pick time
 *  (instant validation, before the user clicks upload) and at
 *  submit time (defence-in-depth in case the picker is bypassed). */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB

/**
 * RevisionsWorkspace — the editor side of the Revisions feature
 * for the web. Replaces the WorkspacePlaceholder once the user
 * is authenticated AND Pro.
 *
 * Three top-level states:
 *
 *   1. Drive not connected → ConnectDriveEmptyState (single CTA
 *      that pops the OAuth flow, polls for return).
 *   2. Connected, no projects → ConnectedEmpty (project list with
 *      one "+ פרויקט חדש" affordance).
 *   3. Connected, with projects → ConnectedWorkspace (full list +
 *      action bar + Drive storage footer).
 *
 * Modals for create / edit / add-round are inline at the bottom
 * to keep the file self-contained — they're tightly coupled to
 * the workspace and don't need to live elsewhere.
 *
 * What this file does NOT do (deferred):
 *   - ProjectDetailView (the 1080-line notes browser from the
 *     desktop). The web "open project" affordance just opens the
 *     public review link in a new tab — the editor can browse
 *     notes there. A first-class notes-browser is a future port.
 *   - ReplaceVideoModal. Same reasoning — less-common flow,
 *     desktop has it for now.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Copy,
  ExternalLink,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
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
  fetchDriveIntegration,
  fetchDriveStorage,
  fetchNoteMediaAsObjectUrl,
  formatBytes,
  listGroupsForOwner,
  listNotesAsOwner,
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

export function RevisionsWorkspace() {
  // `undefined` = still loading. `null` = not connected. Object = connected.
  // Three-state split prevents the empty-state from flashing during the
  // initial fetch on a returning user who's already connected.
  const [drive, setDrive] = useState<DriveIntegration | null | undefined>(undefined)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const d = await fetchDriveIntegration()
      if (!cancelled) setDrive(d)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const requestRefresh = useCallback(() => {
    setRefreshKey((n) => n + 1)
  }, [])

  if (drive === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-fg-muted">
        טוען…
      </div>
    )
  }

  if (drive === null) {
    return <ConnectDriveEmptyState onRequestRefresh={requestRefresh} />
  }

  return (
    <ConnectedWorkspace
      drive={drive}
      onDisconnected={() => setDrive(null)}
    />
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ConnectDriveEmptyState — single-CTA hero
 * ────────────────────────────────────────────────────────────── */

function ConnectDriveEmptyState({
  onRequestRefresh,
}: {
  onRequestRefresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When true, fires `onRequestRefresh` every 2s for up to 5min
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
  // dies if the user abandons the flow.
  useEffect(() => {
    if (!waitingForOAuth) return
    const interval = window.setInterval(() => onRequestRefresh(), 2000)
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
          'נחסם פתיחת חלון חדש. אפשרו popups לדומיין dmplus.net ונסו שוב.',
        )
      }
      setWaitingForOAuth(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'פתיחת החלון נכשלה')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl py-16 text-center">
      <div className="mx-auto mb-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <DriveIcon className="h-8 w-8" />
      </div>
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
        — סבבי תיקונים
      </div>
      <h1 className="mb-4 text-3xl font-medium tracking-tight text-fg">
        חיבור Google Drive
      </h1>
      <p className="mx-auto mb-8 max-w-md text-sm leading-relaxed text-fg-muted">
        סבבי התיקונים נשמרים בדרייב שלך — אנחנו לא מאחסנים את
        הסרטונים אצלנו. כדי להתחיל, חברו חשבון Google.
      </p>
      <button
        type="button"
        onClick={handleConnect}
        disabled={busy}
        className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
      >
        {waitingForOAuth
          ? 'ממתינים לאישור Google…'
          : busy
            ? 'פותח חלון…'
            : 'חיבור Google Drive'}
      </button>
      {error && (
        <div className="mx-auto mt-4 max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {waitingForOAuth && (
        <p className="mt-6 text-xs text-fg-muted">
          חזרת מ-Google? אפשר לסגור את החלון השני — הדף הזה
          יזהה את החיבור תוך שניות.
        </p>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ConnectedWorkspace — project list + actions
 * ────────────────────────────────────────────────────────────── */

interface Projects {
  groups: RevisionGroup[]
  legacy: LegacyProjectSummary[]
}

function ConnectedWorkspace({
  drive,
  onDisconnected,
}: {
  drive: DriveIntegration
  onDisconnected: () => void
}) {
  const [projects, setProjects] = useState<Projects | null>(null)
  const [storage, setStorage] = useState<DriveStorage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [showNewProject, setShowNewProject] = useState(false)
  const [editingGroup, setEditingGroup] = useState<RevisionGroup | null>(null)
  const [addingRoundTo, setAddingRoundTo] = useState<RevisionGroup | null>(null)
  // When set, opens the per-round notes-browser modal. The `round`
  // and `group` give the modal enough context to fetch notes,
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
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'group'; group: RevisionGroup }
    | { kind: 'round'; group: RevisionGroup; roundId: string }
    | { kind: 'legacy'; project: LegacyProjectSummary }
    | null
  >(null)
  // Disconnect-Drive confirm dialog. Boolean rather than an object
  // because there's only one thing the user can be confirming here.
  // Previously this used window.confirm() — replaced because the
  // native dialog is unstyled, breaks the dark theme, and shows the
  // domain name prefix ("www.dmplus.net says…") which reads as a
  // bug to non-technical users.
  const [confirmDisconnectDrive, setConfirmDisconnectDrive] =
    useState(false)

  const reload = useCallback(() => setRefreshTick((n) => n + 1), [])

  // ── Project list — real-time PUSH listener ────────────────────
  //
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
    let cancelled = false
    void (async () => {
      const s = await fetchDriveStorage()
      if (!cancelled) setStorage(s)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  function handleDisconnect() {
    // Just open the modal. The actual disconnect call moves to
    // the modal's confirm button so the busy state + errors render
    // inside the dialog rather than vanishing into a void.
    setConfirmDisconnectDrive(true)
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
        <button
          type="button"
          onClick={reload}
          className="mt-4 rounded-md border border-border px-5 py-2 text-sm text-fg hover:bg-bg-elevated"
        >
          נסה שוב
        </button>
      </div>
    )
  }

  if (!projects) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-fg-muted">
        טוען פרויקטים…
      </div>
    )
  }

  const isEmpty =
    projects.groups.length === 0 && projects.legacy.length === 0

  // When the editor opened a round to browse its notes, the
  // workspace area swaps to a full-page detail view (slides in
  // from the right, RTL natural direction). AnimatePresence
  // handles the two-way transition so going BACK to the list
  // also animates instead of snapping.
  return (
    <div className="relative space-y-8">
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
                return projects.groups
                  .find((g) => g.id === viewingRound.group.id)
                  ?.rounds.find((r) => r.id === viewingRound.round.id)
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
            className="space-y-8"
          >
            <ActionBar
              onNewProject={() => setShowNewProject(true)}
              drive={drive}
              onDisconnect={handleDisconnect}
            />

            {isEmpty ? (
              <EmptyProjectList onNew={() => setShowNewProject(true)} />
            ) : (
              <ProjectList
                projects={projects}
                onEditGroup={(g) => setEditingGroup(g)}
                onAddRound={(g) => setAddingRoundTo(g)}
                onOpenRound={(g, round) =>
                  setViewingRound({ group: g, round })
                }
                onOpenLegacy={(p) => setViewingRound({ legacy: p })}
                onDeleteRound={(g, roundId) =>
                  setConfirmDelete({ kind: 'round', group: g, roundId })
                }
                onDeleteGroup={(g) =>
                  setConfirmDelete({ kind: 'group', group: g })
                }
                onDeleteLegacy={(p) =>
                  setConfirmDelete({ kind: 'legacy', project: p })
                }
              />
            )}

            {storage && <DriveStorageFooter drive={drive} storage={storage} />}
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
            group={addingRoundTo}
            onClose={() => setAddingRoundTo(null)}
            onAdded={() => {
              setAddingRoundTo(null)
              reload()
            }}
          />
        )}
        {confirmDelete && (
          <ConfirmDeleteModal
            key="delete"
            target={confirmDelete}
            onClose={() => setConfirmDelete(null)}
            onDeleted={() => {
              setConfirmDelete(null)
              reload()
            }}
          />
        )}
        {replacingProject && (
          <ReplaceVideoModal
            key="replace"
            projectId={replacingProject.projectId}
            currentName={replacingProject.currentName}
            onClose={() => setReplacingProject(null)}
            onReplaced={() => {
              setReplacingProject(null)
              reload()
            }}
          />
        )}
        {confirmDisconnectDrive && (
          <ConfirmDisconnectDriveModal
            key="disconnect-drive"
            onClose={() => setConfirmDisconnectDrive(false)}
            onConfirmed={() => {
              setConfirmDisconnectDrive(false)
              onDisconnected()
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ActionBar (top of workspace)
 * ────────────────────────────────────────────────────────────── */

function ActionBar({
  onNewProject,
  drive,
  onDisconnect,
}: {
  onNewProject: () => void
  drive: DriveIntegration
  onDisconnect: () => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <button
        type="button"
        onClick={onNewProject}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
      >
        <Plus className="h-4 w-4" />
        פרויקט חדש
      </button>
      <div className="flex items-center gap-3 text-xs text-fg-muted">
        <DriveIcon className="h-3.5 w-3.5 text-primary" />
        <span dir="ltr" className="truncate">
          {drive.email}
        </span>
        <button
          type="button"
          onClick={onDisconnect}
          className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          ניתוק
        </button>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  EmptyProjectList
 * ────────────────────────────────────────────────────────────── */

function EmptyProjectList({ onNew }: { onNew: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-border bg-bg-card p-10 text-center">
      <h2 className="text-lg font-medium text-fg">אין פרויקטים עדיין</h2>
      <p className="mt-3 text-sm text-fg-muted">
        העלו סרטון, צרו קישור לשליחה ללקוח, וקבלו את התיקונים שלו
        בזמן אמת.
      </p>
      <button
        type="button"
        onClick={onNew}
        className="mt-6 inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
      >
        <Plus className="h-4 w-4" />
        פרויקט חדש
      </button>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ProjectList — groups + legacy in one chronological grid
 * ────────────────────────────────────────────────────────────── */

function ProjectList({
  projects,
  onEditGroup,
  onAddRound,
  onOpenRound,
  onOpenLegacy,
  onDeleteRound,
  onDeleteGroup,
  onDeleteLegacy,
}: {
  projects: Projects
  onEditGroup: (g: RevisionGroup) => void
  onAddRound: (g: RevisionGroup) => void
  onOpenRound: (g: RevisionGroup, round: GroupRoundSummary) => void
  onOpenLegacy: (p: LegacyProjectSummary) => void
  onDeleteRound: (g: RevisionGroup, roundId: string) => void
  onDeleteGroup: (g: RevisionGroup) => void
  onDeleteLegacy: (p: LegacyProjectSummary) => void
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
    <div className="space-y-4">
      {items.map((item) =>
        item.kind === 'group' ? (
          <GroupCard
            key={`g-${item.group.id}`}
            group={item.group}
            onEdit={() => onEditGroup(item.group)}
            onAddRound={() => onAddRound(item.group)}
            onOpenRound={(round) => onOpenRound(item.group, round)}
            onDeleteRound={(roundId) => onDeleteRound(item.group, roundId)}
            onDeleteGroup={() => onDeleteGroup(item.group)}
          />
        ) : (
          <LegacyCard
            key={`l-${item.project.id}`}
            project={item.project}
            onOpen={() => onOpenLegacy(item.project)}
            onDelete={() => onDeleteLegacy(item.project)}
          />
        ),
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  GroupCard — expandable rounds list per project group
 * ────────────────────────────────────────────────────────────── */

function GroupCard({
  group,
  onEdit,
  onAddRound,
  onOpenRound,
  onDeleteRound,
  onDeleteGroup,
}: {
  group: RevisionGroup
  onEdit: () => void
  onAddRound: () => void
  onOpenRound: (round: GroupRoundSummary) => void
  onDeleteRound: (roundId: string) => void
  onDeleteGroup: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shareUrl = buildShareUrl(group.shareToken)

  // `stopActionPropagation` — wrap the inline action buttons so a
  // click on them doesn't ALSO toggle the expand state. The whole
  // header is a button (for keyboard + screen-reader friendliness)
  // so without this, every action click would race with the
  // expand handler.
  const stopActionPropagation = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-card transition-colors hover:border-fg/15">
      {/* Header — entire row is the expand affordance. We use a
          div with role=button (not a real <button>) because the
          row contains nested buttons (copy-link, edit, add-round),
          and nested <button>s are invalid HTML — browsers either
          flatten them or fire double events. role=button keeps
          a11y semantics while allowing the nested buttons to
          stopPropagation cleanly. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((s) => !s)
          }
        }}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer flex-col gap-3 p-5 text-right sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ChevronDownIcon
            // Rotates 180° when expanded so the user gets a
            // visual confirmation of state. The icon itself is
            // an inline SVG — no library needed.
            className={
              'h-4 w-4 shrink-0 text-fg-muted transition-transform duration-200 ' +
              (expanded ? 'rotate-180' : '')
            }
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-medium text-fg">
                {group.title || 'ללא שם'}
              </h3>
              {group.hasPassword && (
                <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
                  סיסמה
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-xs text-fg-muted">
              {/* `<bdi dir="ltr">` isolates pure-LTR fragments
                  (numbers + dates) from the surrounding RTL
                  document direction. Without isolation the
                  bidi algorithm reorders "25.6 MB · 27.05.2026"
                  into something like "MB 25.6 27.05.2026 ·"
                  because punctuation flips direction. */}
              <span>
                <bdi dir="ltr">{group.rounds.length}</bdi> סבבים
              </span>
              <span>·</span>
              <bdi dir="ltr">{formatDateShort(group.updatedAt)}</bdi>
            </div>
          </div>
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          onClick={stopActionPropagation}
        >
          <CopyShareLinkButton url={shareUrl} />
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onAddRound()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onAddRound()
              }
            }}
            // gap-1.5 between icon and label matches the
            // ProjectGroupCard on the desktop side — keeps the
            // two surfaces visually identical at this density.
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            <Plus className="h-3.5 w-3.5" />
            סבב חדש
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onEdit()
              }
            }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            <Pencil className="h-3.5 w-3.5" />
            עריכה
          </span>
        </div>
      </div>

      {/* Rounds list — collapsible. AnimatePresence keeps the
          exit animation alive long enough to fade out, and the
          height: auto trick (initial 0, animate auto) gives a
          natural reveal without a flash of jump. */}
      <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          key="rounds"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
        <div className="border-t border-border bg-bg/40">
          {group.rounds.length === 0 ? (
            <div className="p-4 text-center text-xs text-fg-muted">
              עדיין אין סבבים. לחץ "+ סבב חדש" כדי להעלות סרטון.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {group.rounds.map((round) => (
                <li
                  key={round.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-fg">
                      <span className="font-medium">
                        סבב מס׳ <bdi dir="ltr">{round.roundNumber}</bdi>
                      </span>
                      {round.locked && (
                        <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase text-fg-muted">
                          סגור
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-fg-muted">
                      <bdi dir="ltr">{formatBytes(round.videoSizeBytes)}</bdi>{' '}
                      ·{' '}
                      <bdi dir="ltr">{round.notesCount}</bdi> הערות ·{' '}
                      <bdi dir="ltr">{formatDateShort(round.createdAt)}</bdi>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenRound(round)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      הערות (<bdi dir="ltr">{round.notesCount}</bdi>)
                    </button>
                    <a
                      href={`${shareUrl}?r=${round.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      פתיחה
                    </a>
                    <button
                      type="button"
                      onClick={() => onDeleteRound(round.id)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      מחיקה
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-border p-3 text-left">
            <button
              type="button"
              onClick={onDeleteGroup}
              className="inline-flex items-center gap-1.5 text-xs text-destructive/80 transition-colors hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              מחיקת הפרויקט כולו
            </button>
          </div>
        </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  LegacyCard — pre-group-refactor single-round project
 * ────────────────────────────────────────────────────────────── */

function LegacyCard({
  project,
  onOpen,
  onDelete,
}: {
  project: LegacyProjectSummary
  onOpen: () => void
  onDelete: () => void
}) {
  const shareUrl = buildShareUrl(project.shareToken)
  return (
    <div className="rounded-xl border border-border bg-bg-card p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-medium text-fg">
              {project.title || 'ללא שם'}
            </h3>
            <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
              פרויקט קלאסי
            </span>
            {project.hasPassword && (
              <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
                סיסמה
              </span>
            )}
          </div>
          <div className="mt-1.5 text-xs text-fg-muted">
            <bdi dir="ltr">{formatBytes(project.videoSizeBytes)}</bdi> ·{' '}
            <bdi dir="ltr">{project.notesCount}</bdi> הערות ·{' '}
            <bdi dir="ltr">{formatDateShort(project.updatedAt)}</bdi>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyShareLinkButton url={shareUrl} />
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            הערות (<bdi dir="ltr">{project.notesCount}</bdi>)
          </button>
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            פתיחה
          </a>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            מחיקה
          </button>
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  CopyShareLinkButton
 * ────────────────────────────────────────────────────────────── */

function CopyShareLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Older browsers or insecure contexts — fall back to
      // selecting the URL so the user can copy manually.
      window.prompt('העתק את הקישור:', url)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        // Live inside the GroupCard's role=button container — a
        // bubble would also toggle the expand state. Stop the
        // propagation so the copy action stays isolated.
        e.stopPropagation()
        void copy()
      }}
      className={
        'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ' +
        (copied
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border text-fg hover:bg-bg-elevated')
      }
    >
      <Copy className="h-3.5 w-3.5" />
      {copied ? 'הועתק' : 'העתקת קישור שיתוף'}
    </button>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  DriveStorageFooter
 * ────────────────────────────────────────────────────────────── */

function DriveStorageFooter({
  drive,
  storage,
}: {
  drive: DriveIntegration
  storage: DriveStorage
}) {
  const usedPct = storage.limitBytes
    ? Math.min(100, (storage.usageBytes / storage.limitBytes) * 100)
    : 0
  return (
    <div className="rounded-xl border border-border bg-bg-card p-4 text-xs text-fg-muted">
      <div className="mb-2 flex items-center justify-between">
        <span>
          Drive של{' '}
          <span dir="ltr" className="text-fg">
            {drive.email}
          </span>
        </span>
        {/* Numbers + slash in LTR so 4.3 GB / 15 GB doesn't reverse */}
        <span dir="ltr" className="font-mono text-fg">
          {formatBytes(storage.usageBytes)} / {formatBytes(storage.limitBytes)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${usedPct}%` }}
        />
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  MODALS
 * ══════════════════════════════════════════════════════════════ */

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    // Backdrop: fades in. We don't gate the inner panel on
    // AnimatePresence because it lives inside the parent's
    // conditional render — the parent only mounts ModalShell
    // when it should be visible, so a single entrance animation
    // is enough.
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <motion.div
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-bg-elevated p-6"
        // Subtle entrance — fade + small upward translate. Same
        // shape the BuyPage signin modal uses, so all in-place
        // dialogs across the site feel like one family.
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute left-3 top-3 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-card hover:text-fg"
          aria-label="סגור"
        >
          <CloseIcon />
        </button>
        <h2 className="mb-5 text-lg font-medium text-fg">{title}</h2>
        {children}
      </motion.div>
    </motion.div>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  NewProjectModal — title + password + toggles + optional video
 * ────────────────────────────────────────────────────────────── */

function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [watermark, setWatermark] = useState(true)
  const [allowDownload, setAllowDownload] = useState(false)
  const [openInDrive, setOpenInDrive] = useState(false)
  const [file, setFile] = useState<File | null>(null)
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
   *  so the XHRs in driveUpload.ts stop sending bytes, then
   *  unmounts the modal via the parent. */
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
    if (file && file.size > MAX_UPLOAD_BYTES) {
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
      if (!file) {
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

      // Got a video — full flow: access token → ensure folder →
      // upload chunks → set permissions → create group with the
      // resulting driveFileId. Each step checks abort so a click
      // on cancel exits at the next yield point.
      const at = await fetchDriveAccessToken()
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const folders = await ensureProjectFolders(at.accessToken)
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const upload = await uploadFileToDrive({
        accessToken: at.accessToken,
        file,
        folderId: folders.videosFolderId,
        onProgress: setProgress,
        signal: controller.signal,
      })
      await setShareablePermissions(at.accessToken, upload.driveFileId)
      await createProjectGroup({
        driveFileId: upload.driveFileId,
        driveFolderId: folders.videosFolderId,
        title: title.trim(),
        videoFileName: file.name,
        videoSizeBytes: file.size,
        videoMime: file.type || 'video/mp4',
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
      // Suppress the error toast when the user explicitly aborted
      // — they triggered the cancel, surfacing an error would be
      // noise. The modal closes itself via the cancel handler in
      // that case; we just need to keep the form in a sane state
      // in case the AbortController was triggered by something
      // other than the close button.
      if (controller.signal.aborted) {
        return
      }
      setError(err instanceof Error ? err.message : 'יצירת הפרויקט נכשלה')
    }
  }

  return (
    <ModalShell title="פרויקט חדש" onClose={handleClose}>
      <form onSubmit={submit} className="space-y-4">
        <LabelledField
          label="שם הפרויקט"
          value={title}
          onChange={setTitle}
          autoFocus
        />
        <LabelledField
          label="סיסמה (אופציונלי)"
          value={password}
          onChange={setPassword}
          type="text"
          placeholder="ריק = ללא סיסמה"
        />
        <FileFieldPicker
          file={file}
          onPick={(f) => {
            // Validate size on pick so the error shows up before
            // the user clicks "create" — much better UX than
            // letting them fill out the form and only failing on
            // submit.
            if (f && f.size > MAX_UPLOAD_BYTES) {
              setFile(null)
              setError(
                `הקובץ גדול מהמותר. המקסימום הוא ${formatBytes(MAX_UPLOAD_BYTES)}.`,
              )
              return
            }
            setError(null)
            setFile(f)
          }}
          inputRef={fileInputRef}
        />
        <ToggleRow
          label="חתימת מים על הסרטון"
          description="מציג את כתובת המייל של הצופה על גבי הוידאו"
          value={watermark}
          onChange={setWatermark}
        />
        <ToggleRow
          label="לאפשר הורדה ללקוח"
          description="מוסיף כפתור 'הורדה' בדף הצפייה הציבורי"
          value={allowDownload}
          onChange={setAllowDownload}
        />
        <ToggleRow
          label="לאפשר פתיחה ב-Drive"
          description="מוסיף קישור לפתיחת הסרטון ב-Google Drive"
          value={openInDrive}
          onChange={setOpenInDrive}
        />
        {progress && (
          <UploadProgressBar progress={progress} fileName={file?.name || ''} />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-fg-muted transition-colors hover:text-fg"
          >
            {busy ? 'ביטול ההעלאה' : 'ביטול'}
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
          >
            {busy
              ? progress
                ? `מעלה ${Math.round(progress.fraction * 100)}%`
                : 'יוצר…'
              : file
                ? 'יצירה והעלאה'
                : 'יצירת פרויקט ריק'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  AddRoundModal — upload a new round into an existing group
 * ────────────────────────────────────────────────────────────── */

function AddRoundModal({
  group,
  onClose,
  onAdded,
}: {
  group: RevisionGroup
  onClose: () => void
  onAdded: () => void
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !file) return
    if (file.size > MAX_UPLOAD_BYTES) {
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
      const at = await fetchDriveAccessToken()
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const folders = await ensureProjectFolders(at.accessToken)
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const upload = await uploadFileToDrive({
        accessToken: at.accessToken,
        file,
        folderId: folders.videosFolderId,
        onProgress: setProgress,
        signal: controller.signal,
      })
      await setShareablePermissions(at.accessToken, upload.driveFileId)
      await addRoundToGroup({
        groupId: group.id,
        driveFileId: upload.driveFileId,
        driveFolderId: folders.videosFolderId,
        videoFileName: file.name,
        videoSizeBytes: file.size,
        videoMime: file.type || 'video/mp4',
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
    <ModalShell
      // Project name lives in the workspace below (and at the top
      // of the round-detail view if the editor came from there) —
      // including it in the modal title produced awkward results
      // when the project name was a number, e.g. "סבב חדש — 1"
      // read as a dangling math expression. Keep the title clean
      // and let the call-site context do the disambiguation work.
      title="סבב חדש"
      onClose={handleClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <DropZone
          file={file}
          onPick={(f) => {
            if (f && f.size > MAX_UPLOAD_BYTES) {
              setFile(null)
              setError(
                `הקובץ גדול מהמותר. המקסימום הוא ${formatBytes(MAX_UPLOAD_BYTES)}.`,
              )
              return
            }
            setError(null)
            setFile(f)
          }}
          inputRef={fileInputRef}
          disabled={busy}
        />
        {progress && (
          <UploadProgressBar progress={progress} fileName={file?.name || ''} />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-fg-muted transition-colors hover:text-fg"
          >
            {busy ? 'ביטול ההעלאה' : 'ביטול'}
          </button>
          <button
            type="submit"
            disabled={busy || !file}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
          >
            {busy
              ? progress
                ? `מעלה ${Math.round(progress.fraction * 100)}%`
                : 'מעלה…'
              : 'העלאת סבב'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ReplaceVideoModal — swap the video on an existing round.
 *
 *  Same upload pipeline as AddRound (drop zone + chunked upload +
 *  permissions), but the final server call is `replace-project-
 *  video` instead of `add-round-to-group`. Notes + share token
 *  + lock state on the round are preserved across the swap; only
 *  the underlying Drive file changes. Most editors hit this when
 *  they uploaded the wrong cut and need to fix it without losing
 *  the round's history.
 * ────────────────────────────────────────────────────────────── */

function ReplaceVideoModal({
  projectId,
  currentName,
  onClose,
  onReplaced,
}: {
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
      const at = await fetchDriveAccessToken()
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const folders = await ensureProjectFolders(at.accessToken)
      if (controller.signal.aborted) throw new Error('ההעלאה בוטלה')
      const upload = await uploadFileToDrive({
        accessToken: at.accessToken,
        file,
        folderId: folders.videosFolderId,
        onProgress: setProgress,
        signal: controller.signal,
      })
      await setShareablePermissions(at.accessToken, upload.driveFileId)
      const r = await replaceProjectVideo({
        projectId,
        driveFileId: upload.driveFileId,
        driveFolderId: folders.videosFolderId,
        videoFileName: file.name,
        videoSizeBytes: file.size,
        videoMime: file.type || 'video/mp4',
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

  return (
    <ModalShell title="החלפת וידאו" onClose={handleClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-md border border-border bg-bg-card px-3 py-2.5 text-xs text-fg-muted">
          הוידאו הקודם יוחלף ב-{currentName}. ההערות, קישור
          השיתוף, הסיסמה ושאר ההגדרות יישמרו ללא שינוי.
        </div>
        <DropZone
          file={file}
          onPick={(f) => {
            if (f && f.size > MAX_UPLOAD_BYTES) {
              setFile(null)
              setError(
                `הקובץ גדול מהמותר. המקסימום הוא ${formatBytes(MAX_UPLOAD_BYTES)}.`,
              )
              return
            }
            setError(null)
            setFile(f)
          }}
          inputRef={fileInputRef}
          disabled={busy}
        />
        {progress && (
          <UploadProgressBar progress={progress} fileName={file?.name || ''} />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-fg-muted transition-colors hover:text-fg"
          >
            {busy ? 'ביטול ההעלאה' : 'ביטול'}
          </button>
          <button
            type="submit"
            disabled={busy || !file}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
          >
            {busy
              ? progress
                ? `מעלה ${Math.round(progress.fraction * 100)}%`
                : 'מעלה…'
              : 'החלפת הוידאו'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ConfirmDisconnectDriveModal — replaces the native window.confirm
 *
 *  The previous flow used `window.confirm(...)`. That breaks the
 *  dark theme, prefixes the text with the domain ("www.dmplus.net
 *  says…") which reads as suspicious to non-technical users, and
 *  blocks the entire renderer thread until dismissed. Switched to
 *  a regular themed modal so the disconnect prompt looks like
 *  every other confirmation in the workspace.
 *
 *  The actual disconnectDrive() call moves into here so we can
 *  surface a loading state ("מנתק…") and an inline error message
 *  if the server rejects the request — the native confirm() had
 *  nowhere to put either of those.
 * ────────────────────────────────────────────────────────────── */

function ConfirmDisconnectDriveModal({
  onClose,
  onConfirmed,
}: {
  onClose: () => void
  onConfirmed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await disconnectDrive()
    } catch (err) {
      setBusy(false)
      setError(
        err instanceof Error ? err.message : 'הניתוק נכשל',
      )
      return
    }
    // Even if disconnectDrive's internal try/catch swallowed an
    // error and we got here without throwing, we still want to
    // flip the UI — the worst case is the user reconnects and
    // overrides the stale Firestore doc. The fail-safe is "the
    // user is OUT of this Drive integration locally" which is
    // what the modal promised.
    onConfirmed()
  }

  return (
    <ModalShell title="ניתוק חשבון Google Drive" onClose={onClose}>
      <p className="text-sm leading-relaxed text-fg-muted">
        הפרויקטים הקיימים יישארו, אבל לא יהיה אפשר להעלות סבבים
        חדשים או לגשת לפרוייקטים הקיימים עד קישור חשבון Google
        מחדש. הקבצים שהועלו עד עכשיו יישארו ב-Drive שלך.
      </p>
      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-sm text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
        >
          ביטול
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          className="rounded-md bg-destructive px-5 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'מנתק…' : 'ניתוק'}
        </button>
      </div>
    </ModalShell>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  EditGroupModal — password + 3 toggles
 * ────────────────────────────────────────────────────────────── */

function EditGroupModal({
  group,
  onClose,
  onSaved,
}: {
  group: RevisionGroup
  onClose: () => void
  onSaved: () => void
}) {
  // Password input starts BLANK by design — we never show the
  // existing password (we don't even have it; only the hash lives
  // on the server). The "סיסמה: מופעלת" hint tells the editor
  // whether one is currently set. Submitting blank = keep existing;
  // submitting a value = replace; submitting the explicit "clear"
  // action = remove.
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
    <ModalShell title={`עריכת ${group.title}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs text-fg-muted">
            סיסמה
            {group.hasPassword && (
              <span className="ms-2 rounded bg-bg-card px-1.5 py-0.5 text-[10px] uppercase">
                מופעלת
              </span>
            )}
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (e.target.value) setClearPw(false)
              }}
              disabled={clearPw}
              placeholder={
                group.hasPassword
                  ? 'השאר ריק כדי לא לשנות'
                  : 'ריק = ללא סיסמה'
              }
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2.5 pe-10 text-sm text-fg placeholder:text-fg-faint focus:border-fg/30 focus:outline-none disabled:opacity-50"
            />
            {/* Eye toggle — same UX the desktop's EditProjectGroup
                uses. Disabled when "clear password" is on (no
                point in showing nothing). The button lives in the
                input padding (pe-10) so it doesn't visually
                detach from the field. */}
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPassword((s) => !s)}
              disabled={clearPw}
              aria-label={showPassword ? 'הסתר סיסמה' : 'הצג סיסמה'}
              className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-fg-muted transition-colors hover:text-fg disabled:opacity-30"
            >
              {showPassword ? (
                <EyeOffIcon className="h-4 w-4" />
              ) : (
                <EyeIcon className="h-4 w-4" />
              )}
            </button>
          </div>
          {/* Hint mirrors the desktop's wording — important so a
              user who changes the password understands existing
              client sessions don't get kicked out immediately. */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
            לקוחות שכבר נכנסו עם הסיסמה הקודמת יישארו בפנים עד 6
            שעות.
          </p>
          {group.hasPassword && (
            <label className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={clearPw}
                onChange={(e) => {
                  setClearPw(e.target.checked)
                  if (e.target.checked) setPassword('')
                }}
                className="accent-current"
              />
              הסרת הסיסמה הקיימת
            </label>
          )}
        </div>
        <ToggleRow
          label="חתימת מים"
          value={watermark}
          onChange={setWatermark}
        />
        <ToggleRow
          label="לאפשר הורדה"
          value={allowDownload}
          onChange={setAllowDownload}
        />
        <ToggleRow
          label="לאפשר פתיחה ב-Drive"
          value={openInDrive}
          onChange={setOpenInDrive}
        />
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-fg-muted hover:text-fg"
          >
            ביטול
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-40"
          >
            {busy ? 'שומר…' : 'שמירה'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  ConfirmDeleteModal — round / group / legacy
 * ────────────────────────────────────────────────────────────── */

function ConfirmDeleteModal({
  target,
  onClose,
  onDeleted,
}: {
  target:
    | { kind: 'group'; group: RevisionGroup }
    | { kind: 'round'; group: RevisionGroup; roundId: string }
    | { kind: 'legacy'; project: LegacyProjectSummary }
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleteDrive, setDeleteDrive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isRound = target.kind === 'round'
  const title = isRound
    ? 'מחיקת סבב'
    : target.kind === 'group'
      ? `מחיקת הפרויקט "${target.group.title}"`
      : `מחיקת הפרויקט "${target.project.title}"`

  async function confirm() {
    setBusy(true)
    setError(null)
    let result: { ok: boolean; error?: string } = { ok: true }
    if (target.kind === 'round') {
      result = await deleteRound(target.roundId, deleteDrive)
    } else if (target.kind === 'group') {
      result = await deleteGroup(target.group.id, deleteDrive)
    } else {
      const ok = await deleteLegacyProject(target.project.id, deleteDrive)
      result = { ok }
    }
    setBusy(false)
    if (!result.ok) {
      setError(result.error || 'המחיקה נכשלה')
      return
    }
    onDeleted()
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <p className="text-sm leading-relaxed text-fg-muted">
        הקישור הציבורי יפסיק לעבוד מיד. הפעולה לא ניתנת לביטול.
      </p>
      <label className="mt-4 flex items-start gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={deleteDrive}
          onChange={(e) => setDeleteDrive(e.target.checked)}
          className="mt-0.5 accent-current"
        />
        <span>
          למחוק גם את קבצי הוידאו מ-Google Drive (הם יישלחו לסל
          המחזור של Drive ל-30 ימים, ניתן לשחזר ידנית)
        </span>
      </label>
      {error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="text-sm text-fg-muted hover:text-fg disabled:opacity-40"
        >
          ביטול
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          className="rounded-md bg-destructive px-5 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'מוחק…' : 'מחיקה'}
        </button>
      </div>
    </ModalShell>
  )
}

/* ──────────────────────────────────────────────────────────────
 *  RoundDetailModal — notes browser for a single round
 *
 *  Mirrors the desktop's ProjectDetailView but trimmed to fit a
 *  modal. Shows every note the client(s) left, lets the editor
 *  flip statuses (new / resolved / question / not-possible), and
 *  toggles the round's lock state. Screenshots + audio attached
 *  to notes are fetched on-demand from the owner-auth media
 *  proxy.
 *
 *  Takes either a {group, round} pair (new-style) or a legacy
 *  standalone project. Both resolve to the same notes endpoint —
 *  the only API difference is which `projectId` we send.
 * ────────────────────────────────────────────────────────────── */

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
   *  viewed. The parent handles the actual modal mount so it can
   *  coexist with other modals (delete confirm etc.) without
   *  fighting for the same z-stack. */
  onRequestReplaceVideo: (projectId: string, currentName: string) => void
}) {
  // Resolve the common fields once so the rest of the modal body
  // doesn't have to switch over `target` on every read.
  const isLegacy = 'legacy' in target
  const projectId = isLegacy ? target.legacy.id : target.round.id
  const title = isLegacy
    ? target.legacy.title || 'ללא שם'
    : `${target.group.title || 'ללא שם'} — סבב מס׳ ${target.round.roundNumber}`
  const shareUrl = isLegacy
    ? buildShareUrl(target.legacy.shareToken)
    : `${buildShareUrl(target.group.shareToken)}?r=${target.round.id}`
  const locked = isLegacy ? target.legacy.locked : target.round.locked

  const [notes, setNotes] = useState<OwnerNote[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyLock, setBusyLock] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

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
  // from any "drill-into" surface across the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
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
      // No auto-navigate-back — the editor stays in the detail
      // view to continue reviewing notes.
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

  return (
    <div className="space-y-6">
      {/* Back link — first thing the eye lands on, top-right in RTL.
          Editorial style matches the rest of the page chrome. */}
      <button
        type="button"
        onClick={onBack}
        className="group inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-fg-muted transition-colors hover:text-fg"
      >
        <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        <span>חזרה לפרויקטים</span>
      </button>

      {/* Title block + action bar */}
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-medium text-fg">{title}</h2>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-fg-muted">
              {notes ? `${notes.length} הערות` : 'טוען…'}
            </span>
            {locked && (
              <span className="rounded bg-bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
                סגור
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyShareLinkButton url={shareUrl} />
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-card"
          >
            צפייה בדף הציבורי
          </a>
          <button
            type="button"
            onClick={() =>
              onRequestReplaceVideo(
                projectId,
                isLegacy ? target.legacy.title : `סבב מס׳ ${target.round.roundNumber}`,
              )
            }
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-card"
          >
            החלפת וידאו
          </button>
          <button
            type="button"
            onClick={() => void toggleLock()}
            disabled={busyLock}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-card disabled:opacity-40"
          >
            {busyLock ? '…' : locked ? 'פתיחת הסבב' : 'סגירת הסבב'}
          </button>
        </div>
      </div>

      {/* Notes list — flows down the page, no inner scroll container.
          The whole /revisions page scrolls naturally when there are
          many notes (better than a fixed-height inner scroll the
          user can lose). */}
      <div>
        {loadError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {loadError}
            <button
              type="button"
              onClick={() => setRefreshKey((n) => n + 1)}
              className="ms-3 underline underline-offset-2"
            >
              נסה שוב
            </button>
          </div>
        ) : !notes ? (
          <div className="py-12 text-center text-sm text-fg-muted">
            טוען הערות…
          </div>
        ) : notes.length === 0 ? (
          <div className="rounded-2xl border border-border bg-bg-card p-12 text-center">
            <h3 className="text-base font-medium text-fg">
              עדיין אין הערות
            </h3>
            <p className="mx-auto mt-3 max-w-md text-sm text-fg-muted">
              הערות שלקוחות מוסיפים דרך הקישור הציבורי יופיעו כאן.
              שלח את הקישור כדי להתחיל.
            </p>
            <div className="mt-5">
              <CopyShareLinkButton url={shareUrl} />
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                projectId={projectId}
                onApplyStatus={(status, payload) =>
                  void applyStatus(note.id, status, payload)
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Single note card — viewer info, timestamp link, body, optional
 *  screenshot + audio, status pill. Lazy-loads the media via the
 *  owner-auth proxy when the card mounts. */
function NoteCard({
  note,
  projectId,
  onApplyStatus,
}: {
  note: OwnerNote
  projectId: string
  onApplyStatus: (status: NoteStatus, editorResponse?: string) => void
}) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [responseDraft, setResponseDraft] = useState(
    note.editorResponse || '',
  )
  const [editingResponse, setEditingResponse] = useState<
    null | 'question' | 'not-possible'
  >(null)

  // Fetch screenshot once on mount (or when the file id changes).
  useEffect(() => {
    if (!note.screenshotDriveFileId) return
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
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [projectId, note.id, note.screenshotDriveFileId])

  // Same for audio.
  useEffect(() => {
    if (!note.audioDriveFileId) return
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
  }, [projectId, note.id, note.audioDriveFileId])

  const ts = formatTimestamp(note.timeSeconds)
  const dateStr = formatDateLong(note.createdAt)

  function submitResponse(kind: 'question' | 'not-possible') {
    if (!responseDraft.trim()) {
      alert(
        kind === 'question'
          ? 'יש לכתוב את השאלה'
          : 'יש לכתוב מדוע אי אפשר',
      )
      return
    }
    onApplyStatus(kind, responseDraft.trim())
    setEditingResponse(null)
  }

  // Whole-card color reflects the note's status, matching the
  // convention used on the public /review page so editors and
  // clients see the same palette across both surfaces:
  //   • טופל (resolved)    = yellow
  //   • שאלה (question)    = sky / blue
  //   • לא אפשרי (not-possible) = red
  //   • חדש (new)          = neutral (default border + faint bg)
  // (Picked over the muted green for "resolved" specifically per
  // operator's call — yellow feels more celebratory than green
  // which was reading as a hospital checkmark.)
  const statusStyles: Record<NoteStatus, string> = {
    new: 'border-border bg-bg-card',
    resolved: 'border-yellow-500/30 bg-yellow-500/[0.07]',
    question: 'border-sky-500/30 bg-sky-500/[0.06]',
    'not-possible': 'border-red-500/30 bg-red-500/[0.07]',
  }
  return (
    <li
      className={
        // Full-bleed status color: card border + bg both pick up
        // the status tint so a note's state reads instantly even
        // when the editor is scrolling fast through a long list.
        'rounded-xl border p-4 transition-colors ' +
        statusStyles[note.status]
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span dir="ltr" className="text-fg">
              {note.viewerEmail}
            </span>
            <span>·</span>
            {ts && (
              <>
                <span dir="ltr" className="font-mono text-fg">
                  {ts}
                </span>
                <span>·</span>
              </>
            )}
            <span>{dateStr}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">
            {note.text}
          </p>
        </div>
        <StatusBadge status={note.status} />
      </div>

      {/* Screenshot */}
      {(screenshotUrl || note.screenshotDataUrl) && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <img
            src={screenshotUrl || note.screenshotDataUrl || ''}
            alt=""
            className="block max-h-72 w-full object-contain"
          />
        </div>
      )}

      {/* Audio */}
      {audioUrl && (
        <audio
          controls
          src={audioUrl}
          className="mt-3 w-full"
        />
      )}

      {/* Existing editor response (status = question / not-possible) */}
      {note.editorResponse && !editingResponse && (
        <div className="mt-3 rounded-md border border-border bg-bg-elevated px-3 py-2 text-xs text-fg-muted">
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
            תגובת העורך
          </div>
          <div className="whitespace-pre-wrap text-fg">
            {note.editorResponse}
          </div>
        </div>
      )}

      {/* Inline response editor */}
      {editingResponse && (
        <div className="mt-3 space-y-2">
          <textarea
            value={responseDraft}
            onChange={(e) => setResponseDraft(e.target.value)}
            rows={2}
            placeholder={
              editingResponse === 'question'
                ? 'איזו שאלה מבהירה ללקוח?'
                : 'מדוע אי אפשר ליישם?'
            }
            className="w-full rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-fg/30 focus:outline-none"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditingResponse(null)
                setResponseDraft(note.editorResponse || '')
              }}
              className="text-xs text-fg-muted hover:text-fg"
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => submitResponse(editingResponse)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-primary-hover"
            >
              שליחת תגובה
            </button>
          </div>
        </div>
      )}

      {/* Status action buttons */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusActionButton
          label="חדש"
          active={note.status === 'new'}
          color="neutral"
          onClick={() => onApplyStatus('new')}
        />
        <StatusActionButton
          label="טופל"
          active={note.status === 'resolved'}
          color="resolved"
          onClick={() => onApplyStatus('resolved')}
        />
        <StatusActionButton
          label="שאלה"
          active={note.status === 'question'}
          color="question"
          onClick={() => setEditingResponse('question')}
        />
        <StatusActionButton
          label="לא אפשרי"
          active={note.status === 'not-possible'}
          color="not-possible"
          onClick={() => setEditingResponse('not-possible')}
        />
      </div>
    </li>
  )
}

function StatusBadge({ status }: { status: NoteStatus }) {
  // Mirrors the public /review page's badge palette so editor +
  // client both see the same colors per status. yellow/sky/red
  // — see NoteCard comment for the rationale.
  const styles: Record<NoteStatus, { label: string; cls: string }> = {
    new: {
      label: 'חדש',
      cls: 'bg-bg-elevated text-fg-muted',
    },
    resolved: {
      label: 'טופל',
      cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/40',
    },
    question: {
      label: 'שאלה',
      cls: 'bg-sky-500/15 text-sky-400 border-sky-500/40',
    },
    'not-possible': {
      label: 'לא אפשרי',
      cls: 'bg-red-500/15 text-red-400 border-red-500/40',
    },
  }
  const s = styles[status]
  return (
    <span
      className={
        'rounded-full border border-transparent px-2.5 py-0.5 text-[10px] uppercase tracking-wider ' +
        s.cls
      }
    >
      {s.label}
    </span>
  )
}

function StatusActionButton({
  label,
  active,
  color,
  onClick,
}: {
  label: string
  active: boolean
  // Names map to the four note statuses, not abstract semantic
  // colors, so the call-site stays readable: a "resolved" button
  // uses the yellow palette (per the public-review convention),
  // a "question" button uses sky, etc.
  color: 'neutral' | 'resolved' | 'question' | 'not-possible'
  onClick: () => void
}) {
  const colorOn: Record<typeof color, string> = {
    neutral: 'border-fg/30 bg-bg-elevated text-fg',
    resolved: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400',
    question: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
    'not-possible': 'border-red-500/40 bg-red-500/10 text-red-400',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md border px-3 py-1.5 text-xs transition-colors ' +
        (active
          ? colorOn[color]
          : 'border-border text-fg-muted hover:bg-bg-elevated hover:text-fg')
      }
    >
      {label}
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  SHARED PRIMITIVES
 * ══════════════════════════════════════════════════════════════ */

function LabelledField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs text-fg-muted">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full rounded-md border border-border bg-bg-card px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-fg/30 focus:outline-none"
      />
    </div>
  )
}

function FileFieldPicker({
  file,
  onPick,
  inputRef,
  required = false,
}: {
  file: File | null
  onPick: (f: File | null) => void
  inputRef: React.RefObject<HTMLInputElement>
  required?: boolean
}) {
  return (
    <div>
      <label className="mb-1.5 flex items-center justify-between text-xs text-fg-muted">
        <span>
          קובץ וידאו{' '}
          {required && <span className="text-destructive">*</span>}
        </span>
        {/* Display the size cap inline so the user knows the
            constraint BEFORE they pick a giant file and get an
            error toast. Same surface, less surprise. */}
        <span className="text-fg-faint">
          עד <bdi dir="ltr">{formatBytes(MAX_UPLOAD_BYTES)}</bdi>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-md border border-border px-4 py-2 text-xs text-fg transition-colors hover:bg-bg-card"
        >
          בחירת קובץ
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {file
            ? `${file.name} (${formatBytes(file.size)})`
            : required
              ? 'חובה לבחור קובץ'
              : 'לא נבחר קובץ (אפשר להוסיף סבב אחר כך)'}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] || null)}
      />
    </div>
  )
}

/** Large drag-and-drop file picker. Bigger visual presence than
 *  FileFieldPicker — meant for modals where uploading is the
 *  primary action (add-round, replace-video) rather than one
 *  field among many (new-project).
 *
 *  States:
 *    - empty / idle: dashed border + upload icon + prompt
 *    - dragging-over: solid primary border + tinted bg
 *    - file picked: filename + size badge + "replace" link
 *    - disabled (during upload): muted, no interactions
 *
 *  Accepts the file from either drop event OR the hidden
 *  <input type=file>, so users who prefer the click flow get the
 *  same experience.
 */
function DropZone({
  file,
  onPick,
  inputRef,
  disabled = false,
}: {
  file: File | null
  onPick: (f: File | null) => void
  inputRef: React.RefObject<HTMLInputElement>
  disabled?: boolean
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

  return (
    <div>
      <label className="mb-2 flex items-center justify-between text-xs text-fg-muted">
        <span>קובץ וידאו</span>
        <span className="text-fg-faint">
          עד <bdi dir="ltr">{formatBytes(MAX_UPLOAD_BYTES)}</bdi>
        </span>
      </label>
      {/* The whole zone is the affordance — click anywhere opens
          the file picker, drop anywhere accepts the file. We use
          a div + role=button (not a real <button>) because a
          button can't legally contain the "replace" button shown
          when a file is already picked. */}
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
          'group relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-all ' +
          (disabled
            ? 'cursor-not-allowed border-border bg-bg-card/40 opacity-60'
            : dragOver
              ? 'border-primary bg-primary/10 scale-[1.01]'
              : file
                ? 'border-border bg-bg-card hover:border-fg/20'
                : 'cursor-pointer border-border bg-bg-card hover:border-fg/30 hover:bg-bg-elevated')
        }
      >
        {file ? (
          <>
            {/* File picked — show filename + size in a clean
                row, with a "replace" action to swap it out. */}
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <VideoFileIcon className="h-6 w-6" />
            </div>
            <div className="min-w-0 max-w-full">
              <div className="truncate text-sm font-medium text-fg">
                {file.name}
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                <bdi dir="ltr">{formatBytes(file.size)}</bdi>
              </div>
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  inputRef.current?.click()
                }}
                className="text-xs text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
              >
                החלפת קובץ
              </button>
            )}
          </>
        ) : (
          <>
            <div
              className={
                'flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ' +
                (dragOver
                  ? 'bg-primary/20 text-primary'
                  : 'bg-bg-elevated text-fg-muted group-hover:bg-primary/10 group-hover:text-primary')
              }
            >
              <UploadIcon className="h-7 w-7" />
            </div>
            <div>
              <div className="text-sm font-medium text-fg">
                {dragOver ? 'שחרר כאן' : 'גרור קובץ וידאו לכאן'}
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                או <span className="text-primary">לחץ כדי לבחור</span> מהמחשב
              </div>
            </div>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] || null)}
      />
    </div>
  )
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md border border-border bg-bg-card px-3 py-2.5 hover:border-fg/20">
      <div>
        <div className="text-sm text-fg">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-fg-muted">{description}</div>
        )}
      </div>
      <Switch checked={value} onChange={onChange} />
    </label>
  )
}

/** Custom squared switch — mirrors the desktop Switch (built on
 *  Radix), but without the dependency. Same visual: square track
 *  with rounded corners, tile-shaped thumb, copper "on" state
 *  with a soft halo glow. The whole component is a real <button>
 *  so it's keyboard-operable + screen-reader-friendly (role and
 *  aria-checked attributes get the right state).
 *
 *  RTL note: thumb starts on the right of the track (RTL inline
 *  direction) and slides LEFT to the "on" position. Physical
 *  translate so the animation feels identical in any language. */
function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  // Use framer-motion so the toggle's thumb animation is
  // declarative + interruptible. Plain CSS `transition-transform`
  // works in most cases, but it occasionally snaps on the very
  // first interaction (some browsers skip the transition when
  // the className is replaced rather than mutated). Framer's
  // animate prop reliably triggers on every state change.
  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault()
        if (!disabled) onChange(!checked)
      }}
      // Tap-down feedback — track contracts by 2% for a moment.
      // Mirrors the "press" feel users expect from a physical
      // toggle. whileTap is interruptible: if the user releases
      // mid-press the animation snaps right back.
      whileTap={disabled ? undefined : { scale: 0.95 }}
      // Track color transition handled by framer too. CSS
      // transition-colors works fine here but we want the same
      // spring physics as the thumb so the whole switch feels
      // unified.
      animate={{
        backgroundColor: checked
          ? 'var(--primary)'
          : 'rgba(255,255,255,0.04)',
        borderColor: checked ? 'var(--primary)' : 'var(--border)',
      }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={
        'relative mt-0.5 inline-flex h-5 w-10 shrink-0 items-center rounded-md border ' +
        (disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')
      }
    >
      {/* Soft halo glow when "on" — absolutely positioned so it
          doesn't shift the track's box. */}
      <motion.span
        aria-hidden="true"
        animate={{ opacity: checked ? 1 : 0 }}
        transition={{ duration: 0.22 }}
        className="pointer-events-none absolute inset-0 rounded-md bg-primary/40 blur-md"
      />
      {/* Thumb — tile-shaped, ~18 px travel from right to left.
          x is a transform so it animates smoothly on the GPU;
          the spring curve gives a small overshoot for a snappy
          physical feel (matches the desktop's Radix switch). */}
      <motion.span
        aria-hidden="true"
        animate={{
          x: checked ? -18 : -3,
          backgroundColor: checked
            ? 'var(--bg)'
            : 'rgba(245,239,230,0.95)',
        }}
        transition={{
          x: {
            type: 'spring',
            stiffness: 500,
            damping: 32,
            mass: 0.8,
          },
          backgroundColor: { duration: 0.22 },
        }}
        className="pointer-events-none relative z-10 block h-3.5 w-3.5 rounded-sm shadow-lg"
      />
    </motion.button>
  )
}

function UploadProgressBar({
  progress,
  fileName,
}: {
  progress: UploadProgress
  fileName: string
}) {
  const pct = Math.round(progress.fraction * 100)
  return (
    <div className="rounded-md border border-border bg-bg-card p-3">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="truncate text-fg-muted">{fileName}</span>
        <span dir="ltr" className="font-mono text-fg">
          {pct}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  ICONS (inline SVG to skip icon-library dependency)
 * ══════════════════════════════════════════════════════════════ */

function DriveIcon({ className }: { className?: string }) {
  // Stylized Drive triangle — recognisable silhouette without
  // shipping the brand-colored asset. Stroke matches text size.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m12 3 7 12-3.5 6h-7L5 15 12 3Z" />
      <path d="M12 3 5 15h7" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function ChevronDownIcon({ className }: { className?: string }) {
  // Used by GroupCard as the expand affordance. Rotates 180° via
  // a Tailwind transform when the card is open — single glyph,
  // two visual states, no PNG asset needed.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

function UploadIcon({ className }: { className?: string }) {
  // Tray-with-up-arrow — universally read as "upload" across
  // OS icon sets. Used in the drag-and-drop zone's empty state.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function VideoFileIcon({ className }: { className?: string }) {
  // File-with-play-triangle — for the drop zone's "file picked"
  // state. Reads as "this is a video file" at a glance.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <polygon points="10 11 16 14.5 10 18" />
    </svg>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  // Used by the round-detail view's back link. Points RIGHT
  // because in an RTL document, "back" navigates rightward (to
  // the start of the reading direction). Mirrors what the desktop
  // app's back-button arrow does.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/* ══════════════════════════════════════════════════════════════
 *  Misc utilities
 * ══════════════════════════════════════════════════════════════ */

function formatDateShort(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

function formatDateLong(ts: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
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
