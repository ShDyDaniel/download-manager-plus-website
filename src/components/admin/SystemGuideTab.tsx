import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LifeBuoy,
  Copy,
  Check,
  Server,
  FolderOpen,
  AlertTriangle,
  Terminal as TerminalIcon,
  Wrench,
  Radar,
  Loader2,
  X,
  RefreshCw,
  ShieldAlert,
  FileText,
  Download,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { buildZip } from '../../lib/zip'
import { Button } from '@/components/ui/Button'
import { Card } from './SettingsTab'

/**
 * Admin → מדריך מערכת (web). A static support reference: every component
 * the desktop app ships, where it lives on Mac + Windows, download links,
 * the writable work/cache folders, a per-symptom troubleshooting map, and
 * the terminal command to reset the app to "first run" (re-triggers the
 * onboarding tour). Pure reference — no server calls.
 *
 * Kept in sync with the desktop paths (electron/lib/transcription/runtime.ts,
 * store.ts, vendor/ + python/ layout) as of app v1.9.x.
 */

const REINSTALL_URL = 'https://dmplus.net'

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-fg"
      title="העתק"
    >
      {done ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      {label ?? (done ? 'הועתק' : 'העתק')}
    </button>
  )
}

/** A monospace path/command row, LTR so slashes + names read correctly. */
function PathRow({ os, value }: { os: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-16 shrink-0 text-[11px] text-fg-muted">{os}</span>
      <code
        dir="ltr"
        className="min-w-0 flex-1 truncate rounded bg-background/50 px-2 py-1 font-mono text-[11px] text-fg"
        title={value}
      >
        {value}
      </code>
      <CopyBtn text={value} label="" />
    </div>
  )
}

// Full absolute base paths — every component path below is spelled out in
// full so support can paste it straight into Finder/Explorer.
const MAC_BASE = '/Applications/Download Manager Plus.app/Contents/Resources/'
const WIN_BASE =
  'C:\\Users\\<user>\\AppData\\Local\\Programs\\download-manager-plus\\resources\\'
const MAC_DATA = '/Users/<user>/Library/Application Support/Download Manager Plus/'
const WIN_DATA = 'C:\\Users\\<user>\\AppData\\Roaming\\Download Manager Plus\\'

interface Component {
  n: number
  name: string
  role: string
  mac: string[]
  win: string[]
  download?: string
  builtin?: boolean
}

