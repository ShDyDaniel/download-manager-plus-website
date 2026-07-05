import { useEffect, useRef, useState } from 'react'
import {
  Loader2,
  AlertTriangle,
  Plus,
  Trash2,
  Send,
  Save,
  Sparkles,
  CheckCircle,
  GripVertical,
  Crown,
  ChevronDown,
  Terminal,
  Fingerprint,
  Cloud,
  ArrowUp,
  ArrowDown,
  ShieldAlert,
  Power,
} from 'lucide-react'
import {
  adminApi,
  getAdminIdToken,
  listPasskeys,
  registerPasskey,
  deletePasskey,
  type PasskeyInfo,
} from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'

/**
 * Admin → Settings (web). Beta mode, plan mode, terms + privacy
 * editors, and email tools. Pricing is intentionally NOT here — it
 * touches PayPal plan sync and stays in the desktop panel.
 */

interface Section {
  title: string
  paragraphs: string[]
}

/** Built-in accessibility statement, used to SEED the editor the first
 *  time (before anything is published to appConfig/accessibility). Each
 *  bullet is its own paragraph so it's individually movable. Mirrors the
 *  fallback text in AccessibilityModal.tsx. */
const ACCESSIBILITY_DEFAULT: { lastUpdated: string; sections: Section[] } = {
  lastUpdated: 'יוני 2026',
  sections: [
    {
      title: 'המחויבות שלנו',
      paragraphs: [
        'אתר "ניהול הורדות פלוס" (dmplus.net) רואה חשיבות רבה במתן שירות שוויוני לכלל המשתמשים, ופועל להנגיש את האתר כך שיהיה נגיש גם לאנשים עם מוגבלות. אנו משקיעים מאמצים ומשאבים על מנת לאפשר גלישה נוחה ושוויונית ככל הניתן.',
      ],
    },
    {
      title: 'רמת הנגישות באתר',
      paragraphs: [
        'האתר הונגש בהתאם להוראות תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע"ג–2013, ובכפוף לתקן הישראלי ת"י 5568 המבוסס על הנחיות WCAG 2.0 ברמה AA, ככל שניתן.',
      ],
    },
    {
      title: 'מה הונגש באתר',
      paragraphs: [
        'תפריט נגישות צף הזמין מכל עמוד באתר.',
        'התאמות הניתנות להפעלה: הגדלת/הקטנת טקסט, ניגודיות גבוהה, היפוך צבעים, גווני אפור, הדגשת קישורים, גופן קריא, ריווח טקסט מוגדל, עצירת אנימציות, סמן עכבר גדול והדגשת מיקוד מקלדת.',
        'ניווט מלא באמצעות מקלדת וסדר טאבים הגיוני.',
        'מבנה כותרות סמנטי ותוויות לרכיבי הטופס.',
        'תאימות לקוראי מסך נפוצים.',
        'שמירת ההעדפות של המשתמש בין עמודים וביקורים.',
      ],
    },
    {
      title: 'הסתייגות ומגבלות ידועות',
      paragraphs: [
        'למרות מאמצינו להנגיש את כלל הדפים והרכיבים, ייתכן שיימצאו חלקים שטרם הונגשו במלואם או שאינם נתמכים באופן מיטבי בכל הדפדפנים והטכנולוגיות המסייעות. אנו ממשיכים לפעול לשיפור הנגישות באופן שוטף.',
      ],
    },
    {
      title: 'פנייה בנושא נגישות',
      paragraphs: [
        'נתקלתם בבעיית נגישות, או שיש לכם הצעה לשיפור? נשמח לקבל פנייה בכתובת help.dm.plus@gmail.com ונטפל בה בהקדם.',
      ],
    },
  ],
}

/** Built-in partner-terms (תקנון שותפים), used to SEED the editor the
 *  first time (before anything is published to appConfig/partnerTerms).
 *  Mirrors the fallback copy in PartnerPage.tsx so the admin starts from
 *  the real text and just hits "שמור ופרסם". */
const PARTNER_TERMS_DEFAULT: { lastUpdated: string; sections: Section[] } = {
  lastUpdated: 'יוני 2026',
  sections: [
    {
      title: 'ברוכים הבאים',
      paragraphs: [
        'ברוכים הבאים לתוכנית השותפים של "ניהול הורדות פלוס". התקנון להלן מסדיר את היחסים בינך לבין החברה כשותף/ה.',
      ],
    },
    {
      title: '1. שיוך מכירות',
      paragraphs: [
        'מכירה תזוכה לך רק כאשר הלקוח נכנס דרך קישור ההפניה האישי שלך וביצע רכישה בפועל. החברה רשאית לבדוק ולאמת כל שיוך.',
      ],
    },
    {
      title: '2. עמלות',
      paragraphs: [
        'גובה העמלה ואופן חישובה נקבעים בהסכם האישי שלך כפי שמוצג בדשבורד. העמלה מחושבת על הסכום שנותר בפועל לאחר עמלת הסליקה ולאחר מע"מ, ומשולמת על עסקאות שלא בוטלו או הוחזרו.',
      ],
    },
    {
      title: '3. תשלומים',
      paragraphs: [
        'תשלום העמלות יבוצע במועדים ובאמצעים שתיאמת עם החברה. עסקה שבוטלה, הוחזרה (chargeback) או לא נגבתה — לא תזכה בעמלה, ותקוזז אם כבר שולמה.',
      ],
    },
    {
      title: '4. שיווק הוגן',
      paragraphs: [
        'אין לפרסם את המוצר בדרכים מטעות, ספאם, או הבטחות שווא, ואין להשתמש במותג החברה באופן שאינו מאושר. החברה רשאית להפסיק את השותפות בגין הפרה.',
      ],
    },
    {
      title: '5. סודיות ופרטיות',
      paragraphs: [
        'נתוני הדשבורד מיועדים לך בלבד. אינך רשאי/ת לחשוף נתונים, רשימות לקוחות או מידע עסקי של החברה.',
      ],
    },
    {
      title: '6. סיום',
      paragraphs: [
        'כל צד רשאי לסיים את השותפות בכל עת. עמלות שנצברו כדין עד מועד הסיום ישולמו בהתאם לתקנון.',
      ],
    },
    {
      title: '7. שינויים',
      paragraphs: [
        'החברה רשאית לעדכן את התקנון מעת לעת. המשך שימוש בדשבורד לאחר עדכון מהווה הסכמה לתנאים המעודכנים.',
      ],
    },
    {
      title: 'אישור',
      paragraphs: ['אישור התקנון מהווה הסכמה מלאה לכל האמור לעיל.'],
    },
  ],
}

