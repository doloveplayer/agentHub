import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';

const chat = new Hono();
chat.use('*', authMiddleware);

const mentionSchema = z.object({
  agentId: z.string().uuid(),
  agentName: z.string(),
  subPrompt: z.string().min(1),
});

const sendSchema = z.object({
  sessionId: z.string().uuid(),
  content: z.string().min(1),
  mentions: z.array(mentionSchema).optional(),
});

// POST /send — send a message in a session
chat.post('/send', async (c) => {
  const { userId } = c.get('user');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  const { sessionId, content, mentions } = parsed.data;

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  // Reject mentions on solo sessions
  if (session.type === 'solo' && mentions && mentions.length > 0) {
    return c.json({ error: 'Mentions are not supported in solo sessions' }, 400);
  }

  // Create user message
  const userMessage = await prisma.message.create({
    data: { sessionId, senderType: 'human', content, status: 'done' },
  });

  // Create agent placeholder messages — one per mention, or one generic if no mentions
  const targetMentions = (mentions && mentions.length > 0)
    ? mentions
    : [{ agentId: '', agentName: '', subPrompt: content }];

  const agentMessages: { agentMessageId: string; agentId: string }[] = [];
  for (const m of targetMentions) {
    const agentMsg = await prisma.message.create({
      data: {
        sessionId,
        senderType: 'agent',
        agentId: m.agentId || null,
        content: '',
        status: 'streaming',
      },
    });
    agentMessages.push({ agentMessageId: agentMsg.id, agentId: m.agentId });
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  });

  return c.json({ userMessageId: userMessage.id, agentMessages }, 201);
});

export default chat;
