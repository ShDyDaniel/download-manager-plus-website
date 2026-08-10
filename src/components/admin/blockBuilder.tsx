import { useEffect, useRef } from 'react'
import {
  Type,
  Pilcrow,
  MousePointerClick,
  Minus,
  Image as ImageIcon,
  Code2,
  ChevronUp,
  ChevronDown,
  Trash2,
  AlignRight,
  AlignCenter,
  AlignLeft,
  AlignJustify,
  Bold,
  Italic,
  Underline,
  Link as LinkIcon,
  Unlink,
} from 'lucide-react'
import { Input } from '@/components/ui/Input'

/**
 * Shared VISUAL block builder — the same editor the admin newsletter uses
 * to compose emails, extracted so the announcement popup can reuse it 1:1.
 * A `Block[]` describes styled content (rich paragraphs, headings, buttons,
 * images, dividers, raw HTML); `blocksToHtml` renders it to a self-contained
 * HTML string with brand colours that any dark surface (email body OR popup
 * card) can drop in via dangerouslySetInnerHTML.
 */

/* ── מודל הבלוקים ── */
export type Align = 'right' | 'center' | 'left' | 'justify'
/** שדות עיצוב-טקסט משותפים (פונט/גודל/הדגשה/צבע). */
export interface TextStyleFields {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
}
export type Block =
  // פסקה = עורך טקסט-עשיר; ה-html מכיל עיצוב פנימי (מודגש/פונט/צבע/קישור),
  // align = היישור של כל הפסקה (כולל justify — מילוי שורות), ו-padR/padL
  // הם מרווחי-הקצה (px) מכל צד — בעיקר כדי לרסן את המילוי-שורה.
  | { id: string; type: 'paragraph'; html: string; align?: Align; padR?: number; padL?: number }
  | ({ id: string; type: 'heading'; text: string; align?: Align } & TextStyleFields)
  | ({
      id: string
      type: 'button'
      text: string
      href: string
      align?: Align
      variant?: string
    } & TextStyleFields)
  | { id: string; type: 'image'; driveLink: string; alt: string; align?: Align }
  | { id: string; type: 'divider' }
  | { id: string; type: 'raw'; html: string; align?: Align }

/* ── מזהי בלוקים ── */
let idCounter = 0
export function newBlockId(): string {
  // Deterministic-ish, collision-free within a session — enough to key React.
  idCounter += 1
  return `b${idCounter}_${Date.now().toString(36)}`
}

export function newBlock(type: Block['type']): Block {
  const id = newBlockId()
  switch (type) {
    case 'paragraph':
      return { id, type, html: '' }
    case 'heading':
      return { id, type, text: '' }
    case 'button':
      return { id, type, text: 'לחצו כאן', href: 'https://dmplus.net', variant: 'copper' }
    case 'image':
      return { id, type, driveLink: '', alt: '' }
    case 'raw':
      return { id, type, html: '' }
    default:
      return { id, type: 'divider' }
  }
}

/* ── תוכן → HTML ── */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** מזהה-קובץ מכל צורות קישור-השיתוף של גוגל דרייב (או מזהה גולמי). */
export function extractDriveId(link: string): string | null {
  const s = link.trim()
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{20,})/,
    /[?&]id=([a-zA-Z0-9_-]{20,})/,
    /\/d\/([a-zA-Z0-9_-]{20,})/,
  ]
  for (const p of patterns) {
    const m = s.match(p)
    if (m) return m[1]
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s
  return null
}

export function driveImgSrc(link: string): string | null {
  const id = extractDriveId(link)
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : null
}

/** פונטים יפים מ-Google Fonts, כולם תומכי-עברית. name = שם המשפחה
 *  (ל-execCommand בעורך העשיר), stack = מחרוזת ה-font-family לסגנון. */
