# Unified Agent Creation & Preset Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the two separate "Default Agent" / "Custom Agent" flows with a single `CreateAgentModal`, add template selection and preset skills, and support creating agents from both solo session and group session contexts.

**Architecture:** New `CreateAgentModal` component opens from both SessionList and AddAgentModal. Preset skills stored in `apps/api/src/presetSkills.ts`, served via `GET /api/agents/preset-skills`. New `POST /api/agents` endpoint creates a user agent independently.

**Tech Stack:** React 18+, Zustand, Hono, Prisma, TypeScript

**Spec:** `docs/superpowers/specs/2026-06-04-unified-agent-creation.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/src/presetSkills.ts` | **Create** (already generated) | 34 preset SkillDef entries with full content |
| `apps/api/src/routes/agents.ts` | **Modify** | Add GET /preset-skills + POST / endpoints |
| `apps/web/src/components/CreateAgentModal.tsx` | **Create** | Unified creation modal with templates and skill groups |
| `apps/web/src/lib/api.ts` | **Modify** | Add createAgent, getPresetSkills API functions |
| `apps/web/src/components/SessionList.tsx` | **Modify** | Replace dual buttons with single "Create Agent" |
| `apps/web/src/components/AddAgentModal.tsx` | **Modify** | Add "Create New Agent" button that opens CreateAgentModal |

---

### Task 1: Backend — presetSkills 数据文件

**Files:**
- Create: `apps/api/src/presetSkills.ts` (already generated with 33 skills)
- Add: `archive-experience` skill

- [ ] **Step 1: Verify generated file compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: zero errors (excluding pre-existing test/vitest issues).

- [ ] **Step 2: Add archive-experience skill to presetSkills.ts**

Read content from `apps/api/src/agent/skills/archive-experience.md`, append entry to the array.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/presetSkills.ts
git commit -m "feat: add 34 preset skills from ~/.claude plugins and project templates"
```

---

### Task 2: Backend — GET /preset-skills + POST / endpoints

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

- [ ] **Step 1: Add GET /preset-skills**

Insert BEFORE `/:id` routes. Returns name+description only (no content):

```typescript
// GET /preset-skills — list available preset skills (MUST be before /:id)
agents.get('/preset-skills', async (c) => {
  const { presetSkills } = await import('../presetSkills.js');
  const list = presetSkills.map(({ name, description }) => ({ name, description }));
  return c.json(list);
});
```

- [ ] **Step 2: Add POST / endpoint**

Insert after fixed-path routes but before `/:id`. Create schema and handler:

```typescript
const createSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  displayName: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1).max(8000),
  skills: z.array(skillDefSchema).optional(),
});

agents.post('/', async (c) => {
  const { userId } = c.get('user');
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  // Resolve preset skill names to full SkillDef with content
  let skills = parsed.data.skills || [];
  if (skills.length > 0) {
    const { presetSkills } = await import('../presetSkills.js');
    const presetMap = new Map(presetSkills.map(s => [s.name, s]));
    skills = skills.map(s => (!s.content && presetMap.has(s.name)) ? presetMap.get(s.name)! : s);
  }

  const agent = await prisma.agent.create({
    data: { ...parsed.data, skills: skills as any, isActive: true, type: 'user', createdBy: userId },
  });
  return c.json(agent, 201);
});
```

- [ ] **Step 3: Verify compilation and test**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
# Test preset-skills endpoint:
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents/preset-skills | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents.ts
git commit -m "feat: add GET /preset-skills and POST /agents endpoints"
```

---

### Task 3: Frontend — API client functions

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add new functions**

```typescript
getPresetSkills: () =>
  request<{ name: string; description: string }[]>("/agents/preset-skills"),

createAgent: (body: {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  skills?: import("@agenthub/shared").SkillDef[];
}) =>
  request<any>("/agents", {
    method: "POST",
    body: JSON.stringify(body),
  }),
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat: add getPresetSkills and createAgent to API client"
```

---

### Task 4: Frontend — CreateAgentModal 组件

**Files:**
- Create: `apps/web/src/components/CreateAgentModal.tsx`

This is the core UI component (~250 lines). Key structure:

- [ ] **Step 1: Props, state, template/skill group definitions**

