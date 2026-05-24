import { Hono } from 'hono';
import { chromium } from 'playwright';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { SandboxManager } from '../agent/SandboxManager.js';

const preview = new Hono();
preview.use('*', authMiddleware);

async function getSessionContainer(sessionId: string, userId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId || !session.sandboxContainerId) return null;
  return session.sandboxContainerId;
}

preview.get('/:sessionId/ports', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: 'Sandbox not ready' }, 404);
  const ports = await SandboxManager.detectPorts(containerId);
  return c.json({ ports });
});

preview.post('/:sessionId/forward', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: 'Sandbox not ready' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return c.json({ error: 'Invalid port' }, 400);
  const forward = await SandboxManager.portForward(containerId, port);
  return c.json({
    ...forward,
    proxyUrl: `/api/preview/${sessionId}/proxy/${port}/`,
  });
});

preview.post('/:sessionId/screenshot', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: 'Sandbox not ready' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const url = String(body.url || '');
  if (!isAllowedScreenshotUrl(url)) return c.json({ error: 'Screenshot URL must target the local preview proxy' }, 400);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
    const image = await page.screenshot({ type: 'png', fullPage: true });
    return c.json({ image: `data:image/png;base64,${image.toString('base64')}`, capturedAt: Date.now() });
  } finally {
    await browser.close();
  }
});

preview.all('/:sessionId/proxy/:port/*', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.text('Sandbox not ready', 404);
  const port = Number(c.req.param('port'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return c.text('Invalid port', 400);
  const host = await SandboxManager.getContainerHost(containerId);
  if (!host) return c.text('Unable to resolve sandbox host', 502);

  const suffix = c.req.path.split(`/proxy/${port}/`)[1] || '';
  const url = `http://${host}:${port}/${suffix}${new URL(c.req.url).search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  headers.delete('authorization');
  const upstream = await fetch(url, {
    method: c.req.method,
    headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: 'manual',
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('content-security-policy');
  responseHeaders.delete('x-frame-options');
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

export default preview;

function isAllowedScreenshotUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}
