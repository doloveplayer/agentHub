// Task-to-Agent dispatch: routes Planner tasks to session agents via REPL.
// Extracted from handler.ts.

import { stateTracker } from '../agent/StateTracker.js';
import { getSessionContextBus } from '../agent/ContextBus.js';
import { findClosestAgent } from '../agent/turns.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { PinnedStore } from '../agent/PinnedStore.js';
import { DagPersistence } from '../agent/DagPersistence.js';
import { agentCoordinator, type CoordinationContext } from '../agent/AgentCoordinator.js';
import { MilestoneBroadcaster } from '../agent/MilestoneBroadcaster.js';
import { IntentParser } from '../agent/IntentParser.js';
import { InboxManager } from '../agent/InboxManager.js';
import { InboxWakeup } from '../agent/InboxWakeup.js';
import { calcContextPct } from '@agenthub/shared/constants';
import { getManagerLoop } from '../agent/ManagerLoop.js';
import { agentRuntime } from '../agent/AgentRuntime.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { getApprovalGate } from '../agent/ApprovalGate.js';
import { detectLanguage, languageConsistencyPrompt } from '../agent/languageDetection.js';
import { forceTaskDone, forceTaskFailed, touchTask, checkStaleTasks } from './dagExecution.js';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { createSDKAgentProcess, createOneShotAgentProcess } from '../agent/processFactory.js';


/** Agent model name cache for contextPct calculation. Populated when agents start. */
const agentModels = new Map<string, string>();

/** Extract model name from providerConfig (may be JSON string or object). */
function extractModel(providerConfig: unknown): string | undefined {
  if (!providerConfig) return undefined;
  try {
    const cfg = typeof providerConfig === 'string' ? JSON.parse(providerConfig) : providerConfig;
    if (cfg && typeof cfg === 'object' && 'model' in cfg) return (cfg as any).model as string;
  } catch {}
  return undefined;
}

/** Check if a task's expected output file exists in the sandbox. */
function taskOutputExists(hostWorkDir: string, expectedOutput: string): boolean {
  if (!expectedOutput) return false;
  const filePath = path.resolve(hostWorkDir, expectedOutput.replace(/^\/workspace\/?/, ''));
  return fs.existsSync(filePath);
}

/** Mark a task as running in the DAG execution state. */
function markTaskRunningForPlan(sessionId: string, planId: string, taskId: string): void {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (execution) markTaskRunning(execution, taskId);
}

/** Mark a task as done in the DAG execution state. */
function markTaskDoneForPlan(sessionId: string, planId: string, taskId: string): void {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (execution) {
    const item = execution.tasks.get(taskId);
    if (item) {
      item.status = 'done';
      execution.summaryBroadcasted = false;
    }
  }
}

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
  type DagExecutionItem,
  type DagTaskAssignment,
} from './dagExecution.js';
import {
  broadcast, sessionPermissionModes, agentProcesses, agentStates, agentTaskQueues,
  agentCurrentTask, agentCurrentMessage, sandboxes, sessionAgentNames,
  incRunningAgentCount, clearRunningAgent, populateSessionAgentNames,
  type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';
import {
  broadcastDiffSummary,
  recordMessageBeforeVersion,
  takeMessageBeforeVersion,
} from './diffBroadcast.js';
import {
  appendTaskRunOutput,
  clearActiveTaskRun,
  getActiveTaskRun,
  setActiveTaskRun,
} from './taskEventRouter.js';
import type { AbstractProvider, UnifiedAgentEvent } from '../agent/providers/base.js';

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

export function resolveAgentNameInSession(sessionId: string, agentType: string): string | null {
  const normalized = agentType.toLowerCase();
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    // 1. Exact match
    for (const [name] of procMap) {
      const lower = name.toLowerCase();
      if (lower === normalized || lower.startsWith(normalized + '-')) return name;
    }
    // 2. Prefix match: 'test-agent' matches 'test-agent-b13eebaa'
    for (const [name] of procMap) {
      if (name.toLowerCase().startsWith(normalized + '-')) return name;
    }
  }
  // 3. Same for agentTaskQueues
  for (const [name] of agentTaskQueues) {
    const lower = name.toLowerCase();
    if (lower === normalized || lower.startsWith(normalized + '-')) return name;
  }
  // 4. Session agent name cache (populated by dispatchTasksToAgents)
  const nameCache = sessionAgentNames.get(sessionId);
  if (nameCache) {
    const cached = nameCache.get(normalized);
    if (cached) return cached;
  }
  // Target agent not found — return null to skip inbox write
  return null;
}

function planKey(sessionId: string, planId: string): string {
  return `${sessionId}:${planId}`;
}

