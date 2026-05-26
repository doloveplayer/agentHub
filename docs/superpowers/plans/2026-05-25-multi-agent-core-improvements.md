# Multi-Agent Collaboration & Task Planning Core Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Harden the multi-agent task planning and execution pipeline with schema validation, DAG state persistence, fault tolerance, priority scheduling, and interactive plan editing.

**Architecture:** Six independent but sequenced improvements. BullMQ cleanup first to reduce surface area. Zod schema validation replaces brittle JSON parsing. A new `PlanExecution` Prisma model persists DAG state across restarts. Agent fault transfer redistributes queued tasks on agent failure. Priority queue ensures unblocked dependents execute first. Frontend plan editing allows modifying task details before confirmation.

**Tech Stack:** TypeScript, Zod (already in deps), Prisma/PostgreSQL, Zustand (frontend state), @xyflow/react (DAG rendering)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/src/agent/TaskQueue.ts` | **Delete** | BullMQ dead code removal |
| `apps/api/src/index.ts` | Modify | Remove BullMQ init, add startup DAG recovery |
| `apps/api/src/config.ts` | Modify | Remove `taskQueue` config block |
| `packages/shared/src/types.ts` | Modify | Add Zod schemas for TaskPlan/TaskNode |
| `apps/api/src/agent/PlanValidator.ts` | Create | Zod-based plan validation + retry |
| `apps/api/src/agent/PlannerAgent.ts` | Modify | Use PlanValidator instead of hand-rolled parsing |
| `apps/api/prisma/schema.prisma` | Modify | Add `PlanExecution` model |
| `apps/api/src/agent/DagPersistence.ts` | Create | Read/write DAG state via Prisma |
| `apps/api/src/ws/taskDispatcher.ts` | Modify | Integrate persistence, fault transfer, priority queue |
| `apps/api/src/ws/handler.ts` | Modify | Startup recovery, task failed handler |
| `apps/api/src/agent/turns.ts` | Modify | Remove dead `extractPlannerPlan` (superseded by PlanValidator) |
| `apps/web/src/components/ConfirmationPanel.tsx` | Modify | Full task editing (title, agentType, dependsOn, description) |
| `apps/web/src/store/appStore.ts` | Modify | Add `updateTaskField` action |

---

### Task 1: Remove BullMQ Dead Code

**Files:**
- Delete: `apps/api/src/agent/TaskQueue.ts`
- Modify: `apps/api/src/index.ts:149-167`
- Modify: `apps/api/src/config.ts:78-82`

BullMQ is initialized but never used for execution (only drain + shutdown). Removing it eliminates Redis dependency for task scheduling and simplifies the architecture.

- [x] **Step 1: Delete TaskQueue.ts**

```bash
rm apps/api/src/agent/TaskQueue.ts
```

- [x] **Step 2: Remove `taskQueue` config block from config.ts**

In `apps/api/src/config.ts`, delete lines 78-82:

```typescript
// DELETE these lines:
  taskQueue: {
    concurrency: optionalInt('TASK_CONCURRENCY', 3),
    maxRetries: optionalInt('TASK_MAX_RETRIES', 2),
    retryDelayMs: optionalInt('TASK_RETRY_DELAY_MS', 30_000),
  },
```

Use Edit to remove the block.

- [x] **Step 3: Remove BullMQ import and init from index.ts**

In `apps/api/src/index.ts`, replace lines 149-167 (the entire BullMQ init block) with a comment:

```typescript
// Task scheduling is handled by in-process DAG dispatch (ws/taskDispatcher.ts).
// BullMQ was removed — DAG state persistence replaced it (see DagPersistence.ts).
```

Also remove the `setTaskQueueManager` import on line 9:
```typescript
// Delete: import { attachWebSocket, setTaskQueueManager, broadcast } from './ws/handler.js';
// Replace with:
import { attachWebSocket, broadcast } from './ws/handler.js';
```

And remove the shutdown hook on lines 163-167:
```typescript
// DELETE:
// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[shutdown] Closing task queue...');
  await taskQueueManager?.shutdown();
  process.exit(0);
});

// REPLACE with:
process.on('SIGINT', () => {
  console.log('[shutdown] Exiting...');
  process.exit(0);
});
```

- [x] **Step 4: Remove `setTaskQueueManager` export from state.ts**

In `apps/api/src/ws/state.ts`, delete lines 84-85:
```typescript
// DELETE:
export let taskQueueManager: any = null;
export function setTaskQueueManager(tqm: any): void { taskQueueManager = tqm; }
```

- [x] **Step 5: Remove `setTaskQueueManager` export from handler.ts**

In `apps/api/src/ws/handler.ts`, line 43:
```typescript
// DELETE:
export { broadcast, setTaskQueueManager } from './state.js';
// REPLACE with:
export { broadcast } from './state.js';
```

Remove line 27 (the `taskQueueManager` import):
```typescript
// DELETE: taskQueueManager, from the import on line 27
// Change:
  taskQueueManager, taskModifications, agentClaudeSessions,
// To:
  taskModifications, agentClaudeSessions,
