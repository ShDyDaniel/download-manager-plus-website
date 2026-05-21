import { Link, useLocation } from 'react-router-dom'
import { UserCircle } from 'lucide-react'

/**
 * Site-wide top-left account link.
 *
 * Rendered above all routes from App.tsx so visitors always have
 * a one-click path to their subscription dashboard (which doubles
 * as the sign-in form when they're not logged in). Hidden on
 * /account itself — surfacing a "go to /account" link while the
 * user is already on /account would just be visual noise.
 *
 * Positioning: `fixed` to the visual top-left (in RTL = LTR-left),
 * deliberately on the opposite side of the in-Hero brand wordmark
 * which sits on the visual top-right. The two anchor the corners
 * of the page and read as a minimal nav without our needing a
 * full chrome bar.
 *
 * Why not a real navbar: the marketing site has no other nav items
 * (no /about, /pricing, /blog). A full bar with one link would feel
 * empty; a corner link feels intentional and editorial.
 *
 * Z-index 30 chosen to sit above hero ambient glows and product
 * mockup (z = 0-10) but BELOW any modal or popover that may open
 * from inside a page (the download-picker popover uses z-30 too,
 * but it stays right-aligned under its trigger so the two never
 * visually clash).
 */
export function SiteHeader() {
  const location = useLocation()
  // Hide on /account — the user is already there. Using startsWith
  // so any future sub-routes like /account/settings still hide it.
  if (location.pathname.startsWith('/account')) return null

  return (
    <div className="fixed top-4 left-4 z-30 md:top-6 md:left-6">
      <Link
        to="/account"
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-card/70 px-3.5 py-2 text-xs font-medium text-fg-secondary backdrop-blur transition-all hover:border-primary/60 hover:bg-bg-card/90 hover:text-fg hover:shadow-lg hover:shadow-primary/10 md:text-sm"
      >
        <UserCircle className="h-4 w-4" />
        <span>החשבון שלי</span>
      </Link>
    </div>
  )
}
