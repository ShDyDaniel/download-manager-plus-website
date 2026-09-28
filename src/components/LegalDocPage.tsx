import { Fragment, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronUp } from 'lucide-react'
import { FlPage } from './site/FlPage'
import { useLegalDoc, type LegalKind } from './LegalModals'
import { layoutLegalDoc } from './legalText'
import { LegalArticle, LegalError, LegalLoading, LegalToc } from './LegalDoc'

/**
 * /terms and /privacy — the LIVE document (same fetch + session cache as
 * the Terms / Privacy modals: one read per visit, nothing prefetched on
 * other pages), laid out as the approved `.doc` page: title, version +
 * last-updated line, table of contents, numbered sections, real lists
 * and bold lead-in labels. The stored text itself is shown unchanged.
 */
export function LegalDocPage({
  kind,
  pageTitle,
  heading,
  prefix,
  emptyCopy,
  others,
}: {
  kind: LegalKind
  /** Browser-tab title. */
  pageTitle: string
  /** The page's H1. */
  heading: string
  /** Anchor-id prefix ("t" → #t-1 …). */
  prefix: string
  emptyCopy: string
  /** "מסמכים נוספים" links. */
  others: { to: string; label: string }[]
}) {
  const { state, retry } = useLegalDoc(kind)
  const location = useLocation()
  const sections = useMemo(
    () => (state.kind === 'ready' ? layoutLegalDoc(state.doc.sections, prefix) : []),
    [state, prefix],
  )

  // A link straight to a section (/terms#t-7) lands before the text has
  // loaded, so scroll to it once it's there.
  useEffect(() => {
    if (state.kind !== 'ready' || !location.hash) return
    const id = decodeURIComponent(location.hash.slice(1))
    const t = window.setTimeout(
      () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }),
      80,
    )
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind])

  const meta: React.ReactNode[] = []
  if (state.kind === 'ready') {
    if (state.doc.version)
      meta.push(
        <>
          גרסה <bdi className="num">{state.doc.version}</bdi>
        </>,
      )
    if (state.doc.lastUpdated) meta.push(<>עודכן: {state.doc.lastUpdated}</>)
  }

  return (
    <FlPage name={kind} title={pageTitle}>
      <div className="narrow ldoc" id={`${prefix}-top`}>
        <header className="phero dhead">
          <span className="eyebrow">מסמך משפטי</span>
          <h1 className="display">{heading}</h1>
          <p className="meta">
            {meta.map((m, i) => (
              <Fragment key={i}>
                {i > 0 && ' · '}
                {m}
              </Fragment>
            ))}
          </p>
        </header>

        {state.kind === 'loading' && <LegalLoading />}

        {state.kind === 'error' && <LegalError message={state.message} onRetry={retry} />}

        {state.kind === 'ready' &&
          (sections.length === 0 ? (
            <p className="ldoc-empty">{emptyCopy}</p>
          ) : (
            <>
              <LegalToc sections={sections} />
              <LegalArticle sections={sections} />
            </>
          ))}

        <footer className="dfoot">
          {state.kind === 'ready' && sections.length > 0 ? (
            <a className="link top" href={`#${prefix}-top`}>
              <ChevronUp className="ic" aria-hidden />
              חזרה לראש העמוד
            </a>
          ) : (
            <span />
          )}
          <div className="actions">
            <span className="muted small">מסמכים נוספים:</span>
            {others.map((o) => (
              <Link key={o.to} className="btn btn-g btn-sm" to={o.to}>
                {o.label}
              </Link>
            ))}
          </div>
        </footer>
      </div>
    </FlPage>
  )
}
