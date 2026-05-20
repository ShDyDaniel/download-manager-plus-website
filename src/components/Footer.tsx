/**
 * Footer — minimal, three-column on desktop, stacked on mobile.
 * Editorial restraint: small label + serif wordmark + meta line.
 * No social-icon noise, no newsletter signup, no link soup.
 */
export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t border-border px-6 py-12 md:py-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 md:flex-row md:items-end md:justify-between">
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
    </footer>
  )
}
