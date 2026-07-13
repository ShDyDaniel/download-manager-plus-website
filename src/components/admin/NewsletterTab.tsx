import { useCallback, useEffect, useState } from 'react'
import {
  Loader2,
  Send,
  Mail,
  Users as UsersIcon,
  RefreshCw,
  Copy,
  Check,
  Download,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from './SettingsTab'

/**
 * Admin → ניוזלטר (web). The mailing-list workspace: view every user
 * currently opted-in to marketing, copy/export the list, and compose
 * the broadcast. Moved out of Settings so it has room to breathe and
 * to expose the actual subscriber addresses (not just a count).
 */

interface Recipient {
  uid: string
  email: string
  optInAt: string | null
}

export default function NewsletterTab({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [error, setError] = useState('')

  function handleErr(e: unknown) {
    const err = e as Error & { code?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-3xl font-bold font-display text-fg">ניוזלטר</h2>
        <p className="mt-1 text-sm text-fg-muted">
          רשימת התפוצה — כל מי שהסכים לקבל תוכן שיווקי בהרשמה — ושליחת מייל שיווקי לכולם.
        </p>
      </header>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <RecipientsCard onErr={handleErr} />
      <BroadcastCard onErr={handleErr} />
    </div>
  )
}

/* ── רשימת הנרשמים ─────────────────────────────────────────────── */
function RecipientsCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [list, setList] = useState<Recipient[] | null>(null)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await adminApi<{ count?: number; recipients?: Recipient[] }>(
        'admin-list-marketing-recipients',
        {},
      )
      setList(j.recipients ?? [])
      setCount(j.count ?? j.recipients?.length ?? 0)
    } catch (e) {
      onErr(e)
    } finally {
      setLoading(false)
    }
  }, [onErr])

  // טוען אוטומטית בכניסה לטאב.
  useEffect(() => {
    void load()
  }, [load])

  async function copyAll() {
    if (!list || list.length === 0) return
    try {
      await navigator.clipboard.writeText(list.map((r) => r.email).join(', '))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  function exportCsv() {
    if (!list || list.length === 0) return
    const rows = [
      'email,opt_in_at',
      ...list.map((r) => `${r.email},${r.optInAt ?? ''}`),
    ]
    const blob = new Blob([`﻿${rows.join('\n')}`], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `newsletter-recipients-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card title="רשומים לרשימת התפוצה">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-sm text-fg">
          <UsersIcon className="h-4 w-4 text-accent" />
          <span className="font-semibold tabular-nums">{count}</span>
          <span className="text-fg-muted">רשומים</span>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            רענון
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copyAll()}
            disabled={!list || list.length === 0}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            העתקת הכל
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={exportCsv}
            disabled={!list || list.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            ייצוא CSV
          </Button>
        </div>
      </div>

      {loading && !list ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען רשימה…
        </div>
      ) : list && list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-fg-muted">
          <Mail className="h-6 w-6 opacity-40" />
          עדיין אין נרשמים לרשימת התפוצה.
        </div>
      ) : list ? (
        <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-fg-muted">
                <th className="px-3 py-2 text-start font-medium">מייל</th>
                <th className="px-3 py-2 text-start font-medium">נרשם בתאריך</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.uid} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 text-fg" dir="ltr">
                    {r.email}
                  </td>
                  <td className="px-3 py-2 text-fg-muted tabular-nums">
                    {formatDate(r.optInAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/* ── שליחת מייל שיווקי (הועבר מההגדרות) ─────────────────────────── */
function BroadcastCard({ onErr }: { onErr: (e: unknown) => void }) {
  const [bcSubject, setBcSubject] = useState('')
  const [bcHeading, setBcHeading] = useState('')
  const [bcContent, setBcContent] = useState('')
  const [bcBusy, setBcBusy] = useState(false)
  const [bcResult, setBcResult] = useState<{
    kind: 'idle' | 'dry' | 'done' | 'error'
    text: string
  }>({ kind: 'idle', text: '' })

  async function sendBroadcast(dryRun: boolean) {
    if (bcBusy) return
    setBcResult({ kind: 'idle', text: '' })
    if (!bcSubject.trim() || !bcHeading.trim() || !bcContent.trim()) {
      setBcResult({ kind: 'error', text: 'יש למלא subject + heading + תוכן HTML' })
      return
    }
    setBcBusy(true)
    try {
      const j = await adminApi<{
        recipientCount?: number
        sent?: number
        failed?: number
      }>('admin-send-marketing-email', {
        subject: bcSubject.trim(),
        heading: bcHeading.trim(),
        contentHtml: bcContent.trim(),
        dryRun,
      })
      if (dryRun) {
        setBcResult({
          kind: 'dry',
          text: `יש ${j.recipientCount ?? 0} משתמשים ברשימת התפוצה כרגע. לחץ "שלח לכולם" כדי לשלוח להם.`,
        })
      } else {
        setBcResult({
          kind: 'done',
          text: `הסתיים: ${j.sent ?? 0}/${j.recipientCount ?? 0} נשלחו, ${j.failed ?? 0} נכשלו.`,
        })
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === 'auth') return onErr(err)
      setBcResult({ kind: 'error', text: err.message || 'שליחה נכשלה' })
    } finally {
      setBcBusy(false)
    }
  }

  return (
    <Card title="שליחת מייל שיווקי">
      <p className="text-[11px] leading-relaxed text-fg-muted">
        נשלח רק למשתמשים שהסכימו לקבל תוכן שיווקי בהרשמה. כל מייל כולל אוטומטית
        קישור "להסרה מרשימת הדיוור" בתחתית.
      </p>
      <Input
        value={bcSubject}
        onChange={(e) => setBcSubject(e.target.value)}
        placeholder="נושא (Subject) — לדוגמה: 50% הנחה לסוף שבוע"
        disabled={bcBusy}
      />
      <Input
        value={bcHeading}
        onChange={(e) => setBcHeading(e.target.value)}
        placeholder="כותרת ראשית במייל (Heading)"
        disabled={bcBusy}
      />
      <textarea
        value={bcContent}
        onChange={(e) => setBcContent(e.target.value)}
        placeholder='<p style="font-size:14px;line-height:1.7;color:#d1d5db;">תוכן ההודעה כאן...</p>'
        rows={6}
        disabled={bcBusy}
        dir="ltr"
        className="block w-full rounded-lg border border-border bg-input/60 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
      {bcResult.kind !== 'idle' && (
        <div
          className={
            bcResult.kind === 'error'
              ? 'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive'
              : bcResult.kind === 'dry'
                ? 'rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent'
                : 'rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success'
          }
        >
          {bcResult.text}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={bcBusy}
          onClick={() => void sendBroadcast(true)}
          className="flex-1"
        >
          {bcBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          כמה משתמשים יש ברשימה?
        </Button>
        <Button
          variant="gradient"
          size="sm"
          disabled={bcBusy}
          onClick={() => {
            if (
              window.confirm(
                'לשלוח את המייל לכל המשתמשים ברשימת התפוצה? אי אפשר לבטל אחרי שליחה.',
              )
            ) {
              void sendBroadcast(false)
            }
          }}
          className="flex-1"
        >
          {bcBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          שלח לכולם
        </Button>
      </div>
    </Card>
  )
}
