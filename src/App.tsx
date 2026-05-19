import { motion } from 'framer-motion'
import { Hero } from './components/Hero'
import { Features } from './components/Features'
import { Pricing } from './components/Pricing'
import { QuickStart } from './components/QuickStart'
import { FAQ } from './components/FAQ'
import { Footer } from './components/Footer'

// Top-level layout. All download URLs are hardcoded in Hero, so we
// don't fetch the GitHub Releases API at runtime — the site is fully
// static and renders identical content for every visitor.
function App() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="relative"
    >
      <Hero />
      <Features />
      {/* Pricing sits between the feature grid and the quick-start
          screenshots — by the time the reader scrolls down to it,
          they've already seen what the app can do, so the purchase
          ask isn't premature. */}
      <Pricing />
      <QuickStart />
      <FAQ />
      <Footer />
    </motion.div>
  )
}

export default App
