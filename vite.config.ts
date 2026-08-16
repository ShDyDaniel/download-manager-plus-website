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
  build: {
    rollupOptions: {
      output: {
        // Pin the big, rarely-changing framework libs into their own
        // stable-hashed chunk. App code changes on nearly every deploy,
        // which re-hashes whatever chunk it lives in and forces a
        // re-download; keeping React + Router + framer-motion in a
        // separate `vendor` chunk means a returning visitor keeps the
        // cached copy across deploys that only touched app code.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/react-router') ||
              id.includes('/scheduler/') ||
              id.includes('/framer-motion/') ||
              id.includes('/motion-dom/') ||
              id.includes('/motion-utils/')
            ) {
              return 'vendor'
            }
          }
        },
      },
    },
  },
})
