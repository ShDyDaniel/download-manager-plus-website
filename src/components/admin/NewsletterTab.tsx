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
  X,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from './SettingsTab'

/**
 * Admin → ניוזלטר (web). The mailing-list workspace: view every user
 * currently opted-in to marketing, then compose the broadcast with a
 * live preview (identical to how the system renders every email),
 * reusable saved presets, ready-made design blocks, and inline images
 * pasted from a Google Drive share link.
 */

interface Recipient {
  uid: string
  email: string
  optInAt: string | null
}

interface Preset {
  id: string
  name: string
  subject: string
  heading: string
  contentHtml: string
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
          רשימת התפוצה — כל מי שהסכים לקבל תוכן שיווקי בהרשמה — ושליחת מייל שיווקי לכולם.
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

/* ── תבנית המייל — רפליקה מדויקת של renderEmail() בשרת, כדי שהתצוגה
 *    המקדימה תיראה בדיוק כמו מה שנשלח בפועל (כולל הפוטר של הדיוור). ── */
function renderEmailPreview(heading: string, contentHtml: string): string {
  const marketingFooter = `
    <hr style="border:0;border-top:1px solid rgba(245,239,230,0.08);margin:28px 0 16px;"/>
    <p style="font-size:11px;color:#5C5444;line-height:1.6;margin:0;">
      אתה מקבל את המייל הזה כי בחרת לקבל עדכוני מוצר ומבצעים. <a href="#" style="color:#D4A574;text-decoration:underline;">להסרה מרשימת התפוצה</a>.
    </p>`
  return `<!doctype html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet"/></head>
<body style="margin:0;padding:0;background:#16110D;font-family:'Rubik',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:#F5EFE6;direction:rtl;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#16110D;padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;background:#2A211A;border-radius:10px;border:1px solid rgba(245,239,230,0.08);box-shadow:0 24px 48px rgba(13,8,4,0.55);">
<tr><td style="padding:40px 36px;text-align:right;direction:rtl;">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8B8170;margin:0 0 14px;font-weight:500;">— ניהול הורדות פלוס</div>
  <h1 style="font-size:28px;margin:0 0 22px;color:#F5EFE6;font-weight:500;line-height:1.18;letter-spacing:-0.015em;">${heading || 'כותרת ראשית'}</h1>
  ${contentHtml || '<p style="font-size:14px;line-height:1.7;color:#d1d5db;">תוכן ההודעה יופיע כאן…</p>'}
  ${marketingFooter}
</td></tr>
</table>
<div style="margin:24px auto 0;font-size:10px;letter-spacing:0.18em;color:#5C5444;text-align:center;">— ניהול הורדות פלוס —</div>
</td></tr>
</table>
</body></html>`
}

/* בלוקים מעוצבים מוכנים בצבעי-המותג — נטענים לתוך תיבת התוכן בעמדת הסמן. */
const BLOCKS: { key: string; label: string; icon: typeof Type; html: string }[] = [
  {
    key: 'p',
    label: 'פסקה',
    icon: Pilcrow,
    html: '<p style="font-size:15px;line-height:1.8;color:#D8CFC2;margin:0 0 18px;">כתוב כאן את הטקסט של הפסקה.</p>',
  },
  {
    key: 'h',
    label: 'כותרת משנה',
    icon: Type,
    html: '<h2 style="font-size:19px;color:#F5EFE6;font-weight:500;margin:26px 0 12px;">כותרת משנה</h2>',
  },
  {
    key: 'cta',
    label: 'כפתור',
    icon: MousePointerClick,
    html: '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;"><tr><td style="border-radius:8px;background:#D4A574;"><a href="https://dmplus.net" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:500;color:#16110D;text-decoration:none;">לחצו כאן</a></td></tr></table>',
  },
  {
    key: 'hr',
    label: 'קו מפריד',
    icon: Minus,
    html: '<hr style="border:0;border-top:1px solid rgba(245,239,230,0.10);margin:24px 0;"/>',
  },
]

/* ── מלחין ההודעה: פריסטים + בלוקים + תמונה מדרייב + תצוגה מקדימה ── */
function BroadcastCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [bcSubject, setBcSubject] = useState('')
  const [bcHeading, setBcHeading] = useState('')
  const [bcContent, setBcContent] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<{
    kind: 'idle' | 'dry' | 'done' | 'error'
    text: string
  }>({ kind: 'idle', text: '' })

