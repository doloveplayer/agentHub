import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { ClaudeCodeProcess, buildSafeEnv } from '../agent/ClaudeCodeProcess.js';
import { ClaudeCodeProvider } from '../agent/providers/claude-code.js';
import { SandboxManager } from '../agent/SandboxManager.js';
import { stateTracker } from '../agent/StateTracker.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { ProviderFactory } from '../agent/providers/factory.js';
import type { AbstractProvider } from '../agent/providers/base.js';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { config } from '../config.js';

// ---- State ----

/** sessionId → set of connected WebSockets */
const sessions = new Map<string, Set<WebSocket>>();

/** sessionId → active agent info (process + timer) */
const agentStates = new Map<string, Map<string, { process: ClaudeCodeProcess; timer: NodeJS.Timeout; agentId: string }>>();

/** sessionId → Map<agentName → REPL process info> for persistent sessions */
const agentProcesses = new Map<string, Map<string, { provider: AbstractProvider; timer: NodeJS.Timeout; agentId: string }>>();

/** sessionId → sandbox info (lazy-created per session) */
const sandboxes = new Map<string, { containerId: string; workDir: string; hostWorkDir: string }>();

/** Count of currently executing agents across all sessions */
let runningAgentCount = 0;

/** Reference to TaskQueueManager (set by index.ts on startup) */
let taskQueueManager: any = null;
export function setTaskQueueManager(tqm: any): void { taskQueueManager = tqm; }

/** permissionId → timeout timer for auto-deny on user inaction */
const permissionTimeouts = new Map<string, NodeJS.Timeout>();
const PERMISSION_TIMEOUT_MS = 120_000;

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

