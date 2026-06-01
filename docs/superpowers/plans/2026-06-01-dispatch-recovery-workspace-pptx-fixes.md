# Dispatch Recovery Workspace PPTX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skill-written `plan.json` files produce visible task DAGs, dispatch to the intended session agents, use valid workspace file paths, and fail gracefully when browser PPTX preview cannot render a valid file.

**Architecture:** Keep the current skill-driven planner pipeline. Tighten normalization at the source, process existing `plan.json` files when a WebSocket session reconnects, restore persisted plans into the frontend store, and keep workspace file paths rooted at `/workspace`. PPTX files remain generated artifacts; the browser preview becomes best-effort with a clear download fallback.

**Tech Stack:** TypeScript, Hono, Prisma, WebSocket, Zustand, React, Node test runner.

---

### Task 1: Add Failing Normalizer And Workspace Path Tests

**Files:**
- Create: `apps/api/src/agent/PlanNormalizer.test.ts`
- Create: `apps/api/src/routes/workspaceTree.test.ts`

- [ ] **Step 1: Add a PlanNormalizer regression test**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, validateBasic } from './PlanNormalizer.js';

test('normalizePlan accepts planner project and subject fields with suffixed agent types', () => {
  const plan = normalizePlan({
    project: 'PawCare Clinic Hub Frontend Prototype',
    tasks: [
      {
        id: '1',
        subject: '初始化 Vite + React + TypeScript 项目',
        description: 'Create the frontend project',
        agentType: 'code-agent-8abd2c04',
        dependencies: [],
        risk: 'low',
      },
    ],
  });

  assert.equal(plan.planTitle, 'PawCare Clinic Hub Frontend Prototype');
  assert.equal(plan.tasks[0].title, '初始化 Vite + React + TypeScript 项目');
  assert.equal(plan.tasks[0].agentType, 'code-agent');
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.deepEqual(validateBasic(plan), { valid: true });
});
```

- [ ] **Step 2: Add a workspace tree path regression test**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readWorkspaceFileTreeForTest } from './workspace.js';

test('workspace file tree emits /workspace-relative paths, not host paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-workspace-tree-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true;');

    const tree = readWorkspaceFileTreeForTest(root, 'sandbox');
    const src = tree.find((node) => node.name === 'src');
    assert.equal(src?.path, '/workspace/src');
    assert.equal(src?.children?.[0]?.path, '/workspace/src/index.ts');
    assert.ok(!src?.children?.[0]?.path.includes(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the tests and confirm RED**

Run:

```bash
node --test apps/api/src/agent/PlanNormalizer.test.ts apps/api/src/routes/workspaceTree.test.ts
```

Expected: `PlanNormalizer` test fails because `project` and `subject` are not mapped; workspace test fails because `readWorkspaceFileTreeForTest` is not exported yet.

### Task 2: Fix Plan Normalization And Workspace Paths

**Files:**
- Modify: `apps/api/src/agent/PlanNormalizer.ts`
- Modify: `apps/api/src/routes/workspace.ts`

- [ ] **Step 1: Normalize observed planner fields**

Update `normalizePlan()` to use `raw.project` before falling back to `Untitled Plan`. Update `normalizeTask()` to use `t.subject` before falling back to an empty title.

- [ ] **Step 2: Root workspace tree paths at the scanned root**

Change `readFileTree()` to accept `workspaceRoot`, compute paths with `toWorkspacePath(workspaceRoot, fullPath)`, recurse with the same root, and export a `readWorkspaceFileTreeForTest()` wrapper.

- [ ] **Step 3: Run focused tests and confirm GREEN**

Run:

```bash
node --test apps/api/src/agent/PlanNormalizer.test.ts apps/api/src/routes/workspaceTree.test.ts
```

Expected: both tests pass.

### Task 3: Recover And Display Plans Reliably

**Files:**
- Modify: `apps/api/src/ws/planWatcher.ts`
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/web/src/hooks/useChat.ts`
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: Process existing `plan.json` on watcher startup**

After registering `fs.watch` or polling fallback, call `handlePlanFile(sessionId, planPath, sandbox)` on a short timer. This lets reconnects and refreshes re-broadcast an existing high-risk plan.

- [ ] **Step 2: Include plan metadata in recovery events**

When `handler.ts` broadcasts `plan_recovered`, include `planTitle` and `status` so the frontend can render the same task list after reconnect.

- [ ] **Step 3: Handle recovery and reassignment WebSocket events**

In `useChat.ts`, handle `plan_recovered` by calling `setTaskPlan(planId, tasks)`, handle `agent_reassigned` by updating the task assignment, and keep `plan_result` unchanged for new plans.

- [ ] **Step 4: Allow assignment updates on recovered plans**

If `setTaskAgent()` is called before a plan exists, leave state unchanged. If a recovered plan exists, update `assignedAgentId`, `assignedAgentName`, and status exactly like a live `task_assigned` event.

### Task 4: Make PPTX Preview Fail Gracefully

**Files:**
- Modify: `apps/web/src/components/PptxViewer.tsx`
- Modify: `apps/web/src/components/PptxCard.tsx`

- [ ] **Step 1: Normalize opaque preview errors**

Map library errors such as `t is undefined` or `Cannot read properties of undefined` to a user-facing message that says the PPTX was downloaded but browser preview cannot render this file.

- [ ] **Step 2: Keep a download action visible**

In `PptxCard`, when preview fails, show the normalized message and rely on the existing workspace download path so the valid `.pptx` can still be opened in PowerPoint or LibreOffice.

### Task 5: Verification And Review

**Files:**
- Review all touched files only.

- [ ] **Step 1: Run focused tests**

```bash
node --test apps/api/src/agent/PlanNormalizer.test.ts apps/api/src/routes/workspaceTree.test.ts
```

- [ ] **Step 2: Run TypeScript checks**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 3: Inspect diff and apply project checklist**

Check scope, file boundaries, compatibility, exceptional states, and duplication. Do not modify unrelated staged changes or the unstaged `package-lock.json` churn.
