# Planner Skill-Based Task Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile text-parsing planner dispatch with skill-driven pipeline: inject plan skill into Planner's Claude Code skills dir, Planner writes plan.json, Hub file watcher detects and dispatches.

**Architecture:** Two Claude Code skills (cap-inventory.md for agent list, plan-and-dispatch.md for workflow) injected into Planner's `.claude/skills/`. Planner writes `/workspace/plan.json`. `planWatcher.ts` detects via fs.watch, normalizes via `PlanNormalizer.ts`, assesses risk, dispatches low-risk plans immediately and broadcasts confirm for high-risk. Text-parsing fallback retained as backup.

**Tech Stack:** Node.js 20+, TypeScript, fs.watch, existing BullMQ dispatch

---

### Task 1: Shared Types — Add `PlanTask` and `Plan` interfaces

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add `PlanTask` and `Plan` interfaces to shared types**

Add after the existing `TaskPlan` interface (after line 137):

```typescript
/** Skill-driven plan types — single source of truth for plan.json schema */
export interface PlanTask {
  id: string;
  title: string;
  description: string;
  agentType: string;       // matches cap-inventory values, not enum-constrained
  dependsOn: string[];
  expectedOutput: string;
  risk: "low" | "high";
}

export interface Plan {
  planTitle: string;
  summary: string;
  tasks: PlanTask[];
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p packages/shared/tsconfig.json 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add PlanTask and Plan shared types for skill-driven dispatch"
```

---

### Task 2: PlanNormalizer — Normalize and validate plan.json

**Files:**
- Create: `apps/api/src/agent/PlanNormalizer.ts`

- [ ] **Step 1: Create `PlanNormalizer.ts`**

```typescript
import type { Plan, PlanTask } from '@agenthub/shared';

/**
 * Strip session-specific suffix from agentType.
 * "code-agent-2a593a92" → "code-agent"
 * "review-agent-abc123" → "review-agent"
 * "test-agent" → "test-agent" (no suffix, unchanged)
 */
function stripSessionSuffix(agentType: string): string {
  const match = agentType.match(/^(.+?)-[a-f0-9]{6,}$/);
  return match ? match[1] : agentType;
}

/**
 * Normalize raw plan JSON into a standardized Plan object.
 * Handles field name variations and agentType suffix stripping.
 */
export function normalizePlan(raw: Record<string, unknown>): Plan {
  return {
    planTitle: String(
      raw.planTitle || raw.title || raw.planId || raw.name || 'Untitled Plan'
    ),
    summary: String(raw.summary || raw.description || ''),
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((t: Record<string, unknown>) => normalizeTask(t))
      : [],
  };
}

function normalizeTask(t: Record<string, unknown>): PlanTask {
  return {
    id: String(t.id || t.taskId || t.task_id || ''),
    title: String(t.title || t.name || ''),
    description: String(t.description || t.desc || ''),
    agentType: stripSessionSuffix(String(t.agentType || t.agent_type || t.agent || '')),
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String)
      : Array.isArray(t.dependencies) ? t.dependencies.map(String)
      : [],
    expectedOutput: String(t.expectedOutput || t.expected_output || t.output || ''),
    risk: t.risk === 'high' ? 'high' : 'low',
  };
}

/**
 * Basic validation: plan must have a non-empty title and at least one task.
 * Does NOT validate agentType against an enum — dispatcher does final matching.
 */
export function validateBasic(plan: Plan): { valid: true } | { valid: false; reason: string } {
  if (!plan.planTitle.trim()) {
    return { valid: false, reason: 'planTitle is empty' };
  }
  if (plan.tasks.length === 0) {
    return { valid: false, reason: 'tasks array is empty' };
  }
  for (const task of plan.tasks) {
    if (!task.id.trim()) {
      return { valid: false, reason: `task has empty id: ${JSON.stringify(task.title)}` };
    }
    if (!task.title.trim()) {
      return { valid: false, reason: `task ${task.id} has empty title` };
    }
    if (!task.agentType.trim()) {
      return { valid: false, reason: `task ${task.id} has empty agentType` };
    }
  }
  return { valid: true };
}

/**
 * Assess overall plan risk: high if ANY task is high risk.
 */
export function assessRisk(plan: Plan): 'low' | 'high' {
  return plan.tasks.some((t) => t.risk === 'high') ? 'high' : 'low';
}

/**
 * Compute a stable hash for dedup.
 */
export function planHash(plan: Plan): string {
  const ids = plan.tasks.map((t) => t.id).sort().join(',');
  return `${plan.planTitle}|${ids}`;
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/PlanNormalizer.ts
git commit -m "feat: add PlanNormalizer for plan.json field mapping and validation"
```

