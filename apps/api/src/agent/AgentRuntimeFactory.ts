import { ClaudeAgentSDK, mapAllowedTools, mapPermissionMode } from "./ClaudeAgentSDK.js";
import type { AgentRuntime, AgentRuntimeSource, AgentTaskInput, AgentTaskResult } from "./AgentRuntime.js";
import type { ParsedEvent } from "./EventParser.js";

/**
 * Claude SDK implementation of AgentRuntime.
 * Uses @anthropic-ai/claude-agent-sdk to drive Claude Code.
 */
class ClaudeRuntime implements AgentRuntime {
  readonly source: AgentRuntimeSource = "claude";

  async startTask(
    input: AgentTaskInput,
    onEvent: (event: ParsedEvent) => void,
  ): Promise<AgentTaskResult> {
    const sdk = new ClaudeAgentSDK();
    const profile = input.permissionProfile ?? "read_only";
    const taskId = `claude-${input.nodeRunId}`;
    const startedAt = new Date().toISOString();

    try {
      const result = await sdk.stream(input.prompt, {
        cwd: input.workingDirectory ?? process.cwd(),
        model: input.modelId,
        permissionMode: mapPermissionMode(profile),
        allowedTools: input.tools.length > 0 ? input.tools : mapAllowedTools(profile),
        skills: input.skillIds,
        outputFormat: input.outputSchema
          ? { type: "json_schema" as const, schema: input.outputSchema }
          : undefined,
        persistSession: true,
      }, (event) => {
        onEvent(event);
      });

      const status = result.exitCode === 0 ? "succeeded" as const : "failed" as const;
      // Pass structured output as JSON string when available (ManagerLoop uses it)
      const output = result.structuredOutput
        ? JSON.stringify(result.structuredOutput)
        : result.output;
      return {
        taskId,
        runId: taskId,
        sessionKey: result.sessionId || `claude-session-${input.nodeRunId}`,
        source: "claude",
        status,
        output,
        error: status === "failed" ? `Exit code: ${result.exitCode}` : undefined,
        updatedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        taskId,
        runId: taskId,
        sessionKey: `claude-session-${input.nodeRunId}`,
        source: "claude",
        status: "failed",
        error: error.message ?? "Unknown SDK error",
        updatedAt: startedAt,
      };
    }
  }

  async cancelTask(_taskId: string): Promise<void> {
    // SDK handles cancellation via AbortController in streaming
  }
}

/**
 * Stub for Codex runtime — not yet implemented.
 */
class CodexRuntime implements AgentRuntime {
  readonly source: AgentRuntimeSource = "codex";

  async startTask(
    input: AgentTaskInput,
    _onEvent: (event: ParsedEvent) => void,
  ): Promise<AgentTaskResult> {
    return {
      taskId: `codex-${input.nodeRunId}`,
      runId: `codex-${input.nodeRunId}`,
      sessionKey: `codex-session-${input.nodeRunId}`,
      source: "codex",
      status: "failed",
      error: "Codex runtime not yet implemented",
      updatedAt: new Date().toISOString(),
    };
  }

  async cancelTask(_taskId: string): Promise<void> {}
}

/**
 * Stub for OpenClaw runtime — not yet implemented.
 */
class OpenClawRuntime implements AgentRuntime {
  readonly source: AgentRuntimeSource = "openclaw";

  async startTask(
    input: AgentTaskInput,
    _onEvent: (event: ParsedEvent) => void,
  ): Promise<AgentTaskResult> {
    return {
      taskId: `openclaw-${input.nodeRunId}`,
      runId: `openclaw-${input.nodeRunId}`,
      sessionKey: `openclaw-session-${input.nodeRunId}`,
      source: "openclaw",
      status: "failed",
      error: "OpenClaw runtime not yet implemented",
      updatedAt: new Date().toISOString(),
    };
  }

  async cancelTask(_taskId: string): Promise<void> {}
}

const runtimes = new Map<AgentRuntimeSource, AgentRuntime>();

export function getAgentRuntime(source: AgentRuntimeSource): AgentRuntime {
  const existing = runtimes.get(source);
  if (existing) return existing;

  let runtime: AgentRuntime;
  switch (source) {
    case "claude": runtime = new ClaudeRuntime(); break;
    case "codex": runtime = new CodexRuntime(); break;
    case "openclaw": runtime = new OpenClawRuntime(); break;
    default: throw new Error(`Unknown agent source: ${source}`);
  }

  runtimes.set(source, runtime);
  return runtime;
}

export function registerAgentRuntime(source: AgentRuntimeSource, runtime: AgentRuntime): void {
  runtimes.set(source, runtime);
}
