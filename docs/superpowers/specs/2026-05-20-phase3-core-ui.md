# AgentHub Phase 3 — Core UI Design (Tier 1)

> Status: Draft · Date: 2026-05-20

## Key Decisions

1. **React Flow for DAG visualization**: Use @xyflow/react library for node graph rendering. Custom node component with status-colored borders (gray/blue/green/red) and progress bar for running tasks.
2. **TaskCard as message bubble subtype**: DAG visualization rendered inline in chat stream, not as a separate panel. Confirmation panel appears below the DAG card before execution begins.
3. **WebSocket-driven status updates**: Worker task lifecycle events (start/progress/complete/fail) pushed to frontend via new WS message types. Frontend updates individual node states reactively.

## Architecture

```
Planner returns TaskPlan JSON
    ↓
Frontend renders TaskCard message bubble:
    ├── [Header] planTitle + summary + progress counter
    ├── [Body] React Flow DAG with CustomTaskNode
    └── [Footer] ConfirmationPanel (Confirm/Cancel/Edit per task)
    ↓
User confirms → WS confirm_plan → Backend calls TaskQueueManager.submitPlan()
    ↓
Worker events → WS task_status messages → frontend updates node states
    ↓
On failure → TaskCard shows red nodes with retry button
```

## File Structure

```
apps/web/src/components/
  TaskDAG.tsx              # React Flow DAG with CustomTaskNode
  TaskCard.tsx             # Message bubble wrapper (header + DAG + actions)
  ConfirmationPanel.tsx    # Per-task edit + Confirm/Cancel buttons

apps/web/src/store/
  appStore.ts              # [modified] TaskState, setTaskPlan, updateTaskStatus

apps/api/src/ws/
  handler.ts               # [modified] New WS types: confirm_plan, modify_task, retry_task
```

## New WebSocket Message Types

| Type | Direction | Payload |
|------|-----------|---------|
| `confirm_plan` | C→S | planId, sessionId |
| `modify_task` | C→S | planId, taskId, newDescription |
| `retry_task` | C→S | planId, taskId |
| `task_status` | S→C | planId, taskId, status, progress, log? |

## Key Interfaces

```
TaskState { taskId, planId, title, agentType, status: 'waiting'|'running'|'done'|'failed', dependsOn[], progress? }
```

## Node Status Styling

| Status | Border | Background | Indicator |
|--------|--------|------------|-----------|
| waiting | #475569 (slate-600) | #1e293b (slate-800) | ⏸ gray text |
| running | #3b82f6 (blue-500) | #1e3a5f | 🔄 blue progress bar |
| done | #22c55e (green-500) | #1e3a3a | ✅ green |
| failed | #ef4444 (red-500) | #3a1e1e | ❌ red + Retry button |

## Verification

- [x] TaskCard renders in chat stream after Planner returns
- [x] DAG nodes positioned correctly with edge arrows
- [x] Status colors update reactively on WS events
- [x] Confirmation buttons trigger correct WS messages
- [x] Retry button re-enqueues failed task
