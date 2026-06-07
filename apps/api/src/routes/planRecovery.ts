import { Hono } from 'hono';
import { prisma } from '../db/prisma.js';
import { DagPersistence } from '../agent/DagPersistence.js';

const planRecovery = new Hono();

// GET /api/plans/:sessionId/recover
// Returns all non-terminal plans (executing, pending_confirmation) for a session.
// Marks stale 'running' tasks as 'failed' since agent processes can't survive WS disconnect.
planRecovery.get('/:sessionId/recover', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const plans = await DagPersistence.recover(sessionId);

  // Mark stale 'running' tasks as 'failed' — they can't resume after disconnect
  for (const plan of plans) {
    let needsUpdate = false;
    for (const task of plan.tasks) {
      if (task.status === 'running') {
        task.status = 'failed';
        needsUpdate = true;
      }
    }
    if (needsUpdate) {
      await DagPersistence.save(plan);
    }
  }

  return c.json({ plans });
});

// POST /api/plans/:sessionId/:planId/archive
// Marks a plan as archived so it no longer appears in recovery or history
planRecovery.post('/:sessionId/:planId/archive', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const planId = c.req.param('planId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await DagPersistence.markArchived(sessionId, planId);
  return c.json({ success: true });
});

// GET /api/plans/:sessionId/history
// Returns all non-archived plans (including completed/failed) for history view
planRecovery.get('/:sessionId/history', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const records = await prisma.planExecution.findMany({
    where: { sessionId, status: { not: 'archived' } },
    orderBy: { updatedAt: 'desc' },
  });

  const plans = records.map((r) => ({
    planId: r.planId,
    sessionId: r.sessionId,
    planTitle: r.planTitle,
    status: r.status,
    tasks: r.tasks as unknown as any[],
    updatedAt: r.updatedAt.toISOString(),
  }));

  return c.json({ plans });
});

export { planRecovery };
