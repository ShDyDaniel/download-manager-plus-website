import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { LifeBuoy, RefreshCw, Copy, Check, Square, Download, Loader2, Monitor, X, TerminalSquare, CornerDownLeft } from 'lucide-react'
import { buildZip } from '../lib/zip'

/**
 * Dedicated live remote-support session page (admin, opens in its own tab from
 * the System-Guide card). Logs live in R2 (object storage, NOT the DB), so we
 * refresh them every ~2 s straight from R2 — that costs zero Firestore quota.
 * The only DB traffic is the small status/urls fetch every ~8 s.
 */
type LogEntry = { name: string; size: number; url: string }
type ScreenEntry = { name: string; url: string }
type CmdEntry = { seq: number; text: string; output: string; at: number; truncated?: boolean }

function screenLabel(name: string): string {
  if (name === 'app.jpg') return 'חלון התוכנה'
  const m = name.match(/screen-(\d+)/)
  return m ? `מסך ${m[1]}` : name
}

function viewToken(): string {
  const h = window.location.hash || ''
  const m = h.match(/[#&]t=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`/api/revisions?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, viewToken: viewToken() }),
  })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>
  if (!j.ok) throw new Error(j.error || 'failed')
  return j as T
}

export default function AdminSupportSessionPage() {
  const { code = '' } = useParams()
  const cleanCode = code.trim().toUpperCase()
  const [status, setStatus] = useState('')
  const [meta, setMeta] = useState<{ platform?: string; appVersion?: string; email?: string }>({})
  const [logNames, setLogNames] = useState<string[]>([])
  const [active, setActive] = useState('') // selected log tab
  const [content, setContent] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [shots, setShots] = useState<Record<string, string>>({}) // name -> objectURL
  const [zoom, setZoom] = useState('') // enlarged screenshot name
  const [cmd, setCmd] = useState({ enabled: false, consent: false, pending: false })
  const [cmdLog, setCmdLog] = useState<CmdEntry[]>([])
  const [cmdInput, setCmdInput] = useState('')
  const [cmdSending, setCmdSending] = useState(false)
  const cmdEnabledRef = useRef(false) // drives the faster poll while the console is open
  const urlsRef = useRef<Record<string, string>>({})
  const screenUrlsRef = useRef<Record<string, string>>({}) // name -> presigned GET
  const shotObjRef = useRef<Record<string, string>>({}) // name -> objectURL (to revoke)
  const url = `https://dmplus.net/support/${cleanCode}`

  // ~8s: refresh status + fresh presigned R2 urls (the only DB touch).
  const pullMeta = useCallback(async () => {
    try {
      const j = await api<{
        status: string
        platform?: string
        appVersion?: string
        email?: string
        logs: LogEntry[]
        screens?: ScreenEntry[]
        cmdEnabled?: boolean
        cmdConsent?: boolean
        cmdPending?: boolean
        cmdLog?: CmdEntry[]
      }>('support-get', { code: cleanCode })
      setStatus(j.status)
      setCmd({ enabled: !!j.cmdEnabled, consent: !!j.cmdConsent, pending: !!j.cmdPending })
      cmdEnabledRef.current = !!j.cmdEnabled
      setCmdLog(j.cmdLog || [])
      setMeta({ platform: j.platform, appVersion: j.appVersion, email: j.email })
      const names = (j.logs || []).map((l) => l.name)
      setLogNames(names)
      const map: Record<string, string> = {}
      for (const l of j.logs || []) map[l.name] = l.url
      urlsRef.current = map
      const smap: Record<string, string> = {}
      for (const sc of j.screens || []) smap[sc.name] = sc.url
      screenUrlsRef.current = smap
      setActive((a) => a || names[0] || '')
    } catch (e) {
      setErr((e as Error).message || 'auth')
    }
  }, [cleanCode])

  // ~2s: fetch the log blobs straight from R2 (no DB).
  const pullLogs = useCallback(async () => {
    const map = urlsRef.current
    const out: Record<string, string> = {}
    await Promise.all(
      Object.entries(map).map(async ([name, u]) => {
        try {
          const r = await fetch(u)
          out[name] = await r.text()
        } catch {
          /* url may have expired — the 8s meta pull re-signs it */
        }
      }),
    )
    if (Object.keys(out).length) setContent((c) => ({ ...c, ...out }))
  }, [])

  // ~1.5s: fetch each screenshot straight from R2 (no DB), swap in a fresh
  // object URL, and revoke the previous one so memory doesn't grow.
  const pullScreens = useCallback(async () => {
    const map = screenUrlsRef.current
    const names = Object.keys(map)
    if (!names.length) return
    await Promise.all(
      names.map(async (name) => {
        try {
          const r = await fetch(map[name], { cache: 'no-store' })
          if (!r.ok) return
          const obj = URL.createObjectURL(await r.blob())
          const prev = shotObjRef.current[name]
          shotObjRef.current[name] = obj
          setShots((s) => ({ ...s, [name]: obj }))
          if (prev) URL.revokeObjectURL(prev)
        } catch {
          /* url may have expired — the 8s meta pull re-signs it */
        }
      }),
    )
  }, [])

  useEffect(() => {
    void pullMeta()
    const m = setInterval(() => void pullMeta(), 8000)
    const l = setInterval(() => void pullLogs(), 2000)
    const sc = setInterval(() => void pullScreens(), 1500)
    // While the command console is enabled, pull the session doc faster so
    // command output shows up quickly (admin-only, short-lived — not the hot path).
    const cm = setInterval(() => {
      if (cmdEnabledRef.current) void pullMeta()
    }, 2000)
    return () => {
      clearInterval(m)
      clearInterval(l)
      clearInterval(sc)
      clearInterval(cm)
      for (const u of Object.values(shotObjRef.current)) URL.revokeObjectURL(u)
    }
  }, [pullMeta, pullLogs, pullScreens])

  async function sendCmd() {
    const text = cmdInput.trim()
    if (!text || cmdSending || cmd.pending) return
    setCmdSending(true)
    try {
      await api('support-cmd-submit', { code: cleanCode, text })
      setCmdInput('')
      setCmd((c) => ({ ...c, pending: true }))
      void pullMeta()
    } catch (e) {
      setErr((e as Error).message || 'failed')
    } finally {
      setCmdSending(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore */
    }
  }
  async function refresh() {
    try {
      await api('support-refresh', { code: cleanCode })
    } catch {
      /* best-effort */
    }
  }
  async function stop() {
    try {
      await api('support-stop', { code: cleanCode })
    } catch {
      /* best-effort */
    }
    setStatus('stopped')
  }
  function downloadAll() {
    const enc = new TextEncoder()
    const entries = Object.entries(content).map(([n, c]) => ({ name: n, data: enc.encode(c) }))
    if (!entries.length) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(buildZip(entries))
    a.download = `dmplus-support-${cleanCode}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const statusLabel =
    status === 'active' ? 'משדר · חי' : status === 'stopped' ? 'הופסק' : 'ממתין לאישור המשתמש…'
  const statusColor =
    status === 'active' ? 'text-emerald-400' : status === 'stopped' ? 'text-red-400' : 'text-amber-400'

  return (
    <div dir="rtl" className="min-h-dvh bg-background px-4 py-6 text-foreground">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <LifeBuoy className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-bold">תמיכה מרחוק — סשן חי</h1>
              <p className={`text-xs font-medium ${statusColor}`}>
                {statusLabel}
                {meta.email ? ` · ${meta.email}` : ''}
                {meta.platform ? ` · ${meta.platform}` : ''}
                {meta.appVersion ? ` · v${meta.appVersion}` : ''}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void copyLink()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              העתק קישור
            </button>
            <button onClick={() => void refresh()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary">
              <RefreshCw className="h-3.5 w-3.5" /> רענן עכשיו
            </button>
            <button onClick={downloadAll} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary">
              <Download className="h-3.5 w-3.5" /> הורד הכל
            </button>
            {status !== 'stopped' && (
              <button onClick={() => void stop()} className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500">
                <Square className="h-3.5 w-3.5" /> עצור סשן
              </button>
            )}
          </div>
        </header>

        <code dir="ltr" className="mb-4 block select-all rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          {url}
        </code>

        {err && <p className="mb-3 text-xs text-red-400">שגיאה: {err}</p>}

        {/* Live screenshots — app window + desktop(s), refreshed straight from R2 */}
        {Object.keys(shots).length > 0 && (
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Monitor className="h-3.5 w-3.5" /> מסך חי
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {Object.entries(shots).map(([name, src]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setZoom(name)}
                  className="group overflow-hidden rounded-xl border border-border bg-card text-right transition hover:border-primary/50"
                >
                  <img src={src} alt={screenLabel(name)} className="block max-h-56 w-full object-contain bg-black/40" />
                  <span className="block px-2.5 py-1.5 text-[11px] text-muted-foreground group-hover:text-foreground">
                    {screenLabel(name)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Command console (only when the admin authorised commands at creation) */}
        {cmd.enabled && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-card">
            <div className="flex items-center gap-1.5 border-b border-amber-500/20 px-3 py-2 text-xs font-medium text-amber-500">
              <TerminalSquare className="h-3.5 w-3.5" /> מסוף פקודות
              {cmd.pending && <Loader2 className="ms-1 h-3 w-3 animate-spin" />}
            </div>
            {!cmd.consent ? (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ממתין לאישור המשתמש להרצת פקודות…
              </div>
            ) : (
              <>
                <div dir="ltr" className="max-h-[45vh] space-y-2 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
                  {cmdLog.length === 0 ? (
                    <p className="text-muted-foreground">אין עדיין פקודות. הקלד פקודה למטה.</p>
                  ) : (
                    cmdLog.map((e) => (
                      <div key={e.seq}>
                        <div className="text-emerald-400">$ {e.text}</div>
                        {e.output && <pre className="whitespace-pre-wrap text-foreground/80">{e.output}</pre>}
                        {e.truncated && <div className="text-amber-500/80">[הפלט נחתך]</div>}
                      </div>
                    ))
                  )}
                </div>
                <div className="flex items-center gap-2 border-t border-amber-500/20 p-2">
                  <input
                    dir="ltr"
                    value={cmdInput}
                    onChange={(e) => setCmdInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void sendCmd() }}
                    placeholder={cmd.pending ? 'ממתין לתוצאה…' : 'הקלד פקודה ולחץ Enter'}
                    disabled={cmd.pending || cmdSending}
                    className="flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-amber-500/50 disabled:opacity-60"
                  />
                  <button
                    onClick={() => void sendCmd()}
                    disabled={cmd.pending || cmdSending || !cmdInput.trim()}
                    className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
                  >
                    {cmdSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerDownLeft className="h-3.5 w-3.5" />}
                    שלח
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {logNames.length === 0 && Object.keys(shots).length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            ממתין שהמשתמש יאשר את החיבור וישדר את הלוגים…
          </div>
        ) : logNames.length > 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap gap-1 border-b border-border p-2">
              {logNames.map((n) => (
                <button
                  key={n}
                  onClick={() => setActive(n)}
                  className={`rounded-md px-2.5 py-1 text-xs ${active === n ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary'}`}
                >
                  {n}
                </button>
              ))}
            </div>
            <pre dir="ltr" className="max-h-[65vh] overflow-auto p-3 text-[11px] leading-relaxed text-foreground/90">
              {content[active] ?? '…'}
            </pre>
          </div>
        ) : null}
      </div>

      {/* Enlarged screenshot */}
      {zoom && shots[zoom] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setZoom('')}
        >
          <button
            type="button"
            onClick={() => setZoom('')}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <img src={shots[zoom]} alt={screenLabel(zoom)} className="max-h-[90vh] max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  )
}
