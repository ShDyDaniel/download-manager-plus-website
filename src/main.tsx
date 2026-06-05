import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './fonts.css'
import './index.css'
import { captureRefFromUrl } from './lib/referral'

// Capture a partner referral (?ref=<code>) as early as possible so it
// survives to signup even if the visitor browses around first.
captureRefFromUrl()

// BrowserRouter wraps the whole app so any descendant can use
// react-router primitives (`<Link>`, `useNavigate`, etc.). Vercel's
// `vercel.json` rewrites every non-/api path to `/index.html`, so
// deep links like `/buy` work even when the user lands there
// directly (no 404 on refresh).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
