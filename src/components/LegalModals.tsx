import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { layoutLegalDoc } from './legalText'
import {
  LegalArticle,
  LegalError,
  LegalLoading,
  LegalToc,
} from './LegalDoc'

/* ──────────────────────────────────────────────────────────────
 *  Terms / Privacy modals — fetched on-demand from the database.
 *
 *  Both docs live in Firestore (appConfig/terms + appConfig/privacy,
 *  edited via the admin panel) and are served through
 *  /api/paypal?action=get-terms / get-privacy.
 *
 *  Fetch policy: lazy. The modal fires its network call only when it
 *  mounts (i.e. when the user actually clicks the link), so footer
 *  links cost ZERO reads until someone opens them. A module-level
 *  cache means a second open in the same session reuses the first
 *  fetch — no duplicate reads.
 *
 *  `prefetchLegalDocs()` / `usePrefetchLegalDocs()` are an OPT-IN
 *  warm-up for places where opening a legal modal is highly likely
 *  (the signup form), so the modal renders instantly with no spinner.
 *  Do NOT call them from always-mounted chrome like the footer —
 *  that would defeat the lazy policy and read the docs on every page
 *  load for everyone.
 * ────────────────────────────────────────────────────────────── */

export interface TermsSection {
  title: string
  paragraphs: string[]
}
export interface TermsDoc {
  version: number
  lastUpdated: string
  sections: TermsSection[]
}

export type LegalKind = 'terms' | 'privacy'
type LegalCacheEntry =
  | { kind: 'loading'; promise: Promise<TermsDoc> }
  | { kind: 'ready'; doc: TermsDoc }
  | { kind: 'error'; message: string }
const legalDocCache: Partial<Record<LegalKind, LegalCacheEntry>> = {}

/** Kick off a fetch for the given legal doc. Safe to call
 *  repeatedly — concurrent calls share the in-flight promise, a loaded
 *  doc is reused (one read per visit), and a failed load is retried.
 *  Also used by the /terms and /privacy pages. */
export function loadLegalDoc(kind: LegalKind): Promise<TermsDoc> {
  const existing = legalDocCache[kind]
  if (existing && existing.kind === 'ready') return Promise.resolve(existing.doc)
  if (existing && existing.kind === 'loading') return existing.promise
  const action = kind === 'terms' ? 'get-terms' : 'get-privacy'
  const promise = (async () => {
    try {
      const r = await fetch('/api/paypal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = (await r.json()) as
        | (TermsDoc & { ok: true })
        | { ok: false; error: string }
      if (!data.ok) {
        legalDocCache[kind] = { kind: 'error', message: data.error }
        throw new Error(data.error)
      }
      const doc: TermsDoc = {
        version: data.version,
        lastUpdated: data.lastUpdated,
        sections: data.sections,
      }
      legalDocCache[kind] = { kind: 'ready', doc }
      return doc
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'בעיית רשת. נסו שוב.'
      legalDocCache[kind] = { kind: 'error', message }
      throw err
    }
  })()
  legalDocCache[kind] = { kind: 'loading', promise }
  return promise
}

/** Imperative prefetch — fire both legal-doc fetches now (idempotent;
 *  shares any in-flight promise). Call this the moment a legal modal
 *  becomes likely (e.g. a signup modal opening) so the docs are warm
 *  in the cache and the modal renders instantly with no spinner. */
export function prefetchLegalDocs(): void {
  void loadLegalDoc('terms').catch(() => undefined)
  void loadLegalDoc('privacy').catch(() => undefined)
}

/** Prefetch hook — call from any component that's likely a
 *  precursor to opening one of the legal modals (currently
 *  SignupDetailsForm). Fires both fetches in parallel; doesn't
 *  re-fetch if the cache already has them. */
export function usePrefetchLegalDocs(): void {
  useEffect(() => {
    void loadLegalDoc('terms').catch(() => undefined)
    void loadLegalDoc('privacy').catch(() => undefined)
  }, [])
}


export type LegalDocState =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: TermsDoc }
  | { kind: 'error'; message: string }

