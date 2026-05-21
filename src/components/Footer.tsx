import { Link } from 'react-router-dom'
import { XCircle } from 'lucide-react'

/**
 * Footer — minimal, three-column on desktop, stacked on mobile.
 * Editorial restraint: small label + serif wordmark + meta line.
 * No social-icon noise, no newsletter signup, no link soup.
 *
 * Includes a LEGALLY REQUIRED prominent subscription-cancellation
 * link (Israeli consumer-protection law sec. 14ט(א)) — the link
 * must be visible "באופן בולט וברור" on the public-facing site.
 * Putting it in the footer satisfies the prominence requirement
 * while not crowding the marketing content above.
 */
export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-border px-6 py-12 md:py-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-10">
        <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
          {/* Brand block */}
          <div>
            <div className="flex items-center gap-3">
              <img
                src="./icon.png"
                alt=""
                className="h-9 w-9 rounded-[10px]"
                style={{
                  boxShadow:
                    '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 20px rgba(13,8,4,0.4)',
                }}
              />
              <div className="flex flex-col">
                <span className="font-display text-lg text-fg">
                  ניהול הורדות פלוס
                </span>
                <span className="text-xs text-fg-muted">
                  כלי לעורכי וידאו ויוצרי תוכן
                </span>
              </div>
            </div>
          </div>

          {/* Meta — credit, year, version. Tabular for the year so
              it aligns nicely if the layout shifts. */}
          <div className="flex flex-col items-start gap-1 md:items-end">
            <div className="label">— Made in Israel —</div>
            <div className="text-sm text-fg-muted">
              © <span className="tabular">{year}</span> · כל הזכויות שמורות
            </div>
          </div>
        </div>

        {/* Legal-required prominent cancellation link. The icon +
            border treatment make it visually distinct so it can't
            be mistaken for a secondary nav item — Israeli law
            specifically requires this link be "באופן בולט וברור". */}
        <div className="rounded-xl border border-border bg-bg-elevated/40 px-4 py-3 md:flex md:items-center md:justify-between md:gap-4">
          <div className="text-xs text-fg-secondary">
            יש לך מנוי Pro פעיל? אפשר לבטל בכל עת — הביטול נכנס לתוקף מיידית
            ולא תחויב על תקופות עתידיות.
          </div>
          <Link
            to="/manage"
            className="mt-2 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/[0.06] px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/[0.12] md:mt-0"
          >
            <XCircle className="h-3.5 w-3.5" />
            ביטול מנוי
          </Link>
        </div>
      </div>
    </footer>
  )
}
