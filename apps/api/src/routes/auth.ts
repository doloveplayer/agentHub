import { Hono } from 'hono';
import { ProxyAgent } from 'undici';
import { config } from '../config.js';
import { prisma } from '../db/prisma.js';
import { signToken } from '../lib/jwt.js';
import { isUserAllowed } from '../middleware/whitelist.js';
import { authMiddleware } from '../middleware/auth.js';

const auth = new Hono();

const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const proxyDispatcher = httpsProxy ? new ProxyAgent({ uri: httpsProxy }) : undefined;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}) } as RequestInit & { dispatcher?: typeof proxyDispatcher });
  } finally {
    clearTimeout(timeout);
  }
}

// GET /github — redirect to GitHub OAuth authorize URL
auth.get('/github', (c) => {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.github.clientId);
  url.searchParams.set('redirect_uri', config.github.callbackUrl);
  url.searchParams.set('scope', 'read:user user:email');
  return c.redirect(url.toString());
});

// GET /github/callback — handle OAuth callback
auth.get('/github/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) {
    return c.json({ error: 'Missing code parameter' }, 400);
  }

  // Exchange code for access token
  let tokenRes: Response;
  try {
    tokenRes = await fetchWithTimeout('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
        redirect_uri: config.github.callbackUrl,
      }),
    });
  } catch (err) {
    console.error('[auth] GitHub token exchange failed:', (err as Error).message);
    return c.json({ error: `GitHub token exchange failed: ${(err as Error).message}` }, 500);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };

  if (!tokenData.access_token) {
    return c.json(
      { error: tokenData.error || 'Failed to exchange code for token' },
      401,
    );
  }

  // Fetch GitHub user
  let userRes: Response;
  try {
    userRes = await fetchWithTimeout('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });
  } catch (err) {
    console.error('[auth] Failed to fetch GitHub user:', (err as Error).message);
    return c.json({ error: `Failed to fetch GitHub user: ${(err as Error).message}` }, 500);
  }
  const githubUser = (await userRes.json()) as {
    id: number;
    login: string;
    avatar_url: string;
    email?: string;
  };

  // Check whitelist
  if (!isUserAllowed(githubUser.login)) {
    return c.json({ error: 'User not in allowed list' }, 403);
  }

  // Upsert user in DB
  const user = await prisma.user.upsert({
    where: { githubId: githubUser.id },
    update: {
      login: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      email: githubUser.email,
    },
    create: {
      githubId: githubUser.id,
      login: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      email: githubUser.email,
    },
  });

  // Sign JWT
  const token = signToken({ userId: user.id, githubLogin: user.login });

  // Redirect to frontend
  const frontendUrl = new URL(`${config.frontendUrl}/auth/callback`);
  frontendUrl.searchParams.set('token', token);
  return c.redirect(frontendUrl.toString());
});

// GET /me — return current user (protected)
auth.get('/me', authMiddleware, async (c) => {
  const { userId } = c.get('user');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, githubId: true, login: true, avatarUrl: true, email: true },
  });

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json(user);
});

export default auth;
