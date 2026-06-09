# Design: Group Chat Skill Invocation UX

## Problem

In group chat sessions, the "/" popup merges all skills from all session agents into a flat list without showing which agent owns each skill. When a user selects a skill without @mentioning an agent, the message goes to the default agent (usually Planner), which doesn't have the skill — causing silent failure with no user feedback.

## Approach C: Frontend Auto-Tag + Smart Matching

Frontend-only changes. Backend already has `agentHasSkill` checks in `chatHandlers.ts:343-352`.

---

## 1. Data Structure Changes

### `MessageInput.tsx` — `agentSkills` type

```typescript
// Before
const agentSkills: { name: string; description: string }[]

// After
interface AgentSkillEntry {
  name: string;
  description: string;
  agentId: string;
  agentDisplayName: string;
}
const agentSkills: AgentSkillEntry[]
```

Build logic unchanged (iterate session agents' skills), but each entry now carries owner info.

### `SlashCommandPopup.tsx` — `SkillItem` interface

Extend with `agentDisplayName?: string` for inline display.

---

## 2. "/" Popup Display

- Built-in commands (`/plan`, `/review`, etc.) — no owner annotation
- Agent skills — format: `/skill-name` + right-aligned gray text `AgentName`
- Same skill owned by multiple agents — each appears as a separate line with different agent annotation
- Arrow key navigation — focused item auto-scrolls into view via `scrollIntoView({ block: 'nearest' })`

Visual example:
```
📋  /plan          Create a task plan
🔍  /review        Request a code review
🔧  /code-review   code review     CodeAgent
🔧  /code-review   code review     TestAgent
```

Filter logic unchanged — prefix match on name.

---

## 3. Auto-Tag on Skill Selection

### `handleSelectCommand` in `MessageInput.tsx`

1. Look up skill owners from `agentSkills`
2. **Single owner** — auto-add agent to `tags` (if not already present). Do NOT insert `@AgentName` into textarea text; only show in tag bar above.
3. **Multiple owners** — show agent selection popup (reuse `AgentMentionPopup` component). User picks one; selected agent added to tags.
4. Update `slashQuery` state to track which skill was selected for later disambiguation.

### `handleSend` fallback

If `skillInvocation` is set but `tags` is empty:
- Look up skill owners from `agentSkills`
- Single match → auto-add to mentions
- Multiple matches → toast "请 @指定 agent" (shouldn't happen if step 3 handled correctly)

---

## 4. Edge Cases

| Scenario | Behavior |
|----------|----------|
| User @Agent A but selects Agent B's skill | Send to A. Backend's `agentHasSkill` check skips injection. Frontend shows toast: "Agent A 没有 skill-name，已忽略" |
| User removes auto-added tag | Respect user action. `skillInvocation` still sent; backend naturally skips non-matching agent |
| Solo mode `/skill` | Unchanged. Single agent, no ambiguity |
| No agents have skills | "/" popup shows only built-in commands |
| `/skill` doesn't match any agent skill | Tries built-in commands; if no match either, treated as plain text |

---

## Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/MessageInput.tsx` | `agentSkills` type, `handleSelectCommand` auto-tag, `handleSend` fallback, toast for mismatch |
| `apps/web/src/components/SlashCommandPopup.tsx` | `SkillItem` interface, inline agent name display, scroll-into-view |

No backend changes required.
