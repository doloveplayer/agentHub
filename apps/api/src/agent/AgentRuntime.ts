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
  startTask(
    input: AgentTaskInput,
    onEvent: (event: ParsedEvent) => void,
  ): Promise<AgentTaskResult>;
  cancelTask(taskId: string): Promise<void>;
}
