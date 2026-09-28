/* ──────────────────────────────────────────────────────────────
 *  Legal-document text → structure (for display only).
 *
 *  The Terms / Privacy documents are edited as plain text in the
 *  admin panel (sections of title + paragraphs). This module reads
 *  that text and works out how to LAY IT OUT: section numbers, which
 *  lines are really a list, and short lead-in labels to set in bold.
 *  The words themselves are never changed — every character of the
 *  stored text ends up on screen, in order.
 *
 *  Rules (all conservative — anything that doesn't clearly match
 *  stays a normal paragraph):
 *   - Title "7. Something" → number badge 7 + "Something".
 *   - Paragraphs starting with a bullet (•, ·, -, *) → one list.
 *   - A paragraph with line breaks → first line, then the other
 *     lines as a list (when there are 2+ of them, or the first line
 *     ends with ":"); otherwise the lines stay separate paragraphs.
 *   - 3+ paragraphs in a row shaped "short term — description" → list.
 *   - A paragraph ending with ":" followed by 2+ paragraphs that are
 *     mostly list-shaped → those paragraphs become its list.
 *   - One paragraph of 3+ "term — text; term — text; …" parts
 *     (or "term (…); term (…)") → list, any closing sentence after
 *     the last part stays a paragraph.
 *   - List items shaped "short term — text" get the term in bold;
 *     paragraphs shaped "Short label: text" get the label in bold.
 * ────────────────────────────────────────────────────────────── */

export interface LegalSectionInput {
  title: string
  paragraphs: string[]
}

/** A paragraph; `label` (when set) is the bold lead-in before ": ". */
export interface LegalPara {
  t: 'p'
  label?: string
  text: string
}
/** A list item; `term` (when set) is set in bold, followed by `sep`. */
export interface LegalItem {
  term?: string
  sep: string
  text: string
}
export interface LegalList {
  t: 'ul'
  items: LegalItem[]
}
export type LegalBlock = LegalPara | LegalList

export interface LegalSection {
  /** Anchor id (unique within the document). */
  id: string
  /** The number typed into the title ("" when the title has none). */
  num: string
  title: string
  blocks: LegalBlock[]
}

