import { Hono } from "hono";
import { chromium } from "playwright";
import type http from "http";
import net from "net";
import Docker from "dockerode";
import { authMiddleware } from "../middleware/auth.js";
import { prisma } from "../db/prisma.js";
import { config } from "../config.js";
import { SandboxManager } from "../agent/SandboxManager.js";

const docker = new Docker({ socketPath: config.sandbox.hostDockerSocket });

const preview = new Hono();
preview.use("*", authMiddleware);

// TTL cache for container lookups to avoid repeated Docker inspect + Prisma queries on proxy hot path
const containerCache = new Map<string, { containerId: string; ts: number }>();
const CONTAINER_CACHE_TTL = 5000; // 5 seconds

async function getSessionContainer(
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const cached = containerCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CONTAINER_CACHE_TTL)
    return cached.containerId;

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId || !session.sandboxContainerId) {
    containerCache.delete(sessionId);
    return null;
  }
  // Verify container actually exists (DB reference may be stale)
  try {
    await docker.getContainer(session.sandboxContainerId).inspect();
  } catch {
    containerCache.delete(sessionId);
    return null;
  }
  containerCache.set(sessionId, {
    containerId: session.sandboxContainerId,
    ts: Date.now(),
  });
  return session.sandboxContainerId;
}

preview.get("/:sessionId/ports", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: "Sandbox not ready" }, 404);
  const ports = await SandboxManager.detectPorts(containerId);
  return c.json({ ports });
});

preview.post("/:sessionId/forward", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: "Sandbox not ready" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return c.json({ error: "Invalid port" }, 400);
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

preview.post("/:sessionId/serve-static", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");

  // Validate directory BEFORE container check (defense-in-depth)
  const body = await c.req.json().catch(() => ({}));
  const directory = String(body.directory || "/workspace");
  if (directory !== "/workspace" && !directory.startsWith("/workspace/"))
    return c.json({ error: "Directory must be under /workspace" }, 400);
  if (directory.includes("/../") || directory.endsWith("/.."))
    return c.json({ error: "Invalid directory path" }, 400);
  if (!/^\/workspace(\/[\w.@-]+)*$/.test(directory))
    return c.json({ error: "Invalid directory path" }, 400);

  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: "Sandbox not ready" }, 404);

  // Kill ALL previous static servers in this container (await to ensure port is released)
  await SandboxManager.execCapture(
    containerId,
    `pkill -f "/tmp/_serve.js" 2>/dev/null; sleep 0.5; true`,
  );
  staticServers.delete(sessionId);

  try {
    // Check directory exists before attempting to serve (use single-quoted path to prevent injection)
    const dirCheck = await SandboxManager.execCapture(
      containerId,
      `test -d '${directory.replace(/'/g, "'\\''")}' && echo ok || echo missing`,
    );
    if (dirCheck !== "ok") {
      return c.json({ error: `Directory not found: ${directory}` }, 404);
    }

    // Pick a port not already in use
    const usedPorts = await SandboxManager.detectPorts(containerId);
    let port = STATIC_SERVER_BASE_PORT;
    while (usedPorts.includes(port) && port < STATIC_SERVER_BASE_PORT + 20)
      port++;
    if (port >= STATIC_SERVER_BASE_PORT + 20) {
      return c.json({ error: "No available port for static server" }, 503);
    }

    // Write a minimal Node.js static server script to the sandbox and start it.
    // Uses the container's own Node runtime — zero extra deps.
    // Use JSON.stringify for safe JS string literal generation (handles all escaping)
    const dirJsLiteral = JSON.stringify(directory);
    await SandboxManager.execCapture(
      containerId,
      `cat > /tmp/_serve.js << 'ENDOFSCRIPT'
const http=require("http"),fs=require("fs"),path=require("path");
const dir=${dirJsLiteral};
const mime={html:"text/html",js:"application/javascript",css:"text/css",json:"application/json",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",svg:"image/svg+xml",webp:"image/webp",ico:"image/x-icon",woff2:"font/woff2",txt:"text/plain",xml:"application/xml"};
const srv=http.createServer((req,res)=>{
  const raw=req.url.split("?")[0];
  const safe=path.normalize(raw).replace(/^\\.\\.\\//g,"");
  const file=path.join(dir,safe==="/"?"/index.html":safe);
  if(!file.startsWith(dir)){res.writeHead(403);res.end("Forbidden");return}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end("Not found");return}
    res.writeHead(200,{"Content-Type":mime[path.extname(file).slice(1)]||"application/octet-stream"});
    res.end(data);
  });
});
srv.on("error",(e)=>{if(e.code==="EADDRINUSE"){process.exit(1)}});
srv.listen(${port});
ENDOFSCRIPT`,
    );
    SandboxManager.execShell(
      containerId,
      `nohup node /tmp/_serve.js > /tmp/_serve.log 2>&1 &`,
    );

    // Wait for the server to bind the port (single shell-level retry to avoid N docker exec calls)
    const portHex = port.toString(16);
    const ready = await SandboxManager.execCapture(
      containerId,
      `for i in $(seq 1 10); do grep -q ":${portHex}" /proc/net/tcp /proc/net/tcp6 2>/dev/null && echo ready && break; sleep 0.3; done`,
    );
    if (!ready.includes("ready")) {
      const log = await SandboxManager.execCapture(
        containerId,
        'cat /tmp/_serve.log 2>/dev/null || echo "(no log)"',
      );
      return c.json({ error: `Static server failed to start: ${log}` }, 500);
    }

    // Set up port forwarding
    const forward = await SandboxManager.portForward(containerId, port);
    staticServers.set(sessionId, { port, directory });

    return c.json({
      port,
      directory,
      proxyUrl: `/api/preview/${sessionId}/proxy/${port}/`,
      url: `http://localhost:${forward.hostPort}`,
    });
  } catch (err: any) {
    return c.json(
      { error: `Sandbox command failed: ${err?.message || err}` },
      502,
    );
  }
});

