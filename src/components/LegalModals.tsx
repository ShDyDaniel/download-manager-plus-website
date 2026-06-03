import { useEffect, useState } from 'react'

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

interface TermsSection {
  title: string
  paragraphs: string[]
}
export interface TermsDoc {
  version: number
  lastUpdated: string
  sections: TermsSection[]
}

type LegalKind = 'terms' | 'privacy'
type LegalCacheEntry =
  | { kind: 'loading'; promise: Promise<TermsDoc> }
  | { kind: 'ready'; doc: TermsDoc }
  | { kind: 'error'; message: string }
const legalDocCache: Partial<Record<LegalKind, LegalCacheEntry>> = {}

/** Kick off a fetch for the given legal doc. Safe to call
 *  repeatedly — concurrent calls share the in-flight promise. */
function loadLegalDoc(kind: LegalKind): Promise<TermsDoc> {
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

/* Shared chrome for both modals — identical backdrop, close button,
 * Esc/click-outside behaviour and section rendering. Only the title,
 * endpoint and empty-state copy differ. */
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
  const cached = legalDocCache[kind]
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; doc: TermsDoc }
    | { kind: 'error'; message: string }
  >(() => {
    if (cached && cached.kind === 'ready') return { kind: 'ready', doc: cached.doc }
    if (cached && cached.kind === 'error')
      return { kind: 'error', message: cached.message }
    return { kind: 'loading' }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (state.kind === 'ready') return
    let cancelled = false
    void loadLegalDoc(kind)
      .then((doc) => {
        if (cancelled) return
        setState({ kind: 'ready', doc })
      })
      .catch((err) => {
        if (cancelled) return
        setState({
          kind: 'error',
          message:
            err instanceof Error ? err.message : 'בעיית רשת. נסו שוב בעוד רגע.',
        })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-bg-elevated p-6 md:p-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute left-3 top-3 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-bg-card hover:text-fg"
          aria-label="סגור"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <h2 className="mb-1 text-xl font-medium text-fg">{title}</h2>
        {state.kind === 'ready' && state.doc.lastUpdated && (
          <div className="mb-5 text-xs text-fg-muted">
            עודכן: {state.doc.lastUpdated}
          </div>
        )}

        {state.kind === 'loading' && (
          <div className="py-8 text-center text-sm text-fg-muted">טוען…</div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.message}
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="space-y-5">
            {state.doc.sections.length === 0 ? (
              <p className="text-sm text-fg-muted">{emptyCopy}</p>
            ) : (
              state.doc.sections.map((section, i) => (
                <section key={i}>
                  <h3 className="mb-2 text-sm font-semibold text-fg">
                    {section.title}
                  </h3>
                  <div className="space-y-2 text-xs leading-relaxed text-fg-muted">
                    {section.paragraphs.map((p, j) => (
                      <p key={j}>{p}</p>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover"
        >
          סגירה
        </button>
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
