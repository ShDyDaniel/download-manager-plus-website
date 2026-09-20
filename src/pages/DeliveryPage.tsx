import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import {
  Loader2,
  Lock,
  AlertTriangle,
  Clock,
  Download as DownloadIcon,
  ArrowLeft,
  FileVideo,
  FolderDown,
} from 'lucide-react'
import { makeZip, predictLength } from 'client-zip'

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
  width?: number
  height?: number
}
interface DeliveryData {
  title: string
  expiresAt: number
  videos: DeliveryVideo[]
}

function formatBytes(n: number): string {
  // Decimal (1000-based) units to match macOS Finder (a byte-identical
  // file otherwise looks smaller here than in Finder).
  if (!n || n <= 0) return ''
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} KB`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  return `${(n / 1_000_000_000).toFixed(2)} GB`
}

function expiryText(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'הקישור פג'
  const totalHours = Math.floor(ms / (60 * 60 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  const dPart = days > 0 ? `${days} ${days === 1 ? 'יום' : 'ימים'}` : ''
  const hPart = hours > 0 ? `${hours} ${hours === 1 ? 'שעה' : 'שעות'}` : ''
  if (dPart && hPart) return `הקישור פעיל עוד ${dPart} ו-${hPart}`
  if (dPart) return `הקישור פעיל עוד ${dPart}`
  if (hPart) return `הקישור פעיל עוד ${hPart}`
  return 'הקישור פעיל עוד פחות משעה'
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:py-10">
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

        {state.kind === 'ready' && <DeliveryReady data={state.data} />}
      </main>
      <BrandFooter />
    </div>
  )
}

/* ── Ready state — preloads the first video and only reveals the
 *    player once it can play, so the client never lands on a
 *    half-loaded/buffering player inside the page. ─────────────────── */
/**
 * Names for the files inside the zip.
 *
 * Two videos can carry the same name, and a zip with duplicates is one the
 * client has to guess their way through — some tools silently overwrite,
 * others refuse. Characters a filesystem will not take are replaced too.
 */
export function uniqueNames(raw: Array<string | undefined>): string[] {
  const seen = new Map<string, number>()
  return raw.map((r) => {
    const clean = (r || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_')
    const n = (seen.get(clean) ?? 0) + 1
    seen.set(clean, n)
    if (n === 1) return clean
    const dot = clean.lastIndexOf('.')
    return dot > 0
      ? `${clean.slice(0, dot)} (${n})${clean.slice(dot)}`
      : `${clean} (${n})`
  })
}

/** "42%" while a zip is being written, or "" when the size is unknown. */
function pctText(done: number, total: number): string {
  if (!total) return ''
  return `${Math.min(100, Math.round((done / total) * 100))}%`
}

function DeliveryReady({ data }: { data: DeliveryData }) {
  // Videos the browser couldn't decode (e.g. a ProRes/HEVC .mov). We
  // swap those for a clean "download to view" card instead of a black
  // box, so the client always has a way to get the file.
  const [errored, setErrored] = useState<Record<number, boolean>>({})
  const markErrored = (i: number) => {
    setErrored((prev) => (prev[i] ? prev : { ...prev, [i]: true }))
  }

  /* ── Getting everything at once ──────────────────────────────────────
   *
   * This used to fire every download inside one click, on the theory that
   * the browser would treat them as a single user-initiated multi-download.
   * It does not. Measured in Chromium against a local server that counted
   * the requests: of four files, exactly ONE arrived — the LAST one. Each
   * click cancels the navigation the one before it started.
   *
   * So the real answer is a single file: the client picks where to save,
   * and the page streams a .zip straight to that spot, pulling each video
   * from storage as its turn comes. Nothing is held in memory and nothing
   * passes through our server — the bytes go from storage to the client's
   * disk, which is what keeps this free to run.
   *
   * Two things have to be true for that: the browser must be able to hand
   * a file on disk to a script (Chrome, Edge — not Safari or Firefox), and
   * storage must allow the page to read the files. When either is missing
   * we fall back to separate downloads, SPACED OUT — measured: six of six
   * arrive at 250ms apart and beyond, five of six at 120ms, one of six in
   * a tight loop. 600ms leaves room for a slow machine.
   */
  const [canZip, setCanZip] = useState<boolean | null>(null)
  const [zip, setZip] = useState<
    | { kind: 'idle' }
    | { kind: 'working'; done: number; total: number }
    | { kind: 'failed'; message: string }
  >({ kind: 'idle' })

  const savesToDisk =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showSaveFilePicker?: unknown })
      .showSaveFilePicker === 'function'

  // Ask storage, once, whether this page is allowed to read the files at
  // all — before offering a button that would fail. The answer arrives long
  // before anyone clicks, and the body is dropped the moment it starts.
  useEffect(() => {
    let alive = true
    const first = data.videos[0]
    if (!first || !savesToDisk) {
      setCanZip(false)
      return
    }
    void (async () => {
      try {
        const res = await fetch(first.downloadUrl)
        void res.body?.cancel()
        if (alive) setCanZip(res.ok)
      } catch {
        if (alive) setCanZip(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [data.videos, savesToDisk])

  const separately = () => {
    data.videos.forEach((v, i) => {
      window.setTimeout(() => {
        const a = document.createElement('a')
        a.href = v.downloadUrl
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 600)
    })
  }

  const downloadFolder = async () => {
    if (zip.kind === 'working') return
    const names = uniqueNames(data.videos.map((v) => v.name))
    const picker = (
      window as unknown as {
        showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>
      }
    ).showSaveFilePicker
    let handle: FileSystemFileHandle
    try {
      handle = await picker({
        suggestedName: `${(data.title || 'הסרטונים שלך').replace(/[\\/:*?"<>|]/g, '_')}.zip`,
        types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
      })
    } catch {
      return // they closed the save dialog
    }

    const total = Number(
      predictLength(
        data.videos.map((v, i) => ({ name: names[i], size: v.sizeBytes || 0 })),
      ),
    )
    setZip({ kind: 'working', done: 0, total })

    try {
      const writable = await handle.createWritable()
      // Each video is fetched only when the zip reaches it, so there is one
      // transfer at a time rather than all of them fighting for the line.
      async function* entries() {
        for (let i = 0; i < data.videos.length; i++) {
          const v = data.videos[i]
          const res = await fetch(v.downloadUrl)
          if (!res.ok) throw new Error(`storage answered ${res.status}`)
          yield { name: names[i], input: res, size: v.sizeBytes || undefined }
        }
      }
      let done = 0
      const counted = makeZip(entries()).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            done += chunk.byteLength
            setZip((z) => (z.kind === 'working' ? { ...z, done } : z))
            controller.enqueue(chunk)
          },
        }),
      )
      await counted.pipeTo(writable)
      setZip({ kind: 'idle' })
    } catch (e) {
      console.warn('[delivery] zip failed:', e)
      setZip({
        kind: 'failed',
        message: 'ההורדה כקובץ אחד נכשלה. מורידים את הקבצים בנפרד…',
      })
      separately()
      window.setTimeout(() => setZip({ kind: 'idle' }), 6000)
    }
  }

  return (
    <div className="space-y-8">
      {/* Show the page IMMEDIATELY — never gate it behind the video loading.
          Each <video> below streams on its own (preload="metadata" + HTTP Range)
          and shows its own native buffering spinner, so a heavy file no longer
          freezes the whole page until it's fully downloaded. */}
      <div className="space-y-8">
        <header className="text-center">
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            {data.title || 'הסרטונים שלך'}
          </h1>
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {expiryText(data.expiresAt)}
          </p>
          {data.videos.length > 1 && (
            <div className="mt-5 flex flex-col items-center gap-2">
              <button
                onClick={canZip ? () => void downloadFolder() : separately}
                disabled={zip.kind === 'working'}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {zip.kind === 'working' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : canZip ? (
                  <FolderDown className="h-4 w-4" />
                ) : (
                  <DownloadIcon className="h-4 w-4" />
                )}
                {zip.kind === 'working'
                  ? `מוריד… ${pctText(zip.done, zip.total)}`
                  : canZip
                    ? 'הורדת הכל כקובץ אחד'
                    : 'הורדת כל הקבצים'}
              </button>
              {zip.kind === 'working' && (
                <div className="h-1 w-56 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{
                      width: `${Math.min(100, zip.total ? (zip.done / zip.total) * 100 : 0)}%`,
                    }}
                  />
                </div>
              )}
              {zip.kind === 'failed' && (
                <p className="text-xs text-muted-foreground">{zip.message}</p>
              )}
            </div>
          )}
        </header>

        <div className="space-y-8">
          {data.videos.map((v, i) => {
            const size = formatBytes(v.sizeBytes)
            return (
              <div
                key={i}
                className="overflow-hidden rounded-3xl border border-border bg-card shadow-2xl shadow-black/40"
              >
                {/* Big hero player. Wait for the FIRST video's canplay
                    to reveal the page. If the browser can't decode the
                    file, fall back to a download card. */}
                {errored[i] ? (
                  <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 bg-black/40 p-8 text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <FileVideo className="h-7 w-7" />
                    </div>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      לא ניתן להציג תצוגה מקדימה של הפורמט הזה בדפדפן. אפשר
                      להוריד את הסרטון ולצפות בו במחשב.
                    </p>
                    <a
                      href={v.downloadUrl}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-opacity hover:opacity-90"
                    >
                      <DownloadIcon className="h-4 w-4" />
                      הורדת הסרטון
                    </a>
                  </div>
                ) : (
                  <video
                    src={v.streamUrl}
                    controls
                    playsInline
                    // "metadata" (not "auto"): load just the header, then stream the
                    // rest on demand over HTTP Range (R2 presigned URLs support it).
                    // The page is no longer gated on this, so a heavy file streams
                    // progressively with the player's own buffering spinner.
                    preload="metadata"
                    // Reserve the correct aspect ratio BEFORE the video loads (from
                    // the stored dimensions) so the player doesn't resize/jump when
                    // the first frame arrives. Falls back to 16/9 when unknown.
                    style={{
                      aspectRatio:
                        v.width && v.height ? `${v.width} / ${v.height}` : '16 / 9',
                    }}
                    onError={() => markErrored(i)}
                    className="block max-h-[78vh] w-full bg-black"
                  />
                )}
                {/* Info bar — name + size on ONE line, download CTA. */}
                <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <FileVideo className="h-5 w-5" />
                    </div>
                    {/* RTL group: name first (right, next to the icon),
                        size after it (left). Each span is dir=ltr so the
                        filename + "882 KB" don't get their chars flipped. */}
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span
                        dir="ltr"
                        className="min-w-0 truncate text-sm font-semibold text-foreground"
                      >
                        {v.name}
                      </span>
                      {size && (
                        <span className="shrink-0 text-muted-foreground/50">·</span>
                      )}
                      {size && (
                        <span
                          dir="ltr"
                          className="shrink-0 text-xs text-muted-foreground"
                        >
                          {size}
                        </span>
                      )}
                    </div>
                  </div>
                  <a
                    href={v.downloadUrl}
                    className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-opacity hover:opacity-90"
                  >
                    <DownloadIcon className="h-4 w-4" />
                    הורדה
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ── Promo chrome — the operator asked the client page to mainly
 *    advertise the product. Easy to restyle later. ───────────────── */

function BrandBar() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
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
      <div className="mx-auto w-full max-w-3xl px-4 py-8 text-center">
        <p className="text-sm text-foreground">
          הסרטון נשלח אליך דרך{' '}
          <a href={SITE_URL} className="font-semibold text-primary underline underline-offset-2">
            ניהול הורדות פלוס
          </a>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          המערכת לעורכי וידאו וצלמים: סבבי תיקונים, מסירה ללקוחות, הצעות מחיר ועוד.
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
