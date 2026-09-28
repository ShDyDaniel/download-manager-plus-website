import { useCallback, useEffect, useState } from 'react'
import {
  Send,
  Loader2,
  Copy,
  Check,
  Trash2,
  Lock,
  Clock,
  Plus,
  FileVideo,
  Cloud,
  Mail,
} from 'lucide-react'
import {
  deleteDelivery,
  fetchStorageBackend,
  fetchStorageState,
  formatBytes,
  listDeliveries,
  type DeliveryRow,
} from '../lib/revisionsApi'
import { cn } from '../lib/cn'
import { SITE_ORIGIN } from '../lib/site'
import { DeliveryComposerModal } from './workspace/deliveries/DeliveryComposerModal'
import '../styles/app-ui.css'
import { StorageMeter } from './workspace/StorageMeter'

/**
 * DeliveriesWorkspace — the web editor side of "מסירה ללקוח".
 * Mounted by /deliveries once ProWorkspaceShell confirms the user
 * is signed in + Pro. Looks EXACTLY like the desktop DeliveriesPage
 * (same markup + classes, rendered with the app's theme inside
 * `.app-ui` — see src/styles/app-ui.css): add button → composer modal
 * → list → storage bar. Uploads from the browser (uploadFileToR2
 * with initAction 'delivery-upload-init') and authenticates with the
 * website session JWT instead of a Firebase ID token.
 *
 * Desktop twin: src/pages/DeliveriesPage.tsx in the app repo. Keep the
 * markup in step with it.
 */

const SITE = SITE_ORIGIN

