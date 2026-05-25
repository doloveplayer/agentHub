// Task-to-Agent dispatch: routes Planner tasks to session agents via REPL.
// Extracted from handler.ts.

import { stateTracker } from '../agent/StateTracker.js';
import { findClosestAgent } from '../agent/turns.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';

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
  const fullPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}`;
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
  proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, true, sandbox.hostWorkDir, taskMsgId)
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

  const fullPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}`;
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
  proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, true, sandbox.hostWorkDir, taskMsgId)
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

  const execution = createDagExecutionState(planId, assignments);
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
    queue.tasks.push(assignment.task);
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
}

function maybeBroadcastPlanSummary(sessionId: string, execution: DagExecutionState): void {
  if (execution.summaryBroadcasted) return;

  const items = [...execution.tasks.values()];
  const completed = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'failed' || item.status === 'blocked').length;
  const finished = completed + failed;

  if (finished !== items.length) return;

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
