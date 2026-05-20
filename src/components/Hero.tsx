import { motion } from 'framer-motion'
import { Apple, Monitor, ArrowDown, Cloud } from 'lucide-react'
import { Link } from 'react-router-dom'

/**
 * Editorial-style hero. Asymmetric two-column layout (text right,
 * suggestive product visual left in RTL terms) instead of the
 * centered-everything pattern that screams "AI-generated landing
 * page". The display headline uses Instrument Serif / Frank Ruhl
 * Libre (Hebrew fallback) at clamp() sizes with a single italic
 * accent word — the magazine convention of one italic per heading
 * lets the headline carry rhythm without resorting to gradient text.
 */

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
// Mac fallback link is exposed in the hero sub-meta row. The
// Windows Drive fallback link still exists in the releases repo
// but isn't surfaced in the new editorial layout — Windows
// already has the GitHub direct-download button alongside the
// Mac one, and adding a second fallback row crowded the meta
// line. Kept the const here as documentation of where to find it.
const DRIVE_DOWNLOAD_MAC =
  'https://drive.google.com/file/d/1ezciHjhrPULWCT3VGt0dwn7bYO9A4HKP/view?usp=drive_link'

export function Hero() {
  const scrollToFeatures = () => {
    document
      .getElementById('features')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="relative overflow-hidden px-6 pt-12 pb-20 md:pt-20 md:pb-28">
      {/* Single warm ambient glow, top-left in RTL = top-right in
          the visual. Intentionally minimal — one glow, not two
          competing blobs. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[480px] w-[680px] -translate-x-1/2 rounded-full"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(184,121,79,0.18) 0%, transparent 65%)',
        }}
      />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 md:grid-cols-[1.1fr,0.9fr] md:gap-16">
        {/* TEXT COLUMN — sits on the right in RTL (DOM first). */}
        <div>
          {/* Editorial label — uppercase mono-ish, with em-dash. The
              dash is a deliberate magazine convention; it signals
              "this site was art-directed, not auto-generated". */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="label mb-6"
          >
            ליוצרי תוכן ועורכי וידאו —
          </motion.div>

          {/* Display headline — serif, massive, with one italic word.
              clamp() keeps it readable from 375px to 2560px without
              breakpoint babysitting. line-height is intentionally
              tight (1.0) because serif glyphs already have built-in
              vertical air; the standard 1.5 looks airy and amateur
              at this size. */}
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.05 }}
            className="font-display text-fg"
            style={{
              fontSize: 'clamp(44px, 7.5vw, 96px)',
              lineHeight: 1.0,
              letterSpacing: '-0.02em',
            }}
          >
            ניהול הורדות,
            <br />
            <span className="italic-serif" style={{ color: 'var(--accent)' }}>
              סוף־סוף
            </span>{' '}
            מסודר.
          </motion.h1>

          {/* Subhead — one sentence. The previous three-paragraph
              version asked the reader to commit too early; this
              single line is the headline's logical follow-through
              and stops there. Whatever else needs saying lives in
              the Features section below. */}
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="mt-8 max-w-lg text-lg text-fg-secondary md:text-xl"
            style={{ lineHeight: 1.5 }}
          >
            קובץ שיורד — וידאו, סאונד, תמונה — נכנס מיד לפרויקט הנכון.
          </motion.p>

          {/* CTA row — primary download as the lead, platform switch
              as a quiet secondary. No competing gradients, no
              shadow-soup. Single decisive copper button. */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            className="mt-10 flex flex-col items-start gap-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={DOWNLOAD_MAC_GITHUB}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary"
              >
                <Apple className="h-[18px] w-[18px]" />
                הורד ל-Mac
                <span className="text-xs opacity-60">·</span>
                <span className="text-xs opacity-70">חינם</span>
              </a>
              <a
                href={DOWNLOAD_WIN_GITHUB}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary"
              >
                <Monitor className="h-[18px] w-[18px]" />
                הורד ל-Windows
              </a>
            </div>

            {/* Sub-meta row — Drive fallback + Pro mention. Quieter.
                Em-dash separators tie everything to the editorial
                voice instead of using pipe characters or bullets. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted">
              <span>תומך macOS ו-Windows</span>
              <span aria-hidden>—</span>
              <a
                href={DRIVE_DOWNLOAD_MAC}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-fg-secondary underline decoration-fg-faint underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-muted"
              >
                <Cloud className="h-3 w-3" />
                לינק Google Drive
              </a>
              <span aria-hidden>—</span>
              <Link
                to="/buy"
                className="text-fg-secondary transition-colors hover:text-accent"
              >
                Pro לעורך מקצועי
              </Link>
            </div>
          </motion.div>

          {/* Scroll cue — barely there. A bouncing arrow is the AI
              landing page calling card; we keep the affordance but
              make it static and small. */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            onClick={scrollToFeatures}
            className="mt-12 inline-flex items-center gap-2 text-xs text-fg-muted transition-colors hover:text-fg-secondary"
          >
            <ArrowDown className="h-3 w-3" />
            איך זה עובד
          </motion.button>
        </div>

        {/* VISUAL COLUMN — stylized product window. Pure CSS, no
            screenshot. The list-like rows convey "this is a tool
            that routes files" without needing real product imagery.
            On mobile (single column) this falls below the text. */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="relative"
        >
          <HeroProductVisual />
        </motion.div>
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────
 *  Product visual — stylized window with file-routing rows.
 *  Goal: convey the app's purpose at a glance ("downloads get
 *  routed to projects") without needing a real screenshot. The
 *  fake macOS-style traffic-light buttons + window chrome make
 *  this read as "desktop application" instantly.
 * ───────────────────────────────────────────────────────────── */
function HeroProductVisual() {
  return (
    <div
      className="card-elevated overflow-hidden"
      style={{
        boxShadow:
          '0 32px 80px rgba(13,8,4,0.6), 0 8px 24px rgba(13,8,4,0.4), 0 0 0 1px rgba(245,239,230,0.06)',
      }}
    >
      {/* Window chrome — macOS-style traffic lights. Functional
          appearance only; not interactive. */}
      <div
        className="flex items-center gap-2 border-b border-border px-4 py-3"
        style={{ backgroundColor: 'var(--bg-card)' }}
      >
        <span className="h-3 w-3 rounded-full bg-destructive opacity-70" />
        <span
          className="h-3 w-3 rounded-full opacity-70"
          style={{ backgroundColor: 'var(--accent)' }}
        />
        <span className="h-3 w-3 rounded-full bg-success opacity-70" />
        <div className="flex-1 text-center text-xs text-fg-muted" dir="rtl">
          ניהול הורדות פלוס — Studio.proj
        </div>
        <span className="w-12" aria-hidden />
      </div>

      {/* Body — column header + routed file rows. The arrow icons
          convey routing direction. The "Music / Video / Photos"
          tags hint at the app's project-folder model. */}
      <div className="p-5">
        <div
          className="mb-4 flex items-center justify-between text-xs uppercase tracking-wider text-fg-muted"
          dir="rtl"
        >
          <span>קבצים אחרונים</span>
          <span>נותב ל־</span>
        </div>

        <div className="space-y-2.5" dir="rtl">
          <FileRow
            name="Interview_Cut_03.mp4"
            size="248 MB"
            target="Video"
            time="now"
            highlight
          />
          <FileRow
            name="bgm_loop_dark.wav"
            size="84 MB"
            target="Music"
            time="now"
          />
          <FileRow
            name="thumbnail_v4.png"
            size="2.1 MB"
            target="Photos"
            time="1m"
          />
          <FileRow
            name="transcript_raw.txt"
            size="36 KB"
            target="Notes"
            time="3m"
          />
          <FileRow
            name="sfx_swoosh_long.wav"
            size="1.4 MB"
            target="SFX"
            time="5m"
          />
        </div>

        {/* Status footer — gives the window a "live app" feeling
            with a soft pulsing dot. */}
        <div
          className="mt-5 flex items-center justify-between border-t border-border pt-4 text-xs text-fg-muted"
          dir="rtl"
        >
          <div className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: 'var(--success)',
                boxShadow: '0 0 8px var(--success)',
              }}
            />
            <span>במעקב — 5 פרויקטים פעילים</span>
          </div>
          <span className="tabular text-fg-faint">v1.7.3</span>
        </div>
      </div>
    </div>
  )
}

function FileRow({
  name,
  size,
  target,
  time,
  highlight,
}: {
  name: string
  size: string
  target: string
  time: string
  highlight?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
        highlight ? 'bg-bg-card' : 'hover:bg-bg-card/60'
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="font-mono text-fg-secondary"
          style={{ direction: 'ltr', unicodeBidi: 'embed' }}
        >
          {name}
        </span>
        <span className="text-xs text-fg-faint tabular">{size}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-fg-faint tabular">{time}</span>
        <span
          className="rounded-pill px-2 py-0.5 text-xs font-medium"
          style={{
            backgroundColor: highlight
              ? 'var(--accent-glow)'
              : 'rgba(245,239,230,0.04)',
            color: highlight ? 'var(--accent)' : 'var(--fg-secondary)',
            borderRadius: 'var(--radius-pill)',
          }}
        >
          {target}
        </span>
      </div>
    </div>
  )
}
