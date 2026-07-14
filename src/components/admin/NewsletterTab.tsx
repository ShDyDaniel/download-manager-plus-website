import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Loader2,
  Send,
  Mail,
  Users as UsersIcon,
  RefreshCw,
  Copy,
  Check,
  Download,
  Eye,
  EyeOff,
  Save,
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
  X,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from './SettingsTab'

/**
 * Admin → ניוזלטר (web). Mailing-list workspace: view opted-in
 * subscribers, then compose the broadcast in a VISUAL block builder
 * (no raw HTML in sight) with a live preview identical to the system's
 * email template, reusable saved presets, and inline Drive images.
 * The broadcast can target everyone, only free users (incl. active
 * trials), or only Pro users.
 */

interface Recipient {
  uid: string
  email: string
  optInAt: string | null
}

type Audience = 'all' | 'free' | 'pro' | 'one'

/* ── מודל הבלוקים ── */
type Align = 'right' | 'center' | 'left' | 'justify'
/** שדות עיצוב-טקסט משותפים (פונט/גודל/הדגשה/צבע). */
interface TextStyleFields {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
}
type Block =
  // פסקה = עורך טקסט-עשיר; ה-html מכיל עיצוב פנימי (מודגש/פונט/צבע/קישור),
  // ו-align הוא היישור של כל הפסקה (כולל justify — מילוי שורות).
  | { id: string; type: 'paragraph'; html: string; align?: Align }
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

interface Preset {
  id: string
  name: string
  subject: string
  heading: string
  contentHtml: string
  blocksJson: string
  updatedAt: string
}

export default function NewsletterTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [error, setError] = useState('')

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-3xl font-bold font-display text-fg">ניוזלטר</h2>
        <p className="mt-1 text-sm text-fg-muted">
          רשימת התפוצה — כל מי שהסכים לקבל תוכן שיווקי בהרשמה — ובניית מייל שיווקי ושליחתו.
        </p>
      </header>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <RecipientsCard onErr={handleErr} />
      <BroadcastCard onErr={handleErr} />
    </div>
  )
}

