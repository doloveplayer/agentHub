# Skill Invocation UX Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In group chat, show which agent owns each skill in the "/" popup, and auto-tag the owning agent when a skill is selected.

**Architecture:** Frontend-only changes to `MessageInput.tsx` and `SlashCommandPopup.tsx`. Backend's existing `agentHasSkill` check handles injection filtering.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind

---

### Task 1: Extend `agentSkills` data structure

**Files:**
- Modify: `apps/web/src/components/MessageInput.tsx:58-75`

- [ ] **Step 1: Update `agentSkills` useMemo to include agent info**

Replace the `agentSkills` useMemo block (lines 58-75) with:

```typescript
const agentSkills = useMemo(() => {
  if (!activeSessionId) return [];
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return [];
  const agentIds = new Set((session.agents || []).map(sa => sa.agentId));
  const seen = new Set<string>();
  const result: { name: string; description: string; agentId: string; agentDisplayName: string }[] = [];
  for (const a of agents) {
    if (!agentIds.has(a.id)) continue;
    for (const s of (a.skills || [])) {
      // Allow same skill name from different agents (each gets its own line)
      const key = `${s.name}::${a.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name: s.name, description: s.description, agentId: a.id, agentDisplayName: a.displayName });
      }
    }
  }
  return result;
}, [activeSessionId, sessions, agents]);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: No errors

---

### Task 2: Update `SlashCommandPopup` — display + scroll

**Files:**
- Modify: `apps/web/src/components/SlashCommandPopup.tsx`

- [ ] **Step 1: Extend `SkillItem` interface and `allCommands` mapping**

Replace the `SkillItem` interface (line 14-17) and `allCommands` useMemo (lines 31-38):

```typescript
interface SkillItem {
  name: string;
  description: string;
  agentDisplayName?: string;
}

interface Props {
  query: string;
  focusedIndex: number;
  onSelect: (command: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
  agentSkills?: SkillItem[];
}
```

The `allCommands` useMemo stays the same — `agentSkills` already has `agentDisplayName` now.

- [ ] **Step 2: Add scroll-into-view for focused item**

Add a `useEffect` that scrolls the focused item into view when `focusedIndex` changes. Add a `useRef` for the list container and attach `data-index` to each item:

```tsx
export function SlashCommandPopup({ query, focusedIndex, onSelect, onClose, position, agentSkills }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allCommands = useMemo(() => {
    const skills: { name: string; description: string; icon: string; agentDisplayName?: string }[] = (agentSkills || []).map(s => ({
      name: '/' + s.name,
      description: s.description,
      icon: '🔧',
      agentDisplayName: s.agentDisplayName,
    }));
    return [...SLASH_COMMANDS, ...skills];
  }, [agentSkills]);

  const filtered = query
    ? allCommands.filter((c) => c.name.startsWith(query) || c.name.includes(query.slice(1)))
    : allCommands;

  // Auto-scroll focused item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);
```

- [ ] **Step 3: Update item rendering to show agent name**

Replace the item rendering inside the `filtered.map` (lines 64-76):

