import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '../db/prisma.js';
import { getSessionContextBus, ContextBus } from './ContextBus.js';
import { config } from '../config.js';
import type { PlanCheckpoint, AgentSessionState } from '@agenthub/shared';

const SANDBOXES_ROOT = config.sandbox.root;

export class CheckpointManager {
  /** Create or update a checkpoint for a plan. */
  static save(
    sessionId: string,
    planId: string,
    pendingTasks: PlanCheckpoint['pendingTasks'],
    completedTasks: string[],
    failedTasks: PlanCheckpoint['failedTasks'],
    agentSessions: Record<string, AgentSessionState>,
    workspaceGitCommit?: string,
  ): void {
    const bus = getSessionContextBus(sessionId);

    const checkpoint: PlanCheckpoint = {
      planId,
      sessionId,
      workspaceGitCommit,
      contextBusState: bus.serialize(),
      agentSessions,
      pendingTasks,
      completedTasks,
      failedTasks,
      timestamp: Date.now(),
    };

    // Write to filesystem
    const checkpointDir = resolve(SANDBOXES_ROOT, sessionId, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const filePath = resolve(checkpointDir, `${planId}.json`);
    writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');

    // Also persist to DB (fire-and-forget — filesystem is the authoritative source)
    void prisma.sessionCheckpoint.upsert({
      where: { sessionId_planId: { sessionId, planId } },
      update: { data: checkpoint as any },
      create: {
        id: `${sessionId}:${planId}`,
        sessionId, planId,
        data: checkpoint as any,
      },
    }).catch((err: Error) => console.error(`[CheckpointManager] DB save failed: ${err.message}`));
  }

  /** Read a checkpoint from filesystem. Returns null if not found. */
  static read(sessionId: string, planId: string): PlanCheckpoint | null {
    const filePath = resolve(SANDBOXES_ROOT, sessionId, 'checkpoints', `${planId}.json`);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as PlanCheckpoint;
      } catch { /* fallback to null */ }
    }
    return null;
  }

  /** Read checkpoint from DB (for cross-session recovery). */
  static async readFromDB(sessionId: string, planId: string): Promise<PlanCheckpoint | null> {
    try {
      const record = await prisma.sessionCheckpoint.findUnique({
        where: { sessionId_planId: { sessionId, planId } },
      });
      if (record) return record.data as unknown as PlanCheckpoint;
    } catch { /* ignore */ }
    return null;
  }

  /** Restore ContextBus from a checkpoint. */
  static restoreContextBus(sessionId: string, checkpoint: PlanCheckpoint): ContextBus {
    const currentBus = getSessionContextBus(sessionId);
    const restoredBus = ContextBus.deserialize(checkpoint.contextBusState);
    currentBus.clear();
    for (const entry of restoredBus.query()) {
      currentBus.set({
        key: entry.key, value: entry.value, type: entry.type,
        author: entry.author, taskId: entry.taskId, planId: entry.planId,
        tags: entry.tags, status: entry.status,
      });
    }
    // Restored entries are not "new" — they come from a prior checkpoint
    currentBus.clearNewKeys();
    return currentBus;
  }

  /** Clean up checkpoint files for a completed plan. */
  static cleanup(sessionId: string, planId: string): void {
    const filePath = resolve(SANDBOXES_ROOT, sessionId, 'checkpoints', `${planId}.json`);
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  }

  /** Update agent session ID in the checkpoint (called when SDK emits sessionId). */
  static updateAgentSession(
    sessionId: string,
    planId: string,
    agentName: string,
    claudeSessionId: string,
  ): void {
    const checkpoint = CheckpointManager.read(sessionId, planId);
    if (!checkpoint) return;
    checkpoint.agentSessions[agentName] = {
      claudeSessionId,
      lastTaskId: checkpoint.agentSessions[agentName]?.lastTaskId || '',
      status: 'running',
    };
    CheckpointManager.save(
      sessionId, planId,
      checkpoint.pendingTasks, checkpoint.completedTasks,
      checkpoint.failedTasks, checkpoint.agentSessions,
      checkpoint.workspaceGitCommit,
    );
  }

  /** Get all incomplete checkpoints for a session (for recovery on reconnect). */
  static async getIncompleteForSession(sessionId: string): Promise<PlanCheckpoint[]> {
    try {
      const records = await prisma.sessionCheckpoint.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      });
      return records
        .map(r => r.data as unknown as PlanCheckpoint)
        .filter(c => c.pendingTasks.length > 0 || c.failedTasks.length > 0);
    } catch {
      return [];
    }
  }
}
