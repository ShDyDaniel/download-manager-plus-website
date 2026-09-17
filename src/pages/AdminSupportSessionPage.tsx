import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { LifeBuoy, RefreshCw, Copy, Check, Square, Download, Loader2, Monitor, X, TerminalSquare, CornerDownLeft, Cpu, MonitorOff, AppWindow, Sparkles, ArrowLeftRight, Upload } from 'lucide-react'
import { buildZip } from '../lib/zip'
import {
  createPeer,
  makeAnswer,
  awaitChannel,
  waitOpen,
  sendPayload,
  receivePayload,
  BlockedNetworkError,
  IntegrityError,
  MAX_TRANSFER_BYTES,
  formatBytes,
} from '../lib/supportTransfer'

/**
 * Dedicated live remote-support session page (admin, opens in its own tab from
 * the System-Guide card). Logs live in R2 (object storage, NOT the DB), so we
 * refresh them every ~2 s straight from R2 — that costs zero Firestore quota.
 * The only DB traffic is the small status/urls fetch every ~8 s.
 */
type LogEntry = { name: string; size: number; url: string }
type ScreenEntry = { name: string; url: string }
type CmdEntry = { seq: number; text: string; output: string; cwd?: string; at: number; truncated?: boolean }
type Hardware = { model: string; cpu: string; cores: string; ram: string; gpu: string; vram: string }
/** One row of the app-supplied machine profile: section, label, value. The app
 *  decides what it contains — this page only groups and prints it, so the
 *  report grows without the website changing. */
type SystemRow = { s: string; k: string; v: string }
type DisplayInfo = { id: string; index: number; w: number; h: number; primary: boolean }
type ScreenMode = 'off' | 'app' | 'desktop'
/** The current peer-to-peer transfer (server keeps only its handshake). */
type Xfer = {
  id: string
  direction: 'to-admin' | 'to-customer'
  state: 'requested' | 'offered' | 'answered' | 'sending' | 'done' | 'failed' | 'declined' | 'cancelled'
  kind: 'file' | 'text' | null
  name: string | null
  size: number | null
  mime: string | null
  offerSdp: string | null
  answerSdp: string | null
  reason: string | null
}
const XFER_TERMINAL: Xfer['state'][] = ['done', 'failed', 'declined', 'cancelled']
const XFER_BLOCKED_NOTE =
  'הרשת של הלקוח (או שלך) חוסמת חיבור ישיר בין המחשבים, ולכן אי אפשר להעביר קבצים בסשן הזה. שאר הסשן ממשיך לעבוד.'

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

function screenLabel(name: string): string {
  if (name === 'app.jpg') return 'חלון התוכנה'
  const m = name.match(/screen-(\d+)/)
  return m ? `מסך ${m[1]}` : name
}

/**
 * The diagnosis, rendered. Deliberately a tiny hand-rolled reader rather than
 * a markdown dependency: the answer only ever uses headings, bullets and
 * fenced code, and everything is printed as TEXT — no html is interpreted —
 * so a log line that happens to contain markup can't become markup here.
 */
