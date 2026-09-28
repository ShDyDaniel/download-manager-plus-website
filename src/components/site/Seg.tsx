import { motion } from 'framer-motion'
import { useId } from 'react'

/**
 * Segmented control (.seg in fl.css). The active option's background is a pill
 * that slides between options with the same spring the old pricing toggle used.
 */
export function Seg<T extends string>({
  value,
  onChange,
  options,
  label,
  className = '',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: React.ReactNode }[]
  /** Accessible name of the group. */
  label: string
  className?: string
}) {
  const layoutId = useId()
  return (
    <div className={`seg seg-motion ${className}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            className={on ? 'on' : ''}
            aria-pressed={on}
            onClick={() => onChange(o.value)}
          >
            {on && (
              <motion.span
                layoutId={layoutId}
                className="seg-thumb"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="seg-label">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
