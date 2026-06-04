import { WorkspaceManager, type AgentFileDiff, type WorkspaceVersion, type MergeResult } from '../agent/WorkspaceManager.js';
import { broadcast } from './state.js';


const beforeVersions = new Map<string, WorkspaceVersion | null>();
const sessionAgentDiffs = new Map<string, AgentFileDiff[]>();
const sessionAgentRefs = new Map<string, Map<string, string>>();   // sessionId -> (agentName -> afterVersion ref)
const sessionBaseRef = new Map<string, string>();                   // sessionId -> common base ref (first agent's beforeVersion)
const sessionAgentTaskContext = new Map<string, Map<string, { planId: string; taskId: string }>>(); // sessionId -> (agentName -> task context)

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
  sessionAgentDiffs.delete(sessionId);
  sessionAgentRefs.delete(sessionId);
  sessionBaseRef.delete(sessionId);
  sessionAgentTaskContext.delete(sessionId);
}

function tryAutoMergeConflicts(
  sessionId: string,
  workspacePath: string,
  conflicts: { filePath: string; agents: string[]; ranges: { start: number; end: number }[] }[],
): void {
  const agentRefs = sessionAgentRefs.get(sessionId);
  const baseRef = sessionBaseRef.get(sessionId);
  if (!agentRefs || agentRefs.size < 2 || !baseRef) return;

  const refMap = new Map<string, string>();
  for (const [agent, ref] of agentRefs) { refMap.set(agent, ref); }

  const conflictsInput = conflicts.map((c) => ({
    filePath: c.filePath,
    agents: c.agents,
    ranges: c.ranges,
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

  const priorDiffs = sessionAgentDiffs.get(sessionId) ?? [];
  const currentDiffs: AgentFileDiff[] = files.map((file) => ({
    agentName,
    filePath: file.path,
    diff: file.diff,
  }));
  const allDiffs = [...priorDiffs, ...currentDiffs].slice(-200);
  sessionAgentDiffs.set(sessionId, allDiffs);

  // Auto-merge detected conflicts silently (no chat broadcast)
  const conflicts = WorkspaceManager.detectConflicts(allDiffs);
  if (conflicts.length > 0) {
    tryAutoMergeConflicts(sessionId, workspacePath, conflicts);
  }
}
