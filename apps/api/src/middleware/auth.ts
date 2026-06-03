import type { Context, Next } from 'hono';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
import { prisma } from '../db/prisma.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) result[key.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return result;
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  // Fallback chain: Authorization header → ?token= query param → cookie
  const queryToken = c.req.query('token');
  const cookies = parseCookies(c.req.header('Cookie'));
  const cookieToken = cookies['agenthub_token'];
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : queryToken || cookieToken || null;

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
