import { resolve } from 'path';
import { existsSync, cpSync, mkdirSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { encryptApiKey, decryptApiKey, maskApiKey } from '../lib/crypto.js';
import { agentRuntime } from '../agent/AgentRuntime.js';
import { presetSkills } from '../presetSkills.js';
import { config } from '../config.js';
import type { SkillDef } from '@agenthub/shared';

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
      type: true, createdBy: true, skills: true,
    },
  });
  return c.json(list);
});

const skillDefSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  description: z.string(),
  content: z.string(),
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
  systemPrompt: z.string().min(1).optional(),
  provider: z.enum(['claude-code', 'opencode']).optional(),
  providerConfig: z.record(z.unknown()).optional(),
  capabilities: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  skills: z.array(skillDefSchema).nullable().optional(),
});

const createSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Agent name must be lowercase alphanumeric with hyphens'),
  displayName: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1).max(8000),
  provider: z.enum(["claude-code", "opencode"]).optional(),
  skills: z.array(skillDefSchema).optional(),
});

// PUT /provider-configs — store encrypted API keys (MUST be before /:id routes to avoid route conflict)
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
  const provider = meta.provider || 'claude-code';

  if (!/^[a-z0-9-]+$/.test(name)) {
    return c.json({ error: 'name must be kebab-case' }, 400);
  }

  // Runtime validation: reject unsupported providers
  const VALID_PROVIDERS = ['claude-code', 'opencode'];
  if (!VALID_PROVIDERS.includes(provider)) {
    return c.json({ error: `Unknown provider: ${provider}. Supported: ${VALID_PROVIDERS.join(', ')}` }, 400);
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
      type: 'user',
      createdBy: userId,
    },
  });
  return c.json(agent, 201);
});

function getDefaultProviderConfig(provider: string): Record<string, unknown> {
  if (provider === 'claude-code') return { model: 'claude-sonnet-4-6' };
  if (provider === 'opencode') return { model: 'deepseek-chat' };
  return {};
}

// POST /skills/validate — validate an uploaded .md skill file
agents.post('/skills/validate', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return c.json({ valid: false, errors: [{ field: 'file', message: 'No file uploaded' }] }, 400);
    }

    if (!file.name.endsWith('.md')) {
      return c.json({ valid: false, errors: [{ field: 'file', message: 'Only .md files are allowed' }] }, 400);
    }

    if (file.size > 100 * 1024) {
      return c.json({ valid: false, errors: [{ field: 'file', message: 'File size exceeds 100KB limit' }] }, 400);
    }

    const text = await file.text();
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      return c.json({ valid: false, errors: [{ field: 'file', message: 'Missing or invalid frontmatter. Expected: ---\\nkey: value\\n---\\n...' }] });
    }

    const frontmatterText = fmMatch[1];
    const content = fmMatch[2].trim();

    // Parse YAML-like frontmatter
    const meta: Record<string, string> = {};
    for (const line of frontmatterText.split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }

    const errors: Array<{ field: string; message: string }> = [];

    if (!meta.name || meta.name.length === 0) {
      errors.push({ field: 'name', message: 'name is required in frontmatter' });
    } else if (!/^[a-z0-9-]+$/.test(meta.name)) {
      errors.push({ field: 'name', message: 'name must be kebab-case (lowercase letters, digits, hyphens)' });
    }

    if (!meta.description || meta.description.length === 0) {
      errors.push({ field: 'description', message: 'description is required in frontmatter' });
    }

    if (content.length === 0) {
      errors.push({ field: 'content', message: 'Skill content (after frontmatter) cannot be empty' });
    }

    if (errors.length > 0) {
      return c.json({ valid: false, errors });
    }

    return c.json({
      valid: true,
      skill: { name: meta.name, description: meta.description, content },
    });
  } catch (err: any) {
    return c.json({ valid: false, errors: [{ field: 'file', message: err.message || 'Failed to parse file' }] }, 400);
  }
});

// GET /preset-skills — list available preset skills (MUST be before /:id routes)
agents.get('/preset-skills', async (c) => {
  const list = presetSkills.map(({ name, description }) => ({ name, description }));
  return c.json(list);
});

// POST / — create a new user agent (MUST be before /:id routes)
agents.post('/', async (c) => {
  const { userId } = c.get('user');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  // Resolve preset skill names to full SkillDef with content
  let skills = parsed.data.skills || [];
  if (skills.length > 0) {
    const presetMap = new Map(presetSkills.map((s: any) => [s.name, s]));
    skills = skills.map((s: any) => (!s.content && presetMap.has(s.name)) ? presetMap.get(s.name)! : s);
  }

  try {
    const agent = await prisma.agent.create({
      data: {
        ...parsed.data,
        providerConfig: getDefaultProviderConfig(parsed.data.provider || 'claude-code') as any,
        skills: skills as any,
        isActive: true,
        type: 'user',
        createdBy: userId,
      },
    });

    // Set up agent persistent home with full skill directories
    try {
      const { AgentDirectoryManager } = await import('../agent/AgentDirectoryManager.js');
      AgentDirectoryManager.ensureAgentHome(agent.id, agent.name, agent.systemPrompt, skills);
    } catch (homeErr: any) {
      // Rollback: delete the orphaned agent record
      await prisma.agent.delete({ where: { id: agent.id } }).catch(() => {});
      console.error(`[agents] Failed to set up agent home for ${agent.id}, rolled back: ${homeErr.message}`);
      return c.json({ error: 'Failed to initialize agent home directory' }, 500);
    }

    return c.json(agent, 201);
  } catch (err: any) {
    if (err.code === 'P2002') return c.json({ error: 'Agent name already exists' }, 409);
    throw err;
  }
});

