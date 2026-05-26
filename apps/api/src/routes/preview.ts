import { Hono } from 'hono';
import { chromium } from 'playwright';
import type http from 'http';
import net from 'net';
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

  // Inject HMR WebSocket polyfill so Vite's HMR client connects through the proxy
  const ct = responseHeaders.get('content-type') || '';
  if (ct.includes('text/html') && upstream.body) {
    const raw = await upstream.text();
    const injected = injectHmrScript(raw, sessionId, port);
    responseHeaders.delete('content-length');
    return new Response(injected, { status: upstream.status, headers: responseHeaders });
  }

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

// -- HMR WebSocket proxy support --

/** Inject a polyfill script into HTML that rewrites Vite HMR WebSocket URLs
 *  to route through the API proxy path. */
function injectHmrScript(html: string, sessionId: string, port: number): string {
  const proxyPath = `/api/preview/${sessionId}/proxy/${port}`;
  const script = `<script>(${hmrPolyfill.toString()})(${JSON.stringify(proxyPath)})</script>`;
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${script}`);
  }
  if (html.includes('<html>')) {
    return html.replace('<html>', `<html><head>${script}</head>`);
  }
  return script + html;
}

/** Polyfill function (serialized as a string) — runs in the iframe sandbox.
 *  Hijacks the WebSocket constructor so Vite's HMR client connects via the proxy path
 *  instead of the page origin root. */
function hmrPolyfill(proxyPath: string): void {
  const OrigWebSocket = (window as any).WebSocket;
  (window as any).WebSocket = function (url: string, protocols?: string | string[]) {
    let target: string = url;
    if (typeof url === 'string') {
      if (url.startsWith('ws://') || url.startsWith('wss://')) {
        try {
          const a = document.createElement('a');
          a.href = url;
          const path = a.pathname + a.search;
          target = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + proxyPath + (path.startsWith('/') ? path.slice(1) : path);
        } catch { /* use original URL */ }
      } else if (url.startsWith('/')) {
        target = proxyPath + url;
      }
    }
    return new OrigWebSocket(target, protocols);
  };
  (window as any).WebSocket.prototype = OrigWebSocket.prototype;
}

// Regex matches /api/preview/{sessionId}/proxy/{port}/{path}
const PREVIEW_WS_RE = /^\/api\/preview\/([^/]+)\/proxy\/(\d+)\/(.*)$/;

/**
 * Handle an HTTP upgrade request destined for a preview proxy WebSocket.
 * Returns true if the request was matched and handled, false otherwise.
 */
export async function handlePreviewUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<boolean> {
  const match = req.url ? PREVIEW_WS_RE.exec(req.url) : null;
  if (!match) return false;

  const [, sessionId, portStr, wsPath] = match;
  const port = Number(portStr);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    socket.destroy();
    return true;
  }

  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session?.sandboxContainerId) { socket.destroy(); return true; }
    const host = await SandboxManager.getContainerHost(session.sandboxContainerId);
    if (!host) { socket.destroy(); return true; }

    const upstream = net.connect(port, host, () => {
      // Forward the HTTP upgrade request to the sandbox container
      const reqLine = `${req.method} /${wsPath} HTTP/${req.httpVersion}\r\n`;
      upstream.write(reqLine);
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          upstream.write(`${name}: ${value.join(', ')}\r\n`);
        } else if (value !== undefined) {
          upstream.write(`${name}: ${value}\r\n`);
        }
      }
      upstream.write('\r\n');
      if (head.length > 0) upstream.write(head);

      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      upstream.destroy();
    });
  } catch {
    socket.destroy();
  }
  return true;
}
