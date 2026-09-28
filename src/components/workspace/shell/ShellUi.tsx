import { useState } from 'react'
import { AlertCircle } from 'lucide-react'

/**
 * Presentational pieces of ProWorkspaceShell's own screens (sign-in,
 * sign-up, forgot password, the plan gate, loading, errors). They use
 * the SITE look (fl.css + src/styles/pages/workspace.css); the workspace
 * that mounts once the user is in keeps the desktop app's look.
 */

export const LOGO_MARK = '/logo-mark.svg?v=1'

/** Centred column with the soft copper glow behind it. */
export function ShellStage({
  wide = false,
  children,
}: {
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="ws-stage">
      <div className={`ws-wrap${wide ? ' wide' : ''}`}>{children}</div>
    </section>
  )
}

/** Logo mark with a small status badge (spinner / error / lock …). */
export function ShellMark({
  badge,
  tone,
}: {
  badge: React.ReactNode
  tone?: 'ok' | 'err' | 'spin'
}) {
  return (
    <div className="ws-mark">
      <img src={LOGO_MARK} alt="" width={60} height={60} />
      <span className={`ws-badge${tone ? ` ${tone}` : ''}`}>{badge}</span>
    </div>
  )
}

/** Error message box above a form's button (always Hebrew). */
export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="note err" role="alert">
      <AlertCircle className="ic" aria-hidden />
      <span>{children}</span>
    </div>
  )
}

/** The 6-digit code as six boxes. One real input is laid over them
 *  (transparent), so typing, pasting and one-time-code autofill work as
 *  on any text field; the boxes only picture its value. */
export function CodeBoxes({
  id,
  value,
  onChange,
  bad = false,
  describedBy,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  bad?: boolean
  describedBy?: string
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div className={`otp ws-otp${bad ? ' bad' : ''}`}>
      <input
        id={id}
        className="ws-otp-in"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        aria-invalid={bad || undefined}
        aria-describedby={describedBy}
      />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} aria-hidden className={focused && i === value.length ? 'cur' : undefined}>
          {value[i] || ''}
        </span>
      ))}
    </div>
  )
}

