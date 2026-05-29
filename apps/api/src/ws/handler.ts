import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { ProviderFactory } from '../agent/providers/factory.js';
import type { AbstractProvider } from '../agent/providers/base.js';
import { InboxManager } from '../agent/InboxManager.js';
import { MilestoneBroadcaster } from '../agent/MilestoneBroadcaster.js';
import { stateTracker } from '../agent/StateTracker.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { selectDefaultAgent, toTaskStates } from '../agent/turns.js';
import { getApprovalGate } from '../agent/ApprovalGate.js';
import { extractAndValidate } from '../agent/PlanValidator.js';
import { IntentParser } from '../agent/IntentParser.js';
import { InboxWakeup } from '../agent/InboxWakeup.js';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { config } from '../config.js';
import { isDeployTarget, normalizeTarget, startDeployment } from '../routes/deploy.js';
import { parseReviewReport, parseTestOutput } from '../artifacts/ArtifactTools.js';
import { agentCoordinator } from '../agent/AgentCoordinator.js';
import { permissionProfiles, type AgentCapability } from '../agent/PermissionProfiles.js';
import { detectLanguage, languageConsistencyPrompt } from '../agent/languageDetection.js';
import { agentRuntime } from '../agent/AgentRuntime.js';

import {
  sessions, sessionPermissionModes, agentStates, agentProcesses, sandboxes,
  runningAgentCount, incRunningAgentCount, decRunningAgentCount,
  preActivatingSessions,
  pendingAgentQueue, enqueuePending, dequeuePending,
  perSessionPendingQueues, enqueuePerSession, dequeuePerSession,
  sessionsWithMilestones, sequentialQueues,
  agentTaskQueues, agentCurrentTask, agentCurrentMessage,
  permissionTimeouts, PERMISSION_TIMEOUT_MS,
  taskModifications, agentClaudeSessions,
  trackFileMod, detectConflicts, clearFileMods,
  generateId, getOrCreateSandbox, broadcast, sendTo,
  cleanupSessionResources, cleanupSessionClient, clearRunningAgent,
  type AgentProcess, type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';

import {
  dispatchTasksToAgents,
  processNextInQueue,
  startTaskAgent,
  handleDispatchedTaskFinished,
  prepareDispatchedTaskRetry,
  handleReplanFailedTask,
  resolveAgentNameInSession,
} from './taskDispatcher.js';
import {
  broadcastDiffSummary,
  recordMessageBeforeVersion,
  takeMessageBeforeVersion,
} from './diffBroadcast.js';

export { broadcast } from './state.js';

const agentNameToType = new Map<string, string>();
const sessionTypes = new Map<string, string>(); // sessionId → 'solo' | 'group'

// Shared regex patterns for hidden plan extraction in agent output
const PLAN_STRIP_RE = /<!--AGENTHUB_PLAN\{[\s\S]*?\}-->/g;
const PLAN_EXTRACT_RE = /<!--AGENTHUB_PLAN(\{[\s\S]*?\})-->/;

// ---- Connection handler ----

function buildProfileFromAgent(agent: { name: string; description?: string; capabilities?: unknown }): Partial<AgentCapability> {
  if (agent.capabilities && typeof agent.capabilities === 'object') {
    return agent.capabilities as Partial<AgentCapability>;
  }
  return {};
}

const POLICY_VIOLATION_CLOSE_CODE = 1008;

async function handleConnection(ws: WebSocket, request: any) {
  const url = new URL(request.url || '/', `http://${request.headers?.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');

  if (!token || !sessionId) {
    sendTo(ws, { type: 'error', message: 'Missing token or sessionId' });
    ws.close(POLICY_VIOLATION_CLOSE_CODE, 'Missing token or sessionId');
    return;
  }

  let userId: string;
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch {
    sendTo(ws, { type: 'error', message: 'Invalid token' });
    ws.close(POLICY_VIOLATION_CLOSE_CODE, 'Invalid token');
    return;
  }

  // Register message handler FIRST — before any async DB queries.
  const earlyMessages: { data: any }[] = [];
  let sandboxReady = false;
  let sessionType: string | null = null;
  ws.on('message', (raw) => {
    let data: any;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!sandboxReady) { earlyMessages.push({ data }); return; }
    handleMessage(ws, sessionId, data);
  });
  ws.on('close', () => cleanupSessionClient(sessionId, ws));
  ws.on('error', () => cleanupSessionClient(sessionId, ws));

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
      where: { id: sessionId }, select: { id: true, userId: true, permissionMode: true, type: true },
    });
    if (!session || session.userId !== userId) {
      sendTo(ws, { type: 'error', message: 'Session not found or access denied' });
      ws.close(4003, 'Access denied');
      return;
    }
    sessionPermissionModes.set(sessionId, session.permissionMode || 'ask');
    sessionTypes.set(sessionId, session.type);
    sessionType = session.type;
  } catch {
    sendTo(ws, { type: 'error', message: 'Failed to verify session' });
    ws.close(4000, 'Internal error');
    return;
  }

  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId)!.add(ws);

  try {
    const sb = await getOrCreateSandbox(sessionId, sessionType);
    await prisma.session.update({
      where: { id: sessionId }, data: { sandboxContainerId: sb.containerId },
    }).catch(() => {});
    console.log(`[ws] Sandbox ready: session=${sessionId} container=${sb.containerId.slice(0, 12)} hostDir=${sb.hostWorkDir}`);
    if (!sessionsWithMilestones.has(sessionId)) {
      sessionsWithMilestones.add(sessionId);
      MilestoneBroadcaster.on(sessionId, (event) => { broadcast(sessionId, event); });
    }

    // Group session: pre-activate all agents so they're online and listening.
    // Must await so REPL providers are ready before any chat messages arrive.
    if (sessionType === 'group') {
      preActivatingSessions.add(sessionId);
      try {
        await preActivateGroupAgents(sessionId, sb);
      } finally {
        preActivatingSessions.delete(sessionId);
      }
    }
  } catch (err: any) {
    console.error(`[ws] Sandbox creation failed: session=${sessionId} error=${err.message}`);
    sendTo(ws, { type: 'error', message: `Sandbox creation failed: ${err.message}` });
    ws.close(4000, 'Sandbox failed');
    return;
  }

  console.log(`[ws] Client connected: session=${sessionId} userId=${userId}`);
  sendTo(ws, { type: 'connected', sessionId });

  // Recover in-flight plan executions after backend restart
  try {
    const { DagPersistence } = await import('../agent/DagPersistence.js');
    const plans = await DagPersistence.recover(sessionId);
    for (const plan of plans) {
      broadcast(sessionId, {
        type: 'plan_recovered',
        planId: plan.planId,
        tasks: plan.tasks.map((t) => ({
          taskId: t.id,
          planId: plan.planId,
          title: t.title,
          agentType: t.agentType,
          status: t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : t.status === 'blocked' ? 'blocked' : 'waiting',
          dependsOn: t.dependsOn,
          expectedOutput: t.expectedOutput,
          priority: t.priority,
          assignedAgentName: t.agentName,
          assignedAgentId: t.agentId,
          description: t.description,
        })),
      });
    }
    if (plans.length > 0) {
      console.log(`[ws] Recovered ${plans.length} plan(s) for session=${sessionId.slice(0, 8)}`);
    }
  } catch (err: any) {
    console.log(`[ws] Plan recovery skipped: ${err.message}`);
  }

  // Register agent permission profiles for this session
  try {
    const sessionAgentsForProfiles = await prisma.sessionAgent.findMany({
      where: { sessionId },
      include: { agent: { select: { id: true, name: true, displayName: true, description: true } } },
    });
    for (const sa of sessionAgentsForProfiles) {
      const profile = buildProfileFromAgent(sa.agent);
      permissionProfiles.register(sa.agent.name, profile);
      agentNameToType.set(sa.agent.name, sa.agent.name);
    }
  } catch (err: any) {
    console.log(`[ws] Profile registration skipped: ${err.message}`);
  }

  // Flush early messages that arrived before sandbox was ready
  sandboxReady = true;
  if (earlyMessages.length > 0) {
    console.log(`[ws] Flushing ${earlyMessages.length} early message(s) for session=${sessionId.slice(0,8)}`);
    for (const em of earlyMessages) handleMessage(ws, sessionId, em.data);
    earlyMessages.length = 0;
  }
}

function handleMessage(ws: WebSocket, sessionId: string, data: any): void {
  switch (data.type) {
    case 'chat':       handleChatMessage(sessionId, data); break;
    case 'permission_response': handlePermissionResponse(sessionId, data); break;
    case 'permission_mode_change': handlePermissionModeChange(sessionId, data); break;
    case 'stop_agent': handleStopAgent(sessionId, data); break;
    case 'confirm_plan': handleConfirmPlan(sessionId, data); break;
    case 'deploy_to_platform': handleDeployToPlatform(sessionId, data); break;
    case 'modify_task': handleModifyTask(sessionId, data); break;
    case 'retry_task': handleRetryTask(sessionId, data); break;
    case 'replan_failed_task': handleReplanRequest(sessionId, data); break;
    case 'approval_approve': handleApprovalApprove(sessionId, ws, data); break;
    case 'approval_reject': handleApprovalReject(sessionId, ws, data); break;
    case 'approval_reply': handleApprovalReply(sessionId, ws, data); break;
    default: sendTo(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
  }
}

function handleDeployToPlatform(sessionId: string, data: { target?: string; production?: boolean; confirmPhrase?: string }): void {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' }); return; }
  if (data.target !== undefined && !isDeployTarget(data.target)) {
    broadcast(sessionId, { type: 'deployment_status', deploymentId: `dep-${Date.now()}`, target: String(data.target), status: 'failed', error: 'Invalid deploy target', timestamp: Date.now() });
    return;
  }
  const target = normalizeTarget(data.target);
  if (data.production && data.confirmPhrase !== `DEPLOY ${target.toUpperCase()}`) {
    broadcast(sessionId, { type: 'deployment_status', deploymentId: `dep-${Date.now()}`, target, status: 'failed', error: `Confirmation phrase must be DEPLOY ${target.toUpperCase()}`, timestamp: Date.now() });
    return;
  }
  startDeployment(sessionId, sandbox.hostWorkDir, target);
}

function broadcastStructuredArtifact(sessionId: string, agentName: string, content: string): void {
  if (agentName === 'review-agent') {
    const report = parseReviewReport(content);
    if (report.findings.length > 0) broadcast(sessionId, { type: 'review_report', report, timestamp: Date.now() });
  }
  if (agentName === 'test-agent') {
    const report = parseTestOutput(content);
    if (report.total > 0 || report.cases.length > 0) {
      broadcast(sessionId, { type: 'test_report', report, exitCode: report.failed > 0 ? 1 : 0, timestamp: Date.now() });
    }
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

  // Resolve trust mode from session permission mode.
  // read_only/ask → trustMode=false (require permission for mutating tools)
  // smart/trust → trustMode=true (auto-approve)
  const sessionPermMode = sessionPermissionModes.get(sessionId) || 'ask';
  const trustMode = sessionPermMode === 'smart' || sessionPermMode === 'trust';

  const isSlashCommand = prompt.startsWith('/');

  const mentions: { agentId: string; subPrompt: string; messageId: string }[] = isSlashCommand
    ? [{
        agentId: data.mentions?.[0]?.agentId || '',
        subPrompt: prompt,
        messageId: data.mentions?.[0]?.messageId || data.messageId || generateId(),
      }]
    : (data.mentions && data.mentions.length > 0)
      ? data.mentions
      : [{ agentId: '', subPrompt: prompt, messageId: data.messageId || generateId() }];

  const PER_SESSION_MAX = config.agent.perSessionMax;
  const orchestrationMode = data.orchestrationMode || 'parallel';

  // Build context-aware mode prefix for prompt injection
  const sessionType = sessionTypes.get(sessionId) || 'solo';
  const modePrefix = sessionType === 'solo'
    ? '[Solo - 与用户一对一交流]'
    : '[Group - 多Agent协作]';

  if (orchestrationMode === 'sequential' && mentions.length > 1) {
    sequentialQueues.set(sessionId, mentions.slice(1));
    mentions.splice(1);
    console.log(`[ws] Sequential mode: queued ${sequentialQueues.get(sessionId)!.length} agents after first`);
  }

  for (const mention of mentions) {
    if (runningAgentCount >= config.agent.maxConcurrent) {
      enqueuePending({
        sessionId,
        mention: { agentId: mention.agentId, subPrompt: mention.subPrompt, messageId: mention.messageId },
        enqueuedAt: Date.now(),
      });
      broadcast(sessionId, {
        type: 'agent_queued',
        agentMessageId: mention.messageId,
        position: pendingAgentQueue.length,
        message: `All agents busy — queued (position ${pendingAgentQueue.length}). Will execute when a slot frees.`,
      });
      continue;
    }

    const sessionAgents = agentStates.get(sessionId);
    if (sessionAgents && sessionAgents.size >= PER_SESSION_MAX) {
      enqueuePerSession(sessionId, {
        mention: { agentId: mention.agentId, subPrompt: mention.subPrompt, messageId: mention.messageId },
        enqueuedAt: Date.now(),
      });
      const position = perSessionPendingQueues.get(sessionId)?.length ?? 0;
      broadcast(sessionId, {
        type: 'agent_queued',
        agentMessageId: mention.messageId,
        position,
        message: `Session agent limit (${PER_SESSION_MAX}) reached — queued (position ${position}). Will execute when a slot frees.`,
      });
      continue;
    }

    // Reserve a concurrency slot immediately (before any async ops) to prevent
    // race conditions where multiple messages pass the limit check simultaneously.
    incRunningAgentCount();
    try {
      await prisma.message.update({ where: { id: mention.messageId }, data: { status: 'streaming', content: '' } });
    } catch {
      try {
        await prisma.message.create({ data: { id: mention.messageId, sessionId, senderType: 'agent', agentId: mention.agentId || null, content: '', status: 'streaming' } });
      } catch {
        broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Failed to create message' });
        decRunningAgentCount();
        drainPendingQueue();
        drainPerSessionQueue(sessionId);
        continue;
      }
    }

    let agentPrompt = mention.subPrompt;
    let isPlannerAgent = false;
    const history = await buildHistory(sessionId);
    if (!mention.agentId) {
      const defaultAgent = await resolveDefaultAgentForSession(sessionId);
      if (defaultAgent) {
        mention.agentId = defaultAgent.id;
        prisma.message.update({ where: { id: mention.messageId }, data: { agentId: defaultAgent.id } }).catch(() => {});
      }
    }

    if (mention.agentId) {
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
        agentPrompt = `${agent.systemPrompt}${InboxManager.inboxPrompt(agent.name)}${sandbox ? InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostWorkDir) : ''}${sessionMemberBlock}${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
        isPlannerAgent = agent.name === 'planner';
        if (sandbox) AgentDirectoryManager.initialize(sandbox.hostWorkDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null);
      }
    } else {
      agentPrompt = history ? `${history}\n\n---\n${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}` : `${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}`;
    }

    const agentNameForProc = mention.agentId
      ? (await prisma.agent.findUnique({ where: { id: mention.agentId }, select: { name: true } }))?.name
      : null;
    const diffAgentName = agentNameForProc || 'agent';
    if (agentNameForProc) {
      const agent = await prisma.agent.findUnique({ where: { id: mention.agentId }, select: { name: true } });
      if (agent) {
        agentNameToType.set(agentNameForProc, agent.name);
      }
    }
    recordMessageBeforeVersion(
      mention.messageId,
      sandbox.hostWorkDir,
      sessionId,
      diffAgentName,
      `Before ${diffAgentName} turn`,
    );
    // Use AgentRuntime for global agent lifecycle management.
    // Build the full prompt with mode prefix for context awareness.
    const fullPrompt = `${modePrefix}\n\n${agentPrompt}`;

    if (!mention.agentId) {
      console.error(`[ws] No agent resolved for mention in session=${sessionId}`);
      broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Agent unavailable' });
      decRunningAgentCount();
      drainPendingQueue();
      drainPerSessionQueue(sessionId);
      continue;
    }

    // Register in agentStates so stop/pause works via handleStopAgent
    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(mention.messageId, {
      process: { write: () => {}, kill: () => {}, stop: () => {} },
      timer: null,
      agentId: mention.agentId,
      agentName: agentNameForProc || undefined,
      runtimeAgentId: mention.agentId || undefined,
    });

    console.log(`[ws] AgentRuntime sendPrompt: session=${sessionId} agent=${mention.agentId} msg=${mention.messageId}`);
    agentRuntime.sendPrompt(mention.agentId, sessionId, fullPrompt, mention.messageId).catch((err: any) => {
      console.error(`[ws] AgentRuntime.sendPrompt failed: agent=${mention.agentId} session=${sessionId}`, err.message);
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: mention.messageId,
        error: `Agent execution failed: ${err.message}`,
      });
      decRunningAgentCount();
      drainPendingQueue();
      drainPerSessionQueue(sessionId);
    });

    // Notify frontend that agent is now actively processing
    broadcast(sessionId, { type: 'agent_status', status: 'running', agentMessageId: mention.messageId, timestamp: Date.now() });
  }
}

