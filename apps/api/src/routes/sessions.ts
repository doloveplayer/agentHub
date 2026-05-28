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

  return c.json(result.map((s) => {
    const lastMessage = s.messages[0]
      ? {
          ...s.messages[0],
          content: s.messages[0].content.length > 80
            ? `${s.messages[0].content.slice(0, 77)}...`
            : s.messages[0].content,
        }
      : null;

    return {
      id: s.id,
      title: s.title,
      type: s.type,
      permissionMode: s.permissionMode,
      userId: s.userId,
      sandboxContainerId: s.sandboxContainerId,
      agents: s.agents.map((sa) => ({
        agentId: sa.agent.id,
        name: sa.agent.name,
        displayName: sa.agent.displayName,
      })),
      lastMessage,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }));
});

const customAgentSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Agent name must be lowercase alphanumeric with hyphens'),
  displayName: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1).max(8000),
});

const createSchema = z.object({
  type: z.enum(['solo', 'group']).optional().default('solo'),
  agentIds: z.array(z.string().uuid()).optional(),
  title: z.string().optional(),
  customAgent: customAgentSchema.optional(),
});

// POST / — create a new session
sessions.post('/', async (c) => {
  const { userId } = c.get('user');

  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  let { type, agentIds, title, customAgent } = parsed.data;

  // Create custom agent if provided
  if (customAgent && !agentIds?.length) {
    const agent = await prisma.agent.create({
      data: {
        name: customAgent.name,
        displayName: customAgent.displayName,
        description: customAgent.description,
        systemPrompt: customAgent.systemPrompt,
        isActive: true,
      },
    });
    agentIds = [agent.id];
  }

  // Auto-assign agents:
  // - Group without explicit agentIds → assign ALL active agents
  // - Solo without explicit agentIds → assign default CodeAgent
  if ((!agentIds || agentIds.length === 0)) {
    if (type === 'group') {
      const allAgents = await prisma.agent.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      agentIds = allAgents.map((a) => a.id);
    } else {
      // Solo: assign the default code-agent for 1-on-1 chat
      const defaultAgent = await prisma.agent.findFirst({
        where: { name: 'code-agent', isActive: true },
        select: { id: true },
      });
      if (defaultAgent) agentIds = [defaultAgent.id];
    }
  }

  if (agentIds && agentIds.length > 0) {
    const activeAgents = await prisma.agent.findMany({
      where: { id: { in: agentIds }, isActive: true },
      select: { id: true },
    });
    const activeAgentIds = new Set(activeAgents.map((agent) => agent.id));
    const invalidAgentIds = agentIds.filter((agentId) => !activeAgentIds.has(agentId));
    if (invalidAgentIds.length > 0) {
      return c.json({ error: 'One or more agents are not available', invalidAgentIds }, 400);
    }
  }

  const session = await prisma.session.create({
    data: {
      title: title || (type === 'group' ? 'Group Session' : 'New Session'),
      type,
      userId,
      agents: agentIds && agentIds.length > 0
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

const updateSchema = z.object({
  title: z.string().optional(),
  permissionMode: z.enum(['read_only', 'ask', 'smart', 'trust']).optional(),
  pinned: z.boolean().optional(),
});

// PATCH /:id — update session fields (title, permissionMode, etc.)
sessions.patch('/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: parsed.data,
  });

  return c.json({
    id: updated.id,
    title: updated.title,
    type: updated.type,
    permissionMode: updated.permissionMode,
    userId: updated.userId,
    sandboxContainerId: updated.sandboxContainerId,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
});

export default sessions;
