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
  type GroupRoundSummary,
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
 *   2. Two onSnapshot listeners (revisionGroups + revisionProjects,
 *      filtered to the owner) push deltas: one read on attach, one
 *      read per changed doc, zero at idle. No polling.
 *
 * The combine logic is byte-for-byte the same as the server's
 * handleListGroupsOwner / the desktop watcher, so the shape the
 * workspace renders is identical to what listGroupsForOwner returned.
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
  let unsubRounds: (() => void) | null = null

  // Raw docs per collection; hold off emitting until both first
  // snapshots are in so the list is never half-built.
  let groupDocs: Record<string, unknown>[] | null = null
  let roundDocs: Record<string, unknown>[] | null = null

  const emit = () => {
    if (groupDocs === null || roundDocs === null) return

    const activeGroups = groupDocs.filter((g) => g.status === 'active')

    const roundsByGroup = new Map<string, Record<string, unknown>[]>()
    const legacyRoundDocs: Record<string, unknown>[] = []
    for (const r of roundDocs) {
      if (r.status !== 'active') continue
      const gid = String(r.groupId || '')
      if (gid) {
        if (!roundsByGroup.has(gid)) roundsByGroup.set(gid, [])
        roundsByGroup.get(gid)!.push(r)
      } else {
        legacyRoundDocs.push(r)
      }
    }

    const groups: RevisionGroup[] = activeGroups
      .map((g) => {
        const gid = String(g.id || '')
        const rounds: GroupRoundSummary[] = (roundsByGroup.get(gid) || [])
          .map((r) => ({
            id: String(r.id || ''),
            roundNumber: Number(r.roundNumber) || 1,
            videoFileName: String(r.videoFileName || ''),
            videoSizeBytes: Number(r.videoSizeBytes) || 0,
            locked: r.locked === true,
            notesCount: Number(r.notesCount) || 0,
            createdAt: Number(r.createdAt) || 0,
          }))
          .sort((a, b) => a.roundNumber - b.roundNumber)
        return {
          id: gid,
          title: String(g.title || ''),
          shareToken: String(g.shareToken || ''),
          hasPassword: Boolean(g.passwordHash),
          watermark: g.watermark !== false,
          allowDownload: g.allowDownload === true,
          openInDrive: g.openInDrive === true,
          createdAt: Number(g.createdAt) || 0,
          updatedAt: Number(g.updatedAt) || 0,
          rounds,
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)

    const legacyProjects: LegacyProjectSummary[] = legacyRoundDocs
      .map((r) => ({
        id: String(r.id || ''),
        title: String(r.title || ''),
        shareToken: String(r.shareToken || ''),
        hasPassword: Boolean(r.passwordHash),
        videoFileName: String(r.videoFileName || ''),
        videoSizeBytes: Number(r.videoSizeBytes) || 0,
        roundNumber: Number(r.roundNumber) || 1,
        locked: r.locked === true,
        notesCount: Number(r.notesCount) || 0,
        createdAt: Number(r.createdAt) || 0,
        updatedAt: Number(r.updatedAt) || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)

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
    unsubRounds = onSnapshot(
      query(collection(db, 'revisionProjects'), where('ownerUid', '==', uid)),
      (snap: QuerySnapshot) => {
        roundDocs = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return { ...data, id: data.id || d.id }
        })
        emit()
      },
      (err) => {
        console.warn('[revisionsLive] rounds listener error:', err)
        onError?.(err)
      },
    )
  })()

  return () => {
    cancelled = true
    if (unsubGroups) unsubGroups()
    if (unsubRounds) unsubRounds()
  }
}
