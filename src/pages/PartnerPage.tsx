import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Copy, Loader2, LogOut, RotateCw, X } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import '../styles/pages/partner.css'

/**
 * Partner dashboard (/partner) — a self-serve login where a referral
 * partner sees AGGREGATE stats for their own code: signups, paying
 * accounts, revenue total + by month, and their share link.
 *
 * Privacy: deliberately NO individual customer emails — only counts
 * and sums. The full per-user detail stays in the admin panel.
 *
 * Auth is separate from the customer session: a partner token (signed
 * server-side) lives in sessionStorage and is replayed to
 * partner-stats. Credentials are set by the admin per partner.
 */

const TOKEN_KEY = 'dmplus.partner.v1'

interface PartnerStats {
  code: string
  name: string
  /** ISO timestamp the partnership was created (for the "שותף מאז" line). */
  since?: string | null
  link: string
  visibility: { revenue: boolean; earnings: boolean; counts: boolean }
  /** First-login onboarding gates. */
  mustChangePassword?: boolean
  termsAccepted?: boolean
  signups: number | null
  paidAccounts: number | null
  commission: {
    commissionType: 'percent' | 'fixed'
    commissionValue: number
    commissionCurrency: string
    firstOnly?: boolean
  } | null
  earningsByCurrency: Record<string, number> | null
  earningsByMonth: Record<string, Record<string, number>> | null
  /** What the earnings would have been WITHOUT any fee/VAT. */
  earningsGrossByCurrency?: Record<string, number> | null
  /** Total shaved off the partner's earnings (PayPal fee + VAT). */
  earningsFeeByCurrency?: Record<string, number> | null
  /** PayPal-fee portion of the deduction. */
  earningsPaypalFeeByCurrency?: Record<string, number> | null
  /** VAT portion of the deduction (only when receipts are OFF). */
  earningsVatByCurrency?: Record<string, number> | null
  /** Whether SUMIT receipts are on — when off, VAT is deducted too. */
  receiptsEnabled?: boolean
  revenueByCurrency: Record<string, number> | null
  revenueByMonth: Record<string, Record<string, number>> | null
}

/** Shown when the server can't be reached at all (fetch threw / no JSON). */
const NETWORK_MSG = 'לא הצלחנו להתחבר לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'

/** Only Hebrew reaches the partner — an unexpected server message (which
 *  may be English) falls back to the screen's generic Hebrew one. */
function hebrewOr(msg: string | undefined, fallback: string): string {
  return msg && /[\u0590-\u05FF]/.test(msg) ? msg : fallback
}

const CUR_SYMBOL: Record<string, string> = { ILS: '₪', USD: '$', EUR: '€' }
function curSym(c: string): string {
  return CUR_SYMBOL[c] || c
}

/** Money as the site shows it: "₪ 468.30" (symbol first), several
 *  currencies joined with " · ", nothing (or only zeros) → "—". */
function Money({
  m,
  sign = '',
  cls = '',
}: {
  m: Record<string, number> | null | undefined
  /** Prefix for every amount (the fee lines show "−"). */
  sign?: string
  cls?: string
}) {
  const parts = Object.entries(m || {}).filter(([, v]) => v > 0)
  const bdiCls = `num${cls ? ` ${cls}` : ''}`
  return (
    <span className="amt">
      {parts.length === 0 ? (
        <bdi className={bdiCls}>—</bdi>
      ) : (
        parts.map(([c, v], i) => (
          <Fragment key={c}>
            {i > 0 && ' · '}
            <bdi className={bdiCls} dir="ltr">
              {curSym(c)}
              {'\u00a0'}
              {sign}
              {v.toFixed(2)}
            </bdi>
          </Fragment>
        ))
      )}
    </span>
  )
}

function CommissionLabel({ c }: { c: PartnerStats['commission'] }) {
  if (!c) return <>ההסכם טרם הוגדר</>
  const scope = c.firstOnly ? 'על קנייה ראשונה' : 'על כל קנייה / חידוש'
  return c.commissionType === 'percent' ? (
    <>
      <bdi>{c.commissionValue}%</bdi> {scope}
    </>
  ) : (
    <>
      <bdi dir="ltr">
        {curSym(c.commissionCurrency)}
        {'\u00a0'}
        {c.commissionValue}
      </bdi>{' '}
      {scope}
    </>
  )
}

