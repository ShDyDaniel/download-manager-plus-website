import { useCallback, type ReactNode, type RefObject } from 'react'
import { Bold, Highlighter } from 'lucide-react'

/**
 * Lightweight emphasis for revision-note text — the client can make a word
 * bold or highlight it so a correction reads clearer ("move **this** logo",
 * "the ==background== is too dark"). Stored as plain markers inside the
 * existing note `text` string, so nothing on the server / edit / history
 * path changes. Rendered here into safe React nodes (never innerHTML).
 *
 *   **word**   → bold
 *   ==word==   → highlight (marker pen)
 */

const TOKEN_RE = /(\*\*([\s\S]+?)\*\*)|(==([\s\S]+?)==)/g

/** Render note text with **bold** / ==highlight== markers as React nodes.
 *  Whitespace is preserved by the surrounding `whitespace-pre-wrap`. */
export function renderNoteText(text: string): ReactNode {
  if (!text || (!text.includes('**') && !text.includes('=='))) return text
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] != null) {
      out.push(
        <strong key={k++} className="font-bold text-fg">
          {m[2]}
        </strong>,
      )
    } else {
      out.push(
        <mark key={k++} className="rounded bg-amber-400/25 px-0.5 text-fg">
          {m[4]}
        </mark>,
      )
    }
    last = TOKEN_RE.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Formatting toolbar for a note <textarea>: select text → Bold / Highlight
 *  wraps the selection in markers. Also carries a one-line "how to" tip so
 *  it's obvious anywhere a note is written. */
export function NoteFormatToolbar({
  textareaRef,
  value,
  onChange,
  className,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (next: string) => void
  className?: string
}) {
  const wrap = useCallback(
    (marker: string) => {
      const ta = textareaRef.current
      const s = ta ? ta.selectionStart ?? value.length : value.length
      const e = ta ? ta.selectionEnd ?? value.length : value.length
      const sel = value.slice(s, e) || 'טקסט'
      const next = value.slice(0, s) + marker + sel + marker + value.slice(e)
      onChange(next)
      // Re-select the inner text after React re-renders so a second click
      // (or typing) lands where the user expects.
      const innerStart = s + marker.length
      const innerEnd = innerStart + sel.length
      requestAnimationFrame(() => {
        if (!ta) return
        ta.focus()
        try {
          ta.setSelectionRange(innerStart, innerEnd)
        } catch {
          /* ignore */
        }
      })
    },
    [textareaRef, value, onChange],
  )

  return (
    <div className={'flex flex-wrap items-center gap-1.5 ' + (className || '')}>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => wrap('**')}
        title="הדגשה מודגשת (בולד)"
        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-white/[0.07] hover:text-fg"
      >
        <Bold className="h-3 w-3" />
        מודגש
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => wrap('==')}
        title="הדגשה בצבע (טוש)"
        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-white/[0.07] hover:text-fg"
      >
        <Highlighter className="h-3 w-3" />
        הדגשה
      </button>
      <span className="text-[10px] text-fg-muted/70">
        סמנו מילה ולחצו כדי להבליט אותה
      </span>
    </div>
  )
}
