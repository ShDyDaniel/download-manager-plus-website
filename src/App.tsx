import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Hero } from './components/Hero'
import { Features } from './components/Features'
import { QuickStart } from './components/QuickStart'
import { FAQ } from './components/FAQ'
import { Footer } from './components/Footer'
import { fetchLatestRelease, type ReleaseInfo } from './api/releases'

// Top-level layout. Hero loads release info async so the download
// buttons can show actual file sizes / version. Subsequent sections
// don't depend on it.
function App() {
  const [release, setRelease] = useState<ReleaseInfo | null>(null)

  useEffect(() => {
    fetchLatestRelease().then(setRelease).catch(() => null)
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="relative"
    >
      <Hero release={release} />
      <Features />
      <QuickStart />
      <FAQ />
      <Footer />
    </motion.div>
  )
}

export default App
