import { motion } from 'framer-motion'
import { Apple, Monitor, ArrowDown, Cloud } from 'lucide-react'

// Hardcoded download URLs for the current release. Update both the
// GitHub direct-download URLs AND the Drive fallback URLs in lockstep
// every time a new version ships. The website does NOT auto-resolve
// the latest release at runtime — that put the GitHub Releases API
// in the request critical path and broke the download buttons whenever
// the release was still in draft. Hardcoding keeps the site working
// the moment a version is published, with no surprises.
const DOWNLOAD_MAC_GITHUB =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases/download/1.6.5/Download.Manager.Plus-1.6.5-arm64.dmg'
const DOWNLOAD_WIN_GITHUB =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases/download/1.6.5/Download.Manager.Plus.Setup.1.6.5.exe'

// Google Drive fallback links — for users on networks where GitHub
// Releases is blocked (some corporate / school / region-restricted
// networks block raw GitHub asset hosts but allow Drive).
const DRIVE_DOWNLOAD_MAC =
  'https://drive.google.com/file/d/1ezciHjhrPULWCT3VGt0dwn7bYO9A4HKP/view?usp=drive_link'
const DRIVE_DOWNLOAD_WIN =
  'https://drive.google.com/file/d/1c7itYDtBotF1gKSJrc17qjkEyoXMmZCM/view?usp=drive_link'

export function Hero() {
  // Smooth-scroll to the features section when the user clicks the
  // "מה התוכנה עושה" pill at the bottom of the hero.
  const scrollToFeatures = () => {
    document
      .getElementById('features')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="relative px-6 pt-16 pb-24 md:pt-24 md:pb-32">
      <div className="mx-auto max-w-5xl text-center">
        {/* App icon */}
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, delay: 0.15 }}
          className="mb-6 flex justify-center"
        >
          <img
            src="./icon.png"
            alt="ניהול הורדות פלוס"
            className="h-20 w-20 rounded-2xl shadow-2xl shadow-violet-900/40 ring-1 ring-white/10 md:h-24 md:w-24"
          />
        </motion.div>

        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="gradient-text text-4xl font-bold leading-tight md:text-6xl"
        >
          ניהול הורדות פלוס
        </motion.h1>

        {/* Audience tagline */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.22 }}
          className="mt-3 text-sm font-medium text-violet-300/80 md:text-base"
        >
          ליוצרי תוכן ועורכי וידאו
        </motion.div>

        {/* Sub-headline — line breaks preserved exactly as the copy
            was authored (three separate lines, each its own beat). */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.27 }}
          className="mx-auto mt-4 max-w-2xl space-y-2 text-base leading-relaxed text-white/70 md:text-lg"
        >
          <p>סוף לבלגן בתיקיית ההורדות. סוף לשאלה "לאיזה פרויקט הקובץ הזה שייך"?</p>
          <p>כל קובץ שמורידים — וידאו, סאונד, תמונה, מסמך — מנותב אוטומטית לפרויקט הפעיל ברגע שהוא יורד למחשב שלך.</p>
          <p>פחות זמן על סידורים, יותר זמן על יצירה.</p>
        </motion.div>

        {/* Primary download buttons (GitHub Releases) */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.35 }}
          className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <DownloadButton kind="mac" href={DOWNLOAD_MAC_GITHUB} />
          <DownloadButton kind="windows" href={DOWNLOAD_WIN_GITHUB} />
        </motion.div>

        {/* Google Drive fallback row — for users whose network blocks
            GitHub. Smaller / quieter style so it doesn't compete
            visually with the primary CTA, but still always visible. */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.42 }}
          className="mt-6 flex flex-col items-center gap-3"
        >
          <div className="text-xs text-white/50">
            הקישור לא עובד? תוכל להוריד גם דרך Google Drive
          </div>
          <div className="flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-3">
            <DriveButton kind="mac" href={DRIVE_DOWNLOAD_MAC} />
            <DriveButton kind="windows" href={DRIVE_DOWNLOAD_WIN} />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.55 }}
          className="mt-6 text-xs text-white/40"
        >
          חינם להורדה · עובד על Apple Silicon ו-Windows x64
        </motion.div>

        {/* Scroll cue */}
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.7 }}
          onClick={scrollToFeatures}
          className="mt-16 inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-xs text-white/60 transition-all hover:border-white/20 hover:text-white"
        >
          מה התוכנה עושה
          <ArrowDown className="h-3.5 w-3.5 animate-bounce" />
        </motion.button>
      </div>
    </section>
  )
}

function DownloadButton({
  kind,
  href,
}: {
  kind: 'mac' | 'windows'
  href: string
}) {
  const Icon = kind === 'mac' ? Apple : Monitor
  const label = kind === 'mac' ? 'הורד ל-Mac' : 'הורד ל-Windows'
  const hue =
    kind === 'mac'
      ? 'from-violet-500 to-indigo-600 shadow-violet-900/40 hover:shadow-violet-700/50'
      : 'from-blue-500 to-cyan-600 shadow-blue-900/40 hover:shadow-blue-700/50'
  return (
    <a
      href={href}
      target={href.startsWith('http') ? '_blank' : undefined}
      rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
      className={`group inline-flex min-w-[210px] items-center justify-center gap-3 rounded-xl bg-gradient-to-br ${hue} px-6 py-3.5 text-sm font-semibold text-white shadow-lg transition-all hover:brightness-110 active:scale-[0.98]`}
    >
      <Icon className="h-5 w-5" />
      <span>{label}</span>
    </a>
  )
}

// Quieter "outline" version of the download button, used for the
// Google Drive fallback row. Same icons as the primary buttons so
// the platform association stays obvious; the difference is the
// neutral border instead of a colored gradient — keeps the user's
// eye on the primary CTA above.
function DriveButton({
  kind,
  href,
}: {
  kind: 'mac' | 'windows'
  href: string
}) {
  const Icon = kind === 'mac' ? Apple : Monitor
  const label = kind === 'mac' ? 'הורד ל-Mac דרך Drive' : 'הורד ל-Windows דרך Drive'
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center justify-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-medium text-white/80 transition-all hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      <Cloud className="h-3.5 w-3.5 opacity-60" />
    </a>
  )
}
