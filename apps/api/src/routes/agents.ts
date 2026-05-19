import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';

const agents = new Hono();
agents.use('*', authMiddleware);

// GET / — list all active agents
agents.get('/', async (c) => {
  const list = await prisma.agent.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, displayName: true, description: true, systemPrompt: true },
  });
  return c.json(list);
});

const createSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
});

// POST / — create custom agent
agents.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  try {
    const agent = await prisma.agent.create({ data: parsed.data });
    return c.json(agent, 201);
  } catch (err: any) {
    if (err.code === 'P2002') return c.json({ error: 'Agent name already exists' }, 409);
    throw err;
  }
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
  systemPrompt: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

// PUT /:id — update agent
agents.put('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  try {
    const agent = await prisma.agent.update({ where: { id }, data: parsed.data });
    return c.json(agent);
  } catch (err: any) {
    if (err.code === 'P2025') return c.json({ error: 'Agent not found' }, 404);
    throw err;
  }
});

// DELETE /:id — soft-delete
agents.delete('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await prisma.agent.update({ where: { id }, data: { isActive: false } });
    return c.body(null, 204);
  } catch (err: any) {
    if (err.code === 'P2025') return c.json({ error: 'Agent not found' }, 404);
    throw err;
  }
});

export default agents;