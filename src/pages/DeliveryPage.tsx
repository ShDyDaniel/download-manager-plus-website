import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import {
  Loader2,
  Lock,
  AlertTriangle,
  Clock,
  Download as DownloadIcon,
  ArrowLeft,
} from 'lucide-react'

/**
 * Public client-delivery page.
 *
 * URL: /d/:token
 *
 * The END CLIENT opens this link (sent by an editor) to watch + download
 * the final video(s). They are NOT a paying user. The page is chromeless
 * (no marketing SiteHeader — see isChromelessRoute in App.tsx) and leans
 * into a clean "powered by ניהול הורדות פלוס" promo, since the operator
 * asked the client page to mainly advertise the product.
 *
 * Backend: action=delivery-view returns the bundle's videos with
 * short-lived presigned stream + download URLs (or an expired / password
 * state). action=delivery-verify-password mints a passwordToken.
 */

const API = '/api/revisions'
const SITE_URL = 'https://www.dmplus.net'

interface DeliveryVideo {
  name: string
  sizeBytes: number
  streamUrl: string
  downloadUrl: string
}
interface DeliveryData {
  title: string
  expiresAt: number
  videos: DeliveryVideo[]
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function expiryText(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'הקישור פג'
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days >= 1) return `הקישור פעיל עוד ${days} ${days === 1 ? 'יום' : 'ימים'}`
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)))
  return `הקישור פעיל עוד ${hours} שעות`
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'expired'; title: string }
  | { kind: 'password'; title: string; error?: string; busy?: boolean }
  | { kind: 'ready'; data: DeliveryData }

