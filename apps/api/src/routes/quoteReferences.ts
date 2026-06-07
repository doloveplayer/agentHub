import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';

const quoteReferences = new Hono();
quoteReferences.use('*', authMiddleware);

// GET /api/quote-references?messageId=xxx — 获取某消息的引用记录（作为 source 或 target）
quoteReferences.get('/', async (c) => {
  const messageId = c.req.query('messageId');
  if (!messageId) return c.json({ error: 'messageId required' }, 400);

  const [asSource, asTarget] = await Promise.all([
    prisma.quoteReference.findMany({
      where: { sourceMessageId: messageId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.quoteReference.findMany({
      where: { targetMessageId: messageId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return c.json({ quotedFrom: asSource, quotedBy: asTarget });
});

// POST /api/quote-references — 创建引用记录
quoteReferences.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json();
  const { sourceMessageId, selectionText, sourceType, contextMeta, sessionId } = body;

  if (!sourceMessageId || !selectionText || !sessionId) {
    return c.json({ error: 'sourceMessageId, selectionText, sessionId required' }, 400);
  }

  // Session ownership check
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const ref = await prisma.quoteReference.create({
    data: {
      sourceMessageId,
      selectionText: selectionText.slice(0, 2000),
      sourceType: sourceType || 'message',
      contextMeta: contextMeta || undefined,
      sessionId,
    },
  });

  return c.json(ref);
});

// PATCH /api/quote-references/:id — 回填 targetMessageId（Agent 处理完成后）
quoteReferences.patch('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const { targetMessageId, agentId } = body;

  // Ownership check via session
  const existing = await prisma.quoteReference.findUnique({
    where: { id },
    select: { sessionId: true },
  });
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const session = await prisma.session.findUnique({
    where: { id: existing.sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const ref = await prisma.quoteReference.update({
    where: { id },
    data: {
      ...(targetMessageId && { targetMessageId }),
      ...(agentId && { agentId }),
    },
  });

  return c.json(ref);
});

export default quoteReferences;
