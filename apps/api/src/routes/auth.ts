import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { prisma } from '../db/prisma.js';
import { signToken } from '../lib/jwt.js';
import { authMiddleware } from '../middleware/auth.js';

const auth = new Hono();

// POST /auth/login — authenticate with username + password
auth.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const token = signToken({ userId: user.id, username: user.username });
  return c.json({ token, userId: user.id, username: user.username });
});

// POST /auth/register — create a new user account
auth.post('/register', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  if (username.length < 2 || username.length > 32) {
    return c.json({ error: 'Username must be 2-32 characters' }, 400);
  }

  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return c.json({ error: 'Username already taken' }, 409);
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { username, password: hashed },
  });

  const token = signToken({ userId: user.id, username: user.username });
  return c.json({ token, userId: user.id, username: user.username }, 201);
});

// GET /me — return current user (protected)
auth.get('/me', authMiddleware, async (c) => {
  const { userId } = c.get('user');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, avatarUrl: true, email: true },
  });

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json(user);
});

// GET /dev-token — test bypass (dev only)
auth.get('/dev-token', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'Dev token endpoint disabled in production' }, 403);
  }
  const admin = await prisma.user.findFirst({ where: { username: config.defaultAdmin.username } });
  if (!admin) return c.json({ error: 'No admin user found' }, 400);
  const token = signToken({ userId: admin.id, username: admin.username });
  return c.json({ token, userId: admin.id, username: admin.username });
});

/** Seed default admin user if not exists */
export async function seedDefaultAdmin() {
  const { username, password } = config.defaultAdmin;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (!existing) {
    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { username, password: hashed } });
    console.log(`[auth] Seeded default admin user: ${username}`);
  }
}

export default auth;