async function buildTaskPrompt(task: TaskDispatchNode, sessionId?: string): Promise<string> {
  let contextBlock = '';
  if (sessionId) {
    const budget = config.agent.contextTokenBudget;
    const pinnedBudget = Math.floor(budget * 0.4);
    const stateBudget = Math.floor(budget * 0.4);
    const experienceBudget = Math.floor(budget * 0.2);

    const sandbox = sandboxes.get(sessionId);
    const hostWorkDir = sandbox?.hostWorkDir;

    // 1. Pinned context
    const pinnedPrompt = await PinnedStore.buildInjectionPrompt(sessionId, pinnedBudget, hostWorkDir);
    if (pinnedPrompt) contextBlock += pinnedPrompt + '\n';

    // 2. Project state
    const bus = getSessionContextBus(sessionId);
    const digest = bus.getProjectDigest(stateBudget);
    if (digest) contextBlock += digest + '\n';

    // 3. Relevant experience
    const experience = bus.getRelevantExperience(task.agentType, task.description, experienceBudget);
    if (experience) contextBlock += experience + '\n';
  }

  return `${contextBlock}Task: ${task.title}
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

const providersWithTaskHandler = new WeakSet<AbstractProvider>();

function registerProviderTaskEventHandler(
  sessionId: string,
  agentName: string,
  provider: AbstractProvider,
): void {
  if (providersWithTaskHandler.has(provider)) return;
  providersWithTaskHandler.add(provider);
  provider.onEvent((event) => {
    handleProviderTaskEvent(sessionId, agentName, event);
  });
}

function handleProviderTaskEvent(
  sessionId: string,
  agentName: string,
  event: UnifiedAgentEvent,
): void {
  const run = getActiveTaskRun<AgentTaskQueue, TaskDispatchNode>(sessionId, agentName);
  if (!run || !run.queue || !run.task) return;

  const { queue, task, taskMessageId } = run;
  const execution = planExecutions.get(planKey(sessionId, queue.planId));
  if (execution) touchTask(execution, task.id);

  const sandbox = sandboxes.get(sessionId);
  const coordCtx: CoordinationContext | null = sandbox ? {
    sessionId,
    agentName,
    agentType: task.agentType,
    messageId: taskMessageId,
    hostWorkDir: sandbox.hostWorkDir,
    hostSandboxDir: sandbox.hostSandboxDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
    broadcast,
    notifiedKeys: run.notifiedKeys,
  } : null;

  switch (event.type) {
    case 'thinking': {
      const chunk = event.content || '';
      appendTaskRunOutput(sessionId, agentName, chunk);
      broadcast(sessionId, { type: 'stream_chunk', content: chunk, agentMessageId: taskMessageId });
      broadcast(sessionId, {
        type: 'agent_status',
        status: 'thinking',
        details: { content: chunk.slice(0, 120) },
        agentMessageId: taskMessageId,
        timestamp: Date.now(),
      });
      break;
    }
    case 'tool_use':
      if (coordCtx) {
        const resolvedToolName = event.toolName || (typeof event.toolInput?.toolName === 'string' ? event.toolInput.toolName : undefined);
        if (resolvedToolName) {
          agentCoordinator.onToolUse(coordCtx, {
            type: 'tool_use' as const,
            toolName: resolvedToolName,
            input: event.toolInput ?? {},
          });
        }
      }
      broadcast(sessionId, {
        type: 'agent_status',
        status: 'tool_use',
        details: {
          toolName: event.toolName || event.toolInput?.toolName,
          input: event.toolInput,
          inputPreview: JSON.stringify(event.toolInput || {}).slice(0, 80),
        },
        agentMessageId: taskMessageId,
        timestamp: Date.now(),
      });
      // Wire AgentCoordinator: permission check + event routing
      {
        const toolInput = event.toolInput || {};
        const filePath = (toolInput as any).file_path || (toolInput as any).path || (toolInput as any).filePath;
        agentCoordinator.onToolUse({
          sessionId, agentName, agentType: agentName,
          messageId: taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
          hostSandboxDir: sandboxes.get(sessionId)?.hostSandboxDir || queue.sandbox.hostWorkDir,
          resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
          broadcast,
        }, {
          type: 'tool_use',
          toolName: event.toolName || '',
          input: event.toolInput || {},
        } as any);
        // Broadcast file production milestone for DAG task agents
        MilestoneBroadcaster.classify({
          sessionId, agentName,
          agentMessageId: taskMessageId,
          eventType: event.toolName || '',
          toolName: event.toolName || '',
          filePath: typeof filePath === 'string' ? filePath : undefined,
        });
      }
      break;
    case 'tool_result':
      if (coordCtx) {
        agentCoordinator.onToolResult(coordCtx, event.content || '');
      }
      broadcast(sessionId, {
        type: 'agent_status',
        status: 'tool_result',
        details: { resultPreview: (event.content || '').slice(0, 80) },
        agentMessageId: taskMessageId,
        timestamp: Date.now(),
      });
      // Wire AgentCoordinator: route tool results
      agentCoordinator.onToolResult({
        sessionId, agentName, agentType: agentName,
        messageId: taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
        hostSandboxDir: sandboxes.get(sessionId)?.hostSandboxDir || queue.sandbox.hostWorkDir,
        resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
        broadcast,
      }, event.content || '');
      break;
    case 'token_usage':
      stateTracker.updateTokenUsage(taskMessageId, {
        input: event.inputTokens || 0,
        output: event.outputTokens || 0,
        cacheRead: event.cacheReadTokens || 0,
        cacheCreate: event.cacheCreateTokens || 0,
      });
      // Broadcast cumulative totals from StateTracker
      {
        const snap = stateTracker.getSnapshot(taskMessageId);
        const cumulative = snap?.tokenUsage;
        broadcast(sessionId, {
          type: 'agent_status',
          status: 'token_update',
          details: {
            tokenUsage: {
              input: cumulative?.input ?? 0,
              output: cumulative?.output ?? 0,
              cacheRead: cumulative?.cacheRead ?? 0,
              cacheCreate: cumulative?.cacheCreate ?? 0,
              contextPct: calcContextPct(cumulative?.input ?? 0, agentModels.get(agentName)),
              model: agentModels.get(agentName) || undefined,
            },
          },
          agentMessageId: taskMessageId,
        timestamp: Date.now(),
      });
      }
      break;
    case 'skill_use': {
      stateTracker.recordSkillUse({
        skillName: event.skillName || 'unknown',
        agentName,
        agentId: run.task?.agentType || agentName,
        taskId: task.id,
        planId: queue.planId,
      });
      broadcast(sessionId, {
        type: 'skill_use',
        skillName: event.skillName,
        agentName,
        agentId: run.task?.agentType || agentName,
        agentMessageId: taskMessageId,
        taskId: task.id,
        planId: queue.planId,
        timestamp: Date.now(),
      });
      break;
    }
    case 'done': {
      const exitCode = event.exitCode ?? 0;
      const succeeded = exitCode === 0;
      const output = getActiveTaskRun<AgentTaskQueue, TaskDispatchNode>(sessionId, agentName)?.output || '';
      if (coordCtx) {
        agentCoordinator.onAgentDone(coordCtx, exitCode, output.slice(0, 500));
      }
      broadcast(sessionId, { type: 'stream_end', agentMessageId: taskMessageId, fullContent: output, exitCode });
      broadcast(sessionId, {
        type: succeeded ? 'task_completed' : 'task_failed',
        planId: queue.planId,
        taskId: task.id,
        agentName,
        output: output.slice(0, 200),
      });
      import('../agent/SessionCommLog.js').then(({ SessionCommLog }) => {
        SessionCommLog.log(sessionId, 'task', succeeded ? 'completed' : 'failed', {
          planId: queue.planId, taskId: task.id, agentName, exitCode,
        });
      }).catch(() => {});
      stateTracker.setDone(taskMessageId);
      if (succeeded && output) {
        const bus = getSessionContextBus(sessionId);
        bus.set({
          key: `task:${task.id}:output-summary`,
          value: output.slice(0, 500),
          type: 'task-handoff',
          author: agentName,
          taskId: task.id,
          planId: queue.planId,
          tags: [agentName, task.agentType, 'handoff'],
          status: 'active',
        });
      }

      // Wire AgentCoordinator: route agent completion events
      agentCoordinator.onAgentDone({
        sessionId, agentName, agentType: agentName,
        messageId: taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
        hostSandboxDir: sandboxes.get(sessionId)?.hostSandboxDir || queue.sandbox.hostWorkDir,
        resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
        broadcast,
      }, exitCode, output.slice(0, 3000));

      // Scan for NEEDS HELP intents and route to target agents
      if (output) {
        const intents = IntentParser.scan(output);
        for (const intent of intents) {
          const targetName = resolveAgentNameInSession(sessionId, intent.targetAgentName) || intent.targetAgentName;
          InboxManager.write(sandboxes.get(sessionId)?.hostSandboxDir || queue.sandbox.hostWorkDir, targetName, {
            type: 'help_request',
            id: `help-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            from: agentName,
            to: targetName,
            summary: intent.description,
            risk: 'low',
            timestamp: Date.now(),
          }, sessionId);
          broadcast(sessionId, {
            type: 'inbox_update',
            agentName: targetName,
            summary: intent.description,
            timestamp: Date.now(),
          });
        }
      }

      // Persist token usage from StateTracker alongside content/status
      const finalSnapshot = stateTracker.getSnapshot(taskMessageId);
      void prisma.message.update({
        where: { id: taskMessageId },
        data: {
          content: output || '[Agent finished]',
          status: succeeded ? 'done' : 'error',
          inputTokens: finalSnapshot?.tokenUsage?.input ?? 0,
          outputTokens: finalSnapshot?.tokenUsage?.output ?? 0,
          cacheReadTokens: finalSnapshot?.tokenUsage?.cacheRead ?? 0,
          cacheCreateTokens: finalSnapshot?.tokenUsage?.cacheCreate ?? 0,
        },
      }).catch(() => {});
      agentCurrentTask.delete(agentName);
      agentCurrentMessage.delete(agentName);
      clearActiveTaskRun(sessionId, agentName, taskMessageId);
      queue.current = null;
      clearRunningAgent(sessionId, taskMessageId);
      import('./chatHandlers.js').then(({ drainPendingQueue, drainPerSessionQueue }) => {
        drainPendingQueue();
        drainPerSessionQueue(sessionId);
      }).catch(() => {});
      processNextInQueue(sessionId, agentName, queue);
      void handleDispatchedTaskFinished(sessionId, queue.planId, task.id, succeeded);
      // Drain sequential multi-@mention queue
      import('./chatHandlers.js').then(({ startNextSequential }) => {
        startNextSequential(sessionId);
      }).catch(() => {});

      // Proactive inbox check: notify if other agents have pending messages
      {
        const procMap = agentProcesses.get(sessionId);
        if (procMap) {
          for (const [name] of procMap) {
            if (name !== agentName) {
              InboxWakeup.check(sessionId, name, queue.sandbox.hostWorkDir,
                (n) => procMap.has(n), broadcast);
            }
          }
        }
      }
      break;
    }
    case 'error':
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: taskMessageId,
        error: event.message || 'Unknown error',
      });
      const errSnapshot = stateTracker.getSnapshot(taskMessageId);
      void prisma.message.update({
        where: { id: taskMessageId },
        data: {
          status: 'error',
          inputTokens: errSnapshot?.tokenUsage?.input ?? 0,
          outputTokens: errSnapshot?.tokenUsage?.output ?? 0,
          cacheReadTokens: errSnapshot?.tokenUsage?.cacheRead ?? 0,
          cacheCreateTokens: errSnapshot?.tokenUsage?.cacheCreate ?? 0,
        },
      }).catch(() => {});
      agentCurrentTask.delete(agentName);
      agentCurrentMessage.delete(agentName);
      clearActiveTaskRun(sessionId, agentName, taskMessageId);
      queue.current = null;
      clearRunningAgent(sessionId, taskMessageId);
      import('./chatHandlers.js').then(({ drainPendingQueue, drainPerSessionQueue }) => {
        drainPendingQueue();
        drainPerSessionQueue(sessionId);
      }).catch(() => {});
      processNextInQueue(sessionId, agentName, queue);
      break;
  }
}

