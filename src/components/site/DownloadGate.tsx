import { createContext, useCallback, useContext, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSession } from '../../lib/webSession'
import { DownloadAuthModal } from '../DownloadAuthModal'

/**
 * One "הורדה חינם" flow for the whole site (header, home, pricing, feature pages).
 *
 * Same rules as the old Hero buttons:
 *  - a website account is required first, so a partner referral (?ref=…) always
 *    binds to a real account;
 *  - signed in → straight to /install; otherwise the auth modal opens and the
 *    download resumes on success;
 *  - never download from JS here (Chrome flags programmatic cross-origin
 *    downloads) — /install resolves the LATEST release for the platform and
 *    starts it. The platform is optional: without it /install detects the OS.
 */
type Platform = 'mac' | 'win'
type Ctx = { requestDownload: (platform?: Platform) => void }

const DownloadCtx = createContext<Ctx>({ requestDownload: () => {} })

export function DownloadGateProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [authOpen, setAuthOpen] = useState(false)
  const [pending, setPending] = useState<Platform | undefined>(undefined)

  const goToInstall = useCallback(
    (platform?: Platform) => navigate('/install', platform ? { state: { platform } } : undefined),
    [navigate],
  )

  const requestDownload = useCallback(
    (platform?: Platform) => {
      if (getSession()) {
        goToInstall(platform)
      } else {
        setPending(platform)
        setAuthOpen(true)
      }
    },
    [goToInstall],
  )

  return (
    <DownloadCtx.Provider value={{ requestDownload }}>
      {children}
      <DownloadAuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthed={() => {
          setAuthOpen(false)
          goToInstall(pending)
          setPending(undefined)
        }}
      />
    </DownloadCtx.Provider>
  )
}

export function useDownload() {
  return useContext(DownloadCtx)
}