---

### Task 3: CapabilityInventory — Generate agent capability skill file

**Files:**
- Create: `apps/api/src/agent/CapabilityInventory.ts`

- [ ] **Step 1: Create `CapabilityInventory.ts`**

```typescript
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '../db/prisma.js';

export class CapabilityInventory {
  /**
   * Generate cap-inventory.md skill for all agents in a session.
   * Writes to every Planner agent's .claude/skills/ directory.
   */
  static async generate(sessionId: string): Promise<void> {
    const sessionAgents = await prisma.sessionAgent.findMany({
      where: { sessionId },
      include: {
        agent: {
          select: {
            id: true,
            name: true,
            displayName: true,
            description: true,
            capabilities: true,
          },
        },
      },
    });

    if (sessionAgents.length === 0) return;

    const content = buildInventoryMarkdown(sessionAgents);

    for (const sa of sessionAgents) {
      const isPlanner = sa.agent.name === 'planner' || sa.agent.name.startsWith('planner-');
      if (!isPlanner) continue;

      const agent = await prisma.agent.findUnique({
        where: { id: sa.agentId },
        select: { hostWorkDir: true, name: true },
      });
      const hostWorkDir = agent?.hostWorkDir;
      const agentName = agent?.name || sa.agent.name;
      if (!hostWorkDir) continue;

      const skillsDir = resolve(hostWorkDir, `_agent_${agentName}`, '.claude', 'skills');
      if (!existsSync(skillsDir)) continue;

      writeFileSync(resolve(skillsDir, 'cap-inventory.md'), content, 'utf-8');
      console.log(`[CapabilityInventory] Generated cap-inventory for ${agentName} in session ${sessionId.slice(0, 8)}`);

      // Push inbox notification if Planner is actively running
      try {
        const { InboxManager } = await import('./InboxManager.js');
        InboxManager.write(hostWorkDir, agentName, {
          type: 'context_update',
          id: `cap-update-${Date.now().toString(36)}`,
          from: 'hub',
          to: agentName,
          summary: 'Agent capability inventory has been updated. Please re-read cap-inventory.md skill.',
          timestamp: Date.now(),
        });
      } catch {
        // Non-critical — Planner will pick up updated skill on next message
      }
    }
  }

  static async regenerate(sessionId: string): Promise<void> {
    return CapabilityInventory.generate(sessionId);
  }
}

function buildInventoryMarkdown(
  sessionAgents: Awaited<
    ReturnType<typeof prisma.sessionAgent.findMany>
  >,
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const agentTypes = sessionAgents.map((sa: any) => sa.agent.name.toLowerCase());

  let md = `# Agent Capability Inventory

> Last updated by AgentHub at ${now}
> Total agents: ${sessionAgents.length}

## Agents

