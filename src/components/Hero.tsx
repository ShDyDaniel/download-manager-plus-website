import { motion } from 'framer-motion'
import { Apple, Monitor, ArrowDown } from 'lucide-react'
import { type ReleaseInfo, RELEASES_PAGE_URL } from '../api/releases'

export function Hero({ release }: { release: ReleaseInfo | null }) {
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

        {/* Sub-headline */}
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.27 }}
          className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-white/70 md:text-lg"
        >
          סוף לבלגן בתיקיית ההורדות. סוף לשאלה "לאיזה פרויקט הקובץ הזה שייך"?
          כל קובץ שמורידים — וידאו, סאונד, תמונה, מסמך — מנותב אוטומטית לפרויקט
          הפעיל ברגע שהוא יורד למחשב שלך. פחות זמן על סידורים, יותר זמן על יצירה.
        </motion.p>

        {/* Download buttons */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.35 }}
          className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <DownloadButton
            kind="mac"
            href={release?.macArm64?.url || RELEASES_PAGE_URL}
          />
          <DownloadButton
            kind="windows"
            href={release?.windows?.url || RELEASES_PAGE_URL}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-3 text-xs text-white/40"
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
