import { Link, useLocation } from 'react-router-dom'

/**
 * Editorial top-left "החשבון שלי" link.
 *
 * Visual treatment: deliberately plain text — no border, no
 * background, no chip. The marketing page's voice is editorial
 * (subtle wordmark, em-dash labels, "איך זה עובד" scroll cue) and
 * a bordered pill would have read like a banner ad in that
 * context. The link adopts the same `text-fg-muted → text-fg`
 * hover treatment as the in-page scroll cue so all secondary
 * affordances feel like one family.
 *
 * Position: `absolute` (NOT `fixed`) so the link scrolls away with
 * the hero. The user explicitly didn't want a persistent corner
 * link — the marketing site is meant to be read top-to-bottom and
 * a sticky element competes with that reading rhythm. For deep
 * pages (/buy, /account) where the user has already committed to
 * a flow, the link being absent is the right call.
 *
 * Hidden on /account because the destination IS /account — no
 * reason to surface a "go there" affordance to someone already
 * there. startsWith match catches future sub-routes too.
 *
 * Positioning notes:
 *   - top-5 / md:top-6 mirrors the in-Hero brand wordmark spacing,
 *     so wordmark and account link sit at the same y-axis.
 *   - left-5 / md:left-6 in RTL = visual LEFT, opposite the
 *     wordmark on visual RIGHT. The two anchor the top corners
 *     editorial-style.
 *   - z-10 lifts above the hero ambient glow (no z-index, defaults
 *     to 0) but stays below any modal/popover that may open
 *     (z-30+).
 */
export function SiteHeader() {
  const location = useLocation()
  if (location.pathname.startsWith('/account')) return null

  return (
    <Link
      to="/account"
      className="absolute top-5 left-5 z-10 text-sm text-fg-muted transition-colors hover:text-fg md:top-6 md:left-6"
    >
      החשבון שלי
    </Link>
  )
}
