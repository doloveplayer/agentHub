# AgentHub Phase 3 — Core Infrastructure Design (Tier 0)

> Status: Complete · Date: 2026-05-20 · Updated: 2026-05-21

## Key Decisions

1. **Planner as Claude Code subprocess**: Planner Agent reuses ClaudeCodeProcess, not a separate AI service. System prompt forces JSON output with strict schema.
2. **BullMQ over manual scheduling**: Redis-backed task queue with automatic retry, priority ordering, and concurrency control. Dependencies handled via topological sort layering, not BullMQ's FlowProducer (simpler, adequate for 3-8 task plans).
3. **Context via filesystem probing**: Before execution, probe sandbox for file tree + package.json. Inject project context into every task prompt. Previous task outputs referenced by file path.

## Architecture

```
User complex requirement
    ↓
PlannerAgent.plan() → Claude Code subprocess in sandbox
    ↓ (system prompt + JSON schema)
Claude Code outputs TaskPlan JSON → balanced-brace extraction
    ↓
TaskQueueManager.submitPlan()
    ├── topologicalSort(tasks) → ordered layers
    └── queue.addBulk(layer) → BullMQ enqueue with priority
    ↓
Worker processes each task:
    buildContextPrompt(task, projectContext, previousOutputs)
    → ClaudeCodeProcess.start() → stdout stream → result
    ↓
onTaskComplete callback → WebSocket → frontend progress update
```

## File Structure

```
apps/api/src/agent/
  PlannerAgent.ts        # static plan(): Claude Code → TaskPlan JSON
  TaskQueue.ts           # TaskQueueManager: submitPlan, startWorker, blockDependents
  ProjectContext.ts      # probeProjectContext, buildContextPrompt
  SandboxManager.ts      # [modified] execCapture(): non-streaming command output

packages/shared/src/
  types.ts               # [modified] TaskNode, TaskPlan, TaskPlanResult
```

## Key Interfaces

```
TaskNode { id, title, description, agentType, dependsOn[], expectedOutput, priority }
TaskPlan { planTitle, summary, tasks: TaskNode[] }
TaskJobData { planId, sessionId, task: TaskNode, contextPrompt, containerId, workDir, hostWorkDir }
```

## Verification

- [x] TypeScript compiles (api + web)
- [x] Planner registered as default agent, visible via GET /api/agents
- [x] Topological sort handles cyclic dependencies (fallback to final layer)
- [x] Balanced-brace JSON extraction survives surrounding text
- [x] Redis connectivity confirmed at localhost:6379