const COMPONENTS: Component[] = [
  {
    n: 1,
    name: 'מנוע הורדות (yt-dlp)',
    role: 'מוריד סרטונים מ-YouTube, TikTok, Instagram ועוד. הבסיס של טאב "הורדת קבצים".',
    mac: [`${MAC_BASE}vendor/ytdlp/darwin/yt-dlp`],
    win: [`${WIN_BASE}vendor\\ytdlp\\win32\\yt-dlp.exe`],
    download: 'https://github.com/yt-dlp/yt-dlp/releases/latest',
  },
  {
    n: 2,
    name: 'מקודד וידאו (ffmpeg)',
    role: 'המרות וידאו, כיווץ, מיזוג וידאו+אודיו בהורדות, המרת פורמטים.',
    mac: [`${MAC_BASE}vendor/ffmpeg/darwin/arm64/ffmpeg`],
    win: [`${WIN_BASE}vendor\\ffmpeg\\win32\\x64\\ffmpeg.exe`],
    download: 'https://ffmpeg.org/download.html',
  },
  {
    n: 3,
    name: 'בודק וידאו (ffprobe)',
    role: 'קריאת אורך, רזולוציה, קצב פריימים ואיכות. מגיע יחד עם ffmpeg.',
    mac: [`${MAC_BASE}vendor/ffmpeg/darwin/arm64/ffprobe`],
    win: [`${WIN_BASE}vendor\\ffmpeg\\win32\\x64\\ffprobe.exe`],
    download: 'מגיע באותה חבילה של ffmpeg (סעיף 2)',
  },
  {
    n: 4,
    name: 'מחלץ ארכיונים (7-Zip)',
    role: 'חילוץ ZIP · RAR · 7z · TAR שיורדים או מנותבים בתוכנה.',
    mac: [`${MAC_BASE}vendor/7zip/darwin/7zz`],
    win: [`${WIN_BASE}vendor\\7zip\\win32\\7z.exe`, `${WIN_BASE}vendor\\7zip\\win32\\7z.dll`],
    download: 'https://www.7-zip.org/download.html',
  },
  {
    n: 5,
    name: 'מנוע סנכרון אודיו (resampler + ספריות שמע)',
    role: 'ליבת "סנכרון אוטומטי". קריטי: הבינארי חייב את ספריות-השמע שלידו. בלעדיהן הסנכרון נכשל בשקט (תוצאה שגויה במקום שגיאה).',
    mac: [
      `${MAC_BASE}python/bin/resample_swr`,
      `${MAC_BASE}python/Frameworks/libswresample.6.dylib`,
      `${MAC_BASE}python/Frameworks/libavutil.60.dylib`,
    ],
    win: [
      `${WIN_BASE}python\\bin\\resample_swr.exe`,
      `${WIN_BASE}python\\bin\\swresample-7.dll`,
      `${WIN_BASE}python\\bin\\avutil-61.dll`,
    ],
    builtin: true,
  },
  {
    n: 6,
    name: 'קובצי מנוע הסנכרון (Python)',
    role: 'לוגיקת טעינה → סנכרון → ייצוא. קבצים: sync_stdio.py · engine_faithful.py · resampler.py · fcpxml_in.py · fingerprint_reference.py · export_resolve.py',
    mac: [`${MAC_BASE}python/`],
    win: [`${WIN_BASE}python\\`],
    builtin: true,
  },
  {
    n: 7,
    name: 'מנוע זיהוי אודיו (AI)',
    role: 'סקריפט זיהוי מוזיקה/אפקטים למצב ה-AI בסיווג אודיו (ישירות תחת תיקיית הבסיס).',
    mac: [`${MAC_BASE}audio_classify.py`],
    win: [`${WIN_BASE}audio_classify.py`],
    builtin: true,
  },
  {
    n: 8,
    name: 'פייטון 3.12 (מובנה)',
    role: 'מנוע ה-Python שמריץ סנכרון, תמלול ומצב AI. מובנה, אין התקנה אצל המשתמש.',
    mac: [`${MAC_BASE}python-runtime/python/bin/python3.12`],
    win: [`${WIN_BASE}python-runtime\\python\\python.exe`],
    download: 'https://github.com/astral-sh/python-build-standalone/releases (3.12.10 · תג 20250409)',
  },
  {
    n: 9,
    name: 'numpy (מובנה)',
    role: 'ספריית החישובים של מנוע הסנכרון. מותקנת מראש בפייטון המובנה.',
    mac: [`${MAC_BASE}python-runtime/python/lib/python3.12/site-packages/numpy/`],
    win: [`${WIN_BASE}python-runtime\\python\\Lib\\site-packages\\numpy\\`],
    builtin: true,
  },
]

interface TranscriptRow {
  what: string
  mac: string
  win: string
}
const TRANSCRIBE: TranscriptRow[] = [
  {
    what: 'מודל הפילוח (כתוביות) + תיקונים + דאטת-אימון',
    mac: '/Users/<user>/.dmp/transcribe/',
    win: 'C:\\Users\\<user>\\.dmp\\transcribe\\',
  },
  {
    what: 'מודל Whisper ל-MLX (Mac בלבד, GPU של אפל)',
    mac: '/Users/<user>/.dmp/ivrit-mlx/',
    win: 'לא רלוונטי (Windows משתמש ב-faster-whisper תחת מטמון HF)',
  },
  {
    what: 'מטמון מודלים שירדו (Hugging Face)',
    mac: '/Users/<user>/.cache/huggingface/hub/',
    win: 'C:\\Users\\<user>\\.cache\\huggingface\\hub\\',
  },
]

