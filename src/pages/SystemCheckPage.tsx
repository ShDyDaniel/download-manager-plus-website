import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { LifeBuoy } from 'lucide-react'
import { FlPage } from '../components/site/FlPage'
import { SupportLanding } from '../components/SupportLanding'
import '../styles/pages/support.css'

/**
 * Support system-check landing. Support sends this link to a user whose
 * app misbehaves. Opening it launches the desktop app via the dmplus://
 * deep link; the app then runs a full component diagnostic and reports
 * the results straight to the admin panel — the user only confirms once.
 * Results appear only in the admin panel, never here.
 */
export default function SystemCheckPage() {
  const { code = '' } = useParams()
  const cleanCode = useMemo(() => code.trim().toUpperCase(), [code])
  const [opened, setOpened] = useState(false)
  const [copied, setCopied] = useState(false)

  function openApp() {
    setOpened(true)
    window.location.href = `dmplus://system-check?code=${encodeURIComponent(
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
    <FlPage name="system-check" chrome="min" title="בדיקת מערכת לתמיכה">
      <SupportLanding
        badge={<LifeBuoy className="ic" aria-hidden />}
        title="בדיקת מערכת לתמיכה"
        body="לחיצה על הכפתור תפתח את התוכנה ותריץ בדיקה אוטומטית של כל הרכיבים. כל מה שצריך זה לאשר. התוצאות נשלחות ישירות לצוות התמיכה."
        button="פתח את התוכנה והרץ בדיקה"
        onOpen={openApp}
        opened={opened}
        hint={
          <>
            נפתח חלון "האם לפתוח את <bdi>Frameline</bdi>?". אשרו אותו. בתוכנה תופיע בקשה קצרה לאישור, ואז
            פס-התקדמות של הבדיקה.
          </>
        }
        tail="והדביקו את הקוד:"
        code={cleanCode}
        copied={copied}
        onCopy={copyCode}
      />
    </FlPage>
  )
}
