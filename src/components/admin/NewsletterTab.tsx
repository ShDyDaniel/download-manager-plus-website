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
  Monitor,
  Smartphone,
  X,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from './SettingsTab'
import {
  BlockBuilder,
  blocksToHtml,
  esc,
  FONT_CSS_HREF,
  type Block,
} from './blockBuilder'

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
          רשימת התפוצה (כל מי שהסכים לקבל תוכן שיווקי בהרשמה), ובניית מייל שיווקי ושליחתו.
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
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  // גובה התצוגה-המקדימה מותאם אוטומטית לגובה התוכן (בלי גלילה).
  const [previewH, setPreviewH] = useState(420)
  const previewRoRef = useRef<ResizeObserver | null>(null)
  useEffect(() => () => previewRoRef.current?.disconnect(), [])
  function onPreviewLoad(e: React.SyntheticEvent<HTMLIFrameElement>) {
    const doc = e.currentTarget.contentDocument
    if (!doc) return
    // מודדים לפי גובה ה-body בפועל (מתכווץ לתוכן), לא documentElement —
    // האחרון נצמד לגובה ה-iframe וגורם ללולאה שלא מתכווצת.
    const measure = () => {
      const h = doc.body?.scrollHeight || 200
      setPreviewH(Math.max(160, h + 2))
    }
    measure()
    previewRoRef.current?.disconnect()
    try {
      const ro = new ResizeObserver(measure)
      if (doc.body) ro.observe(doc.body)
      previewRoRef.current = ro
    } catch {
      /* ResizeObserver unavailable */
    }
  }

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
        placeholder="נושא (Subject) · לדוגמה: 50% הנחה לסוף שבוע"
        disabled={bcBusy}
      />
      <Input
        value={heading}
        onChange={(e) => setHeading(e.target.value)}
        placeholder="כותרת ראשית במייל (Heading)"
        disabled={bcBusy}
      />

      {/* ── בנאי הבלוקים ── */}
      <BlockBuilder blocks={blocks} onBlocksChange={setBlocks} disabled={bcBusy} />

      {/* תצוגה מקדימה — כפתור הצג/הסתר */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {showPreview ? 'הסתר תצוגה' : 'תצוגה מקדימה'}
        </button>
      </div>

      {/* ── תצוגה מקדימה חיה ── */}
      {showPreview && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-background/40 px-3 py-1.5 text-[11px] text-fg-muted">
            <span>תצוגה מקדימה · בדיוק כמו שהמייל ייראה אצל הנמען</span>
            <div className="ms-auto flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              <button
                type="button"
                title="תצוגת מחשב"
                onClick={() => setDevice('desktop')}
                className={
                  'rounded-md p-1 transition-colors ' +
                  (device === 'desktop' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg')
                }
              >
                <Monitor className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="תצוגת טלפון"
                onClick={() => setDevice('mobile')}
                className={
                  'rounded-md p-1 transition-colors ' +
                  (device === 'mobile' ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg')
                }
              >
                <Smartphone className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className={device === 'mobile' ? 'flex justify-center bg-[#0d0805] p-4' : ''}>
            <iframe
              title="תצוגה מקדימה של המייל"
              srcDoc={renderEmailPreview(heading, contentHtml)}
              onLoad={onPreviewLoad}
              style={{
                height: previewH,
                width: device === 'mobile' ? 390 : '100%',
                maxWidth: '100%',
              }}
              className={
                'block bg-[#16110D] ' +
                (device === 'mobile' ? 'rounded-2xl border border-border shadow-lg' : '')
              }
              sandbox="allow-same-origin"
            />
          </div>
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