/* ── רשימת הנרשמים ─────────────────────────────────────────────── */
function RecipientsCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [list, setList] = useState<Recipient[] | null>(null)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await adminApi<{ count?: number; recipients?: Recipient[] }>(
        'admin-list-marketing-recipients',
        {},
      )
      setList(j.recipients ?? [])
      setCount(j.count ?? j.recipients?.length ?? 0)
    } catch (e) {
      onErr(e)
    } finally {
      setLoading(false)
    }
  }, [onErr])

  useEffect(() => {
    void load()
  }, [load])

  async function copyAll() {
    if (!list || list.length === 0) return
    try {
      await navigator.clipboard.writeText(list.map((r) => r.email).join(', '))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  function exportCsv() {
    if (!list || list.length === 0) return
    const rows = [
      'email,opt_in_at',
      ...list.map((r) => `${r.email},${r.optInAt ?? ''}`),
    ]
    const blob = new Blob([`﻿${rows.join('\n')}`], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `newsletter-recipients-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card title="רשומים לרשימת התפוצה">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-sm text-fg">
          <UsersIcon className="h-4 w-4 text-accent" />
          <span className="font-semibold tabular-nums">{count}</span>
          <span className="text-fg-muted">רשומים</span>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            רענון
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copyAll()}
            disabled={!list || list.length === 0}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            העתקת הכל
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={exportCsv}
            disabled={!list || list.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            ייצוא CSV
          </Button>
        </div>
      </div>

      {loading && !list ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען רשימה…
        </div>
      ) : list && list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-fg-muted">
          <Mail className="h-6 w-6 opacity-40" />
          עדיין אין נרשמים לרשימת התפוצה.
        </div>
      ) : list ? (
        <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-fg-muted">
                <th className="px-3 py-2 text-start font-medium">מייל</th>
                <th className="px-3 py-2 text-start font-medium">נרשם בתאריך</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.uid} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 text-fg" dir="ltr">
                    {r.email}
                  </td>
                  <td className="px-3 py-2 text-fg-muted tabular-nums">
                    {formatDate(r.optInAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/* ─────────────────────────────────────────────────────────────────
 *  בלוקים → HTML. הרפליקה של renderEmail() בשרת עוטפת את התוכן; כאן
 *  אנחנו מייצרים רק את גוף התוכן מתוך הבלוקים, בצבעי-המותג.
 * ───────────────────────────────────────────────────────────────── */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** מזהה-קובץ מכל צורות קישור-השיתוף של גוגל דרייב (או מזהה גולמי). */
function extractDriveId(link: string): string | null {
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

function driveImgSrc(link: string): string | null {
  const id = extractDriveId(link)
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : null
}

/** פונטים יפים מ-Google Fonts, כולם תומכי-עברית. name = שם המשפחה
 *  (ל-execCommand בעורך העשיר), stack = מחרוזת ה-font-family לסגנון. */
const FONTS: { key: string; label: string; name: string; stack: string }[] = [
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
function fontStack(key?: string): string {
  return FONTS.find((f) => f.key === key)?.stack ?? FONTS[0].stack
}
/** קישור Google Fonts הטוען את כל המשפחות — לתצוגה המקדימה ולמייל הנשלח. */
const FONT_CSS_HREF =
  'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&family=Assistant:wght@400;600;700&family=Heebo:wght@400;700&family=Varela+Round&family=Secular+One&family=Frank+Ruhl+Libre:wght@400;500;700&family=Suez+One&family=Bellefair&family=Miriam+Libre:wght@400;700&family=Alef:wght@400;700&display=swap'
const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40]

/** סגנונות כפתור לבחירה. */
const BUTTON_VARIANTS: {
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
function buttonVariant(key?: string) {
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

function blockToHtml(b: Block): string {
  switch (b.type) {
    case 'paragraph': {
      // ה-html כבר כולל את העיצוב הפנימי; עוטפים במיכל עם ברירות-מחדל
      // של גודל/צבע/פונט/כיוון + היישור של כל הפסקה. ב-justify מוסיפים
      // text-align-last כדי שגם השורה האחרונה/הבודדת תימתח מקצה לקצה.
      const al = b.align || 'right'
      const lastRule = al === 'justify' ? 'text-align-last:justify;' : ''
      return `<div style="font-size:15px;line-height:1.8;color:#D8CFC2;font-family:${fontStack(
        'rubik',
      )};direction:rtl;text-align:${al};${lastRule}margin:0 0 18px;">${b.html}</div>`
    }
    case 'heading':
      return wrapAlign(
        `<h2 style="${textCss(b, {
          size: 19,
          color: '#F5EFE6',
          weight: 500,
        })};margin:26px 0 12px;">${esc(b.text)}</h2>`,
        b.align,
      )
    case 'button': {
      const href = esc(b.href || '#')
      const v = buttonVariant(b.variant)
      const labelCss = textCss(b, { size: 15, color: v.textColor, weight: 500 })
      return wrapAlign(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;margin:8px 0 22px;"><tr><td style="border-radius:${v.radius}px;background:${v.bg};${v.border ? `border:${v.border};` : ''}"><a href="${href}" style="display:inline-block;padding:${v.padding};${labelCss};">${esc(
          b.text || 'לחצו כאן',
        )}</a></td></tr></table>`,
        b.align,
      )
    }
    case 'image': {
      const src = driveImgSrc(b.driveLink)
      if (!src) return ''
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

function blocksToHtml(blocks: Block[]): string {
  return blocks.map(blockToHtml).filter(Boolean).join('\n')
}

/* תבנית המייל — רפליקה מדויקת של renderEmail() בשרת. */
function renderEmailPreview(heading: string, contentHtml: string): string {
  const footer = `
    <hr style="border:0;border-top:1px solid rgba(245,239,230,0.08);margin:28px 0 16px;"/>
    <p style="font-size:11px;color:#5C5444;line-height:1.6;margin:0;">
      אתה מקבל את המייל הזה כי בחרת לקבל עדכוני מוצר ומבצעים. <a href="#" style="color:#D4A574;text-decoration:underline;">להסרה מרשימת התפוצה</a>.
    </p>`
  return `<!doctype html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link href="${FONT_CSS_HREF}" rel="stylesheet"/></head>
<body style="margin:0;padding:0;background:#16110D;font-family:'Rubik',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:#F5EFE6;direction:rtl;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#16110D;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;background:#2A211A;border-radius:10px;border:1px solid rgba(245,239,230,0.08);box-shadow:0 24px 48px rgba(13,8,4,0.55);">
<tr><td style="padding:40px 36px;text-align:right;direction:rtl;">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8B8170;margin:0 0 14px;font-weight:500;">— ניהול הורדות פלוס</div>
  <h1 style="font-size:28px;margin:0 0 22px;color:#F5EFE6;font-weight:500;line-height:1.18;letter-spacing:-0.015em;">${esc(
    heading,
  ) || 'כותרת ראשית'}</h1>
  ${contentHtml || '<p style="font-size:14px;line-height:1.7;color:#8B8170;">הוסף בלוקים כדי לבנות את גוף המייל…</p>'}
  ${footer}
</td></tr></table>
<div style="margin:24px auto 0;font-size:10px;letter-spacing:0.18em;color:#5C5444;text-align:center;">— ניהול הורדות פלוס —</div>
</td></tr></table></body></html>`
}

/* סוגי הבלוקים בסרגל ההוספה. */
const BLOCK_KINDS: {
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

const AUDIENCES: { key: Audience; label: string; hint: string }[] = [
  { key: 'all', label: 'כולם', hint: 'כל רשימת התפוצה' },
  { key: 'free', label: 'משתמשי חינם', hint: 'כולל ניסיון פעיל' },
  { key: 'pro', label: 'משתמשי פרו', hint: 'מנוי פעיל בלבד' },
  { key: 'one', label: 'מייל ספציפי', hint: 'שליחה לכתובת אחת' },
]

/* ── מלחין ההודעה: בנאי בלוקים + תצוגה מקדימה + פריסטים + קהל ── */
function BroadcastCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [subject, setSubject] = useState('')
  const [heading, setHeading] = useState('')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [audience, setAudience] = useState<Audience>('all')
  const [oneEmail, setOneEmail] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<{
    kind: 'idle' | 'dry' | 'done' | 'error'
    text: string
  }>({ kind: 'idle', text: '' })
  const [showPreview, setShowPreview] = useState(true)

  const idc = useRef(0)
  const newId = () => `b${idc.current++}_${Date.now().toString(36)}`

  // ── פריסטים ──
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState('')
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [presetBusy, setPresetBusy] = useState(false)

  const loadPresets = useCallback(async () => {
    try {
      const j = await adminApi<{ presets?: Preset[] }>(
        'admin-newsletter-presets-list',
        {},
      )
      setPresets(j.presets ?? [])
    } catch (e) {
      onErr(e)
    }
  }, [onErr])

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  function addBlock(type: Block['type']) {
    const id = newId()
    const b: Block =
      type === 'paragraph'
        ? { id, type, html: '' }
        : type === 'heading'
          ? { id, type, text: '' }
          : type === 'button'
            ? { id, type, text: 'לחצו כאן', href: 'https://dmplus.net', variant: 'copper' }
            : type === 'image'
              ? { id, type, driveLink: '', alt: '' }
              : type === 'raw'
                ? { id, type, html: '' }
                : { id, type: 'divider' }
    setBlocks((bs) => [...bs, b])
  }

  function updateBlock(id: string, patch: Partial<Block>) {
    setBlocks((bs) =>
      bs.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)),
    )
  }

  function removeBlock(id: string) {
    setBlocks((bs) => bs.filter((b) => b.id !== id))
  }

  function moveBlock(id: string, dir: -1 | 1) {
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= bs.length) return bs
      const next = [...bs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const contentHtml = blocksToHtml(blocks)

  function applyPreset(p: Preset) {
    setSubject(p.subject)
    setHeading(p.heading)
    setPresetName(p.name)
    setLoadedId(p.id)
    try {
      const parsed = p.blocksJson ? (JSON.parse(p.blocksJson) as Block[]) : []
      if (Array.isArray(parsed) && parsed.length) {
        // מזהים חדשים כדי למנוע התנגשות מפתחות ב-React. פסקאות ישנות
        // (מבנה text) מומרות ל-html של העורך העשיר.
        setBlocks(
          parsed.map((b) => {
            const withId = { ...b, id: newId() } as Block & { text?: string }
            if (withId.type === 'paragraph' && withId.html === undefined) {
              const legacy = (withId as { text?: string }).text || ''
              return { id: withId.id, type: 'paragraph', html: esc(legacy).replace(/\n/g, '<br/>') }
            }
            return withId as Block
          }),
        )
        return
      }
    } catch {
      /* fall through to raw */
    }
    // פריסט ישן ללא בלוקים — נטען כבלוק HTML גולמי אחד.
    setBlocks(
      p.contentHtml
        ? [{ id: newId(), type: 'raw', html: p.contentHtml }]
        : [],
    )
  }

  async function savePreset() {
    const name = presetName.trim()
    if (!name) {
      setBcResult({ kind: 'error', text: 'תן שם לפריסט לפני השמירה.' })
      return
    }
    setPresetBusy(true)
    try {
      const j = await adminApi<{ id?: string }>('admin-newsletter-preset-save', {
        id: loadedId ?? undefined,
        name,
        subject,
        heading,
        contentHtml,
        blocksJson: JSON.stringify(blocks),
      })
      if (j.id) setLoadedId(j.id)
      await loadPresets()
      setBcResult({ kind: 'done', text: `הפריסט "${name}" נשמר.` })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setBcResult({ kind: 'error', text: err.message || 'שמירה נכשלה' })
    } finally {
      setPresetBusy(false)
    }
  }

  async function deletePreset(p: Preset) {
    if (!window.confirm(`למחוק את הפריסט "${p.name}"?`)) return
    try {
      await adminApi('admin-newsletter-preset-delete', { id: p.id })
      if (loadedId === p.id) setLoadedId(null)
      await loadPresets()
    } catch (e) {
      onErr(e)
    }
  }

  async function sendBroadcast(dryRun: boolean) {
    if (bcBusy) return
    setBcResult({ kind: 'idle', text: '' })
    if (!subject.trim() || !heading.trim() || !contentHtml.trim()) {
      setBcResult({
        kind: 'error',
        text: 'יש למלא נושא, כותרת, ולהוסיף לפחות בלוק תוכן אחד.',
      })
      return
    }
    const isOne = audience === 'one'
    if (isOne && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(oneEmail.trim())) {
      setBcResult({ kind: 'error', text: 'הזן כתובת מייל תקינה לשליחה ספציפית.' })
      return
    }
    setBcBusy(true)
    try {
      const j = await adminApi<{
        recipientCount?: number
        sent?: number
        failed?: number
      }>('admin-send-marketing-email', {
        subject: subject.trim(),
        heading: heading.trim(),
        contentHtml: contentHtml.trim(),
        audience,
        testEmail: isOne ? oneEmail.trim() : undefined,
        dryRun,
      })
      const audLabel = AUDIENCES.find((a) => a.key === audience)?.label ?? ''
      if (dryRun) {
        setBcResult({
          kind: 'dry',
          text: isOne
            ? `ישלח לכתובת ${oneEmail.trim()}. לחץ "שלח" לביצוע.`
            : `יש ${j.recipientCount ?? 0} נמענים בקהל "${audLabel}". לחץ "שלח" כדי לשלוח אליהם.`,
        })
      } else {
        setBcResult({
          kind: 'done',
          text: isOne
            ? `נשלח ל-${oneEmail.trim()} (${j.sent ?? 0} נשלחו, ${j.failed ?? 0} נכשלו).`
            : `הסתיים (${audLabel}): ${j.sent ?? 0}/${j.recipientCount ?? 0} נשלחו, ${j.failed ?? 0} נכשלו.`,
        })
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setBcResult({ kind: 'error', text: err.message || 'שליחה נכשלה' })
    } finally {
      setBcBusy(false)
    }
  }

  return (
    <Card title="בניית מייל שיווקי">
      <p className="text-[11px] leading-relaxed text-fg-muted">
        נשלח רק למשתמשים שהסכימו לקבל תוכן שיווקי בהרשמה. כל מייל כולל אוטומטית
        קישור "להסרה מרשימת הדיוור" בתחתית.
      </p>

      {/* ── פריסטים שמורים ── */}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <span
              key={p.id}
              className={
                'group inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ' +
                (loadedId === p.id
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border bg-background/40 text-fg-muted hover:text-fg')
              }
            >
              <button type="button" onClick={() => applyPreset(p)} className="max-w-[160px] truncate">
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => void deletePreset(p)}
                className="opacity-40 transition-opacity hover:text-destructive hover:opacity-100"
                title="מחיקת פריסט"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="נושא (Subject) — לדוגמה: 50% הנחה לסוף שבוע"
        disabled={bcBusy}
      />
      <Input
        value={heading}
        onChange={(e) => setHeading(e.target.value)}
        placeholder="כותרת ראשית במייל (Heading)"
        disabled={bcBusy}
      />

      {/* ── בנאי הבלוקים ── */}
      <div className="space-y-2">
        {blocks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-fg-muted">
            עדיין אין תוכן. הוסף בלוק ראשון מהכפתורים למטה.
          </div>
        ) : (
          blocks.map((b, i) => (
            <BlockEditor
              key={b.id}
              block={b}
              first={i === 0}
              last={i === blocks.length - 1}
              disabled={bcBusy}
              onChange={(patch) => updateBlock(b.id, patch)}
              onMove={(dir) => moveBlock(b.id, dir)}
              onRemove={() => removeBlock(b.id)}
            />
          ))
        )}
      </div>

      {/* ── סרגל הוספת בלוקים ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-fg-muted">הוסף:</span>
        {BLOCK_KINDS.map((k) => (
          <button
            key={k.type}
            type="button"
            disabled={bcBusy}
            onClick={() => addBlock(k.type)}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <k.icon className="h-3.5 w-3.5" />
            {k.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="ms-auto inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {showPreview ? 'הסתר תצוגה' : 'תצוגה מקדימה'}
        </button>
      </div>

      {/* ── תצוגה מקדימה חיה ── */}
      {showPreview && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-background/40 px-3 py-1.5 text-[11px] text-fg-muted">
            תצוגה מקדימה — בדיוק כמו שהמייל ייראה אצל הנמען
          </div>
          <iframe
            title="תצוגה מקדימה של המייל"
            srcDoc={renderEmailPreview(heading, contentHtml)}
            className="block h-[440px] w-full bg-[#16110D]"
            sandbox=""
          />
        </div>
      )}

      {/* ── שמירת פריסט ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/40 p-2.5">
        <Save className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <Input
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          placeholder="שם הפריסט (למשל: מבצע סוף שנה)"
          className="min-w-[160px] flex-1"
        />
        <Button variant="secondary" size="sm" onClick={() => void savePreset()} disabled={presetBusy}>
          {presetBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {loadedId ? 'עדכן פריסט' : 'שמור כפריסט'}
        </Button>
        {loadedId && (
          <button
            type="button"
            onClick={() => {
              setLoadedId(null)
              setPresetName('')
            }}
            className="text-xs text-fg-muted underline-offset-2 hover:underline"
          >
            פריסט חדש
          </button>
        )}
      </div>

      {/* ── קהל היעד ── */}
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-fg">קהל היעד</div>
        <div className="flex flex-wrap gap-1.5">
          {AUDIENCES.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={bcBusy}
              onClick={() => setAudience(a.key)}
              className={
                'flex flex-col items-start rounded-lg border px-3 py-1.5 text-start transition-colors disabled:opacity-50 ' +
                (audience === a.key
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-background/40 hover:border-fg-muted')
              }
            >
              <span
                className={
                  'text-xs font-medium ' +
                  (audience === a.key ? 'text-accent' : 'text-fg')
                }
              >
                {a.label}
              </span>
              <span className="text-[10px] text-fg-muted">{a.hint}</span>
            </button>
          ))}
        </div>
        {audience === 'one' && (
          <Input
            value={oneEmail}
            onChange={(e) => setOneEmail(e.target.value)}
            placeholder="כתובת המייל לשליחה"
            dir="ltr"
            disabled={bcBusy}
            className="mt-1.5"
          />
        )}
      </div>

      {bcResult.kind !== 'idle' && (
        <div
          className={
            bcResult.kind === 'error'
              ? 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive'
              : bcResult.kind === 'dry'
                ? 'rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent'
                : 'rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success'
          }
        >
          {bcResult.text}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={bcBusy}
          onClick={() => void sendBroadcast(true)}
          className="flex-1"
        >
          {bcBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          כמה נמענים בקהל?
        </Button>
        <Button
          variant="gradient"
          size="sm"
          disabled={bcBusy}
          onClick={() => {
            const audLabel = AUDIENCES.find((a) => a.key === audience)?.label ?? ''
            const msg =
              audience === 'one'
                ? `לשלוח את המייל ל-${oneEmail.trim() || '(ריק)'}?`
                : `לשלוח את המייל לקהל "${audLabel}"? אי אפשר לבטל אחרי שליחה.`
            if (window.confirm(msg)) {
              void sendBroadcast(false)
            }
          }}
          className="flex-1"
        >
          {bcBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          שלח
        </Button>
      </div>
    </Card>
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
          disabled={disabled}
          onChange={(html) => onChange({ html })}
          onAlign={(a) => onChange({ align: a })}
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
          {/* סגנון הכפתור */}
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
            placeholder="תיאור התמונה (alt) — אופציונלי"
            disabled={disabled}
          />
          <p className="text-[10px] leading-relaxed text-fg-muted">
            התמונה חייבת להיות משותפת ל"כל מי שיש לו הקישור", אחרת לא תוצג במייל.
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

/** מוודא שפונטי-Google ותבנית ה-placeholder של העורך טעונים במסמך (פעם אחת). */
let fontsInjected = false
function ensureFontsLoaded() {
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

/* ── עורך טקסט עשיר (contentEditable): מעצב טקסט מסומן בלבד ── */
function RichTextEditor({
  html,
  align,
  disabled,
  onChange,
  onAlign,
}: {
  html: string
  align?: Align
  disabled: boolean
  onChange: (html: string) => void
  onAlign: (a: Align) => void
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
    // מעצב את הקישורים החדשים בצבע-המותג + פתיחה בטאב חדש.
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
        {/* יישור כל הפסקה (כולל justify — מילוי שורות). */}
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
        {/* קישור על הטקסט המסומן */}
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
        }}
        data-ph="כתוב כאן… סמן טקסט כדי לעצב רק אותו"
        onInput={emit}
        onBlur={emit}
        className="nl-rte min-h-[90px] rounded-lg border border-border bg-input/60 px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
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
