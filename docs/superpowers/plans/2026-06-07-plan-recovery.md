# Plan 断线恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 当 WebSocket 断线重连后，前端自动从后端恢复未完成的 DAG 计划状态，用户无需手动重新确认或丢失任务进度。

**Architecture:** 后端 `DagPersistence.recover(sessionId)` 已实现但未被调用。需要：(1) WS 连接成功后前端请求恢复；(2) 后端新增 REST 端点或 WS 消息类型返回未完成计划；(3) 前端 store 恢复 `taskPlans` 状态；(4) taskDispatcher 恢复执行上下文（如有正在运行的任务则标记为 failed 并允许重试）。

**Tech Stack:** Hono REST route, Prisma PlanExecution, Zustand store, WebSocket message type

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/src/routes/planRecovery.ts` | Create | REST endpoint: `GET /api/plans/:sessionId/recover` |
| `apps/api/src/index.ts` | Modify | Register planRecovery route |
| `apps/web/src/hooks/useChat.ts` | Modify | On WS `connected` event, call recovery API and restore plan state |
| `apps/web/src/store/appStore.ts` | Modify | Add `restoreTaskPlans(sessionId, plans)` action |
| `packages/shared/src/types.ts` | Modify | Add `PlanRecoveryResponse` type |

---

### Task 1: Add PlanRecoveryResponse shared type

**Files:**
- Modify: `packages/shared/src/types.ts`

- [x] **Step 1: Add the response type**

```typescript
// Add after the Plan interface (line ~185)
export interface RecoveredPlan {
  planId: string;
  sessionId: string;
  planTitle: string;
  status: 'executing' | 'pending_confirmation' | 'completed' | 'failed';
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    agentType: string;
    dependsOn: string[];
    expectedOutput: string;
    priority: string;
    agentName: string;
    agentId: string;
    status: string;
    dependents: string[];
  }>;
}

export interface PlanRecoveryResponse {
  plans: RecoveredPlan[];
}
```

- [x] **Step 2: Verify types compile**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json
```

Expected: no errors

- [x] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add RecoveredPlan and PlanRecoveryResponse shared types"
```

---

### Task 2: Create plan recovery REST endpoint

**Files:**
- Create: `apps/api/src/routes/planRecovery.ts`
- Modify: `apps/api/src/index.ts`

- [x] **Step 1: Create the recovery route**

```typescript
// apps/api/src/routes/planRecovery.ts
import { Hono } from 'hono';
import { prisma } from '../db/prisma.js';
import { DagPersistence } from '../agent/DagPersistence.js';

const planRecovery = new Hono();

// GET /api/plans/:sessionId/recover
// Returns all non-terminal plans (executing, pending_confirmation) for a session
planRecovery.get('/:sessionId/recover', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  // Verify session ownership
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const plans = await DagPersistence.recover(sessionId);
  return c.json({ plans });
});

