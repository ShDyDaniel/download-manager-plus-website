import { lazy, Suspense, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { captureRefFromUrl, getStoredRef } from './lib/referral'
import { Hero } from './components/Hero'
import { RevisionsHighlight } from './components/RevisionsHighlight'
import { Features } from './components/Features'
import { QuickStart } from './components/QuickStart'
import { FAQ } from './components/FAQ'
import { Footer } from './components/Footer'
import { SiteHeader } from './components/SiteHeader'
import { AmbientGlows } from './components/AmbientGlows'
import { BuyPage } from './pages/BuyPage'
import AccountPage from './pages/AccountPage'
import AuthActionPage from './pages/AuthActionPage'
import { ReviewPage } from './pages/ReviewPage'
import { RevisionsPage } from './pages/RevisionsPage'
import DrivePickerPage from './pages/DrivePickerPage'
import PartnerPage from './pages/PartnerPage'
// Lazy — AdminPage pulls in Firebase Auth (signInWithEmailAndPassword).
// Keeping it out of the main bundle means visitors who never open
// /admin don't download the Firebase weight.
const AdminPage = lazy(() => import('./pages/AdminPage'))

// Top-level layout. The marketing site is the default route (`/`);
// the purchase flow lives at `/buy` so the URL is shareable, deep-
// linkable, and Google-indexable. Vercel's `vercel.json` rewrites
// non-/api requests to index.html so deep links survive refresh.
/** Routes that render their own chrome (or are intentionally
 *  chromeless) and must NOT show the marketing SiteHeader:
 *    - /review        public client-review surface
 *    - /auth-action   Firebase password-reset landing
 *    - /drive-picker  frameless picker the desktop app opens
 *    - /partner       self-serve partner dashboard (own header)
 *  Used both to hide the global header and to bypass the page
 *  transition wrapper, so the two stay in sync. */
function isChromelessRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/review') ||
    pathname.startsWith('/auth-action') ||
    pathname.startsWith('/drive-picker') ||
    pathname.startsWith('/partner') ||
    pathname.startsWith('/admin')
  )
}

function App() {
  const location = useLocation()
  return (
    // `relative` here anchors the absolute-positioned SiteHeader to
    // the top of the page content (NOT the viewport — the user
    // doesn't want a sticky element). When the user scrolls down,
    // the SiteHeader scrolls out of view with the rest of the
    // page; it reappears only when scrolling back to the top.
    <div className="relative">
      {/* Global warm-glow atmosphere on every route. */}
      <AmbientGlows />
      {/* The header belongs to the marketing/app shell only. Standalone
          surfaces (partner dashboard, client review, picker) render
          their own chrome — showing the global nav on top of them
          overlaps their UI (cramped + overlapping on mobile). */}
      {!isChromelessRoute(location.pathname) && <SiteHeader />}
      <AnimatedRoutes />
    </div>
  )
}

/**
 * Routes wrapped in AnimatePresence so every navigation cross-
 * fades smoothly instead of snapping. The outgoing page fades +
 * slides out while the incoming page fades + slides in, both on
 * the same timeline, so the user never sees a flash of blank
 * background between pages.
 *
 * Implementation notes:
 *
 *   - mode="wait" is deliberate: we let the outgoing page finish
 *     its exit before mounting the incoming one. This avoids a
 *     brief moment where two full pages stack on top of each other
 *     (which the AccountPage's sticky chrome doesn't survive
 *     cleanly when overlapped with the Hero's full-screen gradient).
 *   - We key by `location.pathname`, NOT `location.key`. Two
 *     different navigations to the same URL (a refresh of the
 *     current page, say) should NOT trigger a re-mount + re-
 *     animation; the user expects "stay where I am". Path-keyed
 *     means only an actual route change triggers the transition.
 *   - initial={false} on AnimatePresence skips the entrance
 *     animation on the very first paint — the page is already
 *     visible, so re-fading it in feels jittery. Subsequent
 *     navigations get the full enter+exit.
 *   - The transition uses a 180 ms ease-out — fast enough to feel
 *     responsive, slow enough that the eye registers it as
 *     intentional motion rather than a glitch.
 */
function AnimatedRoutes() {
  const location = useLocation()
  const navigate = useNavigate()

  // Keep the partner ref sticky in the URL across navigation.
  //
  // The attribution itself runs off localStorage (survives anywhere),
  // but the operator wants the ?ref to STAY visible in the address bar
  // no matter where you click — so once you arrive via a partner link
  // it's re-appended to every in-app route until the browser closes.
  useEffect(() => {
    captureRefFromUrl()
    const ref = getStoredRef()
    if (!ref) return
    // Leave standalone / external-handoff surfaces untouched.
    const p = location.pathname
    if (
      p.startsWith('/review') ||
      p.startsWith('/auth-action') ||
      p.startsWith('/drive-picker')
    ) {
      return
    }
    const params = new URLSearchParams(location.search)
    if (params.get('ref') === ref) return // already present → no loop
    params.set('ref', ref)
    navigate(
      { pathname: p, search: `?${params.toString()}`, hash: location.hash },
      { replace: true },
    )
  }, [location.pathname, location.search, location.hash, navigate])

  // /review/:token is the public client-review surface — clients
  // who land there shouldn't see a transition animation flash from
  // a page they never visited. Same for /auth-action which gets
  // hit by Firebase from a fresh tab. Bypass the wrapper for those
  // routes so they render instantly with no enter animation.
  const isStandalone = isChromelessRoute(location.pathname)

  if (isStandalone) {
    return (
      <Suspense fallback={null}>
      <Routes location={location}>
        <Route path="/auth-action" element={<AuthActionPage />} />
        <Route path="/review/:token" element={<ReviewPage />} />
        {/* Chromeless surface the DESKTOP app opens in a frameless
            modal window to run the Google Picker. Not linked from
            anywhere in the site UI — it's an app integration point. */}
        <Route path="/drive-picker" element={<DrivePickerPage />} />
        {/* Self-serve partner dashboard (referral stats). */}
        <Route path="/partner" element={<PartnerPage />} />
        {/* Admin panel — 2FA-gated web twin of the desktop panel. */}
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
      </Suspense>
    )
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        // Key by pathname so route changes — and ONLY route changes
        // — re-mount the children and re-run the animation.
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <Routes location={location}>
          <Route
            path="/"
            element={
              <div className="relative">
                <Hero />
                <RevisionsHighlight />
                <Features />
                <QuickStart />
                <FAQ />
                <Footer />
              </div>
            }
          />
          <Route path="/buy" element={<BuyPage />} />
          <Route path="/account" element={<AccountPage />} />
          {/* Web /revisions workspace — full editor-side of the
              Revisions feature ported from the desktop app. Lets
              anyone with a Pro subscription manage projects,
              rounds, and share links from a browser instead of
              having to install the desktop app. Auth + Pro
              entitlement are gated client-side, and re-enforced
              server-side on every API call. See
              pages/RevisionsPage.tsx. */}
          <Route path="/revisions" element={<RevisionsPage />} />
          {/* /manage was the original subscription-management page
              before /account absorbed all its functionality. Keep
              a permanent redirect so old emails, footers, the
              desktop app's pre-update "ניהול תוכנית" button, and
              Google results still land somewhere useful. */}
          <Route
            path="/manage"
            element={<Navigate to="/account" replace />}
          />
        </Routes>
      </motion.div>
    </AnimatePresence>
  )
}

export default App