// Per-agent accumulated content for plan extraction (planner REPL handler)
const replAccumulatedContent = new Map<string, string>();

/**
 * Register a REPL event handler on the provider that handles all event types
 * (thinking, tool_use, done, error) and broadcasts to the frontend.
 * Used for both solo (post-activation) and group session agents.
 */
function registerReplHandler(
  sessionId: string,
  agentName: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
  provider: AbstractProvider,
): void {
  provider.onEvent((event) => {
    const msgId = agentCurrentMessage.get(agentName) || `standby-${agentName}`;
    switch (event.type) {
      case 'thinking': {
        if (event.content) {
          const prev = replAccumulatedContent.get(agentName) || '';
          replAccumulatedContent.set(agentName, prev + event.content);
        }
        let chatContent = event.content || '';
        if (agentName === 'planner') {
          chatContent = chatContent.replace(PLAN_STRIP_RE, '');
          if (!chatContent.trim()) break;
        }
        if (chatContent) broadcast(sessionId, { type: 'stream_chunk', content: chatContent, agentMessageId: msgId });
        broadcast(sessionId, { type: 'agent_status', status: 'thinking', details: { content: (event.content || '').slice(0, 120) }, agentMessageId: msgId, timestamp: Date.now() });
        break;
      }
      case 'tool_use': {
        stateTracker.updateTool(msgId, event.toolName || '', event.toolInput || {});
        if (agentName && sandbox) {
          const result = agentCoordinator.onToolUse({ sessionId, agentName, agentType: agentName, messageId: msgId, hostWorkDir: sandbox.hostWorkDir, resolveAgent: (t: string) => resolveAgentNameInSession(sessionId, t), broadcast }, { type: 'tool_use', toolName: event.toolName || '', input: (event.toolInput || {}) as Record<string, unknown> });
          if (!result.allowed && result.delegateTo) {
            const targetName = resolveAgentNameInSession(sessionId, result.delegateTo);
            if (targetName) {
              const targetProvider = agentProcesses.get(sessionId)?.get(targetName)?.provider;
              if (targetProvider?.isAlive()) {
                const procInfo = agentProcesses.get(sessionId)?.get(targetName);
                const inboxPrompt = `\n## Inbox message\nYou have a new task delegated from ${agentName}. Check your inbox at /workspace/_inbox_${targetName.toLowerCase()}.jsonl.\n\nRead the inbox file now and execute the task autonomously. Do NOT ask the user for permission — process it directly.`;
                wakeupAgent(sessionId, targetName, procInfo?.agentId || '', inboxPrompt, sandbox, targetProvider).catch(err => console.error(`[ws] wakeup failed: ${err.message}`));
              }
            }
          }
        }
        broadcast(sessionId, { type: 'agent_status', status: 'tool_use', details: { toolName: event.toolName, input: event.toolInput, inputPreview: JSON.stringify(event.toolInput || {}).slice(0, 80) }, agentMessageId: msgId, timestamp: Date.now() });
        break;
      }
      case 'tool_result':
        broadcast(sessionId, { type: 'agent_status', status: 'tool_result', details: { content: (event.content || '').slice(0, 200) }, agentMessageId: msgId, timestamp: Date.now() });
        break;
      case 'permission_request': {
        const pid = `${msgId}|::|${event.tool}|::|${Date.now()}`;
        broadcast(sessionId, { type: 'permission_request', permissionId: pid, tool: event.tool, path: event.path, agentMessageId: msgId, timestamp: Date.now() });
        broadcast(sessionId, { type: 'agent_status', status: 'permission_request', details: { tool: event.tool, path: event.path, permissionId: pid }, agentMessageId: msgId, timestamp: Date.now() });
        const timeout = setTimeout(() => {
          permissionTimeouts.delete(pid);
          const stMap = agentStates.get(sessionId);
          if (stMap) { const st = stMap.get(msgId); if (st) st.process.write('n\n'); }
        }, PERMISSION_TIMEOUT_MS);
        permissionTimeouts.set(pid, timeout);
        break;
      }
      case 'token_usage': {
        const input = event.inputTokens || 0;
        const output = event.outputTokens || 0;
        const cacheRead = event.cacheReadTokens || 0;
        const cacheCreate = event.cacheCreateTokens || 0;
        const contextPct = input > 0 ? Math.round((input / config.agent.contextWindowTokens) * 100) : 0;
        stateTracker.updateTokenUsage(msgId, { input, output, cacheRead, cacheCreate });
        broadcast(sessionId, { type: 'agent_status', status: 'token_update', details: { tokenUsage: { input, output, cacheRead, cacheCreate, contextPct } }, agentMessageId: msgId, timestamp: Date.now() });
        break;
      }
      case 'done': {
        stateTracker.setDone(msgId);
        const doneContent = replAccumulatedContent.get(agentName) || '';
        replAccumulatedContent.delete(agentName);
        // Extract hidden plan JSON from Planner output
        if (agentName === 'planner' && doneContent && event.exitCode === 0) {
          const planMatch = doneContent.match(PLAN_EXTRACT_RE);
          if (planMatch) {
            try {
              const plan = JSON.parse(planMatch[1]);
              const validated = extractAndValidate(JSON.stringify(plan));
              if (validated) {
                const planId = `plan-${Date.now()}`;
                broadcast(sessionId, {
                  type: 'plan_result',
                  planId, planTitle: validated.planTitle,
                  summary: validated.summary,
                  tasks: toTaskStates(validated, planId),
                  timestamp: Date.now(),
                });
                const taskNodes: TaskDispatchNode[] = validated.tasks.map(t => ({
                  id: t.id, title: t.title, description: t.description,
                  agentType: t.agentType, dependsOn: t.dependsOn,
                  expectedOutput: t.expectedOutput, priority: t.priority as 'high' | 'medium' | 'low',
                }));
                addDispatchedPlan(planId);
                dispatchTasksToAgents(sessionId, planId, taskNodes, {
                  containerId: sandbox.containerId, workDir: sandbox.workDir, hostWorkDir: sandbox.hostWorkDir,
                }, validated.planTitle).catch((err: any) => {
                  dispatchedPlans.delete(planId);
                  broadcast(sessionId, { type: 'stream_error', error: `Auto-dispatch failed: ${err.message}` });
                });
              }
            } catch (err: any) {
              console.error(`[ws] Failed to parse embedded plan: ${err.message}`);
            }
          }
          // Stop planner from continuing — prevent it from trying to implement
          provider.stopChild?.();
        }
        if (agentName) MilestoneBroadcaster.classify({ sessionId, agentName, agentMessageId: msgId, eventType: 'done' });
        broadcast(sessionId, { type: 'stream_end', agentMessageId: msgId, fullContent: doneContent, exitCode: event.exitCode ?? 0 });
        // Scan complete agent output for cross-agent intents
        if (agentName && sandbox && doneContent) {
          const intents = IntentParser.scan(doneContent);
          for (const intent of intents) {
            const targetName = resolveAgentNameInSession(sessionId, intent.targetAgentName);
            if (targetName && targetName !== agentName) {
              InboxManager.write(sandbox.hostWorkDir, targetName, {
                type: 'intervention_request',
                id: `help-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                from: agentName, to: targetName,
                summary: `${agentName} needs help: ${intent.description}`,
                risk: 'high', timestamp: Date.now(),
              });
              const targetProvider = agentProcesses.get(sessionId)?.get(targetName)?.provider;
              if (targetProvider?.isAlive()) {
                const procInfo = agentProcesses.get(sessionId)?.get(targetName);
                const inboxPrompt = `\n## Inbox message from ${agentName}\n${intent.description}\n\nProcess this request autonomously. Do NOT ask the user — just do it.`;
                wakeupAgent(sessionId, targetName, procInfo?.agentId || '', inboxPrompt, sandbox, targetProvider).catch(err => console.error(`[ws] wakeup failed: ${err.message}`));
              }
              broadcast(sessionId, { type: 'inbox_update', agentName: targetName, fromAgent: agentName, summary: intent.description, timestamp: Date.now() });
              console.log(`[ws] NEEDS HELP routed: ${agentName} → ${targetName}: ${intent.description.slice(0, 80)}`);
            }
          }
        }
        agentCoordinator.onAgentDone({ sessionId, agentName, agentType: agentName, messageId: msgId, hostWorkDir: sandbox.hostWorkDir, resolveAgent: (t: string) => resolveAgentNameInSession(sessionId, t), broadcast }, event.exitCode ?? 0, doneContent.slice(0, 200));
        // Release concurrency slot and drain waiting queues
        clearRunningAgent(sessionId, msgId);
        agentCurrentMessage.delete(agentName);
        // Persist message status to DB so reload doesn't show stale "streaming"
        prisma.message.update({
          where: { id: msgId },
          data: { status: event.exitCode === 0 ? 'done' : 'error', content: doneContent || undefined },
        }).catch(() => {});
        drainPendingQueue();
        drainPerSessionQueue(sessionId);
        break;
      }
      case 'error':
        broadcast(sessionId, { type: 'stream_error', agentMessageId: msgId, error: event.message || 'Unknown error' });
        prisma.message.update({ where: { id: msgId }, data: { status: 'error' } }).catch(() => {});
        break;
    }
  });
}

/**
 * Activate a single agent via REPL for solo sessions.
 * Registers the full REPL handler and resolves when the standby prompt completes.
 */
function activateSoloAgent(
  sessionId: string,
  agentName: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
  trustMode: boolean,
): Promise<void> {
  return (async () => {
    const agent = await prisma.agent.findUnique({ where: { name: agentName }, select: { id: true, name: true, displayName: true, systemPrompt: true, provider: true, providerConfig: true } });
    if (!agent) { console.error(`[ws] activateSoloAgent: agent ${agentName} not found`); return; }

    const { ProviderFactory } = await import('../agent/providers/factory.js');
    const provider = ProviderFactory.create(agent.provider);
    const agentHome = `/workspace/_agent_${agent.name}`;

    // Register the full REPL handler BEFORE starting — handles all subsequent events
    // including the standby prompt response and all future user message responses.
    let activated = false;
    registerReplHandler(sessionId, agentName, sandbox, provider);
    // Also listen for activation completion signal
    provider.onEvent((event) => {
      if (!activated && event.type === 'done') {
        activated = true;
        if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
        agentProcesses.get(sessionId)!.set(agent.name, { provider, timer: null, agentId: agent.id });
        agentNameToType.set(agent.name, agent.name);
        AgentDirectoryManager.initialize(sandbox.hostWorkDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null);
        console.log(`[ws] Solo agent activated: ${agentName} for session=${sessionId}`);
      }
    });

    const standbyPrompt = [
      `## Standby mode`,
      `You are **${agent.displayName}** (${agent.name}), the sole agent in this solo session.`,
      `Wait for the user's request. When they send a message, you'll receive it as a prompt.`,
      `Your working directory is ${agentHome}.`,
      `Do NOT take any action until the user asks you to. Just acknowledge readiness with "Ready."`,
    ].join('\n');

    const fullPrompt = `${agent.systemPrompt}\n\n${standbyPrompt}`;

    // Wait for activation to complete (first done event from standby prompt)
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (activated) { clearInterval(checkInterval); resolve(); }
        // Also reject on error from REPL handler (via stream_error broadcast)
      }, 100);
      // Timeout after 60s
      setTimeout(() => {
        clearInterval(checkInterval);
        if (!activated) reject(new Error(`Agent ${agentName} activation timed out`));
      }, 60000);
      provider.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, {
        agentName: agent.name, hostWorkDir: sandbox.hostWorkDir, trustMode,
      }).catch(reject);
    });
  })();
}

