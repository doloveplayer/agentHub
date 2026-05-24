import { WorkspaceManager, type AgentFileDiff, type WorkspaceVersion } from '../agent/WorkspaceManager.js';
import { broadcast } from './state.js';

const beforeVersions = new Map<string, WorkspaceVersion | null>();
const sessionAgentDiffs = new Map<string, AgentFileDiff[]>();

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
