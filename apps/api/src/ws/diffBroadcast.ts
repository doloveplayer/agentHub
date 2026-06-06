import { WorkspaceManager, type WorkspaceVersion, type MergeResult } from '../agent/WorkspaceManager.js';
import { broadcast } from './state.js';


const beforeVersions = new Map<string, WorkspaceVersion | null>();
const sessionAgentRefs = new Map<string, Map<string, string>>();   // sessionId -> (agentName -> afterVersion ref)
const sessionBaseRef = new Map<string, string>();                   // sessionId -> common base ref (first agent's beforeVersion)
const sessionAgentTaskContext = new Map<string, Map<string, { planId: string; taskId: string }>>(); // sessionId -> (agentName -> task context)
/** sessionId -> (agentName -> set of changed file paths) — for file-set overlap detection */
const sessionAgentChangedFiles = new Map<string, Map<string, Set<string>>>();

export function recordWorkspaceVersionSafe(
  workspacePath: string,
  sessionId: string,
  agentName: string,
  summary: string,
): WorkspaceVersion | null {
  try {
    return WorkspaceManager.recordVersion(workspacePath, { sessionId, agentName, summary });
  } catch (err: any) {
    console.warn(`[ws] Workspace version skipped: ${err.message}`);
    return null;
  }
}

export function recordMessageBeforeVersion(
  messageId: string,
  workspacePath: string,
  sessionId: string,
  agentName: string,
  summary: string,
): WorkspaceVersion | null {
  const version = recordWorkspaceVersionSafe(workspacePath, sessionId, agentName, summary);
  beforeVersions.set(messageId, version);
  return version;
}

export function takeMessageBeforeVersion(messageId: string): WorkspaceVersion | null {
  const version = beforeVersions.get(messageId) ?? null;
  beforeVersions.delete(messageId);
  return version;
}

export function clearDiffTracking(sessionId: string): void {
  sessionAgentRefs.delete(sessionId);
  sessionBaseRef.delete(sessionId);
  sessionAgentTaskContext.delete(sessionId);
  sessionAgentChangedFiles.delete(sessionId);
}

function tryAutoMergeConflicts(
  sessionId: string,
  workspacePath: string,
  conflicts: { filePath: string; agents: string[] }[],
): void {
  const agentRefs = sessionAgentRefs.get(sessionId);
  const baseRef = sessionBaseRef.get(sessionId);
  if (!agentRefs || agentRefs.size < 2 || !baseRef) return;

  const refMap = new Map<string, string>();
  for (const [agent, ref] of agentRefs) { refMap.set(agent, ref); }

  const conflictsInput = conflicts.map((c) => ({
    filePath: c.filePath,
    agents: c.agents,
    ranges: [], // ranges no longer used — 3-way merge handles line-level resolution
  }));

  const results = WorkspaceManager.tryAutoMerge(workspacePath, conflictsInput, baseRef, refMap);

  const resolved = results.filter((r) => r.resolved);
  const unresolved = results.filter((r) => !r.resolved);

  if (resolved.length > 0) {
    broadcast(sessionId, {
      type: 'conflict_resolved',
      files: resolved.map((r) => ({ filePath: r.filePath, agents: r.agents })),
    });
    console.log(`[ws] Auto-merge resolved: session=${sessionId} files=${resolved.map((r) => r.filePath).join(', ')}`);
  }

  if (unresolved.length > 0) {
    // Build task context from tracked agent task info
    const taskContextMap = sessionAgentTaskContext.get(sessionId);
    const taskContext = unresolved.map((r) => ({
      filePath: r.filePath,
      agents: r.agents,
      agentTasks: r.agents.map((agentName) => {
        const ctx = taskContextMap?.get(agentName);
        return ctx ? { agentName, planId: ctx.planId, taskId: ctx.taskId } : { agentName };
      }),
    }));

    broadcast(sessionId, {
      type: 'conflict_unresolved',
      files: unresolved.map((r) => ({ filePath: r.filePath, agents: r.agents })),
      taskContext,
    });
    console.log(`[ws] Auto-merge unresolved (needs manual): session=${sessionId} files=${unresolved.map((r) => r.filePath).join(', ')}`);

    // Escalate to Planner for resolution
    import('./conflictEscalation.js').then(({ escalateUnresolvedConflicts }) => {
      escalateUnresolvedConflicts(sessionId, workspacePath, taskContext).catch(
        (err: any) => console.error(`[ws] Conflict escalation failed: ${err.message}`)
      );
    }).catch(() => {});
  }
}

export function broadcastDiffSummary(
  sessionId: string,
  agentMessageId: string,
  workspacePath: string,
  beforeVersion: WorkspaceVersion | null,
  agentName: string,
  summary?: string,
  context?: { planId: string; taskId: string },
): void {
  if (!beforeVersion) return;
  const afterVersion = recordWorkspaceVersionSafe(
    workspacePath,
    sessionId,
    agentName,
    summary || `After ${agentName} turn`,
  );
  if (!afterVersion) return;

  // Track agent version refs for auto-merge
  if (!sessionAgentRefs.has(sessionId)) sessionAgentRefs.set(sessionId, new Map());
  sessionAgentRefs.get(sessionId)!.set(agentName, afterVersion.ref);
  // First agent's beforeVersion serves as common base for the session
  if (!sessionBaseRef.has(sessionId)) sessionBaseRef.set(sessionId, beforeVersion.ref);
  // Store task context for conflict escalation
  if (context) {
    if (!sessionAgentTaskContext.has(sessionId)) sessionAgentTaskContext.set(sessionId, new Map());
    sessionAgentTaskContext.get(sessionId)!.set(agentName, { planId: context.planId, taskId: context.taskId });
  }

  const files = WorkspaceManager.getWorkspaceDiff(workspacePath, beforeVersion.id)
    .filter((file) => file.diff.trim().length > 0);
  if (files.length === 0) return;

  // Skip planner diffs in conflict detection — planner creates files that
  // other agents later modify. These are sequential dependencies, not conflicts.
  const isPlanner = agentName === 'planner' || agentName.startsWith('planner-');
  if (isPlanner) return;

  // Track changed files per agent for file-set overlap detection
  const changedPaths = new Set(files.map((f) => f.path));
  if (!sessionAgentChangedFiles.has(sessionId)) sessionAgentChangedFiles.set(sessionId, new Map());
  sessionAgentChangedFiles.get(sessionId)!.set(agentName, changedPaths);

  // Detect conflicts by file-set overlap (not diff range comparison).
  // Diff ranges are relative to different base versions and not comparable.
  // 3-way merge (git merge-file) handles line-level resolution internally.
  const agentRefs = sessionAgentRefs.get(sessionId);
  const baseRef = sessionBaseRef.get(sessionId);
  if (!agentRefs || agentRefs.size < 2 || !baseRef) return;

  const overlapConflicts: { filePath: string; agents: string[] }[] = [];
  const allAgents = sessionAgentChangedFiles.get(sessionId)!;
  for (const [otherAgent, otherFiles] of allAgents) {
    if (otherAgent === agentName) continue;
    for (const filePath of changedPaths) {
      if (otherFiles.has(filePath)) {
        overlapConflicts.push({ filePath, agents: [agentName, otherAgent] });
      }
    }
  }

  // Deduplicate (A,B and B,A for same file)
  const seen = new Set<string>();
  const deduped = overlapConflicts.filter((c) => {
    const key = `${c.filePath}::${[...c.agents].sort().join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length > 0) {
    tryAutoMergeConflicts(sessionId, workspacePath, deduped);
  }
}
