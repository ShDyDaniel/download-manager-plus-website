import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { BookOpen, Check, Loader2, Layers, ArrowLeft, Plus } from 'lucide-react'
import { Footer } from '../components/Footer'

/**
 * /glossary — קטלוג חבילות-המונחים לתמלול.
 *
 * הדף הוא *תצוגה* בלבד: ההפעלה עצמה קורית בתוך התוכנה, כי שם נשמרת
 * ההגדרה ושם רץ המנוע. התפקיד של הדף הוא להראות מה קיים ומה בדיוק ייכנס
 * — שקיפות מלאה, כי חבילה משנה את הטקסט שהמשתמש מקבל.
 *
 * הנתונים נמשכים מאותו endpoint שהאפליקציה קוראת, כדי שלא תהיה גרסה
 * שנייה של הרשימה שתתיישן.
 */
interface Pack {
  id: string
  name: string
  description: string
  terms: string[]
}

export function GlossaryPacksPage() {
  const [packs, setPacks] = useState<Pack[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/revisions?action=glossary-packs')
      .then((r) => r.json())
      .then((j) => setPacks(Array.isArray(j?.packs) ? j.packs : []))
      .catch(() => setPacks([]))
  }, [])

  return (
    <div className="relative" dir="rtl">
      <section className="mx-auto max-w-5xl px-6 pb-10 pt-24 text-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-accent">
            <BookOpen className="h-7 w-7 text-white" />
          </span>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            חבילות מונחים לתמלול
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            מנוע תמלול גנרי לא מכיר את המונחים של התחום שלכם, ולכן הוא מנחש
            אותם לפי הצליל, ושם נופלות רוב השגיאות. חבילה היא רשימה מתוחזקת
            של שמות ומונחים; הפעלה אחת בתוכנה, וכל התמלולים הבאים מכירים אותם.
          </p>
        </motion.div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24">
        {packs === null && (
          <div className="flex justify-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {packs?.length === 0 && (
          <p className="py-12 text-center text-muted-foreground">
            הקטלוג אינו זמין כרגע. נסו לרענן בעוד רגע.
          </p>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          {packs?.map((p) => {
            const phrases = p.terms.filter((t) => t.trim().split(/\s+/).length > 1).length
            const isOpen = open === p.id
            return (
              <div
                key={p.id}
                className="rounded-2xl border border-border bg-card p-6 text-right"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary">
                    <Layers className="h-5 w-5 text-primary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-semibold">{p.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-lg bg-secondary px-2.5 py-1 text-muted-foreground">
                    {p.terms.length} מונחים
                  </span>
                  <span className="rounded-lg bg-secondary px-2.5 py-1 text-muted-foreground">
                    {phrases} צירופים
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {/* פותח את התוכנה ומפעיל את הקטגוריה. הקישור נושא מזהה
                      בלבד — המונחים נמשכים מהשרת, כך שאי-אפשר להזריק
                      מילים למילון דרך URL. */}
                  <a
                    href={`dmplus://glossary?pack=${encodeURIComponent(p.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-primary to-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    <Plus className="h-4 w-4" />
                    הוספה לתוכנה
                  </a>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : p.id)}
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {isOpen ? 'הסתרת הרשימה' : 'הצגת כל המונחים'}
                  </button>
                </div>

                {isOpen && (
                  <div className="mt-3 flex max-h-64 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-border bg-background p-3">
                    {p.terms.map((t) => (
                      <span
                        key={t}
                        className="rounded-md bg-secondary px-2 py-0.5 text-xs text-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* איך מפעילים — ההפעלה בתוכנה, לא כאן. חשוב שזה יהיה חד. */}
        <div className="mt-12 rounded-2xl border border-border bg-card p-6">
          <h3 className="text-lg font-semibold">איך מפעילים</h3>
          <ol className="mt-4 space-y-3 text-sm text-muted-foreground">
            {[
              'פותחים בתוכנה את הטאב "תמלול חכם".',
              'לוחצים כאן על "הוספה לתוכנה", או, בתוך התוכנה, על "מתקדם" ואז על הכפתור "קטגוריה".',
              'הקטגוריה מופיעה כתגית אחת במילון האישי, בלי למלא אותו במאות מונחים.',
            ].map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            הקטגוריות מתעדכנות מהשרת. כשמונח נוסף או מתוקן ברשימה, הוא מגיע
            אליכם אוטומטית, בלי להוסיף את הקטגוריה מחדש.
          </p>
        </div>

        <div className="mt-8 text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-primary to-accent px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            להורדת התוכנה
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  )
}