  const [showPreview, setShowPreview] = useState(true)
  const contentRef = useRef<HTMLTextAreaElement>(null)

  // ── פריסטים ──
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState('')
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [presetBusy, setPresetBusy] = useState(false)

  // ── הוספת תמונה מדרייב ──
  const [driveOpen, setDriveOpen] = useState(false)
  const [driveLink, setDriveLink] = useState('')
  const [driveAlt, setDriveAlt] = useState('')

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

  /** מכניס קטע HTML לתיבת התוכן בעמדת הסמן (או בסוף). */
  function insertAtCursor(snippet: string) {
    const ta = contentRef.current
    if (!ta) {
      setBcContent((c) => `${c}\n${snippet}`)
      return
    }
    const start = ta.selectionStart ?? bcContent.length
    const end = ta.selectionEnd ?? bcContent.length
    const next = `${bcContent.slice(0, start)}${snippet}\n${bcContent.slice(end)}`
    setBcContent(next)
    // מחזיר פוקוס וממקם את הסמן אחרי מה שהוכנס.
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + snippet.length + 1
      ta.setSelectionRange(pos, pos)
    })
  }

  function insertDriveImage() {
    const id = extractDriveId(driveLink)
    if (!id) {
      setBcResult({
        kind: 'error',
        text: 'לא זוהה קישור דרייב תקין. הדבק קישור שיתוף לתמונה.',
      })
      return
    }
    // thumbnail?id=…&sz=w1000 — הכתובת הכי אמינה להטמעת תמונת דרייב במייל
    // (uc?export=view נחסם לעיתים ע"י מסך "סריקת וירוסים"). דורש שהקובץ
    // משותף ל"כל מי שיש לו הקישור".
    const src = `https://drive.google.com/thumbnail?id=${id}&sz=w1000`
    const alt = driveAlt.trim().replace(/"/g, '&quot;')
    const img = `<img src="${src}" alt="${alt}" width="468" style="display:block;width:100%;max-width:468px;height:auto;border-radius:8px;margin:8px 0 20px;"/>`
    insertAtCursor(img)
    setDriveLink('')
    setDriveAlt('')
    setDriveOpen(false)
    setBcResult({ kind: 'idle', text: '' })
  }

  function applyPreset(p: Preset) {
    setBcSubject(p.subject)
    setBcHeading(p.heading)
    setBcContent(p.contentHtml)
    setPresetName(p.name)
    setLoadedId(p.id)
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
        subject: bcSubject,
        heading: bcHeading,
        contentHtml: bcContent,
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
    if (!bcSubject.trim() || !bcHeading.trim() || !bcContent.trim()) {
      setBcResult({ kind: 'error', text: 'יש למלא subject + heading + תוכן HTML' })
      return
    }
    setBcBusy(true)
    try {
      const j = await adminApi<{
        recipientCount?: number
        sent?: number
        failed?: number
      }>('admin-send-marketing-email', {
        subject: bcSubject.trim(),
        heading: bcHeading.trim(),
        contentHtml: bcContent.trim(),
        dryRun,
      })
      if (dryRun) {
        setBcResult({
          kind: 'dry',
          text: `יש ${j.recipientCount ?? 0} משתמשים ברשימת התפוצה כרגע. לחץ "שלח לכולם" כדי לשלוח להם.`,
        })
      } else {
        setBcResult({
          kind: 'done',
          text: `הסתיים: ${j.sent ?? 0}/${j.recipientCount ?? 0} נשלחו, ${j.failed ?? 0} נכשלו.`,
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
    <Card title="שליחת מייל שיווקי">
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
        value={bcSubject}
        onChange={(e) => setBcSubject(e.target.value)}
        placeholder="נושא (Subject) — לדוגמה: 50% הנחה לסוף שבוע"
        disabled={bcBusy}
      />
      <Input
        value={bcHeading}
        onChange={(e) => setBcHeading(e.target.value)}
        placeholder="כותרת ראשית במייל (Heading)"
        disabled={bcBusy}
      />

      {/* ── סרגל בלוקים מעוצבים + תמונה ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {BLOCKS.map((b) => (
          <button
            key={b.key}
            type="button"
            disabled={bcBusy}
            onClick={() => insertAtCursor(b.html)}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <b.icon className="h-3.5 w-3.5" />
            {b.label}
          </button>
        ))}
        <button
          type="button"
          disabled={bcBusy}
          onClick={() => setDriveOpen((v) => !v)}
          className={
            'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 ' +
            (driveOpen
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-border bg-background/40 text-fg-muted hover:text-fg')
          }
        >
          <ImageIcon className="h-3.5 w-3.5" />
          תמונה מדרייב
        </button>
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="ms-auto inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {showPreview ? 'הסתר תצוגה' : 'תצוגה מקדימה'}
        </button>
      </div>

      {driveOpen && (
        <div className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-3">
          <p className="text-[11px] leading-relaxed text-fg-muted">
            הדבק קישור-שיתוף לתמונה מגוגל דרייב. חשוב: התמונה חייבת להיות משותפת
            ל"כל מי שיש לו הקישור", אחרת היא לא תוצג במייל.
          </p>
          <Input
            value={driveLink}
            onChange={(e) => setDriveLink(e.target.value)}
            placeholder="https://drive.google.com/file/d/.../view"
            dir="ltr"
          />
          <div className="flex gap-2">
            <Input
              value={driveAlt}
              onChange={(e) => setDriveAlt(e.target.value)}
              placeholder="תיאור התמונה (alt) — אופציונלי"
              className="flex-1"
            />
            <Button variant="secondary" size="sm" onClick={insertDriveImage} disabled={!driveLink.trim()}>
              <ImageIcon className="h-3.5 w-3.5" />
              הוסף
            </Button>
          </div>
        </div>
      )}

      <textarea
        ref={contentRef}
        value={bcContent}
        onChange={(e) => setBcContent(e.target.value)}
        placeholder='<p style="font-size:14px;line-height:1.7;color:#d1d5db;">תוכן ההודעה כאן...</p>'
        rows={8}
        disabled={bcBusy}
        dir="ltr"
        className="block w-full rounded-lg border border-border bg-input/60 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />

      {/* ── תצוגה מקדימה חיה ── */}
      {showPreview && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-background/40 px-3 py-1.5 text-[11px] text-fg-muted">
            תצוגה מקדימה — בדיוק כמו שהמייל ייראה אצל הנמען
          </div>
          <iframe
            title="תצוגה מקדימה של המייל"
            srcDoc={renderEmailPreview(bcHeading, bcContent)}
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
          כמה משתמשים יש ברשימה?
        </Button>
        <Button
          variant="gradient"
          size="sm"
          disabled={bcBusy}
          onClick={() => {
            if (
              window.confirm(
                'לשלוח את המייל לכל המשתמשים ברשימת התפוצה? אי אפשר לבטל אחרי שליחה.',
              )
            ) {
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
          שלח לכולם
        </Button>
      </div>
    </Card>
  )
}

/** מחלץ את מזהה-הקובץ מכל צורות קישור-השיתוף של גוגל דרייב. */
function extractDriveId(link: string): string | null {
  const s = link.trim()
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{20,})/, // /file/d/ID/view
    /[?&]id=([a-zA-Z0-9_-]{20,})/, // ?id=ID / uc?id=ID
    /\/d\/([a-zA-Z0-9_-]{20,})/, // /d/ID
  ]
  for (const p of patterns) {
    const m = s.match(p)
    if (m) return m[1]
  }
  // קישור שהוא כבר רק המזהה עצמו
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s
  return null
}