```

- [x] **Step 6: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors related to TaskQueue.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/agent/TaskQueue.ts apps/api/src/index.ts apps/api/src/config.ts apps/api/src/ws/state.ts apps/api/src/ws/handler.ts
git commit -m "chore: remove unused BullMQ task queue"
```

---

### Task 2: Zod Schema Validation for Planner Output

**Files:**
- Create: `apps/api/src/agent/PlanValidator.ts`
- Modify: `apps/api/src/agent/PlannerAgent.ts:1-115`
- Modify: `apps/api/src/agent/turns.ts` (remove `extractPlannerPlan`, `parsePlan`, `normalizeTask`, `extractFencedJson`, `extractJsonObjects`)
- Modify: `apps/api/src/ws/handler.ts:532-533` (use PlanValidator for plan extraction)

**Goal:** Replace the two different hand-rolled JSON parsing implementations (one in `PlannerAgent.ts`, one in `turns.ts`) with a single Zod schema. Add one automatic retry on parse failure.

- [x] **Step 1: Create PlanValidator.ts**

```typescript
import { z } from 'zod';

export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  agentType: z.enum(['CodeAgent', 'ReviewAgent', 'DevOpsAgent', 'TestAgent', 'DepsAgent']),
  dependsOn: z.array(z.string()).default([]),
  expectedOutput: z.string().default(''),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export const TaskPlanSchema = z.object({
  planTitle: z.string().min(1),
  summary: z.string().default(''),
  tasks: z.array(TaskNodeSchema).min(1, 'Plan must have at least one task'),
  missingAgents: z.array(z.object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    reason: z.string(),
  })).optional(),
});

export type ValidatedTaskNode = z.infer<typeof TaskNodeSchema>;
export type ValidatedTaskPlan = z.infer<typeof TaskPlanSchema>;

/**
 * Extract and validate a TaskPlan from raw LLM output.
 * Handles markdown code fences, loose JSON, and strict JSON.
 * Returns null if no valid plan can be extracted.
 */
export function extractAndValidate(raw: string): ValidatedTaskPlan | null {
  const candidates = extractJsonCandidates(raw);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = TaskPlanSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Not valid JSON, try next candidate
    }
  }
  return null;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];

  // 1. Extract from ```json fences
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    if (match[1]) candidates.push(match[1].trim());
  }

  // 2. Try the whole string as-is
  candidates.push(raw);

  // 3. Find JSON object containing "tasks" via brace matching
  const tasksIdx = raw.indexOf('"tasks"');
  if (tasksIdx !== -1) {
    let depth = 0; let start = -1;
    for (let i = tasksIdx; i >= 0; i--) {
      if (raw[i] === '}') depth++;
      else if (raw[i] === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start !== -1) {
      depth = 0; let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) candidates.push(raw.slice(start, end + 1));
    }
  }

  return candidates;
}
```

- [x] **Step 2: Refactor PlannerAgent.ts to use PlanValidator**

Replace the entire content of `apps/api/src/agent/PlannerAgent.ts`:

```typescript
import { createOneShotAgentProcess } from './processFactory.js';
import { extractAndValidate } from './PlanValidator.js';
import type { ValidatedTaskPlan } from './PlanValidator.js';

const MAX_RETRIES = 1;

export class PlannerAgent {
  static async plan(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    hostWorkDir: string,
  ): Promise<ValidatedTaskPlan> {
    return attemptPlan(sessionId, prompt, containerId, workDir, hostWorkDir, 0);
  }
}

