// Task-to-Agent dispatch: routes Planner tasks to session agents via REPL.
// Extracted from handler.ts.

import { stateTracker } from '../agent/StateTracker.js';
import { findClosestAgent } from '../agent/turns.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { DagPersistence } from '../agent/DagPersistence.js';
import { agentCoordinator } from '../agent/AgentCoordinator.js';
import { getManagerLoop } from '../agent/ManagerLoop.js';
import { getApprovalGate } from '../agent/ApprovalGate.js';
import { detectLanguage, languageConsistencyPrompt } from '../agent/languageDetection.js';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { createSDKAgentProcess, createOneShotAgentProcess } from '../agent/processFactory.js';


/** Resolve trustMode boolean from session's permission mode. */
function resolveTrustMode(sessionId: string): boolean {
  const mode = sessionPermissionModes.get(sessionId) || 'ask';
  return mode === 'smart' || mode === 'trust';
}
import {
  createDagExecutionState,
  consumeReadyTasks,
  markTaskDone,
  markTaskFailed,
  markTaskRetryQueued,
  markTaskRunning,
  type DagExecutionState,
  type DagTaskAssignment,
} from './dagExecution.js';
import {
  broadcast, sessionPermissionModes, agentProcesses, agentStates, agentTaskQueues,
  agentCurrentTask, agentCurrentMessage, sandboxes,
  incRunningAgentCount, decRunningAgentCount,
  type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';
import {
  broadcastDiffSummary,
  recordMessageBeforeVersion,
  takeMessageBeforeVersion,
} from './diffBroadcast.js';

export { type AgentTaskQueue, type TaskDispatchNode };

const planExecutions = new Map<string, DagExecutionState>();
const MAX_PLAN_EXECUTIONS = 500;

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function priorityInsert(queue: TaskDispatchNode[], task: TaskDispatchNode): void {
  const taskPriority = PRIORITY_ORDER[task.priority] ?? 1;
  let insertAt = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const existingPriority = PRIORITY_ORDER[queue[i].priority] ?? 1;
    if (taskPriority < existingPriority) {
      insertAt = i;
      break;
    }
    insertAt = i + 1;
  }
  queue.splice(insertAt, 0, task);
}

function sortByPriority(tasks: TaskDispatchNode[]): TaskDispatchNode[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    return pa - pb;
  });
}

function resolveAgentNameInSession(sessionId: string, agentType: string): string | null {
  // Check active task queues
  const queueNames = [...agentTaskQueues.keys()];
  for (const name of queueNames) {
    if (name === agentType) return name;
  }
  // Check running agent processes
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    for (const [name] of procMap) {
      if (name === agentType) return name;
    }
  }
  // Not yet started — trust agentType as the agent name.
  // Built-in agents use name===type. Custom agents register with their name.
  return agentType;
}

function planKey(sessionId: string, planId: string): string {
  return `${sessionId}:${planId}`;
}

function buildTaskPrompt(task: TaskDispatchNode): string {
  return `Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}
${task.dependsOn.length > 0 ? `\nDepends on: ${task.dependsOn.join(', ')}\n` : ''}
Execute this task now. Output results to the specified files.`;
}

/** Collect a file tree snapshot from the sandbox host workdir. */
function collectFileTree(hostWorkDir: string): string {
  try {
    if (!fs.existsSync(hostWorkDir)) return '(workspace not found)';
    // Use find to get a tree, excluding node_modules and .git
    const output = execSync(
      `find . -maxdepth 4 -not -path './node_modules/*' -not -path './.git/*' -not -path './.sandbox/*' | head -200`,
      { cwd: hostWorkDir, encoding: 'utf-8', timeout: 5000 },
    );
    return output.trim() || '(empty workspace)';
  } catch {
    return '(unable to collect file tree)';
  }
}

/** Max auto-retries before escalating to ManagerLoop. */
const MAX_AUTO_RETRIES = 3;

