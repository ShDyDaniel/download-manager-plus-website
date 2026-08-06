import { useEffect, useState } from 'react'
import { Key as KeyIcon, X, ExternalLink } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Portal } from '@/components/ui/Portal'
import { cn } from '@/lib/cn'

/** Permissive shape — both the Keys tab (full doc) and the Users tab
 *  (key summary) pass into this. Everything except `key` is optional;
 *  rows render only when their field is present. */
export interface KeyDetailsData {
  key: string
  redeemedBy?: string | null
  redeemedByEmail?: string | null
  redeemedAt?: string | null
  expiresAt?: string | null
  createdAt?: string
  createdBy?: string
  subscriptionId?: string | null
  planId?: string | null
  planDays?: number | null
  subscriptionPlanDays?: number | null
  subscriptionPrice?: number | null
  subscriptionCurrency?: string | null
  buyerEmail?: string | null
  nonPaidGrant?: boolean
  grantReason?: string | null
  grantedByAdmin?: string | null
  subscriptionStatus?: string | null
  subscriptionCancelledAt?: string | null
  subscriptionCancelReason?: string | null
  autoRedeemedFromWebhook?: boolean
  billingHistory?: unknown[]
  replacedPriorKeys?: unknown[]
}

function fmtDateTime(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  })
}