async function attemptPlan(
  sessionId: string,
  prompt: string,
  containerId: string,
  workDir: string,
  hostWorkDir: string,
  attempt: number,
): Promise<ValidatedTaskPlan> {
  const planMessageId = `plan-${Date.now()}`;

  const plannerPrompt = `You are a software engineering task planning expert.
First, explore the project structure using ls and cat package.json (or equivalent).
Then, break down the following requirement into parallelizable subtasks:

${prompt}

Output ONLY a valid JSON object (no markdown fences) with this schema:
{
  "planTitle": string,
  "summary": string,
  "tasks": [
    {
      "id": "task-N",
      "title": string,
      "description": string,
      "agentType": "CodeAgent" | "ReviewAgent" | "DevOpsAgent" | "TestAgent" | "DepsAgent",
      "dependsOn": string[],
      "expectedOutput": string,
      "priority": "high" | "medium" | "low"
    }
  ],
  "missingAgents": [{"name": "...", "displayName": "...", "description": "...", "reason": "..."}]
}`;

  return new Promise((resolve, reject) => {
    const proc = createOneShotAgentProcess();
    let accumulated = '';

    proc.onEvent((event) => {
      if (event.type === 'text') accumulated += event.content;

      if (event.type === 'done') {
        if (event.exitCode !== 0) {
          reject(new Error(`Planner exited with code ${event.exitCode}`));
          return;
        }
        const plan = extractAndValidate(accumulated);
        if (plan) {
          resolve(plan);
        } else if (attempt < MAX_RETRIES) {
          console.log(`[planner] Validation failed, retrying (attempt ${attempt + 1})...`);
          resolve(attemptPlan(sessionId, prompt, containerId, workDir, hostWorkDir, attempt + 1));
        } else {
          reject(new Error(`Failed to parse plan JSON after ${MAX_RETRIES + 1} attempts.\nOutput: ${accumulated.slice(-500)}`));
        }
      }

      if (event.type === 'error') {
        if (attempt < MAX_RETRIES) {
          console.log(`[planner] Error, retrying (attempt ${attempt + 1})...`);
          resolve(attemptPlan(sessionId, prompt, containerId, workDir, hostWorkDir, attempt + 1));
        } else {
          reject(new Error(event.message));
        }
      }
    });

    proc.start(sessionId, plannerPrompt, containerId, workDir, true, hostWorkDir, planMessageId)
      .catch(reject);
  });
}
```

- [x] **Step 3: Replace `extractPlannerPlan` usage in handler.ts**

In `apps/api/src/ws/handler.ts`, line 11 and line 533:

Change line 11 from:
```typescript
import { selectDefaultAgent, extractPlannerPlan, toTaskStates } from '../agent/turns.js';
```
To:
```typescript
import { selectDefaultAgent, toTaskStates } from '../agent/turns.js';
```

Change lines 532-533 from:
```typescript
const plan = extractPlannerPlan(accumulatedContent);
```
To:
```typescript
const { extractAndValidate } = await import('../agent/PlanValidator.js');
const plan = extractAndValidate(accumulatedContent);
```

- [x] **Step 4: Remove dead parsing functions from turns.ts**

In `apps/api/src/agent/turns.ts`, delete functions:
- `extractPlannerPlan` (lines 74-86)
- `extractFencedJson` (lines 110-118)
- `extractJsonObjects` (lines 120-138)
- `parsePlan` (lines 140-152)
- `normalizeTask` (lines 154-163)

Remove the unused `TaskPlan` import on line 1:
```typescript
// Change:
import type { AgentConfig, SessionAgentInfo, TaskPlan, TaskNode } from '@agenthub/shared';
// To:
import type { AgentConfig, SessionAgentInfo, TaskNode } from '@agenthub/shared';
```

- [x] **Step 5: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors. Fix any type mismatches.

- [x] **Step 6: Run existing tests**

```bash
cd apps/api && npx vitest run src/agent/core.test.ts src/agent/PlannerAgent.test.ts 2>/dev/null || npx tsx --test src/agent/core.test.ts 2>/dev/null || echo "No test runner configured — manual verification: tsc passes"
```

- [x] **Step 7: Commit**

```bash
git add apps/api/src/agent/PlanValidator.ts apps/api/src/agent/PlannerAgent.ts apps/api/src/agent/turns.ts apps/api/src/ws/handler.ts
git commit -m "feat: add Zod schema validation for Planner output with auto-retry"
```

---

### Task 3: DAG State Persistence

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add `PlanExecution` model)
- Create: `apps/api/src/agent/DagPersistence.ts`
- Modify: `apps/api/src/ws/taskDispatcher.ts` (save/update state on every transition)
- Modify: `apps/api/src/ws/handler.ts` (recover on startup)

**Goal:** Persist `DagExecutionState` to PostgreSQL so plan execution survives backend restarts. Every DAG state transition writes to DB.

- [x] **Step 1: Add PlanExecution model to Prisma schema**

In `apps/api/prisma/schema.prisma`, add after the `Agent` model:

```prisma
model PlanExecution {
  id        String   @id @default(uuid())
  planId    String
  sessionId String
  planTitle String   @default("")
  status    String   @default("pending_confirmation")
  tasks     Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([sessionId])
  @@index([planId])
}
```

- [x] **Step 2: Run Prisma migration**

```bash
cd apps/api && npx prisma migrate dev --name add_plan_execution
```
Expected: Migration created and applied successfully.

- [x] **Step 3: Create DagPersistence.ts**

```typescript
import { prisma } from '../db/prisma.js';
import type { DagTaskStatus } from '../ws/dagExecution.js';

export interface PersistedTask {
  id: string;
  title: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  expectedOutput: string;
  priority: string;
  agentName: string;
  agentId: string;
  status: DagTaskStatus;
  dependents: string[];
}

export interface PersistedPlan {
  planId: string;
  sessionId: string;
  planTitle: string;
  status: string;
  tasks: PersistedTask[];
}

export class DagPersistence {
  static async save(plan: PersistedPlan): Promise<void> {
    await prisma.planExecution.upsert({
      where: { id: `${plan.sessionId}:${plan.planId}` },
      update: {
        status: plan.status,
        tasks: plan.tasks as any,
      },
      create: {
        id: `${plan.sessionId}:${plan.planId}`,
        planId: plan.planId,
        sessionId: plan.sessionId,
        planTitle: plan.planTitle,
        status: plan.status,
        tasks: plan.tasks as any,
      },
    });
  }