function buildTaskMessageId(planId: string, taskId: string): string {
  return `task-${planId}-${taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export async function processNextInQueue(
  sessionId: string,
  agentName: string,
  queue: AgentTaskQueue,
): Promise<void> {
  if (queue.tasks.length === 0) {
    agentTaskQueues.delete(agentName);
    return;
  }

  const task = queue.tasks.shift()!;
  queue.current = task;
  agentCurrentTask.set(agentName, { planId: queue.planId, taskId: task.id });
  markTaskRunningForPlan(sessionId, queue.planId, task.id);

  const procInfo = agentProcesses.get(sessionId)?.get(agentName);

  if (procInfo && procInfo.provider.isAlive()) {
    const taskPrompt = buildTaskPrompt(task);
    const taskMessageId = buildTaskMessageId(queue.planId, task.id);
    recordMessageBeforeVersion(
      taskMessageId,
      queue.sandbox.hostWorkDir,
      sessionId,
      agentName,
      `Before ${agentName} task ${task.id}`,
    );
    agentCurrentMessage.set(agentName, taskMessageId);
    const taskMsg = await prisma.message.create({
      data: { id: taskMessageId, sessionId, senderType: 'agent', agentId: procInfo.agentId, content: '', status: 'streaming' },
    }).catch(() => null);
    if (taskMsg) {
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(taskMsg.id, {
        process: procInfo.provider, timer: procInfo.timer, agentId: procInfo.agentId, agentName,
      });
      incRunningAgentCount();
    }
    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: procInfo.agentId, taskMessageId });
    procInfo.provider.sendPrompt(taskPrompt);
  } else {
    // No REPL provider running — start one, then sendPrompt
    await startReplForTask(sessionId, agentName, task, queue);
  }
}

/**
 * Start a new REPL provider for a task (replaces one-shot dispatch).
 * Registers it in agentProcesses so subsequent tasks reuse it.
 */
async function startReplForTask(
  sessionId: string,
  agentName: string,
  task: TaskDispatchNode,
  queue: AgentTaskQueue,
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) return;
  const agent = await prisma.agent.findUnique({ where: { name: agentName }, select: { id: true, name: true, systemPrompt: true } });
  if (!agent) return;

  const taskMsgId = buildTaskMessageId(queue.planId, task.id);
  const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
    sessionId, agentName: agent.name, agentType: agent.name,
    messageId: taskMsgId, hostWorkDir: sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type), broadcast,
  });
  const fullPrompt = `${agent.systemPrompt}${languageConsistencyPrompt(detectLanguage(task.description || task.title))}\n\n---\n\n${buildTaskPrompt(task)}\n${coordinationPrompt}`;

  try {
    const { ProviderFactory } = await import('../agent/providers/factory.js');
    const provider = ProviderFactory.create('claude-code');

    let output = '';
    provider.onEvent((event) => {
      switch (event.type) {
        case 'thinking':
          output += event.content || '';
          broadcast(sessionId, { type: 'stream_chunk', content: event.content || '', agentMessageId: taskMsgId });
          break;
        case 'done':
          broadcast(sessionId, { type: 'stream_end', agentMessageId: taskMsgId, fullContent: output, exitCode: event.exitCode ?? 0 });
          broadcast(sessionId, { type: event.exitCode === 0 ? 'task_completed' : 'task_failed', planId: queue.planId, taskId: task.id, agentName, output: output.slice(0, 200) });
          stateTracker.setDone(taskMsgId);
          agentCurrentTask.delete(agentName);
          agentCurrentMessage.delete(agentName);
          queue.current = null;
          processNextInQueue(sessionId, agentName, queue);
          void handleDispatchedTaskFinished(sessionId, queue.planId, task.id, event.exitCode === 0);
          break;
        case 'error':
          broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: event.message || 'Unknown error' });
          agentCurrentTask.delete(agentName);
          agentCurrentMessage.delete(agentName);
          queue.current = null;
          processNextInQueue(sessionId, agentName, queue);
          break;
      }
    });

    await provider.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, {
      agentName, hostWorkDir: sandbox.hostWorkDir, trustMode: true,
    });

    if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
    agentProcesses.get(sessionId)!.set(agentName, {
      provider, timer: setTimeout(() => {}, config.agent.timeoutMs), agentId: agent.id,
    });
    agentCurrentMessage.set(agentName, taskMsgId);

    const taskMsg = await prisma.message.create({
      data: { id: taskMsgId, sessionId, senderType: 'agent', agentId: agent.id, content: '', status: 'streaming' },
    }).catch(() => null);
    if (taskMsg) {
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(taskMsg.id, { process: provider, timer: setTimeout(() => {}, config.agent.timeoutMs), agentId: agent.id, agentName });
      incRunningAgentCount();
    }
    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: agent.id, taskMessageId: taskMsgId });
    console.log(`[ws] Task REPL started: agent=${agentName} task=${task.id}`);
  } catch (err: any) {
    console.error(`[ws] Task REPL start failed: ${err.message}`);
    broadcast(sessionId, { type: 'task_failed', planId: queue.planId, taskId: task.id, agentName, output: `Failed to start: ${err.message}` });
    agentCurrentTask.delete(agentName);
    queue.current = null;
    void handleDispatchedTaskFinished(sessionId, queue.planId, task.id, false);
  }
}

// startTaskAgent — main entry point for task dispatch. Uses REPL providers from agentProcesses.
export async function startTaskAgent(
  sessionId: string,
  agent: { id: string; name: string; displayName: string; systemPrompt: string },
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const queue = agentTaskQueues.get(agent.name);
  if (!queue || queue.tasks.length === 0) return;

  // All task dispatch goes through REPL providers via processNextInQueue.
  // It checks agentProcesses for an existing provider; if none, startReplForTask creates one.
  await processNextInQueue(sessionId, agent.name, queue);
}

export async function dispatchTasksToAgents(
  sessionId: string,
  planId: string,
  tasks: TaskDispatchNode[],
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
  planTitle?: string,
): Promise<void> {
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true } } },
  });
  if (sessionAgents.length === 0) {
    broadcast(sessionId, { type: 'stream_error', error: 'No agents in this session to execute tasks' });
    return;
  }

  const agentsByType = new Map<string, typeof sessionAgents[number]['agent'][]>();
  for (const sa of sessionAgents) {
    const key = sa.agent.name.toLowerCase();
    const list = agentsByType.get(key) || [];
    list.push(sa.agent);
    agentsByType.set(key, list);
  }

  const loadByAgent = new Map<string, number>();
  const missingTypes = new Set<string>();
  const assignments: DagTaskAssignment[] = [];

  for (const task of tasks) {
    const candidates = agentsByType.get(task.agentType.toLowerCase()) || [];
    if (candidates.length === 0) {
      const suggested = findClosestAgent(task.agentType, sessionAgents.map(sa => sa.agent));
      if (suggested) {
        candidates.push(suggested as any);
        broadcast(sessionId, {
          type: 'agent_reassigned', planId, taskId: task.id,
          from: task.agentType, to: suggested.name,
          taskTitle: task.title,
        });
      } else {
        missingTypes.add(task.agentType);
        broadcast(sessionId, {
          type: 'agent_missing', planId, taskId: task.id,
          agentType: task.agentType, taskTitle: task.title,
          suggestedAgent: {
            name: task.agentType,
            displayName: task.agentType,
            description: `Auto-suggested ${task.agentType} for task: ${task.title}`,
          },
        });
        continue;
      }
    }
    let bestAgent = candidates[0];
    let bestLoad = Infinity;
    for (const a of candidates) {
      const q = agentTaskQueues.get(a.name);
      const load = (q ? q.tasks.length + (q.current ? 1 : 0) : 0) + (loadByAgent.get(a.name) || 0);
      if (load < bestLoad) { bestLoad = load; bestAgent = a; }
    }
    loadByAgent.set(bestAgent.name, (loadByAgent.get(bestAgent.name) || 0) + 1);
    assignments.push({
      task: {
        id: task.id, title: task.title, description: task.description,
        agentType: task.agentType, dependsOn: task.dependsOn,
        expectedOutput: task.expectedOutput, priority: task.priority || 'medium',
      },
      agentName: bestAgent.name,
      agentId: bestAgent.id,
    });
  }

  if (assignments.length === 0 && missingTypes.size > 0) return;

  const execution = createDagExecutionState(planId, assignments, planTitle);
  setPlanExecution(sessionId, planId, execution);
  await enqueueTaskAssignments(sessionId, planId, consumeReadyTasks(execution), sandbox);
}

export function prepareDispatchedTaskRetry(
  sessionId: string,
  planId: string,
  taskId: string,
): boolean {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (!execution) return false;
  return markTaskRetryQueued(execution, taskId) !== null;
}

export async function handleDispatchedTaskFinished(
  sessionId: string,
  planId: string,
  taskId: string,
  success: boolean,
): Promise<void> {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (!execution) return;

  if (success) {
    const ready = markTaskDone(execution, taskId);
    const sandbox = sandboxes.get(sessionId);
    if (sandbox && ready.length > 0) {
      await enqueueTaskAssignments(sessionId, planId, ready, sandbox);
    }
  } else {
    // Escalation chain: auto-retry → ManagerLoop re-plan → manual intervention
    const failedTask = execution.tasks.get(taskId);
    const failedAgentName = failedTask?.agentName ?? "unknown";
    const currentRetryCount = failedTask?.retryCount ?? 0;

    // Record the error for context
    if (failedTask) {
      failedTask.lastError = `Task execution failed (attempt ${currentRetryCount + 1})`;
    }

    // Collect context: upstream results, file tree, task prompt
    const upstreamResults: Array<{ taskId: string; output: string }> = [];
    const remainingTaskTitles: string[] = [];
    for (const [tid, item] of execution.tasks) {
      if (item.status === "done") {
        upstreamResults.push({ taskId: tid, output: item.task.title });
      } else if (item.status === "waiting" || item.status === "queued") {
        remainingTaskTitles.push(`${item.task.id}: ${item.task.title}`);
      }
    }

    const sandbox = sandboxes.get(sessionId);
    const fileTree = sandbox ? collectFileTree(sandbox.hostWorkDir) : undefined;
    const taskPrompt = failedTask ? buildTaskPrompt(failedTask.task) : undefined;

    // Stage 1: auto-retry (before max retries)
    if (currentRetryCount < MAX_AUTO_RETRIES) {
      console.log(`[dag] Auto-retrying task ${taskId} (attempt ${currentRetryCount + 1}/${MAX_AUTO_RETRIES})`);
      markTaskRetryQueued(execution, taskId);
      if (sandbox) {
        const retryAssignment = consumeReadyTasks(execution);
        if (retryAssignment.length > 0) {
          broadcast(sessionId, {
            type: "manager_decision",
            planId,
            taskId,
            decision: "continue",
            reason: `Auto-retry ${currentRetryCount + 1}/${MAX_AUTO_RETRIES}`,
          });
          await enqueueTaskAssignments(sessionId, planId, retryAssignment, sandbox);
        }
      }
    } else {
      // Stage 2: escalate to ManagerLoop for re-planning
      markTaskFailed(execution, taskId);

      const failure = {
        failedTaskId: taskId,
        failedAgentName,
        error: failedTask?.lastError ?? `Task execution failed after ${currentRetryCount} retries`,
        output: "",
        upstreamResults,
        retryCount: currentRetryCount,
        fileTree,
        taskPrompt,
      };

      broadcast(sessionId, { type: "manager_reviewing", planId, taskId, reason: `Task failed after ${currentRetryCount} retries, requesting Main Agent decision...` });

      try {
        const manager = getManagerLoop();
        const decision = await manager.reviewAndDecide(planId, sessionId, failure, remainingTaskTitles);

        broadcast(sessionId, {
          type: "manager_decision",
          planId,
          taskId,
          decision: decision.action,
          reason: decision.reason,
        });

        switch (decision.action) {
          case "continue": {
            markTaskRetryQueued(execution, taskId);
            const sb = sandboxes.get(sessionId);
            if (sb) {
              const retryAssignment = consumeReadyTasks(execution);
              if (retryAssignment.length > 0) {
                await enqueueTaskAssignments(sessionId, planId, retryAssignment, sb);
              }
            }
            break;
          }
          case "replan": {
            if (decision.nextTasks && decision.nextTasks.length > 0) {
              for (const t of decision.nextTasks) {
                execution.tasks.set(t.id, {
                  task: {
                    id: t.id,
                    title: t.title,
                    description: t.description,
                    agentType: t.agentType,
                    dependsOn: t.dependsOn,
                    expectedOutput: t.expectedOutput,
                    priority: t.priority || "medium",
                  },
                  agentName: t.agentType,
                  agentId: "",
                  status: "waiting",
                  dependents: [],
                  retryCount: 0,
                });
              }
              const sb = sandboxes.get(sessionId);
              if (sb) {
                const replanned = consumeReadyTasks(execution);
                if (replanned.length > 0) {
                  await enqueueTaskAssignments(sessionId, planId, replanned, sb);
                }
              }
            } else {
              // Stage 3: ManagerLoop returned abort → manual intervention needed
              const blocked = markTaskFailed(execution, taskId);
              broadcast(sessionId, {
                type: "replan_required",
                planId,
                taskId,
                failedTask: {
                  taskId,
                  title: failedTask?.task.title ?? taskId,
                  agentType: failedTask?.task.agentType ?? "unknown",
                  error: decision.reason,
                  retryCount: currentRetryCount,
                },
              });
              for (const item of blocked) {
                broadcast(sessionId, {
                  type: "task_blocked", planId, taskId: item.task.id,
                  blockedBy: taskId, agentName: item.agentName,
                  output: `Replan returned no tasks: ${decision.reason}`,
                });
              }
            }
            break;
          }
          case "abort":
          default: {
            const blocked = markTaskFailed(execution, taskId);
            broadcast(sessionId, {
              type: "replan_required",
              planId,
              taskId,
              failedTask: {
                taskId,
                title: failedTask?.task.title ?? taskId,
                agentType: failedTask?.task.agentType ?? "unknown",
                error: decision.reason,
                retryCount: currentRetryCount,
              },
            });
            for (const item of blocked) {
              broadcast(sessionId, {
                type: "task_blocked", planId, taskId: item.task.id,
                blockedBy: taskId, agentName: item.agentName,
                output: `Aborted: ${decision.reason}`,
              });
            }
            break;
          }
        }
      } catch (err: any) {
        // ManagerLoop itself failed — fall back to original blocking behavior
        console.error(`[dag] ManagerLoop error: ${err.message}`);
        const blocked = markTaskFailed(execution, taskId);
        broadcast(sessionId, {
          type: "replan_required",
          planId,
          taskId,
          failedTask: {
            taskId,
            title: failedTask?.task.title ?? taskId,
            agentType: failedTask?.task.agentType ?? "unknown",
            error: `ManagerLoop unavailable: ${err.message}`,
            retryCount: currentRetryCount,
          },
        });
        for (const item of blocked) {
          broadcast(sessionId, {
            type: "task_blocked", planId, taskId: item.task.id,
            blockedBy: taskId, agentName: item.agentName,
            output: `Blocked because dependency ${taskId} failed (ManagerLoop unavailable)`,
          });
        }
      }
    }
  }

  maybeBroadcastPlanSummary(sessionId, execution);
  persistState(sessionId, planId, execution).catch((err) =>
    console.error(`[dag] Persist error on task finish: ${err.message}`));
}

/**
 * Manual re-plan triggered from frontend "让 Main Agent 重新规划" button.
 * Collects full context and asks ManagerLoop to produce replacement tasks.
 */
export async function handleReplanFailedTask(
  sessionId: string,
  planId: string,
  taskId: string,
): Promise<void> {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (!execution) {
    broadcast(sessionId, { type: "stream_error", error: `Plan ${planId} not found` });
    return;
  }

  const failedTask = execution.tasks.get(taskId);
  if (!failedTask) {
    broadcast(sessionId, { type: "stream_error", error: `Task ${taskId} not found in plan` });
    return;
  }

  const currentRetryCount = failedTask.retryCount ?? 0;

  // Collect comprehensive context
  const upstreamResults: Array<{ taskId: string; output: string }> = [];
  const remainingTaskTitles: string[] = [];
  for (const [tid, item] of execution.tasks) {
    if (item.status === "done") {
      upstreamResults.push({ taskId: tid, output: item.task.title });
    } else if (item.status === "waiting" || item.status === "queued") {
      remainingTaskTitles.push(`${item.task.id}: ${item.task.title}`);
    }
  }

  const sandbox = sandboxes.get(sessionId);
  const fileTree = sandbox ? collectFileTree(sandbox.hostWorkDir) : undefined;
  const taskPrompt = buildTaskPrompt(failedTask.task);

  broadcast(sessionId, {
    type: "manager_reviewing",
    planId,
    taskId,
    reason: `User requested manual re-plan for failed task ${taskId} (已失败 ${currentRetryCount} 次)`,
  });

  const failure = {
    failedTaskId: taskId,
    failedAgentName: failedTask.agentName ?? "unknown",
    error: failedTask.lastError ?? `Task failed after ${currentRetryCount} retries`,
    output: "",
    upstreamResults,
    retryCount: currentRetryCount,
    fileTree,
    taskPrompt,
  };

  try {
    const manager = getManagerLoop();
    const decision = await manager.reviewAndDecide(planId, sessionId, failure, remainingTaskTitles);

    broadcast(sessionId, {
      type: "manager_decision",
      planId,
      taskId,
      decision: decision.action,
      reason: decision.reason,
    });

    if (decision.action === "replan" && decision.nextTasks && decision.nextTasks.length > 0) {
      // Inject replacement tasks
      for (const t of decision.nextTasks) {
        execution.tasks.set(t.id, {
          task: {
            id: t.id,
            title: t.title,
            description: t.description,
            agentType: t.agentType,
            dependsOn: t.dependsOn,
            expectedOutput: t.expectedOutput,
            priority: t.priority || "medium",
          },
          agentName: t.agentType,
          agentId: "",
          status: "waiting",
          dependents: [],
          retryCount: 0,
        });
      }
      const sb = sandboxes.get(sessionId);
      if (sb) {
        const replanned = consumeReadyTasks(execution);
        if (replanned.length > 0) {
          await enqueueTaskAssignments(sessionId, planId, replanned, sb);
        }
      }
    } else if (decision.action === "continue") {
      // Manual retry
      markTaskRetryQueued(execution, taskId);
      const sb = sandboxes.get(sessionId);
      if (sb) {
        const retryAssignment = consumeReadyTasks(execution);
        if (retryAssignment.length > 0) {
          await enqueueTaskAssignments(sessionId, planId, retryAssignment, sb);
        }
      }
    } else {
      // abort — task stays failed, user sees the result
      broadcast(sessionId, {
        type: "replan_required",
        planId,
        taskId,
        failedTask: {
          taskId,
          title: failedTask.task.title,
          agentType: failedTask.task.agentType,
          error: decision.reason,
          retryCount: currentRetryCount,
        },
      });
    }
  } catch (err: any) {
    console.error(`[dag] Replan handler error: ${err.message}`);
    broadcast(sessionId, { type: "stream_error", error: `Re-planning failed: ${err.message}` });
  }

  persistState(sessionId, planId, execution).catch((err) =>
    console.error(`[dag] Persist error after replan: ${err.message}`));
}

async function enqueueTaskAssignments(
  sessionId: string,
  planId: string,
  assignments: DagTaskAssignment[],
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  if (assignments.length === 0) return;

  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true } } },
  });
  const agentsByName = new Map(sessionAgents.map((sa) => [sa.agent.name, sa.agent]));
  const touched = new Set<string>();

  for (const assignment of assignments) {
    const existing = agentTaskQueues.get(assignment.agentName);
    const queue: AgentTaskQueue = existing || { planId, sessionId, tasks: [], current: null, sandbox };
    priorityInsert(queue.tasks, assignment.task);
    agentTaskQueues.set(assignment.agentName, queue);
    touched.add(assignment.agentName);
  }

  for (const agentName of touched) {
    const queue = agentTaskQueues.get(agentName);
    if (!queue || queue.current) continue;
    const agent = agentsByName.get(agentName);
    if (agent) await startTaskAgent(sessionId, agent, sandbox);
  }
}

function markTaskRunningForPlan(sessionId: string, planId: string, taskId: string): void {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (execution) markTaskRunning(execution, taskId);
}

function setPlanExecution(sessionId: string, planId: string, execution: DagExecutionState): void {
  planExecutions.set(planKey(sessionId, planId), execution);
  while (planExecutions.size > MAX_PLAN_EXECUTIONS) {
    const oldestKey = planExecutions.keys().next().value;
    if (!oldestKey) break;
    planExecutions.delete(oldestKey);
  }
  // Persist to DB
  persistState(sessionId, planId, execution).catch((err) =>
    console.error(`[dag] Persist error: ${err.message}`));
}

function maybeBroadcastPlanSummary(sessionId: string, execution: DagExecutionState): void {
  if (execution.summaryBroadcasted) return;

  const items = [...execution.tasks.values()];
  const completed = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'failed' || item.status === 'blocked').length;
  const finished = completed + failed;

  if (finished !== items.length) return;

  // Mark completed in DB
  const allDone = failed === 0;
  if (allDone) {
    DagPersistence.markCompleted(sessionId, execution.planId).catch((err) =>
      console.error(`[dag] Failed to mark plan ${execution.planId} completed: ${err.message}`));
  } else {
    DagPersistence.markFailed(sessionId, execution.planId).catch((err) =>
      console.error(`[dag] Failed to mark plan ${execution.planId} failed: ${err.message}`));
  }

  broadcast(sessionId, {
    type: 'plan_summary',
    planId: execution.planId,
    total: items.length,
    completed,
    failed,
    fileChanges: [],
  });
  execution.summaryBroadcasted = true;
}

async function persistState(sessionId: string, planId: string, state: DagExecutionState): Promise<void> {
  const tasks = [...state.tasks.values()].map((item) => ({
    id: item.task.id,
    title: item.task.title,
    description: item.task.description,
    agentType: item.task.agentType,
    dependsOn: item.task.dependsOn,
    expectedOutput: item.task.expectedOutput,
    priority: item.task.priority,
    agentName: item.agentName,
    agentId: item.agentId,
    status: item.status,
    dependents: item.dependents,
  }));

  await DagPersistence.save({
    planId,
    sessionId,
    planTitle: state.planTitle ?? '',
    status: 'executing',
    tasks,
  });
}

export async function reassignQueuedTasks(
  sessionId: string,
  failedAgentName: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const queue = agentTaskQueues.get(failedAgentName);
  if (!queue || queue.tasks.length === 0) return;

  const orphanedTasks = sortByPriority([...queue.tasks]);
  agentTaskQueues.delete(failedAgentName);
  agentCurrentTask.delete(failedAgentName);

  if (orphanedTasks.length === 0) return;

  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true } } },
  });

  if (sessionAgents.length === 0) return;

  const availableAgents = sessionAgents
    .filter((sa) => sa.agent.name !== failedAgentName)
    .map((sa) => sa.agent);

  for (const task of orphanedTasks) {
    const matching = availableAgents.filter(
      (a) => a.name !== failedAgentName
    );
    let target: { name: string; displayName: string } | null = matching.length > 0
      ? matching.reduce((best, a) => {
          const load = (agentTaskQueues.get(a.name)?.tasks.length ?? 0) + (agentCurrentTask.has(a.name) ? 1 : 0);
          const bestLoad = (agentTaskQueues.get(best.name)?.tasks.length ?? 0) + (agentCurrentTask.has(best.name) ? 1 : 0);
          return load < bestLoad ? a : best;
        })
      : null;
    if (!target) {
      target = findClosestAgent(task.agentType, availableAgents as any);
    }

    if (!target) {
      broadcast(sessionId, {
        type: 'task_blocked',
        planId: queue.planId,
        taskId: task.id,
        blockedBy: failedAgentName,
        agentName: failedAgentName,
        output: `Agent ${failedAgentName} failed and no replacement available for type ${task.agentType}`,
      });
      continue;
    }

    broadcast(sessionId, {
      type: 'agent_reassigned',
      planId: queue.planId,
      taskId: task.id,
      from: failedAgentName,
      to: target.name,
      taskTitle: task.title,
    });

    const newQueue = agentTaskQueues.get(target.name);
    if (newQueue) {
      newQueue.tasks.push(task);
    } else {
      agentTaskQueues.set(target.name, {
        planId: queue.planId,
        sessionId,
        tasks: [task],
        current: null,
        sandbox,
      });
    }
  }

  // Kick any idle agents that just got tasks
  const kicked = new Set<string>();
  for (const task of orphanedTasks) {
    const reassignedTo = [...agentTaskQueues.entries()]
      .find(([, q]) => q.tasks.includes(task))?.[0];
    if (reassignedTo && !kicked.has(reassignedTo)) {
      kicked.add(reassignedTo);
      const newQueue = agentTaskQueues.get(reassignedTo);
      if (newQueue && !newQueue.current) {
        await processNextInQueue(sessionId, reassignedTo, newQueue);
      }
    }
  }
}
