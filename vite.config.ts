import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// `base: '/'` is required for nested-path routes like /review/<token>
// to resolve /assets/* correctly. With the old relative base ('./'),
// the browser resolves './assets/index-xxx.js' against the current
// URL — so /review/abc looked for /review/assets/index-xxx.js, which
// 404s and triggers Vercel's SPA fallback returning index.html. The
// <script type="module"> tag then receives HTML for a JS module and
// the page renders blank with the MIME-type console error. Absolute
// base avoids that entirely. Deploys on Vercel always live at the
// domain root, never a sub-path.
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
