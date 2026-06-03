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

// Track active static servers per session so we can stop old ones
// and avoid port conflicts.
const staticServers = new Map<string, { port: number; directory: string }>();

const STATIC_SERVER_BASE_PORT = 8765;

preview.post('/:sessionId/serve-static', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: 'Sandbox not ready' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const directory = String(body.directory || '/workspace');
  if (!directory.startsWith('/workspace')) return c.json({ error: 'Directory must be under /workspace' }, 400);

  // Kill any previous static server for this session
  const prev = staticServers.get(sessionId);
  if (prev) {
    SandboxManager.execShell(containerId, `pkill -f "/tmp/_serve.js" 2>/dev/null || true`);
    staticServers.delete(sessionId);
  }

  // Pick a port not already in use
  const usedPorts = await SandboxManager.detectPorts(containerId);
  let port = STATIC_SERVER_BASE_PORT;
  while (usedPorts.includes(port) && port < STATIC_SERVER_BASE_PORT + 20) port++;
  if (port >= STATIC_SERVER_BASE_PORT + 20) {
    return c.json({ error: 'No available port for static server' }, 503);
  }

  // Write a minimal Node.js static server script to the sandbox and start it.
  // Uses the container's own Node runtime — zero extra deps.
  await SandboxManager.execCapture(containerId,
    `cat > /tmp/_serve.js << 'ENDOFSCRIPT'
const http=require("http"),fs=require("fs"),path=require("path");
const dir="${directory}";
const mime={html:"text/html",js:"application/javascript",css:"text/css",json:"application/json",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",svg:"image/svg+xml",webp:"image/webp",ico:"image/x-icon",woff2:"font/woff2",txt:"text/plain",xml:"application/xml"};
http.createServer((req,res)=>{
  const safe=path.normalize(req.url.split("?")[0]).replace(/\.\\.\\//g,"");
  const file=path.join(dir,safe==="/"?"/index.html":safe);
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end("Not found");return}
    res.writeHead(200,{"Content-Type":mime[path.extname(file).slice(1)]||"application/octet-stream"});
    res.end(data);
  });
}).listen(${port});
ENDOFSCRIPT`
  );
  SandboxManager.execShell(containerId,
    `nohup node /tmp/_serve.js > /dev/null 2>&1 &`
  );

  // Wait for the server to bind the port
  let ready = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300));
    const ports = await SandboxManager.detectPorts(containerId);
    if (ports.includes(port)) { ready = true; break; }
  }
  if (!ready) return c.json({ error: 'Static server failed to start' }, 500);

  // Set up port forwarding
  const forward = await SandboxManager.portForward(containerId, port);
  staticServers.set(sessionId, { port, directory });

  return c.json({
    port,
    directory,
    proxyUrl: `/api/preview/${sessionId}/proxy/${port}/`,
    url: `http://localhost:${forward.hostPort}`,
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
  const hmrScript = `<script>(${hmrPolyfill.toString()})(${JSON.stringify(proxyPath)})</script>`;
  const selScript = `<script>(${selectionCaptureScript.toString()})()</script>`;
  const combined = hmrScript + selScript;
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${combined}`);
  }
  if (html.includes('<html>')) {
    return html.replace('<html>', `<html><head>${combined}</head>`);
  }
  return combined + html;
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

/** Selection capture script — injected alongside HMR polyfill.
 *  Listens for text selection changes and posts selected text to parent window. */
function selectionCaptureScript(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  document.addEventListener('selectionchange', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        window.parent.postMessage({ type: 'agenthub:selection-clear' }, '*');
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2 || text.length > 5000) return;

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      window.parent.postMessage({
        type: 'agenthub:selection',
        text,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        url: window.location.href,
      }, '*');
    }, 300);
  });
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
