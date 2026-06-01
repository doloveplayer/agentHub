import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { CapabilityInventory } from '../agent/CapabilityInventory.js';

const sessionAgents = new Hono();
sessionAgents.use('*', authMiddleware);

// POST /:sessionId/agents — add agents to group
const addSchema = z.object({ agentIds: z.array(z.string().uuid()).min(1) });

sessionAgents.post('/:sessionId/agents', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  if (session.type !== 'group') return c.json({ error: 'Only group sessions support adding agents' }, 400);

  const parsed = addSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);

  const added: string[] = [];
  for (const agentId of parsed.data.agentIds) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) continue;
    if (agent.type !== 'user' || agent.createdBy !== userId) continue;

    await prisma.sessionAgent.upsert({
      where: { sessionId_agentId: { sessionId, agentId } },
      create: { sessionId, agentId },
      update: {},
    });
    added.push(agentId);
  }

  // Broadcast to all session clients
  const { broadcast } = await import('../ws/state.js');
  for (const id of added) {
    broadcast(sessionId, { type: 'agent_added', agentId: id, sessionId });
  }

  CapabilityInventory.regenerate(sessionId).catch((err) =>
    console.error(`[sessionAgents] Failed to regenerate cap-inventory:`, err.message)
  );

  return c.json({ added }, 201);
});

// DELETE /:sessionId/agents/:agentId — remove agent from group
sessionAgents.delete('/:sessionId/agents/:agentId', async (c) => {
  const { userId } = c.get('user');
  const { sessionId, agentId } = c.req.param();

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  await prisma.sessionAgent.deleteMany({ where: { sessionId, agentId } });

  const { broadcast } = await import('../ws/state.js');
  broadcast(sessionId, { type: 'agent_removed', agentId, sessionId });

  CapabilityInventory.regenerate(sessionId).catch((err) =>
    console.error(`[sessionAgents] Failed to regenerate cap-inventory:`, err.message)
  );

  return c.body(null, 204);
});

export default sessionAgents;
