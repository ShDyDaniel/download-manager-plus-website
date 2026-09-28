import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

/**
 * Small pieces shared by the feature landing pages (/sync, /collab, /glossary).
 * Their styles live in each page's own CSS (.pg-sync / .pg-collab /
 * .pg-glossary), which all carry the same "common" block from the prototype.
 */

/** Props for a decorative icon inside a button or a line of text. */
export const IC = { className: 'ic', 'aria-hidden': true } as const

export const SYSTEM_LINE = 'Mac עם שבב M1 ומעלה · Windows 10/11'

/** Smooth-scrolls to a section, stopping ~90px above it (below the sticky header). */
export function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const top = el.getBoundingClientRect().top + window.scrollY - 90
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

/** The fake macOS title bar of a demo window. */
export function WinTop({
  icon: Icon,
  title,
  extra,
}: {
  icon: LucideIcon
  title: string
  extra?: React.ReactNode
}) {
  return (
    <div className="top" aria-hidden="true">
      <i />
      <i />
      <i />
      <span className="ttl">
        <Icon {...IC} />
        {title}
        {extra}
      </span>
    </div>
  )
}

/** Closing call to action: title, one line, the download button + prices. */
export function LandingCta({
  title,
  text,
  primary,
}: {
  title: string
  text: string
  primary: React.ReactNode
}) {
  return (
    <div className="wrap">
      <div className="cta">
        <h2 className="h2">{title}</h2>
        <p className="lead">{text}</p>
        <div className="actions">
          {primary}
          <Link className="btn btn-s btn-lg" to="/buy">
            המחירים
          </Link>
        </div>
        <div className="fine">{SYSTEM_LINE}</div>
      </div>
    </div>
  )
}