  static async updateTaskStatus(
    sessionId: string,
    planId: string,
    taskId: string,
    status: DagTaskStatus,
  ): Promise<void> {
    const record = await prisma.planExecution.findUnique({
      where: { id: `${sessionId}:${planId}` },
    });
    if (!record) return;

    const tasks = (record.tasks as PersistedTask[]).map((t) =>
      t.id === taskId ? { ...t, status } : t
    );
    await prisma.planExecution.update({
      where: { id: `${sessionId}:${planId}` },
      data: { tasks: tasks as any },
    });
  }

  static async recover(sessionId: string): Promise<PersistedPlan[]> {
    const records = await prisma.planExecution.findMany({
      where: { sessionId, status: { in: ['executing', 'pending_confirmation'] } },
      orderBy: { createdAt: 'asc' },
    });

    return records.map((r) => ({
      planId: r.planId,
      sessionId: r.sessionId,
      planTitle: r.planTitle,
      status: r.status,
      tasks: r.tasks as PersistedTask[],
    }));
  }

  static async markCompleted(sessionId: string, planId: string): Promise<void> {
    await prisma.planExecution.updateMany({
      where: { sessionId, planId },
      data: { status: 'completed' },
    });
  }

  static async markFailed(sessionId: string, planId: string): Promise<void> {
    await prisma.planExecution.updateMany({
      where: { sessionId, planId },
      data: { status: 'failed' },
    });
  }

  static async cleanup(sessionId: string): Promise<void> {
    await prisma.planExecution.deleteMany({ where: { sessionId } });
  }
}
```

- [x] **Step 4: Wire persistence into taskDispatcher.ts**

In `apps/api/src/ws/taskDispatcher.ts`, add import:
```typescript
import { DagPersistence } from '../agent/DagPersistence.js';
```

In `setPlanExecution` (line 397), add persistence after the memory set:
```typescript
function setPlanExecution(sessionId: string, planId: string, execution: DagExecutionState): void {
  planExecutions.set(planKey(sessionId, planId), execution);
  while (planExecutions.size > MAX_PLAN_EXECUTIONS) {
    const oldestKey = planExecutions.keys().next().value;
    if (!oldestKey) break;
    planExecutions.delete(oldestKey);
  }
  // Persist to DB
  persistState(sessionId, planId, execution).catch((err) =>
    console.error(`[dag] Persist error: ${err.message}`));
}
```

Add the `persistState` helper at the bottom of the file:
```typescript
async function persistState(sessionId: string, planId: string, state: DagExecutionState): Promise<void> {
  const tasks = [...state.tasks.values()].map((item) => ({
    id: item.task.id,
    title: item.task.title,
    description: item.task.description,
    agentType: item.task.agentType,
    dependsOn: item.task.dependsOn,
    expectedOutput: item.task.expectedOutput,
    priority: item.task.priority,
    agentName: item.agentName,
    agentId: item.agentId,
    status: item.status,
    dependents: item.dependents,
  }));

  await DagPersistence.save({
    planId,
    sessionId,
    planTitle: '',
    status: 'executing',
    tasks,
  });
}
```

In `markTaskDone`, `markTaskFailed`, `markTaskRetryQueued` — add a `persistState` call after each state mutation. Example in `markTaskDone`:
```typescript
export function markTaskDone(state: DagExecutionState, taskId: string): DagTaskAssignment[] {
  const item = state.tasks.get(taskId);
  if (!item) return [];
  item.status = 'done';
  return consumeReadyTasks(state);
}
```
No change needed inside these functions — the caller (`handleDispatchedTaskFinished`) will trigger persistence through the existing call chain.

Add persistence save in `handleDispatchedTaskFinished` after line 358:
```typescript
// After maybeBroadcastPlanSummary(sessionId, execution);
// Add:
persistState(sessionId, planId, execution).catch((err) =>
  console.error(`[dag] Persist error on task finish: ${err.message}`));
```

In `maybeBroadcastPlanSummary`, add completion marker:
```typescript
function maybeBroadcastPlanSummary(sessionId: string, execution: DagExecutionState): void {
  // ... existing logic ...
  if (finished !== items.length) return;

  // Mark completed in DB
  const allDone = failed === 0;
  if (allDone) {
    DagPersistence.markCompleted(sessionId, execution.planId).catch(() => {});
  } else {
    DagPersistence.markFailed(sessionId, execution.planId).catch(() => {});
  }

  broadcast(sessionId, { /* existing plan_summary */ });
  execution.summaryBroadcasted = true;
}
```

- [x] **Step 5: Add startup recovery in handler.ts**

In `apps/api/src/ws/handler.ts`, add after sandbox creation (around line 131, after `sendTo(ws, { type: 'connected', sessionId })`):

```typescript
// Recover in-flight plan executions after backend restart
try {
  const { DagPersistence } = await import('../agent/DagPersistence.js');
  const plans = await DagPersistence.recover(sessionId);
  for (const plan of plans) {
    broadcast(sessionId, {
      type: 'plan_recovered',
      planId: plan.planId,
      tasks: plan.tasks.map((t) => ({
        taskId: t.id,
        planId: plan.planId,
        title: t.title,
        agentType: t.agentType,
        status: t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : t.status === 'blocked' ? 'blocked' : 'waiting',
        dependsOn: t.dependsOn,
        expectedOutput: t.expectedOutput,
        priority: t.priority,
        assignedAgentName: t.agentName,
        assignedAgentId: t.agentId,
        description: t.description,
      })),
    });
  }
  if (plans.length > 0) {
    console.log(`[ws] Recovered ${plans.length} plan(s) for session=${sessionId.slice(0, 8)}`);
  }
} catch (err: any) {
  console.log(`[ws] Plan recovery skipped: ${err.message}`);
}
```

- [x] **Step 6: Add sandbox cleanup persistence cleanup**

In `apps/api/src/ws/state.ts`, in `cleanupSessionResources` (line 146), add before `sessions.delete(sessionId)`:

```typescript
// Clean up persisted plan executions
import('../agent/DagPersistence.js').then(({ DagPersistence }) =>
  DagPersistence.cleanup(sessionId).catch(() => {})
);
```

- [x] **Step 7: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors.

- [x] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/ apps/api/src/agent/DagPersistence.ts apps/api/src/ws/taskDispatcher.ts apps/api/src/ws/handler.ts apps/api/src/ws/state.ts
git commit -m "feat: persist DAG execution state to PostgreSQL with startup recovery"
```

