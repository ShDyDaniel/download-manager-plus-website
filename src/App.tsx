import { motion } from 'framer-motion'
import { Route, Routes } from 'react-router-dom'
import { Hero } from './components/Hero'
import { Features } from './components/Features'
import { QuickStart } from './components/QuickStart'
import { FAQ } from './components/FAQ'
import { Footer } from './components/Footer'
import { BuyPage } from './pages/BuyPage'

// Top-level layout. The marketing site is the default route (`/`);
// the purchase flow lives at `/buy` so the URL is shareable, deep-
// linkable, and Google-indexable. Vercel's `vercel.json` rewrites
// non-/api requests to index.html so deep links survive refresh.
function App() {
  return (
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
    </Routes>
  )
}

export default App