`;

  for (const sa of sessionAgents as any[]) {
    const caps = sa.agent.capabilities as Record<string, unknown> | null;
    md += `### ${sa.agent.displayName} (\`${sa.agent.name}\`)\n`;
    md += `- **ID**: ${sa.agentId}\n`;
    md += `- **Role**: ${sa.agent.description || 'No description'}\n`;
    if (caps?.allowedTools) {
      md += `- **Capabilities**: ${Array.isArray(caps.allowedTools) ? caps.allowedTools.join(', ') : 'All'}\n`;
    }
    md += `- **agentType for plan**: \`${sa.agent.name.toLowerCase()}\`\n\n`;
  }

  md += `---

## Schema Reference

When creating tasks, agentType MUST be one of:
${agentTypes.map((t: string) => `- \`${t}\``).join('\n')}

DO NOT append session IDs or suffixes to agentType.
`;

  return md;
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/CapabilityInventory.ts
git commit -m "feat: add CapabilityInventory for dynamic agent skill generation"
```

---

### Task 4: Wire CapabilityInventory into agent lifecycle

**Files:**
- Modify: `apps/api/src/agent/AgentDirectoryManager.ts`
- Modify: `apps/api/src/routes/sessionAgents.ts`
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: Add optional `sessionId` param to `AgentDirectoryManager.initialize`**

Change the method signature (currently `apps/api/src/agent/AgentDirectoryManager.ts:16`):

```typescript
static initialize(
  hostWorkDir: string,
  agentName: string,
  systemPrompt: string,
  settings?: Record<string, unknown> | null,
  sessionId?: string,
): string {
```

At end of method, after writing settings.json (after the `if (settings)` block at line 48), add:

```typescript
// Regenerate capability inventory for Planner agents when any agent is added
if (sessionId) {
  const isPlanner = agentName === 'planner' || agentName.startsWith('planner-');
  if (!isPlanner) {
    CapabilityInventory.regenerate(sessionId).catch((err) =>
      console.error(`[AgentDirectory] Failed to regenerate cap-inventory:`, err.message)
    );
  }
}
```

Add import at top:

```typescript
import { CapabilityInventory } from './CapabilityInventory.js';
```

- [ ] **Step 2: Pass sessionId at call sites**

In `handler.ts` line 418, change:
```typescript
AgentDirectoryManager.initialize(sandbox.hostWorkDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null);
```
to:
```typescript
AgentDirectoryManager.initialize(sandbox.hostWorkDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null, sessionId);
```

In `AgentRuntime.ts` at the sandbox branch line 92, change:
```typescript
AgentDirectoryManager.initialize(hostWorkDir, agent.name, agent.systemPrompt);
```
to:
```typescript
AgentDirectoryManager.initialize(hostWorkDir, agent.name, agent.systemPrompt, null, undefined);
```

In `AgentRuntime.ts` at the dedicated container branch line 102, same change:
```typescript
AgentDirectoryManager.initialize(info.hostWorkDir, agent.name, agent.systemPrompt);
```
to:
```typescript
AgentDirectoryManager.initialize(info.hostWorkDir, agent.name, agent.systemPrompt, null, undefined);
```

- [ ] **Step 3: Wire into session agent add/remove**

In `apps/api/src/routes/sessionAgents.ts`, add import at top:

```typescript
import { CapabilityInventory } from '../agent/CapabilityInventory.js';
```

After line 42 (after `broadcast(sessionId, { type: 'agent_added', agentId: id, sessionId })` in POST handler), add:

```typescript
CapabilityInventory.regenerate(sessionId).catch((err) =>
  console.error(`[sessionAgents] Failed to regenerate cap-inventory:`, err.message)
);
```

After line 58 (after `broadcast(sessionId, { type: 'agent_removed', agentId, sessionId })` in DELETE handler), add:

```typescript
CapabilityInventory.regenerate(sessionId).catch((err) =>
  console.error(`[sessionAgents] Failed to regenerate cap-inventory:`, err.message)
);
```