interface WorkFolder {
  what: string
  mac: string
  win: string
}
const WORK_FOLDERS: WorkFolder[] = [
  {
    what: 'נתונים + הגדרות (config.json) + מטמון + לוגים',
    mac: MAC_DATA,
    win: WIN_DATA,
  },
  {
    what: 'לוג אבחון סנכרון',
    mac: `${MAC_DATA}sync-debug.log`,
    win: `${WIN_DATA}sync-debug.log`,
  },
  {
    what: 'לוגים (תמלול / זמן-עבודה)',
    mac: `${MAC_DATA}logs/transcribe/  ·  ${MAC_DATA}logs/timetrack/`,
    win: `${WIN_DATA}logs\\transcribe\\  ·  ${WIN_DATA}logs\\timetrack\\`,
  },
  {
    what: 'מטמון סנכרון (טביעות + אודיו)',
    mac: `${MAC_DATA}sync-fpcache/  ·  ${MAC_DATA}sync-audcache/`,
    win: `${WIN_DATA}sync-fpcache\\  ·  ${WIN_DATA}sync-audcache\\`,
  },
]

interface Trouble {
  symptom: string
  cause: string
  fix: string
}
const TROUBLES: Trouble[] = [
  {
    symptom: 'רכיב מובנה חסר (yt-dlp / ffmpeg / 7-Zip / סנכרון / פייטון / numpy)',
    cause: 'התקנה פגומה: קובץ נמחק ע"י אנטי-וירוס או התקנה חלקית.',
    fix: `התקנה מחדש של התוכנה מ-${REINSTALL_URL} (לא הורדת קובץ בודד).`,
  },
  {
    symptom: 'הורדת דרייב יוצרת קובץ פגום / לא נפתח',
    cause: 'גרסה ישנה (לפני אימות md5). מגרסה 1.9.197 יש אימות שלמות + resume.',
    fix: 'לוודא שהלקוח על 1.9.197+. אם עדיין, לבדוק דיסק מלא / אנטי-וירוס שחוסם.',
  },
  {
    symptom: 'סנכרון אוטומטי נכשל / לא מסנכרן כלום',
    cause: 'ספריות-שמע חסרות ליד resample_swr (סעיף 5), או כמות עצומה של קבצים שממלאת דיסק.',
    fix: 'לבקש את sync-debug.log. שורת "fingerprints ok=X/N" מגלה אם טביעות נכשלו (דיסק מלא / זיכרון).',
  },
  {
    symptom: 'תמלול לא עובד / לא מפלח נכון',
    cause: 'מודלים לא ירדו (הפעלה ראשונה ללא אינטרנט) או מטמון פגום.',
    fix: 'לבדוק ~/.dmp/transcribe ו-~/.cache/huggingface. למחוק ולתת להוריד מחדש עם אינטרנט.',
  },
  {
    symptom: 'אין הפעלה / אימות מנוי / עדכונים',
    cause: 'אין גישה ל-dmplus.net: אינטרנט, חומת-אש/אנטי-וירוס, או VPN/פרוקסי.',
    fix: 'לבדוק שהלקוח מגיע ל-https://dmplus.net מהדפדפן; לבטל חסימות.',
  },
  {
    symptom: 'הכתוביות/וידאו לא נכנסות לטיימליין בעורך',
    cause: 'הגשר של פרימייר צריך הפעלה-מחדש, או Resolve חינמי שחוסם סקריפטים (דרוש Studio).',
    fix: 'להפעיל מחדש את העורך; ב-Resolve לוודא מהדורת Studio.',
  },
]