const DASH = ' — '
const BULLET = /^\s*[•·▪◦*-]\s+/
const LABEL = /^([^:()".—;]{2,40}):\s([\s\S]+)$/
const TITLE_NUM = /^(\d+)\.\s*([\s\S]+)$/

/** "term<sep>rest" with a short term → the term, else null. */
function termOf(s: string, sep: string): string | null {
  const i = s.indexOf(sep)
  if (i <= 0) return null
  const term = s.slice(0, i)
  if (term.length > 45 || term.includes('.')) return null
  if (sep !== DASH && term.includes(DASH.trim())) return null
  return term
}

function isTermLine(s: string): boolean {
  return termOf(s, DASH) !== null
}

function item(s: string, sep = DASH): LegalItem {
  const term = termOf(s, sep)
  if (term !== null) return { term, sep, text: s.slice(term.length + sep.length) }
  return { sep, text: s }
}

function para(s: string): LegalPara {
  const m = LABEL.exec(s)
  if (m) return { t: 'p', label: m[1], text: m[2] }
  return { t: 'p', text: s }
}

const stripBullet = (s: string) => s.replace(BULLET, '').trim()

/** "a — x; b — y; c — z. Tail sentence." → list + optional tail. */
function semicolonList(s: string): LegalBlock[] | null {
  const parts = s.split('; ')
  if (parts.length < 3) return null
  for (const sep of [DASH, ' (']) {
    if (!parts.every((p) => termOf(p, sep) !== null)) continue
    const last = parts[parts.length - 1]
    const afterTerm = last.indexOf(sep) + sep.length
    const stop = last.indexOf('. ', afterTerm)
    const lastItem = stop >= 0 ? last.slice(0, stop + 1) : last
    const tail = stop >= 0 ? last.slice(stop + 2).trim() : ''
    const items = [...parts.slice(0, -1).map((p) => p + ';'), lastItem].map((p) =>
      item(p, sep),
    )
    const out: LegalBlock[] = [{ t: 'ul', items }]
    if (tail) out.push(para(tail))
    return out
  }
  return null
}

/** One stored paragraph that contains line breaks. */
function multiline(p: string): LegalBlock[] {
  const lines = p
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length <= 1) return lines.map(para)
  if (lines.every((l) => BULLET.test(l)))
    return [{ t: 'ul', items: lines.map((l) => item(stripBullet(l))) }]
  const [head, ...rest] = lines
  if (rest.length >= 2 || head.endsWith(':'))
    return [para(head), { t: 'ul', items: rest.map((l) => item(stripBullet(l))) }]
  return lines.map(para)
}

export function layoutParagraphs(paragraphs: string[]): LegalBlock[] {
  const ps = paragraphs.map((p) => (typeof p === 'string' ? p : String(p ?? '')))
  const out: LegalBlock[] = []
  let i = 0
  while (i < ps.length) {
    const p = ps[i].trim()
    if (!p) {
      i++
      continue
    }
    if (p.includes('\n')) {
      out.push(...multiline(p))
      i++
      continue
    }
    // Run of bullet paragraphs.
    if (BULLET.test(p)) {
      const items: LegalItem[] = []
      while (i < ps.length && BULLET.test(ps[i]) && !ps[i].includes('\n')) {
        items.push(item(stripBullet(ps[i])))
        i++
      }
      out.push({ t: 'ul', items })
      continue
    }
    // Intro ending with ":" + the paragraphs that are its list.
    if (p.endsWith(':')) {
      let j = i + 1
      while (j < ps.length && ps[j].trim() && !ps[j].includes('\n')) j++
      const next = ps.slice(i + 1, j).map((s) => s.trim())
      const listy = next.filter((s) => BULLET.test(s) || isTermLine(s)).length
      if (next.length >= 2 && listy * 3 >= next.length * 2) {
        out.push(para(p), { t: 'ul', items: next.map((s) => item(stripBullet(s))) })
        i = j
        continue
      }
    }
    // Run of 3+ "term — description" paragraphs.
    let j = i
    while (j < ps.length && !ps[j].includes('\n') && isTermLine(ps[j].trim())) j++
    if (j - i >= 3) {
      out.push({ t: 'ul', items: ps.slice(i, j).map((s) => item(s.trim())) })
      i = j
      continue
    }
    // One paragraph that is really a semicolon-separated list.
    const semi = semicolonList(p)
    if (semi) {
      out.push(...semi)
      i++
      continue
    }
    out.push(para(p))
    i++
  }
  return out
}

/** Sections → numbered, anchored, laid-out sections. `prefix` keeps
 *  anchor ids unique on the page ("t" → t-1, t-2 …; "pr" → pr-1 …). */
export function layoutLegalDoc(
  sections: LegalSectionInput[],
  prefix: string,
): LegalSection[] {
  const used = new Set<string>()
  return (Array.isArray(sections) ? sections : []).map((s, i) => {
    const rawTitle = typeof s?.title === 'string' ? s.title.trim() : ''
    const m = TITLE_NUM.exec(rawTitle)
    const num = m ? m[1] : ''
    const title = m ? m[2].trim() : rawTitle
    let id = num ? `${prefix}-${num}` : `${prefix}-s${i + 1}`
    if (used.has(id)) id = `${prefix}-s${i + 1}`
    used.add(id)
    return {
      id,
      num,
      title,
      blocks: layoutParagraphs(Array.isArray(s?.paragraphs) ? s.paragraphs : []),
    }
  })
}

/* Inline pieces: e-mail addresses (→ mailto link) and domain names
 * are isolated so they keep their left-to-right order inside the
 * Hebrew sentence. */
export type InlinePiece =
  | { k: 'text'; v: string }
  | { k: 'email'; v: string }
  | { k: 'domain'; v: string }

const INLINE =
  /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})|(\b(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|co\.il)\b)/gi

export function splitInline(s: string): InlinePiece[] {
  const out: InlinePiece[] = []
  let last = 0
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ k: 'text', v: s.slice(last, at) })
    out.push(m[1] ? { k: 'email', v: m[1] } : { k: 'domain', v: m[0] })
    last = at + m[0].length
  }
  if (last < s.length) out.push({ k: 'text', v: s.slice(last) })
  return out
}