- [ ] **Step 4: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/AgentDirectoryManager.ts apps/api/src/routes/sessionAgents.ts apps/api/src/ws/handler.ts apps/api/src/agent/AgentRuntime.ts
git commit -m "feat: wire CapabilityInventory into agent lifecycle hooks"
```

---

### Task 5: Create plan-and-dispatch.md skill template and inject into Planner

**Files:**
- Create: `apps/api/src/agent/skills/plan-and-dispatch.md`
- Modify: `apps/api/src/agent/AgentDirectoryManager.ts`

- [ ] **Step 1: Create skills directory**

```bash
mkdir -p /home/c2216-3090/disB/hyh/agentHub/apps/api/src/agent/skills
```

- [ ] **Step 2: Write `plan-and-dispatch.md`**

Write the file `apps/api/src/agent/skills/plan-and-dispatch.md` with this content:

````markdown
---
name: plan
description: >
  Break down requirements into DAG task plans and dispatch to agents.
  Reads cap-inventory for available agents, outputs plan.json to
  /workspace/ and the Hub auto-dispatches. Triggered by user requests
  like "plan X", "规划", "拆解任务", "分配任务", "DAG", or explicit /plan.
---

# Plan and Dispatch

Triggered when the user requests task planning. Read cap-inventory.md first, then produce plan.json.

## Workflow

1. **Read** cap-inventory.md in your skills directory to see available agents
2. **Analyze** the user's requirement against each agent's capabilities
3. **Decompose** into tasks that respect agent constraints
4. **Write** plan.json to `/workspace/plan.json` using the Write tool
5. **Announce** completion — the Hub auto-detects plan.json and dispatches

## Risk Assessment

Each task MUST include a `risk` field:

- **low**: Read-only, creating files, running tests, code review, docs
- **high**: Deleting files, DB schema changes, destructive git, untrusted scripts

If the task can irreversibly destroy data, it's `high`.

## Output Schema

Write to `/workspace/plan.json`:

```json
{
  "planTitle": "string (required)",
  "summary": "string — one paragraph",
  "tasks": [
    {
      "id": "string (required) — unique e.g. T1, T2",
      "title": "string (required)",
      "description": "string — what to do and produce",
      "agentType": "string (required) — MUST match cap-inventory.md Schema Reference",
      "dependsOn": ["string"] — task IDs this depends on,
      "expectedOutput": "string — file or artifact produced",
      "risk": "low" | "high"
    }
  ]
}
```

## Example

```json
{
  "planTitle": "Add dark mode toggle",
  "summary": "Add dark mode toggle to settings with CSS variables",
  "tasks": [
    {
      "id": "T1",
      "title": "Implement dark mode CSS and toggle",
      "description": "Add CSS custom properties and toggle in settings.tsx",
      "agentType": "code-agent",
      "dependsOn": [],
      "expectedOutput": "Modified settings.tsx and styles.css",
      "risk": "low"
    },
    {
      "id": "T2",
      "title": "Code review",
      "description": "Review T1 for style consistency",
      "agentType": "review-agent",
      "dependsOn": ["T1"],
      "expectedOutput": "Review report",
      "risk": "low"
    }
  ]
}
```

## Important

- agentType MUST exactly match cap-inventory.md's Schema Reference
- Do NOT append IDs or session suffixes to agentType
- Write to `/workspace/plan.json` — NOT in your agent directory
````

- [ ] **Step 3: Inject skill into Planner agent directory**

In `AgentDirectoryManager.ts`, add import at top if not already present:

```typescript
import { readFileSync } from 'fs';
```

At end of `initialize` method, before the return, add:

```typescript
// Inject plan-and-dispatch skill for Planner agents
if (agentName === 'planner' || agentName.startsWith('planner-')) {
  const __dirname = new URL('.', import.meta.url).pathname;
  const skillTemplatePath = resolve(__dirname, 'skills', 'plan-and-dispatch.md');
  try {
    const skillContent = readFileSync(skillTemplatePath, 'utf-8');
    writeFileSync(resolve(claudeConfigDir, 'skills', 'plan-and-dispatch.md'), skillContent, 'utf-8');
  } catch (err: any) {
    console.warn(`[AgentDirectory] Could not write plan skill for ${agentName}: ${err.message}`);
  }
}
```

- [ ] **Step 4: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/skills/plan-and-dispatch.md apps/api/src/agent/AgentDirectoryManager.ts
git commit -m "feat: add and inject plan-and-dispatch skill for Planner agents"
```

