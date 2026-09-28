import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import {
  AudioLines,
  BookOpen,
  ChevronDown,
  Download,
  Menu,
  PanelsTopLeft,
  PenLine,
  User,
  X,
} from 'lucide-react'
import { useDownload } from './DownloadGate'

/**
 * Header, mobile drawer and footer of the redesigned site (styles in
 * src/styles/fl.css, scoped under .fl). Rendered by <FlPage>.
 */

const FEATURES = [
  { to: '/#features', icon: PanelsTopLeft, title: 'כל הכלים', text: 'הצעת מחיר, הורדות, תמלול, זמן עבודה ועוד' },
  { to: '/sync', icon: AudioLines, title: 'סנכרון אוטומטי', text: 'מצלמות ומיקרופונים מסונכרנים לפי הסאונד' },
  { to: '/collab', icon: PenLine, title: 'סבבי תיקונים ומסירה', text: 'הלקוח מעיר בדפדפן ומקבל את הסרטון הסופי' },
  { to: '/glossary', icon: BookOpen, title: 'חבילות מונחים לתמלול', text: 'מילים מקצועיות שהתמלול מכיר מראש' },
]
const ACCOUNT = [
  { to: '/account', label: 'החשבון שלי' },
  { to: '/revisions', label: 'סבבי תיקונים' },
  { to: '/deliveries', label: 'מסירה ללקוח' },
]
const MARK = '/logo-mark.svg?v=1'

/** A dropdown in the header: opens on click, closes on outside click / Escape / navigation. */
function Dropdown({
  label,
  className = '',
  buttonClass,
  menuClass,
  children,
}: {
  label: React.ReactNode
  className?: string
  buttonClass?: string
  menuClass: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const location = useLocation()
  useEffect(() => setOpen(false), [location.pathname, location.hash])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className={`dd ${className}${open ? ' open' : ''}`}>
      <button type="button" className={buttonClass} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
        <ChevronDown className="ic" aria-hidden />
      </button>
      <div className={menuClass} onClick={() => setOpen(false)}>
        {children}
      </div>
    </div>
  )
}

export function SiteHeader({ chrome, hideDownload = false }: { chrome: 'full' | 'min'; hideDownload?: boolean }) {
  const { requestDownload } = useDownload()
  const [scrolled, setScrolled] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  useEffect(() => setDrawer(false), [location.pathname, location.hash])
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])

  const brand = (
    <Link className="brand" to="/">
      <img src={MARK} alt="" width={30} height={30} />
      פריימליין
    </Link>
  )

  return (
    <>
      <header className={`site-h${scrolled ? ' scrolled' : ''}`}>
        <div className="wrap in">
          {brand}
          {chrome === 'full' && (
            <>
              <nav className="mainnav" aria-label="ראשי">
                <Dropdown label="תכונות" menuClass="menu">
                  {FEATURES.map(({ to, icon: Icon, title, text }) => (
                    <Link key={to} to={to}>
                      <span className="mi">
                        <Icon className="ic" aria-hidden />
                      </span>
                      <span>
                        <b>{title}</b>
                        <small>{text}</small>
                      </span>
                    </Link>
                  ))}
                </Dropdown>
                <NavLink to="/buy" className={({ isActive }) => (isActive ? 'on' : '')}>מחירים</NavLink>
                <NavLink to="/faq" className={({ isActive }) => (isActive ? 'on' : '')}>שאלות נפוצות</NavLink>
                <NavLink to="/contact" className={({ isActive }) => (isActive ? 'on' : '')}>צור קשר</NavLink>
              </nav>
              <div className="hside">
                <Dropdown
                  className="acct-dd"
                  buttonClass="acct"
                  menuClass="menu end"
                  label={
                    <>
                      <User className="ic" aria-hidden />
                      החשבון שלי
                    </>
                  }
                >
                  {ACCOUNT.map((a) => (
                    <Link key={a.to} to={a.to}>
                      {a.label}
                    </Link>
                  ))}
                </Dropdown>
                {!hideDownload && (
                  <button type="button" className="btn btn-p btn-sm" onClick={() => requestDownload()}>
                    <Download className="ic" aria-hidden />
                    הורדה חינם
                  </button>
                )}
              </div>
              <button type="button" className="burger" aria-label="פתיחת התפריט" onClick={() => setDrawer(true)}>
                <Menu className="ic" aria-hidden />
              </button>
            </>
          )}
        </div>
      </header>

      {chrome === 'full' && drawer && (
        <div className="drawer open">
          <button type="button" className="scrim" aria-label="סגירת התפריט" onClick={() => setDrawer(false)} />
          <nav aria-label="תפריט">
            <div className="top">
              {brand}
              <button type="button" className="x" aria-label="סגירה" onClick={() => setDrawer(false)}>
                <X className="ic" aria-hidden />
              </button>
            </div>
            <Link to="/">דף הבית</Link>
            <Link to="/buy">מחירים</Link>
            <Link to="/faq">שאלות נפוצות</Link>
            <Link to="/contact">צור קשר</Link>
            <h6>תכונות</h6>
            {FEATURES.map((f) => (
              <Link key={f.to} to={f.to}>
                {f.title}
              </Link>
            ))}
            <h6>החשבון שלי</h6>
            {ACCOUNT.map((a) => (
              <Link key={a.to} to={a.to}>
                {a.label}
              </Link>
            ))}
            {!hideDownload && (
              <button
                type="button"
                className="btn btn-p btn-block"
                onClick={() => {
                  setDrawer(false)
                  requestDownload()
                }}
              >
                <Download className="ic" aria-hidden />
                הורדה חינם
              </button>
            )}
          </nav>
        </div>
      )}
    </>
  )
}

