# Borrow HiveWard Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Borrow 5 proven modules from HiveWard (same-domain multi-agent orchestration platform) to fix AgentHub's core defects: static DAG execution, no runtime approval gate, fragile CLI spawn, single-platform lock-in, and read-only DAG visualization.

**Architecture:** Three layers of changes: (1) Execution layer — replace `docker run` CLI spawn with Claude Agent SDK for typed streaming + native session/permission/structured-output; (2) Orchestration layer — add Manager-style dynamic dispatch loop on top of existing DAG for runtime re-planning + approval gates; (3) Adapter layer — extract provider-agnostic `AgentRuntime` interface so Codex/OpenCode drop in without touching orchestration code.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, existing Docker sandbox, React Flow (already in project), Zustand

---

## File Structure

```
apps/api/src/agent/
  ClaudeAgentSDK.ts        (NEW) — SDK wrapper replacing ClaudeCodeProcess.ts
  AgentRuntime.ts           (NEW) — Provider-agnostic runtime interface
  AgentRuntimeFactory.ts    (NEW) — Route to Claude/Codex/OpenCode runtime
  ManagerLoop.ts            (NEW) — Manager-style dynamic dispatch loop
  ApprovalGate.ts           (NEW) — Agent output approval with multi-round reply
  EventParser.ts            (DELETE or archive) — SDK returns typed messages

apps/api/src/ws/
  taskDispatcher.ts         (MODIFY) — Integrate ManagerLoop + ApprovalGate
  handler.ts                (MODIFY) — Route approval events to ApprovalGate

apps/web/src/components/
  ApprovalPanel.tsx          (NEW) — Runtime approval UI with reply/select/reject
  BlueprintEditor.tsx        (NEW) — Editable DAG: drag nodes, connect edges, edit config

packages/shared/src/
  types.ts                   (MODIFY) — Add ApprovalGate, AgentRuntime types
```

---

### Task 1: Claude Agent SDK Wrapper (replace CLI spawn)

**Files:**
- Create: `apps/api/src/agent/ClaudeAgentSDK.ts`
- Modify: `apps/api/src/agent/processFactory.ts`
- Archive: `apps/api/src/agent/ClaudeCodeProcess.ts` (keep for reference, stop importing)
- Archive: `apps/api/src/agent/EventParser.ts` (keep for reference, stop importing)

**Context:** Current `ClaudeCodeProcess.ts` spawns `docker run ... sh -c "cat prompt.txt | claude --print ..."` then parses `stream-json` via `EventParser.ts` (206 lines). This has 5 problems: (a) 200-500ms container startup per message, (b) manual `stream-json` parsing is fragile, (c) `--resume` session ID must be tracked manually, (d) permission proxy requires kill+recreate container, (e) no structured output validation.

HiveWard's `claude-runtime.ts` wraps `@anthropic-ai/claude-agent-sdk`'s `query()` which returns an async iterable of typed `SDKMessage`. Session management (`resume`), permissions (`permissionMode`), tools (`allowedTools`), structured output (`outputFormat`), and thinking control are all SDK-native.

**Design decision:** SDK runs on host with `cwd` pointing to Docker bind-mounted workspace. This eliminates per-message container startup while keeping filesystem isolation (container still exists for workspace). Agent process isolation is traded for SDK-level permission control which is more granular than our current trust-mode binary.

- [x] **Step 1: Install `@anthropic-ai/claude-agent-sdk`**

```bash
cd apps/api && npm install @anthropic-ai/claude-agent-sdk
```

- [x] **Step 2: Write ClaudeAgentSDK wrapper**

