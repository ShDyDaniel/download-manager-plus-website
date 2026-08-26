import { useLayoutEffect, useRef, type ReactNode } from 'react'

/**
 * Lightweight emphasis for revision-note text — the client can HIGHLIGHT a
 * word so a correction reads clearer ("move the *logo*"). WhatsApp-style:
 * wrap a word in a single asterisk on each side.
 *
 *   *word*  → highlight (marker pen)
 *
 * Stored as plain markers inside the existing note `text` string, so nothing
 * on the server / edit / history path changes. Rendered into safe React
 * nodes (never innerHTML).
 */

// One asterisk each side, same line, no asterisk inside.
const TOKEN_RE = /\*([^*\n]+)\*/g

/** Final rendered note text: `*x*` → highlighted `x` (asterisks removed),
 *  like a sent WhatsApp message. Whitespace preserved by the parent
 *  `whitespace-pre-wrap`. */
export function renderNoteText(text: string): ReactNode {
  if (!text || !text.includes('*')) return text
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <mark key={k++} className="rounded bg-amber-400/25 px-0.5 text-fg">
        {m[1]}
      </mark>,
    )
    last = TOKEN_RE.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** In-EDITOR markup: like renderNoteText but the asterisks stay visible and
 *  dimmed (half-transparent), so while typing the user sees exactly what
 *  they wrote AND the live highlight effect — the WhatsApp input look. */
function renderInputMarkup(text: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span key={k++}>
        <span className="text-fg/35">*</span>
        <mark className="rounded bg-amber-400/25 text-fg">{m[1]}</mark>
        <span className="text-fg/35">*</span>
      </span>,
    )
    last = TOKEN_RE.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  // A trailing newline needs a spacer line so the backdrop height matches
  // the textarea's.
  out.push('​')
  return out
}

/**
 * A textarea that shows the highlight live as you type. Implemented as a
 * transparent <textarea> layered over a styled backdrop <div> that mirrors
 * the text — the standard "highlight within a textarea" technique. The two
 * layers share identical box metrics so the styled text sits exactly under
 * the (transparent) real text; the caret stays visible.
 */
export function HighlightTextarea({
  value,
  onChange,
  rows = 4,
  placeholder,
  autoFocus,
  compact,
  dir = 'rtl',
}: {
  value: string
  onChange: (next: string) => void
  rows?: number
  placeholder?: string
  autoFocus?: boolean
  /** Smaller padding + text — used by the inline edit box. */
  compact?: boolean
  dir?: 'rtl' | 'ltr'
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const backRef = useRef<HTMLDivElement>(null)

  const syncScroll = () => {
    if (backRef.current && taRef.current) {
      backRef.current.scrollTop = taRef.current.scrollTop
      backRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }
  useLayoutEffect(syncScroll, [value])

  // Box metrics shared by BOTH layers so the styled text aligns under the
  // transparent typed text.
  const box =
    'w-full resize-y rounded-lg border px-3 leading-relaxed ' +
    (compact ? 'py-1.5 text-xs' : 'py-2.5 text-sm')

  return (
    <div className="relative">
      <div
        ref={backRef}
        aria-hidden
        dir={dir}
        className={
          box +
          ' pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-transparent text-fg'
        }
      >
        {renderInputMarkup(value)}
      </div>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        dir={dir}
        style={{ caretColor: 'var(--fg)' }}
        className={
          box +
          ' relative block bg-transparent text-transparent placeholder:text-fg-muted/60' +
          ' border-white/10 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20'
        }
      />
    </div>
  )
}

/** One-line explanation of the highlight syntax, with a live example so the
 *  effect is obvious. No button — the client just types the asterisks. */
export function FormatHint({ className }: { className?: string }) {
  return (
    <p className={'text-[11px] leading-relaxed text-fg-muted ' + (className || '')}>
      טיפ: עטפו מילה בכוכבית מכל צד כדי להדגיש אותה —{' '}
      <span className="whitespace-nowrap">{renderInputMarkupInline('*ככה*')}</span>
    </p>
  )
}

/** Inline (no trailing spacer) variant of renderInputMarkup for the hint. */
function renderInputMarkupInline(text: string): ReactNode {
  const m = TOKEN_RE.exec(text)
  TOKEN_RE.lastIndex = 0
  if (!m) return text
  return (
    <>
      <span className="text-fg/35">*</span>
      <mark className="rounded bg-amber-400/25 text-fg">{m[1]}</mark>
      <span className="text-fg/35">*</span>
    </>
  )
}
