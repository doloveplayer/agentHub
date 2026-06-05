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

// In-flight deduplication: prevent concurrent requests for the same session
// from racing (e.g. React StrictMode double-mount, rapid file switching).
const pendingStaticServers = new Map<string, Promise<Response>>();

const STATIC_SERVER_BASE_PORT = 8765;
const STATIC_SERVER_PORT_MAX = STATIC_SERVER_BASE_PORT + 20;

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

  // Deduplicate: if a request for this session+directory is already in-flight,
  // return the same promise (cloned response) to prevent racing.
  const dedupeKey = `${sessionId}:${directory}`;
  const pending = pendingStaticServers.get(dedupeKey);
  if (pending) {
    const res = await pending;
    return res.clone();
  }

  const promise = doServeStatic(containerId, sessionId, directory);
  pendingStaticServers.set(dedupeKey, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    if (pendingStaticServers.get(dedupeKey) === promise) {
      pendingStaticServers.delete(dedupeKey);
    }
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function doServeStatic(
  containerId: string,
  sessionId: string,
  directory: string,
): Promise<Response> {
  // Kill ALL previous static servers in this container.
  // pkill/kill may not exist in minimal sandbox images, so use Node.js to find and kill.
  await SandboxManager.execCapture(
    containerId,
    `node -e 'const fs=require("fs");for(const d of fs.readdirSync("/proc")){if(!/^\\d+$/.test(d))continue;try{const c=fs.readFileSync("/proc/"+d+"/cmdline","utf8").replace(/\\0/g," ");if(c.includes("/tmp/_serve.js"))process.kill(Number(d),"SIGKILL")}catch{}}' 2>/dev/null; true`,
  );

  // Wait for ports to actually be released (not blind sleep).
  // Poll /proc/net/tcp to check the static server port range is clear.
  for (let attempt = 0; attempt < 25; attempt++) {
    const tcp = await SandboxManager.execCapture(
      containerId,
      `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true`,
    );
    let occupied = false;
    for (let p = STATIC_SERVER_BASE_PORT; p < STATIC_SERVER_PORT_MAX; p++) {
      if (tcp.toUpperCase().includes(`:${p.toString(16).toUpperCase().padStart(4, "0")}`)) {
        occupied = true;
        break;
      }
    }
    if (!occupied) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  staticServers.delete(sessionId);

  try {
    // Check directory exists before attempting to serve (use single-quoted path to prevent injection)
    const safeDir = directory.replace(/'/g, "'\\''");
    const dirCheck = await SandboxManager.execCapture(
      containerId,
      `test -d '${safeDir}' && echo ok || echo missing`,
    );
    if (dirCheck !== "ok") {
      return jsonRes({ error: `Directory not found: ${directory}` }, 404);
    }

    // Auto-detect build-tool projects (Vite, webpack, etc.): if dist/index.html
    // exists and the root index.html references source files, serve from dist/.
    let serveDir = directory;
    const distCheck = await SandboxManager.execCapture(
      containerId,
      `test -f '${safeDir}/dist/index.html' && echo exists || echo missing`,
    );
    if (distCheck === "exists") {
      const rootHtml = await SandboxManager.execCapture(
        containerId,
        `head -20 '${safeDir}/index.html' 2>/dev/null || true`,
      );
      // If root index.html references source files (src/main.tsx, src/main.ts, etc.), use dist/
      if (/src\/main\.(tsx?|jsx?)/.test(rootHtml) || /type="module".*src=/.test(rootHtml)) {
        serveDir = `${directory}/dist`;
      }
    }

    // Pick a port not already in use
    const usedPorts = await SandboxManager.detectPorts(containerId);
    let port = STATIC_SERVER_BASE_PORT;
    while (usedPorts.includes(port) && port < STATIC_SERVER_PORT_MAX)
      port++;
    if (port >= STATIC_SERVER_PORT_MAX) {
      return jsonRes({ error: "No available port for static server" }, 503);
    }

    // Write a minimal Node.js static server script to the sandbox and start it.
    // Uses the container's own Node runtime — zero extra deps.
    // Use JSON.stringify for safe JS string literal generation (handles all escaping)
    const dirJsLiteral = JSON.stringify(serveDir);
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
function tryListen(attempt){
  srv.listen(${port});
  srv.once("error",function(e){
    srv.removeAllListeners("error");
    if(e.code==="EADDRINUSE"&&attempt<5){
      setTimeout(function(){tryListen(attempt+1)},200);
    }else{
      process.exit(1);
    }
  });
}
tryListen(0);
ENDOFSCRIPT`,
    );
    SandboxManager.execShell(
      containerId,
      `nohup node /tmp/_serve.js > /tmp/_serve.log 2>&1 &`,
    );

    // Wait for the server to bind the port (single shell-level retry to avoid N docker exec calls)
    // /proc/net/tcp uses uppercase hex, so convert to uppercase to match
    const portHex = port.toString(16).toUpperCase();
    const ready = await SandboxManager.execCapture(
      containerId,
      `for i in $(seq 1 10); do grep -qi ":${portHex}" /proc/net/tcp /proc/net/tcp6 2>/dev/null && echo ready && break; sleep 0.3; done`,
    );
    if (!ready.includes("ready")) {
      const log = await SandboxManager.execCapture(
        containerId,
        'cat /tmp/_serve.log 2>/dev/null || echo "(no log)"',
      );
      return jsonRes({ error: `Static server failed to start: ${log}` }, 500);
    }

    // Set up port forwarding
    const forward = await SandboxManager.portForward(containerId, port);
    staticServers.set(sessionId, { port, directory });

    return jsonRes({
      port,
      directory,
      proxyUrl: `/api/preview/${sessionId}/proxy/${port}/`,
      url: `http://localhost:${forward.hostPort}`,
    });
  } catch (err: any) {
    return jsonRes(
      { error: `Sandbox command failed: ${err?.message || err}` },
      502,
    );
  }
}

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

// -- Injected browser scripts (raw JS strings to avoid tsx/esbuild helpers) --

/** Build the combined <script> tags for HMR proxy, selection capture, and token persistence. */
function injectHmrScript(
  html: string,
  sessionId: string,
  port: number,
): string {
  const proxyPath = `/api/preview/${sessionId}/proxy/${port}`;
  const combined =
    `<script>(${HMR_POLYFILL_JS})(${JSON.stringify(proxyPath)})</script>` +
    `<script>(${SELECTION_CAPTURE_JS})()</script>` +
    `<script>(${TOKEN_PERSISTENCE_JS})()</script>`;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${combined}`);
  }
  if (html.includes("<html>")) {
    return html.replace("<html>", `<html><head>${combined}</head>`);
  }
  return combined + html;
}

/* eslint-disable @typescript-eslint/no-unused-expressions */

/** Hijacks WebSocket constructor so Vite HMR connects through the API proxy path. */
const HMR_POLYFILL_JS = `function(proxyPath){
  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var target = url;
    if (typeof url === "string") {
      if (url.startsWith("ws://") || url.startsWith("wss://")) {
        try {
          var a = document.createElement("a");
          a.href = url;
          var path = a.pathname + a.search;
          target = (location.protocol === "https:" ? "wss:" : "ws:") +
            "//" + location.host + proxyPath +
            (path.startsWith("/") ? path.slice(1) : path);
        } catch(e) {}
      } else if (url.startsWith("/")) {
        target = proxyPath + url;
      }
    }
    return new OrigWebSocket(target, protocols);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
}`;

/** Reads ?token= from the initial URL, stores in sessionStorage,
 *  appends to same-origin navigations and intercepts link clicks. */
const TOKEN_PERSISTENCE_JS = `function(){
  var sp = new URLSearchParams(location.search);
  var initial = sp.get("token");
  if (initial) sessionStorage.setItem("_apitok", initial);

  function ensureToken(url) {
    try {
      var u = new URL(url, location.origin);
      if (u.origin !== location.origin) return url;
      var tok = sessionStorage.getItem("_apitok");
      if (!tok) return url;
      u.searchParams.set("token", tok);
      return u.pathname + u.search + u.hash;
    } catch(e) { return url; }
  }

  document.addEventListener("click", function(e) {
    var a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || !a.href) return;
    var tok = sessionStorage.getItem("_apitok");
    if (!tok) return;
    try {
      var u = new URL(a.href, location.origin);
      if (u.origin !== location.origin) return;
      if (!u.searchParams.has("token")) {
        e.preventDefault();
        u.searchParams.set("token", tok);
        location.href = u.pathname + u.search + u.hash;
      }
    } catch(e) {}
  }, true);

  var origPushState = history.pushState;
  history.pushState = function() {
    if (arguments[1] && typeof arguments[0] === "string")
      arguments[0] = ensureToken(arguments[0]);
    return origPushState.apply(this, arguments);
  };
  var origReplaceState = history.replaceState;
  history.replaceState = function() {
    if (arguments[1] && typeof arguments[0] === "string")
      arguments[0] = ensureToken(arguments[0]);
    return origReplaceState.apply(this, arguments);
  };

  window.addEventListener("pageshow", function() {
    var tok = sessionStorage.getItem("_apitok");
    if (!tok) return;
    var u = new URL(location.href);
    if (!u.searchParams.has("token")) {
      u.searchParams.set("token", tok);
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    }
  });
}`;

/** Listens for text selection changes and posts selected text to parent window. */
const SELECTION_CAPTURE_JS = `function(){
  var debounceTimer = null;
  document.addEventListener("selectionchange", function() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        window.parent.postMessage({ type: "agenthub:selection-clear" }, "*");
        return;
      }
      var text = sel.toString().trim();
      if (text.length < 2 || text.length > 5000) return;
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      window.parent.postMessage({
        type: "agenthub:selection",
        text: text,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        url: window.location.href
      }, "*");
    }, 300);
  });
}`;

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
