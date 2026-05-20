/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /* Font families — Rubik is the single typeface for both
       * Hebrew and Latin. `font-display` and `font-sans` both
       * resolve to Rubik; the distinction lives in weight (500
       * for display, 400 for body) rather than face. Inter stays
       * available for the small uppercase editorial labels where
       * its tabular figures and narrow proportions help. */
      fontFamily: {
        sans: ['Rubik', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Rubik', 'system-ui', '-apple-system', 'sans-serif'],
        label: ['Inter', 'Rubik', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      /* Color tokens mapped to the CSS variables in index.css.
       * Single source of truth — change the var, change the theme. */
      colors: {
        bg: {
          DEFAULT: 'var(--bg)',
          elevated: 'var(--bg-elevated)',
          card: 'var(--bg-card)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          secondary: 'var(--fg-secondary)',
          muted: 'var(--fg-muted)',
          faint: 'var(--fg-faint)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          soft: 'var(--primary-soft)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          glow: 'var(--accent-glow)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        success: 'var(--success)',
        destructive: 'var(--destructive)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      boxShadow: {
        DEFAULT: 'var(--shadow)',
        sm: 'var(--shadow-sm)',
        lg: 'var(--shadow-lg)',
        glow: 'var(--shadow-glow)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
      },
      /* Type scale — restrained, editorial. Mobile-friendly bottom
       * (14px) up to display-massive at the top. Wide gaps so size
       * carries hierarchy on its own. */
      fontSize: {
        xs: ['12px', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        sm: ['14px', { lineHeight: '1.55' }],
        base: ['16px', { lineHeight: '1.65' }],
        lg: ['18px', { lineHeight: '1.6' }],
        xl: ['22px', { lineHeight: '1.4' }],
        '2xl': ['28px', { lineHeight: '1.25' }],
        '3xl': ['36px', { lineHeight: '1.15' }],
        '4xl': ['48px', { lineHeight: '1.1', letterSpacing: '-0.01em' }],
        '5xl': ['64px', { lineHeight: '1.05', letterSpacing: '-0.015em' }],
        '6xl': ['80px', { lineHeight: '1.0', letterSpacing: '-0.02em' }],
        '7xl': ['104px', { lineHeight: '0.98', letterSpacing: '-0.025em' }],
      },
    },
  },
  plugins: [],
}
