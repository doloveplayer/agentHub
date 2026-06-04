import { watch, readFileSync, existsSync, statSync, unlinkSync, FSWatcher } from 'fs';
import { resolve } from 'path';
import { normalizePlan, validateBasic, assessRisk, planHash } from '../agent/PlanNormalizer.js';
import { broadcast } from './state.js';
import type { TaskDispatchNode } from './state.js';
import { DagPersistence } from '../agent/DagPersistence.js';
import { addDispatchedPlan } from './planHandlers.js';

const watchers = new Map<string, FSWatcher>();
const pollingIntervals = new Map<string, NodeJS.Timeout>();

/** Deduplication: maps sessionId → last dispatched plan hash */
const processedHashes = new Map<string, string>();

interface SandboxInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
  sandboxDir: string;
  hostSandboxDir: string;
}

/**
 * Unified plan dispatch hook.
 *
 * Call this whenever a plan.json may have been written or updated:
 * from AgentRuntime (Planner done event), from PlanWatcher (file system event),
 * or from any future trigger.
 *
 * Handles: read, validate, JSON retry, dedup, DAG reconciliation,
 * frontend broadcast, and task dispatch.
 */
export async function onPlanReady(
  sessionId: string,
  hostDir: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const planPath = resolve(hostDir, 'plan.json');
  await dispatchPlan(sessionId, planPath, sandbox, 0);
}

/**
 * Start watching for plan.json in both the sandbox dir and the user workspace.
 * The planner agent may write to either location depending on whether it uses
 * an absolute path (/sandbox/plan.json) or a relative path (plan.json from CWD=/workspace).
 */
export function startPlanWatcher(sessionId: string, hostSandboxDir: string, sandbox: SandboxInfo): void {
  if (hasWatcherForSession(sessionId)) {
    console.warn(`[PlanWatcher] Already watching session ${sessionId.slice(0, 8)}`);
    return;
  }

  // Possible plan.json locations: sandbox dir (intended) and user workspace (agent CWD fallback)
  const watchDirs = [hostSandboxDir];
  if (sandbox.hostWorkDir !== hostSandboxDir) {
    watchDirs.push(sandbox.hostWorkDir);
  }

  let debounceTimer: NodeJS.Timeout | null = null;

  const handlePlan = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      for (const dir of watchDirs) {
        const planPath = resolve(dir, 'plan.json');
        if (existsSync(planPath)) {
          dispatchPlan(sessionId, planPath, sandbox, 5).catch((err) => {
            console.error(`[PlanWatcher] Error handling plan for ${sessionId.slice(0, 8)}:`, err.message);
          });
          return;
        }
      }
    }, 200);
  };

  console.log(`[PlanWatcher] Starting watcher for session ${sessionId.slice(0, 8)} at ${watchDirs.join(', ')}`);

  // Watch all directories (dedup in handlePlanFile by hash prevents double-dispatch)
  for (const dir of watchDirs) {
    try {
      const watcher = watch(dir, (_eventType, filename) => {
        if (filename !== 'plan.json' && filename !== 'plan.json.tmp') return;
        handlePlan();
      });
      watchers.set(`${sessionId}:${dir}`, watcher);
      scheduleExistingPlanRead(sessionId, resolve(dir, 'plan.json'), sandbox);
    } catch (err: any) {
      console.warn(`[PlanWatcher] fs.watch failed for ${dir}, falling back to polling:`, err.message);
      startPolling(sessionId, resolve(dir, 'plan.json'), sandbox);
      scheduleExistingPlanRead(sessionId, resolve(dir, 'plan.json'), sandbox);
    }
  }
}

export function stopPlanWatcher(sessionId: string): void {
  // Close all watchers for this session (may have multiple dirs)
  for (const [key, watcher] of watchers) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) {
      watcher.close();
      watchers.delete(key);
    }
  }
  console.log(`[PlanWatcher] Stopped watcher(s) for session ${sessionId.slice(0, 8)}`);

  const interval = pollingIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    pollingIntervals.delete(sessionId);
  }

  processedHashes.delete(sessionId);
}

/**
 * Core plan dispatch logic — read, validate, dedup, dispatch.
 * Retries on Invalid JSON (Docker bind mount may show file before content syncs).
 */