/** Drain the GLOBAL pending queue: start waiting agents when slots free up. */
export function drainPendingQueue(): void {
  if (pendingAgentQueue.length === 0) return;

  const now = Date.now();
  const queueTimeout = config.agent.queueTimeoutMs;

  while (pendingAgentQueue.length > 0 && runningAgentCount < config.agent.maxConcurrent) {
    const next = dequeuePending();
    if (!next) break;

    if (now - next.enqueuedAt > queueTimeout) {
      broadcast(next.sessionId, {
        type: 'stream_error',
        agentMessageId: next.mention.messageId,
        error: `Queue timeout after ${queueTimeout / 1000}s — too many agents waiting.`,
      });
      continue;
    }

    console.log(`[ws] Dequeuing agent: session=${next.sessionId} msg=${next.mention.messageId}`);
    handleChatMessage(next.sessionId, {
      content: next.mention.subPrompt,
      mentions: [next.mention],
    });
  }
}

/** Drain the per-session pending queue: start waiting agents for a specific session when a slot frees. */
export function drainPerSessionQueue(sessionId: string): void {
  const queue = perSessionPendingQueues.get(sessionId);
  if (!queue || queue.length === 0) return;

  const perSessionMax = config.agent.perSessionMax;
  const now = Date.now();
  const queueTimeout = config.agent.queueTimeoutMs;

  while (queue.length > 0 && runningAgentCount < config.agent.maxConcurrent) {
    const sessionAgents = agentStates.get(sessionId);
    if (sessionAgents && sessionAgents.size >= perSessionMax) break; // session still at capacity

    const next = dequeuePerSession(sessionId);
    if (!next) break;

    if (now - next.enqueuedAt > queueTimeout) {
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: next.mention.messageId,
        error: `Per-session queue timeout after ${queueTimeout / 1000}s.`,
      });
      continue;
    }

    console.log(`[ws] Dequeuing per-session agent: session=${sessionId} msg=${next.mention.messageId}`);
    // handleChatMessage re-checks session capacity and may re-enqueue
    handleChatMessage(sessionId, {
      content: next.mention.subPrompt,
      mentions: [next.mention],
    });
  }
}

