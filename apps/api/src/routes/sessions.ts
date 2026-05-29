import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { SandboxManager } from '../agent/SandboxManager.js';
import { broadcast, sandboxes, realWorkspacePaths, workspaceModes } from '../ws/state.js';
import { InboxManager } from '../agent/InboxManager.js';
import { buildGroupContext } from '../agent/groupContext.js';
import { config } from '../config.js';
import * as path from 'path';
import * as fs from 'fs';

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

  // Validate explicit agentIds BEFORE session creation (auto-assigned agents
  // are created below and don't need this check)
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

  // Create session FIRST without agents so we have session.id for
  // template-based system agent naming in the auto-assign block below.
  const session = await prisma.session.create({
    data: {
      title: title || (type === 'group' ? 'Group Session' : 'New Session'),
      type,
      userId,
    },
  });

  // Auto-assign agents using new lifecycle:
  // - Group without explicit agentIds → create system agents from AgentTemplate
  // - Solo without explicit agentIds → reuse user's default code-agent or create from template
  if ((!agentIds || agentIds.length === 0)) {
    if (type === 'group') {
      const templates = await prisma.agentTemplate.findMany();
      agentIds = [];
      for (const tpl of templates) {
        const systemAgent = await prisma.agent.create({
          data: {
            name: `${tpl.name}-${session.id.slice(0, 8)}`,
            displayName: tpl.displayName,
            description: tpl.description,
            systemPrompt: tpl.systemPrompt,
            provider: tpl.provider,
            type: 'system',
            contextMode: 'isolated',
          },
        });
        agentIds.push(systemAgent.id);
      }
    } else {
      // Solo: reuse existing user code-agent or create from template
      let defaultAgent = await prisma.agent.findFirst({
        where: { name: 'code-agent', type: 'user', createdBy: userId, isActive: true },
      });
      if (!defaultAgent) {
        const codeTpl = await prisma.agentTemplate.findUnique({ where: { name: 'code-agent' } });
        if (codeTpl) {
          defaultAgent = await prisma.agent.create({
            data: {
              name: 'code-agent',
              displayName: codeTpl.displayName,
              description: codeTpl.description,
              systemPrompt: codeTpl.systemPrompt,
              type: 'user',
              contextMode: 'shared',
              createdBy: userId,
            },
          });
        }
      }
      agentIds = defaultAgent ? [defaultAgent.id] : [];
    }
  }

  // Create SessionAgent associations
  if (agentIds && agentIds.length > 0) {
    await prisma.sessionAgent.createMany({
      data: agentIds.map((agentId) => ({ sessionId: session.id, agentId })),
    });
  }

  // Fetch the complete session with agents for the response
  const fullSession = await prisma.session.findUnique({
    where: { id: session.id },
    include: {
      agents: { include: { agent: { select: { id: true, name: true, displayName: true } } } },
    },
  });

  if (!fullSession) return c.json({ error: 'Session creation failed' }, 500);

  return c.json({
    ...fullSession,
    type: fullSession.type,
    agents: fullSession.agents.map((sa) => ({
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

  // Broadcast session_renamed event and inject group context if title changed
  if (parsed.data.title && parsed.data.title !== session.title) {
    broadcast(sessionId, {
      type: 'session_renamed',
      sessionId,
      oldTitle: session.title,
      newTitle: parsed.data.title,
      timestamp: Date.now(),
    });

    // Inject updated group context into all agents' inbox
    const sb = sandboxes.get(sessionId);
    if (sb) {
      const sessionAgents = await prisma.sessionAgent.findMany({
        where: { sessionId },
        include: { agent: { select: { name: true } } },
      });
      const groupCtx = await buildGroupContext(sessionId, parsed.data.title);
      if (groupCtx) {
        for (const sa of sessionAgents) {
          InboxManager.write(sb.hostWorkDir, sa.agent.name, {
            type: 'context_update',
            id: `rename-${Date.now()}-${sa.agent.name}`,
            from: 'system',
            to: sa.agent.name,
            summary: `Session renamed to "${parsed.data.title}". Updated group context:\n\n${groupCtx}`,
            risk: 'low',
            timestamp: Date.now(),
          });
        }
      }
    }
  }

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

// POST /:id/workspace — set real workspace path
sessions.post('/:id/workspace', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  let body: { path: string; mode?: 'read_only_default' | 'full_access' };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  if (!body.path) return c.json({ error: 'path is required' }, 400);

  // Resolve and validate path (prevent traversal)
  const resolved = path.resolve(body.path);
  let real: string;
  try { real = fs.realpathSync(resolved); } catch {
    return c.json({ error: 'Path does not exist' }, 400);
  }
  if (!fs.statSync(real).isDirectory()) return c.json({ error: 'Not a directory' }, 400);

  // Allowlist check against RESOLVED path
  const roots = config.realWorkspaceRoots.split(':');
  const allowed = roots.some((root) => real.startsWith(path.resolve(root)));
  if (!allowed) return c.json({ error: `Path not allowed. Must be under: ${roots.join(', ')}` }, 403);

  realWorkspacePaths.set(sessionId, real);
  workspaceModes.set(sessionId, body.mode || 'read_only_default');

  broadcast(sessionId, {
    type: 'workspace_changed',
    sessionId,
    path: real,
    mode: body.mode || 'read_only_default',
    timestamp: Date.now(),
  });

  return c.json({ success: true, path: real, mode: body.mode || 'read_only_default' });
});

// GET /:id/workspace — get current workspace config
sessions.get('/:id/workspace', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  return c.json({
    path: realWorkspacePaths.get(sessionId) || null,
    mode: workspaceModes.get(sessionId) || 'read_only_default',
  });
});

// PATCH /:id/agents/:agentId — update session-level agent config
// (POST and DELETE for /:id/agents moved to routes/sessionAgents.ts)
sessions.patch('/:id/agents/:agentId', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');
  const agentId = c.req.param('agentId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  let body: { systemPromptOverride?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  try {
    const updated = await prisma.sessionAgent.update({
      where: { sessionId_agentId: { sessionId, agentId } },
      data: { systemPromptOverride: body.systemPromptOverride ?? null },
    });

    return c.json({
      sessionId: updated.sessionId,
      agentId: updated.agentId,
      systemPromptOverride: updated.systemPromptOverride,
    });
  } catch (err: any) {
    if (err.code === 'P2025') return c.json({ error: 'Agent not in session' }, 404);
    throw err;
  }
});

// GET /:id/agents/:agentId — get session-level agent config
sessions.get('/:id/agents/:agentId', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');
  const agentId = c.req.param('agentId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const sessionAgent = await prisma.sessionAgent.findUnique({
    where: { sessionId_agentId: { sessionId, agentId } },
    include: { agent: { select: { systemPrompt: true } } },
  });

  if (!sessionAgent) return c.json({ error: 'Agent not in session' }, 404);

  return c.json({
    sessionId,
    agentId,
    systemPromptOverride: sessionAgent.systemPromptOverride,
    globalSystemPrompt: sessionAgent.agent.systemPrompt,
  });
});

export default sessions;
