import { motion } from 'framer-motion'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Hero } from './components/Hero'
import { Features } from './components/Features'
import { QuickStart } from './components/QuickStart'
import { FAQ } from './components/FAQ'
import { Footer } from './components/Footer'
import { SiteHeader } from './components/SiteHeader'
import { BuyPage } from './pages/BuyPage'
import AccountPage from './pages/AccountPage'
import AuthActionPage from './pages/AuthActionPage'
import { ReviewPage } from './pages/ReviewPage'

// Top-level layout. The marketing site is the default route (`/`);
// the purchase flow lives at `/buy` so the URL is shareable, deep-
// linkable, and Google-indexable. Vercel's `vercel.json` rewrites
// non-/api requests to index.html so deep links survive refresh.
function App() {
  return (
    // `relative` here anchors the absolute-positioned SiteHeader to
    // the top of the page content (NOT the viewport — the user
    // doesn't want a sticky element). When the user scrolls down,
    // the SiteHeader scrolls out of view with the rest of the
    // page; it reappears only when scrolling back to the top.
    <div className="relative">
      <SiteHeader />
      <Routes>
        <Route
          path="/"
          element={
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="relative"
            >
              <Hero />
              <Features />
              <QuickStart />
              <FAQ />
              <Footer />
            </motion.div>
          }
        />
        <Route path="/buy" element={<BuyPage />} />
        <Route path="/account" element={<AccountPage />} />
        {/* Custom Firebase Auth action handler. Hosts the password-
            reset (and future verifyEmail) flow on our domain so the
            user never sees the firebaseapp.com fallback page. Wired
            via Firebase Console → Authentication → Templates →
            Customize action URL. */}
        <Route path="/auth-action" element={<AuthActionPage />} />
        {/* Public revision-review page — link sent to client by the
            editor. /review/:token resolves the share token to a
            project, gates by optional password + required email
            (used for watermark), then renders the Drive embed
            player + notes sidebar. See pages/ReviewPage.tsx. */}
        <Route path="/review/:token" element={<ReviewPage />} />
        {/* /manage was the original subscription-management page
            before /account absorbed all its functionality. Keep a
            permanent redirect so old emails, footers, the desktop
            app's pre-update "ניהול תוכנית" button, and Google
            results still land somewhere useful. */}
        <Route path="/manage" element={<Navigate to="/account" replace />} />
      </Routes>
    </div>
  )
}

export default App