---

### Task 6: Replace inline agent list with skill reference in Planner prompt

**Files:**
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: Replace the `sessionMemberBlock` for Planner agents**

In `handler.ts` lines 405-416 (Planner agent prompt building), find:

```typescript
let sessionMemberBlock = '';
if (agent.name === 'planner' || agent.name.startsWith('planner-')) {
  const members = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { name: true, displayName: true, description: true } } },
  });
  if (members.length > 0) {
    const memberLines = members.map(sa => `- ${sa.agent.displayName} (${sa.agent.name}): ${sa.agent.description}`).join('\n');
    sessionMemberBlock = `\n## 当前群聊成员\n${memberLines}\n\n请根据成员专长分配任务。agentType 仅限以上成员。如需其他类型 Agent，在 plan 的 missingAgents 字段中列出：\n\`\`\`json\n"missingAgents": [{"name": "...", "displayName": "...", "description": "...", "reason": "..."}]\n\`\`\`\n`;
  }
}
```

Replace with:

```typescript
let sessionMemberBlock = '';
if (agent.name === 'planner' || agent.name.startsWith('planner-')) {
  sessionMemberBlock = `\n## 任务规划指引

1. 在规划任务之前，请**先读取你的 skill cap-inventory.md**，获取当前群聊中所有可用 Agent 的能力清单
2. plan.json 中的 agentType 必须使用 cap-inventory.md 中声明的值，不要附加 session ID 或后缀
3. 每个任务必须包含 risk 字段（low / high），参考 plan skill 中的风险判定规则
4. 将 plan.json 通过 Write 工具写入 /workspace/plan.json，Hub 会自动检测并调度\n`;
}
```

The `await prisma.sessionAgent.findMany(...)` call is no longer needed for Planner prompt — this removes one DB query per planner message. The member list is maintained by CapabilityInventory in the skill file instead.

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/handler.ts
git commit -m "feat: replace inline agent list with skill-based capability reference in Planner prompt"
```

---

### Task 7: Create PlanWatcher — file listener for plan.json

**Files:**
- Create: `apps/api/src/ws/planWatcher.ts`

- [ ] **Step 1: Create `planWatcher.ts`**

