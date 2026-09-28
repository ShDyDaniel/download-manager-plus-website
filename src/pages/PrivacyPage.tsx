import '../styles/pages/privacy.css'
import { LegalDocPage } from '../components/LegalDocPage'

/** /privacy — the live Privacy Policy (edited in the admin panel). */
export default function PrivacyPage() {
  return (
    <LegalDocPage
      kind="privacy"
      pageTitle="מדיניות פרטיות"
      heading="מדיניות פרטיות"
      prefix="pr"
      emptyCopy="המדיניות טרם פורסמה."
      others={[
        { to: '/terms', label: 'תנאי שימוש' },
        { to: '/accessibility', label: 'הצהרת נגישות' },
      ]}
    />
  )
}
