import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { LifeBuoy, RefreshCw, Copy, Check, Square, Download, Loader2 } from 'lucide-react'
import { ensureStepUp } from '../lib/adminApi'
import { buildZip } from '../lib/zip'

/**
 * Dedicated live remote-support session page (admin, opens in its own tab from
 * the System-Guide card). Logs live in R2 (object storage, NOT the DB), so we
 * refresh them every ~2 s straight from R2 — that costs zero Firestore quota.
 * The only DB traffic is the small status/urls fetch every ~8 s.
 */
type LogEntry = { name: string; size: number; url: string }

async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const stepUpToken = await ensureStepUp()
  const r = await fetch(`/api/revisions?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stepUpToken }),
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
  const urlsRef = useRef<Record<string, string>>({})
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
      }>('support-get', { code: cleanCode })
      setStatus(j.status)
      setMeta({ platform: j.platform, appVersion: j.appVersion, email: j.email })
      const names = (j.logs || []).map((l) => l.name)
      setLogNames(names)
      const map: Record<string, string> = {}
      for (const l of j.logs || []) map[l.name] = l.url
      urlsRef.current = map
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

  useEffect(() => {
    void pullMeta()
    const m = setInterval(() => void pullMeta(), 8000)
    const l = setInterval(() => void pullLogs(), 2000)
    return () => {
      clearInterval(m)
      clearInterval(l)
    }
  }, [pullMeta, pullLogs])

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

        {logNames.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            ממתין שהמשתמש יאשר את החיבור וישדר את הלוגים…
          </div>
        ) : (
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
        )}
      </div>
    </div>
  )
}