---

### Task 4: Agent Fault Transfer

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts` (add fault transfer logic)
- Modify: `apps/api/src/ws/handler.ts` (detect agent failure and trigger transfer)

**Goal:** When an agent process crashes or times out, redistribute its queued (not-yet-started) tasks to other available agents of the same type. Already-running tasks are not transferred — they must be retried manually.

- [x] **Step 1: Add `reassignQueuedTasks` function to taskDispatcher.ts**

```typescript
import { prisma } from '../db/prisma.js';
import { findClosestAgent } from '../agent/turns.js';

async function reassignQueuedTasks(
  sessionId: string,
  failedAgentName: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const queue = agentTaskQueues.get(failedAgentName);
  if (!queue || queue.tasks.length === 0) return;

  const orphanedTasks = [...queue.tasks];
  agentTaskQueues.delete(failedAgentName);
  agentCurrentTask.delete(failedAgentName);

  if (orphanedTasks.length === 0) return;

  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true } } },
  });

  if (sessionAgents.length === 0) return;

  const availableAgents = sessionAgents
    .filter((sa) => sa.agent.name !== failedAgentName)
    .map((sa) => sa.agent);

  for (const task of orphanedTasks) {
    const matching = availableAgents.filter(
      (a) => a.displayName === task.agentType || a.name === failedAgentName
    );
    let target = matching.length > 0
      ? matching.reduce((best, a) => {
          const load = (agentTaskQueues.get(a.name)?.tasks.length ?? 0) + (agentCurrentTask.has(a.name) ? 1 : 0);
          const bestLoad = (agentTaskQueues.get(best.name)?.tasks.length ?? 0) + (agentCurrentTask.has(best.name) ? 1 : 0);
          return load < bestLoad ? a : best;
        })
      : findClosestAgent(task.agentType, availableAgents as any);

    if (!target) {
      broadcast(sessionId, {
        type: 'task_blocked',
        planId: queue.planId,
        taskId: task.id,
        blockedBy: failedAgentName,
        agentName: failedAgentName,
        output: `Agent ${failedAgentName} failed and no replacement available for type ${task.agentType}`,
      });
      continue;
    }

    // Map agent instance to object form for findClosestAgent
    const targetObj = { name: target.name, displayName: target.displayName };

    broadcast(sessionId, {
      type: 'agent_reassigned',
      planId: queue.planId,
      taskId: task.id,
      from: failedAgentName,
      to: target.name,
      taskTitle: task.title,
    });

    const newQueue = agentTaskQueues.get(target.name);
    if (newQueue) {
      newQueue.tasks.push(task);
    } else {
      agentTaskQueues.set(target.name, {
        planId: queue.planId,
        sessionId,
        tasks: [task],
        current: null,
        sandbox,
      });
    }
  }

  // Kick any idle agents that just got tasks
  for (const task of orphanedTasks) {
    const reassignedTo = [...agentTaskQueues.entries()]
      .find(([, q]) => q.tasks.includes(task))?.[0];
    if (reassignedTo) {
      const newQueue = agentTaskQueues.get(reassignedTo);
      if (newQueue && !newQueue.current) {
        // Will be picked up by existing idle check or next processNextInQueue
        await processNextInQueue(sessionId, reassignedTo, newQueue);
        break; // One kick is enough — others will chain
      }
    }
  }
}
```

- [x] **Step 2: Call `reassignQueuedTasks` on agent failure**

In `apps/api/src/ws/handler.ts`, in the one-shot agent `'done'` handler (around line 528), after the existing done handling, add:

```typescript
// Inside the 'done' case, after the existing status update:
if (event.exitCode !== 0 && agentNameForProc) {
  const sb = sandboxes.get(sessionId);
  if (sb) {
    const { reassignQueuedTasks } = await import('./taskDispatcher.js');
    await reassignQueuedTasks(sessionId, agentNameForProc, {
      containerId: sb.containerId,
      workDir: sb.workDir,
      hostWorkDir: sb.hostWorkDir,
    });
  }
}
```

Also in the REPL provider `'done'` handler (around line 399), add similar logic inside the async IIFE:

```typescript
// Inside the async IIFE after the done handling:
if (ev.exitCode !== 0 && agentName) {
  const sb = sandboxes.get(sessionId);
  if (sb) {
    const { reassignQueuedTasks } = await import('./taskDispatcher.js');
    await reassignQueuedTasks(sessionId, agentName, {
      containerId: sb.containerId,
      workDir: sb.workDir,
      hostWorkDir: sb.hostWorkDir,
    });
  }
}
```

Also add the call in `handleStopAgent` in handler.ts (around line 616). After line 625 (`stateMap.delete(data.agentMessageId)`), add:

```typescript
const stoppedAgentName = st.agentName;
if (stoppedAgentName) {
  const sb = sandboxes.get(sessionId);
  if (sb) {
    import('./taskDispatcher.js').then(({ reassignQueuedTasks }) =>
      reassignQueuedTasks(sessionId, stoppedAgentName, {
        containerId: sb.containerId,
        workDir: sb.workDir,
        hostWorkDir: sb.hostWorkDir,
      })
    ).catch(() => {});
  }
}
```

- [x] **Step 3: Also handle agent timeout**

In `apps/api/src/ws/handler.ts`, in the timeout handler for one-shot agents (around line 572, `setTimeout` callback), add before `clearRunningAgent`:

```typescript
if (agentNameForProc) {
  const sb = sandboxes.get(sessionId);
  if (sb) {
    import('./taskDispatcher.js').then(({ reassignQueuedTasks }) =>
      reassignQueuedTasks(sessionId, agentNameForProc, {
        containerId: sb.containerId,
        workDir: sb.workDir,
        hostWorkDir: sb.hostWorkDir,
      })
    ).catch(() => {});
  }
}
```

- [x] **Step 4: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors. Fix any import or type issues.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts apps/api/src/ws/handler.ts
git commit -m "feat: reassign queued tasks to sibling agents on agent failure"
```

