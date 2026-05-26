// Task-to-Agent dispatch: routes Planner tasks to session agents via REPL.
// Extracted from handler.ts.

import { stateTracker } from '../agent/StateTracker.js';
import { findClosestAgent } from '../agent/turns.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { DagPersistence } from '../agent/DagPersistence.js';
import { agentCoordinator } from '../agent/AgentCoordinator.js';

import { createOneShotAgentProcess } from '../agent/processFactory.js';
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
  broadcast, agentProcesses, agentStates, agentTaskQueues,
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
  const queueNames = [...agentTaskQueues.keys()];
  for (const name of queueNames) {
    if (name === agentType) return name;
  }
  // Also check agentProcesses
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    for (const [name] of procMap) {
      if (name === agentType) return name;
    }
  }
  return null;
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
    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: procInfo.agentId });
    procInfo.provider.sendPrompt(taskPrompt);
  } else {
    // One-shot fallback: start a ClaudeCodeProcess directly for the task
    await dispatchTaskOneShot(sessionId, agentName, task, queue);
  }
}

async function dispatchTaskOneShot(
  sessionId: string,
  agentName: string,
  task: TaskDispatchNode,
  queue: AgentTaskQueue,
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { console.log(`[ws] Task dispatch: no sandbox for session ${sessionId}`); return; }
  const agent = await prisma.agent.findUnique({ where: { name: agentName }, select: { id: true, name: true, systemPrompt: true } });
  if (!agent) { console.log(`[ws] Task dispatch: agent ${agentName} not found in DB`); return; }
  const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
    sessionId, agentName: agent.name, agentType: agent.name,
    messageId: buildTaskMessageId(queue.planId, task.id),
    hostWorkDir: sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  });
  const fullPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}\n${coordinationPrompt}`;
  const proc = createOneShotAgentProcess();
  const taskMsgId = buildTaskMessageId(queue.planId, task.id);
  let output = '';

  proc.onEvent((event) => {
    switch (event.type) {
      case 'text':
        output += event.content;
        broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId: taskMsgId });
        break;
      case 'done':
        broadcast(sessionId, { type: 'stream_end', agentMessageId: taskMsgId, fullContent: output || '[Task completed]', exitCode: event.exitCode });
        broadcast(sessionId, { type: event.exitCode === 0 ? 'task_completed' : 'task_failed', planId: queue.planId, taskId: task.id, agentName, output: output.slice(0, 200) });
        stateTracker.setDone(taskMsgId);
        agentCurrentTask.delete(agentName);
        queue.current = null;
        processNextInQueue(sessionId, agentName, queue);
        void handleDispatchedTaskFinished(sessionId, queue.planId, task.id, event.exitCode === 0);
        break;
      case 'error':
        broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: event.message });
        stateTracker.setError(taskMsgId);
        break;
    }
  });

  broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: agent.id });
  console.log(`[ws] Task dispatch (one-shot): agent=${agentName} task=${task.id}`);
  proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, true, sandbox.hostWorkDir, taskMsgId, undefined, agentName)
    .catch((err: any) => {
      console.error(`[ws] Task one-shot failed: ${err.message}`);
      broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: `Task failed: ${err.message}` });
    });
}

// startTaskAgent kept for backwards compatibility — redirects to one-shot dispatch
export async function startTaskAgent(
  sessionId: string,
  agent: { id: string; name: string; displayName: string; systemPrompt: string },
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const queue = agentTaskQueues.get(agent.name);
  if (!queue || queue.tasks.length === 0) return;

  const task = queue.tasks.shift()!;
  queue.current = task;
  agentCurrentTask.set(agent.name, { planId: queue.planId, taskId: task.id });
  markTaskRunningForPlan(sessionId, queue.planId, task.id);

  const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
    sessionId, agentName: agent.name, agentType: agent.name,
    messageId: buildTaskMessageId(queue.planId, task.id),
    hostWorkDir: sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  });
  const fullPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}\n${coordinationPrompt}`;
  const taskMsgId = buildTaskMessageId(queue.planId, task.id);
  let output = '';

  recordMessageBeforeVersion(
    taskMsgId, sandbox.hostWorkDir, sessionId, agent.name,
    `Before ${agent.name} task ${task.id}`,
  );

  const proc = createOneShotAgentProcess();
  proc.onEvent((event) => {
    switch (event.type) {
      case 'text':
        output += event.content;
        broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId: taskMsgId });
        break;
      case 'tool_use':
        broadcast(sessionId, { type: 'agent_status', status: 'tool_use',
          details: { toolName: event.toolName, input: event.input }, agentMessageId: taskMsgId, timestamp: Date.now() });
        {
          const agentType = agent.name;
          const filePath = (event as any).input?.file_path || (event as any).input?.path || (event as any).input?.filePath;
          agentCoordinator.onToolUse({
            sessionId,
            agentName: agent.name,
            agentType,
            messageId: taskMsgId,
            hostWorkDir: sandbox.hostWorkDir,
            resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
            broadcast,
          }, { type: 'tool_use', toolName: (event as any).toolName || '', input: (event as any).input || {} } as any);
        }
        break;
      case 'system': {
        const sysEvent = event as any;
        broadcast(sessionId, { type: 'agent_status', status: 'token_update',
          details: { tokenUsage: { input: sysEvent.inputTokens || 0, output: sysEvent.outputTokens || 0 } },
          agentMessageId: taskMsgId, timestamp: Date.now() });
        break;
      }
      case 'done': {
        const fullContent = output || (event.exitCode === 0 ? '[Task completed]' : '[Task failed]');
        broadcast(sessionId, { type: 'stream_end', agentMessageId: taskMsgId, fullContent, exitCode: event.exitCode ?? 0 });
        broadcastDiffSummary(
          sessionId, taskMsgId, sandbox.hostWorkDir,
          takeMessageBeforeVersion(taskMsgId), agent.name, fullContent,
        );
        {
          const agentType = agent.name;
          const summary = fullContent.slice(0, 200);
          agentCoordinator.onAgentDone({
            sessionId, agentName: agent.name, agentType,
            messageId: taskMsgId,
            hostWorkDir: sandbox.hostWorkDir,
            resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
            broadcast,
          }, event.exitCode ?? 0, summary);
        }
        broadcast(sessionId, {
          type: event.exitCode === 0 ? 'task_completed' : 'task_failed',
          planId: queue.planId, taskId: task.id, agentName: agent.name,
          output: event.exitCode === 0 ? 'done' : `exit code ${event.exitCode}`,
        });
        stateTracker.setDone(taskMsgId);
        agentCurrentTask.delete(agent.name);
        agentCurrentMessage.delete(agent.name);
        queue.current = null;
        processNextInQueue(sessionId, agent.name, queue);
        void handleDispatchedTaskFinished(sessionId, queue.planId, task.id, event.exitCode === 0);
        break;
      }
      case 'error':
        broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: event.message || 'Unknown error' });
        stateTracker.setError(taskMsgId);
        break;
    }
  });

  // Skip if this task message already exists (prevents re-dispatch on reconnect)
  const existingMsg = await prisma.message.findUnique({ where: { id: taskMsgId } }).catch(() => null);
  if (existingMsg && existingMsg.status !== 'streaming') {
    console.log(`[ws] Task dispatch: skipping already-completed task ${task.id} for ${agent.name}`);
    queue.current = null;
    agentCurrentTask.delete(agent.name);
    processNextInQueue(sessionId, agent.name, queue);
    return;
  }

  const taskMsg = await prisma.message.create({
    data: { id: taskMsgId, sessionId, senderType: 'agent', agentId: agent.id, content: '', status: 'streaming' },
  }).catch(() => null);

  if (taskMsg) {
    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(taskMsg.id, { process: proc, timer: setTimeout(() => {}, config.agent.timeoutMs), agentId: agent.id, agentName: agent.name });
    incRunningAgentCount();
  }

  broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName: agent.name, agentId: agent.id });
  console.log(`[ws] Task dispatch (one-shot): agent=${agent.name} task=${task.id}`);
  proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, true, sandbox.hostWorkDir, taskMsgId, undefined, agent.name)
    .catch((err: any) => {
      console.error(`[ws] Task one-shot failed: ${err.message}`);
      broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: `Task failed: ${err.message}` });
    });
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
    const list = agentsByType.get(sa.agent.displayName) || [];
    list.push(sa.agent);
    agentsByType.set(sa.agent.displayName, list);
  }

  const loadByAgent = new Map<string, number>();
  const missingTypes = new Set<string>();
  const assignments: DagTaskAssignment[] = [];

  for (const task of tasks) {
    const candidates = agentsByType.get(task.agentType) || [];
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
            name: task.agentType.toLowerCase().replace('agent', '-agent'),
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
    const blocked = markTaskFailed(execution, taskId);
    for (const item of blocked) {
      broadcast(sessionId, {
        type: 'task_blocked',
        planId,
        taskId: item.task.id,
        blockedBy: taskId,
        agentName: item.agentName,
        output: `Blocked because dependency ${taskId} failed`,
      });
    }
  }

  maybeBroadcastPlanSummary(sessionId, execution);
  persistState(sessionId, planId, execution).catch((err) =>
    console.error(`[dag] Persist error on task finish: ${err.message}`));
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