preview.post("/:sessionId/screenshot", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: "Sandbox not ready" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const url = String(body.url || "");
  if (!isAllowedScreenshotUrl(url))
    return c.json(
      { error: "Screenshot URL must target the local preview proxy" },
      400,
    );

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    const image = await page.screenshot({ type: "png", fullPage: true });
    return c.json({
      image: `data:image/png;base64,${image.toString("base64")}`,
      capturedAt: Date.now(),
    });
  } finally {
    await browser.close();
  }
});

preview.all("/:sessionId/proxy/:port/*", async (c) => {
  const { userId } = c.get("user");
  const sessionId = c.req.param("sessionId");
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.text("Sandbox not ready", 404);
  const port = Number(c.req.param("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return c.text("Invalid port", 400);
  const host = await SandboxManager.getContainerHost(containerId);
  if (!host) return c.text("Unable to resolve sandbox host", 502);

  const suffix = c.req.path.split(`/proxy/${port}/`)[1] || "";
  const url = `http://${host}:${port}/${suffix}${new URL(c.req.url).search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("authorization");
  const upstream = await fetch(url, {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-security-policy");
  responseHeaders.delete("x-frame-options");

  // Set HttpOnly cookie so subsequent iframe navigations carry the token automatically
  const reqUrl = new URL(c.req.url);
  const tokenParam = reqUrl.searchParams.get("token");
  if (tokenParam) {
    responseHeaders.set(
      "Set-Cookie",
      `agenthub_token=${encodeURIComponent(tokenParam)}; Path=/api/preview/${sessionId}/; SameSite=Lax; HttpOnly`,
    );
  }

  // Inject HMR WebSocket polyfill so Vite's HMR client connects through the proxy
  const ct = responseHeaders.get("content-type") || "";
  if (ct.includes("text/html") && upstream.body) {
    const raw = await upstream.text();
    const injected = injectHmrScript(raw, sessionId, port);
    responseHeaders.delete("content-length");
    return new Response(injected, {
      status: upstream.status,
      headers: responseHeaders,
    });
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
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

// -- HMR WebSocket proxy support --

/** Inject a polyfill script into HTML that rewrites Vite HMR WebSocket URLs
 *  to route through the API proxy path. */
function injectHmrScript(
  html: string,
  sessionId: string,
  port: number,
): string {
  const proxyPath = `/api/preview/${sessionId}/proxy/${port}`;
  const hmrScript = `<script>(${hmrPolyfill.toString()})(${JSON.stringify(proxyPath)})</script>`;
  const selScript = `<script>(${selectionCaptureScript.toString()})()</script>`;
  const tokenScript = `<script>(${tokenPersistenceScript.toString()})()</script>`;
  const combined = hmrScript + selScript + tokenScript;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${combined}`);
  }
  if (html.includes("<html>")) {
    return html.replace("<html>", `<html><head>${combined}</head>`);
  }
  return combined + html;
}

/** Polyfill function (serialized as a string) — runs in the iframe sandbox.
 *  Hijacks the WebSocket constructor so Vite's HMR client connects via the proxy path
 *  instead of the page origin root. */
function hmrPolyfill(proxyPath: string): void {
  const OrigWebSocket = (window as any).WebSocket;
  (window as any).WebSocket = function (
    url: string,
    protocols?: string | string[],
  ) {
    let target: string = url;
    if (typeof url === "string") {
      if (url.startsWith("ws://") || url.startsWith("wss://")) {
        try {
          const a = document.createElement("a");
          a.href = url;
          const path = a.pathname + a.search;
          target =
            (location.protocol === "https:" ? "wss:" : "ws:") +
            "//" +
            location.host +
            proxyPath +
            (path.startsWith("/") ? path.slice(1) : path);
        } catch {
          /* use original URL */
        }
      } else if (url.startsWith("/")) {
        target = proxyPath + url;
      }
    }
    return new OrigWebSocket(target, protocols);
  };
  (window as any).WebSocket.prototype = OrigWebSocket.prototype;
}

/** Token persistence script — injected into every proxied HTML page.
 *  Reads ?token= from the initial URL, stores it in sessionStorage,
 *  and appends it to all same-origin link clicks/form submissions. */
function tokenPersistenceScript(): void {
  const sp = new URLSearchParams(location.search);
  const initial = sp.get("token");
  if (initial) sessionStorage.setItem("_apitok", initial);

  function ensureToken(url: string): string {
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin) return url;
      const tok = sessionStorage.getItem("_apitok");
      if (!tok) return url;
      u.searchParams.set("token", tok);
      return u.pathname + u.search + u.hash;
    } catch {
      return url;
    }
  }

  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement).closest(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || !a.href) return;
      const tok = sessionStorage.getItem("_apitok");
      if (!tok) return;
      try {
        const u = new URL(a.href, location.origin);
        if (u.origin !== location.origin) return;
        if (!u.searchParams.has("token")) {
          e.preventDefault();
          u.searchParams.set("token", tok);
          location.href = u.pathname + u.search + u.hash;
        }
      } catch {
        /* ignore */
      }
    },
    true,
  );

  const origPushState = history.pushState;
  history.pushState = function (...args: any[]) {
    if (args[1] && typeof args[0] === "string") args[0] = ensureToken(args[0]);
    return origPushState.apply(this, args as any);
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args: any[]) {
    if (args[1] && typeof args[0] === "string") args[0] = ensureToken(args[0]);
    return origReplaceState.apply(this, args as any);
  };

  window.addEventListener("pageshow", () => {
    const tok = sessionStorage.getItem("_apitok");
    if (!tok) return;
    const u = new URL(location.href);
    if (!u.searchParams.has("token")) {
      u.searchParams.set("token", tok);
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    }
  });
}