export const FONTS: { key: string; label: string; name: string; stack: string }[] = [
  { key: 'rubik', label: 'Rubik', name: 'Rubik', stack: "'Rubik', sans-serif" },
  { key: 'assistant', label: 'Assistant', name: 'Assistant', stack: "'Assistant', sans-serif" },
  { key: 'heebo', label: 'Heebo', name: 'Heebo', stack: "'Heebo', sans-serif" },
  { key: 'varela', label: 'Varela Round', name: 'Varela Round', stack: "'Varela Round', sans-serif" },
  { key: 'secular', label: 'Secular One', name: 'Secular One', stack: "'Secular One', sans-serif" },
  { key: 'frank', label: 'Frank Ruhl Libre', name: 'Frank Ruhl Libre', stack: "'Frank Ruhl Libre', serif" },
  { key: 'suez', label: 'Suez One', name: 'Suez One', stack: "'Suez One', serif" },
  { key: 'bellefair', label: 'Bellefair', name: 'Bellefair', stack: "'Bellefair', serif" },
  { key: 'miriam', label: 'Miriam Libre', name: 'Miriam Libre', stack: "'Miriam Libre', sans-serif" },
  { key: 'alef', label: 'Alef', name: 'Alef', stack: "'Alef', sans-serif" },
]
export function fontStack(key?: string): string {
  return FONTS.find((f) => f.key === key)?.stack ?? FONTS[0].stack
}
/** קישור Google Fonts הטוען את כל המשפחות — לתצוגה המקדימה, למייל ולפופאפ. */
export const FONT_CSS_HREF =
  'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&family=Assistant:wght@400;600;700&family=Heebo:wght@400;700&family=Varela+Round&family=Secular+One&family=Frank+Ruhl+Libre:wght@400;500;700&family=Suez+One&family=Bellefair&family=Miriam+Libre:wght@400;700&family=Alef:wght@400;700&display=swap'
export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40]

/** סגנונות כפתור לבחירה. */
export const BUTTON_VARIANTS: {
  key: string
  label: string
  bg: string
  textColor: string
  border?: string
  radius: number
  padding: string
}[] = [
  { key: 'copper', label: 'נחושת', bg: '#D4A574', textColor: '#16110D', radius: 8, padding: '12px 28px' },
  { key: 'pill', label: 'גלולה', bg: '#D4A574', textColor: '#16110D', radius: 999, padding: '12px 32px' },
  { key: 'outline', label: 'מתאר', bg: 'transparent', textColor: '#D4A574', border: '1px solid #D4A574', radius: 8, padding: '11px 27px' },
  { key: 'soft', label: 'רך', bg: 'rgba(212,165,116,0.15)', textColor: '#E8C9A0', radius: 8, padding: '12px 28px' },
  { key: 'dark', label: 'כהה', bg: '#16110D', textColor: '#F5EFE6', border: '1px solid rgba(245,239,230,0.18)', radius: 8, padding: '12px 28px' },
  { key: 'light', label: 'בהיר', bg: '#F5EFE6', textColor: '#16110D', radius: 8, padding: '12px 28px' },
]
export function buttonVariant(key?: string) {
  return BUTTON_VARIANTS.find((v) => v.key === key) ?? BUTTON_VARIANTS[0]
}

/** בונה מחרוזת-CSS לעיצוב טקסט מתוך שדות הבלוק, עם ברירות-מחדל. */
function textCss(
  b: TextStyleFields,
  def: { size: number; color: string; weight?: number },
): string {
  return [
    `font-family:${fontStack(b.fontFamily)}`,
    `font-size:${b.fontSize || def.size}px`,
    `font-weight:${b.bold ? 700 : def.weight ?? 400}`,
    b.italic ? 'font-style:italic' : 'font-style:normal',
    `text-decoration:${b.underline ? 'underline' : 'none'}`,
    `color:${b.color || def.color}`,
  ].join(';')
}

/** עוטף תוכן ב-div עם יישור אופקי (ברירת-מחדל: ימין, מתאים ל-RTL). */
function wrapAlign(inner: string, align?: Align): string {
  return `<div style="text-align:${align || 'right'};">${inner}</div>`
}

/** אפשרויות רינדור. `fullWidthImages` — לפופאפ: התמונות ממלאות את כל רוחב
 *  הכרטיס (100%) במקום להיות מוגבלות ל-468px כמו במייל. */
