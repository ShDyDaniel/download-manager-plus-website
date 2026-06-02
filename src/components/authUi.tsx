import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Shared auth UI primitives — a 1:1 port of the DESKTOP app's login
 * screen design (src/pages/LoginScreen.tsx) so the website's /account
 * and /revisions sign-in look identical to the app:
 *
 *   - No card. The form sits on the espresso background.
 *   - Bottom-border-only inputs with a small uppercase tracked label.
 *   - A single solid-copper CTA (rounded-md, h-11) — no gradient pill.
 *   - Editorial label + display headline above the form.
 *   - Inline mode-switch links with em-dash separators.
 *
 * Tokens are the website's (text-fg / text-fg-muted / bg-primary /
 * text-bg / text-accent …) rather than the desktop's, but the visual
 * result matches.
 */

/** Editorial header: tiny uppercase label + large display title. */
export function AuthHeader({ label, title }: { label: string; title: string }) {
  return (
    <div className="mb-8">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
        {label}
      </div>
      <h1
        className="font-display text-fg"
        style={{
          fontSize: 'clamp(28px, 4vw, 38px)',
          lineHeight: 1.05,
          letterSpacing: '-0.025em',
          fontWeight: 500,
        }}
      >
        {title}
      </h1>
    </div>
  )
}

/** Bottom-border-only input with a floating uppercase caption. */
export function AuthInput({
  label,
  type = 'text',
  value,
  onChange,
  autoComplete,
  autoFocus,
  required = true,
  name,
  disabled,
  placeholder,
  inputMode,
  maxLength,
}: {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  autoComplete?: string
  autoFocus?: boolean
  required?: boolean
  name?: string
  disabled?: boolean
  placeholder?: string
  inputMode?: 'numeric' | 'text' | 'email' | 'tel' | 'search' | 'url'
  maxLength?: number
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[10px] font-medium uppercase tracking-[0.18em] text-fg-muted">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required={required}
        name={name}
        disabled={disabled}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        className="block w-full border-b border-border bg-transparent px-0 py-2 text-base text-fg placeholder:text-fg-faint/50 transition-colors focus:border-accent focus:outline-none disabled:opacity-60"
      />
    </label>
  )
}

/** Solid copper CTA — sharper radius, fixed height so it never jumps
 *  when the spinner appears. */
export function AuthButton({
  busy,
  children,
  type = 'submit',
  onClick,
  disabled,
}: {
  busy?: boolean
  children: ReactNode
  type?: 'submit' | 'button'
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled ?? busy}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-semibold text-bg transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

/** Inline mode-switch links with em-dash separators. */
export function AuthModeLinks({
  items,
}: {
  items: Array<{ label: string; onClick: () => void; accent?: boolean }>
}) {
  return (
    <div className="flex items-center justify-center gap-3 text-xs">
      {items.map((item, i) => (
        <span key={item.label} className="flex items-center gap-3">
          <button
            type="button"
            onClick={item.onClick}
            className={
              item.accent
                ? 'text-accent transition-opacity hover:opacity-80'
                : 'text-fg-muted transition-colors hover:text-fg'
            }
          >
            {item.label}
          </button>
          {i < items.length - 1 && (
            <span aria-hidden className="text-fg-muted/50">
              —
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

/** Inline error row, matching the desktop. */
export function AuthError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {message}
    </div>
  )
}