/** Selection capture script — injected alongside HMR polyfill.
 *  Listens for text selection changes and posts selected text to parent window. */
function selectionCaptureScript(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  document.addEventListener("selectionchange", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        window.parent.postMessage({ type: "agenthub:selection-clear" }, "*");
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2 || text.length > 5000) return;

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      window.parent.postMessage(
        {
          type: "agenthub:selection",
          text,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
          url: window.location.href,
        },
        "*",
      );
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
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!session?.sandboxContainerId) {
      socket.destroy();
      return true;
    }
    const host = await SandboxManager.getContainerHost(
      session.sandboxContainerId,
    );
    if (!host) {
      socket.destroy();
      return true;
    }

    const upstream = net.connect(port, host, () => {
      // Forward the HTTP upgrade request to the sandbox container
      const reqLine = `${req.method} /${wsPath} HTTP/${req.httpVersion}\r\n`;
      upstream.write(reqLine);
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          upstream.write(`${name}: ${value.join(", ")}\r\n`);
        } else if (value !== undefined) {
          upstream.write(`${name}: ${value}\r\n`);
        }
      }
      upstream.write("\r\n");
      if (head.length > 0) upstream.write(head);

      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => {
      socket.destroy();
    });
    socket.on("error", () => {
      upstream.destroy();
    });
  } catch {
    socket.destroy();
  }
  return true;
}