async function dispatchPlan(
  sessionId: string,
  planPath: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
  retriesLeft: number,
): Promise<void> {
  if (!existsSync(planPath)) return;

  let raw: string;
  try {
    raw = readFileSync(planPath, 'utf-8');
  } catch {
    return;
  }

  if (!raw.trim()) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (retriesLeft > 0) {
      setTimeout(() => {
        dispatchPlan(sessionId, planPath, sandbox, retriesLeft - 1);
      }, 500);
      return;
    }
    console.warn(`[PlanWatcher] Invalid JSON in plan.json for ${sessionId.slice(0, 8)} after retries, giving up`);
    return;
  }

  const plan = normalizePlan(parsed);

  // Dedup by hash
  const hash = planHash(plan);
  if (processedHashes.get(sessionId) === hash) {
    console.log(`[PlanWatcher] Duplicate plan for ${sessionId.slice(0, 8)}, skipping`);
    return;
  }

  const validation = validateBasic(plan);
  if (!validation.valid) {
    console.warn(`[PlanWatcher] Invalid plan for ${sessionId.slice(0, 8)}: ${validation.reason}`);
    return;
  }

  // Check if this plan matches an existing DAG execution (by planTitle).
  // If so, reconcile Planner's status updates → DAG state instead of re-dispatching.
  const { reconcilePlanWithDag } = await import('./taskDispatcher.js');
  const reconciled = reconcilePlanWithDag(sessionId, plan.planTitle, plan.tasks.map((t) => ({
    id: t.id,
    status: t.risk,
  })), sandbox);

  const planTasks = (parsed.tasks as Array<Record<string, unknown>>) || [];
  const reconciled2 = reconcilePlanWithDag(sessionId, plan.planTitle, planTasks.map((t: Record<string, unknown>) => ({
    id: String(t.id || t.taskId || t.task_id || ''),
    status: String(t.status || ''),
  })), sandbox);

  if (reconciled > 0 || reconciled2 > 0) {
    console.log(`[PlanWatcher] Reconciled ${reconciled + reconciled2} tasks for session ${sessionId.slice(0, 8)}`);
    processedHashes.set(sessionId, hash);
    broadcast(sessionId, {
      type: 'plan_reconciled',
      planTitle: plan.planTitle,
      reconciled: reconciled + reconciled2,
    });
    return;
  }

  // If hash didn't change, skip re-dispatch (duplicate file write)
  if (processedHashes.get(sessionId) === hash) {
    console.log(`[PlanWatcher] Duplicate plan for ${sessionId.slice(0, 8)}, skipping`);
    return;
  }

  const risk = assessRisk(plan);
  const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const taskList = plan.tasks.map((t) => ({
    taskId: t.id,
    planId,
    title: t.title,
    description: t.description,
    agentType: t.agentType,
    dependsOn: t.dependsOn,
    expectedOutput: t.expectedOutput,
    priority: 'medium' as const,
    risk: t.risk,
    status: 'waiting' as const,
  }));

  processedHashes.set(sessionId, hash);

  broadcast(sessionId, {
    type: 'plan_result',
    planId,
    planTitle: plan.planTitle,
    summary: plan.summary,
    risk,
    requiresConfirmation: false, // Permission mode gates per-action, plan auto-dispatches
    tasks: taskList,
  });

  // Always dispatch — permission mode handles action-level gating
  console.log(`[PlanWatcher] Dispatching plan ${planId} (risk=${risk}, tasks=${plan.tasks.length})`);

  const tasks: TaskDispatchNode[] = plan.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    agentType: t.agentType,
    dependsOn: t.dependsOn,
    expectedOutput: t.expectedOutput,
    priority: 'medium',
  }));

  const { dispatchTasksToAgents } = await import('./taskDispatcher.js');

  // Prevent double-dispatch if user also clicks "Confirm All" in frontend panel
  addDispatchedPlan(planId);

  dispatchTasksToAgents(sessionId, planId, tasks, sandbox, plan.planTitle)
    .then(() => {
      broadcast(sessionId, { type: 'plan_executing', planId });
    })
    .catch((err: any) => {
      broadcast(sessionId, { type: 'stream_error', error: `Failed to dispatch tasks: ${err.message}` });
    });
}

function startPolling(
  sessionId: string,
  planPath: string,
  sandbox: SandboxInfo,
): void {
  let lastMtime = 0;

  const interval = setInterval(() => {
    try {
      const stat = statSync(planPath);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        dispatchPlan(sessionId, planPath, sandbox, 5).catch(() => {});
      }
    } catch {
      // File may not exist yet
    }
  }, 500);

  pollingIntervals.set(sessionId, interval);
}

function scheduleExistingPlanRead(
  sessionId: string,
  planPath: string,
  sandbox: SandboxInfo,
): void {
  setTimeout(async () => {
    if (!hasWatcherForSession(sessionId) && !pollingIntervals.has(sessionId)) return;

    // Clean up stale plan.json from previous cycles before dispatching
    try {
      const dbPlans = await DagPersistence.recover(sessionId);
      const hasArchived = dbPlans.some(p => p.status === 'archived');
      const hasLive = dbPlans.some(p => p.status === 'executing');
      if (hasArchived && !hasLive) {
        console.log(`[PlanWatcher] Stale plan.json detected for ${sessionId.slice(0, 8)} (all plans archived), removing`);
        try { unlinkSync(planPath); } catch { /* best effort */ }
        return;
      }
    } catch {
      // DB unavailable — proceed normally
    }

    dispatchPlan(sessionId, planPath, sandbox, 5).catch((err) => {
      console.error(`[PlanWatcher] Error handling existing plan for ${sessionId.slice(0, 8)}:`, err.message);
    });
  }, 100);
}

function hasWatcherForSession(sessionId: string): boolean {
  for (const key of watchers.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) return true;
  }
  return false;
}
