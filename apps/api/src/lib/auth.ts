import type { Context } from 'hono';
import { prisma } from '../db/prisma.js';
import { verifyToken } from './jwt.js';

export interface JwtUser {
  userId: string;
  username: string;
}

export async function getUser(c: Context): Promise<JwtUser | Response> {
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
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true } });
    if (!user) {
      return c.json({ error: 'User not found — please re-authenticate' }, 401);
    }
    return { userId: payload.userId, username: payload.username };
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}
