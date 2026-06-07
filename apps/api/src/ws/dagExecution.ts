import type { TaskDispatchNode } from './state.js';

export type DagTaskStatus = 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'blocked';

export interface DagTaskAssignment {
  task: TaskDispatchNode;
  agentName: string;
  agentId: string;
}

export interface DagExecutionItem extends DagTaskAssignment {
  status: DagTaskStatus;
  dependents: string[];
  retryCount: number;
  lastError?: string;
  /** Timestamp when this task last transitioned to 'running' */
  startedAt?: number;
  /** Timestamp of the last event (tool_use, token_update, etc.) for this task */
  lastEventAt?: number;
}

export interface DagExecutionState {
  planId: string;
  planTitle?: string;
  tasks: Map<string, DagExecutionItem>;
  summaryBroadcasted?: boolean;
}

export function createDagExecutionState(
  planId: string,
  assignments: DagTaskAssignment[],
  planTitle?: string,
): DagExecutionState {
  const tasks = new Map<string, DagExecutionItem>();

  for (const assignment of assignments) {
    const id = assignment.task.id;
    if (tasks.has(id)) throw new Error(`Duplicate task id in plan: ${id}`);
    tasks.set(id, { ...assignment, status: 'waiting', dependents: [], retryCount: 0 });
  }

  for (const item of tasks.values()) {
    for (const depId of item.task.dependsOn) {
      const dep = tasks.get(depId);
      if (!dep) throw new Error(`Task ${item.task.id} depends on missing task ${depId}`);
      dep.dependents.push(item.task.id);
    }
  }

  assertAcyclic(tasks);

  return { planId, tasks, planTitle };
}

export function consumeReadyTasks(state: DagExecutionState): DagTaskAssignment[] {
  const ready: DagTaskAssignment[] = [];
  for (const item of state.tasks.values()) {
    if (item.status !== 'waiting') continue;
    const unmet = item.task.dependsOn.filter((depId) => state.tasks.get(depId)?.status !== 'done');
    if (unmet.length > 0) {
      console.log(`[dag] Task ${item.task.id} waiting for: ${unmet.join(', ')} (statuses: ${unmet.map(d => d + '=' + state.tasks.get(d)?.status).join(', ')})`);
      continue;
    }
    item.status = 'queued';
    console.log(`[dag] Task ${item.task.id} ready (dependsOn=[${item.task.dependsOn.join(',')}])`);
    ready.push(toAssignment(item));
  }
  return ready;
}

export function markTaskRunning(state: DagExecutionState, taskId: string): void {
  const item = state.tasks.get(taskId);
  if (!item) return;
  if (item.status === 'waiting' || item.status === 'queued') {
    item.status = 'running';
    item.startedAt = Date.now();
    item.lastEventAt = Date.now();
  }
}

/** Record activity on a running task to prevent timeout. */
export function touchTask(state: DagExecutionState, taskId: string): void {
  const item = state.tasks.get(taskId);
  if (!item || item.status !== 'running') return;
  item.lastEventAt = Date.now();
}

/**
 * Find tasks that have been running longer than `timeoutMs` without any activity.
 * Returns task IDs that should be considered stale.
 */
export function checkStaleTasks(state: DagExecutionState, timeoutMs: number): string[] {
  const now = Date.now();
  const stale: string[] = [];
  for (const item of state.tasks.values()) {
    if (item.status !== 'running') continue;
    const lastActivity = item.lastEventAt || item.startedAt || 0;
    if (lastActivity > 0 && (now - lastActivity) > timeoutMs) {
      stale.push(item.task.id);
    }
  }
  return stale;
}

/**
 * Force a task to 'done' status, then consume ready dependents.
 * Used for manual recovery and plan.json reconciliation.
 */
export function forceTaskDone(state: DagExecutionState, taskId: string): DagTaskAssignment[] {
  const item = state.tasks.get(taskId);
  if (!item) return [];
  item.status = 'done';
  return consumeReadyTasks(state);
}

/**
 * Force a task to 'failed' status, blocking dependents.
 * Used for manual recovery.
 */
