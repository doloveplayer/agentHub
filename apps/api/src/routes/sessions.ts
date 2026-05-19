import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { SandboxManager } from '../agent/SandboxManager.js';

const sessions = new Hono();
sessions.use('*', authMiddleware);

// GET / — list sessions for current user
sessions.get('/', async (c) => {
  const { userId } = c.get('user');

  const result = await prisma.session.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, content: true, senderType: true, createdAt: true },
      },
      agents: {
        include: { agent: { select: { id: true, name: true, displayName: true } } },
      },
    },
  });

  return c.json(result.map((s) => ({
    id: s.id,
    title: s.title,
    type: s.type,
    userId: s.userId,
    sandboxContainerId: s.sandboxContainerId,
    agents: s.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
    lastMessage: s.messages[0] ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  })));
});

const createSchema = z.object({
  type: z.enum(['solo', 'group']).optional().default('solo'),
  agentIds: z.array(z.string().uuid()).optional(),
  title: z.string().optional(),
});

// POST / — create a new session
sessions.post('/', async (c) => {
  const { userId } = c.get('user');

  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  let { type, agentIds, title } = parsed.data;

  // Auto-assign all active agents if creating a group session without explicit agentIds
  if (type === 'group' && (!agentIds || agentIds.length === 0)) {
    const allAgents = await prisma.agent.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    agentIds = allAgents.map((a) => a.id);
  }

  const session = await prisma.session.create({
    data: {
      title: title || (type === 'group' ? 'Group Session' : 'New Session'),
      type,
      userId,
      agents: type === 'group' && agentIds
        ? { create: agentIds.map((agentId) => ({ agentId })) }
        : undefined,
    },
    include: {
      agents: { include: { agent: { select: { id: true, name: true, displayName: true } } } },
    },
  });

  return c.json({
    ...session,
    type: session.type,
    agents: session.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
  }, 201);
});

// GET /:id — get session with all messages
sessions.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      agents: { include: { agent: { select: { id: true, name: true, displayName: true } } } },
    },
  });

  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  return c.json({
    ...session,
    type: session.type,
    agents: session.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
  });
});

// DELETE /:id — delete session
sessions.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  if (session.sandboxContainerId) {
    SandboxManager.destroy(session.sandboxContainerId).catch((err) =>
      console.error(`[api] Failed to destroy sandbox for session ${sessionId}: ${err.message}`),
    );
    SandboxManager.destroyHostDir(sessionId);
  }

  await prisma.session.delete({ where: { id: sessionId } });
  return c.body(null, 204);
});

export default sessions;
