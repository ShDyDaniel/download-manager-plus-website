/**
 * Browser-side API client for the /api/revisions endpoints.
 *
 * Mirror of the desktop's src/lib/revisions.ts, with two key
 * differences:
 *
 *   1. We authenticate with the website's session JWT
 *      (sessionStorage `dmplus.session.v1`) instead of a
 *      Firebase Auth ID token — the public site deliberately
 *      ships without Firebase Web SDK. The /api/revisions
 *      handlers accept either auth method via the verifyOwnerAuth
 *      wrapper, so the downstream code doesn't care.
 *
 *   2. The upload helper lives in driveUpload.ts and uses
 *      browser XHR + File.slice for chunked resumable uploads
 *      (no fs streaming through Electron IPC).
 *
 * Action names + payload shapes must stay in sync with the server
 * (api/revisions.ts) and the desktop client (src/lib/revisions.ts).
 * Changes to ANY of these three places typically need mirrored
 * edits in the other two.
 */

import { getSessionToken } from './webSession'

const API_BASE = '/api/revisions'
const WEBSITE_BASE = 'https://dmplus.net'

/** Shorthand: every owner-side action takes the session token in
 *  the request body as `sessionToken`. Centralizes the lookup
 *  so individual functions can't forget to attach it. */
function authBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const token = getSessionToken()
  if (!token) {
    // Throwing here is louder than returning a malformed body —
    // most callers run after an explicit auth check upstream, so
    // hitting this path is almost certainly a bug.
    throw new Error('יש להתחבר מחדש לאתר ולנסות שוב')
  }
  return { sessionToken: token, ...extra }
}

