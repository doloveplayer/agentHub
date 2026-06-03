import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { PinnedStore } from '../agent/PinnedStore.js';
import { broadcast } from '../ws/state.js';

const pinned = new Hono();
pinned.use('*', authMiddleware);

// GET /:sessionId/pinned — list all pinned items for a session
pinned.get('/:sessionId/pinned', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  // Verify session ownership via prisma (lightweight check)
  const { prisma } = await import('../db/prisma.js');
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const items = await PinnedStore.list(sessionId);
  return c.json(items);
});

const createSchema = z.object({
  sourceType: z.enum(['message', 'file', 'text']),
  content: z.string().min(1),
  sourceMessageId: z.string().optional(),
  filePath: z.string().optional(),
  title: z.string().optional(),
  injectToAgent: z.boolean().optional(),
});

// POST /:sessionId/pinned — pin a new item
pinned.post('/:sessionId/pinned', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const { prisma } = await import('../db/prisma.js');
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const item = await PinnedStore.add(sessionId, parsed.data.sourceType, parsed.data.content, {
    sourceMessageId: parsed.data.sourceMessageId,
    filePath: parsed.data.filePath,
    title: parsed.data.title,
    injectToAgent: parsed.data.injectToAgent,
  });
  broadcast(sessionId, { type: 'pinned_added', sessionId, pinned: item });
  return c.json(item, 201);
});

// DELETE /:sessionId/pinned/:id — unpin an item
pinned.delete('/:sessionId/pinned/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const id = c.req.param('id');

  const { prisma } = await import('../db/prisma.js');
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  await PinnedStore.remove(sessionId, id);
  broadcast(sessionId, { type: 'pinned_removed', sessionId, pinnedId: id });
  return c.json({ ok: true });
});

const updateSchema = z.object({
  injectToAgent: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  title: z.string().optional(),
});

// PATCH /:sessionId/pinned/reorder — reorder pinned items (registered before :id to avoid param capture)
const reorderSchema = z.object({
  ids: z.array(z.string()),
});

pinned.patch('/:sessionId/pinned/reorder', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const { prisma } = await import('../db/prisma.js');
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  await PinnedStore.reorder(sessionId, parsed.data.ids);
  return c.json({ ok: true });
});

// PATCH /:sessionId/pinned/:id — update a pinned item's properties
pinned.patch('/:sessionId/pinned/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const id = c.req.param('id');

  const { prisma } = await import('../db/prisma.js');
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const item = await PinnedStore.update(sessionId, id, parsed.data);
  if (!item) return c.json({ error: 'Not found' }, 404);
  broadcast(sessionId, { type: 'pinned_updated', sessionId, pinned: item });
  return c.json(item);
});

export default pinned;