export { planRecovery };
```

- [x] **Step 2: Register the route in index.ts**

Find the existing route registrations (around line where other routes are mounted) and add:

```typescript
import { planRecovery } from './routes/planRecovery.js';
// ... in the route mounting section:
app.route('/api/plans', planRecovery);
```

- [x] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors

- [x] **Step 4: Commit**

```bash
git add apps/api/src/routes/planRecovery.ts apps/api/src/index.ts
git commit -m "feat: add GET /api/plans/:sessionId/recover endpoint"
```

---

### Task 3: Add restoreTaskPlans to frontend store

**Files:**
- Modify: `apps/web/src/store/appStore.ts`

- [x] **Step 1: Add the restoreTaskPlans action**

Find the `taskPlans` state and `setTaskPlan` action in the store. Add `restoreTaskPlans`:

```typescript
// Add to the store interface and implementation:
restoreTaskPlans: (sessionId: string, plans: Array<{
  planId: string;
  planTitle: string;
  status: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    agentType: string;
    dependsOn: string[];
    expectedOutput: string;
    priority: string;
    agentName: string;
    agentId: string;
    status: string;
    dependents: string[];
  }>;
}>) => void;
```

Implementation:

```typescript
restoreTaskPlans: (sessionId, plans) => {
  set((state) => {
    const existing = state.taskPlans[sessionId] ?? [];
    // Merge: keep existing plans, add recovered ones that don't already exist
    const existingIds = new Set(existing.map(p => p.planId));
    const newPlans = plans
      .filter(p => !existingIds.has(p.planId))
      .map(p => ({
        planId: p.planId,
        planTitle: p.planTitle,
        status: p.status as any,
        tasks: p.tasks.map(t => ({
          ...t,
          status: t.status as any,
        })),
      }));
    return {
      taskPlans: {
        ...state.taskPlans,
        [sessionId]: [...existing, ...newPlans],
      },
    };
  });
},
```

- [x] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no errors

- [x] **Step 3: Commit**

```bash
git add apps/web/src/store/appStore.ts
git commit -m "feat: add restoreTaskPlans action to appStore"
```

---

### Task 4: Trigger plan recovery on WS connect

**Files:**
- Modify: `apps/web/src/hooks/useChat.ts`

- [x] **Step 1: Add recovery call after WS connected**

Find the `ws.onopen` handler (around line 77). After the existing `connected` message handling, add plan recovery:

```typescript
ws.onopen = () => {
  // ... existing onopen logic ...

  // Recover incomplete plans after successful connection
  if (sessionId) {
    api.recoverPlans(sessionId)
      .then((res) => {
        if (res.plans?.length > 0) {
          useAppStore.getState().restoreTaskPlans(sessionId, res.plans);
          console.log(`[WS] Recovered ${res.plans.length} plan(s) for session ${sessionId}`);
        }
      })
      .catch((err) => {
        // Non-fatal: plan recovery failure shouldn't block the session
        console.warn('[WS] Plan recovery failed:', err);
      });
  }
};
```

- [x] **Step 2: Add recoverPlans to api.ts**

In `apps/web/src/lib/api.ts`, add the method to the api object:

```typescript
recoverPlans: async (sessionId: string): Promise<{ plans: any[] }> => {
  const res = await fetch(`${BASE_URL}/plans/${sessionId}/recover`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`recoverPlans failed: ${res.status}`);
  return res.json();
},
```

- [x] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no errors

- [x] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useChat.ts apps/web/src/lib/api.ts
git commit -m "feat: trigger plan recovery on WS connect"
```

---

### Task 5: Handle in-flight tasks on recovery

**Files:**
- Modify: `apps/api/src/routes/planRecovery.ts`

When recovering plans that were `executing`, some tasks may have been `running` when the WS disconnected. These tasks are likely dead (the agent process may have been killed). The recovery endpoint should mark `running` tasks as `failed` so users can retry them.

- [x] **Step 1: Update recovery endpoint to fix stale running tasks**

```typescript
// apps/api/src/routes/planRecovery.ts
import { Hono } from 'hono';
import { prisma } from '../db/prisma.js';
import { DagPersistence } from '../agent/DagPersistence.js';

const planRecovery = new Hono();

planRecovery.get('/:sessionId/recover', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const plans = await DagPersistence.recover(sessionId);

  // Mark stale 'running' tasks as 'failed' — they can't resume after disconnect
  for (const plan of plans) {
    let needsUpdate = false;
    for (const task of plan.tasks) {
      if (task.status === 'running') {
        task.status = 'failed';
        needsUpdate = true;
      }
    }
    if (needsUpdate) {
      await DagPersistence.save(plan);
    }
  }

  return c.json({ plans });
});

export { planRecovery };
```

- [x] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors

- [x] **Step 3: Commit**

```bash
git add apps/api/src/routes/planRecovery.ts
git commit -m "feat: mark stale running tasks as failed during plan recovery"
```

---

### Task 6: End-to-end verification

- [x] **Step 1: Start the dev environment**

```bash
bash scripts/startup.sh
```

- [x] **Step 2: Create a group session and trigger a plan**

1. Open `http://localhost:5175`
2. Create a group session with Planner + CodeAgent
3. Send a message that triggers task planning (e.g., "请制定计划实现一个简单的登录页面")
4. Confirm the plan to start execution

- [x] **Step 3: Simulate disconnect during execution**

1. Open browser DevTools → Network tab
2. Throttle network to Offline
3. Wait 5 seconds
4. Go back online

- [x] **Step 4: Verify plan recovery**

After reconnection:
1. The TaskDAG should reappear with the correct task states
2. Tasks that were `running` should show as `failed` (with retry option)
3. Tasks that were `done` should remain `done`
4. Tasks that were `waiting` should remain `waiting`
5. Check console for `[WS] Recovered 1 plan(s) for session ...` log

- [x] **Step 5: Verify retry works**

Click retry on a failed task → it should re-execute normally.

- [x] **Step 6: Commit verification notes**

```bash
git add docs/superpowers/plans/2026-06-07-plan-recovery.md
git commit -m "docs: add plan recovery implementation plan and verification notes"
```
