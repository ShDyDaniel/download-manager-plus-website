import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TermsModal, PrivacyModal } from './LegalModals'
import { AccessibilityModal } from './AccessibilityModal'

/**
 * Footer — minimal, three-column on desktop, stacked on mobile.
 * Editorial restraint: small label + serif wordmark + meta line.
 * No social-icon noise, no newsletter signup, no link soup.
 *
 * Israeli consumer-protection law sec. 14ט(א) requires a visible
 * subscription-cancellation affordance on the public-facing site
 * "באופן בולט וברור" (prominently and clearly). The previous
 * design used a full-width bordered card with a red icon button —
 * that satisfied "prominent" but visually overwhelmed the rest of
 * the footer. We now satisfy the requirement with a single inline
 * "ביטול מנוי" text link sitting in the same meta row as the
 * copyright. It's not loud, but it's:
 *   - permanently visible on every public page (the footer
 *     renders on / / /buy and is unaffected by sign-in state)
 *   - separated by a `·` so it reads as a distinct meta item
 *   - the same font-size as the copyright line beside it
 * which keeps it discoverable enough that a regulator scanning
 * the page can find it within a second of arriving on the site.
 *
 * If you ever remove this link, replace it with another visible
 * cancellation affordance on the public site before deploying —
 * otherwise the site is out of compliance with 14ט(א).
 */
export function Footer() {
  const year = new Date().getFullYear()
  // Legal docs open on demand only. We deliberately do NOT prefetch
  // them here — the footer renders on every page, and these docs are
  // rarely read, so reading them from the DB eagerly would waste a
  // Firestore read on every visit. The modal fetches on click (and
  // caches per session, so a second open is free). See LegalModals.
  const [termsOpen, setTermsOpen] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [a11yOpen, setA11yOpen] = useState(false)

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

          {/* Meta — legal links + copyright. RTL flex orders DOM
              children right→left, so the visual order matches the DOM
              order requested by the user:
                תנאי שימוש · מדיניות פרטיות · הצהרת נגישות · ביטול מנוי
              with the copyright trailing on the far visual left.
              Terms + Privacy open on-demand modals (no navigation, no
              eager DB read); the others are page links. */}
          <div className="flex flex-col items-start gap-1 md:items-end">
            <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg-muted">
              <button
                type="button"
                onClick={() => setTermsOpen(true)}
                className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                תנאי שימוש
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => setPrivacyOpen(true)}
                className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                מדיניות פרטיות
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => setA11yOpen(true)}
                className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                הצהרת נגישות
              </button>
              <span aria-hidden>·</span>
              <Link
                to="/contact"
                className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                צור קשר
              </Link>
              <span aria-hidden>·</span>
              <Link
                to="/account"
                className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                ביטול מנוי
              </Link>
              <span aria-hidden>·</span>
              {/* Copyright as its own RTL inline-flex so each segment is
                  a positioned flex item — this avoids the bidi mess
                  where the neutral "©"/year digits jumped to the wrong
                  side of the Hebrew text. Visual right→left:
                  "© 2026 · כל הזכויות שמורות". */}
              <span dir="rtl" className="inline-flex items-center gap-x-1.5">
                <span dir="ltr" className="tabular">
                  © {year}
                </span>
                <span aria-hidden>·</span>
                כל הזכויות שמורות
              </span>
            </div>
          </div>
        </div>
      </div>

      {termsOpen && <TermsModal onClose={() => setTermsOpen(false)} />}
      {privacyOpen && <PrivacyModal onClose={() => setPrivacyOpen(false)} />}
      {a11yOpen && <AccessibilityModal onClose={() => setA11yOpen(false)} />}
    </footer>
  )
}