export function SiteFooter() {
  const year = new Date().getFullYear()
  const { requestDownload } = useDownload()
  const col = (title: string, links: { to: string; label: string }[], extra?: React.ReactNode) => (
    <div>
      <h6>{title}</h6>
      <ul>
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to}>{l.label}</Link>
          </li>
        ))}
        {extra}
      </ul>
    </div>
  )
  return (
    <footer className="site-f">
      <div className="wrap">
        <div className="cols">
          <div className="about">
            <Link className="brand" to="/">
              <img src={MARK} alt="" width={30} height={30} />
              פריימליין
            </Link>
            <p>כלי לעורכי וידאו ויוצרי תוכן. בעברית, על Mac ועל Windows.</p>
          </div>
          {col(
            'המוצר',
            [
              { to: '/#features', label: 'כל הכלים' },
              { to: '/sync', label: 'סנכרון אוטומטי' },
              { to: '/collab', label: 'סבבי תיקונים ומסירה' },
              { to: '/glossary', label: 'חבילות מונחים' },
              { to: '/buy', label: 'מחירים' },
            ],
            <li>
              <a
                href="/install"
                onClick={(e) => {
                  e.preventDefault()
                  requestDownload()
                }}
              >
                הורדה
              </a>
            </li>,
          )}
          {col('עזרה', [
            { to: '/faq', label: 'שאלות נפוצות' },
            { to: '/contact', label: 'צור קשר' },
            { to: '/partner', label: 'תוכנית שותפים' },
          ])}
          {col('החשבון', ACCOUNT)}
        </div>
        {/* Israeli consumer-protection law sec. 14ט(א): a visible subscription-
            cancellation link on every public page. Keep "ביטול מנוי" here (it
            leads to /account, where cancelling happens) — or replace it with an
            equally visible one before removing it. */}
        <div className="meta">
          <nav aria-label="מידע משפטי">
            <Link to="/terms">תנאי שימוש</Link>
            <Link to="/privacy">מדיניות פרטיות</Link>
            <Link to="/accessibility">הצהרת נגישות</Link>
            <Link className="cancel" to="/account">ביטול מנוי</Link>
          </nav>
          <span>
            © <bdi className="num">{year}</bdi> פריימליין ·{' '}
            <a href="mailto:help.frameline@gmail.com" className="link">
              help.frameline@gmail.com
            </a>
          </span>
        </div>
      </div>
    </footer>
  )
}
