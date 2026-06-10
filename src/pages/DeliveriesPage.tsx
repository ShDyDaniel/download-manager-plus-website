import { ProWorkspaceShell } from '../components/ProWorkspaceShell'
import { DeliveriesWorkspace } from '../components/DeliveriesWorkspace'

/**
 * Public /deliveries workspace — the editor side of "מסירה ללקוח"
 * exposed on the website. Lets a Pro user upload the final video(s),
 * pick an expiry, and get a /deliver/<token> link to send the client,
 * straight from the browser (no desktop app needed).
 *
 * Auth + Pro entitlement are handled by the shared <ProWorkspaceShell>
 * (the same ladder /revisions uses); this page only wires the
 * deliveries workspace into it. Unlike /revisions there's no Drive
 * OAuth step — deliveries always use our own R2 storage.
 */
export function DeliveriesPage() {
  return (
    <ProWorkspaceShell featureLabel="מסירה ללקוח">
      <DeliveriesWorkspace />
    </ProWorkspaceShell>
  )
}
