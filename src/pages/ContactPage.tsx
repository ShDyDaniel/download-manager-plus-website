import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, CheckCircle2, Mail } from 'lucide-react'
import { Footer } from '../components/Footer'

/* צור קשר — public contact form. Posts to /api/paypal?action=submit-contact,
 * which stores the message in the same `feedback` collection the admin
 * "פניות" tab reads, and pings the operator on Telegram. */

export default function ContactPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [hp, setHp] = useState('') // honeypot
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const canSubmit = name.trim().length >= 2 && emailValid && message.trim().length >= 5

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/paypal?action=submit-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          subject: subject.trim(),
          message: message.trim(),
          hp,
        }),
      })
      const j = (await r.json()) as { ok: boolean; error?: string }
      if (!r.ok || !j.ok) {
        setError(j.error || 'שליחת הפנייה נכשלה — נסו שוב')
      } else {
        setSent(true)
      }
    } catch {
      setError('שליחת הפנייה נכשלה — נסו שוב')
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'w-full rounded-xl border border-border bg-bg-elevated px-4 py-3 text-base text-fg placeholder:text-fg-faint focus:border-primary focus:outline-none'

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto w-full max-w-xl flex-1 px-6 pb-16 pt-28">
        <header className="mb-8">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Mail className="h-6 w-6 text-primary" />
          </div>
          <h1 className="font-display text-3xl font-bold text-fg">צור קשר</h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-secondary">
            יש לכם שאלה, בעיה או הצעה? כתבו לנו ונחזור אליכם למייל בהקדם.
          </p>
        </header>

        {sent ? (
          <div className="rounded-2xl border border-success/40 bg-success/10 p-6 text-center">
            <CheckCircle2 className="mx-auto mb-2 h-7 w-7 text-success" />
            <div className="mb-1 text-base font-semibold text-success">
              הפנייה נשלחה ✓
            </div>
            <p className="text-sm text-fg-secondary">
              תודה שפניתם. נחזור אליכם למייל{' '}
              <bdi dir="ltr" className="text-fg">
                {email.trim()}
              </bdi>{' '}
              בהקדם.
            </p>
            <Link
              to="/"
              className="mt-4 inline-block text-xs text-accent underline underline-offset-2"
            >
              חזרה לדף הבית
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {/* honeypot — hidden from humans, tempting to bots */}
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={hp}
              onChange={(e) => setHp(e.target.value)}
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
              aria-hidden="true"
            />

            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-secondary">שם מלא</span>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="השם שלכם"
                className={inputCls}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-secondary">
                כתובת מייל לחזרה
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                dir="ltr"
                className={`${inputCls} text-right`}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-secondary">
                נושא <span className="text-fg-faint">(רשות)</span>
              </span>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="על מה הפנייה?"
                className={inputCls}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-secondary">הפנייה</span>
              <textarea
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="כתבו כאן את השאלה או הבקשה…"
                rows={6}
                className={`${inputCls} resize-y`}
              />
            </label>

            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit || busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-base font-bold text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Mail className="h-5 w-5" />
              )}
              שליחת הפנייה
            </button>
          </form>
        )}
      </main>
      <Footer />
    </div>
  )
}