// ---- Agent control ----

function handleStopAgent(sessionId: string, data: { agentMessageId: string }): void {
  const stateMap = agentStates.get(sessionId);
  if (!stateMap) {
    // Agent may have already finished — update DB and broadcast stream_end gracefully
    prisma.message.update({ where: { id: data.agentMessageId }, data: { status: 'done' } }).catch(() => {});
    broadcast(sessionId, { type: 'stream_end', agentMessageId: data.agentMessageId, exitCode: -1, stopped: true });
    return;
  }
  const st = stateMap.get(data.agentMessageId);
  if (!st) {
    // Agent not in active state — gracefully mark as done
    prisma.message.update({ where: { id: data.agentMessageId }, data: { status: 'done' } }).catch(() => {});
    broadcast(sessionId, { type: 'stream_end', agentMessageId: data.agentMessageId, exitCode: -1, stopped: true });
    return;
  }
  console.log(`[ws] Stopping agent: session=${sessionId} agentMsg=${data.agentMessageId}`);
  if (st.timer) clearTimeout(st.timer);

  // Delegate to AgentRuntime for globally-managed agents.
  // Delete from stateMap FIRST to prevent clearRunningAgent (fired by 'done'
  // event from stopProcessing) from double-decrementing.
  if (st.runtimeAgentId) {
    stateMap.delete(data.agentMessageId);
    if (st.agentName) agentCurrentMessage.delete(st.agentName);
    agentRuntime.stopProcessing(st.runtimeAgentId);
  } else {
    // Legacy session-scoped agent stop
    if (st.process.kill) st.process.kill(); else if (st.process.stop) st.process.stop();
    if (st.agentName) { agentCurrentMessage.delete(st.agentName); agentProcesses.get(sessionId)?.delete(st.agentName); }
    stateMap.delete(data.agentMessageId);
  }
  const stoppedAgentName = st.agentName;
  if (stoppedAgentName) {
    const sb = sandboxes.get(sessionId);
    if (sb) {
      import('./taskDispatcher.js').then(({ reassignQueuedTasks }) =>
        reassignQueuedTasks(sessionId, stoppedAgentName, {
          containerId: sb.containerId,
          workDir: sb.workDir,
          hostWorkDir: sb.hostWorkDir,
        })
      ).catch(() => {});
    }
  }
  decRunningAgentCount();
  drainPendingQueue();
  drainPerSessionQueue(sessionId);
  if (stateMap.size === 0) agentStates.delete(sessionId);
  prisma.message.update({ where: { id: data.agentMessageId }, data: { status: 'done' } }).catch(() => {});
  broadcast(sessionId, { type: 'stream_end', agentMessageId: data.agentMessageId, exitCode: -1, stopped: true });
}