const MAC_RESET = `osascript -e 'quit app "Download Manager Plus"'; sleep 1; python3 - <<'PY'
import json, os
p = os.path.expanduser("~/Library/Application Support/Download Manager Plus/config.json")
d = json.load(open(p)); s = d.setdefault("settings", {})
s["onboardingTourDone"] = False; s["onboardingTourStep"] = -1; s["onboardingTourId"] = ""
json.dump(d, open(p, "w")); print("done — reopen the app")
PY`

const WIN_RESET = `Stop-Process -Name "Download Manager Plus" -Force -ErrorAction SilentlyContinue
$p = "$env:APPDATA\\Download Manager Plus\\config.json"
$j = Get-Content $p -Raw | ConvertFrom-Json
$j.settings | Add-Member onboardingTourDone $false -Force
$j.settings | Add-Member onboardingTourStep -1 -Force
$j.settings | Add-Member onboardingTourId "" -Force
$j | ConvertTo-Json -Depth 30 | Set-Content $p`

/* ── בדיקת מערכת מרחוק ── */
interface CheckResult {
  id: string
  label: string
  ok: boolean
  detail?: string
}
interface CheckDoc {
  status: 'pending' | 'done'
  results?: CheckResult[]
  meta?: Record<string, unknown>
  logs?: Record<string, string>
  reportedAt?: string
}

