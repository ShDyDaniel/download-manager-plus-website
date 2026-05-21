import { Link, useLocation } from 'react-router-dom'

/**
 * Editorial top-left "החשבון שלי" link.
 *
 * Visual treatment: plain text — no border, no background, no chip.
 * The marketing voice is editorial (subtle wordmark, em-dash
 * labels, "איך זה עובד" scroll cue), so anything chip-like would
 * have read as a banner ad. Same `text-fg-muted → text-fg` hover
 * treatment as the in-page scroll cue so all secondary affordances
 * feel like one family.
 *
 * Layout — anchored to whichever content rail this route uses, so
 * the link always sits at the visual LEFT edge of the same column
 * as the page's other top-level chrome:
 *   - `/`     → Hero is centered inside max-w-6xl. Link aligns
 *               with the LEFT edge of that rail, opposite the
 *               brand wordmark on the RIGHT edge.
 *   - `/buy`  → BuyPage content is centered inside max-w-3xl. Link
 *               aligns with the LEFT edge of that narrower rail,
 *               opposite the "חזרה לדף הבית" back-link on the
 *               RIGHT edge.
 *
 * Without this per-route width the link sat against the edge of
 * the wider 6xl rail even on /buy where the actual content lives
 * inside 3xl — it looked detached, like a stray UI element.
 *
 * Vertical position also matches each page's top content y:
 *   - `/`     → top-12 / md:top-[5.5rem] centers with the Hero
 *               brand icon (pt-10/pt-20 + h-10/2).
 *   - `/buy`  → top-12 / md:top-20 matches the BuyPage's
 *               py-12/py-20 — same y as the back-to-home link.
 *
 * Position is `absolute` (NOT `fixed`) so the link scrolls away
 * with the page content. The marketing site is meant to be read
 * top-to-bottom; a sticky corner element would compete with that
 * reading rhythm.
 *
 * Hidden on /account because the destination IS /account. The
 * startsWith match also catches any future sub-routes like
 * /account/settings.
 */
export function SiteHeader() {
  const location = useLocation()
  // Hide on /account (the link's destination) and on /auth-action
  // (the user is mid-flow on a password reset — surfacing a "go to
  // account" link there would be distracting).
  if (location.pathname.startsWith('/account')) return null
  if (location.pathname.startsWith('/auth-action')) return null

  // Per-route alignment. If we add more pages later (e.g. /pricing,
  // /docs), extend this conditional with their max-width and top
  // offset. Keeping it inline rather than a config map because
  // there are only two destinations today and a switch reads more
  // naturally at this scale.
  const isBuyPage = location.pathname === '/buy'
  const widthClass = isBuyPage ? 'max-w-3xl' : 'max-w-6xl'
  const topClass = isBuyPage ? 'top-12 md:top-20' : 'top-12 md:top-[5.5rem]'

  return (
    // pointer-events-none on the wrapper so the invisible full-width
    // div doesn't intercept clicks on whatever sits below it. The
    // wrapper IS full-width (inset-x-0) so the inner max-w container
    // can center on wide screens, but that means without this guard
    // the wrapper's transparent area was eating clicks on the
    // /buy "חזרה לדף הבית" back-link that lives at the same
    // y-position on the opposite side of the rail.
    //
    // The Link itself opts back into pointer-events so it stays
    // clickable — only the empty space around it passes clicks
    // through to the page beneath.
    <div className={`pointer-events-none absolute inset-x-0 z-10 ${topClass}`}>
      <div className={`mx-auto px-5 md:px-6 ${widthClass}`}>
        <div className="text-left">
          <Link
            to="/account"
            className="pointer-events-auto text-sm text-fg-muted transition-colors hover:text-fg"
          >
            החשבון שלי
          </Link>
        </div>
      </div>
    </div>
  )
}