const TEST_EMAILS: { kind: string; label: string }[] = [
  { kind: 'verify-signup', label: 'קוד אימות הרשמה' },
  { kind: 'verify-existing', label: 'קוד אימות למשתמש קיים' },
  { kind: 'welcome-subscription', label: 'ברוכים הבאים — מנוי' },
  { kind: 'pro-activated', label: 'אישור הפעלת Pro' },
  { kind: 'cancellation', label: 'אישור ביטול מנוי' },
  { kind: 'capture-key', label: 'מפתח לאחר רכישה (legacy)' },
  { kind: 'reset-password', label: 'איפוס סיסמה' },
  { kind: 'renewal-extension', label: 'הארכת מנוי' },
  { kind: 'expiry-reminder', label: 'תזכורת לפני פקיעה' },
  { kind: 'annual-report', label: 'סיכום חיובים שנתי' },
  { kind: 'payment-failed', label: 'כשל בחיוב מנוי' },
  { kind: 'plan-switch', label: 'החלפת מסלול (חודשי/שנתי)' },
  { kind: 'purge-warning-subscription', label: 'אזהרת מחיקת סבבים — מנוי שהסתיים' },
  { kind: 'purge-warning-trial', label: 'אזהרת מחיקת סבבים — ניסיון שהסתיים' },
]

export default function SettingsTab({
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
        <h2 className="text-3xl font-bold font-display text-fg">הגדרות</h2>
        <p className="mt-1 text-sm text-fg-muted">
          מצב בטא, מודל תמחור, מסמכים משפטיים וכלי דיוור.
        </p>
      </header>
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      <AppConfigCard onErr={handleErr} />
      <ProtectionCard onErr={handleErr} />
      <PopupCard onErr={handleErr} />
      <PasskeysCard onErr={handleErr} />
      <LegalCard kind="terms" title="תנאי שימוש" onErr={handleErr} />
      <LegalCard kind="privacy" title="מדיניות פרטיות" onErr={handleErr} />
      <LegalCard kind="accessibility" title="הצהרת נגישות" onErr={handleErr} />
      <LegalCard kind="partner-terms" title="תקנון שותפים" onErr={handleErr} />
      <EmailToolsCard onErr={handleErr} />
      <SumitTestCard onErr={handleErr} />
    </div>
  )
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </div>
  )
}

/* Beta + plan-mode cards — ported 1:1 from the desktop admin panel
 * (optimistic UI, gradient icons, Switch, segmented buttons). Config
 * is loaded once here and shared by both cards. */
function AppConfigCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [beta, setBeta] = useState(false)
  const [plan, setPlan] = useState<'hybrid' | 'subscription'>('hybrid')
  const [loading, setLoading] = useState(true)
  const [betaBusy, setBetaBusy] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [betaOptimistic, setBetaOptimistic] = useState<boolean | null>(null)
  const [planOptimistic, setPlanOptimistic] = useState<
    'hybrid' | 'subscription' | null
  >(null)
  const [betaErr, setBetaErr] = useState('')
  const [planErr, setPlanErr] = useState('')
  const [logsPw, setLogsPw] = useState('')
  const [logsBusy, setLogsBusy] = useState(false)
  const [logsMsg, setLogsMsg] = useState('')
  // Per-tier storage quota (GB), as strings for the inputs.
  const [proGb, setProGb] = useState('')
  const [trialGb, setTrialGb] = useState('')
  const [storageBusy, setStorageBusy] = useState(false)
  const [storageMsg, setStorageMsg] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const r = await adminApi<{
          betaMode: boolean
          planMode: 'hybrid' | 'subscription'
          logsPassword?: string
          proStorageGb?: number
          trialStorageGb?: number
        }>('admin-get-app-config')
        setBeta(r.betaMode)
        setPlan(r.planMode)
        setLogsPw(r.logsPassword || '')
        if (typeof r.proStorageGb === 'number') setProGb(String(r.proStorageGb))
        if (typeof r.trialStorageGb === 'number')
          setTrialGb(String(r.trialStorageGb))
      } catch (e) {
        onErr(e)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveLogsPw() {
    setLogsBusy(true)
    setLogsMsg('')
    try {
      await adminApi('admin-set-app-config', { logsPassword: logsPw.trim() })
      setLogsMsg('נשמר ✓')
      setTimeout(() => setLogsMsg(''), 2500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setLogsMsg(err.message || 'שמירה נכשלה')
    } finally {
      setLogsBusy(false)
    }
  }

  async function saveStorage() {
    const pro = parseFloat(proGb)
    const trial = parseFloat(trialGb)
    if (
      !Number.isFinite(pro) ||
      pro <= 0 ||
      !Number.isFinite(trial) ||
      trial <= 0
    ) {
      setStorageMsg('יש להזין מספרים חיוביים (GB)')
      return
    }
    setStorageBusy(true)
    setStorageMsg('')
    try {
      await adminApi('admin-set-app-config', {
        proStorageGb: pro,
        trialStorageGb: trial,
      })
      setStorageMsg('נשמר ✓')
      setTimeout(() => setStorageMsg(''), 2500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setStorageMsg(err.message || 'שמירה נכשלה')
    } finally {
      setStorageBusy(false)
    }
  }

  const betaActive = betaOptimistic !== null ? betaOptimistic : beta
  const planCurrent = planOptimistic ?? plan
  const isSub = planCurrent === 'subscription'

  async function toggleBeta(next?: boolean) {
    const target = typeof next === 'boolean' ? next : !betaActive
    if (betaBusy || target === betaActive) return
    setBetaBusy(true)
    setBetaErr('')
    setBetaOptimistic(target)
    try {
      await adminApi('admin-set-app-config', { betaMode: target })
      setBeta(target)
      setBetaOptimistic(null)
    } catch (e) {
      setBetaOptimistic(null)
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setBetaErr(err.message || 'שינוי המצב נכשל')
    } finally {
      setBetaBusy(false)
    }
  }

  async function pickPlan(mode: 'hybrid' | 'subscription') {
    if (planBusy || mode === planCurrent) return
    setPlanBusy(true)
    setPlanErr('')
    setPlanOptimistic(mode)
    try {
      await adminApi('admin-set-app-config', { planMode: mode })
      setPlan(mode)
      setPlanOptimistic(null)
    } catch (e) {
      setPlanOptimistic(null)
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setPlanErr(err.message || 'שינוי המצב נכשל')
    } finally {
      setPlanBusy(false)
    }
  }

  return (
    <>
      {/* Beta mode */}
      <div
        className={cn(
          'flex w-full items-stretch gap-4 rounded-2xl border p-4 text-right transition-all',
          betaActive
            ? 'border-success/30 bg-success/[0.08]'
            : 'border-border bg-card',
        )}
      >
        <div className="flex flex-1 items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-md transition-all',
              betaActive
                ? 'from-success to-success shadow-success/40'
                : 'from-popover to-popover shadow-lg',
            )}
          >
            {betaBusy || loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <Sparkles className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              מצב בטא
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                  betaActive
                    ? 'bg-success/20 text-success'
                    : 'bg-popover text-muted-foreground',
                )}
              >
                {loading ? 'טוען...' : betaBusy ? 'מעדכן...' : betaActive ? 'פעיל' : 'כבוי'}
              </span>
              {betaOptimistic !== null && (
                <span className="text-[10px] text-muted-foreground">
                  ⚡ ממתין לאישור Firestore
                </span>
              )}
            </div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {betaActive
                ? 'כל המשתמשים מחוברים מקבלים גישה לתכונות Pro בחינם. כיבוי יחזיר כל משתמש למנוי האמיתי שלו באופן מיידי.'
                : 'מצב רגיל — כל משתמש מקבל את התכונות לפי המנוי שלו. הפעלה תעניק לכולם Pro חינם בזמן שהוא דולק.'}
            </p>
            {betaErr && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {betaErr}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center self-center">
          <Switch
            checked={betaActive}
            onCheckedChange={(v) => toggleBeta(v)}
            disabled={betaBusy || loading}
          />
        </div>
      </div>

      {/* Plan mode */}
      <div
        className={cn(
          'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
          isSub ? 'border-primary/30 bg-primary/[0.05]' : 'border-border bg-card',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary shadow-md shadow-primary/40">
            {planBusy ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <Crown className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              תוכנית התשלום
              <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                {loading ? 'טוען...' : planBusy ? 'מעדכן...' : isSub ? 'מנויים' : 'משולבת'}
              </span>
              {planOptimistic !== null && (
                <span className="text-[10px] text-muted-foreground">
                  ⚡ ממתין לאישור Firestore
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {isSub
                ? 'מצב מנויים — רק משתמשים עם מנוי Pro יכולים להפעיל פיצ׳רים. משתמשים חינמיים יראו את התוכנה אבל לא יוכלו לעשות כלום בלי לשדרג.'
                : 'מצב משולב — חלק מהפיצ׳רים פתוחים בחינם, חלק דורשים Pro. ברירת המחדל המקורית.'}
            </p>
            {planErr && (
              <div className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {planErr}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(['hybrid', 'subscription'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => pickPlan(m)}
              disabled={planBusy || loading}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-sm font-medium transition-all',
                planCurrent === m
                  ? 'border-primary/40 bg-gradient-to-br from-primary/20 to-primary/10 text-foreground shadow-md shadow-primary/30'
                  : 'border-border bg-card text-muted-foreground hover:bg-card',
              )}
            >
              {m === 'hybrid' ? 'תוכנית משולבת' : 'תוכנית מנויים'}
            </button>
          ))}
        </div>
      </div>

      {/* Logs password — unlocks the desktop Ctrl+Shift+1 logs window */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary shadow-md shadow-primary/40">
            <Terminal className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-foreground">סיסמת לוגים (תוכנה)</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              הסיסמה שפותחת את חלון הלוגים בתוכנה דרך הקיצור הסודי
              Ctrl+Shift+1. אם ריק — נעשה שימוש בסיסמת ברירת המחדל המובנית.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={logsPw}
            onChange={(e) => setLogsPw(e.target.value)}
            placeholder="סיסמת לוגים"
            className="flex-1"
          />
          <Button onClick={saveLogsPw} disabled={logsBusy} size="sm">
            {logsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            שמור
          </Button>
        </div>
        {logsMsg && <div className="text-xs text-success">{logsMsg}</div>}
      </div>

      {/* Per-tier storage quota (GB) */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4 text-right">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary shadow-md shadow-primary/40">
            <Cloud className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-foreground">
              מכסת אחסון (GB)
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              כמה שטח אחסון (בג'יגה-בייט) מקבל כל סוג משתמש לסבבי התיקונים.
              השינוי חל מיד על כל המשתמשים. אפשר להזין גם שבר (למשל 1.5).
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            מנויי Pro
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min="0"
                step="0.5"
                value={proGb}
                onChange={(e) => setProGb(e.target.value)}
                className="w-28"
                dir="ltr"
              />
              <span className="text-xs text-muted-foreground">GB</span>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            ניסיון חינם
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min="0"
                step="0.5"
                value={trialGb}
                onChange={(e) => setTrialGb(e.target.value)}
                className="w-28"
                dir="ltr"
              />
              <span className="text-xs text-muted-foreground">GB</span>
            </div>
          </label>
          <Button onClick={saveStorage} disabled={storageBusy} size="sm">
            {storageBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            שמור
          </Button>
        </div>
        {storageMsg && <div className="text-xs text-success">{storageMsg}</div>}
      </div>
    </>
  )
}

/* ── Cost protection / emergency kill switch ────────────────────────
 *  Master maintenance switch + optional daily reads/writes ceiling with
 *  an opt-in auto-trip. Setting any of these is a step-up (passkey)
 *  mutation. The switch itself costs ~0 DB ops: the flag is cached
 *  server-side per instance, and the ceiling is checked against the
 *  free Cloud Monitoring numbers, not Firestore. Lives here in Settings
 *  (live status is mirrored on the Dashboard's database card). */
function ProtectionCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [loading, setLoading] = useState(true)
  const [kill, setKill] = useState(false)
  const [autoKill, setAutoKill] = useState(false)
  const [readCeiling, setReadCeiling] = useState('0')
  const [writeCeiling, setWriteCeiling] = useState('0')
  const [reads, setReads] = useState(0)
  const [writes, setWrites] = useState(0)
  const [killBusy, setKillBusy] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const idToken = await getAdminIdToken()
      if (!idToken) throw Object.assign(new Error('auth'), { code: 'auth' })
      const resp = await fetch('/api/revisions?action=admin-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (resp.status === 401 || resp.status === 403)
        throw Object.assign(new Error('auth'), { code: 'auth' })
      const j = (await resp.json()) as {
        firestore?: { configured?: boolean; reads?: number; writes?: number }
        protection?: {
          killSwitch?: boolean
          autoKill?: boolean
          dailyReadCeiling?: number
          dailyWriteCeiling?: number
        }
      }
      const p = j.protection || {}
      setKill(p.killSwitch === true)
      setAutoKill(p.autoKill === true)
      setReadCeiling(String(p.dailyReadCeiling || 0))
      setWriteCeiling(String(p.dailyWriteCeiling || 0))
      if (j.firestore?.configured) {
        setReads(j.firestore.reads || 0)
        setWrites(j.firestore.writes || 0)
      }
    } catch (e) {
      onErr(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleKill(next: boolean) {
    if (
      next &&
      !window.confirm(
        'להפעיל מצב תחזוקה? כל המשתמשים ייחסמו מהאתר ומהתוכנה (פאנל הניהול ימשיך לעבוד) עד שתכבה ידנית.',
      )
    )
      return
    setKillBusy(true)
    setMsg('')
    try {
      await adminApi('admin-set-app-config', { killSwitch: next })
      setKill(next)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setMsg(err.message || 'שמירה נכשלה')
    } finally {
      setKillBusy(false)
    }
  }

  async function saveSettings() {
    const rc = Math.max(0, Math.floor(Number(readCeiling) || 0))
    const wc = Math.max(0, Math.floor(Number(writeCeiling) || 0))
    setSaveBusy(true)
    setMsg('')
    try {
      await adminApi('admin-set-app-config', {
        autoKill,
        dailyReadCeiling: rc,
        dailyWriteCeiling: wc,
      })
      setMsg('נשמר ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setMsg(err.message || 'שמירה נכשלה')
    } finally {
      setSaveBusy(false)
    }
  }

  const rc = Math.max(0, Math.floor(Number(readCeiling) || 0))
  const wc = Math.max(0, Math.floor(Number(writeCeiling) || 0))

  return (
    <>
      {/* Master kill switch */}
      <div
        className={cn(
          'flex w-full items-stretch gap-4 rounded-2xl border p-4 text-right transition-all',
          kill
            ? 'border-destructive/40 bg-destructive/[0.08]'
            : 'border-border bg-card',
        )}
      >
        <div className="flex flex-1 items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-md transition-all',
              kill
                ? 'from-destructive to-destructive shadow-destructive/40'
                : 'from-popover to-popover shadow-lg',
            )}
          >
            {killBusy || loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <Power className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-bold text-foreground">
              מצב תחזוקה (Kill-switch)
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                  kill
                    ? 'bg-destructive/20 text-destructive'
                    : 'bg-popover text-muted-foreground',
                )}
              >
                {loading ? 'טוען...' : killBusy ? 'מעדכן...' : kill ? 'פעיל' : 'כבוי'}
              </span>
            </div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {kill
                ? 'פעיל — האתר והתוכנה חסומים לכל המשתמשים (פאנל הניהול ממשיך לעבוד). כיבוי יחזיר את השירות מיידית.'
                : 'כבוי — הכל עובד כרגיל. הפעלה חוסמת מיידית את כל המשתמשים — מצוין לעצירת חירום בזמן פיתוח או מתקפה.'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center self-center">
          <Switch
            checked={kill}
            onCheckedChange={(v) => toggleKill(v)}
            disabled={killBusy || loading}
          />
        </div>
      </div>

      {/* Daily ceilings + auto-trip */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary shadow-md shadow-primary/40">
            <ShieldAlert className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-bold text-foreground">
                חסימה אוטומטית בחציית תקרה
              </div>
              <Switch
                checked={autoKill}
                onCheckedChange={(v) => setAutoKill(v)}
                disabled={saveBusy || loading}
              />
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              כשמופעל — אם השימוש היומי חוצה תקרה, מצב התחזוקה נדלק אוטומטית.
              הבדיקה מול נתוני הניטור (חינם), בלי קריאות נוספות למסד.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CeilingField
            label="תקרת קריאות ליום"
            value={readCeiling}
            onChange={setReadCeiling}
            used={reads}
            ceiling={rc}
          />
          <CeilingField
            label="תקרת כתיבות ליום"
            value={writeCeiling}
            onChange={setWriteCeiling}
            used={writes}
            ceiling={wc}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          0 = ללא תקרה. התקרה רק מתריעה/חוסמת לפי הבחירה למעלה — היא לא משנה את
          החיוב בפועל.
        </p>

        <div className="flex items-center justify-end gap-3">
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          <Button onClick={saveSettings} disabled={saveBusy || loading} size="sm">
            {saveBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            שמור הגדרות
          </Button>
        </div>

        <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          זו עצירה ברמת האפליקציה — מיידית והפיכה. כגיבוי-אסון מוחלט מול עלות
          בלתי-צפויה קיים גם ה-kill-switch ברמת החיוב של Google Cloud (Budget →
          Cloud Function שמכבה חיוב), שמתואר ב-
          <span dir="ltr">docs/killswitch</span>.
        </p>
      </div>
    </>
  )
}

function CeilingField({
  label,
  value,
  onChange,
  used,
  ceiling,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  used: number
  ceiling: number
}) {
  const pct = ceiling > 0 ? Math.min(100, (used / ceiling) * 100) : 0
  const tone =
    pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-accent' : 'bg-primary'
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        dir="ltr"
        className="tabular-nums"
      />
      {ceiling > 0 ? (
        <>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={'h-full rounded-full ' + tone}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground" dir="ltr">
            {used.toLocaleString()} / {ceiling.toLocaleString()} היום
          </p>
        </>
      ) : (
        <p className="mt-1 text-[10px] text-muted-foreground">ללא תקרה</p>
      )}
    </div>
  )
}

/* ── Announcement popup ─────────────────────────────────────────────
 *  Configure a popup shown on the website and/or desktop app. The image
 *  is either uploaded to R2 (stored) or a Drive link (not stored — shown
 *  straight from Google). Title/body are optional. Frequency + target
 *  are configurable. Saving is a step-up (passkey) action. */
function popupDriveDirect(url: string): string {
  const u = String(url || '').trim()
  if (!u) return ''
  const m =
    u.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || u.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1600`
  return u
}

function PopupCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [imageSource, setImageSource] = useState<'none' | 'r2' | 'drive'>('none')
  const [imageKey, setImageKey] = useState('')
  const [driveUrl, setDriveUrl] = useState('')
  const [r2Preview, setR2Preview] = useState('') // presigned/local preview for an uploaded image
  const [frequency, setFrequency] = useState<'always' | 'daily' | 'once'>('daily')
  const [target, setTarget] = useState<'web' | 'desktop' | 'both'>('both')
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium')
  const [linkUrl, setLinkUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=get-popup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const j = (await r.json()) as {
          popup?: {
            enabled?: boolean
            title?: string
            body?: string
            imageSource?: 'none' | 'r2' | 'drive'
            driveUrl?: string
            imageUrl?: string
            frequency?: 'always' | 'daily' | 'once'
            target?: 'web' | 'desktop' | 'both'
            size?: 'small' | 'medium' | 'large'
            linkUrl?: string
          }
        }
        const p = j.popup || {}
        setEnabled(p.enabled === true)
        setTitle(p.title || '')
        setBody(p.body || '')
        setImageSource(p.imageSource || 'none')
        setDriveUrl(p.driveUrl || '')
        if (p.imageSource === 'r2') setR2Preview(p.imageUrl || '')
        if (p.frequency) setFrequency(p.frequency)
        if (p.target) setTarget(p.target)
        if (p.size) setSize(p.size)
        setLinkUrl(p.linkUrl || '')
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 4 * 1024 * 1024) {
      setMsg('התמונה גדולה מדי — מקסימום 4MB')
      return
    }
    setUploading(true)
    setMsg('')
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader()
        fr.onload = () => res(String(fr.result))
        fr.onerror = rej
        fr.readAsDataURL(file)
      })
      const r = await adminApi<{ imageKey: string }>(
        'admin-upload-popup-image',
        { content: dataUrl },
      )
      setImageKey(r.imageKey)
      setImageSource('r2')
      setR2Preview(dataUrl)
      setMsg('התמונה הועלתה ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setMsg(err.message || 'העלאה נכשלה')
    } finally {
      setUploading(false)
    }
  }

  async function save() {
    setSaving(true)
    setMsg('')
    try {
      await adminApi('admin-set-popup', {
        enabled,
        title: title.trim(),
        body: body.trim(),
        imageSource,
        imageKey,
        driveUrl: driveUrl.trim(),
        frequency,
        target,
        size,
        linkUrl: linkUrl.trim(),
      })
      setMsg('נשמר ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setMsg(err.message || 'שמירה נכשלה')
    } finally {
      setSaving(false)
    }
  }

  const previewImg =
    imageSource === 'r2'
      ? r2Preview
      : imageSource === 'drive'
        ? popupDriveDirect(driveUrl)
        : ''

  const SOURCES = [
    { v: 'none', label: 'בלי תמונה' },
    { v: 'r2', label: 'העלאת תמונה' },
    { v: 'drive', label: 'קישור מ-Drive' },
  ] as const
  const FREQS = [
    { v: 'always', label: 'בכל כניסה' },
    { v: 'daily', label: 'פעם ביום' },
    { v: 'once', label: 'פעם אחת לאדם' },
  ] as const
  const TARGETS = [
    { v: 'both', label: 'אתר + תוכנה' },
    { v: 'web', label: 'רק האתר' },
    { v: 'desktop', label: 'רק התוכנה' },
  ] as const

  return (
    <Card title="פופאפ הודעה">
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Enable */}
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
            <span className="text-sm font-medium text-foreground">
              הצג פופאפ למשתמשים
            </span>
            <Switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
          </label>

          {/* Image source */}
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">תמונה</div>
            <div className="grid grid-cols-3 gap-2">
              {SOURCES.map((s) => (
                <button
                  key={s.v}
                  type="button"
                  onClick={() => setImageSource(s.v)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-xs transition-colors',
                    imageSource === s.v
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-fg-muted hover:bg-popover',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {imageSource === 'r2' && (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  בחר תמונה
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  onChange={onPickImage}
                  className="hidden"
                />
                <span className="text-[11px] text-fg-faint">מקסימום 4MB</span>
              </div>
            )}
            {imageSource === 'drive' && (
              <Input
                className="mt-2"
                dir="ltr"
                placeholder="קישור לתמונה ב-Google Drive"
                value={driveUrl}
                onChange={(e) => setDriveUrl(e.target.value)}
              />
            )}
          </div>

          {/* Title + body */}
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              כותרת (אפשר להשאיר ריק)
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="כותרת הפופאפ"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              טקסט (אפשר להשאיר ריק)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="טקסט שמופיע מתחת לכותרת"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-fg outline-none focus:border-primary"
            />
          </div>

          {/* Frequency + target */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                תדירות הצגה
              </label>
              <select
                value={frequency}
                onChange={(e) =>
                  setFrequency(e.target.value as typeof frequency)
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-fg outline-none focus:border-primary"
              >
                {FREQS.map((f) => (
                  <option key={f.v} value={f.v}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                איפה להציג
              </label>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value as typeof target)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-fg outline-none focus:border-primary"
              >
                {TARGETS.map((t) => (
                  <option key={t.v} value={t.v}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Size + click-through link */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                גודל הפופאפ
              </label>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value as typeof size)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-fg outline-none focus:border-primary"
              >
                <option value="small">קטן</option>
                <option value="medium">בינוני</option>
                <option value="large">גדול</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                קישור בלחיצה על התמונה — אפשר להשאיר ריק
              </label>
              <Input
                dir="ltr"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="/buy או https://example.com"
              />
            </div>
          </div>

          {/* Live preview */}
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">תצוגה מקדימה</div>
            <div className="overflow-hidden rounded-xl border border-border bg-background">
              {previewImg ? (
                <img
                  src={previewImg}
                  alt=""
                  className="max-h-48 w-full object-contain"
                />
              ) : null}
              {(title || body) && (
                <div className="p-4 text-center">
                  {title && (
                    <div className="text-base font-bold text-fg">{title}</div>
                  )}
                  {body && (
                    <div className="mt-1 text-sm text-fg-muted whitespace-pre-line">
                      {body}
                    </div>
                  )}
                </div>
              )}
              {!previewImg && !title && !body && (
                <div className="p-6 text-center text-xs text-fg-faint">
                  אין תוכן עדיין
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              שמור פופאפ
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function PasskeysCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [list, setList] = useState<PasskeyInfo[] | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      setList(await listPasskeys())
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setMsg(err.message || 'טעינה נכשלה')
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function register() {
    if (busy) return
    setBusy(true)
    setMsg('')
    const name =
      deviceName.trim() ||
      (/iphone|ipad|android/i.test(navigator.userAgent)
        ? 'טלפון'
        : /mac/i.test(navigator.userAgent)
          ? 'Mac'
          : 'מחשב')
    const r = await registerPasskey(name)
    setBusy(false)
    if (r.ok) {
      setDeviceName('')
      setMsg('המכשיר נרשם ✓')
      setTimeout(() => setMsg(''), 2500)
      void load()
    } else {
      setMsg(r.error || 'הרישום נכשל/בוטל')
    }
  }

  async function remove(id: string) {
    if (!window.confirm('להסיר את המכשיר הזה? לא תוכל להיכנס איתו יותר.')) return
    try {
      await deletePasskey(id)
      void load()
    } catch (e) {
      onErr(e)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent shadow-md shadow-primary/40">
          <Fingerprint className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-foreground">
            מפתחות גישה (Passkeys)
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            רשום את המכשיר הזה (Touch ID במק / Face ID באייפון / Windows Hello)
            כדי להיכנס בלי קוד מייל. אפשר לרשום כמה מכשירים — אחד למחשב ואחד
            לטלפון. קוד המייל יישאר כגיבוי.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="שם המכשיר (אופציונלי)"
          className="flex-1"
        />
        <Button onClick={register} disabled={busy} size="sm">
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Fingerprint className="h-3.5 w-3.5" />
          )}
          רשום מכשיר זה
        </Button>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}

      {list === null ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> טוען…
        </div>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          עדיין לא נרשמו מכשירים — תיכנס עם קוד מייל עד שתרשום אחד.
        </p>
      ) : (
        <div className="space-y-1.5">
          {list.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-xs"
            >
              <span className="flex items-center gap-2 text-foreground">
                <Fingerprint className="h-3.5 w-3.5 text-accent" />
                {p.deviceName}
                <span className="text-muted-foreground">
                  · {new Date(p.createdAt).toLocaleDateString('he-IL')}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="text-muted-foreground transition-colors hover:text-destructive"
                title="הסר"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LegalCard({
  kind,
  title,
  onErr,
}: {
  kind: 'terms' | 'privacy' | 'accessibility' | 'partner-terms'
  title: string
  onErr: (e: unknown) => void
}) {
  const [sections, setSections] = useState<Section[]>([])
  const [version, setVersion] = useState(0)
  const [liveVersion, setLiveVersion] = useState(0)
  const [lastUpdated, setLastUpdated] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [dragSrc, setDragSrc] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  // Sections collapsed by default — the legal docs are long, so the
  // editor stays compact until the admin opens a specific section.
  const [openSections, setOpenSections] = useState<Set<number>>(new Set())
  function toggleSection(i: number) {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function moveSection(from: number, to: number) {
    if (from === to) return
    setSections((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    // Keep collapse state attached to the right section after the move.
    setOpenSections((prev) => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx === from) next.add(to)
        else if (from < to && idx > from && idx <= to) next.add(idx - 1)
        else if (to < from && idx >= to && idx < from) next.add(idx + 1)
        else next.add(idx)
      }
      return next
    })
  }

  function removeSection(i: number) {
    setSections(sections.filter((_, j) => j !== i))
    // Re-index open sections so the wrong one doesn't appear expanded.
    setOpenSections((prev) => {
      const next = new Set<number>()
      for (const idx of prev) {
        if (idx < i) next.add(idx)
        else if (idx > i) next.add(idx - 1)
      }
      return next
    })
  }

  // ── Paragraph-level edits within a section ────────────────────
  function updateParagraph(si: number, pi: number, value: string) {
    setSections((prev) => {
      const next = [...prev]
      const paras = [...next[si].paragraphs]
      paras[pi] = value
      next[si] = { ...next[si], paragraphs: paras }
      return next
    })
  }
  function addParagraph(si: number) {
    setSections((prev) => {
      const next = [...prev]
      next[si] = { ...next[si], paragraphs: [...next[si].paragraphs, ''] }
      return next
    })
  }
  function removeParagraph(si: number, pi: number) {
    setSections((prev) => {
      const next = [...prev]
      next[si] = {
        ...next[si],
        paragraphs: next[si].paragraphs.filter((_, j) => j !== pi),
      }
      return next
    })
  }
  function moveParagraph(si: number, from: number, to: number) {
    setSections((prev) => {
      const paras = prev[si].paragraphs
      if (to < 0 || to >= paras.length) return prev
      const next = [...prev]
      const arr = [...paras]
      const [moved] = arr.splice(from, 1)
      arr.splice(to, 0, moved)
      next[si] = { ...next[si], paragraphs: arr }
      return next
    })
  }

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/paypal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: `get-${kind}` }),
        })
        const j = (await r.json()) as {
          ok: boolean
          version?: number
          lastUpdated?: string
          sections?: Section[]
        }
        setVersion(j.version || 0)
        setLiveVersion(j.version || 0)
        const fetchedSections = j.sections || []
        // Seed the editor from the built-in default when nothing's been
        // published yet — so the admin starts from the real content (as
        // editable categories) instead of a blank page, and just hits
        // save to publish. Applies to accessibility and partner-terms.
        // Until they hit save, the DB stays empty and the public surface
        // keeps showing its built-in fallback; saving publishes this.
        const seedDefault =
          fetchedSections.length === 0
            ? kind === 'accessibility'
              ? ACCESSIBILITY_DEFAULT
              : kind === 'partner-terms'
                ? PARTNER_TERMS_DEFAULT
                : null
            : null
        if (seedDefault) {
          setSections(
            seedDefault.sections.map((s) => ({
              title: s.title,
              paragraphs: [...s.paragraphs],
            })),
          )
          setLastUpdated(j.lastUpdated || seedDefault.lastUpdated)
        } else {
          setLastUpdated(j.lastUpdated || '')
          setSections(fetchedSections)
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [kind])

  async function save() {
    // Bumping the version forces every user to re-accept on next login —
    // confirm before doing that, like the desktop does.
    if (
      version > liveVersion &&
      !window.confirm(
        'העלאת מספר הגרסה תכריח את כל המשתמשים לאשר מחדש את המסמך בכניסה הבאה. להמשיך?',
      )
    ) {
      return
    }
    setBusy(true)
    setMsg('')
    try {
      await adminApi(`admin-set-${kind}`, {
        version,
        sections,
        lastUpdated: lastUpdated.trim() || undefined,
      })
      setLiveVersion(version)
      setMsg('נשמר ופורסם ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      onErr(e)
    } finally {
      setBusy(false)
    }
  }

  if (loading)
    return (
      <Card title={title}>
        <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />
      </Card>
    )

  return (
    <Card title={title}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span>גרסה:</span>
        <input
          type="number"
          value={version}
          onChange={(e) => setVersion(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className="w-20 rounded-lg border border-border bg-transparent px-2 py-1 text-sm text-fg outline-none focus:border-primary"
        />
        {version > liveVersion && (
          <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
            מצריך אישור מחדש
          </span>
        )}
        <span className="text-fg-faint">(העלאת הגרסה תכריח אישור מחדש)</span>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span>תאריך עדכון (מוצג למשתמש):</span>
        <input
          value={lastUpdated}
          onChange={(e) => setLastUpdated(e.target.value)}
          placeholder="לדוגמה: 20 במאי 2026"
          className="flex-1 rounded-lg border border-border bg-transparent px-2 py-1 text-sm text-fg outline-none focus:border-primary"
        />
      </label>

      <div className="space-y-3">
        {sections.map((s, i) => (
          <div
            key={i}
            onDragOver={(e) => {
              if (dragSrc === null) return
              e.preventDefault()
              setDragOver(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragSrc !== null) moveSection(dragSrc, i)
              setDragSrc(null)
              setDragOver(null)
            }}
            className={
              'rounded-lg border p-3 transition-colors ' +
              (dragOver === i && dragSrc !== null
                ? 'border-primary'
                : 'border-border')
            }
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                draggable
                onDragStart={() => setDragSrc(i)}
                onDragEnd={() => {
                  setDragSrc(null)
                  setDragOver(null)
                }}
                title="גרור לסידור מחדש"
                className="cursor-grab text-fg-faint hover:text-fg-muted active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </span>
              {/* Explicit up/down for the SECTION (reliable everywhere,
                  unlike drag). */}
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => moveSection(i, i - 1)}
                  disabled={i === 0}
                  title="העלה סעיף"
                  className="text-fg-faint transition-colors hover:text-fg disabled:opacity-25"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => moveSection(i, i + 1)}
                  disabled={i === sections.length - 1}
                  title="הורד סעיף"
                  className="text-fg-faint transition-colors hover:text-fg disabled:opacity-25"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <input
                value={s.title}
                onChange={(e) => {
                  const next = [...sections]
                  next[i] = { ...s, title: e.target.value }
                  setSections(next)
                }}
                placeholder="כותרת הקטגוריה"
                className="flex-1 rounded-lg border border-border bg-transparent px-3 py-1.5 text-sm font-medium text-fg outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => toggleSection(i)}
                title={openSections.has(i) ? 'כיווץ' : 'פתיחה'}
                className="text-fg-muted transition-colors hover:text-fg"
              >
                <ChevronDown
                  className={
                    'h-4 w-4 transition-transform ' +
                    (openSections.has(i) ? 'rotate-180' : '')
                  }
                />
              </button>
              <button
                type="button"
                onClick={() => removeSection(i)}
                title="מחק קטגוריה"
                className="text-fg-muted hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {openSections.has(i) ? (
              <div className="space-y-2">
                {s.paragraphs.length === 0 && (
                  <div className="px-1 text-[11px] text-fg-faint">
                    אין עדיין פסקאות — הוסיפו אחת למטה.
                  </div>
                )}
                {s.paragraphs.map((p, pi) => (
                  <div key={pi} className="flex items-start gap-2">
                    {/* Per-paragraph move up/down */}
                    <div className="flex flex-col pt-1">
                      <button
                        type="button"
                        onClick={() => moveParagraph(i, pi, pi - 1)}
                        disabled={pi === 0}
                        title="העלה פסקה"
                        className="text-fg-faint transition-colors hover:text-fg disabled:opacity-25"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveParagraph(i, pi, pi + 1)}
                        disabled={pi === s.paragraphs.length - 1}
                        title="הורד פסקה"
                        className="text-fg-faint transition-colors hover:text-fg disabled:opacity-25"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <textarea
                      value={p}
                      onChange={(e) => updateParagraph(i, pi, e.target.value)}
                      rows={3}
                      placeholder={`פסקה ${pi + 1}`}
                      className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={() => removeParagraph(i, pi)}
                      title="מחק פסקה"
                      className="pt-1 text-fg-muted hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addParagraph(i)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1 text-[11px] text-fg-muted hover:text-fg"
                >
                  <Plus className="h-3 w-3" /> הוסף פסקה
                </button>
              </div>
            ) : (
              <div className="px-1 text-[11px] text-fg-faint">
                {s.paragraphs.length} פסקאות — לחצו לפתיחה
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSections([...sections, { title: '', paragraphs: [] }])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" /> הוסף קטגוריה
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          שמור ופרסם
        </button>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}
    </Card>
  )
}

function SumitTestCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [target, setTarget] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    draft?: boolean
    url?: string | null
    documentNumber?: string | number | null
    emailed?: boolean
    error?: string | null
    raw?: unknown
  } | null>(null)

  async function run() {
    setSending(true)
    setResult(null)
    try {
      const j = await adminApi('admin-test-sumit', { targetEmail: target.trim() })
      setResult(j as never)
    } catch (e) {
      onErr(e)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card title="בדיקת קבלה — SUMIT (סאמיט)">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="מייל יעד (ריק = למייל שלך)"
          dir="ltr"
          className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={run}
          disabled={sending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          הפקת קבלת בדיקה
        </button>
      </div>
      {result && (
        <div className="mt-2 space-y-1 text-xs">
          <div className={result.ok ? 'text-success' : 'text-destructive'}>
            {result.ok
              ? `הצליח ${result.draft ? '(טיוטה)' : ''} ${result.emailed ? '— נשלח במייל' : ''}`
              : `נכשל: ${result.error || 'שגיאה'}`}
          </div>
          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              dir="ltr"
              className="block break-all text-primary underline"
            >
              {result.url}
            </a>
          )}
          <details>
            <summary className="cursor-pointer text-fg-faint">תשובת SUMIT הגולמית</summary>
            <pre
              dir="ltr"
              className="mt-1 max-h-60 overflow-auto rounded bg-black/30 p-2 text-[10px] leading-relaxed text-fg-muted"
            >
              {JSON.stringify(result.raw, null, 2)}
            </pre>
          </details>
        </div>
      )}
      <p className="text-[11px] text-fg-faint">
        מפיק מסמך טיוטה ב-SUMIT ושולח אותו מהמייל שלנו. כשהעסק מוגדר —
        הגדר env <code>SUMIT_LIVE=true</code> כדי להפיק מסמכים אמיתיים.
      </p>
    </Card>
  )
}

interface PlanPrice {
  regular: number
  sale: number | null
}
interface PricingDoc {
  monthly: PlanPrice
  yearly: PlanPrice
  currency: string
  saleLabel?: string | null
  updatedAt?: string
}
const DEFAULT_PRICING: PricingDoc = {
  monthly: { regular: 9, sale: null },
  yearly: { regular: 60, sale: null },
  currency: 'ILS',
}

/* Pricing card — ported 1:1 from the desktop admin panel. Loads via
 * the public get-pricing endpoint, saves via admin-set-pricing, then
 * triggers sync-plans so PayPal Plans match the new prices. */
export function PricingCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [draft, setDraft] = useState<PricingDoc>(DEFAULT_PRICING)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [monthlySaleOn, setMonthlySaleOn] = useState(false)
  const [yearlySaleOn, setYearlySaleOn] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch('/api/paypal?action=get-pricing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        })
        const j = (await r.json()) as {
          ok: boolean
          monthly?: PlanPrice
          yearly?: PlanPrice
          currency?: string
          saleLabel?: string | null
        }
        if (!alive) return
        if (j.ok && j.monthly && j.yearly) {
          const p: PricingDoc = {
            monthly: { regular: j.monthly.regular, sale: j.monthly.sale ?? null },
            yearly: { regular: j.yearly.regular, sale: j.yearly.sale ?? null },
            currency: j.currency || 'ILS',
            saleLabel: j.saleLabel ?? null,
          }
          setDraft(p)
          setMonthlySaleOn(p.monthly.sale != null)
          setYearlySaleOn(p.yearly.sale != null)
        }
        setLoaded(true)
      } catch (err) {
        setError((err as Error).message || 'טעינת מחירים נכשלה')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    setError('')
    setSavedAt(null)
    try {
      const payload = {
        monthly: {
          regular: draft.monthly.regular,
          sale: monthlySaleOn ? draft.monthly.sale ?? null : null,
        },
        yearly: {
          regular: draft.yearly.regular,
          sale: yearlySaleOn ? draft.yearly.sale ?? null : null,
        },
        currency: draft.currency || 'ILS',
        saleLabel: draft.saleLabel,
      }
      // 1) Persist the pricing doc (source of truth for site + buy page).
      await adminApi('admin-set-pricing', payload)
      // 2) Sync PayPal Plans server-side. Soft-fail: the price is saved
      //    regardless, and the next subscription attempt lazy-syncs.
      //    Routed through adminApi() so the full admin gate (idToken +
      //    12h adminToken + gateKey) is attached — sync-plans is a
      //    sensitive PayPal catalog mutation, not an idToken-only call.
      try {
        await adminApi('sync-plans')
      } catch (e) {
        const err = e as Error & { code?: string }
        if (err.code === 'auth') return onErr(err)
        setError(
          `המחיר נשמר אבל סנכרון ל-PayPal נכשל (${err.message || 'שגיאה'}). הסנכרון יתבצע אוטומטית בעת הרכישה הבאה.`,
        )
      }
      setSavedAt(new Date().toISOString())
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setError(err.message || 'שמירה נכשלה')
    } finally {
      setSaving(false)
    }
  }

  const anySale =
    (monthlySaleOn && draft.monthly.sale != null) ||
    (yearlySaleOn && draft.yearly.sale != null)

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/40">
          <Sparkles className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-bold text-foreground">
            תמחור מנויים
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              {loaded ? `מטבע ${draft.currency}` : 'טוען...'}
            </span>
            {anySale && (
              <span className="rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
                מבצע פעיל
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            מחירים שמופיעים באתר ושנגבים דרך PayPal. שינויים מתעדכנים מיד באתר.
            המערכת מאמתת בצד שרת שהסכום שאושר ב-PayPal תואם למחיר העכשווי — לקוח
            לא יכול לקנות במחיר ישן או נמוך יותר.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">מנוי חודשי</div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={monthlySaleOn}
              onChange={(e) => setMonthlySaleOn(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            מבצע פעיל
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PriceInput
            label="מחיר רגיל"
            value={draft.monthly.regular}
            onChange={(v) =>
              setDraft((d) => ({ ...d, monthly: { ...d.monthly, regular: v } }))
            }
            currency={draft.currency}
          />
          <PriceInput
            label="מחיר מבצע"
            value={draft.monthly.sale ?? 0}
            onChange={(v) =>
              setDraft((d) => ({ ...d, monthly: { ...d.monthly, sale: v } }))
            }
            currency={draft.currency}
            disabled={!monthlySaleOn}
            error={
              monthlySaleOn &&
              draft.monthly.sale != null &&
              draft.monthly.sale >= draft.monthly.regular
                ? '≥ רגיל'
                : undefined
            }
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">מנוי שנתי</div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={yearlySaleOn}
              onChange={(e) => setYearlySaleOn(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            מבצע פעיל
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PriceInput
            label="מחיר רגיל"
            value={draft.yearly.regular}
            onChange={(v) =>
              setDraft((d) => ({ ...d, yearly: { ...d.yearly, regular: v } }))
            }
            currency={draft.currency}
          />
          <PriceInput
            label="מחיר מבצע"
            value={draft.yearly.sale ?? 0}
            onChange={(v) =>
              setDraft((d) => ({ ...d, yearly: { ...d.yearly, sale: v } }))
            }
            currency={draft.currency}
            disabled={!yearlySaleOn}
            error={
              yearlySaleOn &&
              draft.yearly.sale != null &&
              draft.yearly.sale >= draft.yearly.regular
                ? '≥ רגיל'
                : undefined
            }
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-muted-foreground">
          תווית מבצע (אופציונלי) — מופיעה ככרזת מעל הכרטיס באתר
        </label>
        <Input
          value={draft.saleLabel ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, saleLabel: e.target.value }))}
          placeholder="לדוגמה: ′מבצע חורף′ או ′44% הנחה′"
          disabled={!anySale}
        />
      </div>

      {error && (
        <div className="flex items-center gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
      {savedAt && (
        <div className="flex items-center gap-1 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          <CheckCircle className="h-3.5 w-3.5" /> נשמר ב-
          {new Date(savedAt).toLocaleTimeString('he-IL', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
          . האתר יציג את המחיר החדש בתוך כמה שניות.
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          {draft.updatedAt &&
            `עודכן לאחרונה: ${new Date(draft.updatedAt).toLocaleString('he-IL')}`}
        </div>
        <Button onClick={handleSave} disabled={saving || !loaded} size="sm">
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              שומר...
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              שמור שינויים
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function PriceInput({
  label,
  value,
  onChange,
  currency,
  disabled,
  error,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  currency: string
  disabled?: boolean
  error?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">
        {label}
        {error && <span className="ms-1 text-destructive">({error})</span>}
      </span>
      <div className="relative">
        <Input
          type="number"
          inputMode="decimal"
          step="0.5"
          min={0}
          value={value || ''}
          onChange={(e) => {
            const n = parseFloat(e.target.value)
            onChange(Number.isFinite(n) && n >= 0 ? n : 0)
          }}
          disabled={disabled}
          className="pl-10"
        />
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
          {currency === 'ILS' ? '₪' : currency}
        </span>
      </div>
    </label>
  )
}

function EmailToolsCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [target, setTarget] = useState('')
  const [kind, setKind] = useState(TEST_EMAILS[0].kind)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState('')

  // Marketing broadcast state
  const [bcSubject, setBcSubject] = useState('')
  const [bcHeading, setBcHeading] = useState('')
  const [bcContent, setBcContent] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<{
    kind: 'idle' | 'dry' | 'done' | 'error'
    text: string
  }>({ kind: 'idle', text: '' })

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

  async function sendTest() {
    if (!target.trim()) return
    setSending(true)
    setMsg('')
    try {
      await adminApi('admin-send-test-email', { targetEmail: target.trim(), kind })
      setMsg('נשלח ✓')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) {
      onErr(e)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card title="כלי דיוור — מייל בדיקה">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="מייל יעד"
          dir="ltr"
          className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-fg outline-none focus:border-primary"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-primary"
        >
          {TEST_EMAILS.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={sendTest}
          disabled={sending || !target.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          שלח בדיקה
        </button>
      </div>
      {msg && <div className="text-xs text-success">{msg}</div>}

      {/* ── Marketing broadcast ─────────────────────────────────── */}
      <div className="mt-2 space-y-2.5 rounded-xl border border-border bg-background/40 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Send className="h-3.5 w-3.5 text-accent" />
          שליחת מייל שיווקי
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          נשלח רק למשתמשים שהסכימו לקבל תוכן שיווקי בהרשמה. כל מייל כולל אוטומטית
          קישור "להסרה מרשימת הדיוור" בתחתית.
        </p>
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
        <textarea
          value={bcContent}
          onChange={(e) => setBcContent(e.target.value)}
          placeholder='<p style="font-size:14px;line-height:1.7;color:#d1d5db;">תוכן ההודעה כאן...</p>'
          rows={5}
          disabled={bcBusy}
          dir="ltr"
          className="block w-full rounded-lg border border-border bg-input/60 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
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
      </div>
    </Card>
  )
}
