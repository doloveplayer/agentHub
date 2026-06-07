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

export { planRecovery };
