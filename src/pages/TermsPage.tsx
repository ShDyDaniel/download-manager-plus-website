import '../styles/pages/terms.css'
import { LegalDocPage } from '../components/LegalDocPage'

/** /terms — the live Terms of Use (edited in the admin panel). */
export default function TermsPage() {
  return (
    <LegalDocPage
      kind="terms"
      pageTitle="תנאי שימוש"
      heading="תנאי השימוש"
      prefix="t"
      emptyCopy="התנאים טרם פורסמו."
      others={[
        { to: '/privacy', label: 'מדיניות פרטיות' },
        { to: '/accessibility', label: 'הצהרת נגישות' },
      ]}
    />
  )
}
