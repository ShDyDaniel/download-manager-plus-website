import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { FlPage } from '../components/site/FlPage'
import { useDownload } from '../components/site/DownloadGate'
import { HERO_MARK_SVG, SKETCHES, STATIONS } from '../components/site/homeArt'

/**
 * Home page (approved design "D"): animated logo hero, the work stations as a
 * bento of cards — each with a small, honest sketch of the real app screen —
 * and a closing call to action. Styles: .pg-home in src/styles/fl.css.
 */

// The line under the hero title. Empty = not shown (the buttons move up to the
// title). Put text here to bring a description back.
const HERO_SUB = ''

// Card order and widths: three small cards, then transcription + work time
// stacked beside the tall revisions card, then delivery as a wide strip.
const LAYOUT: { kind: string; cls: string }[] = [
  { kind: 'quote', cls: 'w2' },
  { kind: 'files', cls: 'w2' },
  { kind: 'sync', cls: 'w2' },
  { kind: 'subs', cls: 'w3' },
  { kind: 'review', cls: 'w3 tall' },
  { kind: 'time', cls: 'w3' },
  { kind: 'deliver', cls: 'w6' },
]

export function HomePage() {
  const { requestDownload } = useDownload()
  const root = useRef<HTMLDivElement>(null)
  const byKind = Object.fromEntries(STATIONS.map((s) => [s.kind, s]))

  // The work-time sketch's clock ticks once a second, like the app's.
  useEffect(() => {
    const els = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-tick]') ?? [])
    const secs = els.map((el) => Number(el.dataset.tick) || 0)
    const id = window.setInterval(() => {
      els.forEach((el, i) => {
        const s = ++secs[i]
        el.textContent = `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <FlPage name="home">
      <div className="wrap" ref={root}>
        <div className="hero">
          <div aria-hidden dangerouslySetInnerHTML={{ __html: HERO_MARK_SVG }} />
          <h1 className={HERO_SUB ? undefined : 'solo'}>
            כל מה שמסביב לעריכה
            <br />
            בתוכנה אחת
          </h1>
          {HERO_SUB && <p className="sub">{HERO_SUB}</p>}
          <button type="button" className="btn p" onClick={() => requestDownload()}>
            הורדה חינם
          </button>{' '}
          <Link className="btn s" to="/buy">
            המחירים
          </Link>
          <div className="fine">שבעה ימי ניסיון חינם, בלי כרטיס אשראי · Mac עם שבב M1 ומעלה · Windows 10/11</div>
        </div>

        <section id="features">
          <h2>כל שלב בעבודה, כלי אחד</h2>
          <div className="bento">
            {LAYOUT.map(({ kind, cls }) => (
              <div key={kind} className={`cell ${cls}`}>
                <h3>{byKind[kind].title}</h3>
                <p>{byKind[kind].text}</p>
                <div className="sketch" dangerouslySetInnerHTML={{ __html: SKETCHES[kind] }} />
              </div>
            ))}
          </div>
        </section>

        <div className="cta">
          <h2>נסו שבוע, בחינם</h2>
          <button type="button" className="btn p" onClick={() => requestDownload()}>
            הורדה חינם
          </button>
          <div className="fine">בלי כרטיס אשראי</div>
        </div>
      </div>
    </FlPage>
  )
}
