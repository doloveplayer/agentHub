import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { ClaudeCodeProcess, buildSafeEnv } from '../agent/ClaudeCodeProcess.js';
import { ClaudeCodeProvider } from '../agent/providers/claude-code.js';
import { InboxManager } from '../agent/InboxManager.js';
import { MilestoneBroadcaster } from '../agent/MilestoneBroadcaster.js';
import { ProviderFactory } from '../agent/providers/factory.js';
import { stateTracker } from '../agent/StateTracker.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { selectDefaultAgent, extractPlannerPlan, toTaskStates } from '../agent/turns.js';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { config } from '../config.js';

import {
  sessions, agentStates, agentProcesses, sandboxes,
  runningAgentCount, incRunningAgentCount, decRunningAgentCount,
  sessionsWithMilestones, sequentialQueues,
  agentTaskQueues, agentCurrentTask, agentCurrentMessage,
  permissionTimeouts, PERMISSION_TIMEOUT_MS, ENABLE_PERSISTENT_REPL,
  taskQueueManager, taskModifications,
  trackFileMod, detectConflicts, clearFileMods,
  generateId, getOrCreateSandbox, broadcast, sendTo,
  cleanupSessionResources, cleanupSessionClient, clearRunningAgent,
  type AgentProcess, type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';

import {
  dispatchTasksToAgents, processNextInQueue, startTaskAgent,
} from './taskDispatcher.js';

export { broadcast, setTaskQueueManager } from './state.js';

// ---- Connection handler ----

async function handleConnection(ws: WebSocket, request: any) {
  const url = new URL(request.url || '/', `http://${request.headers?.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');

  if (!token || !sessionId) {
    sendTo(ws, { type: 'error', message: 'Missing token or sessionId' });
    ws.close(4000, 'Missing token or sessionId');
    return;
  }

  let userId: string;
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch {
    sendTo(ws, { type: 'error', message: 'Invalid token' });
    ws.close(4001, 'Invalid token');
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
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

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId }, select: { id: true, userId: true },
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

  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId)!.add(ws);

  try {
    const sb = await getOrCreateSandbox(sessionId);
    await prisma.session.update({
      where: { id: sessionId }, data: { sandboxContainerId: sb.containerId },
    }).catch(() => {});
    console.log(`[ws] Sandbox ready: session=${sessionId} container=${sb.containerId.slice(0, 12)} hostDir=${sb.hostWorkDir}`);
    if (!sessionsWithMilestones.has(sessionId)) {
      sessionsWithMilestones.add(sessionId);
      MilestoneBroadcaster.on(sessionId, (event) => { broadcast(sessionId, event); });
    }
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
    case 'chat':       handleChatMessage(sessionId, data); break;
    case 'permission_response': handlePermissionResponse(sessionId, data); break;
    case 'stop_agent': handleStopAgent(sessionId, data); break;
    case 'confirm_plan': handleConfirmPlan(sessionId, data); break;
    case 'modify_task': handleModifyTask(sessionId, data); break;
    case 'retry_task': handleRetryTask(sessionId, data); break;
    default: sendTo(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
  }
}

// ---- Helpers ----

async function buildHistory(sessionId: string): Promise<string | null> {
  try {
    const msgs = await prisma.message.findMany({
      where: { sessionId, status: 'done' }, orderBy: { createdAt: 'asc' }, take: 20,
    });
    if (msgs.length <= 1) return null;
    return msgs.map(m => `${m.senderType === 'human' ? 'User' : 'Agent'}: ${m.content}`).join('\n');
  } catch { return null; }
}

async function resolveDefaultAgentForSession(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      type: true,
      agents: { include: { agent: { select: { id: true, name: true, displayName: true, description: true, systemPrompt: true } } } },
    },
  });
  if (!session) return null;
  const allAgents = session.agents.map(sa => sa.agent);
  const sessionAgents = session.agents.map(sa => ({ agentId: sa.agent.id, name: sa.agent.name, displayName: sa.agent.displayName }));
  return selectDefaultAgent(session.type, sessionAgents, allAgents);
}

async function startNextSequential(sessionId: string): Promise<void> {
  const queue = sequentialQueues.get(sessionId);
  if (!queue || queue.length === 0) { sequentialQueues.delete(sessionId); return; }
  const next = queue.shift()!;
  console.log(`[ws] Sequential: starting next agent msg=${next.messageId}`);
  await handleChatMessage(sessionId, { mentions: [next], orchestrationMode: 'sequential' });
}

// ---- Chat message handling ----

async function handleChatMessage(
  sessionId: string,
  data: { messageId?: string; content?: string; prompt?: string; agentId?: string; trustMode?: boolean; orchestrationMode?: 'parallel' | 'sequential' | 'auto'; mentions?: { agentId: string; subPrompt: string; messageId: string }[] },
): Promise<void> {
  const prompt = data.content || data.prompt;
  if (!prompt) { broadcast(sessionId, { type: 'stream_error', error: 'Missing content or prompt' }); return; }

  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' }); return; }

  const isSlashCommand = prompt.startsWith('/');

  const mentions: { agentId: string; subPrompt: string; messageId: string }[] = isSlashCommand
    ? [{ agentId: '', subPrompt: prompt, messageId: data.messageId || generateId() }]
    : (data.mentions && data.mentions.length > 0)
      ? data.mentions
      : [{ agentId: '', subPrompt: prompt, messageId: data.messageId || generateId() }];

  const PER_SESSION_MAX = 3;
  const orchestrationMode = data.orchestrationMode || 'parallel';

  if (orchestrationMode === 'sequential' && mentions.length > 1) {
    sequentialQueues.set(sessionId, mentions.slice(1));
    mentions.splice(1);
    console.log(`[ws] Sequential mode: queued ${sequentialQueues.get(sessionId)!.length} agents after first`);
  }

  for (const mention of mentions) {
    if (runningAgentCount >= config.agent.maxConcurrent) {
      broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Max concurrent agents reached (${config.agent.maxConcurrent}).` });
      continue;
    }

    const sessionAgents = agentStates.get(sessionId);
    if (sessionAgents && sessionAgents.size >= PER_SESSION_MAX) {
      broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Max ${PER_SESSION_MAX} agents per session.` });
      continue;
    }

    try {
      await prisma.message.update({ where: { id: mention.messageId }, data: { status: 'streaming', content: '' } });
    } catch {
      try {
        await prisma.message.create({ data: { id: mention.messageId, sessionId, senderType: 'agent', agentId: mention.agentId || null, content: '', status: 'streaming' } });
      } catch {
        broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Failed to create message' });
        continue;
      }
    }

    let agentPrompt = mention.subPrompt;
    let isPlannerAgent = false;
    const history = await buildHistory(sessionId);
    if (!isSlashCommand && !mention.agentId) {
      const defaultAgent = await resolveDefaultAgentForSession(sessionId);
      if (defaultAgent) {
        mention.agentId = defaultAgent.id;
        prisma.message.update({ where: { id: mention.messageId }, data: { agentId: defaultAgent.id } }).catch(() => {});
      }
    }

    if (isSlashCommand) {
      // / 指令透明透传
    } else if (mention.agentId) {
      const agent = await prisma.agent.findUnique({ where: { id: mention.agentId } });
      if (agent) {
        let sessionMemberBlock = '';
        if (agent.name === 'planner') {
          const members = await prisma.sessionAgent.findMany({
            where: { sessionId },
            include: { agent: { select: { name: true, displayName: true, description: true } } },
          });
          if (members.length > 0) {
            const memberLines = members.map(sa => `- ${sa.agent.displayName} (${sa.agent.name}): ${sa.agent.description}`).join('\n');
            sessionMemberBlock = `\n## 当前群聊成员\n${memberLines}\n\n请根据成员专长分配任务。agentType 仅限以上成员。如需其他类型 Agent，在 plan 的 missingAgents 字段中列出：\n\`\`\`json\n"missingAgents": [{"name": "...", "displayName": "...", "description": "...", "reason": "..."}]\n\`\`\`\n`;
          }
        }
        agentPrompt = `${agent.systemPrompt}${InboxManager.inboxPrompt(agent.name)}${sessionMemberBlock}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
        isPlannerAgent = agent.name === 'planner';
        if (sandbox) AgentDirectoryManager.initialize(sandbox.hostWorkDir, agent.name, agent.systemPrompt);
      }
    } else {
      agentPrompt = history ? `${history}\n\n---\nUser: ${mention.subPrompt}` : mention.subPrompt;
    }

    let accumulatedContent = '';
    let inJsonBlock = false;
    const agentNameForProc = mention.agentId
      ? (await prisma.agent.findUnique({ where: { id: mention.agentId }, select: { name: true } }))?.name
      : null;
    const existingProc = agentNameForProc ? agentProcesses.get(sessionId)?.get(agentNameForProc) : null;

    if (ENABLE_PERSISTENT_REPL && existingProc && existingProc.provider.isAlive()) {
      console.log(`[ws] Reusing REPL process for agent=${agentNameForProc} msg=${mention.messageId}`);
      agentCurrentMessage.set(agentNameForProc!, mention.messageId);
      existingProc.provider.sendPrompt(mention.subPrompt);
      clearTimeout(existingProc.timer);
      const agentName = agentNameForProc!;
      existingProc.timer = setTimeout(() => {
        existingProc.provider.stop();
        agentProcesses.get(sessionId)?.delete(agentName);
        agentCurrentMessage.delete(agentName);
      }, config.agent.timeoutMs);
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(mention.messageId, {
        process: existingProc.provider, timer: existingProc.timer, agentId: mention.agentId, agentName,
      });
      incRunningAgentCount();
      return;
    }

    if (ENABLE_PERSISTENT_REPL && agentNameForProc) {
      const agentName = agentNameForProc;
      const provider = ProviderFactory.create('claude-code') as ClaudeCodeProvider;
      const safeEnv = buildSafeEnv();

      provider.onEvent((ev) => {
        const msgId = agentCurrentMessage.get(agentName) || mention.messageId;
        switch (ev.type) {
          case 'thinking': {
            accumulatedContent += (ev.content || '');
            broadcast(sessionId, { type: 'stream_chunk', content: ev.content || '', agentMessageId: msgId });
            broadcast(sessionId, { type: 'agent_status', status: 'thinking', details: { content: (ev.content || '').slice(0, 120) }, agentMessageId: msgId, timestamp: Date.now() });
            break;
          }
          case 'tool_use': {
            const inputStr = JSON.stringify(ev.toolInput ?? {});
            stateTracker.updateTool(msgId, ev.toolName || 'unknown', ev.toolInput || {});
            const modPath = ev.toolInput?.file_path || ev.toolInput?.path || ev.toolInput?.filePath;
            if (typeof modPath === 'string' && ['Write', 'Edit'].includes(ev.toolName || '')) {
              trackFileMod(sessionId, agentName, modPath);
            }
            broadcast(sessionId, { type: 'agent_status', status: 'tool_use', details: { toolName: ev.toolName, input: ev.toolInput, inputPreview: inputStr.slice(0, 80) }, agentMessageId: msgId, timestamp: Date.now() });
            break;
          }
          case 'tool_result': {
            const resultStr = typeof ev.content === 'string' ? ev.content : '';
            broadcast(sessionId, { type: 'agent_status', status: 'tool_result', details: { content: resultStr.slice(0, 200), resultPreview: resultStr.slice(0, 80) }, agentMessageId: msgId, timestamp: Date.now() });
            break;
          }
          case 'subagent_start':
            stateTracker.addSubagent(msgId, ev.toolName || 'unknown', ev.content || '');
            broadcast(sessionId, { type: 'agent_status', status: 'subagent_start', details: { agentType: ev.toolName, description: ev.content }, agentMessageId: msgId, timestamp: Date.now() });
            break;
          case 'subagent_result':
            broadcast(sessionId, { type: 'agent_status', status: 'subagent_result', details: { agentType: ev.toolName }, agentMessageId: msgId, timestamp: Date.now() });
            break;
          case 'permission_request': {
            const pid = `${msgId}|::|${ev.toolName || 'unknown'}|::|${Date.now()}`;
            broadcast(sessionId, { type: 'permission_request', permissionId: pid, tool: ev.toolName || '', path: ev.filePath, agentMessageId: msgId, timestamp: Date.now() });
            broadcast(sessionId, { type: 'agent_status', status: 'permission_request', details: { tool: ev.toolName, path: ev.filePath, permissionId: pid }, agentMessageId: msgId, timestamp: Date.now() });
            const timeout = setTimeout(() => {
              console.log(`[ws] Permission timeout: ${pid}`);
              permissionTimeouts.delete(pid);
              const stMap = agentStates.get(sessionId);
              if (stMap) { const st = stMap.get(msgId); if (st) st.process.write('n\n'); }
            }, PERMISSION_TIMEOUT_MS);
            permissionTimeouts.set(pid, timeout);
            break;
          }
          case 'done': {
            console.log(`[ws] Agent done (REPL): session=${sessionId} agentMsg=${msgId} exitCode=${ev.exitCode}`);
            const finalContent = accumulatedContent || (ev.exitCode !== 0 ? '[Agent stopped]' : '[Agent finished]');
            prisma.message.update({ where: { id: msgId }, data: { content: finalContent, status: ev.exitCode === 0 ? 'done' : 'error' } }).catch(() => {});
            stateTracker.setDone(msgId);
            if (agentNameForProc) MilestoneBroadcaster.classify({ sessionId, agentName: agentNameForProc, agentMessageId: msgId, eventType: 'done' });
            broadcast(sessionId, { type: 'stream_end', agentMessageId: msgId, fullContent: finalContent, exitCode: ev.exitCode ?? 0 });
            const stateMap = agentStates.get(sessionId);
            if (stateMap) {
              const st = stateMap.get(msgId);
              if (st) { clearTimeout(st.timer); stateMap.delete(msgId); decRunningAgentCount(); }
              if (stateMap.size === 0) agentStates.delete(sessionId);
            }
            accumulatedContent = '';
            const conflicts = detectConflicts(sessionId);
            if (conflicts.length > 0) {
              broadcast(sessionId, { type: 'conflict_detected', conflicts: conflicts.map(c => ({ filePath: c.filePath, agents: c.agents })) });
              console.log(`[ws] Conflict detected: session=${sessionId} files=${conflicts.map(c => c.filePath).join(', ')}`);
            }
            const taskInfo = agentCurrentTask.get(agentName);
            if (taskInfo) {
              broadcast(sessionId, { type: ev.exitCode === 0 ? 'task_completed' : 'task_failed', planId: taskInfo.planId, taskId: taskInfo.taskId, agentName, output: finalContent.slice(0, 200) });
              agentCurrentTask.delete(agentName);
              const queue = agentTaskQueues.get(agentName);
              if (queue) { queue.current = null; processNextInQueue(sessionId, agentName, queue); }
            }
            agentCurrentMessage.delete(agentName);
            startNextSequential(sessionId);
            break;
          }
          case 'error':
            broadcast(sessionId, { type: 'stream_error', agentMessageId: msgId, error: ev.message || 'Unknown error' });
            stateTracker.setError(msgId);
            break;
        }
      });

      if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
      const timer = setTimeout(() => {
        provider.stop();
        agentProcesses.get(sessionId)?.delete(agentName);
      }, config.agent.timeoutMs);
      agentProcesses.get(sessionId)!.set(agentName, { provider, timer, agentId: mention.agentId });
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(mention.messageId, { process: provider, timer, agentId: mention.agentId, agentName });
      agentCurrentMessage.set(agentName, mention.messageId);
      incRunningAgentCount();

      console.log(`[ws] Starting REPL provider: session=${sessionId} agent=${agentName} msg=${mention.messageId}`);
      provider.start(sessionId, agentPrompt, sandbox.containerId, sandbox.workDir, { agentName, hostWorkDir: sandbox.hostWorkDir, env: safeEnv })
        .catch((err) => {
          console.error(`[ws] Provider start failed: session=${sessionId} agent=${agentName} error=${err.message}`);
          broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Failed to start agent: ${err.message}` });
        });
      return;
    }

    // Fallback: one-shot ClaudeCodeProcess
    const agent = new ClaudeCodeProcess();
    agent.onEvent((event) => {
      switch (event.type) {
        case 'text': {
          accumulatedContent += event.content;
          let chatContent = event.content;
          if (isPlannerAgent) {
            if (inJsonBlock) {
              const endIdx = chatContent.indexOf('```');
              if (endIdx !== -1) { inJsonBlock = false; chatContent = chatContent.slice(endIdx + 3); }
              else break;
            } else {
              const jsonStart = chatContent.indexOf('```json');
              if (jsonStart !== -1) { inJsonBlock = true; chatContent = chatContent.slice(0, jsonStart); }
            }
          }
          if (chatContent) broadcast(sessionId, { type: 'stream_chunk', content: chatContent, agentMessageId: mention.messageId });
          broadcast(sessionId, { type: 'agent_status', status: 'thinking', details: { content: event.content.slice(0, 120) }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        }
        case 'tool_use':
          stateTracker.updateTool(mention.messageId, event.toolName, event.input || {});
          broadcast(sessionId, { type: 'agent_status', status: 'tool_use', details: { toolName: event.toolName, input: event.input, inputPreview: JSON.stringify(event.input ?? {}).slice(0, 80) }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'tool_result':
          broadcast(sessionId, { type: 'agent_status', status: 'tool_result', details: { content: typeof event.content === 'string' ? event.content.slice(0, 200) : '', resultPreview: typeof event.content === 'string' ? event.content.slice(0, 80) : '' }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_start':
          stateTracker.addSubagent(mention.messageId, event.agentType, event.description);
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_start', details: { agentType: event.agentType, description: event.description }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_result':
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_result', details: { agentType: event.agentType }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'permission_request': {
          const pid = `${mention.messageId}|::|${event.tool}|::|${Date.now()}`;
          broadcast(sessionId, { type: 'permission_request', permissionId: pid, tool: event.tool, path: event.path, agentMessageId: mention.messageId, timestamp: Date.now() });
          broadcast(sessionId, { type: 'agent_status', status: 'permission_request', details: { tool: event.tool, path: event.path, permissionId: pid }, agentMessageId: mention.messageId, timestamp: Date.now() });
          const timeout = setTimeout(() => {
            permissionTimeouts.delete(pid);
            const stMap = agentStates.get(sessionId);
            if (stMap) { const st = stMap.get(mention.messageId); if (st) st.process.write('n\n'); }
          }, PERMISSION_TIMEOUT_MS);
          permissionTimeouts.set(pid, timeout);
          break;
        }
        case 'system':
          stateTracker.updateTokenUsage(mention.messageId, { input: (event as any).inputTokens || 0, output: (event as any).outputTokens || 0, cacheRead: 0, cacheCreate: 0 });
          broadcast(sessionId, { type: 'agent_status', status: 'token_update', details: { tokenUsage: { input: (event as any).inputTokens || 0, output: (event as any).outputTokens || 0 } }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'done': {
          stateTracker.setDone(mention.messageId);
          if (agentNameForProc) MilestoneBroadcaster.classify({ sessionId, agentName: agentNameForProc, agentMessageId: mention.messageId, eventType: 'done' });
          console.log(`[ws] Agent done: session=${sessionId} agentMsg=${mention.messageId} exitCode=${event.exitCode}`);
          if (isPlannerAgent && event.exitCode === 0 && accumulatedContent) {
            const plan = extractPlannerPlan(accumulatedContent);
            if (plan) {
              const planId = `plan-${Date.now()}`;
              broadcast(sessionId, { type: 'plan_result', planId, planTitle: plan.planTitle, summary: plan.summary, tasks: toTaskStates(plan, planId), agentMessageId: mention.messageId });
              console.log(`[ws] Planner plan_result broadcast: planId=${planId} tasks=${plan.tasks.length}`);
            }
          }
          const finalContent = accumulatedContent || (event.exitCode !== 0 ? '[Agent stopped]' : '[Agent finished]');
          prisma.message.update({ where: { id: mention.messageId }, data: { content: finalContent, status: event.exitCode === 0 ? 'done' : 'error' } }).catch(() => {});
          broadcast(sessionId, { type: 'stream_end', agentMessageId: mention.messageId, fullContent: finalContent, exitCode: event.exitCode });
          const stateMap = agentStates.get(sessionId);
          if (stateMap) {
            const st = stateMap.get(mention.messageId);
            if (st) { clearTimeout(st.timer); stateMap.delete(mention.messageId); decRunningAgentCount(); }
            if (stateMap.size === 0) agentStates.delete(sessionId);
          }
          startNextSequential(sessionId);
          break;
        }
        case 'error':
          stateTracker.setError(mention.messageId);
          prisma.message.update({ where: { id: mention.messageId }, data: { status: 'error' } }).catch(() => {});
          broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: event.message });
          clearRunningAgent(sessionId, mention.messageId);
          break;
      }
    });

    const timer = setTimeout(() => {
      console.log(`[ws] Agent timeout: session=${sessionId} agentMsg=${mention.messageId}`);
      agent.kill();
      broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Agent execution timed out' });
      const stateMap = agentStates.get(sessionId);
      if (stateMap) {
        const st = stateMap.get(mention.messageId);
        if (st) { clearTimeout(st.timer); stateMap.delete(mention.messageId); decRunningAgentCount(); }
        if (stateMap.size === 0) agentStates.delete(sessionId);
      }
    }, config.agent.timeoutMs);

    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(mention.messageId, { process: agent, timer, agentId: mention.agentId });
    incRunningAgentCount();

    try {
      console.log(`[ws] Starting agent: session=${sessionId} agentMsg=${mention.messageId} prompt="${agentPrompt.slice(0, 80)}..."`);
      agent.start(sessionId, agentPrompt, sandbox.containerId, sandbox.workDir, data.trustMode ?? true, sandbox.hostWorkDir, mention.messageId)
        .catch((err) => {
          console.error(`[ws] Agent start failed: session=${sessionId} agentMsg=${mention.messageId} error=${err.message}`);
          broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Failed to start agent: ${err.message}` });
          prisma.message.update({ where: { id: mention.messageId }, data: { status: 'error' } }).catch(() => {});
          clearRunningAgent(sessionId, mention.messageId);
        });
    } catch (err: any) {
      console.error(`[ws] Agent spawn error: ${err.message}`);
      clearRunningAgent(sessionId, mention.messageId);
    }
  }
}

// ---- Agent control ----

function handleStopAgent(sessionId: string, data: { agentMessageId: string }): void {
  const stateMap = agentStates.get(sessionId);
  if (!stateMap) { broadcast(sessionId, { type: 'stream_error', error: 'No active agents in this session' }); return; }
  const st = stateMap.get(data.agentMessageId);
  if (!st) { broadcast(sessionId, { type: 'stream_error', error: 'Agent not found' }); return; }
  console.log(`[ws] Stopping agent: session=${sessionId} agentMsg=${data.agentMessageId}`);
  clearTimeout(st.timer);
  if (st.process.kill) st.process.kill(); else if (st.process.stop) st.process.stop();
  if (st.agentName) { agentCurrentMessage.delete(st.agentName); agentProcesses.get(sessionId)?.delete(st.agentName); }
  stateMap.delete(data.agentMessageId);
  decRunningAgentCount();
  if (stateMap.size === 0) agentStates.delete(sessionId);
  prisma.message.update({ where: { id: data.agentMessageId }, data: { status: 'done' } }).catch(() => {});
  broadcast(sessionId, { type: 'stream_end', agentMessageId: data.agentMessageId, exitCode: -1, stopped: true });
}

function handlePermissionResponse(sessionId: string, data: { permissionId: string; allowed: boolean; message?: string }): void {
  const agentMessageId = data.permissionId.split('|::|')[0];
  if (!agentMessageId) { broadcast(sessionId, { type: 'stream_error', error: 'Invalid permissionId' }); return; }
  const stateMap = agentStates.get(sessionId);
  if (!stateMap) { broadcast(sessionId, { type: 'stream_error', error: 'No active agents for permission response' }); return; }
  const st = stateMap.get(agentMessageId);
  if (!st) { broadcast(sessionId, { type: 'stream_error', error: 'Agent not found for permission response' }); return; }
  const timeout = permissionTimeouts.get(data.permissionId);
  if (timeout) { clearTimeout(timeout); permissionTimeouts.delete(data.permissionId); }
  st.process.write(data.allowed ? 'y\n' : 'n\n');
}

// ---- Plan handling ----

function applyTaskModifications(tasks: any[]): any[] {
  return tasks.map(t => {
    const key = `${t.planId}:${t.taskId || t.id}`;
    const modified = taskModifications.get(key);
    if (modified) { taskModifications.delete(key); }
    return modified ? { ...t, description: modified } : t;
  });
}

async function handleConfirmPlan(sessionId: string, data: { planId: string; tasks: any[] }): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' }); return; }
  const normalized = applyTaskModifications(data.tasks.map((t: any) => ({ ...t, planId: data.planId })));
  const tasks: TaskDispatchNode[] = normalized.map((t: any) => ({
    id: t.taskId || t.id, title: t.title, description: t.description || '',
    agentType: t.agentType || 'CodeAgent', dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    expectedOutput: t.expectedOutput || '', priority: t.priority || 'medium',
  }));

  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true } } },
  });
  for (const sa of sessionAgents) {
    AgentDirectoryManager.initialize(sandbox.hostWorkDir, sa.agent.name, sa.agent.systemPrompt);
  }

  dispatchTasksToAgents(sessionId, data.planId, tasks, {
    containerId: sandbox.containerId, workDir: sandbox.workDir, hostWorkDir: sandbox.hostWorkDir,
  }).then(() => {
    broadcast(sessionId, { type: 'plan_executing', planId: data.planId });
  }).catch((err: any) => {
    broadcast(sessionId, { type: 'stream_error', error: `Failed to dispatch tasks: ${err.message}` });
  });
}

function handleModifyTask(sessionId: string, data: { planId: string; taskId: string; newDescription: string }): void {
  taskModifications.set(`${data.planId}:${data.taskId}`, data.newDescription);
  broadcast(sessionId, { type: 'task_modified', planId: data.planId, taskId: data.taskId, newDescription: data.newDescription });
}

async function handleRetryTask(sessionId: string, data: { planId: string; taskId: string; task?: any }): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) return;

  const taskNode: any = data.task;
  if (!taskNode) {
    broadcast(sessionId, { type: 'stream_error', error: 'Retry requires full task data. Please re-run the Planner.' });
    return;
  }
  taskNode.id = taskNode.taskId || taskNode.id || data.taskId;

  let agentName: string | undefined;
  if (taskNode.agentType) {
    const agent = await prisma.agent.findFirst({
      where: { displayName: taskNode.agentType }, select: { name: true, systemPrompt: true },
    });
    if (agent) agentName = agent.name;
  }

  if (agentName) {
    const queue = agentTaskQueues.get(agentName);
    const dispatchNode: TaskDispatchNode = {
      id: taskNode.id, title: taskNode.title, description: taskNode.description || '',
      agentType: taskNode.agentType || 'CodeAgent', dependsOn: [],
      expectedOutput: taskNode.expectedOutput || '', priority: (taskNode.priority as 'high' | 'medium' | 'low') || 'medium',
    };
    if (queue) {
      queue.tasks.unshift(dispatchNode);
      if (!queue.current) processNextInQueue(sessionId, agentName, queue);
    } else {
      const newQueue: AgentTaskQueue = { planId: data.planId, sessionId, tasks: [], current: null, sandbox };
      newQueue.tasks.push(dispatchNode);
      agentTaskQueues.set(agentName, newQueue);
      processNextInQueue(sessionId, agentName, newQueue);
    }
  } else {
    broadcast(sessionId, { type: 'stream_error', error: `No agent found for type: ${taskNode.agentType}` });
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
