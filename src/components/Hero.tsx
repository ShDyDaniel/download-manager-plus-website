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
import {
  currencySymbol,
  formatPrice,
  minPricePerMonth,
  useLivePricing,
} from '../lib/pricing'

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
  // Live pricing for the Pro CTA's "starting from X ₪/month" line.
  // Returns null on the very-first-ever visit (no localStorage
  // cache, no fetch yet) — in that case we omit the price line
  // entirely rather than flashing hardcoded defaults. Subsequent
  // visits read the cached value synchronously and render the
  // right number on the first paint.
  const pricing = useLivePricing()
  const minPerMonth = pricing ? minPricePerMonth(pricing) : null
  const sym = pricing ? currencySymbol(pricing.currency) : ''

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
          {/* Brand icon — anchors visual identity in the top
              corner. The wordmark text used to live next to it but
              moved into the main headline below (so the brand name
              is the H1, not a side label), which left the icon
              alone here. Kept it because the icon serves as a
              persistent visual mark — same shape the user sees in
              their dock once they install — without competing with
              the headline that now reads the brand name in full. */}
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mb-8 inline-flex items-center"
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
            — ליוצרי תוכן ועורכי וידאו
          </motion.div>

          {/* Display headline — Rubik, massive. Brand-led: the
              product NAME is the headline (with "פלוס" carrying
              the copper accent because that's the differentiator).
              clamp() keeps it readable from 375px to 2560px
              without breakpoint babysitting; line-height tight
              (1.0) — at this size the standard 1.5 reads as airy
              and amateur. */}
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.05 }}
            className="font-display text-fg [white-space:normal] md:[white-space:nowrap]"
            style={{
              // Clamp evolved through several rounds of mobile
              // feedback. Final: 48 → 64. At 48px on a 375px
              // viewport the headline wraps to two lines, which
              // turns out to LOOK BETTER on mobile than a tightly-
              // packed single line — "ניהול הורדות" / "פלוס"
              // reads like an editorial display headline rather
              // than a cramped product wordmark. Single-line is
              // restored at md:+ via the [white-space:nowrap]
              // utility class (desktop has the horizontal room to
              // keep all 17 chars on one line).
              fontSize: 'clamp(48px, 11.5vw, 64px)',
              lineHeight: 1.05,
              letterSpacing: '-0.025em',
            }}
          >
            ניהול הורדות{' '}
            <span className="accent-word">פלוס</span>
          </motion.h1>

          {/* Secondary headline — the value-prop line that the
              brand-led H1 needs as its emotional follow-through.
              "הכל מסודר" (vs. the old "מסודר") is deliberate: it
              implies the order applies across EVERYTHING the app
              does (downloads, quotes, payments, projects), not
              just the file-routing feature. About 60% of the H1's
              font size so it reads as supporting rather than
              competing. "סוף סוף" gets the accent — same emotional
              hook the old headline used, kept because it lands. */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mt-3 font-display text-fg md:mt-4"
            style={{
              // ~70% of H1 to stay clearly supporting while still
              // reading as a hero element. Mobile min (34) tracks
              // the H1 min (48) bump in lockstep.
              fontSize: 'clamp(34px, 7vw, 44px)',
              lineHeight: 1.1,
              letterSpacing: '-0.015em',
            }}
          >
            <span className="accent-word">סוף סוף</span> הכל מסודר
          </motion.div>

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
            ועוד הרבה כלים שיחסכו לכם הרבה מאוד זמן.
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
            className="mt-7 flex w-full max-w-md flex-col items-stretch gap-2 md:mt-10 md:gap-4"
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
                icon={
                  <Download className="h-3.5 w-3.5 md:h-[18px] md:w-[18px]" />
                }
                macUrl={DOWNLOAD_MAC_GITHUB}
                winUrl={DOWNLOAD_WIN_GITHUB}
                variant="primary"
              />
              <DownloadPicker
                label="דרך Google Drive"
                icon={
                  <Cloud className="h-3.5 w-3.5 md:h-[18px] md:w-[18px]" />
                }
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
              className="group relative mt-1 flex min-h-[40px] items-center justify-center gap-1.5 overflow-hidden rounded-xl border border-primary/60 bg-gradient-to-l from-primary/15 to-primary/5 px-3 py-2 text-xs font-semibold text-fg shadow-lg shadow-primary/10 transition-all hover:border-primary hover:from-primary/25 hover:to-primary/10 hover:shadow-xl hover:shadow-primary/20 md:mt-2 md:min-h-[44px] md:gap-3 md:rounded-2xl md:px-6 md:py-4 md:text-base"
            >
              <Crown className="h-3.5 w-3.5 text-primary md:h-5 md:w-5" />
              <span className="flex items-baseline gap-2">
                <span className="text-xs md:text-lg">רכישת מנוי Pro</span>
                {minPerMonth !== null && (
                  <span className="text-xs font-medium text-fg-muted">
                    · מ-{formatPrice(minPerMonth)} {sym}/חודש
                  </span>
                )}
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
          ניהול הורדות פלוס — טריילר_סרט_קיץ.proj
        </div>
        <span className="w-12" aria-hidden />
      </div>

      {/* Body — column header + routed file rows. The arrow icons
          convey routing direction. The "Music / Video / Photos"
          tags hint at the app's project-folder model. */}
      <div className="p-5">
        {/* Header gets px-3 to match the file rows' inset — without
            it the labels ("קבצים אחרונים" / "נותב ל־") were flush
            against the panel edge while the row content underneath
            sat 12px inward, which read as a misalignment between
            each label and its column. */}
        <div
          className="mb-4 flex items-center justify-between px-3 text-xs uppercase tracking-wider text-fg-muted"
          dir="rtl"
        >
          <span>קבצים אחרונים</span>
          <span>נותב ל־</span>
        </div>

        <div className="space-y-2.5" dir="rtl">
          {/* `highlight` removed — earlier the Video row got a
              copper-tinted pill to draw the eye, but on a static
              marketing mockup it implied "this one is special" and
              the user wanted all four rows to read as peers. */}
          <FileRow
            name="Interview_Cut_03.mp4"
            size="248 MB"
            target="Video"
            time="now"
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

        {/* The "במעקב — N פרויקטים פעילים" + version footer used to
            live here. Removed at user request — the version was
            stale-looking the moment we bumped the real app's
            version, and "5 פרויקטים פעילים" was an arbitrary
            number that didn't add information. The mockup now ends
            cleanly at the last file row. */}
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
        // Aggressive mobile compaction after operator feedback
        // ("much smaller buttons on phone"). Mobile defaults:
        //   - !py-2 (8px) instead of .btn-primary's 14px
        //   - !text-xs (12px) instead of 15px
        //   - !gap-1.5 to keep icon/text from looking floaty
        //   - min-h-[40px] floor (under Apple's 44pt rec, but
        //     these CTAs are large enough horizontally that
        //     accidental misfires are unlikely; the operator
        //     explicitly prioritized visual size over comfort)
        // All overrides revert at md:+ so desktop hierarchy is
        // unchanged.
        className={`${triggerClass} w-full min-h-[40px] !gap-1.5 !py-2 !text-xs md:min-h-[44px] md:!gap-2 md:!py-[14px] md:!text-[15px]`}
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