export async function processNextInQueue(
  sessionId: string,
  agentName: string,
  queue: AgentTaskQueue,
): Promise<void> {
  // Skip tasks whose expected output already exists (agent already did the work)
  while (queue.tasks.length > 0) {
    const next = queue.tasks[0];
    if (next.expectedOutput && taskOutputExists(queue.sandbox.hostWorkDir, next.expectedOutput)) {
      console.log(`[taskDispatcher] Task ${next.id} output already exists, auto-completing`);
      queue.tasks.shift();
      markTaskDoneForPlan(sessionId, queue.planId, next.id);
      broadcast(sessionId, {
        type: 'task_completed', planId: queue.planId, taskId: next.id,
        agentName, output: `Output already exists: ${next.expectedOutput}`,
      });
      DagPersistence.updateTaskStatus(sessionId, queue.planId, next.id, 'done').catch(() => {});
      // Check if this unblocks dependents
      const execution = planExecutions.get(planKey(sessionId, queue.planId));
      if (execution) {
        const ready = forceTaskDone(execution, next.id);
        if (ready.length > 0) {
          await enqueueTaskAssignments(sessionId, queue.planId, ready, queue.sandbox);
        }
      }
    } else {
      break;
    }
  }

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
    registerProviderTaskEventHandler(sessionId, agentName, procInfo.provider);
    // Inject retry context from execution state
    const execution = planExecutions.get(planKey(sessionId, queue.planId));
    const dagItem = execution?.tasks.get(task.id);
    const retryNote = dagItem && dagItem.retryCount > 0
      ? `\n\n⚠️ 上次执行失败 (attempt ${dagItem.retryCount}): 请避免重复相同操作。`
      : '';
    const basePrompt = await buildTaskPrompt(task, sessionId);
    const taskPrompt = basePrompt + retryNote;
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
    setActiveTaskRun({
      sessionId,
      agentName,
      planId: queue.planId,
      taskId: task.id,
      taskMessageId,
      queue,
      task,
    });
    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: procInfo.agentId, taskMessageId });
    import('../agent/SessionCommLog.js').then(({ SessionCommLog }) => {
      SessionCommLog.log(sessionId, 'task', 'assigned', { planId: queue.planId, taskId: task.id, agentName });
    }).catch(() => {});
    // Inject coordination context (inbox messages) when reusing a provider
    const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
      sessionId, agentName, agentType: agentName,
      messageId: taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
      hostSandboxDir: sandboxes.get(sessionId)?.hostSandboxDir || queue.sandbox.hostWorkDir,
      resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
      broadcast,
    });
    procInfo.provider.sendPrompt(`${taskPrompt}\n${coordinationPrompt}`);
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
  const agent = await prisma.agent.findUnique({
    where: { name: agentName },
    select: { id: true, name: true, systemPrompt: true, skills: true, providerConfig: true },
  });
  if (!agent) return;
  // Cache model for contextPct calculation
  const agentModel = extractModel(agent.providerConfig);
  if (agentModel) agentModels.set(agentName, agentModel);

  const taskMsgId = buildTaskMessageId(queue.planId, task.id);
  const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
    sessionId, agentName: agent.name, agentType: agent.name,
    messageId: taskMsgId, hostWorkDir: sandbox.hostWorkDir, hostSandboxDir: sandbox.hostSandboxDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type), broadcast,
  });
  const taskPromptPart = await buildTaskPrompt(task, sessionId);
  const fullPrompt = `${agent.systemPrompt}${languageConsistencyPrompt(detectLanguage(task.description || task.title))}\n\n---\n\n${taskPromptPart}\n${coordinationPrompt}`;

  try {
    const { ProviderFactory } = await import('../agent/providers/factory.js');
    const provider = ProviderFactory.create('claude-code');
    if (provider.setSessionIdCallback) {
      provider.setSessionIdCallback((sid: string) => {
        import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
          CheckpointManager.updateAgentSession(sessionId, queue.planId, agentName, sid);
        }).catch(() => {});
      });
    }
    registerProviderTaskEventHandler(sessionId, agentName, provider);

    // Create message and register state BEFORE provider.start(),
    // so task_assigned reaches the frontend before any stream_chunk events.
    const taskMsg = await prisma.message.create({
      data: { id: taskMsgId, sessionId, senderType: 'agent', agentId: agent.id, content: '', status: 'streaming' },
    }).catch(() => null);
    if (taskMsg) {
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(taskMsg.id, { process: provider, timer: null, agentId: agent.id, agentName });
      incRunningAgentCount();
    }
    if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
    agentProcesses.get(sessionId)!.set(agentName, {
      provider, timer: null, agentId: agent.id,
    });
    agentCurrentMessage.set(agentName, taskMsgId);
    setActiveTaskRun({
      sessionId,
      agentName,
      planId: queue.planId,
      taskId: task.id,
      taskMessageId: taskMsgId,
      queue,
      task,
    });
    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: agent.id, taskMessageId: taskMsgId });
    import('../agent/SessionCommLog.js').then(({ SessionCommLog }) => {
      SessionCommLog.log(sessionId, 'task', 'assigned', { planId: queue.planId, taskId: task.id, agentName });
    }).catch(() => {});

    const agentHomeDir = AgentDirectoryManager.getAgentHome(agent.id);
    AgentDirectoryManager.initialize(sandbox.hostSandboxDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null, sessionId, agent.skills as any[] | null, agent.id);
    AgentDirectoryManager.ensureAgentHome(agent.id, agent.name, agent.systemPrompt, agent.skills as any[] | null);
    console.log(`[ws] Task REPL started: agent=${agentName} task=${task.id}`);
    await provider.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, {
      agentName, hostWorkDir: sandbox.hostWorkDir, hostSandboxDir: sandbox.hostSandboxDir, agentHomeDir, trustMode: true,
    });
  } catch (err: any) {
    console.error(`[ws] Task REPL start failed: ${err.message}`);
    broadcast(sessionId, { type: 'task_failed', planId: queue.planId, taskId: task.id, agentName, output: `Failed to start: ${err.message}` });
    void prisma.message.update({ where: { id: taskMsgId }, data: { status: 'error' } }).catch(() => {});
    agentCurrentTask.delete(agentName);
    agentCurrentMessage.delete(agentName);
    clearActiveTaskRun(sessionId, agentName, taskMsgId);
    queue.current = null;
    clearRunningAgent(sessionId, taskMsgId);
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

  // Cache agent name mappings so resolveAgentNameInSession can resolve base names
  populateSessionAgentNames(sessionId, sessionAgents.map(sa => ({ name: sa.agent.name })));

  const agentsByType = new Map<string, typeof sessionAgents[number]['agent'][]>();
  for (const sa of sessionAgents) {
    const name = sa.agent.name.toLowerCase();
    // Register both the full name ("review-agent-8fbd5f38") and the base name
    // ("review-agent") so that normalized plan agentType values match correctly.
    const baseName = name.replace(/-\w{6,}$/, '');
    for (const key of [name, baseName]) {
      const list = agentsByType.get(key) || [];
      list.push(sa.agent);
      agentsByType.set(key, list);
    }
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
          agentId: suggested.id,
          taskTitle: task.title,
        });
      } else {
        missingTypes.add(task.agentType);
        const availableAgentTypes = [...new Set(sessionAgents.map(sa => sa.agent.name))];
        broadcast(sessionId, {
          type: 'agent_missing', planId, taskId: task.id,
          agentType: task.agentType, taskTitle: task.title,
          availableAgentTypes,
          message: `No agent matches "${task.agentType}". Available in session: ${availableAgentTypes.join(', ')}`,
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
  import('../agent/SessionCommLog.js').then(({ SessionCommLog }) => {
    SessionCommLog.log(sessionId, 'plan', 'created', {
      planId, planTitle, taskCount: assignments.length, agentTypes: [...new Set(assignments.map(a => a.task.agentType))],
    });
  }).catch(() => {});
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
    const taskPrompt = failedTask ? await buildTaskPrompt(failedTask.task, sessionId) : undefined;

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
              if (sandbox) {
                dispatchEscalationToPlanner(sessionId, planId, taskId, {
                  taskId, title: failedTask?.task.title ?? taskId,
                  agentType: failedTask?.task.agentType ?? 'unknown',
                  error: decision.reason, retryCount: currentRetryCount,
                }, sandbox).catch((err: any) => console.error(`[dag] Planner escalation failed: ${err.message}`));
              }
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
            if (sandbox) {
              dispatchEscalationToPlanner(sessionId, planId, taskId, {
                taskId, title: failedTask?.task.title ?? taskId,
                agentType: failedTask?.task.agentType ?? 'unknown',
                error: decision.reason, retryCount: currentRetryCount,
              }, sandbox).catch((err: any) => console.error(`[dag] Planner escalation failed: ${err.message}`));
            }
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
        if (sandbox) {
          dispatchEscalationToPlanner(sessionId, planId, taskId, {
            taskId, title: failedTask?.task.title ?? taskId,
            agentType: failedTask?.task.agentType ?? 'unknown',
            error: `ManagerLoop unavailable: ${err.message}`, retryCount: currentRetryCount,
          }, sandbox).catch((err: any) => console.error(`[dag] Planner escalation failed: ${err.message}`));
        }
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

  // Write known-issue to ContextBus when task is definitively failed (not retrying)
  if (!success) {
    const failedItem = execution.tasks.get(taskId);
    if (failedItem && failedItem.status === 'failed') {
      const bus = getSessionContextBus(sessionId);
      bus.set({
        key: `task:${taskId}:failure`,
        value: `Failed after ${failedItem.retryCount} retries: ${failedItem.lastError || ''}`.slice(0, 300),
        type: 'known-issue',
        author: failedItem.agentName,
        taskId,
        planId,
        tags: [failedItem.agentName, failedItem.task.agentType, 'failure'],
        status: 'active',
      });
    }
  }

  maybeBroadcastPlanSummary(sessionId, execution);
  persistState(sessionId, planId, execution).catch((err) =>
    console.error(`[dag] Persist error on task finish: ${err.message}`));

  // Save checkpoint after any state change
  import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
    const pending = [...execution.tasks.values()]
      .filter(item => item.status === 'waiting' || item.status === 'queued' || item.status === 'running')
      .map(item => ({
        id: item.task.id, title: item.task.title, description: item.task.description,
        agentType: item.task.agentType, dependsOn: item.task.dependsOn,
        expectedOutput: item.task.expectedOutput, priority: item.task.priority,
      }));
    const completed = [...execution.tasks.values()]
      .filter(item => item.status === 'done')
      .map(item => item.task.id);
    const failed = [...execution.tasks.values()]
      .filter(item => item.status === 'failed' || item.status === 'blocked')
      .map(item => ({ id: item.task.id, error: item.lastError || '', retryCount: item.retryCount || 0 }));

    const existingCp = CheckpointManager.read(sessionId, planId);
    CheckpointManager.save(
      sessionId, planId, pending, completed, failed,
      existingCp?.agentSessions || {},
    );
  }).catch((err: any) => console.error('[dag] CheckpointManager import failed:', err.message));
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
  const taskPrompt = await buildTaskPrompt(failedTask.task, sessionId);

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

export async function enqueueTaskAssignments(
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

  // Create initial checkpoint on first dispatch
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (execution) {
    import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
      const allTasks = execution.tasks;
      const pending = [...allTasks.values()]
        .filter(item => item.status !== 'done' && item.status !== 'failed')
        .map(item => ({
          id: item.task.id, title: item.task.title, description: item.task.description,
          agentType: item.task.agentType, dependsOn: item.task.dependsOn,
          expectedOutput: item.task.expectedOutput, priority: item.task.priority,
        }));
      CheckpointManager.save(sessionId, planId, pending, [], [], {});
    }).catch((err: any) => console.error('[dag] ArchiveManager import failed:', err.message));
  }
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

  const sandbox = sandboxes.get(sessionId);
  // Send summary to planner for post-execution review
  if (sandbox) {
    dispatchPlanSummaryToPlanner(sessionId, execution, items, completed, failed, sandbox)
      .catch((err: any) => console.error(`[dag] Failed to dispatch plan summary to planner: ${err.message}`));
  }

  // Archive pipeline: when all tasks are done, archive the plan for future experience extraction
  if (allDone && sandbox) {
    const archiveStartTime = Date.now();
    import('../agent/ArchiveManager.js').then(({ ArchiveManager }) => {
      const archiveTasks = items.map(item => ({
        id: item.task.id,
        title: item.task.title,
        agentType: item.task.agentType,
        status: item.status,
        outputSummary: item.task.expectedOutput || '',
        outputFiles: [],
        modifiedFiles: [],
      }));
      const failedArchiveTasks = items
        .filter(item => item.status === 'failed' || item.status === 'blocked')
        .map(item => ({
          taskId: item.task.id,
          agentType: item.task.agentType,
          error: item.lastError || 'Unknown error',
          retryCount: item.retryCount || 0,
        }));
      ArchiveManager.archivePlan(
        sessionId, execution.planId, execution.planTitle || '',
        archiveTasks, failedArchiveTasks,
        sandbox?.hostWorkDir || '', archiveStartTime,
      ).then(({ manifest, experiences }) => {
        console.log(`[archive] Plan ${execution.planId} archived: ${manifest.tasks.length} tasks, ${experiences.length} experiences`);
        broadcast(sessionId, {
          type: 'plan_archived',
          planId: execution.planId,
          experienceCount: experiences.length,
          manifestPath: `.sandboxes/${sessionId}/archive/${execution.planId}/manifest.json`,
        });
        import('../agent/SessionCommLog.js').then(({ SessionCommLog }) => {
          SessionCommLog.log(sessionId, 'plan', 'archived', {
            planId: execution.planId, taskCount: manifest.tasks.length, experienceCount: experiences.length,
          });
        }).catch(() => {});
      }).catch(err => console.error(`[archive] Plan ${execution.planId} archive failed:`, err));
    }).catch((err: any) => console.error('[dag] ArchiveManager dynamic import failed:', err.message));
  }
}