```typescript
interface Props {
  open: boolean;
  onClose: () => void;
  groupSessionId?: string;  // if set, adds agent to group after creation
}

const TEMPLATES = [
  { key: 'code-agent', label: 'CodeAgent', desc: 'Writes and modifies code, runs shell commands, creates files' },
  { key: 'review-agent', label: 'ReviewAgent', desc: 'Reviews code for bugs, security vulnerabilities, and style issues' },
  { key: 'devops-agent', label: 'DevOpsAgent', desc: 'Handles deployment, CI/CD, Docker, and infrastructure tasks' },
  { key: 'test-agent', label: 'TestAgent', desc: 'Generates tests, runs test suites, and reports results' },
  { key: 'custom', label: 'Custom', desc: 'Start from scratch' },
] as const;

const SKILL_GROUPS: Record<string, string[]> = {
  'Quality': ['karpathy-guidelines', 'systematic-debugging', 'test-driven-development', 'verification-before-completion', 'requesting-code-review', 'receiving-code-review'],
  'Workflow': ['brainstorming', 'writing-plans', 'writing-skills', 'executing-plans', 'subagent-driven-development', 'dispatching-parallel-agents', 'finishing-a-development-branch', 'using-git-worktrees'],
  'Creative': ['frontend-design', 'canvas-design', 'algorithmic-art', 'theme-factory', 'web-artifacts-builder', 'slack-gif-creator'],
  'Documents': ['docx', 'xlsx', 'pptx', 'pdf', 'pdf-generator', 'doc-coauthoring', 'internal-comms', 'claude-api', 'mcp-builder', 'webapp-testing', 'brand-guidelines', 'skill-creator', 'cc-nano-banana', 'archive-experience'],
};
```

- [ ] **Step 2: Load preset skills, form state**

```typescript
const [presetSkills, setPresetSkills] = useState<{ name: string; description: string }[]>([]);
const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
const [displayName, setDisplayName] = useState('');
const [description, setDescription] = useState('');
const [systemPrompt, setSystemPrompt] = useState('');
const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
const [skillSearch, setSkillSearch] = useState('');
const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(['Creative', 'Documents']));
const [creating, setCreating] = useState(false);
const [error, setError] = useState<string | null>(null);

useEffect(() => {
  if (open) {
    api.getPresetSkills().then(setPresetSkills).catch(() => {});
    // Reset form
    setSelectedTemplate(null); setDisplayName(''); setDescription('');
    setSystemPrompt(''); setSelectedSkills(new Set()); setSkillSearch('');
  }
}, [open]);
```

- [ ] **Step 3: Template selection handler**

```typescript
const agents = useAppStore(s => s.agents);

const handleSelectTemplate = (key: string) => {
  setSelectedTemplate(key);
  if (key === 'custom') {
    setDisplayName(''); setDescription(''); setSystemPrompt('');
    setSelectedSkills(new Set());
  } else {
    const tpl = TEMPLATES.find(t => t.key === key)!;
    setDisplayName(tpl.label);
    setDescription(tpl.desc);
    const tplAgent = agents.find(a => a.name === key);
    if (tplAgent) setSystemPrompt(tplAgent.systemPrompt || '');
    // Default skills per template
    if (key === 'code-agent' || key === 'review-agent') {
      setSelectedSkills(new Set(['karpathy-guidelines']));
    } else {
      setSelectedSkills(new Set());
    }
  }
};
```

- [ ] **Step 4: Create handler**

```typescript
const handleCreate = async () => {
  if (!displayName || !description || !systemPrompt) return;
  setCreating(true); setError(null);
  try {
    const name = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    const skills = Array.from(selectedSkills).map(name => ({ name, description: '', content: '' }));
    const agent = await api.createAgent({ name, displayName, description, systemPrompt, skills });

    if (groupSessionId) {
      await api.addSessionAgents(groupSessionId, [agent.id]);
    } else {
      const session = await api.createSession({ type: 'solo', agentIds: [agent.id] });
      useAppStore.getState().setActiveSession(session.id);
    }
    // Refresh stores
    api.getAgents().then(useAppStore.getState().setAgents);
    api.getSessions().then(useAppStore.getState().setSessions);
    onClose();
  } catch (err: any) {
    setError(err.message || 'Failed to create agent');
  } finally {
    setCreating(false);
  }
};
```

- [ ] **Step 5: Render modal**