export function KeyDetailsModal({
  keyDoc,
  onClose,
}: {
  keyDoc: KeyDetailsData | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState<'key' | 'sub' | null>(null)
  function copy(text: string, kind: 'key' | 'sub') {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  useEffect(() => {
    if (!keyDoc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [keyDoc, onClose])

  if (!keyDoc) return null

  const createdLabel = (() => {
    const cb = keyDoc.createdBy || ''
    if (cb.startsWith('admin-grant:')) return `הענקת אדמין (${cb.slice(12)})`
    if (cb.startsWith('admin-web:')) return `הענקת אדמין (${cb.slice(10)})`
    if (cb.startsWith('paypal-subscription-yearly')) return 'PayPal · מנוי שנתי'
    if (cb.startsWith('paypal-subscription-monthly')) return 'PayPal · מנוי חודשי'
    if (cb.startsWith('paypal')) return 'PayPal'
    if (cb === 'manual') return 'ידני (קונסול)'
    return cb || '—'
  })()
  const planLabel = (() => {
    const days = keyDoc.subscriptionPlanDays || keyDoc.planDays
    if (!days) return null
    if (days >= 300) return 'שנתי'
    if (days === 30) return 'חודשי'
    return `${days} ימים`
  })()

  return (
    <Portal>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, pointerEvents: 'auto' }}
          exit={{ opacity: 0, pointerEvents: 'none' }}
          transition={{ duration: 0.18 }}
          dir="rtl"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 px-4 backdrop-blur-md"
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, y: 12 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-7 shadow-xl"
          >
            <button
              onClick={onClose}
              className="absolute left-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-popover hover:text-foreground"
              aria-label="סגור"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/15">
                <KeyIcon className="h-5 w-5 text-accent" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-foreground">פרטי מפתח מוצר</h2>
                <div className="text-xs text-muted-foreground">
                  כל הנתונים שיש על המפתח הזה
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <KeyDetailRow label="מפתח מלא">
                <div className="flex items-center gap-2">
                  <span dir="ltr" className="select-text font-mono text-xs text-foreground">
                    {keyDoc.key}
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(keyDoc.key, 'key')}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-popover hover:text-foreground"
                  >
                    {copied === 'key' ? '✓' : 'העתק'}
                  </button>
                </div>
              </KeyDetailRow>

              <KeyDetailSection title="פרטי יצירה">
                <KeyDetailRow label="נוצר בתאריך">
                  <span dir="ltr" className="text-xs text-foreground">
                    {fmtDateTime(keyDoc.createdAt)}
                  </span>
                </KeyDetailRow>
                <KeyDetailRow label="מקור">
                  <span className="text-xs text-foreground">{createdLabel}</span>
                </KeyDetailRow>
                {keyDoc.subscriptionId && (
                  <KeyDetailRow label="מזהה עסקה / מנוי">
                    <div className="flex flex-wrap items-center gap-2">
                      <span dir="ltr" className="select-text font-mono text-[11px] text-foreground">
                        {keyDoc.subscriptionId}
                      </span>
                      <button
                        type="button"
                        onClick={() => copy(keyDoc.subscriptionId!, 'sub')}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-popover hover:text-foreground"
                      >
                        {copied === 'sub' ? '✓' : 'העתק'}
                      </button>
                      <a
                        href={`https://www.paypal.com/billing/subscriptions/${encodeURIComponent(keyDoc.subscriptionId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
                        title="פותח את דף המנוי ב-PayPal. שם רואים את כל החיובים שבוצעו בפועל"
                      >
                        <ExternalLink className="h-2.5 w-2.5" />
                        צפה ב-PayPal
                      </a>
                    </div>
                  </KeyDetailRow>
                )}
                {keyDoc.planId && (
                  <KeyDetailRow label="Plan ID">
                    <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                      {keyDoc.planId}
                    </span>
                  </KeyDetailRow>
                )}
                {planLabel && (
                  <KeyDetailRow label="תוכנית">
                    <span className="text-xs text-foreground">{planLabel}</span>
                  </KeyDetailRow>
                )}
                {keyDoc.subscriptionPrice != null && (
                  <KeyDetailRow label="מחיר נעול">
                    <span className="text-xs text-foreground">
                      {keyDoc.subscriptionPrice}{' '}
                      {keyDoc.subscriptionCurrency === 'ILS'
                        ? '₪'
                        : keyDoc.subscriptionCurrency === 'USD'
                          ? '$'
                          : keyDoc.subscriptionCurrency || ''}
                    </span>
                  </KeyDetailRow>
                )}
                {keyDoc.buyerEmail && (
                  <KeyDetailRow label="מייל קונה">
                    <span dir="ltr" className="font-mono text-xs text-foreground">
                      {keyDoc.buyerEmail}
                    </span>
                  </KeyDetailRow>
                )}
                {keyDoc.nonPaidGrant && (
                  <KeyDetailRow label="הענקה ידנית">
                    <span className="text-xs text-accent">
                      {keyDoc.grantReason || '—'}
                      {keyDoc.grantedByAdmin && (
                        <span className="text-muted-foreground/60"> ({keyDoc.grantedByAdmin})</span>
                      )}
                    </span>
                  </KeyDetailRow>
                )}
              </KeyDetailSection>

              <KeyDetailSection title="פעילות">
                <KeyDetailRow label="מימוש">
                  {keyDoc.redeemedAt ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span dir="ltr" className="text-xs text-foreground">
                        {fmtDateTime(keyDoc.redeemedAt)}
                      </span>
                      {keyDoc.autoRedeemedFromWebhook && (
                        <span className="text-[10px] text-muted-foreground/70">
                          (אוטומטי דרך webhook)
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">לא מומש</span>
                  )}
                </KeyDetailRow>
                <KeyDetailRow label="בתוקף עד">
                  {keyDoc.expiresAt ? (
                    <span
                      dir="ltr"
                      className={cn(
                        'text-xs',
                        new Date(keyDoc.expiresAt).getTime() < Date.now()
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {fmtDateTime(keyDoc.expiresAt)}
                      {new Date(keyDoc.expiresAt).getTime() < Date.now() && (
                        <span className="mr-1 text-destructive">(פג)</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">ללא תפוגה</span>
                  )}
                </KeyDetailRow>
                {keyDoc.subscriptionStatus && (
                  <KeyDetailRow label="סטטוס מנוי">
                    <span className="text-xs text-foreground">{keyDoc.subscriptionStatus}</span>
                  </KeyDetailRow>
                )}
                {keyDoc.subscriptionCancelledAt && (
                  <KeyDetailRow label="בוטל בתאריך">
                    <div className="flex flex-col items-end gap-0.5">
                      <span dir="ltr" className="text-xs text-foreground">
                        {fmtDateTime(keyDoc.subscriptionCancelledAt)}
                      </span>
                      {keyDoc.subscriptionCancelReason && (
                        <span className="text-[10px] text-muted-foreground/70">
                          {keyDoc.subscriptionCancelReason}
                        </span>
                      )}
                    </div>
                  </KeyDetailRow>
                )}
                {keyDoc.billingHistory && keyDoc.billingHistory.length > 0 && (
                  <KeyDetailRow label="חיובים">
                    <span className="text-xs text-foreground">
                      {keyDoc.billingHistory.length} סה״כ
                    </span>
                  </KeyDetailRow>
                )}
                {keyDoc.replacedPriorKeys && keyDoc.replacedPriorKeys.length > 0 && (
                  <KeyDetailRow label="החליף מפתחות">
                    <span className="text-xs text-muted-foreground">
                      {keyDoc.replacedPriorKeys.length} מפתחות קודמים
                    </span>
                  </KeyDetailRow>
                )}
              </KeyDetailSection>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </Portal>
  )
}

function KeyDetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {title}
      </div>
      <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
        {children}
      </div>
    </div>
  )
}

function KeyDetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="text-left">{children}</div>
    </div>
  )
}