```typescript
import { watch, readFileSync, existsSync, statSync, FSWatcher } from 'fs';
import { resolve } from 'path';
import { normalizePlan, validateBasic, assessRisk, planHash } from '../agent/PlanNormalizer.js';
import { broadcast } from './state.js';
import type { TaskDispatchNode } from './state.js';

const watchers = new Map<string, FSWatcher>();
const processedHashes = new Map<string, string>();
const pollingIntervals = new Map<string, NodeJS.Timeout>();

interface SandboxInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
}

export function startPlanWatcher(sessionId: string, hostWorkDir: string, sandbox: SandboxInfo): void {
  if (watchers.has(sessionId)) {
    console.warn(`[PlanWatcher] Already watching session ${sessionId.slice(0, 8)}`);
    return;
  }

  const planPath = resolve(hostWorkDir, 'plan.json');

  let debounceTimer: NodeJS.Timeout | null = null;

  console.log(`[PlanWatcher] Starting watcher for session ${sessionId.slice(0, 8)} at ${hostWorkDir}`);

  try {
    const watcher = watch(hostWorkDir, (_eventType, filename) => {
      if (filename !== 'plan.json' && filename !== 'plan.json.tmp') return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        handlePlanFile(sessionId, planPath, sandbox).catch((err) => {
          console.error(`[PlanWatcher] Error handling plan for ${sessionId.slice(0, 8)}:`, err.message);
        });
      }, 200);
    });

    watchers.set(sessionId, watcher);
  } catch (err: any) {
    console.warn(`[PlanWatcher] fs.watch failed for ${sessionId.slice(0, 8)}, falling back to polling:`, err.message);
    startPolling(sessionId, planPath, sandbox);
  }
}

export function stopPlanWatcher(sessionId: string): void {
  const watcher = watchers.get(sessionId);
  if (watcher) {
    watcher.close();
    watchers.delete(sessionId);
    console.log(`[PlanWatcher] Stopped watcher for session ${sessionId.slice(0, 8)}`);
  }

  const interval = pollingIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    pollingIntervals.delete(sessionId);
  }

  processedHashes.delete(sessionId);
}

async function handlePlanFile(
  sessionId: string,
  planPath: string,
  sandbox: SandboxInfo,
): Promise<void> {
  if (!existsSync(planPath)) return;

  let raw: string;
  try {
    raw = readFileSync(planPath, 'utf-8');
  } catch {
    return;
  }

  if (!raw.trim()) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`[PlanWatcher] Invalid JSON in plan.json for ${sessionId.slice(0, 8)}, waiting for completion`);
    return;
  }

  const plan = normalizePlan(parsed);

  // Dedup by hash
  const hash = planHash(plan);
  if (processedHashes.get(sessionId) === hash) {
    console.log(`[PlanWatcher] Duplicate plan for ${sessionId.slice(0, 8)}, skipping`);
    return;
  }

  const validation = validateBasic(plan);
  if (!validation.valid) {
    console.warn(`[PlanWatcher] Invalid plan for ${sessionId.slice(0, 8)}: ${validation.reason}`);
    return;
  }

  processedHashes.set(sessionId, hash);

  const risk = assessRisk(plan);
  const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const taskList = plan.tasks.map((t) => ({
    taskId: t.id,
    planId,
    title: t.title,
    description: t.description,
    agentType: t.agentType,
    dependsOn: t.dependsOn,
    expectedOutput: t.expectedOutput,
    priority: 'medium' as const,
    risk: t.risk,
    status: 'waiting' as const,
  }));

  broadcast(sessionId, {
    type: 'plan_result',
    planId,
    planTitle: plan.planTitle,
    summary: plan.summary,
    risk,
    requiresConfirmation: risk === 'high',
    tasks: taskList,
  });

  if (risk === 'low') {
    // Auto-confirm and dispatch
    console.log(`[PlanWatcher] Low-risk plan ${planId}, dispatching immediately`);

    const tasks: TaskDispatchNode[] = plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      agentType: t.agentType,
      dependsOn: t.dependsOn,
      expectedOutput: t.expectedOutput,
      priority: 'medium',
    }));

    const { dispatchTasksToAgents } = await import('./taskDispatcher.js');

    dispatchTasksToAgents(sessionId, planId, tasks, sandbox, plan.planTitle)
      .then(() => {
        broadcast(sessionId, { type: 'plan_executing', planId });
      })
      .catch((err: any) => {
        broadcast(sessionId, { type: 'stream_error', error: `Failed to dispatch tasks: ${err.message}` });
      });
  } else {
    console.log(`[PlanWatcher] High-risk plan ${planId}, awaiting user confirmation`);
    // Frontend shows confirmation panel; confirm_plan triggers dispatchTasksToAgents
  }
}

function startPolling(
  sessionId: string,
  planPath: string,
  sandbox: SandboxInfo,
): void {
  let lastMtime = 0;

  const interval = setInterval(() => {
    try {
      const stat = statSync(planPath);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        handlePlanFile(sessionId, planPath, sandbox).catch(() => {});
      }
    } catch {
      // File may not exist yet
    }
  }, 500);

  pollingIntervals.set(sessionId, interval);
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/planWatcher.ts
git commit -m "feat: add PlanWatcher for fs-based plan detection and dispatch"
```

---

### Task 8: Wire PlanWatcher into sandbox lifecycle and AgentRuntime fallback