export interface RenderOpts {
  fullWidthImages?: boolean
}

export function blockToHtml(b: Block, opts?: RenderOpts): string {
  switch (b.type) {
    case 'paragraph': {
      // text-align-last כדי שגם השורה האחרונה/הבודדת תימתח מקצה לקצה.
      const al = b.align || 'right'
      const lastRule = al === 'justify' ? 'text-align-last:justify;' : ''
      const padRule = `padding-right:${b.padR || 0}px;padding-left:${b.padL || 0}px;`
      return `<div style="font-size:15px;line-height:1.8;color:#D8CFC2;font-family:${fontStack(
        undefined,
      )};direction:rtl;text-align:${al};${lastRule}${padRule}margin:0 0 18px;">${b.html}</div>`
    }
    case 'heading':
      return wrapAlign(
        `<div style="${textCss(b, {
          size: 22,
          color: '#F5EFE6',
          weight: 700,
        })};line-height:1.3;margin:0 0 14px;">${esc(b.text)}</div>`,
        b.align,
      )
    case 'button': {
      const href = b.href || '#'
      const v = buttonVariant(b.variant)
      const labelCss = textCss(b, { size: 15, color: v.textColor, weight: 500 })
      return wrapAlign(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;margin:8px 0 22px;"><tr><td style="border-radius:${v.radius}px;background:${v.bg};${v.border ? `border:${v.border};` : ''}"><a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:${v.padding};${labelCss};">${esc(
          b.text,
        )}</a></td></tr></table>`,
        b.align,
      )
    }
    case 'image': {
      const src = driveImgSrc(b.driveLink)
      if (!src) return ''
      // בפופאפ התמונה בורחת מעבר לריפוד-הכרטיס (p-5 = 20px) ונצמדת לקצוות
      // — בדיוק כמו תמונת-הכותרת המקורית שמילאה את כל רוחב הפופאפ. פינות
      // הכרטיס (overflow-hidden) גוזרות אותה יפה. margin שלילי אופקי בלבד,
      // כדי לא למשוך תוכן מעליה/מתחתיה.
      if (opts?.fullWidthImages) {
        return `<img src="${src}" alt="${esc(
          b.alt,
        )}" style="display:block;width:calc(100% + 40px);max-width:none;height:auto;margin:0 -20px 18px;border-radius:0;"/>`
      }
      return wrapAlign(
        `<img src="${src}" alt="${esc(
          b.alt,
        )}" width="468" style="display:inline-block;width:100%;max-width:468px;height:auto;border-radius:8px;margin:8px 0 20px;"/>`,
        b.align,
      )
    }
    case 'divider':
      return `<hr style="border:0;border-top:1px solid rgba(245,239,230,0.10);margin:24px 0;"/>`
    case 'raw':
      return wrapAlign(b.html, b.align)
  }
}

export function blocksToHtml(blocks: Block[], opts?: RenderOpts): string {
  return blocks
    .map((b) => blockToHtml(b, opts))
    .filter(Boolean)
    .join('\n')
}

/* סוגי הבלוקים בסרגל ההוספה. */
export const BLOCK_KINDS: {
  type: Block['type']
  label: string
  icon: typeof Type
}[] = [
  { type: 'paragraph', label: 'פסקה', icon: Pilcrow },
  { type: 'heading', label: 'כותרת משנה', icon: Type },
  { type: 'button', label: 'כפתור', icon: MousePointerClick },
  { type: 'image', label: 'תמונה', icon: ImageIcon },
  { type: 'divider', label: 'קו מפריד', icon: Minus },
  { type: 'raw', label: 'HTML', icon: Code2 },
]

/* ── מוודא שפונטי-Google ותבנית ה-placeholder של העורך טעונים במסמך (פעם אחת). */
let fontsInjected = false
export function ensureFontsLoaded() {
  if (fontsInjected || typeof document === 'undefined') return
  fontsInjected = true
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = FONT_CSS_HREF
  document.head.appendChild(link)
  const style = document.createElement('style')
  style.textContent =
    '.nl-rte:empty:before{content:attr(data-ph);color:#8B8170;pointer-events:none;}'
  document.head.appendChild(style)
}