function handlePermissionResponse(sessionId: string, data: { permissionId: string; allowed: boolean; message?: string }): void {
  const agentMessageId = data.permissionId.split('|::|')[0];
  if (!agentMessageId) { broadcast(sessionId, { type: 'stream_error', error: 'Invalid permissionId' }); return; }
  // Clear timeout regardless of agent state — prevents stale timeout from writing after death
  const timeout = permissionTimeouts.get(data.permissionId);
  if (timeout) { clearTimeout(timeout); permissionTimeouts.delete(data.permissionId); }
  const stateMap = agentStates.get(sessionId);
  if (!stateMap) {
    console.log(`[ws] Permission response ignored: session=${sessionId} has no active agents`);
    return;
  }
  const st = stateMap.get(agentMessageId);
  if (!st) {
    console.log(`[ws] Permission response ignored: agent already terminated for msg=${agentMessageId}`);
    return;
  }
  st.process.write(data.allowed ? 'y\n' : 'n\n');
}

function handlePermissionModeChange(sessionId: string, data: { mode: string }): void {
  if (!data.mode) return;
  sessionPermissionModes.set(sessionId, data.mode);
  const trustMode = data.mode === 'smart' || data.mode === 'trust';
  // Sync to all online REPL providers in this session
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    for (const [, entry] of procMap) {
      if (entry.provider.updateTrustMode) {
        entry.provider.updateTrustMode(trustMode);
      }
    }
  }
  console.log(`[ws] Permission mode changed: session=${sessionId.slice(0, 8)} mode=${data.mode} trustMode=${trustMode}`);
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

