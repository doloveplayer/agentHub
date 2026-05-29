import { getAgentRuntime } from "./AgentRuntimeFactory.js";
import type { AgentRuntime, AgentTaskInput } from "./AgentTaskRuntime.js";

export interface ManagerDecision {
  action: "continue" | "replan" | "abort";
  reason: string;
  /** Replacement tasks if action=replan */
  nextTasks?: ManagerTaskReplacement[];
}

export interface ManagerTaskReplacement {
  id: string;
  title: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  expectedOutput: string;
  priority: "low" | "medium" | "high";
}

export interface FailureContext {
  failedTaskId: string;
  failedAgentName: string;
  error: string;
  output: string;
  upstreamResults: Array<{ taskId: string; output: string }>;
  retryCount?: number;
  fileTree?: string;
  taskPrompt?: string;
}

const DECISION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["action", "reason"],
  properties: {
    action: { type: "string", enum: ["continue", "replan", "abort"] },
    reason: { type: "string" },
    nextTasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "description", "agentType", "expectedOutput"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          agentType: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          expectedOutput: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
};

/**
 * ManagerLoop: calls Main Agent on task failure to dynamically re-plan
 * instead of blindly blocking all dependents.
 *
 * Based on HiveWard's Manager-driven dispatch pattern, adapted for
 * AgentHub's existing DAG model.
 */
export class ManagerLoop {
  private runtime: AgentRuntime;

  constructor() {
    this.runtime = getAgentRuntime("claude");
  }

  async reviewAndDecide(
    planId: string,
    sessionId: string,
    failure: FailureContext,
    remainingTaskTitles: string[],
  ): Promise<ManagerDecision> {
    const retryContext = failure.retryCount && failure.retryCount > 0
      ? `该任务已失败 ${failure.retryCount} 次。` : '';
    const fileTreeSection = failure.fileTree
      ? `\n## Current file tree\n\`\`\`\n${failure.fileTree.slice(0, 2000)}\n\`\`\`\n`
      : '';
    const taskPromptSection = failure.taskPrompt
      ? `\n## Original task prompt\n${failure.taskPrompt.slice(0, 1000)}\n`
      : '';

    const prompt = [
      "You are the Main Agent (PM) for a DAG execution in AgentHub.",
      `Plan: ${planId} | Session: ${sessionId}`,
      "",
      "## Task Failure",
      `- Failed task: ${failure.failedTaskId}`,
      `- Agent: ${failure.failedAgentName}`,
      `- Error: ${failure.error}`,
      `- Output excerpt: ${failure.output.slice(0, 1500)}`,
      retryContext ? `- Retry status: ${retryContext}` : '',
      "",
      taskPromptSection,
      fileTreeSection,
      "## Upstream completed tasks",
      ...(failure.upstreamResults.length > 0
        ? failure.upstreamResults.map(r => `- ${r.taskId}: ${r.output.slice(0, 300)}`)
        : ["(no upstream tasks completed)"]),
      "",
      "## Remaining tasks (now blocked)",
      ...(remainingTaskTitles.length > 0
        ? remainingTaskTitles.map((t, i) => `${i + 1}. ${t}`)
        : ["(all tasks completed or blocked)"]),
      "",
      "## Decision",
      "Choose ONE action:",
      "- **continue**: the error is transient (network, timeout, fixable by retry). The same task should be retried.",
      "- **replan**: the plan needs restructuring. Provide replacement `nextTasks` that should execute instead of the remaining blocked tasks. New tasks can reference completed upstream tasks in `dependsOn`.",
      "- **abort**: the failure is fatal and cannot be recovered.",
      "",
      "Return JSON matching this schema:",
      '{ "action": "continue"|"replan"|"abort", "reason": "...", "nextTasks": [...] }',
      "",
      "For replan: each nextTask must have id, title, description, agentType, dependsOn (array of upstream task IDs), expectedOutput, priority.",
    ].filter(Boolean).join("\n");

    const input: AgentTaskInput = {
      nodeRunId: `manager-${planId}-${Date.now()}`,
      blueprintRunId: planId,
      prompt,
      tools: [],
      outputSchema: DECISION_OUTPUT_SCHEMA,
    };

    try {
      const result = await this.runtime.startTask(input, () => {});
      if (result.status !== "succeeded" || !result.output) {
        return { action: "abort", reason: "Main Agent failed to produce a decision" };
      }

      // Extract JSON from possible markdown wrapping
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: "abort", reason: "Main Agent output contained no valid JSON" };
      }

      const decision = JSON.parse(jsonMatch[0]) as ManagerDecision;
      if (!["continue", "replan", "abort"].includes(decision.action)) {
        return { action: "abort", reason: `Unknown action: ${decision.action}` };
      }
      return decision;
    } catch (error: any) {
      return { action: "abort", reason: `Manager decision error: ${error.message}` };
    }
  }
}

/** Singleton */
let _managerLoop: ManagerLoop | null = null;
export function getManagerLoop(): ManagerLoop {
  if (!_managerLoop) _managerLoop = new ManagerLoop();
  return _managerLoop;
}
