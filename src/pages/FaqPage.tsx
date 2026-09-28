import '../styles/pages/faq.css'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { MessageCircle } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { FAQ_ITEMS } from '../components/FAQ'

/**
 * /faq — the site's questions and answers (the same list as the FAQ
 * component, src/components/FAQ.tsx), grouped by topic with jump chips,
 * and a "didn't find an answer?" card at the end.
 */

// Topic groups: indexes into FAQ_ITEMS. A question that isn't listed
// (e.g. one added later) is shown under the last group, so nothing is
// ever dropped.
const GROUPS: { id: string; title: string; items: number[] }[] = [
  { id: 'faq-app', title: 'התוכנה', items: [0, 6, 7] },
  { id: 'faq-files', title: 'סידור ההורדות', items: [2, 3] },
  { id: 'faq-account', title: 'מנוי, חשבון ונתונים', items: [1, 5, 4] },
]

function groupsWithAll() {
  const seen = new Set<number>()
  const groups = GROUPS.map((g) => {
    const items = g.items.filter((i) => i < FAQ_ITEMS.length && !seen.has(i))
    items.forEach((i) => seen.add(i))
    return { ...g, items }
  })
  const rest = FAQ_ITEMS.map((_, i) => i).filter((i) => !seen.has(i))
  groups[groups.length - 1].items.push(...rest)
  return groups.filter((g) => g.items.length > 0)
}

// Plain-text mentions in the answers that become links (the words
// themselves don't change).
const LINKS: { words: string; to: string }[] = [
  { words: 'דף הרכישה', to: '/buy' },
  { words: 'איזור האישי באתר', to: '/account' },
]

function answer(text: string): ReactNode {
  let parts: ReactNode[] = [text]
  for (const { words, to } of LINKS) {
    parts = parts.flatMap((p): ReactNode[] => {
      if (typeof p !== 'string' || !p.includes(words)) return [p]
      const [before, ...after] = p.split(words)
      return [
        before,
        <Link key={to} className="link" to={to}>
          {words}
        </Link>,
        after.join(words),
      ]
    })
  }
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)
}

export default function FaqPage() {
  const groups = groupsWithAll()
  return (
    <FlPage name="faq" title="שאלות נפוצות">
      <div className="narrow">
        <header className="phero">
          <span className="eyebrow">שאלות נפוצות</span>
          <h1 className="display">עוד משהו שתרצו לדעת?</h1>
          <nav className="jump" aria-label="נושאים">
            {groups.map((g) => (
              <a key={g.id} href={`#${g.id}`}>
                {g.title}
                <span className="num">{g.items.length}</span>
              </a>
            ))}
          </nav>
        </header>

        {groups.map((g) => (
          <section key={g.id} className="grp" id={g.id} aria-labelledby={`${g.id}-h`}>
            <h2 className="gh" id={`${g.id}-h`}>
              {g.title}
            </h2>
            <div className="acc">
              {g.items.map((i) => (
                // Native accordion; the shared name keeps one answer open
                // at a time. All closed on arrival.
                <details key={FAQ_ITEMS[i].q} name="faq">
                  <summary>{FAQ_ITEMS[i].q}</summary>
                  <div className="body">
                    <p>{answer(FAQ_ITEMS[i].a)}</p>
                  </div>
                </details>
              ))}
            </div>
          </section>
        ))}

        <div className="card ask">
          <span className="ai">
            <MessageCircle className="ic" aria-hidden />
          </span>
          <div className="tx">
            <h2 className="h3">לא מצאתם תשובה?</h2>
            <p className="muted">
              כתבו לנו בטופס יצירת הקשר או במייל{' '}
              <bdi>
                <a className="link" href="mailto:help.frameline@gmail.com">
                  help.frameline@gmail.com
                </a>
              </bdi>
            </p>
          </div>
          <Link className="btn btn-p" to="/contact">
            צור קשר
          </Link>
        </div>
      </div>
    </FlPage>
  )
}
