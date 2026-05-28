import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { encryptApiKey, decryptApiKey, maskApiKey } from '../lib/crypto.js';

const agents = new Hono();
agents.use('*', authMiddleware);

// GET / — list all active agents
agents.get('/', async (c) => {
  const list = await prisma.agent.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, displayName: true, description: true,
      systemPrompt: true, provider: true, providerConfig: true, capabilities: true,
    },
  });
  return c.json(list);
});

const createSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  provider: z.enum(['claude-code', 'codex']).default('claude-code'),
  providerConfig: z.record(z.unknown()).optional(),
});

// POST / — create custom agent
agents.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  try {
    const agent = await prisma.agent.create({
      data: {
        ...parsed.data,
        providerConfig: parsed.data.providerConfig as any,
      },
    });
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
  provider: z.enum(['claude-code', 'codex']).optional(),
  providerConfig: z.record(z.unknown()).optional(),
  capabilities: z.record(z.unknown()).optional(),
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
    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...parsed.data,
        providerConfig: parsed.data.providerConfig as any,
        capabilities: parsed.data.capabilities as any,
      },
    });
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

// PUT /provider-configs — store encrypted API keys
agents.put('/provider-configs', async (c) => {
  const { userId } = c.get('user');
  let body: Record<string, { apiKey?: string; endpoint?: string }>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  // Read existing config first to merge (avoid deleting other provider configs)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedApiKeys: true },
  });
  const existing: Record<string, { apiKey?: string; endpoint?: string }> =
    user?.encryptedApiKeys ? JSON.parse(user.encryptedApiKeys) : {};

  // Merge new configs on top of existing
  for (const [provider, config] of Object.entries(body)) {
    existing[provider] = { ...existing[provider], ...config };
  }

  // Encrypt apiKeys before storing
  const encrypted: Record<string, { apiKey?: string; endpoint?: string }> = {};
  for (const [provider, config] of Object.entries(existing)) {
    encrypted[provider] = { endpoint: config.endpoint };
    if (config.apiKey) {
      // Check if the value is already an encrypted blob (from existing) or new plaintext
      if (config.apiKey.includes(':')) {
        // Already encrypted — keep as-is
        encrypted[provider].apiKey = config.apiKey;
      } else {
        encrypted[provider].apiKey = encryptApiKey(config.apiKey);
      }
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: { encryptedApiKeys: JSON.stringify(encrypted) },
  });
  return c.json({ success: true });
});

// GET /provider-configs — return masked keys
agents.get('/provider-configs', async (c) => {
  const { userId } = c.get('user');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedApiKeys: true },
  });
  if (!user?.encryptedApiKeys) return c.json({});

  // Return masked keys — never expose full key to frontend
  const raw = JSON.parse(user.encryptedApiKeys);
  const masked: Record<string, { apiKey?: string; endpoint?: string }> = {};
  for (const [provider, config] of Object.entries(raw)) {
    masked[provider] = {
      endpoint: (config as any).endpoint,
      apiKey: (config as any).apiKey ? maskApiKey(decryptApiKey((config as any).apiKey)) : undefined,
    };
  }
  return c.json(masked);
});

// POST /from-md — create agent from markdown file
agents.post('/from-md', async (c) => {
  const { userId } = c.get('user');
  let body: { content: string; providerConfig?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  // Parse frontmatter
  const fmMatch = body.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return c.json({ error: 'No frontmatter found. Expected: ---\\nkey: value\\n---\\n...' }, 400);

  const frontmatterText = fmMatch[1];
  const systemPrompt = fmMatch[2].trim();

  // Parse YAML-like frontmatter
  const meta: Record<string, string> = {};
  for (const line of frontmatterText.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  const name = meta.name || `custom-${Date.now()}`;
  const provider = (meta.provider as 'claude-code' | 'codex') || 'claude-code';

  if (!/^[a-z0-9-]+$/.test(name)) {
    return c.json({ error: 'name must be kebab-case' }, 400);
  }

  // Codex requires API key — check User.encryptedApiKeys
  if (provider === 'codex') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { encryptedApiKeys: true } });
    const keys = user?.encryptedApiKeys ? JSON.parse(user.encryptedApiKeys) : {};
    if (!keys.codex) {
      return c.json({ error: 'Codex provider requires an API key. Configure it in Provider Settings first.' }, 400);
    }
  }

  // providerConfig: user-provided or platform defaults
  const providerConfig = body.providerConfig || getDefaultProviderConfig(provider);

  const agent = await prisma.agent.create({
    data: {
      name,
      displayName: meta.displayName || name,
      description: meta.description || `Custom agent: ${name}`,
      systemPrompt,
      provider,
      providerConfig: providerConfig as any,
    },
  });
  return c.json(agent, 201);
});

function getDefaultProviderConfig(provider: string): Record<string, unknown> {
  if (provider === 'claude-code') return { model: 'claude-sonnet-4-6' };
  if (provider === 'codex') return { model: 'gpt-5' };
  return {};
}

export default agents;