/**
 * After all plan tasks complete, send a structured summary to the planner agent
 * for post-execution review. The planner produces a natural-language summary
 * of accomplishments, failures, and suggested next steps.
 */
async function dispatchPlanSummaryToPlanner(
  sessionId: string,
  execution: DagExecutionState,
  items: DagExecutionItem[],
  completed: number,
  failed: number,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string; sandboxDir: string; hostSandboxDir: string },
): Promise<void> {
  const plannerSA = await prisma.sessionAgent.findFirst({
    where: { sessionId, agent: { name: { startsWith: 'planner' } } },
    select: { agent: { select: { id: true, name: true } } },
  });
  if (!plannerSA) return;

  const bus = getSessionContextBus(sessionId);
  const taskLines: string[] = [];
  for (const item of items) {
    const outputEntry = bus.get(`task:${item.task.id}:output-summary`);
    const outputStr = outputEntry
      ? (typeof outputEntry.value === 'string'
          ? outputEntry.value.slice(0, 300)
          : JSON.stringify(outputEntry.value).slice(0, 300))
      : '(no output recorded)';
    const icon = item.status === 'done' ? 'DONE' : item.status === 'failed' ? 'FAIL' : 'SKIP';
    taskLines.push(`- [${icon}] **${item.task.title}** (${item.task.agentType})\n  ${outputStr}`);
  }

  const planTitle = execution.planTitle || execution.planId;
  const summaryPrompt = [
    '## Plan Execution Summary',
    '',
    `The task plan **${planTitle}** has fully completed.`,
    '',
    `Results: ${completed}/${items.length} succeeded, ${failed}/${items.length} failed`,
    '',
    'Task breakdown:',
    ...taskLines,
    '',
    'Please produce a concise post-execution review in Chinese covering:',
    '1. **Accomplished** -- what goals were completed overall',
    '2. **Failures** -- if any tasks failed, analyze why',
    '3. **Next steps** -- suggest what to do next (fix failures, iterate on features, or wrap up)',
    '',
    'This is a review-only request. Output a plain-text summary. Do NOT output AGENTHUB_PLAN or plan.json.',
  ].join('\n');

  const messageId = `plan-summary-${execution.planId}-${Date.now()}`;
  try {
    await prisma.message.create({
      data: { id: messageId, sessionId, senderType: 'agent', agentId: plannerSA.agent.id, content: '', status: 'streaming' },
    });
  } catch { return; }

  const fullPrompt = [
    '[Group - Multi-Agent Collaboration]',
    '',
    summaryPrompt,
  ].join('\n');

  await agentRuntime.sendPrompt(plannerSA.agent.id, sessionId, fullPrompt, messageId, sandbox);
}

