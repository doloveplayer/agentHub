# AgentHub — Apple Design System

> Status: Implemented · Date: 2026-05-22

## Key Decisions

1. **Apple Human Interface Guidelines** as visual direction: frosted glass materials, SF Pro font stack, spring animations, soft shadows instead of hard borders.
2. **Accent color shift**: from `#6c47ff` (purple) to `#007AFF` (Apple Blue). More professional, less "AI-generic".
3. **Zero dependency change**: no new UI libraries added. All effects achieved through Tailwind tokens + CSS custom properties + SVG noise texture.
4. **Font strategy**: removed Google Fonts Inter import. Primary stack uses `-apple-system` / `SF Pro Display`. Monospace uses `SF Mono` on macOS, falls back to Menlo/Monaco/Consolas.

## Design Tokens

### Colors (`tailwind.config.js`)

```
accent:
  DEFAULT:  #007AFF        (focus rings, active indicators, links)
  hover:    #0066D6        (button hover)
  pressed:  #0052AF        (button active)
  subtle:   rgba(0,122,255,0.15)

surface:
  root:     #000000        (body background)
  elevated: rgba(28,28,30,0.70)   (sidebars, panels)
  card:     rgba(44,44,46,0.60)   (cards, bubbles)
  field:    rgba(58,58,60,0.50)   (inputs)
  hover:    rgba(255,255,255,0.06) (hover highlight)

semantic:
  green:    #30D158        (success, running, confirm)
  red:      #FF453A        (error, stop, delete)
  orange:   #FF9F0A        (warning, permission, devops agent)
  teal:     #64D2FF        (info, subagent)

agent:
  code:     #5E5CE6        (purple-indigo, Xcode-style)
  review:   #30D158        (green)
  devops:   #FF9F0A        (orange)
```

### Typography

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `caption` | 11px / 1.3 | 400 | Timestamps, badges |
| `footnote` | 12px / 1.4 | 400 | Labels, metadata |
| `body` | 14px / 1.5 | 400 | Message content, body text |
| `headline` | 16px / 1.3 | 600 | Session titles, panel headers |
| `title` | 20px / 1.25 | 600 | Page titles |

Font stacks:
- **Sans**: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif`
- **Mono**: `'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace`

### Border Radius

| Token | Value | Use |
|-------|-------|-----|
| `sm` | 8px | Tags, badges, small buttons |
| `md` | 10px | Inputs, card elements |
| `lg` | 16px | Panels, cards, bubbles |
| `xl` | 20px | Popovers, dialogs |

### Shadows

```
elevation-low:  0 1px 3px rgba(0,0,0,0.5) + 0.5px inset white 4%
elevation-mid:  0 4px 12px rgba(0,0,0,0.5) + 0.5px inset white 6%
elevation-high: 0 8px 24px rgba(0,0,0,0.6) + 0.5px inset white 8%
inner-glow:     inset 0 1px 0 rgba(255,255,255,0.06)
```

### Transition Curves

```
spring-in:  cubic-bezier(0.16, 1, 0.3, 1)   (enter, expand)
spring-out: cubic-bezier(0.5, 0, 0.75, 0)    (exit, collapse)
duration:   200ms (default), 300ms (expand), 250ms (message enter)
```

## CSS Utility Classes (`index.css`)

| Class | Purpose |
|-------|---------|
| `.apple-card` | Semi-transparent card with elevation-low shadow, `rounded-lg` |
| `.apple-panel` | Frosted glass panel: `rgba(28,28,30,0.70)` + `backdrop-blur(40px)` |
| `.chat-scroll` | 6px scrollbar, white 12% thumb, transparent track |
| `.panel-scroll` | 4px scrollbar, white 10% thumb |
| `.agent-pulse` | Green glow pulse (2s, spring-in) for running agent indicator |
| `.streaming-cursor` | Step-end blink (1s) for streaming text indicator |
| `.message-enter` | Fade-up (translateY 12px → 0, opacity 0→1) for new messages |
| `.animate-fade-up` | Fade-up (translateY 24px → 0) for login page hero |
| `.animate-fade-up-delay-{1,2}` | Same with 100ms/200ms stagger |
| `.bg-noise` | Fixed SVG noise overlay at 3% opacity |

## Component Visual Patterns

### Message Bubble
- **Human**: `bg-accent text-white rounded-lg rounded-br-sm` — right-aligned, blue fill
- **Agent**: `apple-card text-white/85 rounded-lg rounded-bl-sm` — left-aligned, frosted glass
- **Avatar**: `rounded-lg`, human accent blue background, agent color-coded
- **Streaming**: 3 animated dots with staggered opacity