/** Prevent re-dispatching the same plan (can happen on WS reconnect with buffered messages) */
const dispatchedPlans = new Set<string>();

function addDispatchedPlan(planId: string): void {
  if (dispatchedPlans.size > 500) dispatchedPlans.clear();
  dispatchedPlans.add(planId);
}

async function handleConfirmPlan(sessionId: string, data: { planId: string; tasks: any[] }): Promise<void> {
  if (dispatchedPlans.has(data.planId)) {
    console.log(`[ws] Plan ${data.planId} already dispatched, skipping`);
    return;
  }
  addDispatchedPlan(data.planId);

  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' }); return; }
  const normalized = applyTaskModifications(data.tasks.map((t: any) => ({ ...t, planId: data.planId })));
  const tasks: TaskDispatchNode[] = normalized.map((t: any) => ({
    id: t.taskId || t.id, title: t.title, description: t.description || '',
    agentType: t.agentType || 'code-agent', dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    expectedOutput: t.expectedOutput || '', priority: t.priority || 'medium',
  }));

  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true, providerConfig: true } } },
  });
  for (const sa of sessionAgents) {
    AgentDirectoryManager.initialize(sandbox.hostWorkDir, sa.agent.name, sa.agent.systemPrompt, sa.agent.providerConfig as Record<string, unknown> | null);
  }

  dispatchTasksToAgents(sessionId, data.planId, tasks, {
    containerId: sandbox.containerId, workDir: sandbox.workDir, hostWorkDir: sandbox.hostWorkDir,
  }).then(() => {
    broadcast(sessionId, { type: 'plan_executing', planId: data.planId });
  }).catch((err: any) => {
    dispatchedPlans.delete(data.planId);
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
      where: { name: taskNode.agentType }, select: { name: true, systemPrompt: true },
    });
    if (agent) agentName = agent.name;
  }

  if (agentName) {
    const queue = agentTaskQueues.get(agentName);
    const dispatchNode: TaskDispatchNode = {
      id: taskNode.id, title: taskNode.title, description: taskNode.description || '',
      agentType: taskNode.agentType || 'code-agent', dependsOn: [],
      expectedOutput: taskNode.expectedOutput || '', priority: (taskNode.priority as 'high' | 'medium' | 'low') || 'medium',
    };
    prepareDispatchedTaskRetry(sessionId, data.planId, dispatchNode.id);
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

function handleReplanRequest(sessionId: string, data: { planId: string; taskId: string }): void {
  console.log(`[ws] Replan request: planId=${data.planId} taskId=${data.taskId}`);
  handleReplanFailedTask(sessionId, data.planId, data.taskId).catch((err: any) => {
    broadcast(sessionId, { type: 'stream_error', error: `Re-plan failed: ${err.message}` });
  });
}

// ---- Approval Gate handlers ----

function handleApprovalApprove(sessionId: string, _ws: WebSocket, data: { taskId: string; comment?: string }): void {
  const gate = getApprovalGate();
  const request = gate.approve(data.taskId, data.comment);
  if (request) {
    broadcast(sessionId, { type: "approval_resolved", taskId: data.taskId, approved: true, comment: data.comment });
  }
}

function handleApprovalReject(sessionId: string, _ws: WebSocket, data: { taskId: string; comment?: string }): void {
  const gate = getApprovalGate();
  const request = gate.reject(data.taskId, data.comment);
  if (request) {
    broadcast(sessionId, { type: "approval_resolved", taskId: data.taskId, approved: false, comment: data.comment });
  }
}

function handleApprovalReply(sessionId: string, _ws: WebSocket, data: { taskId: string; message: string }): void {
  const gate = getApprovalGate();
  const request = gate.addReply(data.taskId, "user", data.message);
  if (request) {
    broadcast(sessionId, {
      type: "approval_reply_added",
      taskId: data.taskId,
      approvalId: request.id,
      replies: request.replies,
    });
  }
}

// ---- Attach to HTTP server ----

let heartbeatInterval: NodeJS.Timeout | null = null;

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: WebSocket, request) => handleConnection(ws, request));
  console.log('[ws] WebSocket server attached on /ws');

  // Queue heartbeat: send position updates every 10s to sessions with queued agents.
  // Clear any previous interval (e.g., during HMR or integration tests) to avoid leaks.
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (pendingAgentQueue.length === 0) return;
    const now = Date.now();
    for (let i = 0; i < pendingAgentQueue.length; i++) {
      const req = pendingAgentQueue[i];
      const waitMs = now - req.enqueuedAt;
      broadcast(req.sessionId, {
        type: 'agent_queue_heartbeat',
        agentMessageId: req.mention.messageId,
        position: i + 1,
        totalQueued: pendingAgentQueue.length,
        waitSeconds: Math.round(waitMs / 1000),
        timestamp: now,
      });
    }
  }, 10_000);
}