**Files:**
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/api/src/agent/AgentRuntime.ts`

- [ ] **Step 1: Start PlanWatcher on sandbox creation**

In `handler.ts` init handler (around line 155, inside the `try` block after sandbox is created and `sendTo(ws, { type: 'connected' })`), add:

```typescript
// Start plan.json file watcher
import('./planWatcher.js').then(({ startPlanWatcher }) => {
  startPlanWatcher(sessionId, sb.hostWorkDir, sb);
}).catch((err) => {
  console.error('[ws] Failed to start plan watcher:', err.message);
});
```

Add this right after the `console.log(\`[ws] Client connected...\`)` line (line 160) and the `sendTo(ws, { type: 'connected', sessionId })` block.

- [ ] **Step 2: Stop PlanWatcher on session cleanup**

In `handler.ts` (or `state.ts`), add `stopPlanWatcher(sessionId)` to `cleanupSessionResources`.

In `state.ts`, add import at top:

```typescript
import { stopPlanWatcher } from './planWatcher.js';
```

In the `cleanupSessionResources` function, add after the `MilestoneBroadcaster.clear(sessionId)` line (line 238):

```typescript
stopPlanWatcher(sessionId);
```

- [ ] **Step 3: Wire text-parsing fallback in AgentRuntime**

In `AgentRuntime.ts`, the `done` event handler around lines 179-207, modify to add plan.json file check before fallback.

Find the `extractAndValidate` block. The current logic broadcasts `plan_result` when text parsing succeeds. The new logic should:

1. Check if plan.json was already handled by PlanWatcher (check `processedHashes` — but that's in a separate module)
2. If watcher didn't fire within 3s, use the text-parsed plan as fallback

Simpler approach: keep the existing `extractAndValidate` block but only run it if no plan.json file exists in hostWorkDir. This avoids running both paths simultaneously.

In `AgentRuntime.ts`, change the `done` handler's planner branch:

```typescript
// Parse planner output — plan.json (file watcher) is the primary path.
// Text extraction is the fallback for when Write tool isn't available.
if (entry.isPlanner && entry.accumulatedOutput) {
  const planPath = `${entry.hostWorkDir}/plan.json`;
  const { existsSync } = await import('fs');

  // Give file watcher a 3s head start to detect plan.json
  await new Promise(r => setTimeout(r, 3000));

  if (!existsSync(planPath)) {
    // Fallback: text-based plan extraction
    const plan = extractAndValidate(entry.accumulatedOutput);
    if (plan) {
      const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      broadcast(sessionId, {
        type: 'plan_result',
        planId,
        planTitle: plan.planTitle,
        summary: plan.summary,
        risk: 'low',
        requiresConfirmation: true,
        tasks: plan.tasks.map((t) => ({
          taskId: t.id,
          planId,
          title: t.title,
          description: t.description,
          agentType: t.agentType,
          dependsOn: t.dependsOn,
          expectedOutput: t.expectedOutput,
          priority: t.priority,
          status: 'waiting',
        })),
        missingAgents: plan.missingAgents,
      });
    } else {
      console.warn(`[AgentRuntime] Failed to parse planner output for agent ${agentId}`);
    }
  }
  entry.accumulatedOutput = '';
}
```

Wait — the `handleAgentEvent` is not async. Let me simplify: just check if plan.json exists immediately. If the Planner used the Write tool, the file would be there before the `done` event fires (Write happens before done).

```typescript
// Parse planner output and broadcast plan_result
if (entry.isPlanner && entry.accumulatedOutput) {
  // Primary path: plan.json via file watcher (Planner writes with Write tool).
  // Fallback: text extraction from output (when Write tool unavailable).
  const planPath = `${entry.hostWorkDir}/plan.json`;
  let planHandled = false;

  try {
    const { existsSync } = require('fs');
    if (existsSync(planPath)) {
      // File watcher will handle this — skip text extraction
      planHandled = true;
    }
  } catch {}

  if (!planHandled) {
    const plan = extractAndValidate(entry.accumulatedOutput);
    if (plan) {
      const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      broadcast(sessionId, {
        type: 'plan_result',
        planId,
        planTitle: plan.planTitle,
        summary: plan.summary,
        risk: 'low',
        requiresConfirmation: true,
        tasks: plan.tasks.map((t) => ({
          taskId: t.id,
          planId,
          title: t.title,
          description: t.description,
          agentType: t.agentType,
          dependsOn: t.dependsOn,
          expectedOutput: t.expectedOutput,
          priority: t.priority,
          status: 'waiting',
        })),
        missingAgents: plan.missingAgents,
      });
    } else {
      console.warn(`[AgentRuntime] Failed to parse planner output for agent ${agentId}`);
    }
  }
  entry.accumulatedOutput = '';
}
```

Actually, `require` won't work in ESM. Use the already-imported `existsSync` at the top of AgentRuntime.ts or a dynamic import. Let me use the same pattern — `AgentRuntime.ts` already imports from `fs` indirectly. Let me add the import.

At the top of `AgentRuntime.ts`, add:
```typescript
import { existsSync } from 'fs';
```

Then the code can use `existsSync` directly.

- [ ] **Step 4: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ws/handler.ts apps/api/src/ws/state.ts apps/api/src/agent/AgentRuntime.ts
git commit -m "feat: wire PlanWatcher into sandbox lifecycle and add text-parsing fallback"
```

---

### Task 9: Dispatcher agent matching enhancement

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

- [ ] **Step 1: Use agentType matching with fallback to session member list**

In `taskDispatcher.ts`, the `dispatchTasksToAgents` function (line 300) already does agent matching with `agentsByType` map. The key enhancement is: when agentType doesn't match any agent, instead of generating a hardcoded `suggestedAgent`, use the closest matching session member.

The current behavior at line 329-351 already does this with `findClosestAgent`. Let me verify and enhance if needed.

Check if `findClosestAgent` exists:

```bash
grep -n "findClosestAgent" /home/c2216-3090/disB/hyh/agentHub/apps/api/src/ws/taskDispatcher.ts
```

If it exists and works, this task is minimal. Let me add better error messaging for `agent_missing` events.

In the `agent_missing` broadcast (around line 341), enhance the suggested agent info:

Change the suggested agent block from:
```typescript
suggestedAgent: {
  name: task.agentType,
  displayName: task.agentType,
  description: `Auto-suggested ${task.agentType} for task: ${task.title}`,
},
```

To query actual session agents for a meaningful suggestion:

Actually, looking at the existing code — `findClosestAgent` is called first (line 331) and if it returns a match, the task is assigned to that agent (line 333). So by the time we reach the `missingTypes` branch, there's genuinely no matching agent. The enhancement here is to provide a better UX: list all available agent types in the session so the user knows what's available.

```typescript
const availableAgentTypes = [...new Set(sessionAgents.map(sa => sa.agent.name))];
broadcast(sessionId, {
  type: 'agent_missing', planId, taskId: task.id,
  agentType: task.agentType, taskTitle: task.title,
  availableAgentTypes,
  message: `No agent matches "${task.agentType}". Available: ${availableAgentTypes.join(', ')}`,
});
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: enhance agent_missing event with available agent types"
```

---

### Task 10: End-to-end verification

- [ ] **Step 1: Full TypeScript compilation check**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | head -50
```

Expected: No errors.

- [ ] **Step 2: Run existing tests**

```bash
cd /home/c2216-3090/disB/hyh/agentHub && npx tsx apps/api/src/realHubTests.ts 2>&1 | head -30
```

- [ ] **Step 3: Start backend and verify no startup errors**

```bash
cd /home/c2216-3090/disB/hyh/agentHub/apps/api && timeout 5 npx tsx src/index.ts 2>&1 | head -20 || true
```

Expected: No import errors or crashes.