```typescript
// apps/api/src/agent/ClaudeAgentSDK.ts
import { query, type Options, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ParsedEvent } from "./EventParser.js";

export interface SDKStreamOptions {
  prompt: string;
  cwd: string;
  model?: string;
  resume?: string;               // session ID for continuation
  permissionMode?: Options["permissionMode"];
  allowedTools?: string[];
  outputFormat?: Options["outputFormat"];
  skills?: string[];
  thinking?: boolean;
  effort?: Options["effort"];
  abortController?: AbortController;
  maxTurns?: number;
}

export interface SDKResult {
  sessionId: string;
  output: string;
  exitCode: number;
  structuredOutput?: unknown;
}

export type SDKEventHandler = (event: ParsedEvent) => void;

export class ClaudeAgentSDK {
  private abortController: AbortController | null = null;

  async stream(prompt: string, options: SDKStreamOptions, onEvent: SDKEventHandler): Promise<SDKResult> {
    this.abortController = options.abortController ?? new AbortController();

    const sdkOptions: Options = {
      cwd: options.cwd,
      model: options.model,
      resume: options.resume,
      permissionMode: options.permissionMode ?? "default",
      allowedTools: options.allowedTools ?? [],
      skills: options.skills,
      thinking: options.thinking,
      effort: options.effort,
      maxTurns: options.maxTurns,
      settingSources: ["user", "project"],
      abortController: this.abortController,
    };

    if (options.outputFormat) {
      sdkOptions.outputFormat = options.outputFormat;
    }

    let sessionId = options.resume ?? "";
    let outputText = "";
    let structuredOutput: unknown;
    let finalMessage: SDKResultMessage | undefined;

    try {
      for await (const message of query({ prompt, options: sdkOptions })) {
        if ("session_id" in message && typeof message.session_id === "string") {
          sessionId = message.session_id;
        }

        switch (message.type) {
          case "assistant": {
            // Extract text from content blocks
            for (const block of message.message.content) {
              if (block.type === "text") {
                outputText += block.text;
                onEvent({ type: "text", content: block.text });
              } else if (block.type === "tool_use") {
                onEvent({
                  type: "tool_use",
                  toolName: block.name,
                  input: block.input as Record<string, unknown>,
                });
              }
            }
            break;
          }
          case "tool_result": {
            if (typeof message.content === "string") {
              onEvent({ type: "tool_result", content: message.content });
            }
            break;
          }
          case "result": {
            finalMessage = message;
            break;
          }
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError" || this.abortController.signal.aborted) {
        return { sessionId, output: outputText, exitCode: 1 };
      }
      onEvent({ type: "error", message: error.message ?? String(error) });
      return { sessionId, output: outputText, exitCode: 1 };
    }

    if (!finalMessage) {
      return { sessionId, output: outputText, exitCode: 1 };
    }

    const success = finalMessage.subtype === "success";
    structuredOutput = finalMessage.structured_output;

    return {
      sessionId,
      output: success ? (finalMessage.result ?? outputText) : outputText,
      exitCode: success ? 0 : 1,
      structuredOutput,
    };
  }

  kill(): void {
    this.abortController?.abort("cancelled");
  }
}
```

- [x] **Step 3: Implement permission mode mapping**

HiveWard maps `permissionProfile` (user-configured) → SDK `permissionMode` + `allowedTools`. Copy this mapping:

```typescript
// In ClaudeAgentSDK.ts, add:
export type AgentPermissionProfile = "read_only" | "accept_edits" | "default" | "bypass";

export function mapPermissionMode(profile: AgentPermissionProfile): Options["permissionMode"] {
  switch (profile) {
    case "read_only":    return "default";     // SDK default = read-only
    case "accept_edits": return "acceptEdits";  // Auto-approve file edits
    case "default":      return "default";
    case "bypass":       return "bypassPermissions";
  }
}

export function mapAllowedTools(profile: AgentPermissionProfile): string[] {
  switch (profile) {
    case "read_only":    return ["Read", "Grep", "Glob", "Bash"];
    case "accept_edits": return ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "NotebookEdit"];
    case "default":      return [];
    case "bypass":       return [];
  }
}
```

- [x] **Step 4: Update processFactory to use ClaudeAgentSDK**

