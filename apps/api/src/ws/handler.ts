import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { InboxManager } from '../agent/InboxManager.js';
import { MilestoneBroadcaster } from '../agent/MilestoneBroadcaster.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { selectDefaultAgent } from '../agent/turns.js';
import { getApprovalGate } from '../agent/ApprovalGate.js';
import { InboxWakeup } from '../agent/InboxWakeup.js';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { config } from '../config.js';
import { isDeployTarget, normalizeTarget, startDeployment } from '../routes/deploy.js';
import { parseReviewReport, parseTestOutput } from '../artifacts/ArtifactTools.js';
import { permissionProfiles, type AgentCapability } from '../agent/PermissionProfiles.js';
import { detectLanguage, languageConsistencyPrompt } from '../agent/languageDetection.js';
import { agentRuntime } from '../agent/AgentRuntime.js';

import {
  sessions, sessionPermissionModes, agentStates, agentProcesses, sandboxes,
  runningAgentCount, incRunningAgentCount, decRunningAgentCount,
  pendingAgentQueue, enqueuePending, dequeuePending,
  perSessionPendingQueues, enqueuePerSession, dequeuePerSession,
  sessionsWithMilestones, sequentialQueues,
  agentTaskQueues, agentCurrentMessage,
  permissionTimeouts, PERMISSION_TIMEOUT_MS,
  taskModifications, quoteBackfillMap,
  trackFileMod, detectConflicts, clearFileMods,
  generateId, getOrCreateSandbox, broadcast, sendTo,
  cleanupSessionResources, cleanupSessionClient, clearRunningAgent,
  realWorkspacePaths, workspaceModes,
  type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';

import {
  dispatchTasksToAgents,
  processNextInQueue,
  prepareDispatchedTaskRetry,
  handleReplanFailedTask,
  handleForceCompleteTask,
  handleForceFailTask,
  startStaleTaskChecker,
} from './taskDispatcher.js';
import {
  recordMessageBeforeVersion,
} from './diffBroadcast.js';

export { broadcast } from './state.js';

const agentNameToType = new Map<string, string>();
const sessionTypes = new Map<string, string>(); // sessionId → 'solo' | 'group'

/** Sessions whose sandbox + plan watcher have been initialized. */
const sandboxInitialized = new Set<string>();

/** Lazily initialize sandbox, plan watcher, and stale task checker for a session.
 *  Called on first chat message so workspace path is already configured. */
async function ensureSandboxReady(sessionId: string, sessionType?: string | null): Promise<ReturnType<typeof sandboxes.get>> {
  if (sandboxInitialized.has(sessionId)) return sandboxes.get(sessionId);

  const sb = await getOrCreateSandbox(sessionId, sessionType);
  await prisma.session.update({
    where: { id: sessionId }, data: { sandboxContainerId: sb.containerId },
  }).catch(() => {});
  console.log(`[ws] Sandbox ready: session=${sessionId} container=${sb.containerId.slice(0, 12)} hostDir=${sb.hostWorkDir}`);

  if (!sessionsWithMilestones.has(sessionId)) {
    sessionsWithMilestones.add(sessionId);
    MilestoneBroadcaster.on(sessionId, (event) => { broadcast(sessionId, event); });
  }

  import('./planWatcher.js').then(({ startPlanWatcher }) => {
    startPlanWatcher(sessionId, sb.hostSandboxDir, sb);
  }).catch((err) => {
    console.error('[ws] Failed to start plan watcher:', err.message);
  });
  startStaleTaskChecker(sessionId, sb);

  sandboxInitialized.add(sessionId);
  return sb;
}

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
  ws.on('close', () => { sandboxInitialized.delete(sessionId); cleanupSessionClient(sessionId, ws); });
  ws.on('error', () => { sandboxInitialized.delete(sessionId); cleanupSessionClient(sessionId, ws); });

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
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        permissionMode: true,
        type: true,
        workspacePath: true,
        workspaceMode: true,
        writePermission: true,
      },
    });
    if (!session || session.userId !== userId) {
      sendTo(ws, { type: 'error', message: 'Session not found or access denied' });
      ws.close(4003, 'Access denied');
      return;
    }
    sessionPermissionModes.set(sessionId, session.permissionMode || 'ask');
    sessionTypes.set(sessionId, session.type);
    sessionType = session.type;

    // Load workspace configuration from database
    if (session.workspacePath) {
      realWorkspacePaths.set(sessionId, session.workspacePath);
      workspaceModes.set(sessionId, (session.workspaceMode as any) || 'custom');
    }
  } catch {
    sendTo(ws, { type: 'error', message: 'Failed to verify session' });
    ws.close(4000, 'Internal error');
    return;
  }

  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId)!.add(ws);

  // Sandbox creation is deferred to first chat message (ensureSandboxReady)
  // so the user can configure a workspace path before the container bind mount is set.

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
    case 'force_complete_task': handleForceCompleteTaskMsg(sessionId, data); break;
    case 'force_fail_task': handleForceFailTaskMsg(sessionId, data); break;
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
  data: { messageId?: string; content?: string; prompt?: string; agentId?: string; trustMode?: boolean; orchestrationMode?: 'parallel' | 'sequential' | 'auto'; mentions?: { agentId: string; subPrompt: string; messageId: string }[]; quoteReferenceId?: string | null },
): Promise<void> {
  const prompt = data.content || data.prompt;
  if (!prompt) { broadcast(sessionId, { type: 'stream_error', error: 'Missing content or prompt' }); return; }

  // Lazily initialize sandbox on first message (deferred from connection time
  // so the user can configure workspace path before the bind mount is set)
  let sandbox: ReturnType<typeof sandboxes.get>;
  try {
    sandbox = await ensureSandboxReady(sessionId, sessionTypes.get(sessionId));
  } catch (err: any) {
    console.error(`[ws] Sandbox creation failed: session=${sessionId} error=${err.message}`);
    broadcast(sessionId, { type: 'stream_error', error: `Sandbox creation failed: ${err.message}` });
    return;
  }
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
        if (agent.name === 'planner' || agent.name.startsWith('planner-')) {
          sessionMemberBlock = `\n## 任务规划指引

1. 在规划任务之前，请**先读取你的 skill cap-inventory.md**，获取当前群聊中所有可用 Agent 的能力清单
2. plan.json 中的 agentType 必须使用 cap-inventory.md 中声明的值，不要附加 session ID 或后缀
3. 每个任务必须包含 risk 字段（low / high），参考 plan skill 中的风险判定规则
4. 将 plan.json 通过 Write 工具写入 /sandbox/plan.json，Hub 会自动检测并调度\n`;
        }
        agentPrompt = `${agent.systemPrompt}${InboxManager.inboxPrompt(agent.name)}${sandbox ? InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostSandboxDir) : ''}${sessionMemberBlock}${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
        isPlannerAgent = agent.name === 'planner' || agent.name.startsWith('planner-');
        if (sandbox) AgentDirectoryManager.initialize(sandbox.hostSandboxDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null, sessionId);
      }
    } else {
      agentPrompt = history ? `${history}\n\n---\n${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}` : `${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}`;
    }

    // Detect quote context in user message and inject structured guidance
    let quoteContextBlock = '';
    const quoteReferenceId = data.quoteReferenceId;
    if (quoteReferenceId && mention.subPrompt.includes('引用内容 —')) {
      const recentQuote = await prisma.quoteReference.findUnique({
        where: { id: quoteReferenceId },
      });
      if (recentQuote) {
        quoteContextBlock = `\n## 引用上下文\n用户引用了以下内容要求增量修改。请仅修改引用部分，不要重写无关代码。\n- 来源类型：${recentQuote.sourceType}\n- 选区长度：${recentQuote.selectionText.length} 字符\n`;
      }
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
    const fullPrompt = `${modePrefix}\n\n${agentPrompt}${quoteContextBlock}`;

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

    // Track for QuoteReference backfill on agent completion
    if (quoteContextBlock && quoteReferenceId) {
      quoteBackfillMap.set(mention.messageId, { sessionId, agentId: mention.agentId || undefined, quoteReferenceId });
    }

    console.log(`[ws] AgentRuntime sendPrompt: session=${sessionId} agent=${mention.agentId} msg=${mention.messageId}`);
    agentRuntime.sendPrompt(mention.agentId, sessionId, fullPrompt, mention.messageId, sandbox).catch((err: any) => {
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
    AgentDirectoryManager.initialize(sandbox.hostSandboxDir, sa.agent.name, sa.agent.systemPrompt, sa.agent.providerConfig as Record<string, unknown> | null);
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

// ---- Manual task recovery handlers ----

async function handleForceCompleteTaskMsg(
  sessionId: string,
  data: { planId: string; taskId: string },
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }
  await handleForceCompleteTask(sessionId, data.planId, data.taskId, {
    containerId: sandbox.containerId,
    workDir: sandbox.workDir,
    hostWorkDir: sandbox.hostWorkDir,
  });
}

async function handleForceFailTaskMsg(
  sessionId: string,
  data: { planId: string; taskId: string; reason?: string },
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }
  await handleForceFailTask(sessionId, data.planId, data.taskId, data.reason || 'Manually failed by user', {
    containerId: sandbox.containerId,
    workDir: sandbox.workDir,
    hostWorkDir: sandbox.hostWorkDir,
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