// POST /:id/skills — add preset skills to an existing agent (MUST be before /:id routes)
agents.post('/:id/skills', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const { skillNames } = body as { skillNames?: string[] };
  if (!skillNames || !Array.isArray(skillNames) || skillNames.length === 0) {
    return c.json({ error: 'skillNames array required' }, 400);
  }

  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (agent.createdBy !== userId) return c.json({ error: 'Forbidden' }, 403);

  const presetMap = new Map(presetSkills.map(s => [s.name, s]));
  const newSkills: SkillDef[] = [];
  const skillsDir = resolve(config.agentContainer.hostRoot, id, '.claude', 'skills');

  for (const name of skillNames) {
    const preset = presetMap.get(name);
    if (!preset) continue;
    const targetDir = resolve(skillsDir, name);
    if (preset.sourceDir && existsSync(preset.sourceDir)) {
      try {
        cpSync(preset.sourceDir, targetDir, { recursive: true });
      } catch (err: any) {
        console.warn(`[agents] Failed to copy skill dir for ${name}: ${err.message}`);
        mkdirSync(targetDir, { recursive: true });
        const md = `---\nname: ${preset.name}\ndescription: ${preset.description}\n---\n\n${preset.content}`;
        writeFileSync(resolve(targetDir, 'SKILL.md'), md, 'utf-8');
      }
    } else {
      mkdirSync(targetDir, { recursive: true });
      const md = `---\nname: ${preset.name}\ndescription: ${preset.description}\n---\n\n${preset.content}`;
      writeFileSync(resolve(targetDir, 'SKILL.md'), md, 'utf-8');
    }
    newSkills.push({ name: preset.name, description: preset.description, content: preset.content });
  }

  // Merge and deduplicate
  const currentSkills = (agent.skills as SkillDef[] | null) || [];
  const merged = [...currentSkills];
  for (const s of newSkills) {
    if (!merged.find(m => m.name === s.name)) merged.push(s);
  }

  await prisma.agent.update({
    where: { id },
    data: { skills: merged as any },
  });

  return c.json({ added: newSkills });
});

// PUT /:id — update agent (MUST be AFTER fixed-path routes)
agents.put('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  try {
    // When provider is changed, reset providerConfig to the new provider's defaults
    // and restart the in-memory agent so it picks up the new provider
    let mergedConfig = (parsed.data.providerConfig as any) || undefined;
    if (parsed.data.provider) {
      const existing = await prisma.agent.findUnique({ where: { id }, select: { provider: true, providerConfig: true } });
      if (existing && parsed.data.provider !== existing.provider) {
        mergedConfig = getDefaultProviderConfig(parsed.data.provider);
        await agentRuntime.restartProvider(id);
      }
    }

    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...parsed.data,
        providerConfig: mergedConfig,
        capabilities: parsed.data.capabilities as any,
        skills: parsed.data.skills as any,
      },
    });
    return c.json(agent);
  } catch (err: any) {
    if (err.code === 'P2025') return c.json({ error: 'Agent not found' }, 404);
    throw err;
  }
});

// DELETE /:id — soft-delete with container cleanup
agents.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Only allow deletion of user-created agents
  if (agent.type !== 'user') return c.json({ error: 'Cannot delete system agents' }, 403);
  if (agent.createdBy !== userId) return c.json({ error: 'Forbidden' }, 403);
  // Planner is a core agent — never delete
  if (agent.name === 'planner' || agent.name.startsWith('planner-')) {
    return c.json({ error: 'Cannot delete the Planner agent' }, 403);
  }

  // Destroy container if running
  if (agent.containerId && agent.containerStatus === 'running') {
    try {
      const { AgentContainer } = await import('../agent/AgentContainer.js');
      await AgentContainer.destroy(agent.containerId);
    } catch { /* best-effort */ }
  }

  // Clean host work dir
  if (agent.hostWorkDir) {
    try {
      const { AgentContainer } = await import('../agent/AgentContainer.js');
      await AgentContainer.destroyHostDir(agent.id);
    } catch { /* best-effort */ }
  }

  // Notify all groups this agent belongs to before removal
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { agentId: id },
    select: { sessionId: true },
  });
  const { broadcast } = await import('../ws/state.js');
  for (const sa of sessionAgents) {
    broadcast(sa.sessionId, { type: 'agent_removed', agentId: id, sessionId: sa.sessionId });
  }

  // Remove from all groups + soft-delete in a single transaction
  await prisma.$transaction([
    prisma.sessionAgent.deleteMany({ where: { agentId: id } }),
    prisma.agent.update({ where: { id }, data: { isActive: false } }),
  ]);

  return c.body(null, 204);
});

export default agents;