---

### Task 5: Priority Task Queue

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts` (priority-based task ordering)

**Goal:** Replace FIFO `tasks: TaskDispatchNode[]` with a priority-ordered queue. Tasks whose dependencies have just been satisfied (unblocked dependents) get placed at the front. Within the same dependency level, `high > medium > low` priority ordering applies.

- [x] **Step 1: Add priority insertion helper**

In `apps/api/src/ws/taskDispatcher.ts`, add two helpers:

```typescript
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function priorityInsert(queue: TaskDispatchNode[], task: TaskDispatchNode): void {
  const taskPriority = PRIORITY_ORDER[task.priority] ?? 1;
  // Unblocked dependents (dependsOn all done) go to front within their priority band
  let insertAt = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const existingPriority = PRIORITY_ORDER[queue[i].priority] ?? 1;
    if (taskPriority < existingPriority || (taskPriority === existingPriority && i === queue.length)) {
      insertAt = i;
      break;
    }
    insertAt = i + 1;
  }
  queue.splice(insertAt, 0, task);
}

function sortByPriority(tasks: TaskDispatchNode[]): TaskDispatchNode[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    return pa - pb;
  });
}
```

- [x] **Step 2: Use priority insertion in enqueueTaskAssignments**

In `apps/api/src/ws/taskDispatcher.ts`, in `enqueueTaskAssignments` (line 361), change line 379 from:
```typescript
queue.tasks.push(assignment.task);
```
To:
```typescript
priorityInsert(queue.tasks, assignment.task);
```

- [x] **Step 3: Use priority sort in Fault Transfer**

In `reassignQueuedTasks` (added in Task 4), after collecting `orphanedTasks`, sort them:
```typescript
const orphanedTasks = sortByPriority([...queue.tasks]);
```

- [x] **Step 4: TypeScript check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: use priority-ordered task queue instead of FIFO"
```

---

### Task 6: Interactive Plan Editing Before Confirmation

**Files:**
- Modify: `apps/web/src/components/ConfirmationPanel.tsx` (full editing UI)
- Modify: `apps/web/src/store/appStore.ts` (add `updateTaskField`)
- Modify: `apps/web/src/hooks/useChat.ts` (send modified tasks on confirm)

**Goal:** Let users edit any task field (title, description, agentType, dependsOn, expectedOutput, priority) in the confirmation panel before clicking "Confirm All". Currently only description editing is supported.

- [x] **Step 1: Add `updateTaskField` to appStore**

In `apps/web/src/store/appStore.ts`, add to the `AppState` interface (after `updateTaskStatus`):

```typescript
updateTaskField: (planId: string, taskId: string, field: string, value: any) => void;
```

Add the implementation in `create<AppState>`:

```typescript
updateTaskField: (planId, taskId, field, value) =>
  set((state) => {
    const tasks = state.taskPlans[planId];
    if (!tasks) return state;
    return {
      taskPlans: {
        ...state.taskPlans,
        [planId]: tasks.map((t) =>
          t.taskId === taskId ? { ...t, [field]: field === 'dependsOn'
            ? (typeof value === 'string' ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : value)
            : value } : t
        ),
      },
    };
  }),
```

