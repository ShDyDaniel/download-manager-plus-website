import { useEffect, useRef, useState } from 'react'
import {
  Accessibility,
  X,
  Plus,
  Minus,
  RotateCcw,
  Check,
} from 'lucide-react'
import { AccessibilityModal } from './AccessibilityModal'

/**
 * AccessibilityWidget — a self-hosted accessibility menu, as required
 * for Israeli websites (IS 5568 / WCAG 2.0 AA). A floating button
 * opens a panel of adjustments that toggle `a11y-*` classes on
 * <html> (see index.css) + scale the root font size. Choices persist
 * in localStorage so they survive navigation + return visits.
 */

const STORAGE_KEY = 'dmplus.a11y.v1'

type Toggle =
  | 'contrast'
  | 'grayscale'
  | 'invert'
  | 'links'
  | 'readable'
  | 'spacing'
  | 'stopmotion'
  | 'bigcursor'
  | 'focus'

interface A11yState {
  fontScale: number
  toggles: Record<Toggle, boolean>
}

const DEFAULT_STATE: A11yState = {
  fontScale: 1,
  toggles: {
    contrast: false,
    grayscale: false,
    invert: false,
    links: false,
    readable: false,
    spacing: false,
    stopmotion: false,
    bigcursor: false,
    focus: false,
  },
}

const TOGGLE_LABELS: { key: Toggle; label: string }[] = [
  { key: 'contrast', label: 'ניגודיות גבוהה' },
  { key: 'invert', label: 'היפוך צבעים' },
  { key: 'grayscale', label: 'גווני אפור' },
  { key: 'links', label: 'הדגשת קישורים' },
  { key: 'readable', label: 'גופן קריא' },
  { key: 'spacing', label: 'ריווח טקסט מוגדל' },
  { key: 'stopmotion', label: 'עצירת אנימציות' },
  { key: 'bigcursor', label: 'סמן עכבר גדול' },
  { key: 'focus', label: 'הדגשת מיקוד מקלדת' },
]

function load(): A11yState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const p = JSON.parse(raw) as Partial<A11yState>
    return {
      fontScale: typeof p.fontScale === 'number' ? p.fontScale : 1,
      toggles: { ...DEFAULT_STATE.toggles, ...(p.toggles || {}) },
    }
  } catch {
    return DEFAULT_STATE
  }
}

/** Event the app root listens to so it can drive framer-motion's
 *  MotionConfig — CSS alone can't stop JS-driven animations. */
export const A11Y_MOTION_EVENT = 'dmplus-a11y-motion'

export function readStopMotion(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    return (JSON.parse(raw) as A11yState)?.toggles?.stopmotion === true
  } catch {
    return false
  }
}

function apply(state: A11yState) {
  const html = document.documentElement
  for (const { key } of TOGGLE_LABELS) {
    html.classList.toggle(`a11y-${key}`, state.toggles[key])
  }
  if (state.fontScale && state.fontScale !== 1) {
    html.style.fontSize = `${16 * state.fontScale}px`
  } else {
    html.style.removeProperty('font-size')
  }
  // Tell the app root whether to reduce motion in framer-motion.
  window.dispatchEvent(
    new CustomEvent(A11Y_MOTION_EVENT, { detail: state.toggles.stopmotion }),
  )
}

export function AccessibilityWidget() {
  const [open, setOpen] = useState(false)
  const [statementOpen, setStatementOpen] = useState(false)
  const [state, setState] = useState<A11yState>(DEFAULT_STATE)
  const panelRef = useRef<HTMLDivElement>(null)

  // Load + apply persisted prefs on first mount.
  useEffect(() => {
    const s = load()
    setState(s)
    apply(s)
  }, [])

  // Persist + apply on every change.
  function update(next: A11yState) {
    setState(next)
    apply(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  function toggle(key: Toggle) {
    update({
      ...state,
      toggles: { ...state.toggles, [key]: !state.toggles[key] },
    })
  }
  function setFont(scale: number) {
    update({ ...state, fontScale: Math.min(1.6, Math.max(1, scale)) })
  }
  function reset() {
    update(DEFAULT_STATE)
  }

  // Esc closes the panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const anyActive =
    state.fontScale !== 1 || Object.values(state.toggles).some(Boolean)

  return (
    <>
      {/* Floating trigger — bottom-start (right in RTL). */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="תפריט נגישות"
        aria-expanded={open}
        className="fixed bottom-4 right-4 z-[300] flex h-12 w-12 items-center justify-center rounded-full bg-primary text-bg shadow-lg shadow-black/40 outline-offset-2 transition-colors hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Accessibility className="h-6 w-6" strokeWidth={2} />
        {anyActive && (
          <span className="absolute -left-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-bg bg-success" />
        )}
      </button>

      {open && (
        <>
          {/* Scrim */}
          <div
            className="fixed inset-0 z-[300] bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="התאמות נגישות"
            dir="rtl"
            className="fixed bottom-20 right-4 z-[300] flex max-h-[80vh] w-[min(92vw,340px)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Accessibility className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-fg">התאמות נגישות</h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="סגור"
                className="rounded-md p-1 text-fg-muted transition-colors hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {/* Font size */}
              <div>
                <div className="mb-2 text-xs font-medium text-fg-muted">
                  גודל טקסט
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFont(state.fontScale - 0.1)}
                    disabled={state.fontScale <= 1}
                    aria-label="הקטנת טקסט"
                    className="flex h-9 flex-1 items-center justify-center rounded-lg border border-border text-fg transition-colors hover:bg-white/[0.04] disabled:opacity-40"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="w-12 text-center text-sm tabular-nums text-fg">
                    {Math.round(state.fontScale * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setFont(state.fontScale + 0.1)}
                    disabled={state.fontScale >= 1.6}
                    aria-label="הגדלת טקסט"
                    className="flex h-9 flex-1 items-center justify-center rounded-lg border border-border text-fg transition-colors hover:bg-white/[0.04] disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Toggles */}
              <div className="space-y-1.5">
                {TOGGLE_LABELS.map(({ key, label }) => {
                  const on = state.toggles[key]
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggle(key)}
                      aria-pressed={on}
                      className={
                        'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors ' +
                        (on
                          ? 'border-primary/40 bg-primary/10 text-fg'
                          : 'border-border text-fg-muted hover:text-fg')
                      }
                    >
                      <span>{label}</span>
                      <span
                        className={
                          'flex h-5 w-5 items-center justify-center rounded-md border ' +
                          (on
                            ? 'border-primary bg-primary text-bg'
                            : 'border-border')
                        }
                      >
                        {on && <Check className="h-3.5 w-3.5" />}
                      </span>
                    </button>
                  )
                })}
              </div>

              <button
                type="button"
                onClick={reset}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm text-fg-muted transition-colors hover:text-fg"
              >
                <RotateCcw className="h-4 w-4" />
                איפוס הכל
              </button>
            </div>

            <div className="border-t border-border px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setStatementOpen(true)
                }}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                הצהרת הנגישות שלנו
              </button>
            </div>
          </div>
        </>
      )}

      {statementOpen && (
        <AccessibilityModal onClose={() => setStatementOpen(false)} />
      )}
    </>
  )
}