export function DeliveryPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [pwInput, setPwInput] = useState('')

  const load = useCallback(
    async (pwToken: string | null) => {
      if (!token) {
        setState({ kind: 'error', message: 'קישור לא תקין' })
        return
      }
      try {
        const r = await fetch(`${API}?action=delivery-view`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shareToken: token,
            passwordToken: pwToken || undefined,
          }),
        })
        const j = (await r.json().catch(() => null)) as
          | {
              ok?: boolean
              expired?: boolean
              locked?: boolean
              needsPassword?: boolean
              title?: string
              error?: string
              delivery?: DeliveryData
            }
          | null
        if (!j) return setState({ kind: 'error', message: 'תקלת רשת. נסו לרענן.' })
        if (j.expired) return setState({ kind: 'expired', title: j.title || '' })
        if (!j.ok)
          return setState({ kind: 'error', message: j.error || 'הקישור לא נמצא' })
        if (j.locked && j.needsPassword)
          return setState({ kind: 'password', title: j.title || '' })
        if (j.delivery) return setState({ kind: 'ready', data: j.delivery })
        setState({ kind: 'error', message: 'תקלה לא צפויה' })
      } catch {
        setState({ kind: 'error', message: 'תקלת רשת. נסו לרענן.' })
      }
    },
    [token],
  )

  useEffect(() => {
    void load(null)
  }, [load])

  async function submitPassword(e: FormEvent) {
    e.preventDefault()
    if (!pwInput.trim() || !token) return
    setState((s) =>
      s.kind === 'password' ? { ...s, busy: true, error: undefined } : s,
    )
    try {
      const r = await fetch(`${API}?action=delivery-verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareToken: token, password: pwInput }),
      })
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; passwordToken?: string; error?: string }
        | null
      if (j?.ok && j.passwordToken) {
        setState({ kind: 'loading' })
        await load(j.passwordToken)
      } else {
        setState((s) =>
          s.kind === 'password'
            ? { ...s, busy: false, error: j?.error || 'סיסמה שגויה' }
            : s,
        )
      }
    } catch {
      setState((s) =>
        s.kind === 'password' ? { ...s, busy: false, error: 'תקלת רשת' } : s,
      )
    }
  }

  return (
    <div dir="rtl" className="flex min-h-dvh flex-col bg-background text-foreground">
      <BrandBar />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        {state.kind === 'loading' && (
          <Centered>
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </Centered>
        )}

        {state.kind === 'error' && (
          <Notice
            icon={<AlertTriangle className="h-7 w-7 text-destructive" />}
            title="לא הצלחנו לטעון"
            body={state.message}
          />
        )}

        {state.kind === 'expired' && (
          <Notice
            icon={<Clock className="h-7 w-7 text-muted-foreground" />}
            title="הקישור פג"
            body="התוקף של הקישור הזה הסתיים. פנו למי ששלח לכם אותו כדי לקבל קישור חדש."
          />
        )}

        {state.kind === 'password' && (
          <div className="mx-auto mt-10 w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <Lock className="h-6 w-6" />
            </div>
            <h1 className="mb-1 text-lg font-bold">{state.title || 'מסירה מוגנת בסיסמה'}</h1>
            <p className="mb-5 text-sm text-muted-foreground">
              הקובץ מוגן בסיסמה. הזינו את הסיסמה שקיבלתם.
            </p>
            <form onSubmit={submitPassword} className="space-y-3">
              <input
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder="סיסמה"
                autoFocus
                className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-center text-sm outline-none focus:border-primary"
              />
              {state.error && (
                <p className="text-xs font-medium text-destructive">{state.error}</p>
              )}
              <button
                type="submit"
                disabled={state.busy || !pwInput.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {state.busy && <Loader2 className="h-4 w-4 animate-spin" />}
                כניסה
              </button>
            </form>
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="space-y-6">
            <header className="text-center">
              <h1 className="text-2xl font-bold">{state.data.title || 'הסרטונים שלך'}</h1>
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {expiryText(state.data.expiresAt)}
              </p>
            </header>

            <div className="space-y-5">
              {state.data.videos.map((v, i) => (
                <div
                  key={i}
                  className="overflow-hidden rounded-2xl border border-border bg-card"
                >
                  <video
                    src={v.streamUrl}
                    controls
                    playsInline
                    className="w-full bg-black"
                    style={{ maxHeight: '70vh' }}
                  />
                  <div className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" dir="ltr">
                        {v.name}
                      </p>
                      {formatBytes(v.sizeBytes) && (
                        <p className="text-[11px] text-muted-foreground" dir="ltr">
                          {formatBytes(v.sizeBytes)}
                        </p>
                      )}
                    </div>
                    <a
                      href={v.downloadUrl}
                      className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      <DownloadIcon className="h-4 w-4" />
                      הורדה
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
      <BrandFooter />
    </div>
  )
}

/* ── Promo chrome — the operator asked the client page to mainly
 *    advertise the product. Easy to restyle later. ───────────────── */

function BrandBar() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
        <a
          href={SITE_URL}
          className="flex items-baseline gap-1.5 text-lg font-bold tracking-tight"
        >
          <span>ניהול</span>
          <span>הורדות</span>
          <span style={{ color: '#D4A574' }}>פלוס</span>
        </a>
        <a
          href={SITE_URL}
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          לאתר שלנו
          <ArrowLeft className="h-3.5 w-3.5" />
        </a>
      </div>
    </header>
  )
}

function BrandFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 text-center">
        <p className="text-sm text-foreground">
          הסרטון נשלח אליך דרך{' '}
          <a href={SITE_URL} className="font-semibold text-primary underline underline-offset-2">
            ניהול הורדות פלוס
          </a>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          המערכת לעורכי וידאו וצלמים — סבבי תיקונים, מסירה ללקוחות, הצעות מחיר ועוד.
        </p>
        <a
          href={SITE_URL}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          גלו עוד
          <ArrowLeft className="h-3.5 w-3.5" />
        </a>
      </div>
    </footer>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[40vh] items-center justify-center">{children}</div>
}

function Notice({
  icon,
  title,
  body,
}: {
  icon: ReactNode
  title: string
  body: string
}) {
  return (
    <div className="mx-auto mt-10 w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-background">
        {icon}
      </div>
      <h1 className="mb-1 text-lg font-bold">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
