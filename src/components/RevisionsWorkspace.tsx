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
  // When true, fires `onRequestRefresh` every 2s for up to 90s
  // after we open the OAuth tab. Once the parent sees `connected`
  // it unmounts us, automatically clearing the polling effect.
  const [waitingForOAuth, setWaitingForOAuth] = useState(false)

  useEffect(() => {
    if (!waitingForOAuth) return
    const interval = window.setInterval(() => onRequestRefresh(), 2000)
    const timeout = window.setTimeout(() => {
      setWaitingForOAuth(false)
      setBusy(false)
    }, 90_000)
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
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'group'; group: RevisionGroup }
    | { kind: 'round'; group: RevisionGroup; roundId: string }
    | { kind: 'legacy'; project: LegacyProjectSummary }
    | null
  >(null)

  const reload = useCallback(() => setRefreshTick((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await listGroupsForOwner()
        if (cancelled) return
        setProjects({ groups: data.groups, legacy: data.legacyProjects })
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'טעינה נכשלה')
      }
    })()
    void (async () => {
      const s = await fetchDriveStorage()
      if (!cancelled) setStorage(s)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  async function handleDisconnect() {
    if (
      !window.confirm(
        'לנתק את חשבון Google Drive? פרויקטים קיימים יישארו אבל לא תוכל להעלות סבבים חדשים עד שתחבר מחדש.',
      )
    ) {
      return
    }
    await disconnectDrive()
    onDisconnected()
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

  return (
    <div className="space-y-8">
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
          onOpenRound={(g, round) => setViewingRound({ group: g, round })}
          onOpenLegacy={(p) => setViewingRound({ legacy: p })}
          onDeleteRound={(g, roundId) =>
            setConfirmDelete({ kind: 'round', group: g, roundId })
          }
          onDeleteGroup={(g) => setConfirmDelete({ kind: 'group', group: g })}
          onDeleteLegacy={(p) =>
            setConfirmDelete({ kind: 'legacy', project: p })
          }
        />
      )}

      {storage && <DriveStorageFooter drive={drive} storage={storage} />}

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={() => {
            setShowNewProject(false)
            reload()
          }}
        />
      )}
      {editingGroup && (
        <EditGroupModal
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
          target={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => {
            setConfirmDelete(null)
            reload()
          }}
        />
      )}
      {viewingRound && (
        <RoundDetailModal
          target={viewingRound}
          onClose={() => setViewingRound(null)}
          onLockChanged={reload}
        />
      )}
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
        + פרויקט חדש
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
        className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
      >
        + פרויקט חדש
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
              <span>{group.rounds.length} סבבים</span>
              <span>·</span>
              <span>{formatDateShort(group.updatedAt)}</span>
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
            className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            + סבב חדש
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
            className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            עריכה
          </span>
        </div>
      </div>

      {/* Rounds list — collapsible */}
      {expanded && (
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
                        סבב מס׳ {round.roundNumber}
                      </span>
                      {round.locked && (
                        <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase text-fg-muted">
                          סגור
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-fg-muted">
                      {formatBytes(round.videoSizeBytes)} ·{' '}
                      {round.notesCount} הערות ·{' '}
                      {formatDateShort(round.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenRound(round)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
                    >
                      הערות ({round.notesCount})
                    </button>
                    <a
                      href={`${shareUrl}?r=${round.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
                    >
                      פתיחה
                    </a>
                    <button
                      type="button"
                      onClick={() => onDeleteRound(round.id)}
                      className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
                    >
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
              className="text-xs text-destructive/80 transition-colors hover:text-destructive"
            >
              מחיקת הפרויקט כולו
            </button>
          </div>
        </div>
      )}
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
            {formatBytes(project.videoSizeBytes)} · {project.notesCount}{' '}
            הערות · {formatDateShort(project.updatedAt)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyShareLinkButton url={shareUrl} />
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            הערות ({project.notesCount})
          </button>
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-elevated"
          >
            פתיחה
          </a>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-destructive/30 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
          >
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
        'rounded-md border px-3 py-1.5 text-xs transition-colors ' +
        (copied
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border text-fg hover:bg-bg-elevated')
      }
    >
      {copied ? 'הועתק ✓' : 'העתקת קישור שיתוף'}
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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-bg-elevated p-6">
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
      </div>
    </div>
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!title.trim()) {
      setError('יש לתת שם לפרויקט')
      return
    }
    setError(null)
    setBusy(true)

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
      // resulting driveFileId.
      const at = await fetchDriveAccessToken()
      const folders = await ensureProjectFolders(at.accessToken)
      const upload = await uploadFileToDrive({
        accessToken: at.accessToken,
        file,
        folderId: folders.videosFolderId,
        onProgress: setProgress,
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
      setError(err instanceof Error ? err.message : 'יצירת הפרויקט נכשלה')
    }
  }

  return (
    <ModalShell title="פרויקט חדש" onClose={busy ? () => undefined : onClose}>
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
          onPick={setFile}
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
            onClick={onClose}
            disabled={busy}
            className="text-sm text-fg-muted hover:text-fg disabled:opacity-40"
          >
            ביטול
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !file) return
    setError(null)
    setBusy(true)
    try {
      const at = await fetchDriveAccessToken()
      const folders = await ensureProjectFolders(at.accessToken)
      const upload = await uploadFileToDrive({
        accessToken: at.accessToken,
        file,
        folderId: folders.videosFolderId,
        onProgress: setProgress,
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
      setError(err instanceof Error ? err.message : 'הוספת הסבב נכשלה')
    }
  }

  return (
    <ModalShell
      title={`סבב חדש — ${group.title}`}
      onClose={busy ? () => undefined : onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <FileFieldPicker
          file={file}
          onPick={setFile}
          inputRef={fileInputRef}
          required
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
            onClick={onClose}
            disabled={busy}
            className="text-sm text-fg-muted hover:text-fg disabled:opacity-40"
          >
            ביטול
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
          <input
            type="text"
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
            className="w-full rounded-md border border-border bg-bg-card px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-fg/30 focus:outline-none disabled:opacity-50"
          />
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

function RoundDetailModal({
  target,
  onClose,
  onLockChanged,
}: {
  target:
    | { group: RevisionGroup; round: GroupRoundSummary }
    | { legacy: LegacyProjectSummary }
  onClose: () => void
  onLockChanged: () => void
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function toggleLock() {
    if (busyLock) return
    setBusyLock(true)
    const r = await updateProjectLock(projectId, !locked)
    setBusyLock(false)
    if (r.ok) {
      onLockChanged()
      onClose()
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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated">
        {/* Sticky header */}
        <div className="flex flex-col gap-3 border-b border-border bg-bg-elevated p-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium text-fg">
              {title}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-xs">
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
              onClick={() => void toggleLock()}
              disabled={busyLock}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-bg-card disabled:opacity-40"
            >
              {busyLock ? '…' : locked ? 'פתיחת הסבב' : 'סגירת הסבב'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-card hover:text-fg"
              aria-label="סגור"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Scrollable notes list */}
        <div className="flex-1 overflow-y-auto p-5">
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
            <div className="py-12 text-center text-sm text-fg-muted">
              אין עדיין הערות מהלקוח. ההערות שיתווספו לדף הציבורי
              יופיעו כאן.
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

  return (
    <li className="rounded-xl border border-border bg-bg-card p-4">
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
          color="muted"
          onClick={() => onApplyStatus('new')}
        />
        <StatusActionButton
          label="טופל"
          active={note.status === 'resolved'}
          color="success"
          onClick={() => onApplyStatus('resolved')}
        />
        <StatusActionButton
          label="שאלה"
          active={note.status === 'question'}
          color="warning"
          onClick={() => setEditingResponse('question')}
        />
        <StatusActionButton
          label="לא אפשרי"
          active={note.status === 'not-possible'}
          color="destructive"
          onClick={() => setEditingResponse('not-possible')}
        />
      </div>
    </li>
  )
}

function StatusBadge({ status }: { status: NoteStatus }) {
  const styles: Record<NoteStatus, { label: string; cls: string }> = {
    new: {
      label: 'חדש',
      cls: 'bg-bg-elevated text-fg-muted',
    },
    resolved: {
      label: 'טופל',
      cls: 'bg-success/10 text-success border-success/40',
    },
    question: {
      label: 'שאלה',
      cls: 'bg-primary/10 text-primary border-primary/40',
    },
    'not-possible': {
      label: 'לא אפשרי',
      cls: 'bg-destructive/10 text-destructive border-destructive/40',
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
  color: 'muted' | 'success' | 'warning' | 'destructive'
  onClick: () => void
}) {
  const colorOn: Record<typeof color, string> = {
    muted: 'border-fg/30 bg-bg-elevated text-fg',
    success: 'border-success/40 bg-success/10 text-success',
    warning: 'border-primary/40 bg-primary/10 text-primary',
    destructive:
      'border-destructive/40 bg-destructive/10 text-destructive',
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
      <label className="mb-1.5 block text-xs text-fg-muted">
        קובץ וידאו {required && <span className="text-destructive">*</span>}
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault()
        if (!disabled) onChange(!checked)
      }}
      className={
        'relative mt-0.5 inline-flex h-5 w-10 shrink-0 cursor-pointer items-center rounded-md border transition-colors duration-300 ' +
        (disabled ? 'cursor-not-allowed opacity-50 ' : '') +
        (checked
          ? 'border-primary bg-primary '
          : 'border-border bg-white/[0.04] ')
      }
    >
      {/* Soft halo glow when "on" — absolutely positioned so it
          doesn't shift the track's box. */}
      <span
        aria-hidden="true"
        className={
          'pointer-events-none absolute inset-0 rounded-md bg-primary/40 blur-md transition-opacity duration-300 ' +
          (checked ? 'opacity-100' : 'opacity-0')
        }
      />
      {/* Thumb — tile-shaped, ~16 px travel from right to left. */}
      <span
        aria-hidden="true"
        className={
          'pointer-events-none relative z-10 block h-3.5 w-3.5 rounded-sm shadow-lg transition-transform duration-300 ' +
          'ease-[cubic-bezier(0.34,1.56,0.64,1)] ' +
          (checked
            ? '-translate-x-[18px] bg-bg'
            : '-translate-x-[3px] bg-fg/95')
        }
      />
    </button>
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
