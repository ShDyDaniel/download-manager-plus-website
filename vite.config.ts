import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base` matters when deploying under a sub-path on GitHub Pages
// (e.g. https://shdydaniel.github.io/download-manager-plus-website/).
// If you switch to a custom domain or root deployment, change to '/'.
export default defineConfig({
  plugins: [react()],
  base: './',
})
