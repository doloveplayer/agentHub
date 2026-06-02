// Chat message handling, queue management, agent control, and permission handling.
// Extracted from handler.ts to keep modules focused.

import { InboxManager } from '../agent/InboxManager.js';
import { MilestoneBroadcaster } from '../agent/MilestoneBroadcaster.js';
import { AgentDirectoryManager } from '../agent/AgentDirectoryManager.js';
import { selectDefaultAgent } from '../agent/turns.js';
import { InboxWakeup } from '../agent/InboxWakeup.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { parseReviewReport, parseTestOutput } from '../artifacts/ArtifactTools.js';
import { detectLanguage, languageConsistencyPrompt } from '../agent/languageDetection.js';
import { agentRuntime } from '../agent/AgentRuntime.js';

import { pendingRecoveries } from './handler.js';
import {
  sessionPermissionModes, agentStates, agentProcesses, sandboxes,
  runningAgentCount, incRunningAgentCount, decRunningAgentCount,
  pendingAgentQueue, enqueuePending, dequeuePending,
  perSessionPendingQueues, enqueuePerSession, dequeuePerSession,
  sessionsWithMilestones, sequentialQueues,
  agentCurrentMessage,
  permissionTimeouts,
  quoteBackfillMap,
  generateId, getOrCreateSandbox, broadcast,
  clearRunningAgent,
  realWorkspacePaths, workspaceModes,
} from './state.js';

import { startStaleTaskChecker } from './taskDispatcher.js';
import { recordMessageBeforeVersion } from './diffBroadcast.js';

// ---- Shared state (used by handleConnection in handler.ts) ----

export const agentNameToType = new Map<string, string>();
export const sessionTypes = new Map<string, string>(); // sessionId → 'solo' | 'group'
export const sandboxInitialized = new Set<string>();

// ---- Sandbox initialization ----

/** Lazily initialize sandbox, plan watcher, and stale task checker for a session.
 *  Called on first chat message so workspace path is already configured. */
export async function ensureSandboxReady(sessionId: string, sessionType?: string | null): Promise<ReturnType<typeof sandboxes.get>> {
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

  // Recovery: check for incomplete plans on reconnect — ask user instead of auto-dispatching
  import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
    CheckpointManager.getIncompleteForSession(sessionId).then(checkpoints => {
      for (const cp of checkpoints) {
        if (cp.pendingTasks.length > 0) {
          console.log(`[recovery] Incomplete plan ${cp.planId} — ${cp.pendingTasks.length} pending tasks, asking user`);
          // Restore ContextBus so agent state is available
          CheckpointManager.restoreContextBus(sessionId, cp);
          // Store for user decision
          pendingRecoveries.set(`${sessionId}:${cp.planId}`, {
            planId: cp.planId,
            pendingTasks: cp.pendingTasks,
          });
          // Don't auto-dispatch — let user decide
          broadcast(sessionId, {
            type: 'plan_recovery_available',
            planId: cp.planId,
            pendingCount: cp.pendingTasks.length,
            planTitle: cp.pendingTasks[0]?.title || 'Unknown',
            pendingTasks: cp.pendingTasks.map(t => ({
              id: t.id,
              title: t.title,
              agentType: t.agentType,
            })),
          });
        }
      }
    }).catch((err: any) => console.error('[recovery] getIncompleteForSession failed:', err.message));
  }).catch((err: any) => console.error('[recovery] CheckpointManager import failed:', err.message));

  sandboxInitialized.add(sessionId);
  return sb;
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

// ---- Chat message handling ----

export async function handleChatMessage(
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
    const history = await buildHistory(sessionId);
    if (!mention.agentId) {
      const defaultAgent = await resolveDefaultAgentForSession(sessionId);
      if (defaultAgent) {
        mention.agentId = defaultAgent.id;
        prisma.message.update({ where: { id: mention.messageId }, data: { agentId: defaultAgent.id } }).catch(() => {});
      }
    }

    // Single DB query for agent — reused for prompt building, name resolution, and type tracking
    const agent = mention.agentId
      ? await prisma.agent.findUnique({ where: { id: mention.agentId } })
      : null;
    const agentNameForProc = agent?.name ?? null;

    if (agent) {
      let sessionMemberBlock = '';
      if (agent.name === 'planner' || agent.name.startsWith('planner-')) {
        sessionMemberBlock = `\n## 任务规划指引

1. 在规划任务之前，请**先读取你的 skill cap-inventory.md**，获取当前群聊中所有可用 Agent 的能力清单
2. plan.json 中的 agentType 必须使用 cap-inventory.md 中声明的值，不要附加 session ID 或后缀
3. 每个任务必须包含 risk 字段（low / high），参考 plan skill 中的风险判定规则
4. 将 plan.json 通过 Write 工具写入 /sandbox/plan.json，Hub 会自动检测并调度\n`;
      }
      agentPrompt = `${agent.systemPrompt}${InboxManager.inboxPrompt(agent.name)}${sandbox ? InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostSandboxDir, sessionId) : ''}${sessionMemberBlock}${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
      if (sandbox) AgentDirectoryManager.initialize(sandbox.hostSandboxDir, agent.name, agent.systemPrompt, agent.providerConfig as Record<string, unknown> | null, sessionId, agent.skills as any[] | null);
      agentNameToType.set(agent.name, agent.name);
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

    const diffAgentName = agentNameForProc || 'agent';
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

export function handleStopAgent(sessionId: string, data: { agentMessageId: string }): void {
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

// ---- Permission handling ----

export function handlePermissionResponse(sessionId: string, data: { permissionId: string; allowed: boolean; message?: string }): void {
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

export function handlePermissionModeChange(sessionId: string, data: { mode: string }): void {
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
