import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { ClaudeCodeProcess } from '../agent/ClaudeCodeProcess.js';
import { SandboxManager } from '../agent/SandboxManager.js';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { config } from '../config.js';

// ---- State ----

/** sessionId → set of connected WebSockets */
const sessions = new Map<string, Set<WebSocket>>();

/** sessionId → active agent info (process + timer) */
const agentStates = new Map<string, Map<string, { process: ClaudeCodeProcess; timer: NodeJS.Timeout; agentId: string }>>();

/** sessionId → sandbox info (lazy-created per session) */
const sandboxes = new Map<string, { containerId: string; workDir: string; hostWorkDir: string }>();

/** Count of currently executing agents across all sessions */
let runningAgentCount = 0;

// ---- Helpers ----

function generateId(): string {
  return crypto.randomUUID();
}

async function getOrCreateSandbox(sessionId: string) {
  let sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    sandbox = await SandboxManager.create(sessionId);
    sandboxes.set(sessionId, sandbox);
  }
  return sandbox;
}

function broadcast(sessionId: string, data: unknown): void {
  const conns = sessions.get(sessionId);
  if (!conns) return;
  const payload = JSON.stringify(data);
  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function sendTo(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function cleanupSessionResources(sessionId: string): void {
  // Kill all agents for this session
  const stateMap = agentStates.get(sessionId);
  if (stateMap) {
    for (const [msgId, state] of stateMap) {
      clearTimeout(state.timer);
      state.process.kill();
      runningAgentCount = Math.max(0, runningAgentCount - 1);
    }
    agentStates.delete(sessionId);
  }

  // Destroy Docker sandbox
  const sandbox = sandboxes.get(sessionId);
  if (sandbox) {
    SandboxManager.destroy(sandbox.containerId).catch((err) =>
      console.error(`[ws] Failed to destroy container: ${err.message}`),
    );
    SandboxManager.destroyHostDir(sessionId);
    sandboxes.delete(sessionId);
    console.log(`[ws] Sandbox cleaned: session=${sessionId}`);
  }

  sessions.delete(sessionId);
}

async function buildHistory(sessionId: string): Promise<string | null> {
  try {
    const msgs = await prisma.message.findMany({
      where: { sessionId, status: 'done' },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (msgs.length <= 1) return null;
    return msgs.map(m =>
      `${m.senderType === 'human' ? 'User' : 'Agent'}: ${m.content}`
    ).join('\n');
  } catch { return null; }
}

function cleanupSessionClient(sessionId: string, ws: WebSocket): void {
  const conns = sessions.get(sessionId);
  if (!conns) return;
  conns.delete(ws);
  if (conns.size > 0) return;

  console.log(`[ws] Last client left session=${sessionId}, cleaning up...`);
  cleanupSessionResources(sessionId);
}

// ---- Connection handler ----

async function handleConnection(ws: WebSocket, request: any) {
  const url = new URL(
    request.url || '/',
    `http://${request.headers?.host || 'localhost'}`,
  );
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');

  if (!token || !sessionId) {
    sendTo(ws, { type: 'error', message: 'Missing token or sessionId' });
    ws.close(4000, 'Missing token or sessionId');
    return;
  }

  // Verify JWT
  let userId: string;
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch {
    sendTo(ws, { type: 'error', message: 'Invalid token' });
    ws.close(4001, 'Invalid token');
    return;
  }

  // Verify user still exists in DB (defense against DB resets)
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      sendTo(ws, { type: 'error', message: 'User not found — please re-authenticate' });
      ws.close(4001, 'User not found');
      return;
    }
  } catch {
    sendTo(ws, { type: 'error', message: 'Failed to verify user' });
    ws.close(4000, 'Internal error');
    return;
  }

  // Verify session ownership
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });
    if (!session || session.userId !== userId) {
      sendTo(ws, { type: 'error', message: 'Session not found or access denied' });
      ws.close(4003, 'Access denied');
      return;
    }
  } catch {
    sendTo(ws, { type: 'error', message: 'Failed to verify session' });
    ws.close(4000, 'Internal error');
    return;
  }

  // Register connection
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new Set());
  }
  sessions.get(sessionId)!.add(ws);

  // Ensure sandbox exists
  try {
    const sb = await getOrCreateSandbox(sessionId);
    // Persist containerId so REST DELETE can clean up
    await prisma.session.update({
      where: { id: sessionId },
      data: { sandboxContainerId: sb.containerId },
    }).catch(() => {});
    console.log(`[ws] Sandbox ready: session=${sessionId} container=${sb.containerId.slice(0, 12)} hostDir=${sb.hostWorkDir}`);
  } catch (err: any) {
    console.error(`[ws] Sandbox creation failed: session=${sessionId} error=${err.message}`);
    sendTo(ws, { type: 'error', message: `Sandbox creation failed: ${err.message}` });
    ws.close(4000, 'Sandbox failed');
    return;
  }

  console.log(`[ws] Client connected: session=${sessionId} userId=${userId}`);
  sendTo(ws, { type: 'connected', sessionId });

  ws.on('message', (raw) => {
    let data: any;
    try { data = JSON.parse(raw.toString()); } catch {
      sendTo(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    handleMessage(ws, sessionId, data);
  });

  ws.on('close', () => cleanupSessionClient(sessionId, ws));
  ws.on('error', () => cleanupSessionClient(sessionId, ws));
}

function handleMessage(ws: WebSocket, sessionId: string, data: any): void {
  switch (data.type) {
    case 'chat':
      handleChatMessage(sessionId, data);
      break;
    case 'permission_response':
      handlePermissionResponse(sessionId, data);
      break;
    default:
      sendTo(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
  }
}

// ---- Chat message handling ----

async function handleChatMessage(
  sessionId: string,
  data: { messageId?: string; content?: string; prompt?: string; agentId?: string; trustMode?: boolean; mentions?: { agentId: string; subPrompt: string; messageId: string }[] },
): Promise<void> {
  const prompt = data.content || data.prompt;
  if (!prompt) {
    broadcast(sessionId, { type: 'stream_error', error: 'Missing content or prompt' });
    return;
  }

  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }

  // / 指令透明透传：跳过 mention 解析和 system prompt，原样转发给 Claude Code
  const isSlashCommand = prompt.startsWith('/');

  // Normalize mentions: if explicit mentions provided, use them; otherwise single agent
  const mentions: { agentId: string; subPrompt: string; messageId: string }[] =
    isSlashCommand
      ? [{ agentId: '', subPrompt: prompt, messageId: data.messageId || generateId() }]
      : (data.mentions && data.mentions.length > 0)
        ? data.mentions
        : [{ agentId: '', subPrompt: prompt, messageId: data.messageId || generateId() }];

  const PER_SESSION_MAX = 3;

  for (const mention of mentions) {
    // Global concurrency check
    if (runningAgentCount >= config.agent.maxConcurrent) {
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: mention.messageId,
        error: `Max concurrent agents reached (${config.agent.maxConcurrent}). Please wait.`,
      });
      continue;
    }

    // Per-session concurrency check
    const sessionAgents = agentStates.get(sessionId);
    if (sessionAgents && sessionAgents.size >= PER_SESSION_MAX) {
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: mention.messageId,
        error: `Max ${PER_SESSION_MAX} agents per session. Wait for one to finish.`,
      });
      continue;
    }

    // Set message status to streaming
    try {
      await prisma.message.update({
        where: { id: mention.messageId },
        data: { status: 'streaming', content: '' },
      });
    } catch {
      try {
        await prisma.message.create({
          data: { id: mention.messageId, sessionId, senderType: 'agent', agentId: mention.agentId || null, content: '', status: 'streaming' },
        });
      } catch {
        broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Failed to create message' });
        continue;
      }
    }

    // Build agent-specific prompt
    let agentPrompt = mention.subPrompt;
    const history = await buildHistory(sessionId);
    if (isSlashCommand) {
      // / 指令透明透传：不注入 system prompt，原样转发
      // Claude Code 自行识别和执行 /commands
    } else if (mention.agentId) {
      const agent = await prisma.agent.findUnique({ where: { id: mention.agentId } });
      if (agent) {
        agentPrompt = `${agent.systemPrompt}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
      }
    } else {
      agentPrompt = history ? `${history}\n\n---\nUser: ${mention.subPrompt}` : mention.subPrompt;
    }

    let accumulatedContent = '';
    const agent = new ClaudeCodeProcess();

    agent.onEvent((event) => {
      switch (event.type) {
        case 'text':
          accumulatedContent += event.content;
          broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId: mention.messageId });
          break;
        case 'tool_use':
          broadcast(sessionId, { type: 'agent_status', status: 'tool_use', details: { toolName: event.toolName, input: event.input }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'tool_result':
          broadcast(sessionId, { type: 'agent_status', status: 'tool_result', details: { content: typeof event.content === 'string' ? event.content.slice(0, 200) : '' }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_start':
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_start', details: { agentType: event.agentType, description: event.description }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_result':
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_result', details: { agentType: event.agentType }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'done': {
          console.log(`[ws] Agent done: session=${sessionId} agentMsg=${mention.messageId} exitCode=${event.exitCode}`);
          prisma.message.update({
            where: { id: mention.messageId },
            data: { content: accumulatedContent, status: event.exitCode === 0 ? 'done' : 'error' },
          }).catch(() => {});
          broadcast(sessionId, { type: 'stream_end', agentMessageId: mention.messageId, fullContent: accumulatedContent, exitCode: event.exitCode });

          const stateMap = agentStates.get(sessionId);
          if (stateMap) {
            const st = stateMap.get(mention.messageId);
            if (st) {
              clearTimeout(st.timer);
              stateMap.delete(mention.messageId);
              runningAgentCount = Math.max(0, runningAgentCount - 1);
            }
            if (stateMap.size === 0) agentStates.delete(sessionId);
          }
          break;
        }
        case 'error':
          broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: event.message });
          break;
      }
    });

    // Timeout per agent
    const timer = setTimeout(() => {
      console.log(`[ws] Agent timeout: session=${sessionId} agentMsg=${mention.messageId}`);
      agent.kill();
      broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Agent execution timed out' });
      const stateMap = agentStates.get(sessionId);
      if (stateMap) {
        const st = stateMap.get(mention.messageId);
        if (st) { clearTimeout(st.timer); stateMap.delete(mention.messageId); runningAgentCount = Math.max(0, runningAgentCount - 1); }
        if (stateMap.size === 0) agentStates.delete(sessionId);
      }
    }, config.agent.timeoutMs);

    // Store agent state
    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(mention.messageId, { process: agent, timer, agentId: mention.agentId });
    runningAgentCount++;

    // Start agent (fire and forget)
    try {
      console.log(`[ws] Starting agent: session=${sessionId} agentMsg=${mention.messageId} prompt="${agentPrompt.slice(0, 80)}..."`);
      agent.start(sessionId, agentPrompt, sandbox.containerId, sandbox.workDir, data.trustMode ?? true, sandbox.hostWorkDir, mention.messageId).catch((err) => {
        console.error(`[ws] Agent start failed: session=${sessionId} agentMsg=${mention.messageId} error=${err.message}`);
        broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Failed to start agent: ${err.message}` });
      });
    } catch (err: any) {
      console.error(`[ws] Agent spawn error: ${err.message}`);
    }
  }
}

function handlePermissionResponse(
  sessionId: string,
  data: { permissionId: string; allowed: boolean; message?: string },
): void {
  const stateMap = agentStates.get(sessionId);
  if (!stateMap || stateMap.size === 0) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active agent process' });
    return;
  }
  // Permission proxy with per-agent routing deferred to Phase 3.
  // In multi-agent mode, we cannot reliably determine which agent requested
  // the permission, so reject rather than delivering stdin to the wrong agent.
  if (stateMap.size > 1) {
    broadcast(sessionId, { type: 'stream_error', error: 'Permission response not supported in multi-agent mode. Use trust mode or wait for Phase 3.' });
    return;
  }
  for (const [, st] of stateMap) {
    st.process.write(data.allowed ? 'y\n' : 'n\n');
    break;
  }
}

// ---- Attach to HTTP server ----

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: WebSocket, request) => handleConnection(ws, request));
  console.log('[ws] WebSocket server attached on /ws');
}

export function handleWebSocket(ws: WebSocket, request: any): void {
  handleConnection(ws, request);
}