async function api<T>(action: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/paypal?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await r.json()) as T
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <FlPage name="partner" chrome="min" title="שותפים">
      {children}
    </FlPage>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="note err" role="alert">
      <AlertCircle className="ic" aria-hidden />
      <span>{message}</span>
    </div>
  )
}

function Head({ title, intro }: { title: string; intro?: string }) {
  return (
    <div className="pp-head">
      <span className="eyebrow">שותפים</span>
      <h1 className="pp-h">{title}</h1>
      {intro && <p className="pp-intro">{intro}</p>}
    </div>
  )
}

export default function PartnerPage() {
  const [stats, setStats] = useState<PartnerStats | null>(null)
  const [booting, setBooting] = useState(true)
  // The saved session couldn't be checked because the server was
  // unreachable (not an auth failure — the token is kept for the retry).
  const [bootFailed, setBootFailed] = useState(false)
  const [bootTry, setBootTry] = useState(0)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Last login attempt never reached the server → the button offers a retry.
  const [offline, setOffline] = useState(false)
  const [copied, setCopied] = useState(false)

  // Resume an existing session.
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY)
    if (!token) {
      setBooting(false)
      return
    }
    void (async () => {
      try {
        const r = await api<
          { ok: true; partner: PartnerStats } | { ok: false; error: string }
        >('partner-stats', { token })
        if (r.ok) setStats(r.partner)
        else sessionStorage.removeItem(TOKEN_KEY)
      } catch {
        setBootFailed(true)
      }
      setBooting(false)
    })()
  }, [bootTry])

  function retryBoot() {
    setBootFailed(false)
    setBooting(true)
    setBootTry((n) => n + 1)
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    type LoginResp =
      | { ok: true; token: string; partner: PartnerStats }
      | { ok: false; error: string }
    let r: LoginResp
    try {
      r = await api<LoginResp>('partner-login', { email, password })
    } catch {
      setBusy(false)
      setOffline(true)
      setError(NETWORK_MSG)
      return
    }
    setBusy(false)
    setOffline(false)
    if (!r.ok) {
      setError(hebrewOr(r.error, 'ההתחברות נכשלה'))
      return
    }
    sessionStorage.setItem(TOKEN_KEY, r.token)
    setStats(r.partner)
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY)
    setStats(null)
    setEmail('')
    setPassword('')
  }

  async function copyLink() {
    if (!stats) return
    try {
      await navigator.clipboard.writeText(stats.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  if (booting) {
    return (
      <Shell>
        <div className="pp-center" role="status">
          <Loader2 className="ic spin" aria-hidden />
          <span>טוען…</span>
        </div>
      </Shell>
    )
  }

  if (bootFailed) {
    return (
      <Shell>
        <div className="narrow pp-auth">
          <div className="card pp-card pp-fail" role="alert">
            <span className="pp-fail-ic">
              <AlertCircle className="ic" aria-hidden />
            </span>
            <h1 className="pp-h">הדף לא נטען</h1>
            <p>{NETWORK_MSG}</p>
            <button type="button" className="btn btn-p btn-lg btn-block" onClick={retryBoot}>
              <RotateCw className="ic" aria-hidden />
              ניסיון נוסף
            </button>
          </div>
        </div>
      </Shell>
    )
  }

  // ── Login ──
  if (!stats) {
    return (
      <Shell>
        <div className="narrow pp-auth">
          <form className="card form pp-card" onSubmit={handleLogin}>
            <Head title="כניסת שותפים" />
            <div className="field">
              <label htmlFor="pl-mail">אימייל</label>
              <input
                className="input ltr"
                id="pl-mail"
                type="email"
                dir="ltr"
                required
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="pl-pw">סיסמה</label>
              <input
                className="input ltr"
                id="pl-pw"
                type="password"
                dir="ltr"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <ErrorNote message={error} />}
            <button className="btn btn-p btn-lg btn-block" type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="ic spin" aria-hidden />
              ) : (
                offline && <RotateCw className="ic" aria-hidden />
              )}
              {offline ? 'ניסיון נוסף' : 'התחברות'}
            </button>
          </form>
          <p className="pp-under">הגישה לשותפים בלבד. אם אין לכם פרטי כניסה, פנו אלינו.</p>
        </div>
      </Shell>
    )
  }

  // ── First login, step 1: replace the temp password ──
  if (stats.mustChangePassword) {
    return (
      <Shell>
        <SetPasswordScreen
          onDone={(token, partner) => {
            sessionStorage.setItem(TOKEN_KEY, token)
            setStats(partner)
          }}
          onAuthLost={logout}
        />
      </Shell>
    )
  }

  // ── First login, step 2: accept the partnership terms ──
  if (!stats.termsAccepted) {
    return (
      <Shell>
        <AcceptTermsScreen onDone={(partner) => setStats(partner)} onAuthLost={logout} />
      </Shell>
    )
  }

  // ── Dashboard ──
  // Which money breakdown to show by month (earnings preferred, else
  // gross revenue) — only when the partner is allowed to see it.
  const monthSource = stats.earningsByMonth || stats.revenueByMonth || null
  const monthsTitle = stats.earningsByMonth
    ? 'הרווח שלך לפי חודש'
    : 'הכנסות לפי חודש'
  const months = monthSource
    ? Object.entries(monthSource)
        .filter(([m]) => m !== 'unknown')
        .sort((a, b) => b[0].localeCompare(a[0]))
    : []
  const showMoney = stats.visibility.earnings || stats.visibility.revenue

  // Stats — RTL order (right→left): נרשמו · קנו · סך ההכנסות · סך הרווח
  // שלך. In RTL the first DOM child renders on the right, so the order
  // below is the visual order. Each card shows only if the partner is
  // allowed to see it (a hidden card is absent, never a 0).
  const cards: ReactNode[] = []
  if (stats.signups !== null) {
    cards.push(<Stat key="signups" label="נרשמו" value={String(stats.signups)} />)
  }
  if (stats.paidAccounts !== null) {
    cards.push(<Stat key="paid" label="קנו" value={String(stats.paidAccounts)} />)
  }
  if (stats.visibility.revenue && stats.revenueByCurrency) {
    cards.push(
      <Stat key="revenue" label="סך ההכנסות" value={<Money m={stats.revenueByCurrency} />} money />,
    )
  }
  if (stats.visibility.earnings && stats.earningsByCurrency) {
    cards.push(
      <EarningsStat
        key="earnings"
        net={stats.earningsByCurrency}
        gross={stats.earningsGrossByCurrency}
        fee={stats.earningsFeeByCurrency}
        paypalFee={stats.earningsPaypalFeeByCurrency}
        vat={stats.earningsVatByCurrency}
        receiptsEnabled={stats.receiptsEnabled !== false}
      />,
    )
  }
  const statCols = ['', '', 'g2', 'g3', 'g4'][cards.length]

  return (
    <Shell>
      <div className="wrap pp-dash">
        <div className="pp-top">
          <div>
            <span className="eyebrow">דשבורד שותף</span>
            <h1 className="pp-name">{stats.name}</h1>
            {stats.since && (
              <p className="pp-since">
                שותף מאז{' '}
                <bdi>
                  {new Date(stats.since).toLocaleDateString('he-IL', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </bdi>
              </p>
            )}
          </div>
          <button type="button" className="btn btn-g btn-sm" onClick={logout}>
            <LogOut className="ic" aria-hidden />
            התנתקות
          </button>
        </div>

        <div className={`pp-row${stats.visibility.earnings ? '' : ' one'}`}>
          {/* Share link */}
          <div className="card pp-link">
            <label className="lbl" htmlFor="pd-ref">
              קישור ההפניה שלך
            </label>
            <div className="pp-copy">
              <input
                className="input"
                id="pd-ref"
                readOnly
                dir="ltr"
                value={stats.link}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className={`btn btn-s pp-cp${copied ? ' copied' : ''}`}
                onClick={copyLink}
                aria-live="polite"
              >
                <span className="a">
                  <Copy className="ic" aria-hidden />
                  העתק
                </span>
                <span className="b">
                  <Check className="ic" aria-hidden />
                  הועתק
                </span>
              </button>
            </div>
          </div>

          {/* Commission agreement — only when earnings are shown */}
          {stats.visibility.earnings && (
            <div className="card pp-deal">
              <span className="lbl">ההסכם שלך</span>
              <b>
                <CommissionLabel c={stats.commission} />
              </b>
            </div>
          )}
        </div>

        {cards.length > 0 && <div className={`grid ${statCols} pp-stats`}>{cards}</div>}

        {/* Money by month — only when a money figure is visible */}
        {showMoney && (
          <div className="card pp-months">
            <h2 className="h3">{monthsTitle}</h2>
            <p className="pp-sub">היסטוריה מלאה: כל החודשים מאז תחילת השותפות.</p>
            {months.length === 0 ? (
              <p className="pp-empty">עדיין אין נתונים.</p>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{stats.earningsByMonth ? 'הרווח שלך' : 'הכנסות'}</th>
                      <th scope="col">חודש</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.map(([m, rev]) => (
                      <tr key={m}>
                        <td>
                          <Money m={rev} />
                        </td>
                        <td>
                          <bdi className="num">
                            {m.slice(5, 7)}/{m.slice(0, 4)}
                          </bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p className="pp-foot">הנתונים מתעדכנים בכל טעינה של הדף.</p>
      </div>
    </Shell>
  )
}

function Stat({ label, value, money }: { label: string; value: ReactNode; money?: boolean }) {
  return (
    <div className="card pp-stat">
      <span>{label}</span>
      <b className={money ? 'num money' : 'num'}>{value}</b>
    </div>
  )
}

/** Earnings card — shows the NET payout (after PayPal's fee). Clicking
 *  "(אחרי עמלה של פייפאל)" opens a modal that EXPLAINS why the amount
 *  differs (PayPal's processing fee) + shows the full breakdown. */
function EarningsStat({
  net,
  gross,
  fee,
  paypalFee,
  vat,
  receiptsEnabled,
}: {
  net: Record<string, number>
  gross?: Record<string, number> | null
  fee?: Record<string, number> | null
  paypalFee?: Record<string, number> | null
  vat?: Record<string, number> | null
  receiptsEnabled: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="card pp-stat hot">
        <span>סך הרווח שלך</span>
        <b className="num money">
          <Money m={net} />
        </b>
        <button type="button" className="pp-fee" onClick={() => setOpen(true)}>
          {receiptsEnabled ? '(אחרי עמלה של פייפאל)' : '(אחרי עמלות)'}
        </button>
      </div>
      {open && (
        <FeeExplainModal
          net={net}
          gross={gross}
          fee={fee}
          paypalFee={paypalFee}
          vat={vat}
          receiptsEnabled={receiptsEnabled}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** A small explainer popup for the partner: why the payout is lower
 *  than the sticker price (PayPal's per-transaction processing fee). */
function FeeExplainModal({
  net,
  gross,
  fee,
  paypalFee,
  vat,
  receiptsEnabled,
  onClose,
}: {
  net: Record<string, number>
  gross?: Record<string, number> | null
  fee?: Record<string, number> | null
  paypalFee?: Record<string, number> | null
  vat?: Record<string, number> | null
  receiptsEnabled: boolean
  onClose: () => void
}) {
  // When receipts are OFF, VAT is ALWAYS part of the deduction — show
  // its own line even before any sale, so the partner knows up front
  // that both PayPal AND VAT come off the top. (Not gated on having
  // data: a brand-new partner must still see the structure.)
  const hasVat = !receiptsEnabled
  const paypalLine = paypalFee && Object.keys(paypalFee).length ? paypalFee : fee
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Portaled to <body> with its own .fl root (see fl.css .fl-overlay) so the
  // backdrop covers the whole window, header included.
  return createPortal(
    <div className="fl fl-overlay" dir="rtl">
      <div className="pg-partner">
        <div className="pp-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <div className="dialog pp-dialog" role="dialog" aria-modal="true" aria-labelledby="pp-fee-title">
            <button type="button" className="pp-x" aria-label="סגור" onClick={onClose} autoFocus>
              <X className="ic" aria-hidden />
            </button>

            <h2 id="pp-fee-title">{hasVat ? 'למה הסכום שונה? עמלות' : 'למה הסכום שונה? עמלת PayPal'}</h2>
            <p>
              {hasVat ? (
                <>
                  על כל תשלום נגבית עמלת סליקה של PayPal, ובנוסף משולם מע"מ למדינה. לכן הסכום שנשאר בפועל נמוך
                  מהמחיר שהלקוח שילם. הרווח שלך מחושב על הסכום שנשאר <b>אחרי כל העמלות</b>, כלומר הכסף ה"אמיתי"
                  שנכנס.
                </>
              ) : (
                <>
                  על כל תשלום, חברת PayPal גובה עמלת סליקה. לכן הסכום שמגיע בפועל לחשבון נמוך מהמחיר שהלקוח שילם.
                  הרווח שלך מחושב על הסכום שנשאר <b>אחרי</b> עמלת PayPal, כלומר הכסף ה"אמיתי" שנכנס.
                </>
              )}
            </p>

            <div className="pp-break">
              <div className="ln">
                <span>הרווח שלך (לפני עמלות)</span>
                <Money m={gross} />
              </div>
              <div className="ln">
                <span>עמלת PayPal</span>
                <Money m={paypalLine} sign="−" cls="neg" />
              </div>
              {hasVat && (
                <div className="ln">
                  <span>מע"מ</span>
                  <Money m={vat} sign="−" cls="neg" />
                </div>
              )}
              <hr />
              <div className="ln tot">
                <span>{hasVat ? 'הרווח שלך (אחרי עמלות)' : 'הרווח שלך (אחרי עמלה)'}</span>
                <Money m={net} cls="pos" />
              </div>
            </div>

            <p className="fine">
              {hasVat
                ? 'עמלת PayPal נקבעת על ידי PayPal ומשתנה מעט בין עסקה לעסקה. המע"מ מחושב לפי השיעור הנהוג. המספרים כאן הם הסכומים האמיתיים שנגבו בפועל.'
                : 'העמלה נקבעת על ידי PayPal ומשתנה מעט בין עסקה לעסקה (מטבע, המרת מטבע ועוד). המספרים כאן הם העמלות האמיתיות שנגבו בפועל.'}
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── First-login: set a permanent password ──────────────────────── */
function SetPasswordScreen({
  onDone,
  onAuthLost,
}: {
  onDone: (token: string, partner: PartnerStats) => void
  onAuthLost: () => void
}) {
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (pw1.length < 6) {
      setError('הסיסמה חייבת להיות לפחות 6 תווים')
      return
    }
    if (pw1 !== pw2) {
      setError('הסיסמאות אינן תואמות')
      return
    }
    setBusy(true)
    setError(null)
    const token = sessionStorage.getItem(TOKEN_KEY) || ''
    const r = await api<
      | { ok: true; token: string; partner: PartnerStats }
      | { ok: false; error: string }
    >('partner-change-password', { token, newPassword: pw1 })
    setBusy(false)
    if (!r.ok) {
      if (r.error === 'unauthorized') return onAuthLost()
      setError(hebrewOr(r.error, 'העדכון נכשל'))
      return
    }
    onDone(r.token, r.partner)
  }

  return (
    <div className="narrow pp-auth">
      <form className="card form pp-card" onSubmit={submit}>
        <Head
          title="הגדרת סיסמה קבועה"
          intro="זו הכניסה הראשונה שלך. בחר/י סיסמה קבועה שתחליף את הסיסמה הזמנית שקיבלת במייל."
        />
        <div className="field">
          <label htmlFor="ps-new">סיסמה חדשה</label>
          <input
            className="input ltr"
            id="ps-new"
            type="password"
            dir="ltr"
            required
            autoComplete="new-password"
            autoFocus
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ps-rep">אימות סיסמה</label>
          <input
            className="input ltr"
            id="ps-rep"
            type="password"
            dir="ltr"
            required
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </div>
        {error && <ErrorNote message={error} />}
        <button className="btn btn-p btn-lg btn-block" type="submit" disabled={busy}>
          {busy && <Loader2 className="ic spin" aria-hidden />}
          שמירה והמשך
        </button>
      </form>
    </div>
  )
}

/* ── First-login: accept the partnership terms ──────────────────── */
function AcceptTermsScreen({
  onDone,
  onAuthLost,
}: {
  onDone: (partner: PartnerStats) => void
  onAuthLost: () => void
}) {
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The admin-editable partner terms (appConfig/partnerTerms). When the
  // admin hasn't published a doc yet, sections stays empty and we render
  // the built-in PARTNER_TERMS fallback below.
  const [sections, setSections] = useState<
    { title: string; paragraphs: string[] }[]
  >([])
  useEffect(() => {
    let active = true
    api<{ ok?: boolean; sections?: { title: string; paragraphs: string[] }[] }>(
      'get-partner-terms',
      {},
    )
      .then((d) => {
        if (active && Array.isArray(d?.sections)) setSections(d.sections)
      })
      .catch(() => {
        /* keep fallback */
      })
    return () => {
      active = false
    }
  }, [])

  async function accept() {
    if (busy || !agreed) return
    setBusy(true)
    setError(null)
    const token = sessionStorage.getItem(TOKEN_KEY) || ''
    const r = await api<
      { ok: true; partner: PartnerStats } | { ok: false; error: string }
    >('partner-accept-terms', { token })
    setBusy(false)
    if (!r.ok) {
      if (r.error === 'unauthorized') return onAuthLost()
      setError(hebrewOr(r.error, 'הפעולה נכשלה'))
      return
    }
    onDone(r.partner)
  }

  return (
    <div className="narrow pp-auth pp-wide">
      <div className="card pp-card">
        <Head title="תקנון תוכנית השותפים" />
        <div className="pp-terms" tabIndex={0} role="region" aria-label="תקנון תוכנית השותפים">
          {sections.length > 0
            ? sections.map((sec, si) => (
                <div key={si} className="pp-sec">
                  {sec.title && <b className="pp-sec-t">{sec.title}</b>}
                  {sec.paragraphs.map((para, pi) => (
                    <p key={pi}>{para}</p>
                  ))}
                </div>
              ))
            : PARTNER_TERMS.map(([title, text], i) => (
                <p key={i}>
                  {title && <b>{title}: </b>}
                  {text}
                </p>
              ))}
        </div>
        <div className="pp-accept">
          <label className="check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            קראתי את התקנון ואני מאשר/ת את תנאי תוכנית השותפים.
          </label>
          {error && <ErrorNote message={error} />}
          <button
            type="button"
            className="btn btn-p btn-lg btn-block"
            disabled={!agreed || busy}
            onClick={accept}
          >
            {busy && <Loader2 className="ic spin" aria-hidden />}
            אני מאשר/ת וממשיך/ה
          </button>
        </div>
      </div>
    </div>
  )
}

/* Default partnership terms, as [bold title, text]. Placeholder copy —
 * edit freely; bump PARTNER_TERMS_VERSION in api/paypal.ts to force
 * partners to re-accept after a material change. */
const PARTNER_TERMS: [string, string][] = [
  ['', 'ברוכים הבאים לתוכנית השותפים של פריימליין. התקנון להלן מסדיר את היחסים בינך לבין החברה כשותף/ה.'],
  ['1. שיוך מכירות', 'מכירה תזוכה לך רק כאשר הלקוח נכנס דרך קישור ההפניה האישי שלך וביצע רכישה בפועל. החברה רשאית לבדוק ולאמת כל שיוך.'],
  ['2. עמלות', 'גובה העמלה ואופן חישובה נקבעים בהסכם האישי שלך כפי שמוצג בדשבורד. העמלה מחושבת על הסכום שנותר בפועל לאחר עמלת הסליקה ולאחר מע"מ, ומשולמת על עסקאות שלא בוטלו או הוחזרו.'],
  ['3. תשלומים', 'תשלום העמלות יבוצע במועדים ובאמצעים שתיאמת עם החברה. עסקה שבוטלה, הוחזרה (chargeback) או לא נגבתה, לא תזכה בעמלה, ותקוזז אם כבר שולמה.'],
  ['4. שיווק הוגן', 'אין לפרסם את המוצר בדרכים מטעות, ספאם, או הבטחות שווא, ואין להשתמש במותג החברה באופן שאינו מאושר. החברה רשאית להפסיק את השותפות בגין הפרה.'],
  ['5. סודיות ופרטיות', 'נתוני הדשבורד מיועדים לך בלבד. אינך רשאי/ת לחשוף נתונים, רשימות לקוחות או מידע עסקי של החברה.'],
  ['6. סיום', 'כל צד רשאי לסיים את השותפות בכל עת. עמלות שנצברו כדין עד מועד הסיום ישולמו בהתאם לתקנון.'],
  ['7. שינויים', 'החברה רשאית לעדכן את התקנון מעת לעת. המשך שימוש בדשבורד לאחר עדכון מהווה הסכמה לתנאים המעודכנים.'],
  ['', 'אישור התקנון מהווה הסכמה מלאה לכל האמור לעיל.'],
]
