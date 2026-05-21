import { Link, useLocation } from 'react-router-dom'

/**
 * Editorial top-left "החשבון שלי" link.
 *
 * Visual treatment: plain text — no border, no background, no chip.
 * The marketing voice is editorial (subtle wordmark on the right,
 * em-dash labels, "איך זה עובד" scroll cue), so anything chip-like
 * would have read as a banner ad. Same `text-fg-muted → text-fg`
 * hover treatment as the in-page scroll cue so all secondary
 * affordances feel like one family.
 *
 * Layout — anchored to the SAME content rail as the Hero.
 *   - Outer `absolute inset-x-0` lets the inner container span the
 *     full page width.
 *   - Inner `max-w-6xl px-5 md:px-6 mx-auto` mirrors the Hero
 *     section's container exactly, so on wide screens the link
 *     aligns with the LEFT edge of the centered content rail.
 *     Without this wrapper the link sat against the literal screen
 *     edge, which looked detached from the page on wide displays.
 *   - `text-left` forces physical-left alignment inside the RTL
 *     document, so the link anchors at the visual LEFT corner of
 *     the rail — opposite the brand wordmark which sits at the
 *     visual RIGHT corner of the same rail.
 *
 * Vertical position — chosen to center vertically with the in-Hero
 * brand wordmark:
 *   - Mobile: top-12 (48px) so the text baseline aligns with the
 *     center of the brand icon at pt-10 + h-10/2.
 *   - Desktop: top-[5.5rem] (88px) for the same alignment at
 *     pt-20 + h-10/2. Off-the-shelf Tailwind values (top-20/top-24)
 *     missed by 8-9px which read as "not quite right".
 *
 * Position is `absolute` (NOT `fixed`) so the link scrolls away
 * with the hero. The marketing site is meant to be read top-to-
 * bottom and a sticky element competes with that reading rhythm.
 *
 * Hidden on /account because the destination IS /account — no
 * reason to surface a "go there" affordance to someone already
 * there. startsWith match catches future sub-routes too.
 */
export function SiteHeader() {
  const location = useLocation()
  if (location.pathname.startsWith('/account')) return null

  return (
    <div className="absolute inset-x-0 top-12 z-10 md:top-[5.5rem]">
      <div className="mx-auto max-w-6xl px-5 md:px-6">
        <div className="text-left">
          <Link
            to="/account"
            className="text-sm text-fg-muted transition-colors hover:text-fg"
          >
            החשבון שלי
          </Link>
        </div>
      </div>
    </div>
  )
}
