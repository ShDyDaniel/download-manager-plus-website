import { useEffect, useState } from 'react'
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Bug,
  Lightbulb,
  Check,
  Trash2,
  Undo2,
  ImageIcon,
  MessageSquare,
  Mail,
  Send,
  X,
} from 'lucide-react'
import { adminApi, getAdminIdToken } from '../../lib/adminApi'
import { Portal } from '@/components/ui/Portal'

interface FeedbackReply {
  reply: string
  at: string
  by?: string
}
interface FeedbackDoc {
  id: string
  kind: 'bug' | 'feature' | 'contact'
  source?: string
  subject?: string | null
  message: string
  userEmail?: string | null
  userName?: string | null
  appVersion?: string
  platform?: string | null
  resolved?: boolean
  createdAt?: string
  telegramFileId?: string
  telegramFileIds?: string[]
  replies?: FeedbackReply[]
  lastRepliedAt?: string
}

export default function FeedbackTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [items, setItems] = useState<FeedbackDoc[] | null>(null)
  const [view, setView] = useState<'open' | 'handled'>('open')
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  async function load() {
    setError('')
    try {
      const r = await adminApi<{ items: FeedbackDoc[] }>('admin-list-feedback')
      setItems(r.items)
    } catch (e) {
      handleErr(e)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleResolved(it: FeedbackDoc) {
    if (busyId) return
    setBusyId(it.id)
    try {
      await adminApi('admin-set-feedback-resolved', {
        id: it.id,
        resolved: !it.resolved,
      })
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyId(null)
    }
  }

  async function del(it: FeedbackDoc) {
    if (busyId) return
    if (!window.confirm('למחוק את הפנייה לצמיתות?')) return
    setBusyId(it.id)
    try {
      await adminApi('admin-delete-feedback', { id: it.id })
      await load()
    } catch (e) {
      handleErr(e)
    } finally {
      setBusyId(null)
    }
  }

  const list = (items ?? []).filter((it) =>
    view === 'open' ? !it.resolved : it.resolved,
  )
  const open = (items ?? []).filter((it) => !it.resolved)
  const openCount = open.length
  const handledCount = (items ?? []).filter((it) => it.resolved).length
  const openBugs = open.filter((it) => it.kind === 'bug').length
  const openFeatures = open.filter((it) => it.kind === 'feature').length

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold font-display text-fg">פניות</h2>
          <p className="mt-1 text-sm text-fg-muted">פניות מהאתר, באגים ובקשות פיצ׳רים ממשתמשים.</p>
        </div>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-fg transition-colors hover:bg-popover"
        >
          <RefreshCw className="h-3.5 w-3.5" /> רענן
        </button>
      </header>

      {items !== null && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="פתוחים" value={openCount} color="from-primary to-primary" icon={<MessageSquare className="h-4 w-4 text-white" />} />
          <StatCard label="באגים פתוחים" value={openBugs} color="from-destructive to-primary" icon={<Bug className="h-4 w-4 text-white" />} />
          <StatCard label="פיצ׳רים פתוחים" value={openFeatures} color="from-accent to-primary" icon={<Lightbulb className="h-4 w-4 text-white" />} />
        </div>
      )}

      <div className="flex gap-2">
        <Tab active={view === 'open'} onClick={() => setView('open')}>
          פתוחים ({openCount})
        </Tab>
        <Tab active={view === 'handled'} onClick={() => setView('handled')}>
          טופלו ({handledCount})
        </Tab>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {items === null ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-10 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען…
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl border border-border py-10 text-center text-sm text-fg-muted">
          {view === 'open' ? 'אין פניות פתוחות 🎉' : 'אין פניות שטופלו'}
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((it) => (
            <FeedbackRow
              key={it.id}
              it={it}
              busy={busyId === it.id}
              onToggle={() => toggleResolved(it)}
              onDelete={() => del(it)}
              onReplied={() => void load()}
              onAuthExpired={onAuthExpired}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-lg border px-3 py-1.5 text-xs transition-colors ' +
        (active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border text-fg-muted hover:text-fg')
      }
    >
      {children}
    </button>
  )
}

function FeedbackRow({
  it,
  busy,
  onToggle,
  onDelete,
  onReplied,
  onAuthExpired,
}: {
  it: FeedbackDoc
  busy: boolean
  onToggle: () => void
  onDelete: () => void
  onReplied: () => void
  onAuthExpired: () => void
}) {
  const [images, setImages] = useState<string[] | null>(null)
  const [loadingImg, setLoadingImg] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)
  const [replyErr, setReplyErr] = useState('')

  async function sendReply() {
    if (replyText.trim().length < 2) return
    setReplyBusy(true)
    setReplyErr('')
    try {
      await adminApi('admin-reply-feedback', {
        id: it.id,
        reply: replyText.trim(),
      })
      setReplyText('')
      setReplyOpen(false)
      onReplied()
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onAuthExpired()
      setReplyErr(err.message || 'שליחת התשובה נכשלה')
    } finally {
      setReplyBusy(false)
    }
  }
  const fileIds =
    it.telegramFileIds && it.telegramFileIds.length
      ? it.telegramFileIds
      : it.telegramFileId
        ? [it.telegramFileId]
        : []

  async function loadImages() {
    if (loadingImg || images) return
    setLoadingImg(true)
    try {
      const idToken = await getAdminIdToken()
      if (!idToken) return onAuthExpired()
      const urls: string[] = []
      for (const fid of fileIds) {
        const r = await fetch(
          `/api/feedback?fileId=${encodeURIComponent(fid)}`,
          { headers: { Authorization: `Bearer ${idToken}` } },
        )
        if (r.ok) {
          const blob = await r.blob()
          urls.push(URL.createObjectURL(blob))
        }
      }
      setImages(urls)
    } finally {
      setLoadingImg(false)
    }
  }

  const isBug = it.kind === 'bug'
  const isContact = it.kind === 'contact'
  const kindLabel = isContact ? 'פנייה' : isBug ? 'באג' : 'הצעה'
  const KindIcon = isContact ? Mail : isBug ? Bug : Lightbulb
  const kindTone = isContact
    ? 'bg-primary/10 text-primary'
    : isBug
      ? 'bg-destructive/10 text-destructive'
      : 'bg-accent/10 text-accent'
  const kindBorder = isContact
    ? 'border-primary/30 text-primary'
    : isBug
      ? 'border-destructive/30 text-destructive'
      : 'border-accent/30 text-accent'
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span
          className={
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ' +
            kindTone
          }
        >
          <KindIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                'rounded-full border px-1.5 py-0.5 text-[9px] font-bold ' +
                kindBorder
              }
            >
              {kindLabel}
            </span>
            {it.userName && (
              <span className="text-xs font-medium text-fg">{it.userName}</span>
            )}
            {it.userEmail && (
              <span className="text-[11px] text-fg-muted" dir="ltr">
                {it.userEmail}
              </span>
            )}
          </div>
          {it.subject && (
            <div className="mt-1 text-xs font-semibold text-fg">{it.subject}</div>
          )}
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-fg">{it.message}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-fg-faint">
            {it.createdAt && (
              <span>{new Date(it.createdAt).toLocaleString('he-IL')}</span>
            )}
            {it.appVersion && (
              <>
                <span>·</span>
                <span dir="ltr">v{it.appVersion}</span>
              </>
            )}
            {it.platform && (
              <>
                <span>·</span>
                <span dir="ltr">{it.platform}</span>
              </>
            )}
          </div>

          {fileIds.length > 0 && (
            <div className="mt-2">
              {images ? (
                <div className="flex flex-wrap gap-2">
                  {images.map((u, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setLightbox(u)}
                      className="overflow-hidden rounded-lg border border-border transition-opacity hover:opacity-80"
                    >
                      <img
                        src={u}
                        alt=""
                        className="h-20 w-20 object-cover"
                      />
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={loadImages}
                  disabled={loadingImg}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
                >
                  {loadingImg ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3 w-3" />
                  )}
                  הצג {fileIds.length} צילומי מסך
                </button>
              )}
            </div>
          )}

          {/* Sent replies */}
          {it.replies && it.replies.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {it.replies.map((r, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-success/25 bg-success/[0.06] px-3 py-2"
                >
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] text-success">
                    <Mail className="h-3 w-3" />
                    נשלחה תשובה · {new Date(r.at).toLocaleString('he-IL')}
                  </div>
                  <p className="whitespace-pre-wrap text-xs text-fg-secondary">
                    {r.reply}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Reply composer */}
          {it.userEmail && (
            <div className="mt-3">
              {!replyOpen ? (
                <button
                  type="button"
                  onClick={() => setReplyOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20"
                >
                  <Mail className="h-3 w-3" />
                  {it.replies && it.replies.length ? 'שליחת תשובה נוספת' : 'השב במייל'}
                </button>
              ) : (
                <div className="space-y-2 rounded-lg border border-border bg-bg-elevated p-2.5">
                  <textarea
                    autoFocus
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder={`תשובה שתישלח למייל של ${it.userName || 'הלקוח'}…`}
                    rows={4}
                    className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-primary focus:outline-none"
                  />
                  {replyErr && (
                    <div className="text-[11px] text-destructive">{replyErr}</div>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setReplyOpen(false)
                        setReplyErr('')
                      }}
                      className="rounded-md px-2.5 py-1.5 text-[11px] text-fg-muted hover:text-fg"
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      disabled={replyBusy || replyText.trim().length < 2}
                      onClick={() => void sendReply()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {replyBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      שליחה במייל
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            title={it.resolved ? 'החזר לפתוח' : 'סמן כטופל'}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : it.resolved ? (
              <Undo2 className="h-3.5 w-3.5" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            title="מחק"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-fg-muted transition-colors hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {lightbox && (
        <Portal>
          <div
            dir="rtl"
            onClick={() => setLightbox(null)}
            className="fixed inset-0 z-[260] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              onClick={() => setLightbox(null)}
              className="absolute right-5 top-5 rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="סגירה"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={lightbox}
              alt=""
              onClick={(e) => e.stopPropagation()}
              className="max-h-[90vh] max-w-[90vw] rounded-xl border border-white/10 object-contain shadow-2xl"
            />
          </div>
        </Portal>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string
  value: number
  color: string
  icon: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
      <div>
        <div className="text-2xl font-semibold tabular-nums text-fg">{value}</div>
        <div className="text-[11px] text-fg-muted">{label}</div>
      </div>
      <div
        className={
          'flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br shadow-md ' +
          color
        }
      >
        {icon}
      </div>
    </div>
  )
}
