import { AnimatePresence, motion } from 'framer-motion'
import {
  Apple,
  Monitor,
  ArrowDown,
  Cloud,
  Crown,
  Download,
  ChevronDown,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/**
 * Editorial-style hero. Asymmetric two-column layout (text right,
 * suggestive product visual left in RTL terms) instead of the
 * centered-everything pattern that screams "AI-generated landing
 * page". The display headline uses Rubik at clamp() sizes with a
 * single accent-color word (no italic — Hebrew has no true italic
 * and synthetic slant looks broken to a Hebrew reader) so emphasis
 * comes from weight + color, not from leaning glyphs.
 */

// Hardcoded download URLs for the current release. Update both the
// GitHub direct-download URLs AND the Drive fallback URLs in lockstep
// every time a new version ships. The website does NOT auto-resolve
// the latest release at runtime — that put the GitHub Releases API
// in the request critical path and broke the download buttons whenever
// the release was still in draft. Hardcoding keeps the site working
// the moment a version is published, with no surprises.
const DOWNLOAD_MAC_GITHUB =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases/download/1.7.6/Download.Manager.Plus-1.7.6-arm64.dmg'
const DOWNLOAD_WIN_GITHUB =
  'https://github.com/ShDyDaniel/download-manager-plus-releases/releases/download/1.7.6/Download.Manager.Plus-1.7.6-x64.exe'

// Google Drive fallback links — for users on networks where GitHub
// Releases is blocked (some corporate / school / region-restricted
// networks block raw GitHub asset hosts but allow Drive). Both
// platforms now get a Drive link surfaced via the dropdown CTA so
// blocked Windows users aren't stranded.
const DRIVE_DOWNLOAD_MAC =
  'https://drive.google.com/file/d/1RhTDO7sQbmuGsFeMQkgoBUsKU0MT9ScQ/view?usp=drive_link'
const DRIVE_DOWNLOAD_WIN =
  'https://drive.google.com/file/d/1s0BON0ohxi5dP5NMLkQVpDmgEDVhLzvS/view?usp=drive_link'

export function Hero() {
  const scrollToFeatures = () => {
    document
      .getElementById('features')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="relative overflow-hidden px-5 pt-10 pb-14 md:px-6 md:pt-20 md:pb-28">
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

      <div className="relative mx-auto grid max-w-6xl items-center gap-10 md:grid-cols-[1.1fr,0.9fr] md:gap-16">
        {/* TEXT COLUMN — sits on the right in RTL (DOM first). */}
        <div>
          {/* Brand row — the product icon + wordmark, sitting at
              the top of the hero. This is the "face" of the
              software showing up before anything else; without it
              the page reads as "some app" instead of "this app".
              Kept compact (40px icon) so it anchors identity but
              doesn't compete with the headline below. */}
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mb-8 inline-flex items-center gap-3"
          >
            <img
              src="./icon.png"
              alt="לוגו ניהול הורדות פלוס"
              className="h-10 w-10 rounded-[10px]"
              style={{
                boxShadow:
                  '0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px rgba(13,8,4,0.5)',
              }}
            />
            <span className="text-[15px] font-medium text-fg">
              ניהול הורדות פלוס
            </span>
          </motion.div>

          {/* Editorial label — uppercase, with em-dash. The dash is
              a deliberate magazine convention; it signals "this
              site was art-directed, not auto-generated". */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
            className="label mb-6"
          >
            ליוצרי תוכן ועורכי וידאו —
          </motion.div>

          {/* Display headline — Rubik, massive, with one accent
              word in heavier weight + warm color. clamp() keeps it
              readable from 375px to 2560px without breakpoint
              babysitting. Line-height is tight (1.05) — at this
              size the standard 1.5 reads as airy and amateur. */}
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
            <span className="accent-word">
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
            className="mt-6 max-w-lg text-base text-fg-secondary md:mt-8 md:text-xl"
            style={{ lineHeight: 1.55 }}
          >
            קובץ שיורד — וידאו, סאונד, תמונה — נכנס מיד לפרויקט הנכון.
          </motion.p>

          {/* CTA block — three actions, in priority order from top:
              1. Free download (primary copper button, opens an OS
                 picker — Mac or Windows). Most visitors want this.
              2. Drive mirror (secondary outline, same OS picker).
                 For corporate/school networks that block GitHub.
              3. Pro purchase (clearly distinct, accent-tinted with
                 Crown icon + price). Now gets the full visual real
                 estate it deserves instead of being squeezed into a
                 meta line. The visual separator above it (border-t)
                 tells the eye "this is a different kind of action". */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            className="mt-8 flex w-full max-w-md flex-col items-stretch gap-4 md:mt-10"
          >
            {/* Download row — two equal-weight buttons that each
                open an OS picker on click. `grid-cols-2` (not flex)
                guarantees both buttons end up the same width
                regardless of label length — previously "הורדה חינם"
                and "דרך Google Drive" rendered at different widths
                because flex was auto-sizing each one to its
                content, which looked broken next to the Pro button
                below. Stacked on mobile for 44pt touch targets. */}
            <div className="flex flex-col items-stretch gap-3 sm:grid sm:grid-cols-2">
              <DownloadPicker
                label="הורדה חינם"
                icon={<Download className="h-[18px] w-[18px]" />}
                macUrl={DOWNLOAD_MAC_GITHUB}
                winUrl={DOWNLOAD_WIN_GITHUB}
                variant="primary"
              />
              <DownloadPicker
                label="דרך Google Drive"
                icon={<Cloud className="h-[18px] w-[18px]" />}
                macUrl={DRIVE_DOWNLOAD_MAC}
                winUrl={DRIVE_DOWNLOAD_WIN}
                variant="secondary"
              />
            </div>

            {/* Pro CTA. Stretches to the same max-width as the
                download row above (max-w-md on the parent) so the
                three CTAs form a tidy vertical column instead of
                three different widths fighting each other. Crown
                + gradient still differentiate the action. */}
            <Link
              to="/buy"
              className="group relative mt-2 flex items-center justify-center gap-3 overflow-hidden rounded-2xl border border-primary/60 bg-gradient-to-l from-primary/15 to-primary/5 px-6 py-4 text-base font-semibold text-fg shadow-lg shadow-primary/10 transition-all hover:border-primary hover:from-primary/25 hover:to-primary/10 hover:shadow-xl hover:shadow-primary/20"
            >
              <Crown className="h-5 w-5 text-primary" />
              <span className="flex items-baseline gap-2">
                <span className="text-base md:text-lg">רכישת מנוי Pro</span>
                <span className="text-xs font-medium text-fg-muted">
                  · מ-5 ₪/חודש
                </span>
              </span>
              <ChevronDown className="h-4 w-4 -rotate-90 text-primary transition-transform group-hover:-translate-x-1" />
            </Link>

            {/* Sub-meta — platform support note. Drive lives in the
                button now, no need to re-mention it here. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
              <span>תומך macOS ו-Windows</span>
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
            className="mt-10 inline-flex items-center gap-2 text-xs text-fg-muted transition-colors hover:text-fg-secondary md:mt-12"
          >
            <ArrowDown className="h-3 w-3" />
            איך זה עובד
          </motion.button>
        </div>

        {/* VISUAL COLUMN — stylized product window. Pure CSS, no
            screenshot. The list-like rows convey "this is a tool
            that routes files" without needing real product imagery.
            HIDDEN ON MOBILE — the mockup detail (file names, sizes,
            routing chips) doesn't read at phone width, and the
            vertical real estate it would consume pushes the
            download CTA below the fold. Mobile visitors get the
            wordmark + headline + CTA above the fold instead. */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="relative hidden md:block"
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

/* ─────────────────────────────────────────────────────────────
 *  DownloadPicker — a CTA button that, on click, reveals a small
 *  popover anchored beneath it with two OS choices (Mac, Windows).
 *  Used twice in the hero: once for the GitHub direct downloads
 *  (primary copper) and once for the Drive mirror fallback
 *  (secondary outline). Pulling them into one component keeps the
 *  open/close + click-outside + ARIA wiring DRY between the two.
 *
 *  Why a popover and not two separate buttons:
 *  - The previous layout had four separate links (Mac GH, Win GH,
 *    Mac Drive, Win Drive) — that's a lot of CTA noise above the
 *    fold and made the actual purchase button impossible to find.
 *  - Now the user picks "free download" or "Drive download" first
 *    (the meaningful decision), and only THEN picks an OS (a quick
 *    follow-up choice). That frees up vertical space for the Pro
 *    button to actually breathe.
 * ───────────────────────────────────────────────────────────── */
function DownloadPicker({
  label,
  icon,
  badge,
  macUrl,
  winUrl,
  variant,
}: {
  label: string
  icon: React.ReactNode
  badge?: string
  macUrl: string
  winUrl: string
  variant: 'primary' | 'secondary'
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Click-outside-to-close. Listening on `mousedown` (not `click`)
  // means we react before the next click target's own handlers
  // fire — important when one DownloadPicker is open and the user
  // clicks the OTHER picker's button, we want this one to close
  // FIRST so the other one can open cleanly.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const triggerClass =
    variant === 'primary' ? 'btn-primary justify-center' : 'btn-secondary justify-center'

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${triggerClass} w-full`}
      >
        {icon}
        <span>{label}</span>
        {badge && (
          <>
            <span className="text-xs opacity-60">·</span>
            <span className="text-xs opacity-70">{badge}</span>
          </>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${
            open ? 'rotate-180' : ''
          } ${variant === 'primary' ? 'opacity-70' : 'opacity-50'}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            role="menu"
            className="absolute right-0 z-30 mt-2 w-full min-w-[220px] overflow-hidden rounded-xl border border-border bg-bg-card p-1 shadow-2xl shadow-black/40 sm:right-auto sm:left-0"
          >
            <a
              href={macUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-fg transition-colors hover:bg-bg-elevated"
            >
              <Apple className="h-4 w-4 text-fg-secondary" />
              <span className="flex-1 text-right">macOS</span>
              <span className="text-[10px] uppercase tracking-wider text-fg-faint">
                .dmg
              </span>
            </a>
            <a
              href={winUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              role="menuitem"
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-fg transition-colors hover:bg-bg-elevated"
            >
              <Monitor className="h-4 w-4 text-fg-secondary" />
              <span className="flex-1 text-right">Windows</span>
              <span className="text-[10px] uppercase tracking-wider text-fg-faint">
                .exe
              </span>
            </a>
          </motion.div>
        )}
      </AnimatePresence>
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