function expiryLabel(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'פג'
  const totalHours = Math.floor(ms / (60 * 60 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  const dPart = days > 0 ? `${days} ${days === 1 ? 'יום' : 'ימים'}` : ''
  const hPart = hours > 0 ? `${hours} ${hours === 1 ? 'שעה' : 'שעות'}` : ''
  if (dPart && hPart) return `עוד ${dPart} ו-${hPart}`
  if (dPart) return `עוד ${dPart}`
  if (hPart) return `עוד ${hPart}`
  return 'עוד פחות משעה'
}

export function DeliveriesWorkspace() {
  const [storage, setStorage] = useState<{
    usedBytes: number
    limitBytes: number
  } | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [composerOpen, setComposerOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  // Storage backend — deliveries are R2-only, so Drive accounts get a
  // "contact support" panel instead of the workspace. null = not known
  // yet (don't flash the workspace before we've confirmed).
  const [backend, setBackend] = useState<'r2' | 'drive' | null>(null)

  const refresh = useCallback(async () => {
    const [b, s, d] = await Promise.all([
      fetchStorageBackend().catch(() => 'r2' as const),
      fetchStorageState().catch(() => null),
      listDeliveries().catch(() => []),
    ])
    setBackend(b)
    setStorage(s)
    setDeliveries(d)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function copyLink(link: string, id: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800)
    } catch {
      /* ignore */
    }
  }

  async function confirmDelete(id: string) {
    setPendingDelete(null)
    try {
      await deleteDelivery(id)
      await refresh()
    } catch {
      /* ignore */
    }
  }

  if (backend === 'drive') {
    return <DriveNoAccessPanel />
  }

  return (
    // `.app-ui` switches on the desktop app's theme; its utilities apply to
    // descendants only, so the layout lives on the child.
    <div className="app-ui">
            <div dir="rtl" className="flex flex-col">
        {/* Header + list (matches the revisions tab exactly: centered
            max-w-4xl with py-8/md:py-10 top breathing room). */}
        <div className="flex-1">
          <div className="mx-auto w-full max-w-4xl px-6 pb-8 pt-2 md:pb-10 md:pt-4">
            {/* Header — title on the right (RTL start), primary CTA on
                the left. Same layout + sizing as the revisions tab. */}
            <header className="mb-8 flex items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  — מסירה ללקוח
                </div>
                <h1
                  className="font-display text-2xl font-extrabold tracking-tight text-foreground md:text-3xl"
                  style={{ letterSpacing: '-0.02em' }}
                >
                  שליחת הסרטון הסופי
                </h1>
                {storage && (
                  <StorageMeter usedBytes={storage.usedBytes} limitBytes={storage.limitBytes} />
                )}
              </div>

              <button
                type="button"
                onClick={() => setComposerOpen(true)}
                className="inline-flex min-h-[2.5rem] shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" strokeWidth={2.5} />
                שליחת סרטון
              </button>
            </header>

            {/* List — three states: loading / empty / list. */}
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2
                  className="h-5 w-5 animate-spin text-muted-foreground"
                  aria-label="טוען"
                />
              </div>
            ) : deliveries.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-14 text-center">
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Send className="h-6 w-6" strokeWidth={1.8} />
                </div>
                <h2 className="mb-2 text-base font-medium text-foreground">
                  אין עדיין מסירות
                </h2>
                <p className="mb-6 max-w-md text-xs leading-relaxed text-muted-foreground">
                  לחצו על "שליחת סרטון" כדי להעלות סרטון סופי ולקבל קישור
                  לשליחה ללקוח.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {deliveries.map((d) => {
                  const link = `${SITE}/deliver/${d.shareToken}`
                  const expired = d.expiresAt <= Date.now()
                  return (
                    <div
                      key={d.id}
                      className="rounded-xl border border-border bg-card p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium text-foreground">
                              {d.title || 'מסירה ללקוח'}
                            </p>
                            {d.hasPassword && (
                              <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                          </div>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
                            {/* Each meta item is its OWN flex chip so a bare
                                number never floats in the middle of the RTL
                                line. Count gets a video icon (reads as "N
                                clips"); size stays LTR; expiry keeps the
                                clock. */}
                            {/* (The app's `tabular` class is a no-op there; the
                                site defines one, so it's left off here.) */}
                            <span className="inline-flex items-center gap-1">
                              <FileVideo className="h-3 w-3 shrink-0" />
                              <span>{d.videoCount}</span>
                            </span>
                            <span dir="ltr">{formatBytes(d.sizeBytes)}</span>
                            <span
                              className={cn(
                                'inline-flex items-center gap-1',
                                expired && 'text-destructive',
                              )}
                            >
                              <Clock className="h-3 w-3 shrink-0" />
                              {expired ? 'פג' : expiryLabel(d.expiresAt)}
                            </span>
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {!expired && (
                            <button
                              type="button"
                              onClick={() => copyLink(link, d.id)}
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:border-primary/50"
                            >
                              {copied === d.id ? (
                                <Check className="h-3.5 w-3.5 text-success" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                              {copied === d.id ? 'הועתק' : 'העתקת קישור'}
                            </button>
                          )}
                          {pendingDelete === d.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => confirmDelete(d.id)}
                                className="inline-flex h-8 items-center rounded-md bg-destructive px-2.5 text-xs font-medium text-destructive-foreground"
                              >
                                מחיקה
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(null)}
                                className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-xs text-muted-foreground"
                              >
                                ביטול
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingDelete(d.id)}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
                              aria-label="מחיקת מסירה"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>


        <DeliveryComposerModal
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          onCreated={refresh}
        />
      </div>
    </div>
  )
}

/** Shown when the account's storage backend is Google Drive. Deliveries
 *  are built on our own R2 storage, so Drive accounts can't use the tab —
 *  point them to support. */
function DriveNoAccessPanel() {
  return (
    <div className="app-ui">
      <div
        dir="rtl"
        className="flex min-h-[50vh] flex-col items-center justify-center px-6 py-16 text-center"
      >
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Cloud className="h-7 w-7" strokeWidth={1.7} />
        </div>
        <h1 className="font-display text-2xl font-semibold text-foreground">
          הטאב אינו זמין בחשבון הזה
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          מערכת המסירה ללקוח עובדת מול האחסון שלנו. החשבון שלך מוגדר
          לאחסון ב‑Google Drive, ולכן אין גישה לטאב הזה. כדי לפתוח אותו,
          אפשר לפנות לתמיכה.
        </p>
        <a
          href="mailto:help.frameline@gmail.com?subject=פתיחת%20טאב%20מסירה%20ללקוח"
          className="mt-6 inline-flex min-h-[2.5rem] items-center gap-2 rounded-xl bg-primary px-5 py-2 text-sm font-semibold text-background shadow-md shadow-primary/20 transition-all hover:bg-primary/90"
        >
          <Mail className="h-4 w-4" />
          פנייה לתמיכה
        </a>
      </div>
    </div>
  )
}

