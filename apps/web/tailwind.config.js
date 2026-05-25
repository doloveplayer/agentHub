/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'hub-root':          'var(--bg-root)',
        'hub-surface':       'var(--bg-surface)',
        'hub-raised':        'var(--bg-raised)',
        'hub-hover':         'var(--bg-hover)',
        'hub-active':        'var(--bg-active)',
        'hub-input':         'var(--bg-input)',
        'hub-code':          'var(--bg-code)',
        'hub-border':        'var(--border-subtle)',
        'hub-border-2':      'var(--border-default)',
        'hub-accent':        'var(--accent-primary)',
        'hub-accent-hover':  'var(--accent-hover)',
        'hub-warning':       'var(--accent-warning)',
        'hub-danger':        'var(--accent-danger)',
        'hub-success':       'var(--accent-success)',
        'hub-link':          'var(--accent-link)',
        'agent-code':        'var(--agent-code)',
        'agent-review':      'var(--agent-review)',
        'agent-devops':      'var(--agent-devops)',
        'agent-planner':     'var(--agent-planner)',
        'agent-test':        'var(--agent-test)',
        'agent-security':    'var(--agent-security)',
      },
      textColor: {
        'hub-primary':   'var(--text-primary)',
        'hub-secondary': 'var(--text-secondary)',
        'hub-tertiary':  'var(--text-tertiary)',
        'hub-muted':     'var(--text-muted)',
      },
      borderColor: {
        'hub': 'var(--border-subtle)',
      },
      borderRadius: {
        'hub-sm':  'var(--radius-sm)',
        'hub-md':  'var(--radius-md)',
        'hub-lg':  'var(--radius-lg)',
        'hub-xl':  'var(--radius-xl)',
        'hub-2xl': 'var(--radius-2xl)',
      },
      transitionDuration: {
        'hub-fast': '120ms',
        'hub':      '180ms',
        'hub-slow': '250ms',
      },
    },
  },
  plugins: [],
};
