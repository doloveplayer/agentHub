import { watch, readFileSync, existsSync, statSync, FSWatcher } from 'fs';
import { resolve } from 'path';
import { normalizePlan, validateBasic, assessRisk, planHash } from '../agent/PlanNormalizer.js';
import { broadcast } from './state.js';
import type { TaskDispatchNode } from './state.js';

const watchers = new Map<string, FSWatcher>();
const processedHashes = new Map<string, string>();
const pollingIntervals = new Map<string, NodeJS.Timeout>();

interface SandboxInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
}

export function startPlanWatcher(sessionId: string, hostWorkDir: string, sandbox: SandboxInfo): void {
  if (watchers.has(sessionId)) {
    console.warn(`[PlanWatcher] Already watching session ${sessionId.slice(0, 8)}`);
    return;
  }

  const planPath = resolve(hostWorkDir, 'plan.json');

  let debounceTimer: NodeJS.Timeout | null = null;

  console.log(`[PlanWatcher] Starting watcher for session ${sessionId.slice(0, 8)} at ${hostWorkDir}`);

  try {
    const watcher = watch(hostWorkDir, (_eventType, filename) => {
      if (filename !== 'plan.json' && filename !== 'plan.json.tmp') return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        handlePlanFile(sessionId, planPath, sandbox).catch((err) => {
          console.error(`[PlanWatcher] Error handling plan for ${sessionId.slice(0, 8)}:`, err.message);
        });
      }, 200);
    });

    watchers.set(sessionId, watcher);
  } catch (err: any) {
    console.warn(`[PlanWatcher] fs.watch failed for ${sessionId.slice(0, 8)}, falling back to polling:`, err.message);
    startPolling(sessionId, planPath, sandbox);
  }
}

export function stopPlanWatcher(sessionId: string): void {
  const watcher = watchers.get(sessionId);
  if (watcher) {
    watcher.close();
    watchers.delete(sessionId);
    console.log(`[PlanWatcher] Stopped watcher for session ${sessionId.slice(0, 8)}`);
  }

  const interval = pollingIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    pollingIntervals.delete(sessionId);
  }

  processedHashes.delete(sessionId);
}

async function handlePlanFile(
  sessionId: string,
  planPath: string,
  sandbox: SandboxInfo,
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
    console.log(`[PlanWatcher] Invalid JSON in plan.json for ${sessionId.slice(0, 8)}, waiting for completion`);
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

  processedHashes.set(sessionId, hash);

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

  broadcast(sessionId, {
    type: 'plan_result',
    planId,
    planTitle: plan.planTitle,
    summary: plan.summary,
    risk,
    requiresConfirmation: risk === 'high',
    tasks: taskList,
  });

  if (risk === 'low') {
    console.log(`[PlanWatcher] Low-risk plan ${planId}, dispatching immediately`);

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

    dispatchTasksToAgents(sessionId, planId, tasks, sandbox, plan.planTitle)
      .then(() => {
        broadcast(sessionId, { type: 'plan_executing', planId });
      })
      .catch((err: any) => {
        broadcast(sessionId, { type: 'stream_error', error: `Failed to dispatch tasks: ${err.message}` });
      });
  } else {
    console.log(`[PlanWatcher] High-risk plan ${planId}, awaiting user confirmation`);
  }
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
        handlePlanFile(sessionId, planPath, sandbox).catch(() => {});
      }
    } catch {
      // File may not exist yet
    }
  }, 500);

  pollingIntervals.set(sessionId, interval);
}
