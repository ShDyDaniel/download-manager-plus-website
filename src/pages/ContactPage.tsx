import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, CheckCircle2, HelpCircle, LifeBuoy, Loader2, Mail } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { SettingsMini, SupportPath } from '../components/SupportLanding'
import '../styles/pages/contact.css'

/* צור קשר — public contact form. Posts to /api/paypal?action=submit-contact,
 * which stores the message in the same `feedback` collection the admin
 * "פניות" tab reads, and pings the operator on Telegram. */

const SEND_FAILED = 'שליחת הפנייה נכשלה. נסו שוב'
/** Only Hebrew reaches the visitor — an unexpected server message (which
 *  may be English) falls back to the generic Hebrew one. */
const hebrewOr = (msg: string | undefined, fallback: string) =>
  msg && /[\u0590-\u05FF]/.test(msg) ? msg : fallback

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
        setError(hebrewOr(j.error, SEND_FAILED))
      } else {
        setSent(true)
      }
    } catch {
      setError(SEND_FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FlPage name="contact" chrome="full" title="צור קשר">
      <div className="narrow">
        <div className="phero ct-hero">
          <span className="ct-tile">
            <Mail className="ic" aria-hidden />
          </span>
          <h1 className="display">צור קשר</h1>
          <p className="lead">יש לכם שאלה, בעיה או הצעה? כתבו לנו ונחזור אליכם למייל בהקדם.</p>
        </div>
      </div>

      <div className="wrap ct-grid">
        <div className="ct-main">
          <div>
            {sent ? (
              <div className="card ct-done" role="status">
                <span className="ct-done-ic">
                  <CheckCircle2 className="ic" aria-hidden />
                </span>
                <h2 className="h3">הפנייה נשלחה</h2>
                <p>
                  תודה שפניתם. נחזור אליכם למייל <bdi dir="ltr">{email.trim()}</bdi> בהקדם.
                </p>
                <Link className="btn btn-s" to="/">
                  חזרה לדף הבית
                </Link>
              </div>
            ) : (
              <form className="card form ct-form" onSubmit={submit}>
                <div className="grid g2">
                  <div className="field">
                    <label htmlFor="ct-name">שם מלא</label>
                    <input
                      className="input"
                      id="ct-name"
                      name="name"
                      type="text"
                      required
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="השם שלכם"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="ct-mail">כתובת מייל לחזרה</label>
                    <input
                      className="input ltr"
                      id="ct-mail"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      dir="ltr"
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="ct-subj">
                    נושא <span className="opt">(רשות)</span>
                  </label>
                  <input
                    className="input"
                    id="ct-subj"
                    name="subject"
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="על מה הפנייה?"
                  />
                </div>

                <div className="field fmsg">
                  <label htmlFor="ct-msg">הפנייה</label>
                  <textarea
                    className="textarea"
                    id="ct-msg"
                    name="message"
                    required
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="כתבו כאן את השאלה או הבקשה…"
                    rows={6}
                  />
                </div>

                {/* honeypot — hidden from humans, tempting to bots. No name/label
                    on purpose, so browser autofill never fills it for a person. */}
                <div className="ct-hp" aria-hidden="true">
                  <input
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={hp}
                    onChange={(e) => setHp(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="note err" role="alert">
                    <AlertCircle className="ic" aria-hidden />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  className="btn btn-p btn-lg btn-block"
                  type="submit"
                  disabled={!canSubmit || busy}
                  aria-busy={busy || undefined}
                >
                  {busy ? <Loader2 className="ic spin" aria-hidden /> : <Mail className="ic" aria-hidden />}
                  שליחת הפנייה
                </button>
              </form>
            )}
          </div>
        </div>

        <aside className="ct-side" aria-label="דרכים נוספות ליצור קשר">
          <div className="card ct-alt">
            <span className="ct-ic">
              <Mail className="ic" aria-hidden />
            </span>
            <div>
              <h2 className="h3">אפשר גם במייל</h2>
              <p>כתבו לנו ישירות לכתובת:</p>
              <a className="link ct-mailto" href="mailto:help.frameline@gmail.com">
                <bdi dir="ltr">help.frameline@gmail.com</bdi>
              </a>
            </div>
          </div>
          <div className="card ct-alt">
            <span className="ct-ic">
              <HelpCircle className="ic" aria-hidden />
            </span>
            <div>
              <h2 className="h3">שאלות נפוצות</h2>
              <p>אולי כבר יש תשובה לשאלה שלכם.</p>
              <Link className="link" to="/faq">
                לשאלות הנפוצות
              </Link>
            </div>
          </div>
          <div className="card ct-alt ct-code">
            <span className="ct-ic">
              <LifeBuoy className="ic" aria-hidden />
            </span>
            <div>
              <h2 className="h3">קיבלתם קוד מצוות התמיכה?</h2>
              <p>
                מזינים אותו בתוכנה, ב<SupportPath />.
              </p>
            </div>
            <SettingsMini caption="כך זה נראה בהגדרות של התוכנה" />
          </div>
        </aside>
      </div>
    </FlPage>
  )
}
