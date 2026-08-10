import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, Download, Trash2, Waves } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { buildZip, type ZipEntry } from '../../lib/zip'
import { Switch } from '@/components/ui/Switch'

/**
 * Audio-sync telemetry — opt-in data users upload after each sync, for
 * tuning the engine. Lives in R2 (per-sync events + gzipped acoustic
 * fingerprints + timeline structure), NOT Firestore. The server returns a
 * MANIFEST of every object's key + a 6-hour presigned URL; we fetch them
 * all and pack one ZIP.
 *
 * Extracted out of the old "לוגים" tab into "נתונים משותפים" — it's shared
 * user data, not an error log. Self-contained so it drops into a sub-tab.
 */
export default function SyncTelemetryPanel({
  onAuthExpired,
}: {
  onAuthExpired: () => void
}) {
  const [error, setError] = useState('')
  const [dl, setDl] = useState(false)
  const [clr, setClr] = useState(false)
  const [info, setInfo] = useState('')
  // Global ingestion pause — null until admin-get-app-config answers.
  const [paused, setPaused] = useState<boolean | null>(null)
  const [pausing, setPausing] = useState(false)

  function handleErr(e: unknown) {
    const err = e as { code?: string; message?: string }
    if (err.code === 'auth') return onAuthExpired()
    setError(err.message || 'שגיאה')
  }

  useEffect(() => {
    adminApi<{ syncTelemetryDisabled?: boolean }>('admin-get-app-config')
      .then((c) => setPaused(c.syncTelemetryDisabled === true))
      .catch(() => setPaused(null))
  }, [])

  async function togglePaused(next: boolean) {
    setPausing(true)
    setError('')
    try {
      await adminApi('admin-set-app-config', { syncTelemetryDisabled: next })
      setPaused(next)
    } catch (e) {
      handleErr(e)
    } finally {
      setPausing(false)
    }
  }

  async function download() {
    setDl(true)
    setError('')
    setInfo('')
    try {
      const r = await adminApi<{
        events: { key: string; url: string; size: number }[]
        fingerprints: { hash: string; url: string; size: number }[]
        timelines: { key: string; url: string; size: number }[]
        count: number
        fingerprintCount: number
        timelineCount: number
        truncated: boolean
        urlTtlSeconds: number
        exportedAt: string
      }>('admin-sync-telemetry-export', {})

      // Pull every object straight from R2 (CORS allows GET from the site
      // origin) and pack ONE zip: events/ + timelines/ (gunzipped back to
      // readable .xml) + fingerprints/ (kept .bin.gz) + the manifest.
      const canGunzip = typeof DecompressionStream !== 'undefined'
      const jobs = [
        ...r.events.map((e) => ({
          url: e.url,
          path: e.key.replace(/^sync-telemetry\//, ''),
          gunzip: false,
        })),
        ...r.timelines.map((t) => {
          const base = t.key
            .replace(/^sync-telemetry\/timelines\//, '')
            .replace(/\.gz$/, '')
          return canGunzip
            ? { url: t.url, path: `timelines/${base}`, gunzip: true }
            : { url: t.url, path: `timelines/${base}.gz`, gunzip: false }
        }),
        ...r.fingerprints.map((f) => ({
          url: f.url,
          path: `fingerprints/${f.hash}.bin.gz`,
          gunzip: false,
        })),
      ]

      const entries: ZipEntry[] = []
      let done = 0
      let skipped = 0
      const queue = [...jobs]
      // 4 parallel fetches — fingerprint blobs can be several MB each.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (;;) {
            const job = queue.shift()
            if (!job) return
            try {
              const resp = await fetch(job.url)
              if (!resp.ok) throw new Error(String(resp.status))
              let data: Uint8Array
              if (job.gunzip && resp.body) {
                const ds = resp.body.pipeThrough(new DecompressionStream('gzip'))
                data = new Uint8Array(await new Response(ds).arrayBuffer())
              } else {
                data = new Uint8Array(await resp.arrayBuffer())
              }
              entries.push({ name: job.path, data })
            } catch {
              // Object vanished (reset mid-export) or mid-upload — skip.
              skipped += 1
            }
            done += 1
            setInfo(`מוריד ${done}/${jobs.length} קבצים…`)
          }
        }),
      )
      entries.sort((a, b) => a.name.localeCompare(b.name))
      entries.push({
        name: 'manifest.json',
        data: new TextEncoder().encode(JSON.stringify(r, null, 2)),
      })

      const blob = buildZip(entries)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dmplus-sync-telemetry-${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setInfo(
        `${r.count} סנכרונים · ${r.fingerprintCount} טביעות אצבע · ${r.timelineCount ?? 0} קבצי טיימליין · ירדו כקובץ ZIP אחד` +
          (skipped ? ` (${skipped} קבצים דולגו, ייתכן שהעלאה רצה ברקע)` : ''),
      )
    } catch (e) {
      handleErr(e)
    } finally {
      setDl(false)
    }
  }

  const clear = async () => {
    if (
      !window.confirm(
        'לאפס את כל נתוני הסנכרון שנאספו? כל האירועים, טביעות האצבע וקבצי הטיימליין יימחקו לצמיתות מהאחסון.',
      )
    )
      return
    setClr(true)
    setError('')
    setInfo('')
    try {
      const r = await adminApi<{ deleted: number }>('admin-sync-telemetry-clear', {})
      setInfo(`נמחקו ${r.deleted} קבצים. המערכת נקייה ומוכנה לאיסוף חדש`)
    } catch (e) {
      handleErr(e)
    } finally {
      setClr(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] px-5 py-4">
        <Waves className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">נתוני סנכרון אוטומטי</div>
          <div className="text-xs text-fg-muted">
            נתונים אנונימיים שמשתמשים שאישרו שולחים בסוף כל סנכרון. כל מועמד
            והציונים שלו, ההקשר, טביעות האצבע האקוסטיות, ומבנה הטיימליין של
            הקלט והפלט (מעוקר, ללא מדיה או שמות קבצים). ההורדה היא קובץ ZIP
            אחד עם כל הקבצים מסודרים בתיקיות.
          </div>
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2">
            <Switch
              checked={paused === true}
              onCheckedChange={(v) => togglePaused(v)}
              disabled={paused === null || pausing}
            />
            <span
              className={
                'text-xs ' +
                (paused ? 'font-medium text-rose-400' : 'text-fg-muted')
              }
            >
              {paused
                ? 'קליטת נתונים מושבתת · משתמשים לא מעלים שום דבר חדש'
                : 'השבתת קליטה · עצירת כל ההעלאות מהמשתמשים'}
            </span>
          </label>
          {info && (
            <div className="mt-1 text-xs font-medium text-primary">{info}</div>
          )}
        </div>
        <button
          type="button"
          onClick={download}
          disabled={dl}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {dl ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {dl ? 'מוריד…' : 'הורדת הכל (ZIP)'}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={clr}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-400 transition-colors hover:bg-rose-500/20 disabled:opacity-60"
        >
          {clr ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {clr ? 'מוחק…' : 'איפוס כל הנתונים'}
        </button>
      </div>
    </div>
  )
}
