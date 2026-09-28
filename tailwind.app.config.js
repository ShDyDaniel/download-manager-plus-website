/** @type {import('tailwindcss').Config} */
/**
 * The DESKTOP APP's Tailwind theme, for the web workspaces that must look
 * exactly like the app (/revisions, /deliveries).
 *
 * Built separately from the site's theme (src/styles/app-ui.css pulls it in
 * with `@config`), and scoped: every utility is emitted as `.app-ui .x`, so it
 * only applies inside an element with class `app-ui` — and wins over the
 * site's same-named utilities there. Colours read their own `--app-*`
 * variables (defined in app-ui.css, same values as the app's index.css), so
 * nothing outside `.app-ui` changes.
 *
 * Keep in sync with the desktop repo's tailwind.config.ts / src/index.css.
 */
export default {
  important: '.app-ui',
  corePlugins: { preflight: false },
  content: [
    './src/components/RevisionsWorkspace.tsx',
    './src/components/DeliveriesWorkspace.tsx',
    './src/components/workspace/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Rubik', 'Heebo', 'system-ui', 'sans-serif'],
        display: ['Rubik', 'Heebo', 'system-ui', 'sans-serif'],
      },
      colors: {
        border: 'hsl(var(--app-border))',
        input: 'hsl(var(--app-input))',
        ring: 'hsl(var(--app-ring))',
        background: 'hsl(var(--app-background))',
        foreground: 'hsl(var(--app-foreground))',
        primary: { DEFAULT: 'hsl(var(--app-primary))', foreground: 'hsl(var(--app-primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--app-secondary))', foreground: 'hsl(var(--app-secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--app-destructive))', foreground: 'hsl(var(--app-destructive-foreground))' },
        success: { DEFAULT: 'hsl(var(--app-success))', foreground: 'hsl(var(--app-success-foreground))' },
        popover: { DEFAULT: 'hsl(var(--app-popover))', foreground: 'hsl(var(--app-popover-foreground))' },
        muted: { DEFAULT: 'hsl(var(--app-muted))', foreground: 'hsl(var(--app-muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--app-accent))', foreground: 'hsl(var(--app-accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--app-card))', foreground: 'hsl(var(--app-card-foreground))' },
      },
      borderRadius: {
        lg: 'var(--app-radius)',
        md: 'calc(var(--app-radius) - 2px)',
        sm: 'calc(var(--app-radius) - 4px)',
      },
      keyframes: {
        eqbar: { '0%, 100%': { transform: 'scaleY(0.32)' }, '50%': { transform: 'scaleY(1)' } },
      },
      animation: { eqbar: 'eqbar 0.9s ease-in-out infinite' },
    },
  },
  plugins: [],
}
