import { signInWithCustomToken, signOut as fbSignOut } from 'firebase/auth'
import {
  collection,
  onSnapshot,
  query,
  where,
  type QuerySnapshot,
} from 'firebase/firestore'
import { getClientAuth, getClientDb } from './firebaseClient'
import { getSession } from './webSession'
import {
  fetchFirebaseCustomToken,
  type RevisionGroup,
  type LegacyProjectSummary,
} from './revisionsApi'

/**
 * Real-time PUSH layer for the website's Drive workspace — the web
 * twin of the desktop's watchOwnerRevisions.
 *
 * Mechanism:
 *   1. ensureFirebaseSession() mints a Firebase custom token from the
 *      site's session JWT (one Auth round-trip, ZERO Firestore reads)
 *      and signs the Firebase Web SDK in, so request.auth.uid matches
 *      the owner and the read rules pass.
 *   2. ONE onSnapshot listener on revisionGroups (filtered to the
 *      owner) pushes deltas: one read on attach, one read per changed
 *      group, zero at idle. No polling.
 *
 * LAZY-LOAD: we deliberately do NOT listen to revisionProjects here.
 * The list only needs each group's denormalised `roundCount`; the
 * actual round docs are fetched (listRoundsForOwner) only when a
 * project is opened. This keeps tab entry to "groups only" reads
 * instead of "every group + every round the user owns".
 */

// Dedupe concurrent sign-in attempts — many callers may race on first
// mount. They all await the same promise.
let signInPromise: Promise<string | null> | null = null

/** Ensure a Firebase Auth session exists for the current owner.
 *  Returns the uid, or null if we couldn't establish one (e.g. the
 *  custom-token mint failed). Idempotent + concurrency-safe. */
export async function ensureFirebaseSession(): Promise<string | null> {
  // The site's source-of-truth identity is the session JWT. If there's
  // no JWT session, don't sign in to Firebase at all.
  const expectedUid = getSession()?.claims.uid ?? null
  if (!expectedUid) return null

  const auth = getClientAuth()
  if (auth.currentUser) {
    // Reuse the existing Firebase session ONLY if it's the same user.
    if (auth.currentUser.uid === expectedUid) return auth.currentUser.uid
    // Account switched on the site — drop the stale Firebase session
    // so we don't read the previous user's data with their uid.
    try {
      await fbSignOut(auth)
    } catch {
      /* ignore — we'll mint a fresh session below regardless */
    }
  }
  if (signInPromise) return signInPromise
  signInPromise = (async () => {
    try {
      const token = await fetchFirebaseCustomToken()
      if (!token) return null
      const cred = await signInWithCustomToken(auth, token)
      return cred.user.uid
    } catch (err) {
      console.warn('[revisionsLive] firebase sign-in failed:', err)
      return null
    } finally {
      signInPromise = null
    }
  })()
  return signInPromise
}

/** Attach the live groups+rounds listener. Returns a synchronous
 *  unsubscribe (safe to call even before the async sign-in settles).
 *  onError fires if the session can't be established or a snapshot
 *  errors — callers can then fall back to a one-shot fetch. */
export function watchOwnerRevisionsLive(
  cb: (data: {
    groups: RevisionGroup[]
    legacyProjects: LegacyProjectSummary[]
  }) => void,
  onError?: (err: Error) => void,
): () => void {
  let cancelled = false
  let unsubGroups: (() => void) | null = null

  // Raw group docs from the single live listener.
  let groupDocs: Record<string, unknown>[] | null = null

  const emit = () => {
    if (groupDocs === null) return

    const activeGroups = groupDocs.filter((g) => g.status === 'active')

    const groups: RevisionGroup[] = activeGroups
      .map((g) => ({
        id: String(g.id || ''),
        title: String(g.title || ''),
        shareToken: String(g.shareToken || ''),
        hasPassword: Boolean(g.passwordHash),
        watermark: g.watermark !== false,
        allowDownload: g.allowDownload === true,
        openInDrive: g.openInDrive === true,
        roundCount: Number(g.roundCount) || 0,
        createdAt: Number(g.createdAt) || 0,
        updatedAt: Number(g.updatedAt) || 0,
        // Rounds load on demand when the project is opened.
        rounds: undefined,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    // Legacy single-round projects are no longer surfaced in the live
    // list (this user has none, and scanning for them would defeat the
    // lazy-load). Always emit an empty array for shape compatibility.
    const legacyProjects: LegacyProjectSummary[] = []

    cb({ groups, legacyProjects })
  }

  void (async () => {
    const uid = await ensureFirebaseSession()
    if (cancelled) return
    if (!uid) {
      onError?.(new Error('no-firebase-session'))
      return
    }
    const db = getClientDb()
    unsubGroups = onSnapshot(
      query(collection(db, 'revisionGroups'), where('ownerUid', '==', uid)),
      (snap: QuerySnapshot) => {
        groupDocs = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return { ...data, id: data.id || d.id }
        })
        emit()
      },
      (err) => {
        console.warn('[revisionsLive] groups listener error:', err)
        onError?.(err)
      },
    )
  })()

  return () => {
    cancelled = true
    if (unsubGroups) unsubGroups()
  }
}