```typescript
// apps/api/src/agent/processFactory.ts — replace ClaudeCodeProcess import
import { ClaudeAgentSDK } from "./ClaudeAgentSDK.js";

export function createOneShotAgentProcess(): OneShotAgentProcess {
  if (config.agent.provider === "test") return new TestAgentProcess();
  if (config.agent.provider === "claude-code") return new ClaudeAgentSDKAdapter();
  throw new Error(`Unknown agent provider: ${config.agent.provider}`);
}

// Adapter: ClaudeAgentSDK → OneShotAgentProcess interface
class ClaudeAgentSDKAdapter implements OneShotAgentProcess {
  private sdk: ClaudeAgentSDK | null = null;
  private handlers: Array<(event: ParsedEvent) => void> = [];

  onEvent(handler: (event: ParsedEvent) => void): void {
    this.handlers.push(handler);
  }

  async start(sessionId: string, prompt: string, _containerId: string, workDir: string,
              trustMode?: boolean, hostWorkDir?: string, _promptFileId?: string,
              claudeSessionId?: string, _agentConfigId?: string): Promise<void> {
    this.sdk = new ClaudeAgentSDK();
    const cwd = hostWorkDir || workDir;
    const profile: AgentPermissionProfile = trustMode ? "bypass" : "read_only";
    const result = await this.sdk.stream(prompt, {
      cwd,
      resume: claudeSessionId,
      permissionMode: mapPermissionMode(profile),
      allowedTools: mapAllowedTools(profile),
    }, (event) => {
      for (const h of this.handlers) h(event);
    });
    // done event is emitted inside stream() via result handling
  }

  write(input: string): void { /* SDK handles stdin internally */ }
  kill(): void { this.sdk?.kill(); }
}
```

- [x] **Step 5: Remove docker run overhead for one-shot tasks**

Current `ClaudeCodeProcess.startDockerRun()` constructs `docker run ... agenthub-sandbox`. With SDK running on host and `cwd` pointing to bind-mounted workspace, Docker container only needs to exist for filesystem isolation — not for process execution. Update `dispatchTaskOneShot` in `taskDispatcher.ts`:

```typescript
// In dispatchTaskOneShot(), replace:
//   proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, true, sandbox.hostWorkDir, ...)
// With:
//   proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.hostWorkDir ?? sandbox.workDir, true, sandbox.hostWorkDir, ...)
// The SDK uses hostWorkDir as cwd — container isolation is still provided for filesystem via bind mount.
```

- [x] **Step 6: Verify: TypeScript compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [x] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json
git add apps/api/src/agent/ClaudeAgentSDK.ts apps/api/src/agent/processFactory.ts
git commit -m "feat: add Claude Agent SDK wrapper replacing CLI spawn"
```

---

### Task 2: AgentRuntime Interface (multi-platform abstraction)

**Files:**
- Create: `apps/api/src/agent/AgentRuntime.ts`
- Create: `apps/api/src/agent/AgentRuntimeFactory.ts`

**Context:** AgentHub currently has only `ClaudeCodeProcess`. HiveWard's `AgentSdkRuntime` interface + `AgentSdkRuntimeRouter` shows how to abstract Claude/Codex/OpenCode behind one interface so orchestration code never knows which platform runs a task.

HiveWard reference files: `packages/adapter/src/sdk-runtime/types.ts`, `packages/adapter/src/sdk-runtime/factory.ts`

- [x] **Step 1: Define AgentRuntime interface**

```typescript
// apps/api/src/agent/AgentRuntime.ts
import type { ParsedEvent } from "./EventParser.js";

export type AgentRuntimeSource = "claude" | "codex" | "openclaw";

export interface AgentTaskInput {
  nodeRunId: string;
  blueprintRunId: string;
  prompt: string;
  modelId?: string;
  workingDirectory?: string;
  permissionProfile?: "read_only" | "accept_edits" | "default" | "bypass";
  outputSchema?: Record<string, unknown>;
  skillIds?: string[];
  timeoutMs?: number;
  tools: string[];
}