function RemoteCheckCard({ onAuthExpired }: { onAuthExpired?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<{ code: string; url: string } | null>(null)
  const [doc, setDoc] = useState<CheckDoc | null>(null)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  useEffect(() => stopPoll, [])

  const poll = useCallback(
    async (code: string) => {
      try {
        const j = await adminApi<{ check?: CheckDoc }>('admin-syscheck-get', { code })
        if (j.check) {
          setDoc(j.check)
          if (j.check.status === 'done') stopPoll()
        }
      } catch (e) {
        const er = e as Error & { code?: string }
        if (er.code === 'auth') {
          stopPoll()
          onAuthExpired?.()
        }
      }
    },
    [onAuthExpired],
  )

  async function createLink() {
    setBusy(true)
    setErr('')
    setDoc(null)
    stopPoll()
    try {
      const j = await adminApi<{ code: string; url: string }>('admin-syscheck-create', {})
      setLink({ code: j.code, url: j.url })
      pollRef.current = setInterval(() => void poll(j.code), 4000)
    } catch (e) {
      const er = e as Error & { code?: string }
      if (er.code === 'auth') return onAuthExpired?.()
      setErr(er.message || 'יצירת הקישור נכשלה')
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore */
    }
  }

  const results = doc?.results ?? []
  const failed = results.filter((r) => !r.ok)

  // One-click: bundle EVERYTHING (machine details + checks + all logs + raw
  // JSON) into a single .zip, so the whole report can be sent for review
  // instead of eyeballing it tab-by-tab.
  function downloadAll() {
    if (!doc) return
    const enc = new TextEncoder()
    const entries: { name: string; data: Uint8Array }[] = []
    const add = (name: string, content: string) =>
      entries.push({ name, data: enc.encode(content) })

    if (doc.meta && Object.keys(doc.meta).length)
      add(
        'פרטי-מכונה.txt',
        Object.entries(doc.meta)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join('\n'),
      )
    add(
      'בדיקות.txt',
      results
        .map(
          (r) =>
            `${r.ok ? '[תקין] ' : '[נכשל] '} ${r.label}${
              r.detail ? `\n         ${r.detail}` : ''
            }`,
        )
        .join('\n'),
    )
    for (const [name, content] of Object.entries(doc.logs ?? {}))
      add(`logs/${name}`, content)
    add('report.json', JSON.stringify(doc, null, 2))

    const idRaw = String(doc.meta?.['מזהה מכשיר'] ?? '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(buildZip(entries))
    a.download = `dmplus-syscheck-${idRaw || 'report'}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Card title="בדיקת מערכת מרחוק (תמיכה)">
      <p className="text-[11px] leading-relaxed text-fg-muted">
        צור קישור ושלח ללקוח. בלחיצה, התוכנה נפתחת אצלו, מריצה בדיקה מלאה של כל
        הרכיבים (הוא רק מאשר), והתוצאה חוזרת לכאן: בדיוק מה עובד ומה לא.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="gradient" size="sm" onClick={() => void createLink()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
          צור קישור בדיקה
        </Button>
        {link && (
          <span className="text-[11px] text-fg-muted">תקף 24 שעות · קוד חד-פעמי</span>
        )}
      </div>

      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </div>
      )}

      {link && (
        <div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
          <div className="flex items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 truncate rounded bg-background/60 px-2 py-1.5 font-mono text-xs text-fg">
              {link.url}
            </code>
            <button
              type="button"
              onClick={() => void copy(link.url)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted hover:text-fg"
            >
              {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              העתק קישור
            </button>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-fg-muted">
            קוד ידני:{' '}
            <code dir="ltr" className="rounded bg-background/60 px-1.5 py-0.5 font-mono tracking-widest text-fg">
              {link.code}
            </code>
          </div>

          {(!doc || doc.status === 'pending') && (
            <div className="flex items-center gap-2 text-xs text-accent">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ממתין שהלקוח יריץ את הבדיקה…
            </div>
          )}
        </div>
      )}

      {/* results */}
      {doc?.status === 'done' && (
        <div className="space-y-2">
          <div
            className={
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ' +
              (failed.length === 0
                ? 'border border-success/40 bg-success/10 text-success'
                : 'border border-destructive/40 bg-destructive/10 text-destructive')
            }
          >
            {failed.length === 0 ? (
              <>
                <Check className="h-4 w-4" /> הכול תקין · {results.length} רכיבים עברו
              </>
            ) : (
              <>
                <ShieldAlert className="h-4 w-4" /> {failed.length} רכיבים נכשלו מתוך {results.length}
              </>
            )}
            <div className="ms-auto flex items-center gap-3">
              <button
                type="button"
                onClick={downloadAll}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-accent opacity-90 hover:opacity-100"
                title="הורדת כל הנתונים (פרטי מכונה + בדיקות + לוגים) כקובץ ZIP אחד"
              >
                <Download className="h-3 w-3" /> הורד הכול (ZIP)
              </button>
              <button
                type="button"
                onClick={() => link && void poll(link.code)}
                className="inline-flex items-center gap-1 text-[11px] font-normal opacity-70 hover:opacity-100"
                title="רענן"
              >
                <RefreshCw className="h-3 w-3" /> רענן
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            {results.map((r) => (
              <div
                key={r.id}
                className="flex items-start gap-2 border-b border-border/50 px-3 py-2 last:border-0"
              >
                {r.ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-fg">{r.label}</div>
                  {r.detail && (
                    <code dir="ltr" className="mt-0.5 block truncate font-mono text-[11px] text-fg-muted" title={r.detail}>
                      {r.detail}
                    </code>
                  )}
                </div>
              </div>
            ))}
          </div>

          {doc.meta && Object.keys(doc.meta).length > 0 && (
            <div className="rounded-xl border border-border bg-background/40 p-3">
              <div className="mb-1 text-[11px] font-medium text-fg-muted">פרטי מכונה</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {Object.entries(doc.meta).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 text-[11px]">
                    <span className="text-fg-muted">{k}</span>
                    <span dir="ltr" className="truncate font-mono text-fg" title={String(v)}>
                      {String(v)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {doc.logs && Object.keys(doc.logs).length > 0 && (
            <LogViewer logs={doc.logs} />
          )}
        </div>
      )}
    </Card>
  )
}

/** Pro-only log tails (sync / transcription / time-track). Collapsible +
 *  downloadable so the admin can inspect what actually failed on the machine. */
function LogViewer({ logs }: { logs: Record<string, string> }) {
  const names = Object.keys(logs)
  const [active, setActive] = useState(names[0] || '')
  const text = logs[active] || ''
  const download = () => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = active
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
          <FileText className="h-3.5 w-3.5" />
          לוגים (Pro)
        </div>
        <button
          onClick={download}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-accent hover:bg-accent/10"
        >
          <Download className="h-3 w-3" />
          הורדה
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {names.map((n) => (
          <button
            key={n}
            onClick={() => setActive(n)}
            className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${
              n === active
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-background'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <pre
        dir="ltr"
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-2 font-mono text-[10px] leading-relaxed text-fg-muted"
      >
        {text || '(ריק)'}
      </pre>
    </div>
  )
}

function RemoteSupportCard({ onAuthExpired }: { onAuthExpired?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [withCmd, setWithCmd] = useState(false)

  async function createLink() {
    setBusy(true)
    setErr('')
    try {
      const { ensureStepUp } = await import('../../lib/adminApi')
      const stepUpToken = await ensureStepUp()
      const r = await fetch('/api/revisions?action=support-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // This step-up (a real passkey verification) is what authorises command
        // execution for the whole session — the user still gives a second consent.
        body: JSON.stringify({ stepUpToken, cmd: withCmd }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; code?: string; viewToken?: string; error?: string }
      if (!j.ok || !j.code) {
        if (r.status === 403) return onAuthExpired?.()
        throw new Error(j.error || 'failed')
      }
      // Open the dedicated live-session page in its own tab. The session-scoped
      // view token rides in the URL fragment (client-only) so that page needs
      // no per-tab admin session or repeated passkey.
      window.open(`/admin/support/${j.code}#t=${encodeURIComponent(j.viewToken || '')}`, '_blank', 'noopener')
    } catch (e) {
      setErr((e as Error).message || 'יצירת הקישור נכשלה')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="תמיכה מרחוק — לוגים, מסך חי ופקודות">
      <p className="text-[11px] leading-relaxed text-fg-muted">
        צור קישור ושלח ללקוח. הוא מאשר פעם אחת, והתוכנה משדרת לכאן בזמן אמת את כל
        קובצי היומן (לוגים) וצילומי מסך חיים. הכל נפתח בדף ייעודי חדש — עם צפייה
        חיה, רענון, הורדה ועצירה.
      </p>
      <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-relaxed text-fg-muted">
        <input
          type="checkbox"
          checked={withCmd}
          onChange={(e) => setWithCmd(e.target.checked)}
          className="mt-0.5 accent-amber-500"
        />
        <span>
          <span className="font-semibold text-amber-500">כלול הרשאת הרצת פקודות (מתקדם)</span>
          {' '}— האימות שלך עכשיו מאשר את היכולת להריץ פקודות מערכת במחשב הלקוח. הלקוח יתבקש לאשר זאת בנפרד בתוכנה.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="gradient" size="sm" onClick={() => void createLink()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LifeBuoy className="h-3.5 w-3.5" />}
          צור קישור תמיכה
        </Button>
        <span className="text-[11px] text-fg-muted">נפתח בטאב חדש</span>
      </div>
      {err && <p className="text-[11px] text-red-400">{err}</p>}
    </Card>
  )
}

export default function SystemGuideTab({
  onAuthExpired,
}: {
  onAuthExpired?: () => void
}) {
  return (
    <div className="space-y-5">
      <header>
        <h2 className="flex items-center gap-2 text-3xl font-bold font-display text-fg">
          <LifeBuoy className="h-7 w-7 text-accent" />
          מדריך מערכת
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          בדיקת-מערכת מרחוק, כל רכיב ואיפה הוא יושב (Mac + Windows), פתרון תקלות, ואיפוס להפעלה-ראשונה.
        </p>
      </header>

      <RemoteCheckCard onAuthExpired={onAuthExpired} />
      <RemoteSupportCard onAuthExpired={onAuthExpired} />

      {/* intro note */}
      <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2.5 text-sm text-fg">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <span>
          רוב הרכיבים <b>מובנים בתוכנה</b> ותמיד אמורים להיות שם. אם רכיב מובנה חסר, ההתקנה
          פגומה, והפתרון הוא <b>התקנה מחדש</b> מ-
          <a href={REINSTALL_URL} target="_blank" rel="noopener" className="text-accent underline">
            dmplus.net
          </a>{' '}
          (לא הורדת קובץ בודד).
        </span>
      </div>

      {/* base locations */}
      <Card title="מיקומי הבסיס (תיקיית Resources)">
        <p className="text-[11px] text-fg-muted">
          תיקיית-האם של הרכיבים. הנתיבים בכל רכיב למטה כבר <b>מלאים</b> (מוכנים להדבקה ב-Finder/Explorer).
          החליפו <code dir="ltr" className="font-mono">{'<user>'}</code> בשם המשתמש של הלקוח.
        </p>
        <PathRow os="Mac" value={MAC_BASE} />
        <PathRow os="Windows" value={WIN_BASE} />
      </Card>

      {/* components */}
      <Card title="רכיבי המערכת">
        <div className="space-y-3">
          {COMPONENTS.map((c) => (
            <div key={c.n} className="rounded-xl border border-border bg-background/30 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/15 text-[11px] font-semibold text-accent">
                  {c.n}
                </span>
                <span className="text-sm font-semibold text-fg">{c.name}</span>
                {c.builtin && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-fg-muted">
                    מובנה
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{c.role}</p>
              <div className="mt-2">
                {c.mac.map((p, i) => (
                  <PathRow key={`m${i}`} os={i === 0 ? 'Mac' : ''} value={p} />
                ))}
                {c.win.map((p, i) => (
                  <PathRow key={`w${i}`} os={i === 0 ? 'Windows' : ''} value={p} />
                ))}
              </div>
              <div className="mt-1.5 text-[11px] text-fg-muted">
                {c.download ? (
                  c.download.startsWith('http') ? (
                    <>
                      הורדה:{' '}
                      <a href={c.download} target="_blank" rel="noopener" className="text-accent underline" dir="ltr">
                        {c.download}
                      </a>
                    </>
                  ) : (
                    <>הורדה: {c.download}</>
                  )
                ) : (
                  <>הורדה ישירה: אין. אם חסר, התקנה מחדש של התוכנה.</>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* server */}
      <Card title="חיבור לשרת (dmplus.net)">
        <div className="flex items-start gap-2 text-sm text-fg">
          <Server className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            הפעלה/אימות מנוי, עדכונים, סבבי-תיקונים, מסירות, הצעות-מחיר. בדיקת נגישות:{' '}
            <code dir="ltr" className="rounded bg-background/50 px-1.5 py-0.5 font-mono text-[11px]">
              https://dmplus.net
            </code>
            . אם אדום: אינטרנט / חומת-אש / VPN אצל הלקוח (לא רכיב שמתקינים).
          </span>
        </div>
      </Card>

      {/* transcription subsystem */}
      <Card title="תת-מערכת תמלול (מודלים שיורדים)">
        <p className="text-[11px] leading-relaxed text-fg-muted">
          מודלי התמלול/פילוח כבדים ולכן <b>יורדים בהפעלה ראשונה</b> (לא ארוזים). אם חסרים, בדוק אינטרנט
          בהפעלה הראשונה; אפשר למחוק את התיקיות ולתת להוריד מחדש.
        </p>
        {TRANSCRIBE.map((t, i) => (
          <div key={i} className="rounded-lg border border-border bg-background/30 p-2">
            <div className="text-xs font-medium text-fg">{t.what}</div>
            <PathRow os="Mac" value={t.mac} />
            <PathRow os="Windows" value={t.win} />
          </div>
        ))}
      </Card>

      {/* work folders */}
      <Card title="תיקיות עבודה + לוגים (לתמיכה)">
        <div className="flex items-center gap-2 text-[11px] text-fg-muted">
          <FolderOpen className="h-3.5 w-3.5" /> איפה יושבים ההגדרות, המטמון והלוגים.
        </div>
        {WORK_FOLDERS.map((w, i) => (
          <div key={i} className="rounded-lg border border-border bg-background/30 p-2">
            <div className="text-xs font-medium text-fg">{w.what}</div>
            <PathRow os="Mac" value={w.mac} />
            <PathRow os="Windows" value={w.win} />
          </div>
        ))}
      </Card>

      {/* troubleshooting */}
      <Card title="פתרון תקלות · זיהוי ← סיבה ← פתרון">
        <div className="space-y-2">
          {TROUBLES.map((t, i) => (
            <div key={i} className="rounded-xl border border-border bg-background/30 p-3">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Wrench className="h-3.5 w-3.5 text-accent" />
                {t.symptom}
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                <span className="text-fg-muted">סיבה סבירה: </span>
                {t.cause}
              </div>
              <div className="mt-1 text-xs text-success">
                <span>פתרון: </span>
                {t.fix}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* first-run reset */}
      <Card title='איפוס להפעלה-ראשונה (הדרכה מחדש)'>
        <p className="text-[11px] leading-relaxed text-fg-muted">
          מפעיל מחדש את שאלת ה"התחל הדרכה?" כאילו זו פתיחה ראשונה. <b>סוגר את התוכנה</b> ואז מאפס את הדגל
          (שאר ההגדרות נשמרות). הרץ בטרמינל, ואז פתח את התוכנה מחדש.
        </p>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-fg">
            <TerminalIcon className="h-3.5 w-3.5 text-accent" /> Mac — Terminal
            <span className="ms-auto">
              <CopyBtn text={MAC_RESET} />
            </span>
          </div>
          <pre dir="ltr" className="overflow-x-auto rounded-lg border border-border bg-background/50 p-2.5 font-mono text-[11px] leading-relaxed text-fg">
            {MAC_RESET}
          </pre>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-fg">
            <TerminalIcon className="h-3.5 w-3.5 text-accent" /> Windows — PowerShell
            <span className="ms-auto">
              <CopyBtn text={WIN_RESET} />
            </span>
          </div>
          <pre dir="ltr" className="overflow-x-auto rounded-lg border border-border bg-background/50 p-2.5 font-mono text-[11px] leading-relaxed text-fg">
            {WIN_RESET}
          </pre>
        </div>

        <p className="text-[11px] text-fg-muted">
          איפוס מלא (מוחק גם העדפות): סגור את התוכנה ומחק את הקובץ{' '}
          <code dir="ltr" className="rounded bg-background/50 px-1 py-0.5 font-mono">config.json</code>{' '}
          מתיקיית העבודה (למעלה). התוכנה תיווצר מחדש בהפעלה הבאה.
        </p>
      </Card>

      {/* quick procedure */}
      <Card title="נוהל טיפול מהיר">
        <ol className="list-inside list-decimal space-y-1 text-xs leading-relaxed text-fg">
          <li>הגדרות → בדיקת מערכת, לראות איזה רכיב אדום (חסר).</li>
          <li>רכיב מובנה חסר → התקנה מחדש מ-dmplus.net.</li>
          <li>חיבור לשרת אדום → אינטרנט / חומת-אש / VPN אצל הלקוח.</li>
          <li>סנכרון נכשל אבל הכל ירוק → לבקש את sync-debug.log לבדיקה.</li>
          <li>תמלול נכשל → לבדוק שהמודלים ירדו (~/.dmp/transcribe, מטמון HF).</li>
        </ol>
      </Card>
    </div>
  )
}