Modal (`max-w-2xl`, `max-h-[85vh]` flex column):
- Header: "Create Agent" + close button
- Scrollable body:
  - Template cards (5 horizontal cards, click to select, highlighted border on selected)
  - Display Name input (required)
  - Description input (required)
  - System Prompt textarea (6 rows, monospace)
  - Skills section:
    - Search input filtering across all groups
    - Each group is a `<details>` element, open by default for Quality/Workflow, collapsed for Creative/Documents
    - Each skill: checkbox + name (bold) + description (truncated gray text)
- Footer: Cancel + Create button (disabled while creating or missing required fields)

- [ ] **Step 6: Verify compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/CreateAgentModal.tsx
git commit -m "feat: add CreateAgentModal with template selection and preset skill groups"
```

---

### Task 5: SessionList — 替换创建按钮

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`

- [ ] **Step 1: Add state and import**

```typescript
import { CreateAgentModal } from './CreateAgentModal';
const [showCreateAgent, setShowCreateAgent] = useState(false);
```

- [ ] **Step 2: Replace "+ Add" dropdown**

Replace the entire `{!customAgentMode ? (...) : (...)}` block with:

```tsx
<button onClick={(e) => { e.stopPropagation(); setShowCreateAgent(true); }}>
  <Bot className="w-3.5 h-3.5" /> Create Agent
</button>
<button onClick={() => handleCreate('group')}>
  <Users className="w-3.5 h-3.5" /> Group Session
</button>
```

- [ ] **Step 3: Remove old state**

Delete: `customAgentMode`, `customName`, `customDisplay`, `customDesc`, `customPrompt` state declarations. Remove `handleCreate('solo')` logic or simplify.

- [ ] **Step 4: Render CreateAgentModal**

```tsx
{showCreateAgent && (
  <CreateAgentModal open={showCreateAgent} onClose={() => setShowCreateAgent(false)} />
)}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SessionList.tsx
git commit -m "feat: replace solo agent creation with unified CreateAgentModal"
```

---

### Task 6: AddAgentModal — 新增创建入口

**Files:**
- Modify: `apps/web/src/components/AddAgentModal.tsx`

- [ ] **Step 1: Import and state**

```typescript
import { CreateAgentModal } from './CreateAgentModal';
const [showCreateAgent, setShowCreateAgent] = useState(false);
```

- [ ] **Step 2: Add button + modal**

At the top of the modal body:

```tsx
<div className="p-4 border-b border-hub">
  <button onClick={() => setShowCreateAgent(true)}
    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-dashed border-hub-accent/30 text-hub-accent hover:bg-hub-accent/5 transition text-sm">
    <Plus className="w-4 h-4" /> Create New Agent
  </button>
</div>

{showCreateAgent && (
  <CreateAgentModal
    open={showCreateAgent}
    groupSessionId={sessionId}
    onClose={() => { setShowCreateAgent(false); onClose(); }}
  />
)}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AddAgentModal.tsx
git commit -m "feat: add Create New Agent button to group session add panel"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: Full TypeScript compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 2: Restart and test API**

```bash
bash scripts/cleanup.sh && bash scripts/startup.sh
# Verify preset-skills endpoint returns 34 skills
# Verify POST /agents creates agent with resolved skill content
```

- [ ] **Step 3: UI screenshot test**

Playwright: open CreateAgentModal, select CodeAgent template, verify fields populate, toggle skill checkboxes, create agent. Verify in Group Session Add panel too.

- [ ] **Step 4: Cleanup and final commit**

```bash
git add -A && git commit -m "chore: end-to-end verification of unified agent creation"
```

---

## Verification Checklist

- [ ] `npx tsc --noEmit` passes for api and web
- [ ] `GET /api/agents/preset-skills` returns 34 preset skills
- [ ] `POST /api/agents` creates agent, resolves preset skill names to full content
- [ ] CreateAgentModal: template selection populates fields correctly
- [ ] CreateAgentModal: skill groups are collapsible, search filters across groups
- [ ] CreateAgentModal: solo path creates session and navigates to it
- [ ] CreateAgentModal: group path adds agent to session
- [ ] SessionList: single "Create Agent" button replaces old Default/Custom buttons
- [ ] AddAgentModal: "Create New Agent" button opens modal, creates and adds agent
- [ ] Old `customAgentMode` code fully removed from SessionList
