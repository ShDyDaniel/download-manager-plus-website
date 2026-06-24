import { lazy, Suspense, useEffect, useState } from 'react'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { captureRefFromUrl, getStoredRef } from './lib/referral'
import { trackPageview } from './lib/pageview'
import { Hero } from './components/Hero'
import { RevisionsHighlight } from './components/RevisionsHighlight'
import { Features } from './components/Features'
import { QuickStart } from './components/QuickStart'
import { FAQ } from './components/FAQ'
import { Footer } from './components/Footer'
import { SiteHeader } from './components/SiteHeader'
import { SitePopup } from './components/SitePopup'
import {
  AccessibilityWidget,
  A11Y_MOTION_EVENT,
  readStopMotion,
} from './components/AccessibilityWidget'
import { BuyPage } from './pages/BuyPage'
import AccountPage from './pages/AccountPage'
import AuthActionPage from './pages/AuthActionPage'
import { ReviewPage } from './pages/ReviewPage'
import { DeliveryPage } from './pages/DeliveryPage'
import { RevisionsPage } from './pages/RevisionsPage'
import { DeliveriesPage } from './pages/DeliveriesPage'
import { SyncLandingPage } from './pages/SyncLandingPage'
import DrivePickerPage from './pages/DrivePickerPage'
import PartnerPage from './pages/PartnerPage'
import DeviceCheckPage from './pages/DeviceCheckPage'
import TrialActivatePage from './pages/TrialActivatePage'
import InstallPage from './pages/InstallPage'
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
    pathname.startsWith('/deliver/') ||
    pathname.startsWith('/auth-action') ||
    pathname.startsWith('/drive-picker') ||
    pathname.startsWith('/partner') ||
    pathname.startsWith('/device-check') ||
    pathname.startsWith('/trial') ||
    pathname.startsWith('/install') ||
    pathname.startsWith('/mac-setup') ||
    pathname.startsWith('/admin')
  )
}

function App() {
  const location = useLocation()
  // Drive framer-motion's reduced-motion from the accessibility menu's
  // "stop animations" toggle (CSS alone can't stop JS animations).
  const [reduceMotion, setReduceMotion] = useState(readStopMotion)
  useEffect(() => {
    const h = (e: Event) =>
      setReduceMotion(Boolean((e as CustomEvent).detail))
    window.addEventListener(A11Y_MOTION_EVENT, h)
    return () => window.removeEventListener(A11Y_MOTION_EVENT, h)
  }, [])
  return (
    // `relative` anchors the absolute-positioned SiteHeader to the top
    // of the page content. MotionConfig lets the accessibility menu's
    // "stop animations" toggle reduce framer-motion animation globally.
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <div className="relative">
        {/* The header belongs to the marketing/app shell only.
            Standalone surfaces (partner dashboard, client review,
            picker) render their own chrome. */}
        {!isChromelessRoute(location.pathname) && <SiteHeader />}
        {!isChromelessRoute(location.pathname) && <SitePopup />}
        <AnimatedRoutes />
        {/* Accessibility menu — required for Israeli sites (IS 5568).
            Rendered globally so it's reachable from every page. */}
        <AccessibilityWidget />
      </div>
    </MotionConfig>
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

  // Count visits to the marketing / buy / account pages (raw, no
  // cookies; de-duped per session inside trackPageview).
  useEffect(() => {
    const p = location.pathname
    if (p === '/') trackPageview('home')
    else if (p === '/buy') trackPageview('buy')
    else if (p === '/account') trackPageview('account')
  }, [location.pathname])

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
        {/* Public client-delivery page — final video(s) + download,
            opened by the recipient from a /deliver/<token> link. */}
        <Route path="/deliver/:token" element={<DeliveryPage />} />
        {/* Chromeless surface the DESKTOP app opens in a frameless
            modal window to run the Google Picker. Not linked from
            anywhere in the site UI — it's an app integration point. */}
        <Route path="/drive-picker" element={<DrivePickerPage />} />
        {/* Self-serve partner dashboard (referral stats). */}
        <Route path="/partner" element={<PartnerPage />} />
        {/* Support device-check landing — opens the desktop app to
            report its device signature (or shows a backup code). */}
        <Route path="/device-check/:code" element={<DeviceCheckPage />} />
        {/* Trial activation — opened from the desktop user menu; the app
            passes the ID token + device id on the fragment. */}
        <Route path="/trial" element={<TrialActivatePage />} />
        {/* Install / first-launch page — reached after the account gate;
            holds the REAL download button + one-time setup steps. */}
        <Route path="/install" element={<InstallPage />} />
        <Route path="/mac-setup" element={<InstallPage />} />
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
          {/* Marketing landing for the desktop "סנכרון אוטומטי" tab —
              animated demo of the audio-sync timeline + a download CTA
              that routes to the home page (single download surface).
              See pages/SyncLandingPage.tsx. */}
          <Route path="/sync" element={<SyncLandingPage />} />
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
          {/* Web /deliveries workspace — "מסירה ללקוח". Upload the
              final video(s), pick an expiry, get a /deliver/<token>
              link to send the client. Shares the auth + Pro ladder
              with /revisions via ProWorkspaceShell; uploads go to
              our own R2 storage (no Drive step). See
              pages/DeliveriesPage.tsx. */}
          <Route path="/deliveries" element={<DeliveriesPage />} />
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
