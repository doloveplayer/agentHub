import { prisma } from '../db/prisma.js';
import type { DagTaskStatus } from '../ws/dagExecution.js';

export interface PersistedTask {
  id: string;
  title: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  expectedOutput: string;
  priority: string;
  agentName: string;
  agentId: string;
  status: DagTaskStatus;
  dependents: string[];
}

export interface PersistedPlan {
  planId: string;
  sessionId: string;
  planTitle: string;
  status: string;
  tasks: PersistedTask[];
}

export class DagPersistence {
  static async save(plan: PersistedPlan): Promise<void> {
    await prisma.planExecution.upsert({
      where: { id: `${plan.sessionId}:${plan.planId}` },
      update: {
        status: plan.status,
        tasks: plan.tasks as any,
      },
      create: {
        id: `${plan.sessionId}:${plan.planId}`,
        planId: plan.planId,
        sessionId: plan.sessionId,
        planTitle: plan.planTitle,
        status: plan.status,
        tasks: plan.tasks as any,
      },
    });
  }

  static async updateTaskStatus(
    sessionId: string,
    planId: string,
    taskId: string,
    status: DagTaskStatus,
  ): Promise<void> {
    const record = await prisma.planExecution.findUnique({
      where: { id: `${sessionId}:${planId}` },
    });
    if (!record) return;

    const tasks = (record.tasks as unknown as PersistedTask[]).map((t) =>
      t.id === taskId ? { ...t, status } : t
    );
    await prisma.planExecution.update({
      where: { id: `${sessionId}:${planId}` },
      data: { tasks: tasks as any },
    });
  }

  static async recover(sessionId: string): Promise<PersistedPlan[]> {
    const records = await prisma.planExecution.findMany({
      where: { sessionId, status: { in: ['executing', 'pending_confirmation'] } },
      orderBy: { createdAt: 'asc' },
    });

    return records.map((r) => ({
      planId: r.planId,
      sessionId: r.sessionId,
      planTitle: r.planTitle,
      status: r.status,
      tasks: r.tasks as unknown as PersistedTask[],
    }));
  }

  static async markCompleted(sessionId: string, planId: string): Promise<void> {
    await prisma.planExecution.updateMany({
      where: { sessionId, planId },
      data: { status: 'completed' },
    });
  }

  static async markFailed(sessionId: string, planId: string): Promise<void> {
    await prisma.planExecution.updateMany({
      where: { sessionId, planId },
      data: { status: 'failed' },
    });
  }

  static async cleanup(sessionId: string): Promise<void> {
    await prisma.planExecution.deleteMany({ where: { sessionId } });
  }
}