/** Stop the queue heartbeat interval (for graceful shutdown / testing). */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function handleWebSocket(ws: WebSocket, request: any): void {
  handleConnection(ws, request);
}

/**
 * Wake up an idle REPL agent with an inbox prompt.
 * Creates a message, sets up state tracking, and increments the concurrency counter
 * so the frontend can properly display the agent's response and the counter is balanced.
 */
async function wakeupAgent(
  sessionId: string,
  agentName: string,
  agentId: string,
  prompt: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
  provider: AbstractProvider,
) {
  const msgId = generateId();
  agentCurrentMessage.set(agentName, msgId);

  // Create message in DB so frontend can find it
  try {
    await prisma.message.create({
      data: { id: msgId, sessionId, senderType: 'agent', agentId, content: '', status: 'streaming' },
    });
  } catch (err: any) { console.error('[ws] Failed to create wakeup message:', err?.message ?? err); }

  // Register in agentStates so stop/pause works and done handler can decrement count
  if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
  agentStates.get(sessionId)!.set(msgId, {
    process: provider, timer: null,
    agentId, agentName,
  });
  incRunningAgentCount();

  broadcast(sessionId, { type: 'agent_wakeup', agentMessageId: msgId, agentName, timestamp: Date.now() });
  provider.sendPrompt(prompt);
  console.log(`[ws] Agent wakeup: ${agentName} msg=${msgId}`);
}

