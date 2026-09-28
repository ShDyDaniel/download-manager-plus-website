import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { SiteFooter, SiteHeader } from './SiteChrome'

/**
 * Frame of every redesigned page: the `.fl` root (tokens + components from
 * src/styles/fl.css), header, main, footer.
 *
 *   chrome="full" — header with the menus + footer (marketing pages)
 *   chrome="min"  — logo bar only (pages opened from a link or from the app:
 *                   install, trial, auth-action, support pages, partner…)
 *
 * `name` gives the page its own scope class (.pg-<name>) for its CSS in
 * src/styles/pages/<name>.css.
 */
export function FlPage({
  name,
  chrome = 'full',
  title,
  children,
}: {
  name: string
  chrome?: 'full' | 'min'
  /** Document title (without the site name). */
  title?: string
  children: React.ReactNode
}) {
  const location = useLocation()
  useEffect(() => {
    if (title) document.title = `${title} · פריימליין`
    return () => {
      document.title = 'פריימליין · תוכנה ליוצרי תוכן ועורכי וידאו'
    }
  }, [title])
  // Links like /#features land on the section, below the sticky header.
  useEffect(() => {
    if (!location.hash) return
    const id = decodeURIComponent(location.hash.slice(1))
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 60)
    return () => window.clearTimeout(t)
  }, [location.hash, location.pathname])

  return (
    <div className="fl" data-chrome={chrome}>
      <a className="skip" href="#main">
        דילוג לתוכן
      </a>
      <SiteHeader chrome={chrome} />
      <main id="main">
        <div className={`page pg-${name}`}>{children}</div>
      </main>
      {chrome === 'full' && <SiteFooter />}
    </div>
  )
}
