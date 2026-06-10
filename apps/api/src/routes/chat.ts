import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { selectDefaultAgent } from '../agent/turns.js';
import { TurnManager } from '../agent/TurnManager.js';

const chat = new Hono();
chat.use('*', authMiddleware);

const mentionSchema = z.object({
  agentId: z.string().uuid(),
  agentName: z.string(),
  subPrompt: z.string().min(1),
});

const sendSchema = z.object({
  sessionId: z.string().uuid(),
  content: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'content must not be blank',
  }),
  mentions: z.array(mentionSchema).optional(),
  parentTurnId: z.string().uuid().optional().nullable(),
});

// POST /send — send a message in a session
chat.post('/send', async (c) => {
  const { userId } = c.get('user');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  const { sessionId, content, mentions, parentTurnId } = {
    parentTurnId: undefined as string | null | undefined,
    ...parsed.data,
  };

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      type: true,
      userId: true,
      workspacePath: true,
      agents: {
        include: {
          agent: {
            select: { id: true, name: true, displayName: true, description: true, systemPrompt: true },
          },
        },
      },
    },
  });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  // Reject mentions on solo sessions
  if (session.type === 'solo' && mentions && mentions.length > 0) {
    return c.json({ error: 'Mentions are not supported in solo sessions' }, 400);
  }

  // --- Turn auto-creation ---
  // Create user message first so Turn can reference it
  const workspacePath = session.workspacePath || null;

  const userMessage = await prisma.message.create({
    data: { sessionId, senderType: 'human', content, status: 'done' },
  });

  const turn = await TurnManager.createTurn({
    sessionId,
    userMessageId: userMessage.id,
    workspacePath,
    parentTurnId: parentTurnId ?? undefined,
  });

  // Touch session updatedAt so it reflects recent activity for sorting
  prisma.session.update({ where: { id: sessionId }, data: { updatedAt: new Date() } }).catch(() => {});

  // Create agent placeholder messages — one per mention, or one generic if no mentions
  const defaultAgent = selectDefaultAgent(
    session.type,
    session.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
    session.agents.map((sa) => sa.agent),
  );
  const targetMentions = (mentions && mentions.length > 0)
    ? mentions
    : [{ agentId: defaultAgent?.id || '', agentName: defaultAgent?.name || '', subPrompt: content }];

  const agentMessages: { agentMessageId: string; agentId: string }[] = [];
  for (const m of targetMentions) {
    const agentMsg = await prisma.message.create({
      data: {
        sessionId,
        senderType: 'agent',
        agentId: m.agentId || null,
        content: '',
        status: 'streaming',
        turnId: turn.id,
      },
    });
    agentMessages.push({ agentMessageId: agentMsg.id, agentId: m.agentId });
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  });

  return c.json({ userMessageId: userMessage.id, turnId: turn.id, agentMessages }, 201);
});

// DELETE /messages/:id — Turn-level delete: finds the Turn containing this message and deletes it
chat.delete('/messages/:id', async (c) => {
  const { userId } = c.get('user');
  const messageId = c.req.param('id');

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { session: { select: { userId: true } } },
  });
  if (!message) return c.json({ error: 'Message not found' }, 404);
  if (message.session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  // If message belongs to a Turn, delete the entire Turn
  if (message.turnId) {
    const result = await TurnManager.deleteTurn(message.turnId);
    return c.json({ ok: true, deletedTurn: true, ...result });
  }

  // Legacy: message without Turn association — direct hard delete
  await prisma.message.delete({ where: { id: messageId } });
  return c.json({ ok: true });
});

export default chat;
