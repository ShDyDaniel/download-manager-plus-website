import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

/**
 * Firebase Web SDK client for the website.
 *
 * Used ONLY for the live revisions listener (onSnapshot) in the
 * Drive workspace. Everything else on the site authenticates via the
 * HMAC session JWT and talks to the Vercel API — this client adds a
 * real Firebase Auth session (minted from that JWT via a custom
 * token, see ensureFirebaseSession) so the Firestore read rules
 * (request.auth.uid == resource.data.ownerUid) pass and the editor
 * can receive real-time pushes instead of polling.
 *
 * The config below is PUBLIC. Firebase web configs ship in every
 * client bundle by design — access is gated by Security Rules + Auth,
 * not by hiding these values. Inlined (rather than read from env) so
 * the website needs no extra Vercel env var for this feature.
 */
const firebaseConfig = {
  apiKey: 'AIzaSyAvQ1nNPZdstWp-Ws8HnlmqUvnHTZZoxic',
  authDomain: 'n-plus-64549.firebaseapp.com',
  projectId: 'n-plus-64549',
  storageBucket: 'n-plus-64549.firebasestorage.app',
  messagingSenderId: '1005271902300',
  appId: '1:1005271902300:web:1d196840da1cee3064de99',
}

let app: FirebaseApp | null = null
let authInstance: Auth | null = null
let dbInstance: Firestore | null = null

function ensureApp(): FirebaseApp {
  if (app) return app
  // Reuse an existing app if one was already initialized (HMR / a
  // second import) so we never throw "duplicate-app".
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
  return app
}

export function getClientAuth(): Auth {
  if (!authInstance) authInstance = getAuth(ensureApp())
  return authInstance
}

export function getClientDb(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(ensureApp())
  return dbInstance
}