async function postAction<T>(
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(`${API_BASE}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action }),
  })
  const json = (await r.json().catch(() => ({}))) as
    | (T & { ok: true })
    | { ok: false; error?: string }
  if (!json || (json as { ok?: boolean }).ok !== true) {
    const err =
      (json as { error?: string }).error ||
      `שגיאה לא צפויה (${r.status})`
    throw new Error(err)
  }
  return json as T
}

/* ──────────────────────────────────────────────────────────────
 *  Drive integration
 * ────────────────────────────────────────────────────────────── */

export interface DriveIntegration {
  connected: true
  email: string
  scope: string
  connectedAt: number
  lastUsedAt: number
}

/** Check whether the user has Drive connected. Returns null if
 *  not connected; integration shape if connected. */
export async function fetchDriveIntegration(): Promise<DriveIntegration | null> {
  try {
    const r = await postAction<{
      ok: true
      connected: boolean
      email?: string
      scope?: string
      connectedAt?: number
      lastUsedAt?: number
    }>('oauth-status', authBody())
    if (!r.connected || !r.email) return null
    return {
      connected: true,
      email: r.email,
      scope: r.scope || '',
      connectedAt: r.connectedAt || 0,
      lastUsedAt: r.lastUsedAt || 0,
    }
  } catch (err) {
    console.warn('[revisionsApi] fetchDriveIntegration failed:', err)
    return null
  }
}

/** URL the browser should navigate to to start the OAuth flow.
 *  We use `source=web` so the server-side callback knows to
 *  302-redirect back to /revisions?oauth=connected on success
 *  instead of showing the desktop's "close this tab" HTML page. */
export function buildOauthStartUrl(): string {
  const token = getSessionToken()
  if (!token) throw new Error('יש להתחבר מחדש לאתר')
  // Session token rides in the query string because oauth-start
  // is a GET-navigation handler — can't carry a body. Length is
  // fine (~250 chars).
  return `${API_BASE}?action=oauth-start&source=web&sessionToken=${encodeURIComponent(token)}`
}

/** Disconnect Drive — revokes our refresh token on Google's side
 *  (best-effort) and deletes the Firestore integration doc. */
export async function disconnectDrive(): Promise<boolean> {
  try {
    await postAction<{ ok: true }>('oauth-disconnect', authBody())
    return true
  } catch (err) {
    console.warn('[revisionsApi] disconnectDrive failed:', err)
    return false
  }
}

/** Fetch a fresh Drive access token (server refreshes from the
 *  stored refresh token). The browser calls this just-in-time
 *  before any Drive operation. */
export interface DriveAccessTokenResult {
  accessToken: string
  expiresIn: number
  email: string
}
export async function fetchDriveAccessToken(): Promise<DriveAccessTokenResult> {
  const r = await postAction<{
    ok: true
    accessToken: string
    expiresIn: number
    email: string
    needsReconnect?: boolean
  }>('access-token', authBody())
  return {
    accessToken: r.accessToken,
    expiresIn: r.expiresIn,
    email: r.email,
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Drive storage
 * ────────────────────────────────────────────────────────────── */

export interface DriveStorage {
  /** Bytes used inside the user's Drive that our app can see.
   *  Drive returns the total quota usage for the WHOLE account
   *  (including stuff outside our drive.file scope), so this is
   *  the user's total Drive usage, not just our footprint. */
  usageBytes: number
  /** Hard quota in bytes — typically 15 GB free, larger for
   *  Workspace / paid Google One. */
  limitBytes: number
}

export async function fetchDriveStorage(): Promise<DriveStorage | null> {
  try {
    const r = await postAction<{
      ok: true
      usageBytes: number
      limitBytes: number
    }>('drive-storage', authBody())
    return { usageBytes: r.usageBytes, limitBytes: r.limitBytes }
  } catch (err) {
    console.warn('[revisionsApi] fetchDriveStorage failed:', err)
    return null
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Project groups + rounds (the new-style data model)
 * ────────────────────────────────────────────────────────────── */

export interface GroupRoundSummary {
  id: string
  roundNumber: number
  videoFileName: string
  videoSizeBytes: number
  locked: boolean
  notesCount: number
  createdAt: number
}

export interface RevisionGroup {
  id: string
  title: string
  shareToken: string
  hasPassword: boolean
  watermark: boolean
  allowDownload: boolean
  openInDrive: boolean
  createdAt: number
  updatedAt: number
  rounds: GroupRoundSummary[]
}

export interface LegacyProjectSummary {
  id: string
  title: string
  shareToken: string
  hasPassword: boolean
  videoFileName: string
  videoSizeBytes: number
  roundNumber: number
  locked: boolean
  notesCount: number
  createdAt: number
  updatedAt: number
}

/** Single-round-trip fetch for everything the workspace list
 *  needs: groups with embedded round summaries + any legacy
 *  pre-group-refactor standalone projects. Sorted server-side
 *  by updatedAt DESC. */
export async function listGroupsForOwner(): Promise<{
  groups: RevisionGroup[]
  legacyProjects: LegacyProjectSummary[]
}> {
  const r = await postAction<{
    ok: true
    groups: RevisionGroup[]
    legacyProjects?: LegacyProjectSummary[]
  }>('list-groups-owner', authBody())
  return {
    groups: r.groups,
    legacyProjects: r.legacyProjects || [],
  }
}

export interface CreateGroupInput {
  driveFileId: string
  driveFolderId: string
  title: string
  videoFileName: string
  videoSizeBytes: number
  videoMime: string
  password?: string
  roundNumber?: number
  watermark?: boolean
  allowDownload?: boolean
  openInDrive?: boolean
}

export interface CreateGroupResult {
  groupId: string
  roundId: string | null
  shareToken: string
  shareUrl: string
}

/** Create a project group + first round in one atomic write.
 *  Caller already uploaded the video to Drive (via driveUpload.ts)
 *  and passes the resulting `driveFileId` + parent folder ID. */
export async function createProjectGroup(
  input: CreateGroupInput,
): Promise<CreateGroupResult> {
  return await postAction<CreateGroupResult & { ok: true }>(
    'create-project-group',
    authBody(input as unknown as Record<string, unknown>),
  )
}

export interface CreateEmptyGroupInput {
  title: string
  password?: string
  watermark?: boolean
  allowDownload?: boolean
  openInDrive?: boolean
}

/** Create a project group with NO rounds — used when the editor
 *  wants to set up the project first and upload rounds later. */
export async function createEmptyProjectGroup(
  input: CreateEmptyGroupInput,
): Promise<{ groupId: string; shareToken: string; shareUrl: string }> {
  return await postAction<{
    ok: true
    groupId: string
    shareToken: string
    shareUrl: string
  }>(
    'create-project-group',
    authBody(input as unknown as Record<string, unknown>),
  )
}

export interface AddRoundInput {
  groupId: string
  driveFileId: string
  driveFolderId: string
  videoFileName: string
  videoSizeBytes: number
  videoMime: string
  roundNumber?: number
}

/** Add another round to an existing group. Same share link +
 *  password as the rest of the group. */
export async function addRoundToGroup(
  input: AddRoundInput,
): Promise<{ roundId: string }> {
  const r = await postAction<{ ok: true; roundId: string }>(
    'add-round-to-group',
    authBody(input as unknown as Record<string, unknown>),
  )
  return { roundId: r.roundId }
}

/** Update group-level settings. Patch semantics — undefined
 *  fields stay unchanged; `password === ""` clears the existing
 *  password. */
export async function updateGroup(
  groupId: string,
  changes: {
    password?: string
    watermark?: boolean
    allowDownload?: boolean
    openInDrive?: boolean
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await postAction<{ ok: true }>(
      'update-group',
      authBody({ groupId, ...changes }),
    )
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'שגיאה',
    }
  }
}

/** Archive a single round. Returns lastRound=true when the
 *  project has no more rounds — the UI then prompts whether to
 *  also delete the (now empty) group. */
export async function deleteRound(
  roundId: string,
  deleteDriveFile = false,
): Promise<
  | { ok: true; driveDeleted: boolean; lastRound: boolean }
  | { ok: false; error: string }
> {
  try {
    const r = await postAction<{
      ok: true
      driveDeleted: boolean
      lastRound: boolean
    }>('delete-round', authBody({ roundId, deleteDriveFile }))
    return r
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'שגיאה',
    }
  }
}

/** Archive an entire group + all its rounds. Optionally trashes
 *  the video files on Drive (note media stays — it lives in the
 *  shared notes folder that's not group-specific). */
export async function deleteGroup(
  groupId: string,
  deleteDriveFiles = false,
): Promise<
  | { ok: true; driveDeleted: boolean; roundsArchived: number }
  | { ok: false; error: string }
> {
  try {
    const r = await postAction<{
      ok: true
      driveDeleted: boolean
      roundsArchived: number
    }>('delete-group', authBody({ groupId, deleteDriveFiles }))
    return r
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'שגיאה',
    }
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Legacy single-round projects (pre-group refactor)
 * ────────────────────────────────────────────────────────────── */

/** Delete a legacy standalone project. Soft delete (default)
 *  flips status to 'archived' + revokes anyone-with-link
 *  permission so existing share URLs stop working. Hard delete
 *  also trashes the Drive video. */
export async function deleteLegacyProject(
  projectId: string,
  deleteDriveFile = false,
): Promise<boolean> {
  try {
    await postAction<{ ok: true }>(
      'delete-project',
      authBody({ projectId, deleteDriveFile }),
    )
    return true
  } catch (err) {
    console.warn('[revisionsApi] deleteLegacyProject failed:', err)
    return false
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Helpers
 * ────────────────────────────────────────────────────────────── */

/** Build the public share URL the editor sends to clients.
 *  Single source of truth for the URL template. */
export function buildShareUrl(shareToken: string): string {
  return `${WEBSITE_BASE}/review/${shareToken}`
}

/** Format a byte count as a human-readable string ("4.3 GB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