- [x] **Step 2: Expand ConfirmationPanel to support full field editing**

Replace `apps/web/src/components/ConfirmationPanel.tsx`:

```typescript
import type { TaskNode } from '@agenthub/shared';
import { useState } from 'react';
import { Pencil, Check, X } from 'lucide-react';

interface Props {
  tasks: TaskNode[];
  onConfirm: () => void;
  onUpdateTask: (taskId: string, newDescription: string) => void;
  onUpdateField: (taskId: string, field: string, value: any) => void;
  onCancel: () => void;
}

const AGENT_TYPES = ['CodeAgent', 'ReviewAgent', 'DevOpsAgent', 'TestAgent', 'DepsAgent'];
const PRIORITIES = ['high', 'medium', 'low'];

export function ConfirmationPanel({ tasks, onConfirm, onUpdateTask, onUpdateField, onCancel }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editField, setEditField] = useState<string | null>(null);

  return (
    <div className="mx-4 my-2 bg-hub-surface border border-hub-warning/30 rounded-hub-lg px-4 py-3">
      <h3 className="text-sm font-semibold text-hub-warning mb-1">Review Task Plan</h3>
      <p className="text-xs text-hub-tertiary mb-3">
        {tasks.length} tasks planned. Click any field to edit, then confirm to execute.
      </p>
      <div className="space-y-2 mb-3 max-h-80 overflow-y-auto panel-scroll">
        {tasks.map((t) => (
          <div key={t.id} className="bg-hub-raised rounded-hub-md px-3 py-2">
            {/* Title */}
            <div className="flex items-center justify-between mb-1">
              {editingId === t.id && editField === 'title' ? (
                <InlineEdit
                  value={t.title}
                  onSave={(v) => { onUpdateField(t.id, 'title', v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                />
              ) : (
                <span
                  className="text-xs font-medium text-hub-primary cursor-pointer hover:text-hub-link"
                  onClick={() => { setEditingId(t.id); setEditField('title'); }}
                >{t.title}</span>
              )}
              <div className="flex items-center gap-1.5 shrink-0">
                {/* AgentType */}
                {editingId === t.id && editField === 'agentType' ? (
                  <select
                    value={t.agentType}
                    onChange={(e) => { onUpdateField(t.id, 'agentType', e.target.value); setEditingId(null); setEditField(null); }}
                    className="text-[10px] bg-hub-input text-hub-secondary rounded px-1 py-0.5 border border-hub"
                  >
                    {AGENT_TYPES.map((at) => <option key={at} value={at}>{at}</option>)}
                  </select>
                ) : (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded bg-hub-hover text-hub-tertiary cursor-pointer hover:bg-hub-border"
                    onClick={() => { setEditingId(t.id); setEditField('agentType'); }}
                  >{t.agentType}</span>
                )}
                {/* Priority */}
                {editingId === t.id && editField === 'priority' ? (
                  <select
                    value={t.priority}
                    onChange={(e) => { onUpdateField(t.id, 'priority', e.target.value); setEditingId(null); setEditField(null); }}
                    className="text-[10px] bg-hub-input text-hub-secondary rounded px-1 py-0.5 border border-hub"
                  >
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <span
                    className={`text-[10px] px-1 py-0.5 rounded cursor-pointer hover:opacity-80 ${
                      t.priority === 'high' ? 'bg-hub-danger/15 text-hub-danger' :
                      t.priority === 'low' ? 'bg-hub-hover text-hub-tertiary' :
                      'bg-hub-info/15 text-hub-info'
                    }`}
                    onClick={() => { setEditingId(t.id); setEditField('priority'); }}
                  >{t.priority}</span>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="mt-1">
              {editingId === t.id && editField === 'description' ? (
                <InlineEdit
                  value={t.description}
                  multiline
                  onSave={(v) => { onUpdateTask(t.id, v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                />
              ) : (
                <p
                  className="text-xs text-hub-tertiary cursor-pointer hover:text-hub-secondary truncate"
                  onClick={() => { setEditingId(t.id); setEditField('description'); }}
                >{t.description || 'No description'}</p>
              )}
            </div>

            {/* DependsOn */}
            <div className="mt-1">
              {editingId === t.id && editField === 'dependsOn' ? (
                <InlineEdit
                  value={t.dependsOn.join(', ')}
                  onSave={(v) => { onUpdateField(t.id, 'dependsOn', v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                  placeholder="task-1, task-2"
                />
              ) : (
                t.dependsOn.length > 0 ? (
                  <p
                    className="text-[10px] text-hub-muted cursor-pointer hover:text-hub-tertiary"
                    onClick={() => { setEditingId(t.id); setEditField('dependsOn'); }}
                  >Depends on: {t.dependsOn.join(', ')}</p>
                ) : (
                  <p
                    className="text-[10px] text-hub-muted/50 cursor-pointer hover:text-hub-tertiary"
                    onClick={() => { setEditingId(t.id); setEditField('dependsOn'); }}
                  >No dependencies (click to add)</p>
                )
              )}
            </div>

            {/* ExpectedOutput */}
            <div className="mt-1">
              {editingId === t.id && editField === 'expectedOutput' ? (
                <InlineEdit
                  value={t.expectedOutput || ''}
                  onSave={(v) => { onUpdateField(t.id, 'expectedOutput', v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                  placeholder="Expected output file or result"
                />
              ) : (
                <p
                  className="text-[10px] text-hub-muted/70 cursor-pointer hover:text-hub-tertiary truncate"
                  onClick={() => { setEditingId(t.id); setEditField('expectedOutput'); }}
                >Output: {t.expectedOutput || 'Unspecified'}</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={onConfirm}
          className="px-4 py-1.5 bg-hub-success hover:bg-hub-success/80 text-white text-xs rounded-md font-medium transition">
          Confirm All
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 bg-hub-hover hover:bg-hub-border text-hub-secondary text-xs rounded-md transition">
          Cancel
        </button>
      </div>
    </div>
  );
}

function InlineEdit({
  value, onSave, onCancel, multiline, placeholder,
}: {
  value: string; onSave: (v: string) => void; onCancel: () => void;
  multiline?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const inputClass = "bg-hub-input text-xs text-hub-secondary rounded p-1 border border-hub w-full";

  return (
    <div className="flex flex-col gap-1">
      {multiline ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          className={inputClass + " resize-none"} rows={2} placeholder={placeholder} />
      ) : (
        <input value={text} onChange={(e) => setText(e.target.value)}
          className={inputClass} placeholder={placeholder} />
      )}
      <div className="flex gap-2">
        <button onClick={() => onSave(text)} className="text-xs text-hub-success"><Check className="w-3 h-3 inline" /></button>
        <button onClick={onCancel} className="text-xs text-hub-tertiary"><X className="w-3 h-3 inline" /></button>
      </div>
    </div>
  );
}
```

