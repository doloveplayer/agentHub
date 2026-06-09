# AgentHub Phase 3 — Core UI Design (Tier 1)

> Status: Draft · Date: 2026-05-20

## Key Decisions

1. **React Flow for DAG visualization**: Use @xyflow/react library for node graph rendering. Custom node component with status-colored borders (gray/teal/green/red, per project design tokens) and progress bar for running tasks.
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
| waiting | #3a3a3a (border-default) | #1e1e1e (bg-root) | ⏸ muted text |
| running/queued | #4fd1c5 (accent-primary) | #1a2a2a | 🔄 teal progress bar |
| done | #38a169 (accent-success) | #1a2e1a | ✅ green |
| failed | #e53e3e (accent-danger) | #3a1e1e | ❌ red + Retry button |

> Note: Color values updated 2026-05-25 to match the Understand Anything dashboard redesign. All status colors now use CSS custom properties defined in `apps/web/src/index.css`.

## Verification

- [x] TaskCard renders in chat stream after Planner returns
- [x] DAG nodes positioned correctly with edge arrows
- [x] Status colors update reactively on WS events
- [x] Confirmation buttons trigger correct WS messages
- [x] Retry button re-enqueues failed task
