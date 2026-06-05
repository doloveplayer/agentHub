/** @type {import('tailwindcss').Config} */
/*
 * Light theme (DeerFlow-inspired). Add class="dark" to <html> for dark mode.
 * Colors use OKLCH with <alpha-value> for opacity modifier support.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* Background layers — light */
        'hub-root':          'oklch(0.97 0.005 95 / <alpha-value>)',
        'hub-sidebar':       'oklch(0.945 0.005 95 / <alpha-value>)',
        'hub-surface':       'oklch(1 0 0 / <alpha-value>)',
        'hub-raised':        'oklch(1 0 0 / <alpha-value>)',
        'hub-hover':         'oklch(0.95 0.005 95 / <alpha-value>)',
        'hub-active':        'oklch(0.90 0.04 185 / <alpha-value>)',
        'hub-input':         'oklch(0.96 0.005 95 / <alpha-value>)',
        'hub-code':          'oklch(0.97 0.005 95 / <alpha-value>)',

        /* Borders — light */
        'hub-border':        'oklch(0 0 0 / <alpha-value>)',
        'hub-border-2':      'oklch(0 0 0 / <alpha-value>)',

        /* Accent — light */
        'hub-accent':        'oklch(0.50 0.12 185 / <alpha-value>)',
        'hub-accent-hover':  'oklch(0.43 0.12 185 / <alpha-value>)',
        'hub-warning':       'oklch(0.65 0.18 80 / <alpha-value>)',
        'hub-danger':        'oklch(0.50 0.22 25 / <alpha-value>)',
        'hub-success':       'oklch(0.50 0.18 150 / <alpha-value>)',
        'hub-link':          'oklch(0.50 0.15 245 / <alpha-value>)',
        'hub-info':          'oklch(0.50 0.20 280 / <alpha-value>)',

        /* Text — light */
        'hub-primary':       'oklch(0.15 0 0 / <alpha-value>)',
        'hub-secondary':     'oklch(0.35 0.005 250 / <alpha-value>)',
        'hub-tertiary':      'oklch(0.50 0.005 250 / <alpha-value>)',
        'hub-muted':         'oklch(0.65 0.005 250 / <alpha-value>)',

        /* Agent identity colors */
        'agent-code':        'oklch(0.50 0.22 280 / <alpha-value>)',
        'agent-review':      'oklch(0.50 0.18 145 / <alpha-value>)',
        'agent-devops':      'oklch(0.50 0.20 40 / <alpha-value>)',
        'agent-planner':     'oklch(0.55 0.12 185 / <alpha-value>)',
        'agent-test':        'oklch(0.50 0.15 250 / <alpha-value>)',
        'agent-security':    'oklch(0.55 0.18 85 / <alpha-value>)',
      },
      borderColor: {
        'hub': 'oklch(0 0 0 / 8%)',
      },
      borderRadius: {
        'hub-sm':  '4px',
        'hub-md':  '6px',
        'hub-lg':  '8px',
        'hub-xl':  '12px',
        'hub-2xl': '16px',
      },
      transitionDuration: {
        'hub-fast': '120ms',
        'hub':      '180ms',
        'hub-slow': '250ms',
      },
      fontSize: {
        'caption':  ['0.75rem',   { lineHeight: '1rem',    fontWeight: '400' }],
        'footnote': ['0.688rem',  { lineHeight: '1rem',    fontWeight: '400' }],
        'body':     ['0.8125rem', { lineHeight: '1.25rem', fontWeight: '400' }],
      },
    },
  },
  plugins: [],
};
