import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X } from 'lucide-react'

/**
 * Marketing-site top-left navigation.
 *
 * Desktop: three editorial text links (סבבי תיקונים · מסירה ללקוח ·
 * החשבון שלי) anchored to the left edge of the page's content rail.
 *
 * Mobile: those links don't fit cleanly at the top (and on /buy they
 * collided with the page's own back-link), so instead we show a small
 * SQUARE copper menu button (three lines, like a settings icon). Tapping
 * it opens a side drawer that lists the same destinations. This keeps
 * the top of the screen clean and the brand color consistent.
 *
 * Hidden on /account, /auth-action, /review, /revisions, /deliveries —
 * those have their own chrome (see per-route guards below).
 */
const NAV_LINKS = [
  { to: '/revisions', label: 'סבבי תיקונים' },
  { to: '/deliveries', label: 'מסירה ללקוח' },
  { to: '/account', label: 'החשבון שלי' },
]

export function SiteHeader() {
  const location = useLocation()
  const [open, setOpen] = useState(false)

  if (location.pathname.startsWith('/account')) return null
  if (location.pathname.startsWith('/auth-action')) return null
  if (location.pathname.startsWith('/review')) return null
  if (location.pathname.startsWith('/revisions')) return null
  if (location.pathname.startsWith('/deliveries')) return null

  // Per-route alignment — match the page's content rail so the cluster
  // lines up under the same column as the rest of the chrome.
  const isBuyPage = location.pathname === '/buy'
  const widthClass = isBuyPage ? 'max-w-3xl' : 'max-w-6xl'
  // Homepage: vertically center the menu with the Hero brand icon
  // (h-10 sitting at pt-16). /buy: align with the page's back-link.
  const topClass = isBuyPage ? 'top-12 md:top-20' : 'top-16 md:top-[5.5rem]'

  return (
    <>
      <div className={`pointer-events-none absolute inset-x-0 z-10 ${topClass}`}>
        <div className={`mx-auto px-5 md:px-6 ${widthClass}`}>
          <div className="text-left">
            {/* ── MOBILE: bare three-line menu icon (no box), in the
                brand copper, sized + positioned to mirror the Hero
                logo on the opposite edge. ── */}
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="פתח תפריט"
              className="pointer-events-auto -ml-1.5 inline-flex h-10 w-10 items-center justify-center text-primary transition-transform active:scale-90 md:hidden"
            >
              <Menu className="h-6 w-6" strokeWidth={2.25} />
            </button>

            {/* ── DESKTOP: inline editorial links ── */}
            <div className="hidden md:block">
              <Link
                to="/revisions"
                className="pointer-events-auto text-sm text-fg-muted transition-colors hover:text-fg"
              >
                סבבי תיקונים
              </Link>
              <span aria-hidden="true" className="select-none px-3 text-fg-muted/40">
                ·
              </span>
              <Link
                to="/deliveries"
                className="pointer-events-auto text-sm text-fg-muted transition-colors hover:text-fg"
              >
                מסירה ללקוח
              </Link>
              <span aria-hidden="true" className="select-none px-3 text-fg-muted/40">
                ·
              </span>
              <Link
                to="/account"
                className="pointer-events-auto text-sm text-fg-muted transition-colors hover:text-fg"
              >
                החשבון שלי
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* ── MOBILE side drawer ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            // The whole overlay (backdrop dim + blur) fades 0→1 over
            // ~0.35s — the same window the panel takes to slide in — so
            // the rest of the site blurs PROGRESSIVELY as the drawer
            // enters, instead of snapping to full blur after it lands.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            dir="rtl"
            className="fixed inset-0 z-50 md:hidden"
          >
            {/* Backdrop */}
            <button
              type="button"
              aria-label="סגור תפריט"
              onClick={() => setOpen(false)}
              className="absolute inset-0 h-full w-full bg-black/60 backdrop-blur-sm"
            />
            {/* Panel — slides in from the RIGHT (RTL convention). */}
            <motion.nav
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
              className="absolute right-0 top-0 flex h-full w-64 max-w-[78%] flex-col border-l border-border bg-bg-elevated p-5 shadow-2xl"
            >
              <div className="mb-6 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-fg-muted">
                  תפריט
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="סגור"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-bg hover:text-fg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {NAV_LINKS.map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-3 text-base font-medium text-fg transition-colors hover:bg-primary/10 hover:text-primary"
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
