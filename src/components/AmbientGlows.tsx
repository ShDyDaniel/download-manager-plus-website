/**
 * AmbientGlows — a global, fixed, non-interactive layer of soft warm
 * radial "light" blobs scattered across the viewport. Rendered once at
 * the app root so EVERY route (home, /buy, /account, /revisions,
 * /admin, /partner …) gets the same atmosphere the home hero has,
 * instead of a flat static background.
 *
 * Implementation notes:
 *  - `fixed inset-0` + `-z-10` puts it above the page background colour
 *    but behind all content (which sits at the default z-index).
 *  - `pointer-events-none` so it never intercepts clicks.
 *  - Each blob is a radial-gradient (cheap to paint, no blur filter)
 *    at a low opacity so text stays perfectly readable on top.
 */
export function AmbientGlows() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* Top-centre — the bright one the rest of the site echoes. */}
      <div
        className="absolute"
        style={{
          top: '-18%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '75vw',
          height: '60vh',
          background:
            'radial-gradient(ellipse at center, rgba(184,121,79,0.18) 0%, transparent 70%)',
        }}
      />
      {/* Upper-right accent. */}
      <div
        className="absolute"
        style={{
          top: '8%',
          right: '-12%',
          width: '48vw',
          height: '48vh',
          background:
            'radial-gradient(ellipse at center, rgba(212,165,116,0.12) 0%, transparent 70%)',
        }}
      />
      {/* Mid-left accent. */}
      <div
        className="absolute"
        style={{
          top: '42%',
          left: '-14%',
          width: '48vw',
          height: '50vh',
          background:
            'radial-gradient(ellipse at center, rgba(184,121,79,0.11) 0%, transparent 70%)',
        }}
      />
      {/* Lower-centre/right accent so long pages keep some glow below. */}
      <div
        className="absolute"
        style={{
          bottom: '-18%',
          left: '45%',
          transform: 'translateX(-50%)',
          width: '60vw',
          height: '50vh',
          background:
            'radial-gradient(ellipse at center, rgba(212,165,116,0.10) 0%, transparent 70%)',
        }}
      />
    </div>
  )
}