export interface AgentTaskResult {
  taskId: string;
  runId: string;
  sessionKey: string;
  source: AgentRuntimeSource;
  status: "succeeded" | "failed" | "cancelled";
  output?: string;
  error?: string;
  updatedAt: string;
}

export interface AgentRuntime {
  readonly source: AgentRuntimeSource;
  startTask(input: AgentTaskInput, onEvent: (event: ParsedEvent) => void): Promise<AgentTaskResult>;
  cancelTask(taskId: string): Promise<void>;
}
```

- [x] **Step 2: Implement AgentRuntimeFactory**

```typescript
// apps/api/src/agent/AgentRuntimeFactory.ts
import type { AgentRuntime, AgentRuntimeSource } from "./AgentRuntime.js";
import { ClaudeAgentSDK } from "./ClaudeAgentSDK.js";

export class AgentRuntimeFactory {
  private static runtimes = new Map<AgentRuntimeSource, AgentRuntime>();

  static register(source: AgentRuntimeSource, runtime: AgentRuntime): void {
    this.runtimes.set(source, runtime);
  }

  static get(source: AgentRuntimeSource): AgentRuntime {
    const runtime = this.runtimes.get(source);
    if (runtime) return runtime;
    if (source === "claude") {
      const claude = new ClaudeSDKRuntime();
      this.runtimes.set("claude", claude);
      return claude;
    }
    throw new Error(`No runtime registered for source: ${source}`);
  }
}
```

- [x] **Step 3: Commit**

```bash
git add apps/api/src/agent/AgentRuntime.ts apps/api/src/agent/AgentRuntimeFactory.ts
git commit -m "feat: add AgentRuntime interface and factory for multi-platform abstraction"
```

---

### Task 3: Manager Loop (dynamic dispatch replacing static DAG topology)

**Files:**
- Create: `apps/api/src/agent/ManagerLoop.ts`
- Modify: `apps/api/src/ws/taskDispatcher.ts`

**Context:** Current `taskDispatcher.ts` uses `consumeReadyTasks()` — nodes with all dependencies satisfied fire simultaneously, purely based on static DAG topology. Once a node fails, all dependents are blocked — no re-planning, no alternative path.

HiveWard's `blueprintWorker.ts` Manager pattern: a Manager node runs its own Agent that reads upstream results, then picks the next slot to delegate to (`{ status: "continue", nextSlot: 3, reason: "..." }`). This enables: (a) dynamic slot ordering based on upstream output, (b) QA-fail → return to build slot for rework, (c) skip slots when upstream makes them unnecessary.

**We don't copy HiveWard's full Manager/Slot/Handoff model.** That adds conceptual complexity. Instead, we extend the existing DAG with a lightweight "review-and-redispatch" loop: when a task fails, instead of blocking dependents, the Main Agent gets the error context and produces an updated sub-DAG.

- [x] **Step 1: Define ManagerLoop decision types**

```typescript
// apps/api/src/agent/ManagerLoop.ts
import type { TaskDispatchNode } from "../ws/state.js";

export interface ManagerDecision {
  action: "continue" | "replan" | "abort";
  nextTasks?: TaskDispatchNode[];  // replacement sub-DAG if replan
  reason: string;
}

export interface FailureContext {
  failedTaskId: string;
  failedAgentName: string;
  error: string;
  output: string;
  upstreamResults: Array<{ taskId: string; output: string }>;
}
```

- [x] **Step 2: Implement ManagerLoop.reviewAndDecide()**

This calls the Main Agent with failure context and gets a decision:

```typescript
export class ManagerLoop {
  constructor(private runtime: AgentRuntime) {}

