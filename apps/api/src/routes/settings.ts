import { Hono } from 'hono';
import { z } from 'zod';
import { config, runtimeConfig } from '../config.js';
import { prisma } from '../db/prisma.js';
import { getUser } from '../lib/auth.js';
import { isAdmin } from '../middleware/whitelist.js';

const settings = new Hono();

// GET /api/settings/user — return current user settings, create defaults if missing
settings.get('/user', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const user = result;

  let userSettings = await prisma.userSettings.findUnique({
    where: { userId: user.userId },
  });

  if (!userSettings) {
    userSettings = await prisma.userSettings.create({
      data: { userId: user.userId },
    });
  }

  return c.json({
    theme: userSettings.theme,
    notificationsEnabled: userSettings.notificationsEnabled,
    avatarUrl: userSettings.avatarUrl,
  });
});

// PUT /api/settings/user — update user settings
const updateUserSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  notificationsEnabled: z.boolean().optional(),
  avatarUrl: z.string().nullable().optional(),
});

settings.put('/user', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const user = result;

  const parsed = updateUserSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const data: Record<string, any> = {};
  if (parsed.data.theme !== undefined) data.theme = parsed.data.theme;
  if (parsed.data.notificationsEnabled !== undefined) data.notificationsEnabled = parsed.data.notificationsEnabled;
  if (parsed.data.avatarUrl !== undefined) data.avatarUrl = parsed.data.avatarUrl;

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const updated = await prisma.userSettings.upsert({
    where: { userId: user.userId },
    update: data,
    create: { userId: user.userId, ...data },
  });

  return c.json({
    theme: updated.theme,
    notificationsEnabled: updated.notificationsEnabled,
    avatarUrl: updated.avatarUrl,
  });
});

// GET /api/settings/runtime — return current RuntimeAgentConfig
settings.get('/runtime', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const user = result;

  const data = runtimeConfig.agent.toJSON();
  if (isAdmin(user.username)) {
    return c.json({ ...data, isAdmin: true });
  }
  return c.json(data);
});

// PUT /api/settings/runtime — admin-only update runtime config
const updateRuntimeSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(10000).max(3600000).optional(),
  queueTimeoutMs: z.number().int().min(10000).max(1800000).optional(),
  perSessionMax: z.number().int().min(1).max(50).optional(),
  contextTokenBudget: z.number().int().min(2000).max(50000).optional(),
  permissionTimeoutMs: z.number().int().min(5000).max(600000).optional(),
});

settings.put('/runtime', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const user = result;

  // Admin check
  if (!isAdmin(user.username)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const parsed = updateRuntimeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  if (parsed.data.maxConcurrent !== undefined) {
    await runtimeConfig.agent.setMaxConcurrent(prisma, parsed.data.maxConcurrent);
  }
  if (parsed.data.timeoutMs !== undefined) {
    await runtimeConfig.agent.setTimeoutMs(prisma, parsed.data.timeoutMs);
  }
  if (parsed.data.queueTimeoutMs !== undefined) {
    await runtimeConfig.agent.setQueueTimeoutMs(prisma, parsed.data.queueTimeoutMs);
  }
  if (parsed.data.perSessionMax !== undefined) {
    await runtimeConfig.agent.setPerSessionMax(prisma, parsed.data.perSessionMax);
  }
  if (parsed.data.contextTokenBudget !== undefined) {
    await runtimeConfig.agent.setContextTokenBudget(prisma, parsed.data.contextTokenBudget);
  }
  if (parsed.data.permissionTimeoutMs !== undefined) {
    await runtimeConfig.agent.setPermissionTimeoutMs(prisma, parsed.data.permissionTimeoutMs);
  }

  return c.json(runtimeConfig.agent.toJSON());
});

export default settings;