/* ─────────────────────────────────────────────────────────────────
 *  Editor UI
 * ───────────────────────────────────────────────────────────────── */

/**
 * The whole visual builder: the block list, per-block editors, and the
 * "add block" bar. Fully controlled — the parent owns the `blocks` array
 * and gets a new array on every edit. Drop it anywhere an admin needs to
 * compose rich content (newsletter body, popup body, …).
 */
export function BlockBuilder({
  blocks,
  onBlocksChange,
  disabled = false,
  emptyHint = 'עדיין אין תוכן. הוסף בלוק ראשון מהכפתורים למטה.',
}: {
  blocks: Block[]
  onBlocksChange: (blocks: Block[]) => void
  disabled?: boolean
  emptyHint?: string
}) {
  function addBlock(type: Block['type']) {
    onBlocksChange([...blocks, newBlock(type)])
  }
  function updateBlock(id: string, patch: Partial<Block>) {
    onBlocksChange(
      blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)),
    )
  }
  function removeBlock(id: string) {
    onBlocksChange(blocks.filter((b) => b.id !== id))
  }
  function moveBlock(id: string, dir: -1 | 1) {
    const i = blocks.findIndex((b) => b.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= blocks.length) return
    const next = [...blocks]
    ;[next[i], next[j]] = [next[j], next[i]]
    onBlocksChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {blocks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-fg-muted">
            {emptyHint}
          </div>
        ) : (
          blocks.map((b, i) => (
            <BlockEditor
              key={b.id}
              block={b}
              first={i === 0}
              last={i === blocks.length - 1}
              disabled={disabled}
              onChange={(patch) => updateBlock(b.id, patch)}
              onMove={(dir) => moveBlock(b.id, dir)}
              onRemove={() => removeBlock(b.id)}
            />
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-fg-muted">הוסף:</span>
        {BLOCK_KINDS.map((k) => (
          <button
            key={k.type}
            type="button"
            disabled={disabled}
            onClick={() => addBlock(k.type)}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <k.icon className="h-3.5 w-3.5" />
            {k.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── עורך בלוק בודד ── */
function BlockEditor({
  block,
  first,
  last,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  block: Block
  first: boolean
  last: boolean
  disabled: boolean
  onChange: (patch: Partial<Block>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const LABELS: Record<Block['type'], string> = {
    paragraph: 'פסקה',
    heading: 'כותרת משנה',
    button: 'כפתור',
    image: 'תמונה',
    divider: 'קו מפריד',
    raw: 'HTML',
  }
  const imgPreview =
    block.type === 'image' ? driveImgSrc(block.driveLink) : null

  return (
    <div className="rounded-xl border border-border bg-background/30 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
          {LABELS[block.type]}
        </span>
        {block.type !== 'divider' && block.type !== 'paragraph' && (
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {([
              ['right', AlignRight, 'יישור לימין'],
              ['center', AlignCenter, 'מרכוז'],
              ['left', AlignLeft, 'יישור לשמאל'],
            ] as const).map(([val, Icon, title]) => {
              const active = (block.align || 'right') === val
              return (
                <button
                  key={val}
                  type="button"
                  disabled={disabled}
                  title={title}
                  onClick={() => onChange({ align: val })}
                  className={
                    'rounded-md p-1 transition-colors disabled:opacity-40 ' +
                    (active
                      ? 'bg-accent/15 text-accent'
                      : 'text-fg-muted hover:text-fg')
                  }
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              )
            })}
          </div>
        )}
        <div className="ms-auto flex items-center gap-0.5">
          <IconBtn disabled={disabled || first} onClick={() => onMove(-1)} title="למעלה">
            <ChevronUp className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn disabled={disabled || last} onClick={() => onMove(1)} title="למטה">
            <ChevronDown className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn disabled={disabled} onClick={onRemove} title="מחיקה" danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </div>

      {block.type === 'paragraph' && (
        <RichTextEditor
          html={block.html}
          align={block.align}
          padR={block.padR}
          padL={block.padL}
          disabled={disabled}
          onChange={(html) => onChange({ html })}
          onAlign={(a) => onChange({ align: a })}
          onPad={(patch) => onChange(patch)}
        />
      )}

      {block.type === 'heading' && (
        <div className="space-y-2">
          <Input
            value={block.text}
            onChange={(e) => onChange({ text: e.target.value })}
            placeholder="טקסט הכותרת"
            disabled={disabled}
          />
          <TextStyleBar style={block} defColor="#F5EFE6" disabled={disabled} onChange={onChange} />
        </div>
      )}

      {block.type === 'button' && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] text-fg-muted">טקסט הכפתור</span>
              <Input
                value={block.text}
                onChange={(e) => onChange({ text: e.target.value })}
                placeholder="לחצו כאן"
                disabled={disabled}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-fg-muted">קישור (לאן מוביל)</span>
              <Input
                value={block.href}
                onChange={(e) => onChange({ href: e.target.value })}
                placeholder="https://dmplus.net"
                dir="ltr"
                disabled={disabled}
              />
            </label>
          </div>
          <div className="space-y-1">
            <span className="text-[11px] text-fg-muted">סגנון הכפתור</span>
            <div className="flex flex-wrap gap-1.5">
              {BUTTON_VARIANTS.map((v) => {
                const active = (block.variant || 'copper') === v.key
                return (
                  <button
                    key={v.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange({ variant: v.key })}
                    title={v.label}
                    style={{
                      background: v.bg,
                      color: v.textColor,
                      border: v.border || '1px solid transparent',
                      borderRadius: v.key === 'pill' ? 999 : 6,
                    }}
                    className={
                      'px-3 py-1 text-[11px] font-medium transition-transform disabled:opacity-50 ' +
                      (active ? 'ring-2 ring-accent ring-offset-1 ring-offset-card' : 'hover:scale-[1.03]')
                    }
                  >
                    {v.label}
                  </button>
                )
              })}
            </div>
          </div>
          <TextStyleBar
            style={block}
            defColor={buttonVariant(block.variant).textColor}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      )}

      {block.type === 'image' && (
        <div className="space-y-2">
          <label className="space-y-1 block">
            <span className="text-[11px] text-fg-muted">קישור-שיתוף מגוגל דרייב</span>
            <Input
              value={block.driveLink}
              onChange={(e) => onChange({ driveLink: e.target.value })}
              placeholder="https://drive.google.com/file/d/.../view"
              dir="ltr"
              disabled={disabled}
            />
          </label>
          <Input
            value={block.alt}
            onChange={(e) => onChange({ alt: e.target.value })}
            placeholder="תיאור התמונה (alt) · אופציונלי"
            disabled={disabled}
          />
          <p className="text-[10px] leading-relaxed text-fg-muted">
            התמונה חייבת להיות משותפת ל"כל מי שיש לו הקישור", אחרת לא תוצג.
          </p>
          {block.driveLink.trim() &&
            (imgPreview ? (
              <img
                src={imgPreview}
                alt=""
                className="max-h-32 rounded-lg border border-border object-contain"
              />
            ) : (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                לא זוהה קישור דרייב תקין.
              </div>
            ))}
        </div>
      )}

      {block.type === 'divider' && (
        <div className="py-1">
          <div className="h-px bg-border" />
        </div>
      )}

      {block.type === 'raw' && (
        <textarea
          value={block.html}
          onChange={(e) => onChange({ html: e.target.value })}
          placeholder="<p style=…>HTML חופשי למתקדמים…</p>"
          rows={4}
          dir="ltr"
          disabled={disabled}
          className="block w-full resize-y rounded-lg border border-border bg-input/60 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      )}
    </div>
  )
}

/* ── עורך טקסט עשיר (contentEditable): מעצב טקסט מסומן בלבד ── */
function RichTextEditor({
  html,
  align,
  padR,
  padL,
  disabled,
  onChange,
  onAlign,
  onPad,
}: {
  html: string
  align?: Align
  padR?: number
  padL?: number
  disabled: boolean
  onChange: (html: string) => void
  onAlign: (a: Align) => void
  onPad: (patch: { padR?: number; padL?: number }) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // איתחול חד-פעמי (הרכיב ממופתח לפי מזהה-הבלוק, אז טעינת פריסט = mount חדש).
  useEffect(() => {
    ensureFontsLoaded()
    if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => onChange(ref.current?.innerHTML || '')
  const cmd = (c: string, v?: string) => {
    ref.current?.focus()
    try {
      document.execCommand('styleWithCSS', false, 'true')
    } catch {
      /* ignore */
    }
    document.execCommand(c, false, v)
    emit()
  }
  const setSize = (px: string) => {
    if (!px) return
    ref.current?.focus()
    document.execCommand('fontSize', false, '7')
    ref.current?.querySelectorAll('font[size="7"]').forEach((el) => {
      const span = document.createElement('span')
      span.style.fontSize = `${px}px`
      while (el.firstChild) span.appendChild(el.firstChild)
      el.replaceWith(span)
    })
    emit()
  }
  const addLink = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      window.alert('קודם סמן את הטקסט שעליו יהיה הקישור, ואז לחץ.')
      return
    }
    let url = window.prompt('כתובת הקישור:', 'https://')
    if (!url) return
    url = url.trim()
    if (!/^https?:\/\//i.test(url) && !url.startsWith('mailto:')) url = `https://${url}`
    ref.current?.focus()
    document.execCommand('createLink', false, url)
    ref.current?.querySelectorAll('a:not([data-styled])').forEach((a) => {
      const el = a as HTMLAnchorElement
      el.setAttribute('data-styled', '1')
      el.style.color = '#D4A574'
      el.style.textDecoration = 'underline'
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener')
    })
    emit()
  }
  const removeLink = () => cmd('unlink')

  const selCls =
    'rounded-lg border border-border bg-input/60 px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
  const tbtn =
    'rounded-md p-1.5 text-fg-muted transition-colors hover:text-fg disabled:opacity-40'

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          defaultValue=""
          onChange={(e) => {
            const f = FONTS.find((x) => x.key === e.target.value)
            if (f) cmd('fontName', f.name)
            e.target.value = ''
          }}
          disabled={disabled}
          className={selCls}
          title="פונט לטקסט המסומן"
        >
          <option value="">פונט</option>
          {FONTS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          defaultValue=""
          onChange={(e) => {
            setSize(e.target.value)
            e.target.value = ''
          }}
          disabled={disabled}
          className={selCls}
          title="גודל לטקסט המסומן"
        >
          <option value="">גודל</option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}px
            </option>
          ))}
        </select>
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          <button type="button" disabled={disabled} title="מודגש" onClick={() => cmd('bold')} className={tbtn}>
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={disabled} title="נטוי" onClick={() => cmd('italic')} className={tbtn}>
            <Italic className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={disabled} title="קו תחתי" onClick={() => cmd('underline')} className={tbtn}>
            <Underline className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          {([
            ['right', AlignRight, 'יישור לימין'],
            ['center', AlignCenter, 'מרכוז'],
            ['left', AlignLeft, 'יישור לשמאל'],
            ['justify', AlignJustify, 'יישור לשני הצדדים'],
          ] as const).map(([val, Icon, title]) => {
            const on = (align || 'right') === val
            return (
              <button
                key={val}
                type="button"
                disabled={disabled}
                title={title}
                onClick={() => onAlign(val)}
                className={
                  'rounded-md p-1.5 transition-colors disabled:opacity-40 ' +
                  (on ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg')
                }
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          <button type="button" disabled={disabled} title="הוספת קישור לטקסט המסומן" onClick={addLink} className={tbtn}>
            <LinkIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={disabled} title="הסרת קישור" onClick={removeLink} className={tbtn}>
            <Unlink className="h-3.5 w-3.5" />
          </button>
        </div>
        <label className="flex items-center gap-1 rounded-lg border border-border px-1.5 py-1 text-xs text-fg-muted" title="צבע לטקסט המסומן">
          <input
            type="color"
            defaultValue="#D8CFC2"
            onChange={(e) => cmd('foreColor', e.target.value)}
            disabled={disabled}
            className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          צבע
        </label>
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        dir="rtl"
        style={{
          textAlign: align || 'right',
          textAlignLast: align === 'justify' ? 'justify' : 'auto',
          paddingRight: `${(padR || 0) + 12}px`,
          paddingLeft: `${(padL || 0) + 12}px`,
        }}
        data-ph="כתוב כאן… סמן טקסט כדי לעצב רק אותו"
        onInput={emit}
        onBlur={emit}
        className="nl-rte min-h-[90px] rounded-lg border border-border bg-input/60 py-2 text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {align === 'justify' && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-background/40 px-3 py-2">
          <label className="space-y-1">
            <span className="flex justify-between text-[11px] text-fg-muted">
              <span>מרווח ימין</span>
              <span className="tabular-nums">{padR || 0}px</span>
            </span>
            <input
              type="range"
              min={0}
              max={200}
              value={padR || 0}
              disabled={disabled}
              onChange={(e) => onPad({ padR: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </label>
          <label className="space-y-1">
            <span className="flex justify-between text-[11px] text-fg-muted">
              <span>מרווח שמאל</span>
              <span className="tabular-nums">{padL || 0}px</span>
            </span>
            <input
              type="range"
              min={0}
              max={200}
              value={padL || 0}
              disabled={disabled}
              onChange={(e) => onPad({ padL: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </label>
        </div>
      )}
    </div>
  )
}

/* ── סרגל עיצוב-טקסט: פונט, גודל, מודגש/נטוי/קו-תחתי, צבע ── */
function TextStyleBar({
  style,
  defColor,
  disabled,
  onChange,
}: {
  style: TextStyleFields
  defColor: string
  disabled: boolean
  onChange: (patch: Partial<Block>) => void
}) {
  const selCls =
    'rounded-lg border border-border bg-input/60 px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
  const toggleCls = (on?: boolean) =>
    'rounded-md p-1.5 transition-colors disabled:opacity-40 ' +
    (on ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={style.fontFamily || 'brand'}
        onChange={(e) => onChange({ fontFamily: e.target.value })}
        disabled={disabled}
        className={selCls}
        title="פונט"
      >
        {FONTS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={String(style.fontSize || '')}
        onChange={(e) =>
          onChange({ fontSize: e.target.value ? Number(e.target.value) : undefined })
        }
        disabled={disabled}
        className={selCls}
        title="גודל טקסט"
      >
        <option value="">גודל</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}px
          </option>
        ))}
      </select>
      <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
        <button
          type="button"
          disabled={disabled}
          title="מודגש"
          onClick={() => onChange({ bold: !style.bold })}
          className={toggleCls(style.bold)}
        >
          <Bold className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={disabled}
          title="נטוי"
          onClick={() => onChange({ italic: !style.italic })}
          className={toggleCls(style.italic)}
        >
          <Italic className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={disabled}
          title="קו תחתי"
          onClick={() => onChange({ underline: !style.underline })}
          className={toggleCls(style.underline)}
        >
          <Underline className="h-3.5 w-3.5" />
        </button>
      </div>
      <label
        className="flex items-center gap-1 rounded-lg border border-border px-1.5 py-1 text-xs text-fg-muted"
        title="צבע הטקסט"
      >
        <input
          type="color"
          value={style.color || defColor}
          onChange={(e) => onChange({ color: e.target.value })}
          disabled={disabled}
          className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        צבע
      </label>
      {style.color && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ color: undefined })}
          className="text-[11px] text-fg-muted underline-offset-2 hover:underline"
        >
          איפוס צבע
        </button>
      )}
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        'rounded-md p-1.5 text-fg-muted transition-colors disabled:opacity-30 ' +
        (danger ? 'hover:text-destructive' : 'hover:text-fg')
      }
    >
      {children}
    </button>
  )
}