function Diagnosis({
  text,
  onRun,
}: {
  text: string
  /** Present when the command console is live. Loads the command into the
   *  console input — it does NOT run it. The operator reads it and presses
   *  send: the model proposes, a human commits. Absent = read-only block. */
  onRun?: (cmd: string) => void
}) {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let code: string[] | null = null
  let bullets: string[] = []

  const codeBlock = (body: string[], key: string) => {
    const joined = body.join('\n')
    // A single line is a command we can hand to the console as-is. Anything
    // multi-line is a script: shells differ on how they take those (cmd.exe
    // chains with & and would mangle it), so it stays copy-only.
    const single = body.filter((l) => l.trim()).length === 1
    const cmd = joined.trim()
    return (
      <div key={key} className="space-y-1">
        <pre
          dir="ltr"
          className="overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 text-left text-[11px] leading-relaxed text-foreground"
        >
          {joined}
        </pre>
        <div className="flex items-center gap-2">
          {onRun && single && cmd && (
            <button
              onClick={() => onRun(cmd)}
              className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-[11px] text-primary ring-1 ring-primary/40 transition hover:bg-primary/25"
            >
              <CornerDownLeft className="h-3 w-3" /> העבר לטרמינל
            </button>
          )}
          <button
            onClick={() => void navigator.clipboard.writeText(cmd).catch(() => undefined)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary"
          >
            <Copy className="h-3 w-3" /> העתק
          </button>
          {onRun && !single && (
            <span className="text-[11px] text-muted-foreground">
              רצף פקודות — הריצו אותן אחת-אחת בטרמינל
            </span>
          )}
        </div>
      </div>
    )
  }

  const flushBullets = () => {
    if (!bullets.length) return
    blocks.push(
      <ul key={`u${blocks.length}`} className="me-4 list-disc space-y-1 text-xs text-foreground">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    )
    bullets = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('```')) {
      if (code) {
        blocks.push(codeBlock(code, `c${blocks.length}`))
        code = null
      } else {
        flushBullets()
        code = []
      }
      continue
    }
    if (code) {
      code.push(raw)
      continue
    }
    if (/^#{1,4}\s/.test(line)) {
      flushBullets()
      blocks.push(
        <h3 key={`h${blocks.length}`} className="pt-1 text-xs font-bold text-primary">
          {line.replace(/^#{1,4}\s+/, '')}
        </h3>,
      )
      continue
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^\s*[-*•]\s+/, ''))
      continue
    }
    if (!line.trim()) {
      flushBullets()
      continue
    }
    flushBullets()
    blocks.push(
      <p key={`p${blocks.length}`} className="text-xs leading-relaxed text-foreground">
        {line}
      </p>,
    )
  }
  flushBullets()
  // An unterminated fence still gets rendered — a truncated answer shouldn't
  // silently swallow the command it was in the middle of suggesting.
  if (code) blocks.push(codeBlock(code, `c${blocks.length}`))
  return <div className="space-y-2">{blocks}</div>
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
  const [cmdEnabling, setCmdEnabling] = useState(false)
  const [cmdEnableErr, setCmdEnableErr] = useState('')
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [system, setSystem] = useState<SystemRow[]>([])
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [screenMode, setScreenMode] = useState<ScreenMode>('app')
  const [screenDisplay, setScreenDisplay] = useState(-1)
  const [screenPerm, setScreenPerm] = useState('granted')
  const [ai, setAi] = useState({ busy: false, answer: '', error: '' })
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiScreens, setAiScreens] = useState(false)
  const [purgeAt, setPurgeAt] = useState<number | null>(null)
  const [purged, setPurged] = useState(false)
  const cmdEnabledRef = useRef(false) // drives the faster poll while the console is open
  // ── Peer-to-peer transfer ──
  const [xfer, setXfer] = useState<Xfer | null>(null)
  const [xferNote, setXferNote] = useState('')
  const [xferError, setXferError] = useState('')
  const [xferProgress, setXferProgress] = useState<number | null>(null)
  const [xferReceivedText, setXferReceivedText] = useState<string | null>(null)
  const [xferBusy, setXferBusy] = useState(false)
  const [xferCopied, setXferCopied] = useState(false)
  const xferActiveRef = useRef(false) // drives the faster poll mid-handshake
  const xferFileRef = useRef<File | null>(null) // the file queued for the customer
  const xferHandledRef = useRef('') // transfer id already answered automatically
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const xferInputRef = useRef<HTMLInputElement | null>(null)
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
        xfer?: Xfer | null
        hardware?: Hardware | null
        system?: SystemRow[]
        displays?: DisplayInfo[]
        screenMode?: ScreenMode
        screenDisplay?: number
        screenPermission?: string
        purgeAt?: number | null
        purged?: boolean
      }>('support-get', { code: cleanCode })
      setStatus(j.status)
      setCmd({ enabled: !!j.cmdEnabled, consent: !!j.cmdConsent, pending: !!j.cmdPending })
      cmdEnabledRef.current = !!j.cmdEnabled
      setCmdLog(j.cmdLog || [])
      setXfer(j.xfer || null)
      xferActiveRef.current = !!j.xfer && !XFER_TERMINAL.includes(j.xfer.state)
      setHardware(j.hardware || null)
      setSystem(j.system || [])
      setDisplays(j.displays || [])
      setScreenMode(j.screenMode || 'app')
      setScreenDisplay(typeof j.screenDisplay === 'number' ? j.screenDisplay : -1)
      setScreenPerm(j.screenPermission || 'granted')
      setPurgeAt(j.purgeAt ?? null)
      setPurged(j.purged === true)
      setMeta({ platform: j.platform, appVersion: j.appVersion, email: j.email })
      const names = (j.logs || []).map((l) => l.name)
      setLogNames(names)
      const map: Record<string, string> = {}
      for (const l of j.logs || []) map[l.name] = l.url
      urlsRef.current = map
      const smap: Record<string, string> = {}
      for (const sc of j.screens || []) smap[sc.name] = sc.url
      screenUrlsRef.current = smap
      // Drop any screenshots the app no longer sends (mode switched to off/app).
      setShots((cur) => {
        let changed = false
        const next: Record<string, string> = {}
        for (const [n, u] of Object.entries(cur)) {
          if (smap[n]) next[n] = u
          else { changed = true; URL.revokeObjectURL(u); delete shotObjRef.current[n] }
        }
        return changed ? next : cur
      })
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
      if (cmdEnabledRef.current || xferActiveRef.current) void pullMeta()
    }, 2000)
    return () => {
      clearInterval(m)
      clearInterval(l)
      clearInterval(sc)
      clearInterval(cm)
      for (const u of Object.values(shotObjRef.current)) URL.revokeObjectURL(u)
    }
  }, [pullMeta, pullLogs, pullScreens])

  async function changeScreen(mode: ScreenMode, display: number) {
    setScreenMode(mode)
    setScreenDisplay(display)
    try {
      await api('support-screen-mode', { code: cleanCode, mode, display })
    } catch (e) {
      setErr((e as Error).message || 'failed')
    }
  }

  /** Turn on command execution for a session that is already running.
   *
   *  Same bar as ticking the box at creation: a real passkey step-up here,
   *  and then a separate consent dialog on the user's machine — the app
   *  raises it the moment the control lands, so nothing can run before they
   *  agree. Enabling costs the session nothing else; the link, the logs and
   *  the screen carry on uninterrupted. */
  async function enableCmd() {
    if (cmdEnabling) return
    setCmdEnabling(true)
    setCmdEnableErr('')
    try {
      const { ensureStepUp } = await import('../lib/adminApi')
      const stepUpToken = await ensureStepUp()
      const j = await api<{ viewToken?: string }>('support-cmd-enable', {
        code: cleanCode,
        stepUpToken,
      })
      // The token this tab opened with was minted WITHOUT command scope, so
      // every command sent afterwards would be refused. Swap in the one the
      // server just issued.
      if (j.viewToken) {
        history.replaceState(
          null,
          '',
          `${window.location.pathname}#t=${encodeURIComponent(j.viewToken)}`,
        )
      }
      setCmd((c) => ({ ...c, enabled: true }))
      void pullMeta()
    } catch (e) {
      // "admin-auth-required" means this TAB has no admin session — the panel
      // keeps it in sessionStorage, which is per-tab. Say what to do about it
      // instead of showing the raw code.
      const err = e as Error & { code?: string }
      setCmdEnableErr(
        err.code === 'auth' || err.message === 'admin-auth-required'
          ? 'הטאב הזה לא מזוהה כמנהל. פתחו את הסשן מחדש מתוך פאנל הניהול, או פתחו את הפאנל בטאב הזה והתחברו — ואז נסו שוב.'
          : err.message || 'ההפעלה נכשלה. נסו שוב.',
      )
    } finally {
      setCmdEnabling(false)
    }
  }

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

  /** Ask for a written diagnosis of everything the session has gathered.
   *  On demand rather than continuous: the logs re-upload every couple of
   *  seconds, and analysing each round would cost a fortune to tell you the
   *  same thing over and over. */
  async function analyze() {
    if (ai.busy) return
    setAi({ busy: true, answer: '', error: '' })
    try {
      const j = await api<{ answer?: string; error?: string }>('support-analyze', {
        code: cleanCode,
        question: aiQuestion.trim() || undefined,
        // Opt-in per run: images cost several times a page of text, and a
        // customer's desktop holds plenty that has nothing to do with the fault.
        includeScreens: aiScreens && Object.keys(shots).length > 0,
      })
      setAi({ busy: false, answer: j.answer || '', error: '' })
    } catch (e) {
      setAi({ busy: false, answer: '', error: (e as Error).message || 'הניתוח נכשל' })
    }
  }

  /** Put a suggested command into the console input rather than firing it.
   *  The operator still presses send — one deliberate act, never two clicks
   *  from a model's sentence to a stranger's shell. */
  function stageCmd(text: string) {
    setCmdInput(text)
    document.getElementById('support-cmd-input')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    ;(document.getElementById('support-cmd-input') as HTMLInputElement | null)?.focus()
  }

  // ── Peer-to-peer transfer ────────────────────────────────────────────
  function closePeer() {
    try {
      peerRef.current?.close()
    } catch {
      /* already closed */
    }
    peerRef.current = null
  }

  function xferSignal(id: string, body: Record<string, unknown>) {
    return api('support-xfer-signal', { code: cleanCode, id, ...body })
  }

  async function startXferRequest(direction: 'to-admin' | 'to-customer', file?: File) {
    setXferError('')
    setXferNote('')
    setXferProgress(null)
    setXferReceivedText(null)
    xferFileRef.current = file ?? null
    try {
      await api('support-xfer-request', {
        code: cleanCode,
        direction,
        ...(file
          ? { name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }
          : {}),
      })
      xferActiveRef.current = true
      void pullMeta()
    } catch (e) {
      setXferError((e as Error).message || 'הבקשה נכשלה')
    }
  }

  /** The customer offered a file or text — take it. The click is also the
   *  user gesture the browser demands before opening a save-file picker, so
   *  the destination is chosen here, before a single byte moves. */
  async function acceptFromCustomer(x: Xfer) {
    if (!x.offerSdp || xferBusy) return
    setXferBusy(true)
    setXferError('')
    type Writable = { write(data: unknown): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }
    let fileSink: Writable | null = null
    let answered = false
    const parts: Uint8Array[] = []
    try {
      if (x.kind === 'file') {
        const picker = (
          window as unknown as {
            showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{ createWritable(): Promise<Writable> }>
          }
        ).showSaveFilePicker
        if (picker) {
          const handle = await picker({ suggestedName: x.name || 'file' })
          fileSink = await handle.createWritable()
        }
      }
      const pc = createPeer()
      peerRef.current = pc
      const { link, sdp } = await makeAnswer(pc, x.offerSdp)
      await xferSignal(x.id, { answerSdp: sdp })
      answered = true
      setXferNote('מתחבר ישירות למחשב של הלקוח…')
      const l = await awaitChannel(pc, link)
      await waitOpen(pc, l.channel)
      setXferNote('מקבל…')
      const meta = await receivePayload(
        l,
        {
          begin: (m) => m.kind === x.kind && (x.size == null || m.size === x.size),
          write: async (chunk) => {
            if (fileSink) await fileSink.write(chunk)
            else parts.push(chunk)
          },
          end: async (ok) => {
            if (!fileSink) return
            if (ok) await fileSink.close()
            else await fileSink.abort?.()
          },
        },
        (got, total) => setXferProgress(total ? got / total : 1),
      )
      if (meta.kind === 'text') {
        setXferReceivedText(new TextDecoder().decode(joinBytes(parts)))
        setXferNote('הטקסט התקבל.')
      } else if (fileSink) {
        setXferNote('הקובץ התקבל ונשמר במחשב שלך.')
      } else {
        // No save-file picker in this browser — hand it over as a download.
        const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: meta.mime }))
        const a = document.createElement('a')
        a.href = url
        a.download = meta.name
        a.click()
        // Revoking right after the click can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        setXferNote('הקובץ התקבל.')
      }
      await xferSignal(x.id, { state: 'done' }).catch(() => undefined)
      // Let the acknowledgement leave before tearing the connection down.
      await new Promise((r) => setTimeout(r, 1500))
    } catch (e) {
      // Closing the save picker before answering isn't a failure — nothing started.
      if (!answered && (e as Error).name === 'AbortError') return
      if (fileSink?.abort) await fileSink.abort().catch(() => undefined)
      await reportXferFailure(
        x.id,
        e,
        e instanceof IntegrityError ? 'הקובץ הגיע פגום, ולכן לא נשמר. בקשו אותו שוב.' : 'ההעברה נכשלה.',
      )
    } finally {
      closePeer()
      setXferBusy(false)
      setXferProgress(null)
      void pullMeta()
    }
  }

  /** Report a failure this side saw. When the customer's app already ended the
   *  transfer, its own account (cancelled, couldn't save) is what the status
   *  line shows, so the generic error gives way to it. */
  async function reportXferFailure(id: string, e: unknown, message: string) {
    const blocked = e instanceof BlockedNetworkError
    const detail = blocked ? e.detail : ''
    closePeer()
    setXferNote('')
    // Show the operator what this side actually managed. "srflx=0" means the
    // STUN servers never answered from here, which is a different problem from
    // two NATs that can't meet.
    setXferError(blocked ? `${XFER_BLOCKED_NOTE}${detail ? ` (${detail})` : ''}` : message)
    // Both ends see a blocked network at once. For anything else, give the
    // customer's app a moment to report the more specific reason first.
    if (!blocked) await new Promise((r) => setTimeout(r, 1500))
    try {
      await xferSignal(id, {
        state: 'failed',
        reason: blocked ? `blocked ${detail}`.trim().slice(0, 60) : 'error',
      })
    } catch (err) {
      const m = (err as Error).message
      if (m === 'ended' || m === 'stale') setXferError('')
    }
  }

  async function cancelXfer() {
    if (!xfer) return
    closePeer()
    await xferSignal(xfer.id, { state: 'cancelled' }).catch(() => undefined)
    void pullMeta()
  }

  // Operator → customer: once the customer approves and picks where to save,
  // their app offers; answer it and push the file the operator already chose.
  useEffect(() => {
    const x = xfer
    if (!x || x.direction !== 'to-customer' || x.state !== 'offered' || !x.offerSdp) return
    if (xferHandledRef.current === x.id) return
    xferHandledRef.current = x.id
    const file = xferFileRef.current
    if (!file) {
      setXferError('הקובץ שבחרת כבר לא זמין בטאב הזה. בחר אותו שוב ושלח מחדש.')
      void xferSignal(x.id, { state: 'cancelled', reason: 'file-lost' }).catch(() => undefined)
      return
    }
    const offerSdp = x.offerSdp
    void (async () => {
      setXferBusy(true)
      try {
        const pc = createPeer()
        peerRef.current = pc
        const { link, sdp } = await makeAnswer(pc, offerSdp)
        await xferSignal(x.id, { answerSdp: sdp })
        setXferNote('הלקוח אישר. מתחבר ישירות למחשב שלו…')
        const l = await awaitChannel(pc, link)
        await waitOpen(pc, l.channel)
        setXferNote('שולח…')
        await sendPayload(
          l,
          { kind: 'file', blob: file, name: file.name, mime: file.type || 'application/octet-stream' },
          (sent, total) => setXferProgress(total ? sent / total : 1),
        )
        setXferNote('הקובץ נמסר ללקוח.')
        await xferSignal(x.id, { state: 'done' }).catch(() => undefined)
      } catch (e) {
        await reportXferFailure(
          x.id,
          e,
          e instanceof IntegrityError ? 'הקובץ הגיע אצל הלקוח פגום. נסו לשלוח שוב.' : 'ההעברה נכשלה.',
        )
      } finally {
        closePeer()
        setXferBusy(false)
        setXferProgress(null)
        void pullMeta()
      }
    })()
  }, [xfer])

  const xferLive = !!xfer && !XFER_TERMINAL.includes(xfer.state)
  const xferStatus = (() => {
    if (!xfer) return ''
    const what =
      xfer.kind === 'text'
        ? 'טקסט'
        : `${xfer.name || 'קובץ'}${xfer.size != null ? ` (${formatBytes(xfer.size)})` : ''}`
    switch (xfer.state) {
      case 'requested':
        return xfer.direction === 'to-admin'
          ? 'ממתין שהלקוח יבחר מה לשלוח…'
          : `ממתין שהלקוח יאשר קבלה של ${what}…`
      case 'offered':
        return xfer.direction === 'to-admin' ? `הלקוח רוצה לשלוח לך ${what}.` : 'הלקוח אישר…'
      case 'answered':
      case 'sending':
        return 'מעביר…'
      case 'done':
        return 'ההעברה הושלמה.'
      case 'declined':
        return 'הלקוח דחה את ההעברה.'
      case 'cancelled':
        return 'ההעברה בוטלה.'
      case 'failed':
        return xfer.reason?.startsWith('blocked')
          ? `${XFER_BLOCKED_NOTE}${xfer.reason.length > 8 ? ` · ${xfer.reason.slice(8)}` : ''}`
          : xfer.reason === 'disk'
            ? 'ההעברה נכשלה: לא היה אפשר לשמור את הקובץ במחשב של הלקוח (אולי אין מספיק מקום).'
            : 'ההעברה נכשלה.'
      default:
        return ''
    }
  })()

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
  /** The machine profile, as the plain-text file that leads the report.
   *  Log files say what went wrong; without this there's no record of what it
   *  went wrong ON, and a bundle downloaded today is unreadable next month. */
  function machineReport(): string {
    const L: string[] = []
    const rule = '─'.repeat(46)
    L.push('פרטי המחשב · ניהול הורדות פלוס', rule)
    L.push(`קוד סשן: ${cleanCode}`)
    if (meta.email) L.push(`חשבון: ${meta.email}`)
    if (meta.appVersion) L.push(`גרסת התוכנה: ${meta.appVersion}`)
    if (meta.platform) L.push(`דפדפן/מערכת (מדווח): ${meta.platform}`)
    L.push(`הדוח הופק: ${new Date().toLocaleString('he-IL')}`)

    // No column padding anywhere below: these lines mix Hebrew labels with
    // Latin values, and in a plain-text editor the bidi algorithm moves
    // padding spaces into the middle of the line rather than aligning it.
    if (system.length) {
      // Printed in the order the app sent, opening a block at each new section.
      let cur = ''
      for (const r of system) {
        if (r.s !== cur) {
          cur = r.s
          L.push('', rule, cur, rule)
        }
        L.push(`${r.k}: ${r.v}`)
      }
    } else if (hardware) {
      // An older app version reported specs but not the long profile.
      L.push('', rule, 'חומרה', rule)
      L.push(`דגם: ${hardware.model}`)
      L.push(`מעבד: ${hardware.cpu}`)
      L.push(`ליבות: ${hardware.cores}`)
      L.push(`זיכרון: ${hardware.ram}`)
      L.push(`כרטיס מסך: ${hardware.gpu}`)
      L.push(`זיכרון כרטיס: ${hardware.vram}`)
      L.push('', 'התוכנה במחשב הזה ישנה מכדי לדווח את הפרופיל המלא.')
    } else {
      L.push('', 'המחשב לא הספיק לדווח את פרטיו לפני שהסשן הסתיים.')
    }

    if (displays.length) {
      L.push('', rule, 'מסכים', rule)
      for (const d of displays) {
        L.push(`מסך ${d.index + 1}${d.primary ? ' (ראשי)' : ''}: ${d.w}×${d.h}`)
      }
      if (screenPerm !== 'granted') L.push(`הרשאת צילום מסך: ${screenPerm}`)
    }

    const names = Object.keys(content).sort()
    if (names.length) {
      L.push('', rule, `קבצי לוג בדוח (${names.length})`, rule)
      // Filename first and unlabelled — a Hebrew unit at the end of a Latin
      // filename would jump to the wrong side of the line.
      for (const n of names) L.push(n)
    }
    return L.join('\r\n')
  }

  function downloadAll() {
    const enc = new TextEncoder()
    const entries = Object.entries(content).map(([n, c]) => ({ name: n, data: enc.encode(c) }))
    // A session that reported its machine but produced no log file is still
    // worth downloading — the specs are the point.
    if (!entries.length && !system.length && !hardware) return
    // Leads the archive: "00-" so it sorts first, and a BOM so Notepad on
    // Windows reads the Hebrew as UTF-8 instead of mojibake.
    entries.unshift({
      name: '00-machine-info.txt',
      data: enc.encode('﻿' + machineReport()),
    })
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

        {status === 'stopped' && (
          <p className="mb-3 text-xs text-muted-foreground">
            {purged
              ? 'הסשן הופסק והנתונים נמחקו מהאחסון.'
              : `הסשן הופסק. הנתונים יימחקו מהאחסון${purgeAt ? ` בעוד כ-${Math.max(0, Math.ceil((purgeAt - Date.now()) / 60000))} דק׳` : ' בקרוב'}.`}
          </p>
        )}

        {/* Machine specs (reported once on consent, like the system-check link) */}
        {hardware && (
          <div className="mb-4 rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" /> פרטי המחשב
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
              {[
                ['דגם', hardware.model],
                ['מעבד', hardware.cpu],
                ['ליבות', hardware.cores],
                ['זיכרון (RAM)', hardware.ram],
                ['כרטיס מסך', hardware.gpu],
                ['זיכרון גרפי', hardware.vram],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate font-medium text-foreground" title={v}>{v || '—'}</dd>
                </div>
              ))}
            </dl>
            {displays.length > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                מסכים מחוברים: {displays.map((d) => `${d.w}×${d.h}${d.primary ? ' (ראשי)' : ''}`).join(' · ')}
              </p>
            )}
          </div>
        )}

        {/* AI diagnosis — reads the logs + machine profile, writes an opinion.
            Never acts: any command it proposes is printed for the operator to
            run deliberately, because the material it reads comes from someone
            else's computer and can say anything. */}
        <div className="mb-4 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" /> אבחון אוטומטי
            </span>
            <input
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void analyze()
              }}
              placeholder="שאלה ממוקדת (לא חובה) — למשל: למה ההפרדה רצה על מעבד?"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
            <button
              onClick={() => void analyze()}
              disabled={ai.busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 text-xs text-primary ring-1 ring-primary/40 transition hover:bg-primary/25 disabled:opacity-50"
            >
              {ai.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {ai.busy ? 'מנתח…' : 'נתח את הסשן'}
            </button>
          </div>
          {Object.keys(shots).length > 0 && (
            <label className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={aiScreens}
                onChange={(e) => setAiScreens(e.target.checked)}
                className="accent-primary"
              />
              כלול גם את צילומי המסך בניתוח (למשל תקלה שרואים ולא כתובה בלוג)
            </label>
          )}
          {ai.error && <p className="text-xs text-red-400">{ai.error}</p>}
          {ai.answer ? (
            <>
              <Diagnosis
                text={ai.answer}
                onRun={cmd.enabled && cmd.consent ? stageCmd : undefined}
              />
              <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                נכתב על ידי מודל שקרא את הלוגים — הוא לא הריץ כלום ולא נגע במחשב. פקודה שהוא מציע נטענת לטרמינל ורצה רק כשאתם שולחים אותה, אז קראו אותה קודם.
              </p>
            </>
          ) : (
            !ai.busy &&
            !ai.error && (
              <p className="text-[11px] text-muted-foreground">
                קורא את כל הלוגים שנאספו ואת פרטי המחשב, ומחזיר אבחון עם הראיות שעליהן הוא מסתמך.
              </p>
            )
          )}
        </div>

        {/* Peer-to-peer transfer — files and text move straight between the two
            machines over an encrypted WebRTC channel. Nothing is stored; the
            server only carries the handshake. */}
        <div className="mb-4 rounded-xl border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ArrowLeftRight className="h-3.5 w-3.5" /> העברת קבצים וטקסט
            </span>
            <span className="text-[11px] text-muted-foreground">
              ישירות בין המחשבים, מוצפן — לא נשמר בשום שרת
            </span>
          </div>
          {status !== 'active' ? (
            <p className="text-[11px] text-muted-foreground">זמין כשהסשן פעיל.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void startXferRequest('to-admin')}
                disabled={xferLive || xferBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-secondary disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" /> בקשת קובץ או טקסט מהלקוח
              </button>
              <button
                type="button"
                onClick={() => xferInputRef.current?.click()}
                disabled={xferLive || xferBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-secondary disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" /> שליחת קובץ ללקוח
              </button>
              <input
                ref={xferInputRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  if (f.size > MAX_TRANSFER_BYTES) {
                    setXferError('אפשר לשלוח קבצים עד 2GB.')
                    return
                  }
                  void startXferRequest('to-customer', f)
                }}
              />
              {xferLive && (
                <button
                  type="button"
                  onClick={() => void cancelXfer()}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                >
                  ביטול
                </button>
              )}
            </div>
          )}
          {xfer && (xferNote || xferStatus) && (
            <p className="mt-2 text-xs text-foreground">{xferNote || xferStatus}</p>
          )}
          {xfer && xfer.state === 'offered' && xfer.direction === 'to-admin' && (
            <button
              type="button"
              onClick={() => void acceptFromCustomer(xfer)}
              disabled={xferBusy}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 text-xs text-primary ring-1 ring-primary/40 transition hover:bg-primary/25 disabled:opacity-50"
            >
              {xferBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {xfer.kind === 'text' ? 'קבלת הטקסט' : 'קבלה ושמירה'}
            </button>
          )}
          {xferProgress != null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary" style={{ width: `${Math.round(xferProgress * 100)}%` }} />
            </div>
          )}
          {xferError && <p className="mt-2 text-xs text-red-400">{xferError}</p>}
          {xferReceivedText != null && (
            <div className="mt-2 space-y-1">
              <pre
                dir="auto"
                className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 text-[11px] text-foreground"
              >
                {xferReceivedText}
              </pre>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(xferReceivedText)
                    .then(() => {
                      setXferCopied(true)
                      setTimeout(() => setXferCopied(false), 1500)
                    })
                    .catch(() => undefined)
                }
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary"
              >
                {xferCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {xferCopied ? 'הועתק' : 'העתק'}
              </button>
            </div>
          )}
        </div>

        {/* Screen-capture controls — what the app should stream */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2.5">
          <span className="me-1 text-xs font-medium text-muted-foreground">שיתוף מסך:</span>
          {([
            ['off', 'כבוי', MonitorOff],
            ['app', 'התוכנה בלבד', AppWindow],
            ['desktop', 'כל המסך', Monitor],
          ] as const).map(([m, label, Icon]) => (
            <button
              key={m}
              onClick={() => void changeScreen(m, m === 'desktop' ? (screenDisplay >= 0 ? screenDisplay : -1) : -1)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
                screenMode === m ? 'bg-primary/15 text-primary ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
          {screenMode === 'desktop' && screenPerm !== 'granted' && (
            <span className="w-full text-[11px] text-amber-400">
              המשתמש לא אישר "הקלטת מסך" (macOS). יש לאשר בהגדרות המערכת ← פרטיות ← הקלטת מסך, ולהפעיל את התוכנה מחדש.
            </span>
          )}
          {screenMode === 'desktop' && displays.length > 1 && (
            <select
              value={screenDisplay}
              onChange={(e) => void changeScreen('desktop', Number(e.target.value))}
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
            >
              <option value={-1}>כל המסכים</option>
              {displays.map((d) => (
                <option key={d.id} value={d.index}>
                  מסך {d.index + 1} — {d.w}×{d.h}{d.primary ? ' (ראשי)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

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
        {/* Commands can be turned on mid-session. Deciding up front whether a
            fault will need a terminal is guesswork — you usually find out from
            the logs, by which point the session is already running, and
            starting over to tick a box costs the customer another consent. */}
        {!cmd.enabled && status !== 'stopped' && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
            <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs text-muted-foreground">
              הרצת פקודות כבויה בסשן הזה. אפשר להפעיל עכשיו — נדרש אימות שלך, והמשתמש יתבקש לאשר בנפרד בתוכנה.
            </span>
            <button
              onClick={() => void enableCmd()}
              disabled={cmdEnabling}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs text-amber-500 ring-1 ring-amber-500/40 transition hover:bg-amber-500/25 disabled:opacity-50"
            >
              {cmdEnabling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <TerminalSquare className="h-3.5 w-3.5" />
              )}
              הפעל הרצת פקודות
            </button>
            {cmdEnableErr && <span className="w-full text-[11px] text-red-400">{cmdEnableErr}</span>}
          </div>
        )}

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
                        <div className="text-emerald-400">
                          {e.cwd && <span className="text-muted-foreground">{e.cwd} </span>}$ {e.text}
                        </div>
                        {e.output && <pre className="whitespace-pre-wrap text-foreground/80">{e.output}</pre>}
                        {e.truncated && <div className="text-amber-500/80">[הפלט נחתך]</div>}
                      </div>
                    ))
                  )}
                </div>
                <div className="flex items-center gap-2 border-t border-amber-500/20 p-2">
                  <input
                    id="support-cmd-input"
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
