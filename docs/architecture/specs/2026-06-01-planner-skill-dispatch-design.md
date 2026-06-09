# Planner Skill-Based Task Dispatch

Date: 2026-06-01

## Problem

Planner task dispatch is triggered by `extractAndValidate()` parsing LLM text output in `AgentRuntime.handleAgentEvent`. The Planner produces `plan.json` with an agent-specific schema that doesn't match `PlanValidator`'s zod schema — wrong field names (`dependencies` vs `dependsOn`), suffixed `agentType` values (`code-agent-2a593a92` vs `code-agent`), and missing required fields. Parse failure → `plan_result` never broadcast → frontend never shows confirmation → `dispatchTasksToAgents` never called. No fallback.

## Solution Overview

Replace the fragile text-parsing approach with a skill-driven pipeline:

1. Inject two Claude Code skills into Planner's `.claude/skills/` directory
2. Planner reads skills, outputs standardized `plan.json` to `/workspace/`
3. Hub file watcher detects `plan.json`, normalizes, risk-assesses, dispatches

## Architecture

```
Session created / agent added or removed
        │
        ▼
  CapabilityInventory.regenerate(sessionId)
        │
        ├──▶ cap-inventory.md ──▶ Planner .claude/skills/
        │    (markdown agent list + valid agentType enum)
        │
        ▼
  Planner receives task request
        │
        ▼
  Reads cap-inventory.md + plan-and-dispatch.md (skills)
        │
        ▼
  Writes /workspace/plan.json
        │
        ▼
  planWatcher.ts (fs.watch on hostWorkDir)
        │
        ├── normalizePlan()       field mapping + agentType suffix strip
        ├── validateBasic()       must have non-empty tasks array
        ├── assessRisk()          any task.risk="high" → high overall
        │
   ┌────┴────┐
   ▼         ▼
 high       low
   │         │
   ▼         ▼
 broadcast  dispatchTasksToAgents()
 confirm    (immediate)
 panel
        │
        ▼
  Fallback path (if no plan.json within 3s of Planner done):
  extractAndValidate from text → normalize → dispatch
```

## Component Design

### 1. Shared Types (`packages/shared/src/types.ts`)

```typescript
interface PlanTask {
  id: string;
  title: string;
  description: string;
  agentType: string;       // matches cap-inventory values
  dependsOn: string[];
  expectedOutput: string;
  risk: "low" | "high";
}

interface Plan {
  planTitle: string;
  summary: string;
  tasks: PlanTask[];
}
```

### 2. Skill: cap-inventory.md

- **name**: `cap-inventory`
- **auto_load**: true (loaded on session start)
- **Content**: Markdown table of all session agents with role, capabilities, constraints, input/output, and valid `agentType` value. Includes a Schema Reference section listing exact `agentType` enum values.
- **Hot reload**: Regenerated on session creation, agent add, agent remove, agent config change. If Planner is mid-session, inbox push notifies of update.

### 3. Skill: plan-and-dispatch.md

- **name**: `plan`
- **Trigger**: User requests like "plan X", "规划", "拆解任务", "分配任务", "DAG", or explicit `/plan`
- **Workflow**: Read cap-inventory → analyze requirement → decompose tasks → Write `/workspace/plan.json` → announce completion
- **Risk rules**: low = read-only, new files, tests, review; high = delete files, DB schema changes, destructive git, untrusted scripts
- **Schema**: JSON schema matching `Plan` interface, with concrete examples

### 4. CapabilityInventory (`apps/api/src/agent/CapabilityInventory.ts`)

- `generate(sessionId)`: reads all session agents from DB, builds cap-inventory.md, writes to `{hostWorkDir}/_agent_planner-xxx/.claude/skills/cap-inventory.md`
- `regenerate(sessionId)`: same as generate, called on membership change events
- Hook points: `AgentDirectoryManager.initialize`, session agent add/remove handlers in `handler.ts`

### 5. PlanNormalizer (`apps/api/src/agent/PlanNormalizer.ts`)

- `normalizePlan(raw)`: field mapping (`dependencies`→`dependsOn`, `output`→`expectedOutput`, `planId`/`title`→`planTitle`), strips session suffix from `agentType` (`code-agent-xxx`→`code-agent`)
- `validateBasic(plan)`: checks `tasks` is non-empty array, `planTitle` is non-empty string. Does NOT validate `agentType` against enum — dispatcher does final matching.

### 6. PlanWatcher (`apps/api/src/ws/planWatcher.ts`)

- `startWatching(hostWorkDir, sessionId)`: `fs.watch` on `{hostWorkDir}/plan.json`
- Debounce 100ms before reading
- Dedup: hash `planTitle + tasks.map(id).join()` against last processed hash
- Flow: detect → read → normalize → validate → assessRisk → dispatch or broadcast confirm
- Error handling: JSON parse failure (ignore, wait for next write), validation failure (inbox notify Planner), dispatch failure (broadcast error, keep in queue)
- `stopWatching(sessionId)`: called on session destroy

### 7. Fallback Path (existing `AgentRuntime.handleAgentEvent`)

- Keep the `extractAndValidate` call in the `done` event handler
- If `plan_result` fires AND planWatcher hasn't processed a plan.json within 3s, take the text-parsed plan through the same normalize→assessRisk→dispatch path
- This handles cases where Planner can't use Write tool but still outputs valid plan text

### 8. Planner Prompt Changes

Remove inline `sessionMemberBlock` injection in `handler.ts` (the simple name:description list). Replace with a short directive:
```
读取你的 skill cap-inventory.md 获取可用 agent 能力清单。规划任务时 agentType 使用清单中的值。
```

### 9. Dispatcher Enhancement

`dispatchTasksToAgents` uses session member list for final agent matching, not `agentType` string alone. If `agentType` matches no session member, broadcast `agent_missing` with suggested alternatives.

## Implementation Phases

### Phase 1: Shared Types + Normalizer
- 1.1 Define `PlanTask`/`Plan` in `packages/shared/src/types.ts`
- 1.2 Create `PlanNormalizer.ts` with `normalizePlan()` + `validateBasic()`

### Phase 2: Capability Inventory
- 2.1 Create `CapabilityInventory.ts` with `generate()`/`regenerate()`
- 2.2 Wire into `AgentDirectoryManager.initialize`
- 2.3 Wire into session agent add/remove handlers

### Phase 3: Plan Skill Injection
- 3.1 Create `plan-and-dispatch.md` template
- 3.2 Write both skills in `AgentDirectoryManager.initialize` for Planner agents
- 3.3 Remove inline `sessionMemberBlock` from `handler.ts`

### Phase 4: Plan Watcher
- 4.1 Create `planWatcher.ts`
- 4.2 Start/stop watcher with sandbox lifecycle
- 4.3 Wire fallback path in `AgentRuntime.handleAgentEvent`

### Phase 5: Dispatcher Enhancement
- 5.1 Final agent matching by session members in `taskDispatcher.ts`
- 5.2 Enhanced `agent_missing` event with user-confirmable suggestions

## Risks

- **fs.watch may not work on all filesystems** (NFS, Docker bind mounts): fall back to polling with a 500ms interval if native watch fails
- **Planner may output plan.json incrementally**: debounce + JSON parse failure retry handles this
- **Concurrent plan writes**: only one Planner per session writes plans; hash dedup handles re-writes
