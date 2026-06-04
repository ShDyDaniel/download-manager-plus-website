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

import { getSessionToken, signOut } from './webSession'

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
  // 401/403 from any owner-side action means the session token
  // the server saw is no longer trusted (expired, revoked, or the
  // secret rotated under us). Wipe the local session
  // synchronously so subscribers re-render into AuthShell instead
  // of letting the workspace strand the user on stale state with
  // every subsequent call also failing. Caller still gets a
  // thrown error so its own UI can show a one-time "session
  // expired" message before unmounting.
  if (r.status === 401 || r.status === 403) {
    signOut()
    throw new Error('הסשן פג. יש להתחבר מחדש.')
  }
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

/**
 * Stamp the owner's WEBSITE "last seen" — ONCE per tab session.
 * Fire-and-forget, guarded by sessionStorage so it fires on the first
 * authenticated entry (login / opening revisions) and NOT on every
 * data request. signOut() clears the guard so the next login re-stamps.
 */
const WEB_SEEN_GUARD = 'dmplus.webseen.v1'
export function touchWebSeenOnce(): void {
  try {
    if (sessionStorage.getItem(WEB_SEEN_GUARD)) return
    const token = getSessionToken()
    if (!token) return
    sessionStorage.setItem(WEB_SEEN_GUARD, '1')
    // Raw fetch (not postAction) so a transient error never triggers
    // the auth-expired signOut side effect — it's only a presence ping.
    void fetch(`${API_BASE}?action=touch-web-seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch-web-seen', sessionToken: token }),
    }).catch(() => undefined)
  } catch {
    /* ignore */
  }
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
/** Which storage backend this user is on (admin-controlled, default
 *  'r2'). Decides whether the workspace requires a Drive connection
 *  and which upload path to use. */
export async function fetchStorageBackend(): Promise<'r2' | 'drive'> {
  try {
    const r = await postAction<{ ok: true; storageBackend?: string }>(
      'oauth-status',
      authBody(),
    )
    return r.storageBackend === 'drive' ? 'drive' : 'r2'
  } catch {
    return 'r2'
  }
}

/** R2 storage usage + quota for the in-app storage bar (R2 users). */
export async function fetchStorageState(): Promise<{
  usedBytes: number
  limitBytes: number
} | null> {
  try {
    const r = await postAction<{
      ok: true
      storageUsedBytes?: number
      storageLimitBytes?: number
    }>('oauth-status', authBody())
    if (typeof r.storageLimitBytes !== 'number') return null
    return {
      usedBytes: Number(r.storageUsedBytes) || 0,
      limitBytes: r.storageLimitBytes,
    }
  } catch {
    return null
  }
}

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
  /** Which storage backend this round's video lives on. Lets the UI
   *  flag rounds NOT on the user's current backend. */
  storage?: 'r2' | 'drive'
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
  /** Number of active rounds — denormalised on the group so the list
   *  renders the count without reading any round docs (lazy-load). */
  roundCount: number
  /** Rounds are loaded on demand when the project is opened
   *  (listRoundsForOwner). Empty until then; `undefined` means
   *  "not loaded yet", `[]` means "loaded, no rounds". */
  rounds?: GroupRoundSummary[]
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

/** Lazy-load the rounds of a single project, on demand when the user
 *  opens it. The list view (live listener / listGroupsForOwner) only
 *  carries each group's roundCount, so opening a project is the only
 *  thing that reads round docs — and only for that one project. */
export async function listRoundsForOwner(
  groupId: string,
): Promise<GroupRoundSummary[]> {
  const r = await postAction<{ ok: true; rounds: GroupRoundSummary[] }>(
    'list-rounds-owner',
    { ...authBody(), groupId },
  )
  return r.rounds || []
}

/** Mint a short-lived Firebase custom auth token for the current
 *  session owner. The website logs in with the HMAC session JWT and
 *  has no Firebase Auth session of its own, but the live revisions
 *  listener (onSnapshot) needs one so the Firestore read rules pass.
 *  The client signs in with this token, then opens the listener.
 *  Costs nothing against the Firestore read quota — it's an Auth
 *  operation only. */
export async function fetchFirebaseCustomToken(): Promise<string> {
  const r = await postAction<{ ok: true; token: string }>(
    'firebase-custom-token',
    authBody(),
  )
  return r.token
}

export interface CreateGroupInput {
  // Exactly one storage pointer, per the user's backend.
  r2Key?: string
  driveFileId?: string
  driveFolderId?: string
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
  r2Key?: string
  driveFileId?: string
  driveFolderId?: string
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

/* ──────────────────────────────────────────────────────────────
 *  Notes — list / status toggle / media fetch
 *
 *  The editor's view of what clients left on a round. The /review/
 *  :token page lets clients ADD notes; this section is the
 *  editor's review-and-respond surface. Status values are loaded
 *  via list-notes-owner (skips password gate, uses the editor's
 *  session token) and updated via update-note-status.
 * ────────────────────────────────────────────────────────────── */

export type NoteStatus = 'new' | 'resolved' | 'question' | 'not-possible'

export interface OwnerNote {
  id: string
  viewerEmail: string
  viewerName?: string | null
  /** Number = pinned to this second in the video. null = general
   *  note not tied to any specific moment. */
  timeSeconds: number | null
  text: string
  /** Legacy storage: base64 data URL on the note doc itself. */
  screenshotDataUrl?: string | null
  /** New storage: Drive file ID of the screenshot. Fetch via
   *  fetchNoteMediaAsObjectUrl. */
  screenshotDriveFileId?: string | null
  /** Drive file ID of the voice recording attached to this note. */
  audioDriveFileId?: string | null
  /** R2 object keys — equivalents for R2-backed rounds. */
  screenshotR2Key?: string | null
  audioR2Key?: string | null
  status: NoteStatus
  /** Free-text editor response. Populated when status is 'question'
   *  or 'not-possible'. */
  editorResponse?: string | null
  createdAt: number
}

/** Fetch all notes the client(s) left on this round. Sorted
 *  server-side by timeSeconds ASC — render order matches video
 *  playback order without re-sorting on the client. */
export async function listNotesAsOwner(
  projectId: string,
): Promise<OwnerNote[]> {
  const r = await postAction<{ ok: true; notes: OwnerNote[] }>(
    'list-notes-owner',
    authBody({ projectId }),
  )
  return r.notes
}

/** Flip a note's status. The server requires `editorResponse` for
 *  the two statuses that carry text back to the reviewer
 *  ('question' / 'not-possible'); leave it undefined for 'new' /
 *  'resolved'. Throws on failure so the caller knows to revert
 *  any optimistic UI update. */
export async function updateNoteStatus(
  projectId: string,
  noteId: string,
  status: NoteStatus,
  editorResponse?: string,
): Promise<void> {
  await postAction<{ ok: true }>(
    'update-note-status',
    authBody({ projectId, noteId, status, editorResponse }),
  )
}

/** Fetch a note's screenshot or audio as a blob URL the caller
 *  can plug into <img src> or <audio src>. Uses the owner-auth
 *  proxy so password-protected projects work too — the public
 *  GET URL would need a passwordToken we don't have here.
 *
 *  IMPORTANT: caller MUST URL.revokeObjectURL() the returned URL
 *  when done (typically in a useEffect cleanup) or it leaks
 *  memory. */
export async function fetchNoteMediaAsObjectUrl(
  projectId: string,
  noteId: string,
  kind: 'image' | 'audio',
): Promise<string> {
  const token = getSessionToken()
  if (!token) throw new Error('יש להתחבר מחדש')
  // Two-step: ask Vercel for a short-lived Cloudflare Worker URL
  // (tiny JSON — no file bytes through Vercel), then fetch the actual
  // bytes from the Worker (Drive → Cloudflare → here). Falls back to
  // the legacy byte endpoint if the Worker isn't configured.
  const urlResp = await fetch(`${API_BASE}?action=note-media-owner-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: token, projectId, noteId, kind }),
  })
  if (urlResp.ok) {
    const json = (await urlResp.json()) as
      | { ok: true; url: string }
      | { ok: false; error: string }
    if (json.ok && json.url) {
      const media = await fetch(json.url)
      if (!media.ok) throw new Error(`טעינת המדיה נכשלה (${media.status})`)
      return URL.createObjectURL(await media.blob())
    }
  }
  // Fallback — legacy byte stream through Vercel (used only if the
  // media worker URL action is unavailable, e.g. CLOUDFLARE_STREAM_BASE
  // not set on this deployment).
  const r = await fetch(`${API_BASE}?action=note-media-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: token, projectId, noteId, kind }),
  })
  if (!r.ok) throw new Error(`טעינת המדיה נכשלה (${r.status})`)
  return URL.createObjectURL(await r.blob())
}

/* ──────────────────────────────────────────────────────────────
 *  Round-level mutations (lock/unlock)
 * ────────────────────────────────────────────────────────────── */

/** Toggle a round's lock state. When locked, the public review
 *  page can still play the video and read existing notes, but
 *  the add-note endpoint rejects with 423. Use this when the
 *  round is "closed" and the editor is incorporating changes. */
export async function updateProjectLock(
  projectId: string,
  locked: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await postAction<{ ok: true }>(
      'update-project',
      authBody({ projectId, locked }),
    )
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'שגיאה',
    }
  }
}

/** Replace the underlying video on an existing round / legacy
 *  project. The new video must already live on Drive (caller
 *  uploads via driveUpload.ts first, same as for create-round).
 *  Existing notes + share token are preserved — only the video
 *  bytes change. Optionally trashes the old Drive video file
 *  too (default true, to free quota since most editors are
 *  replacing because the old upload was wrong). */
export interface ReplaceVideoInput {
  projectId: string
  r2Key?: string
  driveFileId?: string
  driveFolderId?: string
  videoFileName: string
  videoSizeBytes: number
  videoMime: string
  /** When true (default server-side), the old R2 object is deleted
   *  after the swap so it stops counting against quota. Pass false
   *  to keep it. */
  deleteOldDriveFile?: boolean
}

export async function replaceProjectVideo(
  input: ReplaceVideoInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await postAction<{ ok: true }>(
      'replace-project-video',
      authBody(input as unknown as Record<string, unknown>),
    )
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'שגיאה',
    }
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