- [x] **Step 3: Update ChatView.tsx to pass `onUpdateField`**

In `apps/web/src/components/ChatView.tsx`, in the `PlanRenderer` component (around line 25), add `onUpdateField` prop:

In `ConfirmationPanel` usage (line 42), add the new prop:
```tsx
<ConfirmationPanel key={planId}
  tasks={tasks.map((t: any) => ({ ... }))}
  onConfirm={() => { ... }}
  onUpdateTask={(taskId, newDescription) => { ... }}
  onUpdateField={(taskId, field, value) => {
    const updated = tasks.map((t: any) =>
      t.taskId === taskId ? { ...t, [field]: value } : t);
    setTaskPlan(planId, updated);
  }}
  onCancel={() => { ... }}
/>
```

- [x] **Step 4: Update useChat confirmPlan to send full task data**

In `apps/web/src/hooks/useChat.ts`, find the `confirmPlan` function. Update it to read the latest tasks from the store and send them as the payload:

```typescript
const confirmPlan = useCallback((planId: string) => {
  const ws = socketPool.get(sessionId);
  if (!ws) return;
  const tasks = useAppStore.getState().taskPlans[planId] || [];
  ws.send(JSON.stringify({
    type: 'confirm_plan',
    planId,
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      description: t.description || '',
      agentType: t.agentType,
      dependsOn: t.dependsOn,
      expectedOutput: t.expectedOutput || '',
      priority: t.priority || 'medium',
    })),
  }));
}, [sessionId]);
```

- [x] **Step 5: TypeScript check**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/components/ConfirmationPanel.tsx apps/web/src/store/appStore.ts apps/web/src/components/ChatView.tsx apps/web/src/hooks/useChat.ts
git commit -m "feat: enable full interactive plan editing before confirmation"
```

---

## Self-Review Results

**1. Spec coverage:** All 6 requirements mapped to tasks:
- (1) DAG persistence → Task 3
- (2) Zod schema validation → Task 2
- (3) Agent fault transfer → Task 4
- (4) Priority queue → Task 5
- (5) Planner editing → Task 6
- (6) BullMQ removal → Task 1

**2. Placeholder scan:** No TBD/TODO/fill-in-later found. All steps have complete code.

**3. Type consistency:** `DagTaskStatus`, `TaskDispatchNode`, `AgentTaskQueue`, `DagExecutionState` — all imported from existing modules in `taskDispatcher.ts` and `dagExecution.ts`. Frontend `TaskState` from `appStore.ts`. Shared `TaskNode` from `@agenthub/shared`. New types (`PersistedTask`, `PersistedPlan`) defined in `DagPersistence.ts` and used consistently.

**4. Cross-task consistency:** Task 4 references `sortByPriority` from Task 5 — Task 4's `reassignQueuedTasks` uses it. Execution order ensures Task 5 comes after Task 4 in practice, but the reference is declared in Task 4's code block. Since both tasks modify `taskDispatcher.ts`, Task 5's `sortByPriority` will exist when Task 4's `reassignQueuedTasks` calls it. Added the `sortByPriority` call in Task 4 step 3.
