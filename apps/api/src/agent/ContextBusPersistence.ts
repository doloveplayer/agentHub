import { prisma } from '../db/prisma.js';
import { ContextBus, getSessionContextBus } from './ContextBus.js';
import type { ContextEntry } from '@agenthub/shared';

export class ContextBusPersistence {
  /** Persist a single entry to DB. */
  static async saveEntry(sessionId: string, entry: ContextEntry): Promise<void> {
    await prisma.contextEntryRecord.upsert({
      where: { sessionId_key: { sessionId, key: entry.key } },
      update: {
        value: JSON.stringify(entry.value),
        type: entry.type,
        version: entry.version,
        author: entry.author,
        taskId: entry.taskId || null,
        planId: entry.planId || null,
        tags: entry.tags,
        status: entry.status,
      },
      create: {
        id: `${sessionId}:${entry.key}`,
        sessionId,
        key: entry.key,
        value: JSON.stringify(entry.value),
        type: entry.type,
        version: entry.version,
        author: entry.author,
        taskId: entry.taskId || null,
        planId: entry.planId || null,
        tags: entry.tags,
        status: entry.status,
      },
    }).catch((err: Error) => console.error(`[ContextBus] DB save failed: ${err.message}`));
  }

  /** Restore ContextBus from DB for a session. */
  static async restore(sessionId: string): Promise<ContextBus> {
    const bus = getSessionContextBus(sessionId);
    try {
      const records = await prisma.contextEntryRecord.findMany({
        where: { sessionId, status: 'active' },
        orderBy: { updatedAt: 'asc' },
      });
      for (const r of records) {
        let value: unknown = r.value;
        try { value = JSON.parse(r.value); } catch { /* keep as string */ }
        bus.set({
          key: r.key,
          value,
          type: r.type as ContextEntry['type'],
          author: r.author,
          taskId: r.taskId || undefined,
          planId: r.planId || undefined,
          tags: r.tags as string[],
          status: r.status as ContextEntry['status'],
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ContextBus] Restore failed: ${message}`);
    }
    return bus;
  }

  /** Delete all entries for a session. */
  static async cleanup(sessionId: string): Promise<void> {
    await prisma.contextEntryRecord.deleteMany({ where: { sessionId } }).catch(() => {});
  }
}

/** Save a checkpoint to DB */
export async function saveCheckpoint(
  sessionId: string,
  planId: string,
  data: unknown,
): Promise<void> {
  await prisma.sessionCheckpoint.upsert({
    where: { sessionId_planId: { sessionId, planId } },
    update: { data: data as any },
    create: {
      id: `${sessionId}:${planId}`,
      sessionId,
      planId,
      data: data as any,
    },
  }).catch((err: Error) => console.error(`[Checkpoint] DB save failed: ${err.message}`));
}

/** Read a checkpoint from DB */
export async function readCheckpoint(
  sessionId: string,
  planId: string,
): Promise<unknown | null> {
  try {
    const record = await prisma.sessionCheckpoint.findUnique({
      where: { sessionId_planId: { sessionId, planId } },
    });
    return record ? record.data : null;
  } catch {
    return null;
  }
}

/** Get all incomplete checkpoints for a session */
export async function getIncompleteCheckpoints(sessionId: string): Promise<unknown[]> {
  try {
    const records = await prisma.sessionCheckpoint.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(r => r.data);
  } catch {
    return [];
  }
}
