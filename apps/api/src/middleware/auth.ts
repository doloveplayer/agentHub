import type { Context, Next } from 'hono';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
import { prisma } from '../db/prisma.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  // Also support token query param for iframe/SSE requests that can't set headers
  const queryToken = c.req.query('token');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : queryToken || null;

  if (!token) {
    return c.json({ error: 'Missing authorization header or token query param' }, 401);
  }
  try {
    const payload = verifyToken(token);
    // Verify user still exists in DB (defense against DB resets)
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true },
    });
    if (!user) {
      return c.json({ error: 'User not found — please re-authenticate' }, 401);
    }
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}
