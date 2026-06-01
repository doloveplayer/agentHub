# Task Router PPTX Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the interrupted fixes so reused task providers close the currently running agent card and PPTX artifacts remain previewable when `pptx-preview` fails.

**Architecture:** Move mutable task-run routing state into `apps/api/src/ws/taskEventRouter.ts` and make `taskDispatcher.ts` register the current task run before both reused-provider and new-provider execution paths. Add a lightweight `pptxFallback` parser/renderer path that extracts slide content directly from `.pptx` ZIP XML and lets `PptxViewer.tsx` render visible fallback slides instead of only showing an error/download message.

**Tech Stack:** TypeScript, Node test runner, JSZip, React, Vite.

---

### Task 1: Verify Current Task Event Router Coverage

**Files:**
- Test: `apps/api/src/ws/taskEventRouter.test.ts`
- Modify: `apps/api/src/ws/taskEventRouter.ts` if the test exposes missing behavior.

- [ ] **Step 1: Inspect the current router test**

Confirm the test sets an older task run, replaces it with a newer task run for the same `sessionId` and `agentName`, appends output, and verifies clearing the old task message id does not clear the newer run.

- [ ] **Step 2: Run the focused router test**

Run:

```bash
npx tsx --test apps/api/src/ws/taskEventRouter.test.ts
```

Expected RED if routing state is not correctly implemented; expected GREEN if the interrupted work already completed this unit.

### Task 2: Route Reused Provider Events Through Current Run State

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`
- Test: `apps/api/src/ws/taskEventRouter.test.ts`

- [ ] **Step 1: Inspect provider reuse and creation branches**

In `processNextInQueue()`, locate both the branch that calls `provider.sendPrompt()` for a reusable provider and the branch that starts a new provider with `provider.start()`.

- [ ] **Step 2: Register current run before execution in both branches**

Before either `sendPrompt()` or `start()`, call:

```typescript
setActiveTaskRun({
  sessionId,
  agentName,
  planId: queue.planId,
  taskId: task.id,
  taskMessageId,
  queue,
  task,
});
```

- [ ] **Step 3: Use the shared event handler for both branches**

Ensure `registerProviderTaskEventHandler(sessionId, agentName, provider)` is called for every provider and that the callback dynamically reads `getActiveTaskRun(sessionId, agentName)` when each event arrives. Keep `stream_chunk`, `stream_end`, `task_completed`, `task_failed`, `clearRunningAgent()`, and `processNextInQueue()` behavior in that shared handler.

- [ ] **Step 4: Run the focused router test**

Run:

```bash
npx tsx --test apps/api/src/ws/taskEventRouter.test.ts
```

Expected: PASS.

### Task 3: Add PPTX Fallback Parser Coverage

**Files:**
- Create/Modify: `apps/web/src/lib/pptxFallback.ts`
- Test: `apps/web/src/lib/pptxFallback.test.ts`

- [ ] **Step 1: Inspect or add the parser test**

Use the PawCare `.pptx` fixture in the workspace if available. The test must load the real file as bytes, call the fallback parser, assert two slides are returned, and assert text/shape content is extracted.

- [ ] **Step 2: Run the focused parser test**

Run:

```bash
npx tsx --test apps/web/src/lib/pptxFallback.test.ts
```

Expected RED if the parser is incomplete; expected GREEN if the interrupted work already completed it.

### Task 4: Render Fallback Slides In The Viewer

**Files:**
- Modify: `apps/web/src/components/PptxViewer.tsx`
- Modify: `apps/web/src/lib/pptxFallback.ts`
- Test: `apps/web/src/lib/pptxFallback.test.ts`

- [ ] **Step 1: Keep `pptx-preview` as the first rendering path**

Leave the existing successful preview path unchanged.

- [ ] **Step 2: On preview failure, parse the same `ArrayBuffer` with `parsePptxFallback()`**

If fallback parsing returns slides, set viewer state to render those slides as positioned blocks using text and shape metadata.

- [ ] **Step 3: Preserve download as an auxiliary action**

Keep the download button visible, but do not make the error/download text the only visible content when fallback parsing succeeds.

- [ ] **Step 4: Run the focused parser test**

Run:

```bash
npx tsx --test apps/web/src/lib/pptxFallback.test.ts
```

Expected: PASS.

### Task 5: Verification And Review

**Files:**
- Review touched task-router and PPTX files only.

- [ ] **Step 1: Run focused tests**

```bash
npx tsx --test apps/api/src/ws/taskEventRouter.test.ts apps/web/src/lib/pptxFallback.test.ts
```

- [ ] **Step 2: Run TypeScript checks**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 3: Run frontend build**

```bash
npm run build --workspace @agenthub/web
```

- [ ] **Step 4: Verify PPTX fallback visually**

Use a temporary Playwright page or Vite-served app route to confirm `PawCare_Structure.pptx` renders visible slide content and is not only an error/download message.

- [ ] **Step 5: Apply the project review checklist**

Confirm scope, file boundaries, compatibility, exceptional states, and duplication. Report any verification command that could not be run.
