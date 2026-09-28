import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { MonitorSmartphone } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { SupportLanding } from '../components/SupportLanding'
import '../styles/pages/support.css'

/**
 * Support device-check landing. A user who can't get a free trial (because
 * an OLD account on the same machine already used one) gets this link from
 * support. Two ways to report the machine's signature:
 *   1. Click "open the app" → the dmplus:// deep link launches the desktop
 *      app, which reports the device signature automatically.
 *   2. Backup — copy the code and paste it into the app's
 *      Settings → "תמיכה" → "הזנת קוד תמיכה".
 * The matched account shows up only in the admin panel, never here.
 */
export default function DeviceCheckPage() {
  const { code = '' } = useParams()
  const cleanCode = useMemo(() => code.trim().toUpperCase(), [code])
  const [opened, setOpened] = useState(false)
  const [copied, setCopied] = useState(false)

  function openApp() {
    setOpened(true)
    // Trigger the custom-protocol deep link. The OS asks the user to
    // confirm opening the desktop app; if it's not installed nothing
    // happens and they fall back to the manual code below.
    window.location.href = `dmplus://device-check?code=${encodeURIComponent(
      cleanCode,
    )}`
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(cleanCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked — the code is visible anyway */
    }
  }

  return (
    <FlPage name="device-check" chrome="min" title="אימות לתמיכה">
      <SupportLanding
        badge={<MonitorSmartphone className="ic" aria-hidden />}
        title="אימות לתמיכה"
        body="חתימת המחשב תישלח למערכת כדי לבדוק אם נפתח חשבון על המחשב הזה בעבר."
        button="פתח את התוכנה ושלח אוטומטית"
        onOpen={openApp}
        opened={opened}
        hint={
          <>
            נפתח חלון "האם לפתוח את <bdi>Frameline</bdi>?". אשרו אותו כדי לשלוח. אפשר לסגור את הדף הזה לאחר מכן.
          </>
        }
        tail="והדביקו את הקוד הבא:"
        code={cleanCode}
        copied={copied}
        onCopy={copyCode}
      />
    </FlPage>
  )
}