  async reviewAndDecide(
    planId: string,
    sessionId: string,
    failure: FailureContext,
    remainingTasks: TaskDispatchNode[],
  ): Promise<ManagerDecision> {
    const prompt = [
      "You are the Main Agent (PM) for a DAG execution.",
      `Plan: ${planId}`,
      "",
      "A task has failed:",
      `- Task: ${failure.failedTaskId}`,
      `- Agent: ${failure.failedAgentName}`,
      `- Error: ${failure.error}`,
      `- Output: ${failure.output.slice(0, 2000)}`,
      "",
      "Upstream results:",
      ...failure.upstreamResults.map(r => `- ${r.taskId}: ${r.output.slice(0, 500)}`),
      "",
      "Remaining tasks that are now blocked:",
      ...remainingTasks.map(t => `- ${t.id}: ${t.title} (agent: ${t.agentType})`),
      "",
      "Decide:",
      "- If the error is fixable by re-running the same task, return action=continue",
      "- If the plan needs restructuring (new tasks, different agents), return action=replan with nextTasks",
      "- If the failure is fatal, return action=abort",
      "Return JSON: { action: 'continue'|'replan'|'abort', reason: string, nextTasks?: TaskDispatchNode[] }",
    ].join("\n");

    const result = await this.runtime.startTask({
      nodeRunId: `manager-${planId}-${Date.now()}`,
      blueprintRunId: planId,
      prompt,
      tools: [],
    }, () => {});

    if (result.status !== "succeeded" || !result.output) {
      return { action: "abort", reason: "Main Agent failed to produce a decision" };
    }

    try {
      const decision = JSON.parse(result.output) as ManagerDecision;
      return decision;
    } catch {
      return { action: "abort", reason: "Main Agent returned unparseable decision" };
    }
  }
}
```

- [x] **Step 3: Wire ManagerLoop into handleDispatchedTaskFinished**

In `taskDispatcher.ts`, replace the current "block all dependents on failure" logic:

```typescript
// In handleDispatchedTaskFinished(), replace the failure branch:
if (!success) {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (!execution) return;

  // Collect failure context
  const failedTask = execution.tasks.get(taskId);
  const upstreamResults: Array<{ taskId: string; output: string }> = [];
  for (const [tid, item] of execution.tasks) {
    if (item.status === "done") {
      upstreamResults.push({ taskId: tid, output: item.task.title });
    }
  }

  const remainingTasks = [...execution.tasks.values()]
    .filter(t => t.status === "queued" || t.status === "blocked")
    .map(t => t.task);

  const failure: FailureContext = {
    failedTaskId: taskId,
    failedAgentName: failedTask?.agentName ?? "unknown",
    error: `Task ${taskId} failed`,
    output: "",
    upstreamResults,
  };

  const runtime = AgentRuntimeFactory.get("claude");
  const manager = new ManagerLoop(runtime);
  const decision = await manager.reviewAndDecide(planId, sessionId, failure, remainingTasks);

  broadcast(sessionId, {
    type: "manager_decision",
    planId,
    taskId,
    decision: decision.action,
    reason: decision.reason,
  });

  if (decision.action === "continue") {
    markTaskRetryQueued(execution, taskId);
    // Re-enqueue
  } else if (decision.action === "replan" && decision.nextTasks) {
    // Replace remaining tasks with re-planned ones
    await dispatchTasksToAgents(sessionId, planId, decision.nextTasks, sandboxes.get(sessionId)!);
  } else {
    // abort — mark all remaining as failed
    for (const [tid] of execution.tasks) {
      markTaskFailed(execution, tid);
    }
  }

  maybeBroadcastPlanSummary(sessionId, execution);
  await persistState(sessionId, planId, execution);
}
```

- [x] **Step 4: Verify: TypeScript compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/agent/ManagerLoop.ts apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: add ManagerLoop for dynamic DAG re-planning on task failure"
```

---

### Task 4: Approval Gate (runtime agent output review)

