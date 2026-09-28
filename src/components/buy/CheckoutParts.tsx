import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react'
import {
  CircleCheck,
  CircleX,
  CreditCard,
  Crown,
  Laptop,
  Lock,
  Mail,
  TriangleAlert,
  X,
} from 'lucide-react'
import { formatPrice } from '../../lib/pricing'

/**
 * Presentational pieces of the /buy checkout (styles: .pg-buy in
 * src/styles/pages/buy.css). No logic lives here — BuyPage owns every state,
 * request and PayPal call and only hands these the values to show.
 */

/** Checkout-style amount: the number, then the currency sign, kept LTR. */
export function Amt({ n, sym }: { n: number; sym: string }) {
  return (
    <bdi dir="ltr" className="num">
      {formatPrice(n)} {sym}
    </bdi>
  )
}

/** A date (DD.MM.YYYY) kept LTR inside Hebrew text. */
export function DateText({ children }: { children: string }) {
  return (
    <bdi dir="ltr" className="num">
      {children}
    </bdi>
  )
}

/** The order summary box: plan, the price per cycle, the ×12 breakdown for a
 *  yearly price (the cards quote yearly per month, so the total has to be
 *  explained here) and the "now / from then on" rows. */
export function OrderSummary({
  label,
  title,
  sub,
  amount,
  sym,
  cycleWord,
  yearly,
  rows,
}: {
  label: string
  title: string
  sub: ReactNode
  amount: number
  sym: string
  cycleWord: string
  yearly: boolean
  rows: [ReactNode, ReactNode][]
}) {
  return (
    <div className="sum">
      <div className="sum-h">
        <div>
          <span className="lbl2">{label}</span>
          <h3>{title}</h3>
          <span className="sub">{sub}</span>
        </div>
        <div className="big">
          <span className="bn">
            <Amt n={amount} sym={sym} />
            <small>/ {cycleWord}</small>
          </span>
          <small className="vat">כולל מע״מ</small>
        </div>
      </div>
      {yearly && (
        <div className="x12">
          <div className="between">
            <span>מחיר לחודש</span>
            <Amt n={Math.round((amount / 12) * 100) / 100} sym={sym} />
          </div>
          <div className="times">× 12 חודשים</div>
          <div className="between tot">
            <span>סה״כ לשנה, בתשלום אחד</span>
            <Amt n={amount} sym={sym} />
          </div>
        </div>
      )}
      <div className="rows">
        {rows.map(([a, b], i) => (
          <div className="between" key={i}>
            <span>{a}</span>
            <span>{b}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The separate auto-renew consent (Consumer Protection Law, sec. 13ג).
 *  Never pre-ticked; states the amount and the cycle; "לתנאי המנוי" opens the
 *  terms dialog without ticking the box. */
export function RenewConsent({
  checked,
  onChange,
  amount,
  cycleWord,
  extra,
  onOpenTerms,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  amount: ReactNode
  cycleWord: string
  extra?: ReactNode
  onOpenTerms: () => void
}) {
  return (
    <label className="check consent">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        אני מאשר/ת חיוב אוטומטי מתחדש בסך {amount} כל {cycleWord}
        {extra}, ושקראתי ואני מסכים/ה{' '}
        <button
          type="button"
          className="tlink"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpenTerms()
          }}
        >
          לתנאי המנוי
        </button>
        .
      </span>
    </label>
  )
}

/** Said before the pay button: an Intel-Mac owner must not be able to pay for
 *  an app that won't run on their machine. */
export function PlatformNote() {
  return (
    <div className="plat">
      <Laptop className="ic" aria-hidden />
      <span>
        התוכנה פועלת על Mac עם שבב M1 ומעלה ועל Windows 10/11 בגרסת 64 ביט.
        מחשבי Mac עם מעבד Intel אינם נתמכים.
      </span>
    </div>
  )
}

/**
 * Trust strip under the card button. Card-only checkout lost PayPal's own
 * branded button, so this names who processes the card and that we never see
 * it.
 */
export function PaymentTrustStrip() {
  return (
    <div className="trust">
      <span className="l1">
        <Lock className="ic" aria-hidden />
        תשלום מאובטח, מעובד על־ידי <b className="pp">PayPal</b>
      </span>
      <span className="l2">פרטי הכרטיס מועברים ישירות ל-PayPal ולא נשמרים אצלנו</span>
    </div>
  )
}

/**
 * The pay area shared by every checkout flow: platform sentence, error, then
 * either the "what's missing" hint (with a dimmed stand-in where the card
 * button will appear), the PayPal loading / failure line, or the container
 * PayPal renders its button into. The caller decides every state.
 */
export function PayArea({
  gate,
  error,
  sdkError,
  sdkReady,
  containerRef,
  containerId,
  amount,
  sym,
  cycleWord,
}: {
  /** Hint shown instead of the button while the form isn't complete. */
  gate: string | null
  error: string | null
  sdkError: string | null
  sdkReady: boolean
  containerRef: Ref<HTMLDivElement>
  containerId?: string
  amount: number
  sym: string
  cycleWord: string
}) {
  return (
    <div className="pay">
      <PlatformNote />
      {error && (
        <div className="note err" role="alert">
          <TriangleAlert className="ic" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {gate ? (
        <>
          <p className="gate" role="status">
            {gate}
          </p>
          <div className="pp-btn" aria-hidden>
            <CreditCard className="ic" />
            כרטיס חיוב או אשראי
          </div>
        </>
      ) : sdkError ? (
        <div className="note err" role="alert">
          <TriangleAlert className="ic" aria-hidden />
          <span>{sdkError}</span>
        </div>
      ) : !sdkReady ? (
        <div className="pp-load" role="status">
          <span className="spin sm" aria-hidden />
          טוען את PayPal…
        </div>
      ) : (
        <div
          id={containerId}
          ref={containerRef}
          className="ppwrap"
          role="group"
          aria-label="אפשרויות תשלום של PayPal"
        />
      )}
      <PaymentTrustStrip />
      <p className="fline">
        <Amt n={amount} sym={sym} /> / {cycleWord}
        <span className="vat"> · כולל מע״מ</span> · מתחדש אוטומטית · ביטול בכל עת
      </p>
    </div>
  )
}

/** "תנאי המנוי · סיכום העסקה" — the disclosures the buyer can open before
 *  paying (sec. 13ג). A native dialog: Esc and a click outside close it. */
export function TermsDialog({
  open,
  onClose,
  planLine,
  amountLine,
  cycleWord,
  saleNote,
}: {
  open: boolean
  onClose: () => void
  planLine: ReactNode
  amountLine: ReactNode
  cycleWord: string
  /** Extra auto-renew line for a locked sale price (off today). */
  saleNote?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="terms"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog">
        <div className="dlg-h">
          <span className="crown">
            <Crown className="ic" aria-hidden />
          </span>
          <h2 id={titleId}>תנאי המנוי · סיכום העסקה</h2>
          <button type="button" className="dlg-x" aria-label="סגירה" onClick={onClose}>
            <X className="ic" aria-hidden />
          </button>
        </div>
        <ul className="tl">
          <li>
            <b>תוכנית:</b> {planLine}
          </li>
          <li>
            <b>סכום החיוב:</b> {amountLine}
          </li>
          <li>
            <b>חידוש אוטומטי:</b> החיוב יתחדש אוטומטית כל {cycleWord} עד לביטול.
            {saleNote}
          </li>
          <li>
            <b>ביטול:</b> ניתן לבטל בכל עת בדף{' '}
            <a className="link" href="/account">
              החשבון שלי
            </a>
            . המנוי הוא לתקופה בלתי מוגבלת ומתחדש בכל מחזור חיוב עד שתבטלו. אחרי
            הביטול לא תחויבו יותר.
          </li>
          <li>
            <b>החזרים:</b> ביטול בתוך ארבעה עשר יום מהרכישה הראשונה — כל הסכום
            חוזר, פחות דמי ביטול קטנים. במנוי שנתי, גם אחר כך: מקבלים בחזרה את מה
            ששולם, פחות המחיר החודשי הרגיל על כל חודש שהתחיל, ופחות דמי ביטול.
            במנוי חודשי, אחרי ארבעה עשר הימים הראשונים, הגישה נשארת עד סוף החודש
            ששולם, בלי החזר. לפני הביטול מוצג בדיוק כמה יחזור.
          </li>
          <li>
            <b>אבטחה:</b> התשלום מתבצע ישירות אצל PayPal. אנחנו לא מאחסנים פרטי
            כרטיס.
          </li>
        </ul>
        <button type="button" className="btn btn-p btn-block" onClick={onClose}>
          הבנתי
        </button>
      </div>
    </dialog>
  )
}

/** A centred status card inside the checkout (loading / price unavailable). */
export function GateCard({ loading, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <div className="card co-st gate-st" role="status">
      {loading && <span className="spin" aria-hidden />}
      <p>{children}</p>
    </div>
  )
}

/** The hard block shown instead of any way to pay when the server price
 *  can't be confirmed. */
export function PurchaseBlocked() {
  return (
    <div className="card co-st gate-st">
      <span className="ret-ic warn">
        <TriangleAlert className="ic" aria-hidden />
      </span>
      <h3 className="h3">הרכישה אינה זמינה כרגע</h3>
      <p>
        לא הצלחנו לטעון את פרטי המנוי מהשרת כרגע, כנראה עקב עומס זמני. כדי לא
        לחייב אתכם לפני שהכול מוכן, חסמנו את הרכישה לרגע. אנא נסו שוב בעוד מספר
        דקות.
      </p>
      <div className="actions">
        <button type="button" className="btn btn-s" onClick={() => window.location.reload()}>
          נסו שוב
        </button>
      </div>
    </div>
  )
}

/* ── Return screens (after PayPal), shown at the top of the page ── */

/** What the page remembers about the payment that just finished (written in
 *  PayPal's onApprove, right before the redirect). null = unknown. */
export type ReturnFlow =
  | { flow: 'new' }
  | { flow: 'new-in' }
  | { flow: 'renew'; plan: string; startsAt?: string }
  | null

function AccountLine() {
  return (
    <p className="small muted renew-l">
      המנוי מתחדש אוטומטית. לביטול בכל עת:{' '}
      <a className="link" href="/account">
        החשבון שלי
      </a>
    </p>
  )
}

function DownloadLine({ onDownload }: { onDownload: () => void }) {
  return (
    <p className="small">
      <button type="button" className="link linkbtn" onClick={onDownload}>
        עוד אין לכם את התוכנה? להורדה
      </button>
    </p>
  )
}

function MailTip() {
  return (
    <div className="note info">
      <Mail className="ic" aria-hidden />
      <span>
        <b>לא רואים את המייל?</b> לפעמים זה לוקח עד דקה. בדקו גם בספאם ובקידום
        מכירות.
      </span>
    </div>
  )
}

export function ReturnScreen({
  kind,
  flow,
  onBackToCheckout,
  onDownload,
}: {
  kind: 'subscribed' | 'cancelled'
  flow: ReturnFlow
  onBackToCheckout: () => void
  onDownload: () => void
}) {
  if (kind === 'cancelled') {
    return (
      <div className="card ret" role="status">
        <span className="ret-ic mu">
          <CircleX className="ic" aria-hidden />
        </span>
        <h2 className="h3">התשלום בוטל</h2>
        <p>לא נוצר מנוי ולא חויבתם. אם זה קרה בטעות, אפשר לנסות שוב.</p>
        <div className="actions">
          <button type="button" className="btn btn-p" onClick={onBackToCheckout}>
            חזרה לתשלום
          </button>
        </div>
      </div>
    )
  }

  const ok = (
    <span className="ret-ic">
      <CircleCheck className="ic" aria-hidden />
    </span>
  )

  if (flow?.flow === 'new') {
    return (
      <div className="card ret" role="status">
        {ok}
        <h2 className="h3">המנוי נוצר בהצלחה</h2>
        <p>שלחנו לכם מייל עם מפתח המוצר. כך מפעילים אותו:</p>
        <ol className="steps">
          <li>פותחים את התוכנה</li>
          <li>
            לוחצים על <span className="ui">מימוש מפתח מוצר</span>
          </li>
          <li>מדביקים את המפתח מהמייל</li>
        </ol>
        <MailTip />
        <AccountLine />
        <DownloadLine onDownload={onDownload} />
      </div>
    )
  }

  if (flow?.flow === 'new-in') {
    return (
      <div className="card ret" role="status">
        {ok}
        <h2 className="h3">המנוי נוצר בהצלחה</h2>
        <p>
          המפתח שויך לחשבון שלכם אוטומטית, ואין צורך להזין אותו בתוכנה. פתחו את
          התוכנה מאותו חשבון, והמסלול החדש כבר פעיל.
        </p>
        <AccountLine />
        <DownloadLine onDownload={onDownload} />
      </div>
    )
  }

  if (flow?.flow === 'renew') {
    return (
      <div className="card ret" role="status">
        {ok}
        <h2 className="h3">המנוי עודכן בהצלחה</h2>
        <div className="inset kv">
          <div className="between">
            <span>המסלול</span>
            <b>
              {flow.plan}
              {flow.startsAt && (
                <>
                  , החל מ-<DateText>{flow.startsAt}</DateText>
                </>
              )}
            </b>
          </div>
        </div>
        <p>
          המפתח נשאר אותו מפתח, אין צורך לעדכן שום דבר בתוכנה. שלחנו לכם גם מייל
          אישור.
        </p>
        <AccountLine />
      </div>
    )
  }

  // Unknown flow (PayPal's own return page, or the browser dropped the
  // marker): wording that is true for a new purchase, a signed-in purchase
  // and a renewal / plan change alike.
  return (
    <div className="card ret" role="status">
      {ok}
      <h2 className="h3">התשלום הושלם בהצלחה</h2>
      <p>שלחנו לכם מייל אישור עם כל הפרטים.</p>
      <div className="cases">
        <p>
          <b>רכשתם מנוי חדש?</b> מפתח המוצר מחכה במייל. פותחים את התוכנה, לוחצים
          על <span className="ui">מימוש מפתח מוצר</span> ומדביקים אותו. אם הייתם
          מחוברים לחשבון בזמן הרכישה, המפתח כבר שויך אליו.
        </p>
        <p>
          <b>חידשתם או החלפתם מסלול?</b> המפתח נשאר אותו מפתח, ואין צורך לעדכן
          שום דבר בתוכנה.
        </p>
      </div>
      <MailTip />
      <AccountLine />
      <DownloadLine onDownload={onDownload} />
    </div>
  )
}