```tsx
{filtered.map((cmd, i) => (
  <div
    key={cmd.name + (cmd.agentDisplayName || '')}
    data-index={i}
    onClick={() => onSelect(cmd.name)}
    className={`px-3 py-2 flex items-center gap-2.5 cursor-pointer transition text-sm ${
      i === focusedIndex ? 'bg-hub-active text-hub-primary' : 'text-hub-tertiary hover:bg-hub-hover hover:text-hub-secondary'
    }`}
  >
    <span className="text-xs w-5 text-center">{cmd.icon}</span>
    <span className="font-medium font-mono text-xs">{cmd.name}</span>
    <span className="text-[11px] text-hub-muted flex-1 truncate">{cmd.description}</span>
    {cmd.agentDisplayName && (
      <span className="text-[10px] text-hub-muted shrink-0 ml-1">{cmd.agentDisplayName}</span>
    )}
  </div>
))}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: No errors

---

### Task 3: Auto-tag agent on skill selection

**Files:**
- Modify: `apps/web/src/components/MessageInput.tsx:142-147` (handleSelectCommand)

- [ ] **Step 1: Add skill disambiguation state**

Add new state variables after the existing state declarations (around line 52):

```typescript
const [pendingSkillAgents, setPendingSkillAgents] = useState<AgentConfig[]>([]);
const [pendingSkillName, setPendingSkillName] = useState<string | null>(null);
```

- [ ] **Step 2: Replace `handleSelectCommand` with auto-tag logic**

Replace the `handleSelectCommand` function (lines 142-147):

```typescript
const handleSelectCommand = (command: string) => {
  const skillName = command.slice(1); // Remove leading "/"
  const owners = agentSkills.filter(s => s.name === skillName);

  if (owners.length === 1) {
    // Single owner — auto-tag
    const owner = owners[0];
    setTags((prev) => {
      if (prev.some(t => t.agentId === owner.agentId)) return prev;
      return [...prev, { agentId: owner.agentId, agentName: owner.name, displayName: owner.agentDisplayName }];
    });
    setValue(command + ' ');
  } else if (owners.length > 1) {
    // Multiple owners — show disambiguation popup
    const agentConfigs: AgentConfig[] = owners.map(o => {
      const full = agents.find(a => a.id === o.agentId);
      return full || { id: o.agentId, name: '', displayName: o.agentDisplayName, description: '', systemPrompt: '', provider: 'claude-code', type: 'user', skills: [] } as AgentConfig;
    });
    setPendingSkillAgents(agentConfigs);
    setPendingSkillName(skillName);
    setValue(command + ' ');
    setShowSlash(false);
    setSlashQuery('');
    return;
  } else {
    // No agent owns this — just set the value (built-in command)
    setValue(command + ' ');
  }

  setShowSlash(false);
  setSlashQuery('');
  ref.current?.focus();
};
```

- [ ] **Step 3: Add disambiguation popup handler**

Add handler for when user selects an agent from the disambiguation popup:

```typescript
const handleSkillAgentSelect = (agent: AgentConfig) => {
  setTags((prev) => {
    if (prev.some(t => t.agentId === agent.id)) return prev;
    return [...prev, { agentId: agent.id, agentName: agent.name, displayName: agent.displayName }];
  });
  setPendingSkillAgents([]);
  setPendingSkillName(null);
  ref.current?.focus();
};
```

- [ ] **Step 4: Render disambiguation popup in JSX**

Add the `AgentMentionPopup` for skill disambiguation right after the existing `{showSlash && ...}` block (around line 323):

```tsx
{pendingSkillAgents.length > 0 && (
  <AgentMentionPopup
    agents={pendingSkillAgents}
    query=""
    focusedIndex={0}
    onSelect={handleSkillAgentSelect}
    onClose={() => { setPendingSkillAgents([]); setPendingSkillName(null); }}
    position={{ top: 0, left: 8 }}
  />
)}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: No errors

---

### Task 4: `handleSend` fallback + mismatch toast

**Files:**
- Modify: `apps/web/src/components/MessageInput.tsx:197-264` (handleSend)

- [ ] **Step 1: Add fallback auto-tag in `handleSend`**

In `handleSend`, after the `skillInvocation` detection block (around line 252) and before the `onSend` call, add:

```typescript
// Fallback: if skillInvocation is set but no tags, auto-find owner
if (skillInvocation && tags.length === 0) {
  const owners = agentSkills.filter(s => s.name === skillInvocation);
  if (owners.length === 1) {
    const owner = owners[0];
    tags = [{ agentId: owner.agentId, agentName: owner.name, displayName: owner.agentDisplayName }];
  } else if (owners.length > 1) {
    addToast(`多个 Agent 拥有 ${skillInvocation}，请 @指定 Agent`, 'warning');
    return;
  }
}
```

Note: `tags` needs to be declared with `let` instead of `const` in the destructuring from state, or use a local variable. Adjust the variable scoping accordingly.

- [ ] **Step 2: Add mismatch toast**

In `handleSend`, after building mentions and before calling `onSend`, add a check: if `skillInvocation` is set and mentions target an agent that doesn't have the skill, show a toast:

```typescript
if (skillInvocation && mentions.length > 0) {
  for (const m of mentions) {
    const targetAgent = agents.find(a => a.id === m.agentId);
    if (targetAgent && !(targetAgent.skills || []).some((s: any) => s.name === skillInvocation)) {
      addToast(`${targetAgent.displayName} 没有 ${skillInvocation}，skill 将被忽略`, 'warning');
    }
  }
}
```

This requires importing/using `addToast` from the store. Check if it's already available — `useAppStore` is already imported.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: No errors

---

### Task 5: Manual verification

- [ ] **Step 1: Start dev server and test**

Run:
```bash
cd apps/web && npx vite
```

- [ ] **Step 2: Test scenarios**

1. **Group chat, single owner skill**: Type `/` → see skill with agent name → select → agent tag appears automatically → send → agent receives skill injection
2. **Group chat, multi-owner skill**: Type `/` → see same skill listed twice with different agents → select → disambiguation popup appears → pick agent → tag added → send
3. **Group chat, no @mention**: Select skill without @mentioning → auto-tag added → send works
4. **Group chat, mismatch**: @Agent A, select Agent B's skill → toast warns about mismatch
5. **Solo chat**: Type `/` → skills shown without agent annotation → select → works as before
6. **Arrow key scroll**: Open "/" popup with many items → arrow down past visible area → list scrolls to follow focus
7. **TypeScript**: `npx tsc --noEmit -p apps/web/tsconfig.json` passes

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/MessageInput.tsx apps/web/src/components/SlashCommandPopup.tsx docs/superpowers/plans/2026-06-05-skill-invocation-ux.md docs/superpowers/specs/2026-06-05-skill-invocation-ux-design.md
git commit -m "feat: show skill owner in slash popup and auto-tag agent on selection"
```
