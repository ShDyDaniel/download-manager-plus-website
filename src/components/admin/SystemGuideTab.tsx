import { useState } from 'react'
import {
  LifeBuoy,
  Copy,
  Check,
  Server,
  FolderOpen,
  AlertTriangle,
  Terminal as TerminalIcon,
  Wrench,
} from 'lucide-react'
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

interface Component {
  n: number
  name: string
  role: string
  mac: string
  win: string
  download?: string
  builtin?: boolean
}

const COMPONENTS: Component[] = [
  {
    n: 1,
    name: 'מנוע הורדות (yt-dlp)',
    role: 'מוריד סרטונים מ-YouTube, TikTok, Instagram ועוד. הבסיס של טאב "הורדת קבצים".',
    mac: 'vendor/ytdlp/darwin/yt-dlp',
    win: 'vendor/ytdlp/win32/yt-dlp.exe',
    download: 'https://github.com/yt-dlp/yt-dlp/releases/latest',
  },
  {
    n: 2,
    name: 'מקודד וידאו (ffmpeg)',
    role: 'המרות וידאו, כיווץ, מיזוג וידאו+אודיו בהורדות, המרת פורמטים.',
    mac: 'vendor/ffmpeg/darwin/arm64/ffmpeg',
    win: 'vendor/ffmpeg/win32/x64/ffmpeg.exe',
    download: 'https://ffmpeg.org/download.html',
  },
  {
    n: 3,
    name: 'בודק וידאו (ffprobe)',
    role: 'קריאת אורך, רזולוציה, קצב פריימים ואיכות. מגיע יחד עם ffmpeg.',
    mac: 'vendor/ffmpeg/darwin/arm64/ffprobe',
    win: 'vendor/ffmpeg/win32/x64/ffprobe.exe',
    download: 'מגיע באותה חבילה של ffmpeg (סעיף 2)',
  },
  {
    n: 4,
    name: 'מחלץ ארכיונים (7-Zip)',
    role: 'חילוץ ZIP · RAR · 7z · TAR שיורדים או מנותבים בתוכנה.',
    mac: 'vendor/7zip/darwin/7zz',
    win: 'vendor/7zip/win32/7z.exe  +  vendor/7zip/win32/7z.dll',
    download: 'https://www.7-zip.org/download.html',
  },
  {
    n: 5,
    name: 'מנוע סנכרון אודיו (resampler + ספריות שמע)',
    role: 'ליבת "סנכרון אוטומטי". קריטי: הבינארי חייב את ספריות-השמע שלידו — בלעדיהן הסנכרון נכשל בשקט (תוצאה שגויה במקום שגיאה).',
    mac: 'python/bin/resample_swr  +  python/Frameworks/libswresample.6.dylib  +  python/Frameworks/libavutil.60.dylib',
    win: 'python/bin/resample_swr.exe  +  python/bin/swresample-7.dll  +  python/bin/avutil-61.dll',
    builtin: true,
  },
  {
    n: 6,
    name: 'קובצי מנוע הסנכרון (Python)',
    role: 'לוגיקת טעינה → סנכרון → ייצוא של הטיימליין.',
    mac: 'python/sync_stdio.py · engine_faithful.py · resampler.py · fcpxml_in.py · fingerprint_reference.py · export_resolve.py',
    win: 'python/ (זהה למק)',
    builtin: true,
  },
  {
    n: 7,
    name: 'מנוע זיהוי אודיו (AI)',
    role: 'סקריפט זיהוי מוזיקה/אפקטים למצב ה-AI בסיווג אודיו.',
    mac: 'audio_classify.py  (ישירות תחת תיקיית הבסיס)',
    win: 'audio_classify.py  (ישירות תחת תיקיית הבסיס)',
    builtin: true,
  },
  {
    n: 8,
    name: 'פייטון 3.12 (מובנה)',
    role: 'מנוע ה-Python שמריץ סנכרון, תמלול ומצב AI. מובנה — אין התקנה אצל המשתמש.',
    mac: 'python-runtime/python/bin/python3.12',
    win: 'python-runtime/python/python.exe',
    download: 'https://github.com/astral-sh/python-build-standalone/releases (3.12.10 · תג 20250409)',
  },
  {
    n: 9,
    name: 'numpy (מובנה)',
    role: 'ספריית החישובים של מנוע הסנכרון. מותקנת מראש בפייטון המובנה.',
    mac: 'python-runtime/python/lib/python3.12/site-packages/numpy/',
    win: 'python-runtime/python/Lib/site-packages/numpy/',
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
    mac: '~/.dmp/transcribe/  (model/, corrections.jsonl, train.jsonl)',
    win: 'C:\\Users\\<user>\\.dmp\\transcribe\\',
  },
  {
    what: 'מודל Whisper ל-MLX (Mac בלבד — GPU של אפל)',
    mac: '~/.dmp/ivrit-mlx/',
    win: '— (Windows משתמש ב-faster-whisper תחת מטמון HF)',
  },
  {
    what: 'מטמון מודלים שירדו (Hugging Face)',
    mac: '~/.cache/huggingface/hub/',
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
    mac: '~/Library/Application Support/Download Manager Plus/',
    win: '%APPDATA%\\Download Manager Plus\\',
  },
  {
    what: 'לוג אבחון סנכרון',
    mac: '…/Download Manager Plus/sync-debug.log',
    win: '…\\Download Manager Plus\\sync-debug.log',
  },
  {
    what: 'לוגים (תמלול / זמן-עבודה)',
    mac: '…/Download Manager Plus/logs/transcribe|timetrack/',
    win: '…\\Download Manager Plus\\logs\\transcribe|timetrack\\',
  },
  {
    what: 'מטמון סנכרון (טביעות + אודיו)',
    mac: '…/Download Manager Plus/sync-fpcache/ · sync-audcache/',
    win: '…\\Download Manager Plus\\sync-fpcache\\ · sync-audcache\\',
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
    cause: 'התקנה פגומה — קובץ נמחק ע"י אנטי-וירוס או התקנה חלקית.',
    fix: `התקנה מחדש של התוכנה מ-${REINSTALL_URL} (לא הורדת קובץ בודד).`,
  },
  {
    symptom: 'הורדת דרייב יוצרת קובץ פגום / לא נפתח',
    cause: 'גרסה ישנה (לפני אימות md5). מגרסה 1.9.197 יש אימות שלמות + resume.',
    fix: 'לוודא שהלקוח על 1.9.197+. אם עדיין — לבדוק דיסק מלא / אנטי-וירוס שחוסם.',
  },
  {
    symptom: 'סנכרון אוטומטי נכשל / לא מסנכרן כלום',
    cause: 'ספריות-שמע חסרות ליד resample_swr (סעיף 5), או כמות עצומה של קבצים שממלאת דיסק.',
    fix: 'לבקש את sync-debug.log — שורת "fingerprints ok=X/N" מגלה אם טביעות נכשלו (דיסק מלא / זיכרון).',
  },
  {
    symptom: 'תמלול לא עובד / לא מפלח נכון',
    cause: 'מודלים לא ירדו (הפעלה ראשונה ללא אינטרנט) או מטמון פגום.',
    fix: 'לבדוק ~/.dmp/transcribe ו-~/.cache/huggingface. למחוק ולתת להוריד מחדש עם אינטרנט.',
  },
  {
    symptom: 'אין הפעלה / אימות מנוי / עדכונים',
    cause: 'אין גישה ל-dmplus.net — אינטרנט, חומת-אש/אנטי-וירוס, או VPN/פרוקסי.',
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

export default function SystemGuideTab() {
  return (
    <div className="space-y-5">
      <header>
        <h2 className="flex items-center gap-2 text-3xl font-bold font-display text-fg">
          <LifeBuoy className="h-7 w-7 text-accent" />
          מדריך מערכת
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          כל רכיב שהתוכנה משתמשת בו, איפה הוא יושב (Mac + Windows), פתרון תקלות, ואיפוס להפעלה-ראשונה.
        </p>
      </header>

      {/* intro note */}
      <div className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2.5 text-sm text-fg">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <span>
          רוב הרכיבים <b>מובנים בתוכנה</b> ותמיד אמורים להיות שם. אם רכיב מובנה חסר — ההתקנה
          פגומה, והפתרון הוא <b>התקנה מחדש</b> מ-
          <a href={REINSTALL_URL} target="_blank" rel="noopener" className="text-accent underline">
            dmplus.net
          </a>{' '}
          (לא הורדת קובץ בודד).
        </span>
      </div>

      {/* base locations */}
      <Card title="מיקומי הבסיס (תיקיית Resources)">
        <p className="text-[11px] text-fg-muted">כל הנתיבים ברכיבים למטה הם יחסית לתיקייה הזו.</p>
        <PathRow os="Mac" value="/Applications/Download Manager Plus.app/Contents/Resources/" />
        <PathRow os="Windows" value="C:\\Users\\<user>\\AppData\\Local\\Programs\\download-manager-plus\\resources\\" />
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
                <PathRow os="Mac" value={c.mac} />
                <PathRow os="Windows" value={c.win} />
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
                  <>הורדה ישירה: אין — אם חסר, התקנה מחדש של התוכנה.</>
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
            . אם אדום — אינטרנט / חומת-אש / VPN אצל הלקוח (לא רכיב שמתקינים).
          </span>
        </div>
      </Card>

      {/* transcription subsystem */}
      <Card title="תת-מערכת תמלול (מודלים שיורדים)">
        <p className="text-[11px] leading-relaxed text-fg-muted">
          מודלי התמלול/פילוח כבדים ולכן <b>יורדים בהפעלה ראשונה</b> (לא ארוזים). אם חסרים — בדוק אינטרנט
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
      <Card title="פתרון תקלות — זיהוי ← סיבה ← פתרון">
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
          מתיקיית העבודה (למעלה) — התוכנה תיווצר מחדש בהפעלה הבאה.
        </p>
      </Card>

      {/* quick procedure */}
      <Card title="נוהל טיפול מהיר">
        <ol className="list-inside list-decimal space-y-1 text-xs leading-relaxed text-fg">
          <li>הגדרות → בדיקת מערכת — לראות איזה רכיב אדום (חסר).</li>
          <li>רכיב מובנה חסר → התקנה מחדש מ-dmplus.net.</li>
          <li>חיבור לשרת אדום → אינטרנט / חומת-אש / VPN אצל הלקוח.</li>
          <li>סנכרון נכשל אבל הכל ירוק → לבקש את sync-debug.log לבדיקה.</li>
          <li>תמלול נכשל → לבדוק שהמודלים ירדו (~/.dmp/transcribe, מטמון HF).</li>
        </ol>
      </Card>
    </div>
  )
}