/**
 * Pre-activate all agents in a group session so they're online and listening.
 * Each agent gets a standby prompt and a persistent REPL process.
 */
async function preActivateGroupAgents(
  sessionId: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true, provider: true, providerConfig: true } } },
  });
  if (sessionAgents.length === 0) return;

  const standbyPrompt = (displayName: string, agentName: string) =>
    [
      `## Standby mode`,
      `You are **${displayName}** (${agentName}), an active member of this group chat.`,
      ``,
      `Other agents may send you messages via your inbox at /workspace/_inbox_${agentName.toLowerCase()}.jsonl.`,
      `Check it after receiving this prompt and respond if any messages are waiting.`,
      ``,
      `Monitor the conversation. Speak up when:`,
      `- Another agent explicitly requests your help ("NEEDS HELP from @${displayName}")`,
      `- You see an issue in your domain that needs attention`,
      `- The user or planner asks for your expertise`,
      ``,
      `Stay concise. If nothing needs your attention, just acknowledge you're online.`,
    ].join('\n');

  console.log(`[ws] Pre-activating ${sessionAgents.length} agents for group session=${sessionId.slice(0, 8)}`);

  // Start agents in parallel — each runs in its own Docker container, no shared state.
  await Promise.all(sessionAgents.map(async (sa) => {
    try {
      const provider = ProviderFactory.create(sa.agent.provider);
      const agentName = sa.agent.name;

      registerReplHandler(sessionId, agentName, sandbox, provider);

      // Initialize agent directory: CLAUDE.md + settings.json for persistent identity
      AgentDirectoryManager.initialize(
        sandbox.hostWorkDir,
        agentName,
        sa.agent.systemPrompt,
        sa.agent.providerConfig as Record<string, unknown> | null,
      );
      // Ensure inbox file exists so agent can be contacted from the start
      InboxManager.init(sandbox.hostWorkDir, agentName);

      await provider.start(
        sessionId,
        standbyPrompt(sa.agent.displayName, agentName),
        sandbox.containerId,
        sandbox.workDir,
        { agentName, hostWorkDir: sandbox.hostWorkDir, trustMode: true },
      );

      // Register in agentProcesses for lifecycle tracking
      if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
      agentProcesses.get(sessionId)!.set(agentName, {
        provider,
        timer: null,
        agentId: sa.agent.id,
      });

      console.log(`[ws] Agent activated: ${agentName} for session=${sessionId.slice(0, 8)}`);
    } catch (err: any) {
      console.error(`[ws] Failed to activate agent ${sa.agent.name}: ${err.message}`);
    }
  }));

  console.log(`[ws] Group agents ready: session=${sessionId.slice(0, 8)} count=${sessionAgents.length}`);
}