**Files:**
- Create: `apps/api/src/agent/ApprovalGate.ts`
- Create: `apps/web/src/components/ApprovalPanel.tsx`
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/web/src/components/ChatView.tsx`

**Context:** AgentHub has `ConfirmationPanel` for pre-execution plan review, but no runtime approval for individual Agent outputs. HiveWard's `AgentApprovalConfig` + `waiting_approval` status pauses blueprint execution until human reviews the output.

This is critical for: deployment commands, database migrations, external API calls — any agent action with irreversible side effects.

- [x] **Step 1: Define ApprovalGate types**

```typescript
// apps/api/src/agent/ApprovalGate.ts
import { nanoid } from "nanoid";

export interface ApprovalRequest {
  id: string;
  planId: string;
  taskId: string;
  agentName: string;
  output: unknown;
  replies: ApprovalReply[];
  status: "waiting" | "approved" | "rejected";
  selectedReplyId?: string;
  createdAt: string;
}

export interface ApprovalReply {
  id: string;
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

export class ApprovalGate {
  private pending = new Map<string, ApprovalRequest>(); // taskId → request
  private resolvers = new Map<string, (result: ApprovalResult) => void>();

  submit(taskId: string, planId: string, agentName: string, output: unknown): ApprovalRequest {
    const request: ApprovalRequest = {
      id: `approval-${nanoid(10)}`,
      planId,
      taskId,
      agentName,
      output,
      replies: [],
      status: "waiting",
      createdAt: new Date().toISOString(),
    };
    this.pending.set(taskId, request);
    return request;
  }

  async waitForDecision(taskId: string): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      this.resolvers.set(taskId, resolve);
    });
  }

  approve(taskId: string, comment?: string): void {
    const request = this.pending.get(taskId);
    if (!request) return;
    request.status = "approved";
    const resolve = this.resolvers.get(taskId);
    if (resolve) {
      resolve({ approved: true, comment, output: request.output });
      this.resolvers.delete(taskId);
    }
  }

  reject(taskId: string, comment?: string): void {
    const request = this.pending.get(taskId);
    if (!request) return;
    request.status = "rejected";
    const resolve = this.resolvers.get(taskId);
    if (resolve) {
      resolve({ approved: false, comment });
      this.resolvers.delete(taskId);
    }
  }

  addReply(taskId: string, role: "user" | "assistant", body: string): void {
    const request = this.pending.get(taskId);
    if (!request) return;
    request.replies.push({
      id: `reply-${nanoid(8)}`,
      role,
      body,
      createdAt: new Date().toISOString(),
    });
  }

  getPending(taskId: string): ApprovalRequest | undefined {
    return this.pending.get(taskId);
  }

  listPending(planId: string): ApprovalRequest[] {
    return [...this.pending.values()].filter(r => r.planId === planId);
  }
}

export interface ApprovalResult {
  approved: boolean;
  comment?: string;
  output?: unknown;
}
```

- [x] **Step 2: Add approval field to TaskDispatchNode**

```typescript
// In packages/shared/src/types.ts, add to TaskNode:
export interface TaskNode {
  // ... existing fields
  requiresApproval?: boolean;  // NEW
}
```

- [x] **Step 3: Wire ApprovalGate into taskDispatcher**

In `dispatchTaskOneShot` and `startTaskAgent`, after agent finishes successfully, check `requiresApproval`:

```typescript
// After 'done' event handler, before marking task complete:
if (task.requiresApproval && event.exitCode === 0) {
  const gate = getApprovalGate(); // singleton
  const request = gate.submit(task.id, queue.planId, agentName, output);

  broadcast(sessionId, {
    type: "approval_required",
    planId: queue.planId,
    taskId: task.id,
    agentName,
    approvalId: request.id,
    output: output.slice(0, 500),
    replies: [],
  });

  const decision = await gate.waitForDecision(task.id);
  if (!decision.approved) {
    broadcast(sessionId, { type: "task_failed", planId: queue.planId, taskId: task.id, agentName, output: "Rejected by reviewer." });
    await handleDispatchedTaskFinished(sessionId, queue.planId, task.id, false);
    return;
  }
}
```

- [x] **Step 4: Add WebSocket handler for approval actions**

In `handler.ts`, add cases for:
```typescript
case "approval_approve":
  approvalGate.approve(data.taskId, data.comment);
  break;
