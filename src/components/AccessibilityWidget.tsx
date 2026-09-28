import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Accessibility,
  X,
  Plus,
  Minus,
  RotateCcw,
  Check,
} from 'lucide-react'
import { AccessibilityModal } from './AccessibilityModal'
import '../styles/a11y-widget.css'

/**
 * AccessibilityWidget — a self-hosted accessibility menu, as required
 * for Israeli websites (IS 5568 / WCAG 2.0 AA). A floating button
 * opens a panel of adjustments that toggle `a11y-*` classes on
 * <html> (see index.css) + scale the root font size. Choices persist
 * in localStorage so they survive navigation + return visits.
 *
 * Look: the redesign's round copper button + panel (own `.fl` root, styles
 * in src/styles/a11y-widget.css, so it looks the same on old-design pages
 * too). The admin routes (/admin…) keep the original button and panel
 * unchanged, including the statement link that opens AccessibilityModal;
 * everywhere else that link goes to the /accessibility page.
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

/** Window event that opens the accessibility menu (e.g. the "פתיחת
 *  התפריט" button on the /accessibility page). */
export const A11Y_OPEN_EVENT = 'dmplus-a11y-open'
export function openAccessibilityMenu(): void {
  window.dispatchEvent(new Event(A11Y_OPEN_EVENT))
}

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

  // Opened from elsewhere on the site (see openAccessibilityMenu).
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(A11Y_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(A11Y_OPEN_EVENT, onOpen)
  }, [])

  const anyActive =
    state.fontScale !== 1 || Object.values(state.toggles).some(Boolean)

  // The admin panel keeps the original widget exactly as it was.
  const { pathname } = useLocation()
  if (!pathname.startsWith('/admin')) {
    return (
      <div className="fl fl-overlay a11yw">
        {/* Floating trigger — bottom-LEFT on mobile (out of the way of the
            right-aligned footer), bottom-right on desktop. */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="תפריט נגישות"
          aria-expanded={open}
          className={'fab a11y' + (anyActive ? ' on' : '')}
        >
          <Accessibility className="ic" strokeWidth={2} aria-hidden />
          {anyActive && <span className="dot" />}
        </button>

        {open && (
          <>
            {/* Scrim */}
            <div className="a11y-scrim" onClick={() => setOpen(false)} aria-hidden />
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="התאמות נגישות"
              dir="rtl"
              className="a11y-panel"
            >
              <div className="hd">
                <span className="ttl">
                  <Accessibility className="ic" aria-hidden />
                  <b>התאמות נגישות</b>
                </span>
                <button
                  type="button"
                  className="x"
                  onClick={() => setOpen(false)}
                  aria-label="סגור"
                >
                  <X className="ic" aria-hidden />
                </button>
              </div>

              {/* Font size */}
              <div className="size">
                <span>גודל טקסט</span>
                <div className="ctl">
                  <button
                    type="button"
                    onClick={() => setFont(state.fontScale - 0.1)}
                    disabled={state.fontScale <= 1}
                    aria-label="הקטנת טקסט"
                  >
                    <Minus className="ic" aria-hidden />
                  </button>
                  <bdi className="pct num">{Math.round(state.fontScale * 100)}%</bdi>
                  <button
                    type="button"
                    onClick={() => setFont(state.fontScale + 0.1)}
                    disabled={state.fontScale >= 1.6}
                    aria-label="הגדלת טקסט"
                  >
                    <Plus className="ic" aria-hidden />
                  </button>
                </div>
              </div>

              {/* Toggles */}
              <div className="tgs">
                {TOGGLE_LABELS.map(({ key, label }) => {
                  const on = state.toggles[key]
                  return (
                    <button
                      key={key}
                      type="button"
                      className="tg"
                      onClick={() => toggle(key)}
                      aria-pressed={on}
                    >
                      <span>{label}</span>
                      <i aria-hidden>{on && <Check className="ic" strokeWidth={3} />}</i>
                    </button>
                  )
                })}
              </div>

              <button type="button" className="reset" onClick={reset}>
                <RotateCcw className="ic" aria-hidden />
                איפוס הכל
              </button>

              <Link className="link small stmt" to="/accessibility" onClick={() => setOpen(false)}>
                הצהרת הנגישות שלנו
              </Link>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Floating trigger — bottom-LEFT on mobile (out of the way of the
          right-aligned footer), bottom-right on desktop. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="תפריט נגישות"
        aria-expanded={open}
        className="fixed bottom-4 left-4 z-[300] flex h-12 w-12 items-center justify-center rounded-full bg-primary text-bg shadow-lg shadow-black/40 outline-offset-2 transition-colors hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:left-auto md:right-4"
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
            className="fixed bottom-20 left-4 z-[300] flex max-h-[80vh] w-[min(92vw,340px)] flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-xl md:left-auto md:right-4"
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