export function forceTaskFailed(state: DagExecutionState, taskId: string, reason: string): DagTaskAssignment[] {
  const item = state.tasks.get(taskId);
  if (!item) return [];
  item.status = 'failed';
  item.lastError = reason;
  return markTaskFailed(state, taskId);
}

export function markTaskDone(state: DagExecutionState, taskId: string): DagTaskAssignment[] {
  const item = state.tasks.get(taskId);
  if (!item) return [];
  item.status = 'done';
  return consumeReadyTasks(state);
}

export function markTaskFailed(state: DagExecutionState, taskId: string): DagTaskAssignment[] {
  const item = state.tasks.get(taskId);
  if (!item) return [];
  item.status = 'failed';

  const blocked: DagTaskAssignment[] = [];
  const visit = (id: string) => {
    const current = state.tasks.get(id);
    if (!current || current.status === 'done' || current.status === 'failed' || current.status === 'blocked') return;
    current.status = 'blocked';
    blocked.push(toAssignment(current));
    for (const childId of current.dependents) visit(childId);
  };

  for (const childId of item.dependents) visit(childId);
  return blocked;
}

export function markTaskRetryQueued(state: DagExecutionState, taskId: string): DagTaskAssignment | null {
  const item = state.tasks.get(taskId);
  if (!item || item.status !== 'failed') return null;

  item.status = 'queued';
  item.retryCount += 1;
  state.summaryBroadcasted = false;
  resetRecoverableBlockedDescendants(state, item, new Set([taskId]));
  return toAssignment(item);
}

/**
 * Reset a completed (done) task back to queued for conflict retry.
 * Unlike markTaskRetryQueued (which only handles 'failed' status),
 * this supports resetting successfully completed tasks when their
 * output conflicts with another task. Also works on 'failed' tasks.
 */
export function resetDoneTaskToRetry(state: DagExecutionState, taskId: string): DagTaskAssignment | null {
  const item = state.tasks.get(taskId);
  if (!item) return null;
  if (item.status !== 'done' && item.status !== 'failed') return null;

  item.status = 'queued';
  item.retryCount += 1;
  item.lastError = `File conflict — retrying (attempt ${item.retryCount})`;
  state.summaryBroadcasted = false;

  // Unblock any dependent tasks that only depended on this one
  for (const childId of item.dependents) {
    const child = state.tasks.get(childId);
    if (!child || child.status !== 'blocked') continue;
    const allDepsDone = child.task.dependsOn.every((depId) => {
      if (depId === taskId) return true; // This one is being retried
      return state.tasks.get(depId)?.status === 'done';
    });
    if (allDepsDone) {
      child.status = 'waiting';
    }
  }

  return toAssignment(item);
}

function toAssignment(item: DagExecutionItem): DagTaskAssignment {
  return { task: item.task, agentName: item.agentName, agentId: item.agentId };
}

function resetRecoverableBlockedDescendants(
  state: DagExecutionState,
  parent: DagExecutionItem,
  recoveringIds: Set<string>,
): void {
  for (const childId of parent.dependents) {
    const child = state.tasks.get(childId);
    if (!child || child.status !== 'blocked') continue;

    const canRecover = child.task.dependsOn.every((depId) => {
      if (recoveringIds.has(depId)) return true;
      return state.tasks.get(depId)?.status === 'done';
    });
    if (!canRecover) continue;

    child.status = 'waiting';
    recoveringIds.add(child.task.id);
    resetRecoverableBlockedDescendants(state, child, recoveringIds);
  }
}

function assertAcyclic(tasks: Map<string, DagExecutionItem>): void {
  const inDegree = new Map<string, number>();
  for (const item of tasks.values()) inDegree.set(item.task.id, item.task.dependsOn.length);

  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    const item = tasks.get(id);
    if (!item) continue;
    for (const childId of item.dependents) {
      const nextDegree = (inDegree.get(childId) || 0) - 1;
      inDegree.set(childId, nextDegree);
      if (nextDegree === 0) queue.push(childId);
    }
  }

  if (visited !== tasks.size) {
    const stuck = [...inDegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id)
      .join(', ');
    throw new Error(`Circular dependency in plan: ${stuck}`);
  }
}
