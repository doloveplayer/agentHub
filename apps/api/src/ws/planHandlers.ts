// Plan confirmation, task modification, retry, replan, and force-complete/fail handlers.
// Extracted from handler.ts to keep modules focused.

import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { prisma } from '../db/prisma.js';
import {
  sandboxes,
  agentTaskQueues,
  taskModifications,
  broadcast,
  type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';

import {
  dispatchTasksToAgents,
  processNextInQueue,
  prepareDispatchedTaskRetry,
  handleReplanFailedTask,
  handleForceCompleteTask,
  handleForceFailTask,
} from './taskDispatcher.js';

import { drainPendingQueue, drainPerSessionQueue } from './chatHandlers.js';

// ---- Plan deduplication ----

/** Prevent re-dispatching the same plan (can happen on WS reconnect with buffered messages) */
const dispatchedPlans = new Map<string, number>(); // planId → timestamp
const DISPATCHED_PLAN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function addDispatchedPlan(planId: string): void {
  const now = Date.now();
  // Evict expired entries
  for (const [id, ts] of dispatchedPlans) {
    if (now - ts > DISPATCHED_PLAN_TTL_MS) dispatchedPlans.delete(id);
  }
  dispatchedPlans.set(planId, now);
}

function isPlanDispatched(planId: string): boolean {
  const ts = dispatchedPlans.get(planId);
  if (!ts) return false;
  if (Date.now() - ts > DISPATCHED_PLAN_TTL_MS) {
    dispatchedPlans.delete(planId);
    return false;
  }
  return true;
}

// ---- Plan handling ----

function applyTaskModifications(tasks: any[]): any[] {
  return tasks.map(t => {
    const key = `${t.planId}:${t.taskId || t.id}`;
    const modified = taskModifications.get(key);
    if (modified) { taskModifications.delete(key); }
    return modified ? { ...t, description: modified } : t;
  });
}

export async function handleConfirmPlan(sessionId: string, data: { planId: string; tasks: any[] }): Promise<void> {
  if (isPlanDispatched(data.planId)) {
    console.log(`[ws] Plan ${data.planId} already dispatched, skipping`);
    return;
  }
  addDispatchedPlan(data.planId);

  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' }); return; }
  const normalized = applyTaskModifications(data.tasks.map((t: any) => ({ ...t, planId: data.planId })));
  const tasks: TaskDispatchNode[] = normalized.map((t: any) => ({
    id: t.taskId || t.id, title: t.title, description: t.description || '',
    agentType: t.agentType || 'code-agent', dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    expectedOutput: t.expectedOutput || '', priority: t.priority || 'medium',
  }));

  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true, providerConfig: true } } },
  });
  for (const sa of sessionAgents) {
    AgentDirectoryManager.initialize(sandbox.hostSandboxDir, sa.agent.name, sa.agent.systemPrompt, sa.agent.providerConfig as Record<string, unknown> | null);
  }

  dispatchTasksToAgents(sessionId, data.planId, tasks, {
    containerId: sandbox.containerId, workDir: sandbox.workDir, hostWorkDir: sandbox.hostWorkDir,
  }).then(() => {
    broadcast(sessionId, { type: 'plan_executing', planId: data.planId });
  }).catch((err: any) => {
    dispatchedPlans.delete(data.planId);
    broadcast(sessionId, { type: 'stream_error', error: `Failed to dispatch tasks: ${err.message}` });
  });
}

export function handleModifyTask(sessionId: string, data: { planId: string; taskId: string; newDescription: string }): void {
  taskModifications.set(`${data.planId}:${data.taskId}`, data.newDescription);
  broadcast(sessionId, { type: 'task_modified', planId: data.planId, taskId: data.taskId, newDescription: data.newDescription });
}

export async function handleRetryTask(sessionId: string, data: { planId: string; taskId: string; task?: any }): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) return;

  const taskNode: any = data.task;
  if (!taskNode) {
    broadcast(sessionId, { type: 'stream_error', error: 'Retry requires full task data. Please re-run the Planner.' });
    return;
  }
  taskNode.id = taskNode.taskId || taskNode.id || data.taskId;

  let agentName: string | undefined;
  if (taskNode.agentType) {
    const agent = await prisma.agent.findFirst({
      where: { name: taskNode.agentType }, select: { name: true, systemPrompt: true },
    });
    if (agent) agentName = agent.name;
  }

  if (agentName) {
    const dispatchNode: TaskDispatchNode = {
      id: taskNode.id, title: taskNode.title, description: taskNode.description || '',
      agentType: taskNode.agentType || 'code-agent', dependsOn: [],
      expectedOutput: taskNode.expectedOutput || '', priority: (taskNode.priority as 'high' | 'medium' | 'low') || 'medium',
    };
    prepareDispatchedTaskRetry(sessionId, data.planId, dispatchNode.id);
    const existingQueue = agentTaskQueues.get(agentName);
    if (existingQueue) {
      existingQueue.tasks.unshift(dispatchNode);
      if (!existingQueue.current) processNextInQueue(sessionId, agentName, existingQueue);
    } else {
      const newQueue: AgentTaskQueue = { planId: data.planId, sessionId, tasks: [], current: null, sandbox };
      newQueue.tasks.push(dispatchNode);
      agentTaskQueues.set(agentName, newQueue);
      processNextInQueue(sessionId, agentName, newQueue);
    }
  } else {
    broadcast(sessionId, { type: 'stream_error', error: `No agent found for type: ${taskNode.agentType}` });
  }
}

export function handleReplanRequest(sessionId: string, data: { planId: string; taskId: string }): void {
  console.log(`[ws] Replan request: planId=${data.planId} taskId=${data.taskId}`);
  handleReplanFailedTask(sessionId, data.planId, data.taskId).catch((err: any) => {
    broadcast(sessionId, { type: 'stream_error', error: `Re-plan failed: ${err.message}` });
  });
}

// ---- Manual task recovery handlers ----

export async function handleForceCompleteTaskMsg(
  sessionId: string,
  data: { planId: string; taskId: string },
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }
  await handleForceCompleteTask(sessionId, data.planId, data.taskId, {
    containerId: sandbox.containerId,
    workDir: sandbox.workDir,
    hostWorkDir: sandbox.hostWorkDir,
  });
}

export async function handleForceFailTaskMsg(
  sessionId: string,
  data: { planId: string; taskId: string; reason?: string },
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }
  await handleForceFailTask(sessionId, data.planId, data.taskId, data.reason || 'Manually failed by user', {
    containerId: sandbox.containerId,
    workDir: sandbox.workDir,
    hostWorkDir: sandbox.hostWorkDir,
  });
}
