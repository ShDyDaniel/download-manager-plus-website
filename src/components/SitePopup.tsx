import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

/** Admin-configured announcement popup for the website. Frequency is
 *  enforced locally (no cookies, no server tracking) keyed by the
 *  popup's id, so changing the popup re-shows it. */
interface Popup {
  enabled: boolean
  id: string
  title: string
  body: string
  imageUrl: string
  frequency: 'always' | 'daily' | 'once'
  target: 'web' | 'desktop' | 'both'
  size?: 'small' | 'medium' | 'large'
  linkUrl?: string
}

const SIZE_MAX_W: Record<'small' | 'medium' | 'large', string> = {
  small: 'max-w-sm',
  medium: 'max-w-lg',
  large: 'max-w-3xl',
}

function shouldShow(p: Popup): boolean {
  if (!p.enabled || !p.id) return false
  if (p.target !== 'web' && p.target !== 'both') return false
  if (!p.title && !p.body && !p.imageUrl) return false
  try {
    if (p.frequency === 'always') return true
    const key = `dmplus.popup.${p.id}`
    if (p.frequency === 'once') return !localStorage.getItem(key)
    if (p.frequency === 'daily') {
      const today = new Date().toISOString().slice(0, 10)
      return localStorage.getItem(key) !== today
    }
  } catch {
    return true
  }
  return true
}
function markShown(p: Popup): void {
  try {
    const key = `dmplus.popup.${p.id}`
    if (p.frequency === 'once') localStorage.setItem(key, '1')
    else if (p.frequency === 'daily')
      localStorage.setItem(key, new Date().toISOString().slice(0, 10))
  } catch {
    /* ignore */
  }
}

export function SitePopup() {
  const [popup, setPopup] = useState<Popup | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/paypal?action=get-popup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        const j = (await r.json()) as { popup?: Popup }
        const p = j.popup
        if (!alive || !p) return
        if (shouldShow(p)) {
          setPopup(p)
          setOpen(true)
          markShown(p)
        }
      } catch {
        /* ignore */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!open || !popup) return null
  const { title, body, imageUrl, linkUrl } = popup
  const maxW = SIZE_MAX_W[popup.size || 'medium']
  const isExternal = /^https?:\/\//i.test(linkUrl || '')
  const img = imageUrl ? (
    <img
      src={imageUrl}
      alt=""
      className="max-h-[60vh] w-full bg-black/20 object-contain"
    />
  ) : null
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        dir="rtl"
        className={`relative w-full ${maxW} overflow-hidden rounded-2xl border border-border bg-card shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="סגור"
          className="absolute left-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
        >
          <X className="h-4 w-4" />
        </button>
        {img && linkUrl ? (
          <a
            href={linkUrl}
            {...(isExternal
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
            onClick={() => setOpen(false)}
            className="block cursor-pointer"
          >
            {img}
          </a>
        ) : (
          img
        )}
        {(title || body) && (
          <div className="p-5 text-center">
            {title && <div className="text-lg font-bold text-fg">{title}</div>}
            {body && (
              <div className="mt-2 whitespace-pre-line text-sm leading-relaxed text-fg-muted">
                {body}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
