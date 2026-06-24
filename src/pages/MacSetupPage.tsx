import { ShieldCheck, Settings, MousePointerClick, RefreshCw } from 'lucide-react'

/**
 * First-launch guide for macOS, opened automatically when a Mac user starts a
 * download (see Hero startDownload). The app is ad-hoc signed but NOT notarized
 * by Apple, so the first open shows "Apple could not verify…". This page
 * reassures the user, walks them through the one-time bypass, and stresses that
 * it happens ONCE — future updates install seamlessly (the app downloads them
 * itself, so no Gatekeeper prompt).
 */
export default function MacSetupPage() {
  return (
    <div
      dir="rtl"
      className="flex min-h-dvh flex-col items-center bg-background px-4 py-12 text-foreground"
    >
      <div className="w-full max-w-lg">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>

        <h1 className="mt-4 text-center text-2xl font-bold">
          פתיחת התוכנה בפעם הראשונה ב-Mac
        </h1>
        <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground">
          ההורדה החלה ✓ — רק שלב קטן וחד-פעמי לפני שמתחילים.
        </p>

        {/* Why */}
        <div className="mt-6 rounded-2xl border border-border bg-card p-5">
          <div className="text-sm font-semibold">למה תופיע הודעה של Apple?</div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            בפתיחה הראשונה ייתכן שתראו "Apple could not verify…". זה תקין
            לחלוטין — התוכנה בטוחה, וההודעה מופיעה רק מכיוון שהיא עדיין לא עברה
            את אישור Apple בתשלום. זה לא אומר שיש בעיה בתוכנה.
          </p>
        </div>

        {/* Steps */}
        <div className="mt-4 space-y-3">
          <Step
            icon={<MousePointerClick className="h-4 w-4 text-accent" />}
            title="1. פתחו את קובץ ההתקנה"
            body="לחצו פעמיים על הקובץ שהורד (‎.pkg‎). אם הוא נפתח רגיל — מצוין, סיימתם."
          />
          <Step
            icon={<Settings className="h-4 w-4 text-accent" />}
            title="2. אם הופיעה ההודעה של Apple"
            body='פתחו: הגדרות מערכת ← פרטיות ואבטחה ← גללו למטה ← לחצו "פתח בכל זאת" (Open Anyway). ואז פתחו שוב את הקובץ ולחצו "פתח".'
          />
          <Step
            icon={<MousePointerClick className="h-4 w-4 text-accent" />}
            title="חלופה (ב-macOS ישן יותר)"
            body='קליק-ימני על הקובץ ← "Open" ← ושוב "Open" בחלון שמופיע.'
          />
        </div>

        {/* One-time reassurance */}
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-success/30 bg-success/[0.06] p-4">
          <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="text-sm leading-relaxed text-foreground">
            <span className="font-semibold">זה קורה פעם אחת בלבד.</span>{' '}
            כל העדכונים הבאים יותקנו אוטומטית ובצורה חלקה — בלי ההודעה הזו.
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">
          Download Manager Plus
        </p>
      </div>
    </div>
  )
}

function Step({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </div>
  )
}
