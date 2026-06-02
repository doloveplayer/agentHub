import { WorkspaceManager, type AgentFileDiff, type WorkspaceVersion, type MergeResult } from '../agent/WorkspaceManager.js';
import { broadcast } from './state.js';

function classifyFile(path: string): 'expected' | 'system' | 'review' {
  if (path.startsWith('.agenthub/') || path.startsWith('.git/') || path === '.gitignore')
    return 'system';
  if (path.startsWith('.'))
    return 'review';
  return 'expected';
}

const beforeVersions = new Map<string, WorkspaceVersion | null>();
const sessionAgentDiffs = new Map<string, AgentFileDiff[]>();
const sessionAgentRefs = new Map<string, Map<string, string>>();   // sessionId -> (agentName -> afterVersion ref)
const sessionBaseRef = new Map<string, string>();                   // sessionId -> common base ref (first agent's beforeVersion)

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
    broadcast(sessionId, {
      type: 'conflict_unresolved',
      files: unresolved.map((r) => ({ filePath: r.filePath, agents: r.agents })),
    });
    console.log(`[ws] Auto-merge unresolved (needs manual): session=${sessionId} files=${unresolved.map((r) => r.filePath).join(', ')}`);
  }
}

export function broadcastDiffSummary(
  sessionId: string,
  agentMessageId: string,
  workspacePath: string,
  beforeVersion: WorkspaceVersion | null,
  agentName: string,
  summary?: string,
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

  const files = WorkspaceManager.getWorkspaceDiff(workspacePath, beforeVersion.id)
    .filter((file) => file.diff.trim().length > 0)
    .map((file) => ({ ...file, baseVersionId: beforeVersion.id }));
  if (files.length === 0) return;

  const priorDiffs = sessionAgentDiffs.get(sessionId) ?? [];
  const currentDiffs: AgentFileDiff[] = files.map((file) => ({
    agentName,
    filePath: file.path,
    diff: file.diff,
  }));
  const allDiffs = [...priorDiffs, ...currentDiffs].slice(-200);
  sessionAgentDiffs.set(sessionId, allDiffs);

  const conflicts = WorkspaceManager.detectConflicts(allDiffs);
  const conflictByFile = new Map(conflicts.map((conflict) => [conflict.filePath, conflict]));
  const filesWithConflicts = files.map((file) => ({
    ...file,
    conflict: conflictByFile.get(file.path),
    classification: classifyFile(file.path),
  }));

  if (conflicts.length > 0) {
    broadcast(sessionId, {
      type: 'conflict_detected',
      conflicts: conflicts.map((conflict) => ({
        filePath: conflict.filePath,
        agents: conflict.agents,
        ranges: conflict.ranges,
      })),
    });

    // Attempt auto-merge for detected conflicts
    tryAutoMergeConflicts(sessionId, workspacePath, conflicts);
  }

  broadcast(sessionId, {
    type: 'diff_summary',
    id: `diff-${Date.now()}`,
    title: `${agentName} changed ${files.length} file${files.length === 1 ? '' : 's'}`,
    agentMessageId,
    beforeVersionId: beforeVersion.id,
    afterVersionId: afterVersion.id,
    files: filesWithConflicts,
    createdAt: Date.now(),
  });
}