export function broadcast(sessionId: string, data: unknown): void {
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
  // Kill all REPL processes for this session
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    for (const [, info] of procMap) { clearTimeout(info.timer); info.provider.stop(); }
    agentProcesses.delete(sessionId);
  }

  // Kill all agents for this session
  const stateMap = agentStates.get(sessionId);
  if (stateMap) {
    // Clean up permission timeouts for agents in this session
    for (const [pid, timeout] of permissionTimeouts) {
      const agentMsgId = pid.split('|::|')[0];
      if (stateMap.has(agentMsgId)) { clearTimeout(timeout); permissionTimeouts.delete(pid); }
    }
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
    case 'stop_agent':
      handleStopAgent(sessionId, data);
      break;
    case 'confirm_plan':
      handleConfirmPlan(sessionId, data);
      break;
    case 'modify_task':
      handleModifyTask(sessionId, data);
      break;
    case 'retry_task':
      handleRetryTask(sessionId, data);
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
    let isPlannerAgent = false;
    const history = await buildHistory(sessionId);
    if (isSlashCommand) {
      // / 指令透明透传：不注入 system prompt，原样转发
      // Claude Code 自行识别和执行 /commands
    } else if (mention.agentId) {
      const agent = await prisma.agent.findUnique({ where: { id: mention.agentId } });
      if (agent) {
        agentPrompt = `${agent.systemPrompt}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
        isPlannerAgent = agent.name === 'planner';
        // Lazy-init agent directory on first use (not at session creation)
        if (sandbox) {
          AgentDirectoryManager.initialize(sandbox.hostWorkDir, agent.name, agent.systemPrompt);
        }
      }
    } else {
      // No agent @mentioned: route to Planner as group admin / default responder
      const planner = await prisma.agent.findUnique({ where: { name: 'planner' } });
      if (planner) {
        agentPrompt = `${planner.systemPrompt}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
        isPlannerAgent = true;
        mention.agentId = planner.id; // link message to Planner for AgentCard association
        // Update DB so the message shows Planner as sender
        prisma.message.update({ where: { id: mention.messageId }, data: { agentId: planner.id } }).catch(() => {});
        if (sandbox) {
          AgentDirectoryManager.initialize(sandbox.hostWorkDir, planner.name, planner.systemPrompt);
        }
      } else {
        agentPrompt = history ? `${history}\n\n---\nUser: ${mention.subPrompt}` : mention.subPrompt;
      }
    }

    let accumulatedContent = '';
    let inJsonBlock = false;
    // REPL process reuse: check if agent already has a running provider.
    const agentNameForProc = mention.agentId
      ? (await prisma.agent.findUnique({ where: { id: mention.agentId }, select: { name: true } }))?.name
      : null;
    const existingProc = agentNameForProc
      ? agentProcesses.get(sessionId)?.get(agentNameForProc)
      : null;
    if (existingProc && existingProc.provider.isAlive()) {
      console.log(`[ws] Reusing REPL process for agent=${agentNameForProc}`);
      // Problem 4 fix: only send user message, REPL already has system prompt + history in context
      existingProc.provider.sendPrompt(mention.subPrompt);
      clearTimeout(existingProc.timer);
      const agentName = agentNameForProc!;
      existingProc.timer = setTimeout(() => {
        existingProc.provider.stop();
        agentProcesses.get(sessionId)?.delete(agentName);
      }, config.agent.timeoutMs);
      // Create placeholder in agentStates so stop_agent can find it.
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      const procRef = new ClaudeCodeProcess();
      agentStates.get(sessionId)!.set(mention.messageId, {
        process: procRef, timer: existingProc.timer, agentId: mention.agentId,
      });
      return; // Reused existing process, no need to spawn a new one
    }

    // Problem 3 fix: wire up REPL provider for named agents.
    // Fall back to one-shot ClaudeCodeProcess only when no agent name is available.
    if (agentNameForProc) {
      const agentName = agentNameForProc;
      const provider = ProviderFactory.create('claude-code') as ClaudeCodeProvider;

      // Build safe env for provider
      const safeEnv = buildSafeEnv();

      provider.onEvent((ev) => {
        switch (ev.type) {
          case 'thinking': {
            accumulatedContent += (ev.content || '');
            broadcast(sessionId, { type: 'stream_chunk', content: ev.content || '', agentMessageId: mention.messageId });
            broadcast(sessionId, { type: 'agent_status', status: 'thinking',
              details: { content: (ev.content || '').slice(0, 120) },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            break;
          }
          case 'tool_use': {
            const inputStr = JSON.stringify(ev.toolInput ?? {});
            stateTracker.updateTool(mention.messageId, ev.toolName || 'unknown', ev.toolInput || {});
            broadcast(sessionId, { type: 'agent_status', status: 'tool_use',
              details: { toolName: ev.toolName, input: ev.toolInput, inputPreview: inputStr.slice(0, 80) },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            break;
          }
          case 'tool_result': {
            const resultStr = typeof ev.content === 'string' ? ev.content : '';
            broadcast(sessionId, { type: 'agent_status', status: 'tool_result',
              details: { content: resultStr.slice(0, 200), resultPreview: resultStr.slice(0, 80) },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            break;
          }
          case 'subagent_start':
            stateTracker.addSubagent(mention.messageId, ev.toolName || 'unknown', ev.content || '');
            broadcast(sessionId, { type: 'agent_status', status: 'subagent_start',
              details: { agentType: ev.toolName, description: ev.content },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            break;
          case 'subagent_result':
            broadcast(sessionId, { type: 'agent_status', status: 'subagent_result',
              details: { agentType: ev.toolName },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            break;
          case 'permission_request': {
            const pid = `${mention.messageId}|::|${ev.toolName || 'unknown'}|::|${Date.now()}`;
            broadcast(sessionId, {
              type: 'permission_request', permissionId: pid,
              tool: ev.toolName || '', path: ev.filePath,
              agentMessageId: mention.messageId, timestamp: Date.now(),
            });
            broadcast(sessionId, { type: 'agent_status', status: 'permission_request',
              details: { tool: ev.toolName, path: ev.filePath, permissionId: pid },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            const timeout = setTimeout(() => {
              console.log(`[ws] Permission timeout: ${pid}`);
              permissionTimeouts.delete(pid);
              const stMap = agentStates.get(sessionId);
              if (stMap) {
                const st = stMap.get(mention.messageId);
                if (st) st.process.write('n\n');
              }
            }, PERMISSION_TIMEOUT_MS);
            permissionTimeouts.set(pid, timeout);
            break;
          }
          case 'done': {
            console.log(`[ws] Agent done (REPL): session=${sessionId} agentMsg=${mention.messageId} exitCode=${ev.exitCode}`);
            const finalContent = accumulatedContent || (ev.exitCode !== 0 ? '[Agent stopped]' : '[Agent finished]');
            prisma.message.update({
              where: { id: mention.messageId },
              data: { content: finalContent, status: ev.exitCode === 0 ? 'done' : 'error' },
            }).catch(() => {});
            stateTracker.setDone(mention.messageId);
            broadcast(sessionId, { type: 'stream_end', agentMessageId: mention.messageId,
              fullContent: finalContent, exitCode: ev.exitCode ?? 0 });
            const stateMap = agentStates.get(sessionId);
            if (stateMap) {
              const st = stateMap.get(mention.messageId);
              if (st) { clearTimeout(st.timer); stateMap.delete(mention.messageId); runningAgentCount = Math.max(0, runningAgentCount - 1); }
              if (stateMap.size === 0) agentStates.delete(sessionId);
            }
            break;
          }
          case 'error':
            broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: ev.message || 'Unknown error' });
            stateTracker.setError(mention.messageId);
            break;
        }
      });

      // Register provider for future reuse
      if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
      const timer = setTimeout(() => {
        provider.stop();
        agentProcesses.get(sessionId)?.delete(agentName);
      }, config.agent.timeoutMs);
      agentProcesses.get(sessionId)!.set(agentName, { provider, timer, agentId: mention.agentId });

      // Register in agentStates for stop_agent support
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      const procRef = new ClaudeCodeProcess();
      agentStates.get(sessionId)!.set(mention.messageId, { process: procRef, timer, agentId: mention.agentId });
      runningAgentCount++;

      // Start REPL provider (fire and forget)
      console.log(`[ws] Starting REPL provider: session=${sessionId} agent=${agentName} msg=${mention.messageId}`);
      provider.start(sessionId, agentPrompt, sandbox.containerId, sandbox.workDir, {
        agentName,
        hostWorkDir: sandbox.hostWorkDir,
        env: safeEnv,
      }).catch((err) => {
        console.error(`[ws] Provider start failed: session=${sessionId} agent=${agentName} error=${err.message}`);
        broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Failed to start agent: ${err.message}` });
      });
      return; // REPL path complete, skip one-shot spawn below
    }

    // Fallback: one-shot ClaudeCodeProcess (no named agent, legacy path)
    const stSnap = stateTracker.getOrCreate(mention.messageId, mention.agentId || 'agent');
    const agent = new ClaudeCodeProcess();

    agent.onEvent((event) => {
      switch (event.type) {
        case 'text': {
          accumulatedContent += event.content;
          // For Planner agent, strip JSON code blocks from chat output
          // so users see conversational text only, not raw JSON
          let chatContent = event.content;
          if (isPlannerAgent) {
            if (inJsonBlock) {
              // Inside JSON block — check for closing fence
              const endIdx = chatContent.indexOf('```');
              if (endIdx !== -1) {
                inJsonBlock = false;
                // Send only content after the closing ```
                chatContent = chatContent.slice(endIdx + 3);
              } else {
                break; // still inside JSON block, skip entirely
              }
            } else {
              // Outside JSON block — check for opening ```json fence
              const jsonStart = chatContent.indexOf('```json');
              if (jsonStart !== -1) {
                inJsonBlock = true;
                // Send only content before the opening fence
                chatContent = chatContent.slice(0, jsonStart);
              }
            }
          }
          if (chatContent) {
            broadcast(sessionId, { type: 'stream_chunk', content: chatContent, agentMessageId: mention.messageId });
          }
          // Also send as agent_status(thinking) for Agent Card activity feed
          broadcast(sessionId, { type: 'agent_status', status: 'thinking',
            details: { content: event.content.slice(0, 120) },
            agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        }
        case 'tool_use': {
          const inputStr = JSON.stringify(event.input ?? {});
          stateTracker.updateTool(mention.messageId, event.toolName, event.input || {});
          broadcast(sessionId, { type: 'agent_status', status: 'tool_use',
            details: { toolName: event.toolName, input: event.input, inputPreview: inputStr.slice(0, 80) },
            agentMessageId: mention.messageId, timestamp: Date.now() });
          // REPL mode (trustMode=false): intercept Write/Edit/Bash as permission requests.
          // Claude Code REPL waits for y/n stdin response after these tool_use events.
          const needsPermission = ['Write', 'Edit', 'Bash'].includes(event.toolName);
          if (!data.trustMode && needsPermission) {
            const pid = `${mention.messageId}|::|${event.toolName}|::|${Date.now()}`;
            broadcast(sessionId, {
              type: 'permission_request',
              permissionId: pid,
              tool: event.toolName,
              path: (event.input as any)?.file_path || (event.input as any)?.command?.slice(0, 80),
              agentMessageId: mention.messageId,
              timestamp: Date.now(),
            });
            broadcast(sessionId, { type: 'agent_status', status: 'permission_request',
              details: { tool: event.toolName, path: (event.input as any)?.file_path, permissionId: pid },
              agentMessageId: mention.messageId, timestamp: Date.now() });
            const timeout = setTimeout(() => {
              console.log(`[ws] Permission auto-deny timeout: ${pid}`);
              permissionTimeouts.delete(pid);
              const stMap = agentStates.get(sessionId);
              if (stMap) {
                const st = stMap.get(mention.messageId);
                if (st) st.process.write('n\n');
              }
            }, PERMISSION_TIMEOUT_MS);
            permissionTimeouts.set(pid, timeout);
          }
          break;
        }
        case 'tool_result': {
          const resultStr = typeof event.content === 'string' ? event.content : '';
          broadcast(sessionId, { type: 'agent_status', status: 'tool_result',
            details: { content: resultStr.slice(0, 200), resultPreview: resultStr.slice(0, 80) },
            agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        }
        case 'subagent_start':
          stateTracker.addSubagent(mention.messageId, event.agentType, event.description);
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_start',
            details: { agentType: event.agentType, description: event.description },
            agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_result':
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_result',
            details: { agentType: event.agentType },
            agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'permission_request': {
          const pid = `${mention.messageId}|::|${event.tool}|::|${Date.now()}`;
          broadcast(sessionId, {
            type: 'permission_request',
            permissionId: pid,
            tool: event.tool,
            path: event.path,
            agentMessageId: mention.messageId,
            timestamp: Date.now(),
          });
          broadcast(sessionId, { type: 'agent_status', status: 'permission_request',
            details: { tool: event.tool, path: event.path, permissionId: pid },
            agentMessageId: mention.messageId, timestamp: Date.now() });
          // Auto-deny after timeout if user doesn't respond
          const timeout = setTimeout(() => {
            console.log(`[ws] Permission timeout: ${pid}`);
            permissionTimeouts.delete(pid);
            const stMap = agentStates.get(sessionId);
            if (stMap) {
              const st = stMap.get(mention.messageId);
              if (st) st.process.write('n\n');
            }
          }, PERMISSION_TIMEOUT_MS);
          permissionTimeouts.set(pid, timeout);
          break;
        }
        case 'done': {
          stateTracker.setDone(mention.messageId);
          console.log(`[ws] Agent done: session=${sessionId} agentMsg=${mention.messageId} exitCode=${event.exitCode}`);
          // If Planner agent, try to extract TaskPlan JSON and broadcast plan_result
          if (isPlannerAgent && event.exitCode === 0 && accumulatedContent) {
            try {
              const jsonMatch = accumulatedContent.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
              if (jsonMatch) {
                const plan = JSON.parse(jsonMatch[0]);
                if (plan.tasks && plan.tasks.length > 0) {
                  const planId = `plan-${Date.now()}`;
                  // Normalize task fields
                  const tasks = plan.tasks.map((t: any, i: number) => ({
                    taskId: t.id || `task-${i + 1}`,
                    planId,
                    title: t.title || `Task ${i + 1}`,
                    agentType: t.agentType || 'CodeAgent',
                    status: 'waiting' as const,
                    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
                    expectedOutput: t.expectedOutput || '',
                    priority: t.priority || 'medium',
                    description: t.description || '',
                  }));
                  broadcast(sessionId, {
                    type: 'plan_result',
                    planId,
                    planTitle: plan.planTitle || 'Task Plan',
                    summary: plan.summary || '',
                    tasks,
                    agentMessageId: mention.messageId,
                  });
                  console.log(`[ws] Planner plan_result broadcast: planId=${planId} tasks=${tasks.length}`);
                }
              }
            } catch (err: any) {
              console.error(`[ws] Failed to parse Planner JSON: ${err.message}`);
            }
          }
          // Replace empty content with a placeholder so message bubble isn't blank
          const finalContent = accumulatedContent || (event.exitCode !== 0 ? '[Agent stopped]' : '[Agent finished]');
          prisma.message.update({
            where: { id: mention.messageId },
            data: { content: finalContent, status: event.exitCode === 0 ? 'done' : 'error' },
          }).catch(() => {});
          broadcast(sessionId, { type: 'stream_end', agentMessageId: mention.messageId,
            fullContent: finalContent, exitCode: event.exitCode });

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
          stateTracker.setError(mention.messageId);
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

function handleStopAgent(
  sessionId: string,
  data: { agentMessageId: string },
): void {
  const stateMap = agentStates.get(sessionId);
  if (!stateMap) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active agents in this session' });
    return;
  }
  const st = stateMap.get(data.agentMessageId);
  if (!st) {
    broadcast(sessionId, { type: 'stream_error', error: 'Agent not found' });
    return;
  }
  console.log(`[ws] Stopping agent: session=${sessionId} agentMsg=${data.agentMessageId}`);
  clearTimeout(st.timer);
  st.process.kill();
  stateMap.delete(data.agentMessageId);
  runningAgentCount = Math.max(0, runningAgentCount - 1);
  if (stateMap.size === 0) agentStates.delete(sessionId);

  prisma.message.update({
    where: { id: data.agentMessageId },
    data: { status: 'done' },
  }).catch(() => {});

  broadcast(sessionId, { type: 'stream_end', agentMessageId: data.agentMessageId, exitCode: -1, stopped: true });
}

function handlePermissionResponse(
  sessionId: string,
  data: { permissionId: string; allowed: boolean; message?: string },
): void {
  // Parse agentMessageId from permissionId (format: "agentMessageId|::|tool|::|timestamp")
  const agentMessageId = data.permissionId.split('|::|')[0];
  if (!agentMessageId) {
    broadcast(sessionId, { type: 'stream_error', error: 'Invalid permissionId' });
    return;
  }

  const stateMap = agentStates.get(sessionId);
  if (!stateMap) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active agents for permission response' });
    return;
  }

  const st = stateMap.get(agentMessageId);
  if (!st) {
    broadcast(sessionId, { type: 'stream_error', error: 'Agent not found for permission response' });
    return;
  }

  // Cancel the auto-deny timeout
  const timeout = permissionTimeouts.get(data.permissionId);
  if (timeout) {
    clearTimeout(timeout);
    permissionTimeouts.delete(data.permissionId);
  }

  st.process.write(data.allowed ? 'y\n' : 'n\n');
}

function handleConfirmPlan(
  sessionId: string,
  data: { planId: string; tasks: any[] },
): void {
  if (!taskQueueManager) {
    broadcast(sessionId, { type: 'stream_error', error: 'Task queue not initialized' });
    return;
  }
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }
  // Normalize frontend TaskState (taskId) → TaskNode (id) for TaskQueue
  const tasks = data.tasks.map((t: any) => ({
    id: t.taskId || t.id,
    title: t.title,
    description: t.description || '',
    agentType: t.agentType || 'CodeAgent',
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    expectedOutput: t.expectedOutput || '',
    priority: t.priority || 'medium',
  }));
  taskQueueManager.submitPlan(
    data.planId, sessionId, { planTitle: '', summary: '', tasks },
    sandbox.containerId, sandbox.workDir, sandbox.hostWorkDir,
  ).then(() => {
    broadcast(sessionId, { type: 'plan_executing', planId: data.planId });
  }).catch((err: any) => {
    broadcast(sessionId, { type: 'stream_error', error: `Failed to submit plan: ${err.message}` });
  });
}

function handleModifyTask(
  sessionId: string,
  data: { planId: string; taskId: string; newDescription: string },
): void {
  // Modify task description in the plan before execution
  // Frontend updates local state; backend re-validates
  broadcast(sessionId, {
    type: 'task_modified',
    planId: data.planId,
    taskId: data.taskId,
    newDescription: data.newDescription,
  });
}

function handleRetryTask(
  sessionId: string,
  data: { planId: string; taskId: string; task?: any },
): void {
  if (!taskQueueManager) {
    broadcast(sessionId, { type: 'stream_error', error: 'Task queue not initialized' });
    return;
  }
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) return;

  // Build minimal TaskNode from request data or create a stub for re-enqueue
  const taskNode: any = data.task || {
    id: data.taskId,
    title: data.taskId,
    description: 'Retry failed task',
    agentType: 'CodeAgent',
    dependsOn: [],
    expectedOutput: '',
    priority: 'medium',
  };

  taskQueueManager.retryTask(
    data.planId, sessionId, taskNode,
    sandbox.containerId, sandbox.workDir, sandbox.hostWorkDir,
  ).catch((err: any) => {
    broadcast(sessionId, { type: 'stream_error', error: `Retry failed: ${err.message}` });
  });
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
