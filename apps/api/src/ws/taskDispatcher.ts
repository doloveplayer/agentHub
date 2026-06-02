// Task-to-Agent dispatch: routes Planner tasks to session agents via REPL.
// Extracted from handler.ts.

import { stateTracker } from '../agent/StateTracker.js';
import { getSessionContextBus } from '../agent/ContextBus.js';
import { findClosestAgent } from '../agent/turns.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { DagPersistence } from '../agent/DagPersistence.js';
import { agentCoordinator } from '../agent/AgentCoordinator.js';
import { getManagerLoop } from '../agent/ManagerLoop.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { getApprovalGate } from '../agent/ApprovalGate.js';
import { detectLanguage, languageConsistencyPrompt } from '../agent/languageDetection.js';
import { forceTaskDone, forceTaskFailed, touchTask, checkStaleTasks } from './dagExecution.js';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import { createSDKAgentProcess, createOneShotAgentProcess } from '../agent/processFactory.js';


/** Estimated context window sizes per model. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-flash': 1000000,
  'claude-sonnet-4-6': 200000,
  'claude-opus-4-7': 200000,
  'claude-haiku-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-opus-4-5': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'gemini-2.5-pro': 1048576,
  'gemini-2.5-flash': 1048576,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
};

function calcContextPct(inputTokens: number, model?: string): number {
  if (!inputTokens || inputTokens <= 0) return 0;
  const window = MODEL_CONTEXT_WINDOWS[model || ''] || 200000;
  return Math.round((inputTokens / window) * 100);
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
  type DagTaskAssignment,
} from './dagExecution.js';
import {
  broadcast, sessionPermissionModes, agentProcesses, agentStates, agentTaskQueues,
  agentCurrentTask, agentCurrentMessage, sandboxes,
  incRunningAgentCount, clearRunningAgent,
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
    for (const [name] of procMap) {
      if (name.toLowerCase() === normalized) return name;
    }
  }
  for (const [name] of agentTaskQueues) {
    if (name.toLowerCase() === normalized) return name;
  }
  return agentType;
}

function planKey(sessionId: string, planId: string): string {
  return `${sessionId}:${planId}`;
}

function buildTaskPrompt(task: TaskDispatchNode, sessionId?: string): string {
  let contextBlock = '';
  if (sessionId) {
    const bus = getSessionContextBus(sessionId);
    const digest = bus.getProjectDigest(400);
    const experience = bus.getRelevantExperience(task.agentType, task.description);
    if (digest) contextBlock += digest + '\n';
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
      break;
    case 'tool_result':
      broadcast(sessionId, {
        type: 'agent_status',
        status: 'tool_result',
        details: { resultPreview: (event.content || '').slice(0, 80) },
        agentMessageId: taskMessageId,
        timestamp: Date.now(),
      });
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
              contextPct: calcContextPct(cumulative?.input ?? 0),
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
      void prisma.message.update({
        where: { id: taskMessageId },
        data: { content: output || '[Agent finished]', status: succeeded ? 'done' : 'error' },
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
      break;
    }
    case 'error':
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: taskMessageId,
        error: event.message || 'Unknown error',
      });
      void prisma.message.update({
        where: { id: taskMessageId },
        data: { status: 'error' },
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
    const basePrompt = buildTaskPrompt(task, sessionId);
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
  const agent = await prisma.agent.findUnique({ where: { name: agentName }, select: { id: true, name: true, systemPrompt: true, skills: true } });
  if (!agent) return;

  const taskMsgId = buildTaskMessageId(queue.planId, task.id);
  const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
    sessionId, agentName: agent.name, agentType: agent.name,
    messageId: taskMsgId, hostWorkDir: sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type), broadcast,
  });
  const fullPrompt = `${agent.systemPrompt}${languageConsistencyPrompt(detectLanguage(task.description || task.title))}\n\n---\n\n${buildTaskPrompt(task, sessionId)}\n${coordinationPrompt}`;

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
    const taskPrompt = failedTask ? buildTaskPrompt(failedTask.task, sessionId) : undefined;

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
  const taskPrompt = buildTaskPrompt(failedTask.task, sessionId);

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

  // Archive pipeline: when all tasks are done, archive the plan for future experience extraction
  if (allDone) {
    const sandbox = sandboxes.get(sessionId);
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
