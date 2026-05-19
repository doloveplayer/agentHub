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
  if (!authHeader) {
    return c.json({ error: 'Missing authorization header' }, 401);
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return c.json({ error: 'Invalid authorization header format' }, 401);
  }

  const token = parts[1];
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
