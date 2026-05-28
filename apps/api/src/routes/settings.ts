import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { config, runtimeConfig } from '../config.js';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';

const settings = new Hono();

interface JwtUser {
  userId: string;
  githubLogin: string;
}

/**
 * Extract user from JWT Bearer token in Authorization header.
 * Returns user object on success, or a Response on failure.
 */
async function getUser(c: Context): Promise<JwtUser | Response> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Missing authorization header' }, 401);
  }
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return c.json({ error: 'Invalid authorization header format' }, 401);
  }
  try {
    const payload = verifyToken(parts[1]);
    // Verify user still exists in DB
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true } });
    if (!user) {
      return c.json({ error: 'User not found — please re-authenticate' }, 401);
    }
    return { userId: payload.userId, githubLogin: payload.githubLogin };
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

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

  return c.json(runtimeConfig.agent.toJSON());
});

// PUT /api/settings/runtime — admin-only update runtime config
const updateRuntimeSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(10000).max(3600000).optional(),
  queueTimeoutMs: z.number().int().min(10000).max(1800000).optional(),
  perSessionMax: z.number().int().min(1).max(50).optional(),
});

settings.put('/runtime', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const user = result;

  // Admin check: caller must be in allowedUsers
  if (!config.github.allowedUsers.includes(user.githubLogin)) {
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

  return c.json(runtimeConfig.agent.toJSON());
});

export default settings;
