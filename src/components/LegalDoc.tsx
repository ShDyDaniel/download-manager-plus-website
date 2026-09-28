import { Fragment, type MouseEvent } from 'react'
import { AlertCircle, Loader2, RotateCcw } from 'lucide-react'
import {
  splitInline,
  type LegalBlock,
  type LegalItem,
  type LegalSection,
} from './legalText'
import '../styles/legal-doc.css'

/* Rendering of a laid-out legal document (see legalText.ts) in the
 * redesign's `.doc` look. Used by the /terms, /privacy and
 * /accessibility pages and by the Terms / Privacy modals. Must render
 * inside a `.fl … .ldoc` element (styles: src/styles/legal-doc.css). */

type Heading = 'h2' | 'h3'

/** Text with e-mail addresses as mailto links and domains isolated
 *  left-to-right. The characters are the stored text, unchanged. */
export function LegalInline({ text }: { text: string }) {
  return (
    <>
      {splitInline(text).map((p, i) =>
        p.k === 'text' ? (
          <Fragment key={i}>{p.v}</Fragment>
        ) : p.k === 'email' ? (
          <bdi key={i}>
            <a className="link" href={`mailto:${p.v}`}>
              {p.v}
            </a>
          </bdi>
        ) : (
          <bdi key={i}>{p.v}</bdi>
        ),
      )}
    </>
  )
}

function Item({ it }: { it: LegalItem }) {
  if (it.term === undefined)
    return (
      <li>
        <LegalInline text={it.text} />
      </li>
    )
  return (
    <li>
      <b>
        <LegalInline text={it.term} />
      </b>
      {it.sep}
      <LegalInline text={it.text} />
    </li>
  )
}

export function LegalBlocks({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.t === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <Item key={j} it={it} />
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.label !== undefined && (
              <>
                <b>
                  <LegalInline text={b.label} />:
                </b>{' '}
              </>
            )}
            <LegalInline text={b.text} />
          </p>
        ),
      )}
    </>
  )
}

/** The sections, each with its (optional) number badge and anchor. */
export function LegalArticle({
  sections,
  heading = 'h2',
}: {
  sections: LegalSection[]
  heading?: Heading
}) {
  const H = heading
  return (
    <article className="doc">
      {sections.map((s) => (
        <section key={s.id} className="sec-d" aria-labelledby={s.id}>
          <H id={s.id} className="sec-h">
            {s.num && <span className="n num">{s.num}</span>}
            <span>{s.title}</span>
          </H>
          <LegalBlocks blocks={s.blocks} />
        </section>
      ))}
    </article>
  )
}

/** Table of contents. On a page the links are plain in-page anchors;
 *  in a modal pass `onJump` (scrolls inside the modal, leaves the URL
 *  alone) and `collapsible` (starts closed). */
export function LegalToc({
  sections,
  heading = 'h2',
  onJump,
  collapsible = false,
}: {
  sections: LegalSection[]
  heading?: Heading
  onJump?: (id: string) => void
  collapsible?: boolean
}) {
  const H = heading
  const list = (
    <ol>
      {sections.map((s) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            onClick={
              onJump
                ? (e: MouseEvent) => {
                    e.preventDefault()
                    onJump(s.id)
                  }
                : undefined
            }
          >
            <span className="n num">{s.num}</span>
            <span>{s.title}</span>
          </a>
        </li>
      ))}
    </ol>
  )
  if (collapsible)
    return (
      <details className="card flat toc">
        <summary>תוכן העניינים</summary>
        {list}
      </details>
    )
  return (
    <nav className="card flat toc" aria-label="תוכן העניינים">
      <H className="toc-t">תוכן העניינים</H>
      {list}
    </nav>
  )
}

export function LegalLoading({ label = 'טוען…' }: { label?: string }) {
  return (
    <div className="ldoc-state" role="status" aria-live="polite">
      <Loader2 className="ic ldoc-spin" aria-hidden />
      {label}
    </div>
  )
}

export function LegalError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="note err ldoc-err" role="alert">
      <AlertCircle className="ic" aria-hidden />
      <div className="tx">{message}</div>
      <button type="button" className="btn btn-s btn-sm" onClick={onRetry}>
        <RotateCcw className="ic" aria-hidden />
        נסו שוב
      </button>
    </div>
  )
}