case "approval_reject":
  approvalGate.reject(data.taskId, data.comment);
  break;
case "approval_reply":
  approvalGate.addReply(data.taskId, "user", data.message);
  // Re-trigger agent with reply context
  break;
```

- [x] **Step 5: Build ApprovalPanel frontend component**

```tsx
// apps/web/src/components/ApprovalPanel.tsx
// Renders when approval_required event received:
// - Shows agent output preview
// - Approve / Reject buttons
// - Multi-round reply chat (user types message, agent responds)
// Uses existing MessageBubble for reply rendering
```

- [x] **Step 6: Verify: TypeScript compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```

- [x] **Step 7: Commit**

```bash
git add apps/api/src/agent/ApprovalGate.ts apps/web/src/components/ApprovalPanel.tsx apps/api/src/ws/handler.ts apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: add runtime approval gate for agent outputs"
```

---

### Task 5: Blueprint Editor (editable DAG)

**Files:**
- Create: `apps/web/src/components/BlueprintEditor.tsx`
- Modify: `apps/web/src/components/TaskDAG.tsx` (rename or wrap)

**Context:** `TaskDAG.tsx` (190 lines) already renders DAG with React Flow but is read-only. HiveWard's `BlueprintStudioPage.tsx` is a full editor: drag new nodes from palette, connect edges, edit node config in side panel, import/export blueprint packages.

Making the DAG editable allows users to manually adjust the Main Agent's plan before execution, which is a frequently requested capability.

- [x] **Step 1: Add editable mode to TaskDAG**

```typescript
// Extend TaskDAG.tsx with editable mode:
interface TaskDAGProps {
  // ... existing props
  editable?: boolean;
  onNodesChange?: (nodes: TaskNode[]) => void;
  onEdgesChange?: (edges: TaskEdge[]) => void;
}
```

- [x] **Step 2: Add node palette for drag-to-create**

```tsx
// Add a sidebar palette with draggable agent types:
const NODE_TYPES = [
  { type: "agent", label: "Agent Task", color: "#3b82f6" },
  { type: "approval", label: "Approval Gate", color: "#f59e0b" },
  { type: "condition", label: "Condition", color: "#8b5cf6" },
];
```

- [x] **Step 3: Add edge creation with condition labels**

```tsx
// On connection create, show condition selector:
// - success (green)
// - failure (red)
// Default to "success"
```

- [x] **Step 4: Sync edited DAG back to plan**

When user finishes editing, emit updated DAG back to backend as modified plan:

```typescript
// On save, send via WebSocket:
socket.send(JSON.stringify({
  type: "plan_update",
  planId,
  nodes: updatedNodes,
  edges: updatedEdges,
}));
```

- [x] **Step 5: Verify: TypeScript compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [x] **Step 6: Commit**

```bash
git add apps/web/src/components/BlueprintEditor.tsx apps/web/src/components/TaskDAG.tsx
git commit -m "feat: add editable DAG blueprint editor"
```

---

## Verification Checklist

Before marking this plan complete, verify:

1. `npx tsc --noEmit -p apps/api/tsconfig.json` passes
2. `npx tsc --noEmit -p apps/web/tsconfig.json` passes
3. AgentHub starts with `bash scripts/startup.sh` without crash
4. Send a test message — agent responds via SDK (not CLI spawn)
5. Create a DAG plan with `requiresApproval: true` — execution pauses at approval gate
6. Approve the task — execution continues
7. Trigger a task failure — ManagerLoop emits `manager_decision` event
8. Edit DAG in BlueprintEditor — changes persist in plan state