/**
 * When a task has exhausted all recovery strategies (auto-retry + ManagerLoop),
 * notify the planner so it can analyze the failure and suggest alternatives.
 */
async function dispatchEscalationToPlanner(
  sessionId: string,
  planId: string,
  failedTaskId: string,
  failedTask: { taskId: string; title: string; agentType: string; error: string; retryCount: number },
  sandbox: { containerId: string; workDir: string; hostWorkDir: string; sandboxDir: string; hostSandboxDir: string },
): Promise<void> {
  const plannerSA = await prisma.sessionAgent.findFirst({
    where: { sessionId, agent: { name: { startsWith: 'planner' } } },
    select: { agent: { select: { id: true, name: true } } },
  });
  if (!plannerSA) return;

  const escalationPrompt = [
    '## Plan Escalation — Task Failed Beyond Recovery',
    '',
    `A task in your plan has failed after exhausting all recovery strategies:`,
    '',
    `- **Plan**: ${planId}`,
    `- **Failed Task**: ${failedTask.title} (${failedTask.agentType})`,
    `- **Error**: ${failedTask.error}`,
    `- **Retries**: ${failedTask.retryCount} attempts`,
    '',
    'Auto-retry and ManagerLoop review have both been exhausted.',
    'Please analyze the failure and propose next steps:',
    '1. **Why did it fail?** — diagnose the root cause',
    '2. **Impact** — which downstream tasks are now blocked?',
    '3. **Next steps** — should the approach be changed? Should the task be redesigned or deferred?',
    '',
    'This is an escalation review. Output in Chinese. Do NOT output AGENTHUB_PLAN or call any tools.',
  ].join('\n');

  const messageId = `escalation-${planId}-${Date.now()}`;
  try {
    await prisma.message.create({
      data: { id: messageId, sessionId, senderType: 'agent', agentId: plannerSA.agent.id, content: '', status: 'streaming' },
    });
  } catch { return; }

  const fullPrompt = [
    '[Group - Multi-Agent Collaboration]',
    '',
    escalationPrompt,
  ].join('\n');

  await agentRuntime.sendPrompt(plannerSA.agent.id, sessionId, fullPrompt, messageId, sandbox);
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
    let target: (typeof availableAgents)[number] | null = matching.length > 0
      ? matching.reduce((best, a) => {
          const load = (agentTaskQueues.get(a.name)?.tasks.length ?? 0) + (agentCurrentTask.has(a.name) ? 1 : 0);
          const bestLoad = (agentTaskQueues.get(best.name)?.tasks.length ?? 0) + (agentCurrentTask.has(best.name) ? 1 : 0);
          return load < bestLoad ? a : best;
        })
      : null;
    if (!target) {
      target = findClosestAgent(task.agentType, availableAgents);
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
      agentId: target.id,
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

// ---------------------------------------------------------------------------
// Manual recovery: force-complete or force-fail a stuck task
// ---------------------------------------------------------------------------

/**
 * Force a task to 'done' and unblock dependents. Used for manual recovery
 * when a task completed its work but the agent didn't emit done.
 */
export async function handleForceCompleteTask(
  sessionId: string,
  planId: string,
  taskId: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (!execution) {
    broadcast(sessionId, { type: 'stream_error', error: `Plan ${planId} not found` });
    return;
  }

  const item = execution.tasks.get(taskId);
  if (!item) {
    broadcast(sessionId, { type: 'stream_error', error: `Task ${taskId} not found in plan ${planId}` });
    return;
  }

  console.log(`[taskDispatcher] Force-completing task ${taskId} in plan ${planId}`);
  const ready = forceTaskDone(execution, taskId);
  execution.summaryBroadcasted = false;

  broadcast(sessionId, {
    type: 'task_completed', planId, taskId,
    agentName: item.agentName, output: '[Force completed by user]',
  });

  // Persist
  DagPersistence.updateTaskStatus(sessionId, planId, taskId, 'done').catch(() => {});

  // Dispatch newly unblocked tasks
  if (ready.length > 0) {
    await enqueueTaskAssignments(sessionId, planId, ready, sandbox);
  }
}

/**
 * Force a task to 'failed'. Used for manual recovery when a task is stuck.
 */
export async function handleForceFailTask(
  sessionId: string,
  planId: string,
  taskId: string,
  reason: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const execution = planExecutions.get(planKey(sessionId, planId));
  if (!execution) {
    broadcast(sessionId, { type: 'stream_error', error: `Plan ${planId} not found` });
    return;
  }

  console.log(`[taskDispatcher] Force-failing task ${taskId} in plan ${planId}: ${reason}`);
  forceTaskFailed(execution, taskId, reason);
  execution.summaryBroadcasted = false;

  broadcast(sessionId, {
    type: 'task_failed', planId, taskId,
    agentName: execution.tasks.get(taskId)?.agentName || 'unknown',
    output: `Force failed: ${reason}`,
  });

  DagPersistence.updateTaskStatus(sessionId, planId, taskId, 'failed').catch(() => {});
}

// ---------------------------------------------------------------------------
// Plan reconciliation: sync plan.json status → DAG execution state
// ---------------------------------------------------------------------------

/**
 * Compare plan.json task statuses with DAG execution state and advance
 * any tasks that Planner marked as completed but DAG still shows as running.
 * Returns count of reconciled tasks.
 */
export function reconcilePlanWithDag(
  sessionId: string,
  planTitle: string,
  planTasks: Array<{ id: string; status?: string }>,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): number {
  // Find matching DAG execution by plan title (plan.json → planId mapping is loose)
  let matchedExecution: DagExecutionState | null = null;
  for (const [key, execution] of planExecutions) {
    if (!key.startsWith(sessionId)) continue;
    if (execution.planTitle === planTitle || execution.planTitle && planTitle.includes(execution.planTitle)) {
      matchedExecution = execution;
      break;
    }
  }

  if (!matchedExecution) return 0;

  let reconciled = 0;
  for (const pt of planTasks) {
    if (pt.status !== 'completed') continue;

    const dagItem = matchedExecution.tasks.get(pt.id);
    if (!dagItem) continue;

    // Only reconcile tasks stuck in non-terminal states
    if (dagItem.status === 'done' || dagItem.status === 'failed') continue;

    console.log(`[reconcile] Plan "${planTitle}" task ${pt.id}: planner says completed, DAG says ${dagItem.status} → forcing done`);
    const ready = forceTaskDone(matchedExecution, pt.id);
    reconciled++;

    // Dispatch newly unblocked tasks
    if (ready.length > 0) {
      const planId = matchedExecution.planId;
      enqueueTaskAssignments(sessionId, planId, ready, sandbox).catch((err) =>
        console.error(`[reconcile] Failed to enqueue unblocked tasks:`, err.message)
      );
    }
  }

  if (reconciled > 0) {
    matchedExecution.summaryBroadcasted = false;
  }

  return reconciled;
}

// ---------------------------------------------------------------------------
// Stale task checker
// ---------------------------------------------------------------------------

const STALE_CHECK_INTERVAL_MS = 30_000;
const STALE_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const staleCheckIntervals = new Map<string, NodeJS.Timeout>();

export function startStaleTaskChecker(
  sessionId: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): void {
  if (staleCheckIntervals.has(sessionId)) return;

  const interval = setInterval(() => {
    for (const [key, execution] of planExecutions) {
      if (!key.startsWith(sessionId)) continue;

      const staleTaskIds = checkStaleTasks(execution, STALE_TASK_TIMEOUT_MS);
      for (const taskId of staleTaskIds) {
        const item = execution.tasks.get(taskId);
        console.log(`[stale-check] Task ${taskId} in plan ${execution.planId} is stale (no activity for ${STALE_TASK_TIMEOUT_MS}ms)`);
        forceTaskFailed(execution, taskId, 'Task timed out — no activity for 10 minutes');
        execution.summaryBroadcasted = false;

        broadcast(sessionId, {
          type: 'task_failed',
          planId: execution.planId,
          taskId,
          agentName: item?.agentName || 'unknown',
          output: 'Task timed out — agent may have crashed or stalled',
        });

        DagPersistence.updateTaskStatus(sessionId, execution.planId, taskId, 'failed').catch(() => {});
      }
    }
  }, STALE_CHECK_INTERVAL_MS);

  staleCheckIntervals.set(sessionId, interval);
  console.log(`[stale-check] Started stale task checker for session ${sessionId.slice(0, 8)}`);
}

export function stopStaleTaskChecker(sessionId: string): void {
  const interval = staleCheckIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    staleCheckIntervals.delete(sessionId);
  }
}
