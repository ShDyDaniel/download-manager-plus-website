import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { LifeBuoy } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { ConsentPreview, SupportLanding } from '../components/SupportLanding'
import '../styles/pages/support.css'

/**
 * Live remote-support landing. The admin sends this to a user with a
 * misbehaving app. Opening it launches the desktop app via the dmplus://
 * deep link; the app then shows a consent window explaining exactly what
 * will be shared, and — only after the user approves — streams its log
 * files to the admin panel until either side stops.
 */
export default function SupportPage() {
  const { code = '' } = useParams()
  const cleanCode = useMemo(() => code.trim().toUpperCase(), [code])
  const [opened, setOpened] = useState(false)
  const [copied, setCopied] = useState(false)

  function openApp() {
    setOpened(true)
    window.location.href = `dmplus://support?code=${encodeURIComponent(cleanCode)}`
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
    <FlPage name="support" chrome="min" title="תמיכה מרחוק">
      <SupportLanding
        badge={<LifeBuoy className="ic" aria-hidden />}
        title="תמיכה מרחוק"
        body="לחיצה על הכפתור תפתח את התוכנה. בתוכנה יופיע חלון שמסביר בדיוק מה ישותף עם צוות התמיכה — ורק אחרי שתאשרו, החיבור יתחיל. תוכלו לעצור אותו בכל רגע."
        button="פתח את התוכנה"
        onOpen={openApp}
        opened={opened}
        hint={
          <>
            נפתח חלון "האם לפתוח את <bdi>Frameline</bdi>?". אשרו אותו, ואז אשרו את חלון התמיכה בתוכנה.
          </>
        }
        tail="והדביקו את הקוד:"
        code={cleanCode}
        copied={copied}
        onCopy={copyCode}
        extra={<ConsentPreview />}
      />
    </FlPage>
  )
}