### Sidebars (SessionList, AgentStatusPanel)
- `apple-panel` class: frosted glass background + 40px blur
- Separator: `border-white/[0.06]` (subtle hairlines instead of hard borders)
- Active indicator: `border-l-[3px] border-l-accent` (left border accent)
- Hover: `bg-white/[0.04]` with spring transition

### Popups (Mention, Slash Command, Create Session)
- `apple-card shadow-elevation-high` (strongest depth)
- No border — separation via shadow alone
- Selected item: `bg-white/[0.08]`

### Cards (AgentCard, TaskCard, ConfirmationPanel)
- `apple-card` base, `shadow-elevation-low`
- Header separator: `border-b border-white/[0.06]`
- Confirmation panel: additional `border border-[#FF9F0A]/20` (orange warn tint)

### Buttons
- **Primary/CTA**: `bg-accent hover:bg-accent-hover active:scale-[0.97]` (Apple press)
- **Confirm**: `bg-[#30D158]` (Apple Green)
- **Danger/Stop**: `bg-[#FF453A]` or `hover:bg-[#FF453A]/15 text-[#FF453A]` (Apple Red)
- **Warning/Pause**: `bg-[#FF9F0A]` (Apple Orange)
- **Cancel/Neutral**: `bg-white/[0.06] hover:bg-white/[0.10]`

### Text Hierarchy
- Primary content: `text-white/85` or `text-white/90`
- Secondary: `text-white/50` or `text-white/45`
- Tertiary/metadata: `text-white/30` or `text-white/25`
- Disabled/empty: `text-white/15` or `text-white/20`

## Component → Token Mapping

| Component | Surface | Shadow | Border |
|-----------|---------|--------|--------|
| SessionList | apple-panel | elevation-low | border-r white/6% |
| AgentStatusPanel | apple-panel | elevation-low | border-l white/6% |
| ChatView (empty) | bg-black | - | - |
| MessageBubble (agent) | apple-card | elevation-low | - |
| MessageBubble (human) | bg-accent | - | - |
| MessageInput textarea | bg white/6% | - | focus:ring-accent |
| AgentCard | apple-card | elevation-low | - |
| TaskCard | apple-card | elevation-low | - |
| ConfirmationPanel | apple-card | elevation-low | orange warn tint |
| MentionPopup | apple-card | elevation-high | - |
| SlashCommandPopup | apple-card | elevation-high | - |
| Create dropdown | apple-card | elevation-high | - |
| Event row (collapsed) | bg white/3% | - | border white/6% |
| Permission card | apple-card | - | orange warn tint |

## Agent Event Color Coding

| Event Type | Text Color | Background |
|------------|-----------|------------|
| thinking | `text-white/35 italic` | `bg-white/[0.02]` |
| tool_use | `text-[#5E5CE6]` | `bg-[#5E5CE6]/8` |
| tool_result | `text-[#30D158]` | `bg-[#30D158]/8` |
| subagent_start | `text-[#64D2FF]` | `bg-[#64D2FF]/8` |
| subagent_result | `text-[#30D158]/80` | `bg-[#30D158]/6` |
| permission_request | `text-[#FF9F0A]` | `bg-[#FF9F0A]/8` |

## TaskDAG Node Status

| Status | Background | Border | Text |
|--------|-----------|--------|------|
| waiting | `#1C1C1E` | `#48484A` | `#98989D` |
| running | `#002251` | `#007AFF` | `#81B9FF` |
| done | `#002A1A` | `#30D158` | `#7EEDB0` |
| failed | `#2D0A0A` | `#FF453A` | `#FF8880` |

Edge stroke: `rgba(255,255,255,0.10)`, progress bar: `#007AFF`.

## Files Modified

```
apps/web/tailwind.config.js       — extended theme (colors, fonts, radii, shadows, easing)
apps/web/src/index.css            — CSS variables, material classes, animations, noise
apps/web/index.html               — body class (bg-black, bg-noise)
apps/web/src/pages/ChatPage.tsx   — root layout
apps/web/src/components/*.tsx     — 15 components updated (see summary below)
```

All 15 components:
`LoginPage`, `AuthCallback`, `SessionList`, `ChatView`, `MessageBubble`, `MessageInput`,
`AgentStatusPanel`, `AgentCard`, `AgentMentionPopup`, `SlashCommandPopup`, `FileTree`,
`TaskCard`, `TaskDAG`, `ConfirmationPanel`, `ChatPage`

## Verification

- [x] TypeScript compilation passes (`npx tsc --noEmit -p apps/web/tsconfig.json`)
- [x] No functional logic changed (props, state, events, API calls untouched)
- [x] No new dependencies added
- [ ] Visual QA: run `cd apps/web && npx vite` to verify