/** Errors are shown to the user in Hebrew only: the server's own
 *  messages are Hebrew; anything else (a browser "Failed to fetch",
 *  a JSON parse error…) becomes a generic Hebrew network message. */
function hebrewErrorMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : ''
  return /[֐-׿]/.test(m) ? m : 'בעיית רשת. נסו שוב בעוד רגע.'
}

/** The legal doc for a page or modal: served from the module cache
 *  when it's already loaded, otherwise fetched once on mount.
 *  `retry()` fetches again after an error. */
export function useLegalDoc(kind: LegalKind): {
  state: LegalDocState
  retry: () => void
} {
  const [state, setState] = useState<LegalDocState>(() => {
    const cached = legalDocCache[kind]
    return cached && cached.kind === 'ready'
      ? { kind: 'ready', doc: cached.doc }
      : { kind: 'loading' }
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const cached = legalDocCache[kind]
    if (cached && cached.kind === 'ready') {
      setState({ kind: 'ready', doc: cached.doc })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    void loadLegalDoc(kind)
      .then((doc) => {
        if (!cancelled) setState({ kind: 'ready', doc })
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: 'error', message: hebrewErrorMessage(err) })
      })
    return () => {
      cancelled = true
    }
  }, [kind, attempt])

  return { state, retry: () => setAttempt((a) => a + 1) }
}

/* Shared chrome for both modals — identical backdrop, close button,
 * Esc/click-outside behaviour and section rendering. Only the title,
 * endpoint and empty-state copy differ. Rendered in its own `.fl`
 * root so the redesign's styles apply on any page. */
function LegalModal({
  kind,
  title,
  emptyCopy,
  onClose,
}: {
  kind: LegalKind
  title: string
  emptyCopy: string
  onClose: () => void
}) {
  const { state, retry } = useLegalDoc(kind)
  const titleId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Anchor ids are prefixed "m…" so they never clash with the ids of
  // a /terms or /privacy page underneath.
  const sections = useMemo(
    () =>
      state.kind === 'ready'
        ? layoutLegalDoc(state.doc.sections, kind === 'terms' ? 'mt' : 'mpr')
        : [],
    [state, kind],
  )

  const jump = (id: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="fl fl-overlay">
      <div
        className="lm-back"
        dir="rtl"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="lm ldoc" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="lm-hd">
            <div>
              <h2 className="lm-t" id={titleId}>
                {title}
              </h2>
              {state.kind === 'ready' && state.doc.lastUpdated && (
                <p className="meta">עודכן: {state.doc.lastUpdated}</p>
              )}
            </div>
            <button type="button" className="lm-x" onClick={onClose} aria-label="סגור">
              <X className="ic" aria-hidden />
            </button>
          </div>

          <div className="lm-bd" ref={bodyRef}>
            {state.kind === 'loading' && <LegalLoading />}

            {state.kind === 'error' && <LegalError message={state.message} onRetry={retry} />}

            {state.kind === 'ready' &&
              (sections.length === 0 ? (
                <p className="ldoc-empty">{emptyCopy}</p>
              ) : (
                <>
                  {sections.length > 3 && (
                    <LegalToc sections={sections} onJump={jump} collapsible />
                  )}
                  <LegalArticle sections={sections} heading="h3" />
                </>
              ))}
          </div>

          <div className="lm-ft">
            <button type="button" onClick={onClose} className="btn btn-p btn-block">
              סגירה
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function TermsModal({ onClose }: { onClose: () => void }) {
  return (
    <LegalModal
      kind="terms"
      title="תנאי השימוש"
      emptyCopy="התנאים טרם פורסמו."
      onClose={onClose}
    />
  )
}

export function PrivacyModal({ onClose }: { onClose: () => void }) {
  return (
    <LegalModal
      kind="privacy"
      title="מדיניות פרטיות"
      emptyCopy="המדיניות טרם פורסמה."
      onClose={onClose}
    />
  )
}
