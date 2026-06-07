// AgentRuntime — Global Agent Lifecycle Manager
// Manages all agent REPL processes globally (not per-session), handling
// lazy container startup, prompt queueing, and idle timeout shutdown.

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ProviderFactory } from './providers/factory.js';
import type { AbstractProvider, UnifiedAgentEvent } from './providers/base.js';
import { AgentContainer } from './AgentContainer.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import { extractAndValidate } from './PlanValidator.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { IntentParser } from './IntentParser.js';
import { InboxManager } from './InboxManager.js';
import { agentCoordinator } from './AgentCoordinator.js';
import { MilestoneBroadcaster } from './MilestoneBroadcaster.js';
import { broadcast, clearRunningAgent, quoteBackfillMap, sessionAgentNames, sessionPermissionModes, permissionTimeouts, agentStates } from '../ws/state.js';
import { takeMessageBeforeVersion, broadcastDiffSummary } from '../ws/diffBroadcast.js';

interface QueueItem {
  sessionId: string;
  prompt: string;
  agentMessageId?: string;
}

interface SandboxInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
  sandboxDir: string;
  hostSandboxDir: string;
}

interface AgentEntry {
  provider: AbstractProvider;
  containerId: string;
  hostWorkDir: string;
  hostSandboxDir: string;
  idleTimer: NodeJS.Timeout | null;
  currentSession: string | null;
  currentMessageId: string | null;
  currentAgentId: string | null; // agent ID for current message
  currentAgentName: string | null; // agent display name for inbox writes
  queue: QueueItem[];
  sharedContainer: boolean; // true when using session sandbox (don't destroy on idle)
  isPlanner: boolean; // true if this agent is a planner
  accumulatedOutput: string; // accumulate output for planner agents
  model: string; // model name for context window calculation
  // Retained after 'done' clears currentMessageId so late 'token_usage' events
  // (Claude SDK sends result→done before assistant→token_usage) can still
  // persist token data to the correct message.
  lastSessionId: string | null;
  lastMessageId: string | null;
  lastAgentId: string | null;
  needsCompression: boolean;           // set when contextPct > threshold
  compressionPhase: 'none' | 'summarizing'; // compression state
  compressionPendingPrompt: string | null;   // stores user prompt during compression
  intentScanOffset: number;            // position in accumulatedOutput already scanned for intents
  notifiedKeys: Set<string>;           // per-agent dedup for AgentCoordinator routing
  trustMode: boolean;                  // true = bypass permissions (trust/smart), false = ask/read_only
  sessionPermissionMode: string;        // raw session permission mode string
}

import {
  calcContextPct,
  mergeModelWindowOverrides,
} from '@agenthub/shared/constants';

/** Runtime context window table — base + env overrides. */
const modelWindows = mergeModelWindowOverrides(process.env.AGENTHUB_MODEL_WINDOWS);
const calcPct = (inputTokens: number, model: string): number =>
  calcContextPct(inputTokens, model, modelWindows);

const COMPRESSION_THRESHOLD_PCT = 70;

async function resolveAgentByName(
  sessionId: string,
  agentName: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const sa = await prisma.sessionAgent.findFirst({
      where: { sessionId, agent: { name: agentName } },
      select: { agent: { select: { id: true, name: true } } },
    });
    return sa?.agent ?? null;
  } catch { return null; }
}

/**
 * Synchronous agent name resolver for AgentCoordinator callbacks.
 * Supports prefix matching: 'code-agent' → 'code-agent-6064e856'.
 * Uses the agentRuntime singleton's agents map to find matching names.
 */
function resolveAgentByNameSync(sessionId: string, agentType: string): string | null {
  const normalized = agentType.toLowerCase();
  // Access the private agents map through the singleton
  const agentsMap = (agentRuntime as any).agents as Map<string, AgentEntry>;
  if (agentsMap) {
    for (const [id, entry] of agentsMap) {
      const name = entry.currentAgentName || entry.lastAgentId;
      if (name) {
        const lower = name.toLowerCase();
        if (lower === normalized || lower.startsWith(normalized + '-')) {
          return name;
        }
      }
    }
  }
  // Fallback to session agent name cache (populated at sandbox init, shared with taskDispatcher)
  const nameCache = sessionAgentNames.get(sessionId);
  if (nameCache) {
    const cached = nameCache.get(normalized);
    if (cached) return cached;
  }
  // Target agent not found — return null to skip inbox write
  return null;
}

function buildCompressionPrompt(contextPct: number): string {
  return `## Context Compression Required

Your context window is approximately ${contextPct}% full. Before processing the next user request,
please write a **concise summary** of the conversation so far.

Include in your summary:
1. **User's original goal** — what the user asked you to do
2. **Key decisions** — important choices made and why
3. **Current state** — what files exist, what's working, what's not
4. **Pending items** — what still needs to be done

Format your summary as structured markdown. This summary will serve as the
starting context for your next session, so be thorough but concise.
After writing the summary, I will process your next user request.`;
}

class AgentRuntime {
  private agents = new Map<string, AgentEntry>();
  // Track token usage per message for persistence on completion
  private tokenUsageMap = new Map<string, {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  }>();

  constructor() {
    // Periodic cleanup: evict stale tokenUsageMap entries to prevent memory leaks
    // (entries may linger if agent crashes and 'done' event never fires)
    setInterval(() => {
      if (this.tokenUsageMap.size > 1000) {
        const entries = [...this.tokenUsageMap.entries()];
        const cutoff = entries.length - 500;
        for (let i = 0; i < cutoff; i++) {
          this.tokenUsageMap.delete(entries[i][0]);
        }
        console.log(`[AgentRuntime] Cleaned ${cutoff} stale tokenUsageMap entries`);
      }
    }, 5 * 60 * 1000);
  }

  /** Send a prompt to an agent. Queues if busy, starts container if stopped. */
  async sendPrompt(agentId: string, sessionId: string, prompt: string, agentMessageId?: string, sandbox?: SandboxInfo, trustMode = true): Promise<void> {
    let entry = this.agents.get(agentId);

    if (!entry) {
      const sessionPermMode = sessionPermissionModes.get(sessionId) || 'ask';
      entry = await this.ensureRunning(agentId, sandbox, trustMode, sessionPermMode);
    }

    // Detect container mismatch: agent was running in a different session's container.
    // Only switch when agent is idle — if busy, queue the request.
    if (sandbox && entry.containerId !== sandbox.containerId) {
      if (entry.currentSession !== null && entry.currentSession !== sessionId) {
        // Agent is busy with another session — queue
        entry.queue.push({ sessionId, prompt, agentMessageId });
        broadcast(sessionId, {
          type: 'agent_queued',
          agentId,
          agentMessageId,
          message: `Agent is busy. Position in queue: ${entry.queue.length}`,
        });
        return;
      }
      // Agent is idle but in wrong container — switch containers
      await this.rehomeAgent(agentId, entry, sandbox);
    }

    if (entry.currentSession !== null && entry.currentSession !== sessionId) {
      // Agent is busy with another session — queue
      entry.queue.push({ sessionId, prompt, agentMessageId });
      broadcast(sessionId, {
        type: 'agent_queued',
        agentId,
        agentMessageId,
        message: `Agent is busy. Position in queue: ${entry.queue.length}`,
      });
      return;
    }

    // Agent is idle — send directly
    entry.currentSession = sessionId;
    entry.currentMessageId = agentMessageId || null;
    entry.currentAgentId = agentId;
    entry.lastSessionId = sessionId;
    entry.lastMessageId = agentMessageId || null;
    entry.lastAgentId = agentId;
    entry.accumulatedOutput = ''; // Reset accumulated output for new task
    entry.intentScanOffset = 0;
    this.clearIdleTimer(entry);

    // --- Context Compression ---
    if (entry.needsCompression && entry.compressionPhase === 'none') {
      entry.needsCompression = false;
      entry.compressionPhase = 'summarizing';
      entry.compressionPendingPrompt = prompt;

      const compressionPct = entry.currentMessageId
        ? calcPct(this.tokenUsageMap.get(entry.currentMessageId)?.input ?? 0, entry.model)
        : 75;
      const compressionPrompt = buildCompressionPrompt(compressionPct);
      entry.provider.sendPrompt(compressionPrompt);
      return;
    }
    // --- End Context Compression ---

    entry.provider.sendPrompt(prompt);
  }

  /** Ensure agent container and REPL are running. Lazy-start if stopped. */
  async ensureRunning(agentId: string, sandbox?: SandboxInfo, trustMode = true, sessionPermissionMode = 'trust'): Promise<AgentEntry> {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    // Use session sandbox if provided (solo sessions), otherwise create agent container
    let containerId: string;
    let hostWorkDir: string;

    if (sandbox) {
      // Reuse session sandbox — agent config goes to sandbox dir, user work to workspace
      containerId = sandbox.containerId;
      hostWorkDir = sandbox.hostWorkDir;
      // Initialize agent directory in the sandbox dir (not user workspace)
      AgentDirectoryManager.initialize(sandbox.hostSandboxDir, agent.name, agent.systemPrompt, null, undefined, agent.skills as any[] | null, agentId);
      // Update agent record with session sandbox info
      await prisma.agent.update({
        where: { id: agentId },
        data: { containerId, containerStatus: 'running', hostWorkDir },
      }).catch((e) => console.error('[AgentRuntime] Failed to update agent sandbox info:', e));
    } else {
      // Fallback: create dedicated agent container
      if (!agent.containerId || agent.containerStatus === 'stopped') {
        const info = await AgentContainer.create(agentId, agent.systemPrompt);
        AgentDirectoryManager.initialize(info.hostWorkDir, agent.name, agent.systemPrompt, null, undefined, agent.skills as any[] | null, agentId);
        await prisma.agent.update({
          where: { id: agentId },
          data: { containerId: info.containerId, containerStatus: 'running', hostWorkDir: info.hostWorkDir },
        });
        agent.containerId = info.containerId;
        agent.hostWorkDir = info.hostWorkDir;
      }
      containerId = agent.containerId!;
      hostWorkDir = agent.hostWorkDir!;
    }

    // Ensure agent persistent home exists at .agents/<agentId>/
    AgentDirectoryManager.ensureAgentHome(agentId, agent.name, agent.systemPrompt, agent.skills as any[] | null);

    const provider = ProviderFactory.create(agent.provider);
    const hostSandboxDir = sandbox ? sandbox.hostSandboxDir : hostWorkDir;
    const agentHomeDir = AgentDirectoryManager.getAgentHome(agentId);
    await provider.start(
      'agent-' + agentId,
      'Standby — waiting for tasks',
      containerId,
      '/workspace',
      {
        apiKey: (agent.providerConfig as any)?.apiKey,
        model: (agent.providerConfig as any)?.model,
        hostWorkDir,
        hostSandboxDir,
        agentHomeDir,
        agentName: agent.name,
        trustMode,
        sessionPermissionMode,
      },
    );

    const isPlanner = agent.name === 'planner' || agent.name.startsWith('planner-');
    const model = (agent.providerConfig as any)?.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const entry: AgentEntry = {
      provider,
      containerId,
      hostWorkDir,
      hostSandboxDir,
      idleTimer: null,
      currentSession: null,
      currentMessageId: null,
      currentAgentId: null,
      currentAgentName: agent.name,
      queue: [],
      sharedContainer: !!sandbox,
      isPlanner,
      accumulatedOutput: '',
      model,
      lastSessionId: null,
      lastMessageId: null,
      lastAgentId: null,
      needsCompression: false,
      compressionPhase: 'none' as const,
      compressionPendingPrompt: null,
      intentScanOffset: 0,
      notifiedKeys: new Set<string>(),
      trustMode,
      sessionPermissionMode,
    };

    provider.onEvent((event: UnifiedAgentEvent) => {
      void this.handleAgentEvent(agentId, entry, event);
    });

    this.agents.set(agentId, entry);
    console.log(`[AgentRuntime] Agent ${agent.name} running (container=${entry.containerId.slice(0, 12)})`);
    return entry;
  }

  /** Forward REPL events to the correct session, manage queue lifecycle */
  private async handleAgentEvent(agentId: string, entry: AgentEntry, event: UnifiedAgentEvent): Promise<void> {
    const sessionId = entry.currentSession || 'unknown';
    const agentMessageId = entry.currentMessageId || undefined;

    switch (event.type) {
      case 'thinking':
        if (event.content) {
          // Accumulate output for all agents so we can persist on completion
          entry.accumulatedOutput += event.content;
          broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId });

          // Real-time NEEDS HELP intent detection: scan new content as it arrives
          if (event.content.includes('NEEDS HELP')) {
            const newContent = entry.accumulatedOutput.slice(entry.intentScanOffset);
            const intents = IntentParser.scan(newContent);
            for (const intent of intents) {
              resolveAgentByName(sessionId, intent.targetAgentName).then(target => {
                if (target) {
                  InboxManager.write(entry.hostSandboxDir, target.name, {
                    type: 'help_request',
                    id: `help-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    from: entry.currentAgentName || entry.currentAgentId || 'unknown',
                    to: target.name,
                    summary: intent.description,
                    risk: 'low',
                    timestamp: Date.now(),
                  }, sessionId);
                  broadcast(sessionId, {
                    type: 'inbox_update',
                    agentName: target.name,
                    summary: intent.description,
                    timestamp: Date.now(),
                  });
                }
              });
            }
            entry.intentScanOffset = entry.accumulatedOutput.length;
          }
        }
        break;
      case 'tool_use':
        broadcast(sessionId, {
          type: 'agent_status',
          status: 'tool_use',
          agentMessageId,
          details: { toolName: event.toolName, input: event.toolInput },
        });
        // Wire AgentCoordinator: permission check + event routing
        {
          const toolInput = event.toolInput || {};
          const filePath = (toolInput as any).file_path || (toolInput as any).path || (toolInput as any).filePath;
          agentCoordinator.onToolUse({
            sessionId,
            agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
            agentType: entry.currentAgentName || entry.currentAgentId || 'unknown',
            messageId: agentMessageId || '',
            hostWorkDir: entry.hostWorkDir,
            hostSandboxDir: entry.hostSandboxDir,
            resolveAgent: (type: string) => resolveAgentByNameSync(sessionId, type),
            broadcast,
            notifiedKeys: entry.notifiedKeys,
          }, {
            type: 'tool_use',
            toolName: event.toolName || '',
            input: toolInput,
          } as any);
          // Broadcast file production milestone for chat agents
          MilestoneBroadcaster.classify({
            sessionId,
            agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
            agentMessageId: agentMessageId || '',
            eventType: event.toolName || '',
            toolName: event.toolName || '',
            filePath: typeof filePath === 'string' ? filePath : undefined,
          });
        }
        break;
      case 'tool_result':
        broadcast(sessionId, {
          type: 'agent_status',
          status: 'tool_result',
          agentMessageId,
          details: { resultPreview: (event.content || '').slice(0, 200) },
        });
        // Wire AgentCoordinator: route tool results
        agentCoordinator.onToolResult({
          sessionId,
          agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
          agentType: entry.currentAgentName || entry.currentAgentId || 'unknown',
          messageId: agentMessageId || '',
          hostWorkDir: entry.hostWorkDir,
          hostSandboxDir: entry.hostSandboxDir,
          resolveAgent: (type: string) => resolveAgentByNameSync(sessionId, type),
          broadcast,
          notifiedKeys: entry.notifiedKeys,
        }, event.content || '');
        break;
      case 'permission_request': {
        const requestId = event.requestId;
        const permId = event.permissionId;

        // CONTROL_REQUEST path (SDK native): Write/Edit/MultiEdit trigger popup.
        // Non-write tools are pre-approved via allowedTools and never reach here.
        if (requestId && agentMessageId) {
          const timeoutMs = config.agent.permissionTimeoutMs;
          const routedId = `${agentMessageId}|::|${requestId}`;
          broadcast(sessionId, {
            type: 'permission_request',
            agentMessageId,
            permissionId: routedId,
            tool: event.tool,
            path: event.path,
            toolInput: event.toolInput,
            timestamp: event.timestamp,
          });
          const timeout = setTimeout(() => {
            const stateMap = agentStates.get(sessionId);
            const st = stateMap?.get(agentMessageId);
            if (st?.process?.respondControlRequest) {
              st.process.respondControlRequest(requestId, true);
            }
            permissionTimeouts.delete(routedId);
          }, timeoutMs);
          permissionTimeouts.set(routedId, timeout);
          break;
        }

        // Legacy custom_permission_request path (fallback)
        if (permId && agentMessageId) {
          const timeoutMs = config.agent.permissionTimeoutMs;
          const routedPermId = `${agentMessageId}|::|${permId}`;
          broadcast(sessionId, {
            type: 'permission_request',
            agentMessageId,
            permissionId: routedPermId,
            tool: event.tool,
            path: event.path,
            toolInput: event.toolInput,
            timestamp: event.timestamp,
          });
          const timeout = setTimeout(() => {
            const stateMap = agentStates.get(sessionId);
            const st = stateMap?.get(agentMessageId);
            if (st?.process?.respondToPermission) {
              st.process.respondToPermission(permId, true);
            }
            permissionTimeouts.delete(routedPermId);
          }, timeoutMs);
          permissionTimeouts.set(routedPermId, timeout);
        }
        break;
      }
      case 'done':
        // --- Handle compression completion ---
        if (entry.compressionPhase === 'summarizing') {
          const summary = entry.accumulatedOutput?.slice(0, 3000) || 'Conversation state preserved.';
          const pendingPrompt = entry.compressionPendingPrompt || 'Continue.';
          entry.compressionPhase = 'none';
          entry.compressionPendingPrompt = null;
          entry.accumulatedOutput = '';
          entry.intentScanOffset = 0;

          try {
            const summaryDir = resolve(entry.hostWorkDir, `_agent_${entry.currentAgentId || 'agent'}`);
            mkdirSync(summaryDir, { recursive: true });
            writeFileSync(resolve(summaryDir, '_context_summary.md'), summary, 'utf-8');
          } catch {}

          try { entry.provider.stop(); } catch {}
          const fullPrompt = `## Previous Session Summary\n\n${summary}\n\n---\n\n## New Request\n\n${pendingPrompt}`;
          await entry.provider.start(
            'agent-' + agentId,
            fullPrompt,
            entry.containerId,
            '/workspace',
            { hostWorkDir: entry.hostWorkDir, trustMode: entry.trustMode, sessionPermissionMode: entry.sessionPermissionMode, agentName: entry.currentAgentName || undefined },
          );

          entry.provider.onEvent((e: UnifiedAgentEvent) => {
            this.handleAgentEvent(agentId, entry, e);
          });
          break;
        }
        // --- End compression completion ---

        broadcast(sessionId, { type: 'stream_end', exitCode: event.exitCode ?? 0, agentMessageId });

        // Wire AgentCoordinator: route agent completion events
        agentCoordinator.onAgentDone({
          sessionId,
          agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
          agentType: entry.currentAgentName || entry.currentAgentId || 'unknown',
          messageId: agentMessageId || '',
          hostWorkDir: entry.hostWorkDir,
          hostSandboxDir: entry.hostSandboxDir,
          resolveAgent: (type: string) => resolveAgentByNameSync(sessionId, type),
          broadcast,
          notifiedKeys: entry.notifiedKeys,
        }, event.exitCode ?? 0, entry.accumulatedOutput?.slice(0, 3000) || '');

        // Route NEEDS HELP intents to target agent inboxes
        if (entry.accumulatedOutput) {
          const helpIntents = IntentParser.scan(entry.accumulatedOutput);
          for (const intent of helpIntents) {
            const target = await resolveAgentByName(sessionId, intent.targetAgentName);
            if (target) {
              InboxManager.write(entry.hostSandboxDir, target.name, {
                type: 'help_request',
                id: `help-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                from: entry.currentAgentName || entry.currentAgentId || 'unknown',
                to: target.name,
                summary: intent.description,
                risk: 'low',
                timestamp: Date.now(),
              }, sessionId);
              broadcast(sessionId, {
                type: 'inbox_update',
                agentName: target.name,
                summary: intent.description,
                timestamp: Date.now(),
              });
            }
          }
        }

        if (agentMessageId) {
          // Record after-version and broadcast diff summary
          const beforeVer = takeMessageBeforeVersion(agentMessageId);
          if (beforeVer) {
            broadcastDiffSummary(
              sessionId, agentMessageId, entry.hostWorkDir,
              beforeVer, entry.currentAgentName || entry.currentAgentId || 'agent',
              `After ${entry.currentAgentName || entry.currentAgentId} turn`,
            );
          }

          clearRunningAgent(sessionId, agentMessageId);
          void prisma.message.updateMany({
            where: { id: agentMessageId, status: 'streaming' },
            data: {
              status: 'done',
              ...(entry.accumulatedOutput ? { content: entry.accumulatedOutput } : {}),
            },
          }).catch(() => {});
        }

        // Parse planner output and broadcast plan_result.
        // Primary path: onPlanReady hook (shared with PlanWatcher).
        // Fallback: text extraction from output (when Write tool unavailable).
        if (entry.isPlanner && entry.accumulatedOutput) {
          const planPath = `${entry.hostWorkDir}/plan.json`;
          let planHandled = false;

          if (existsSync(planPath)) {
            try {
              const { onPlanReady } = await import('../ws/planWatcher.js');
              await onPlanReady(sessionId, entry.hostWorkDir, {
                containerId: entry.containerId,
                workDir: '/workspace',
                hostWorkDir: entry.hostWorkDir,
              });
              planHandled = true;
              console.log(`[AgentRuntime] Plan dispatched via onPlanReady: session=${sessionId.slice(0, 8)}`);
            } catch (err: any) {
              console.warn(`[AgentRuntime] onPlanReady failed, falling back to text extraction: ${err.message}`);
            }
          }

          if (!planHandled) {
            const plan = extractAndValidate(entry.accumulatedOutput);
            if (plan) {
              const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              broadcast(sessionId, {
                type: 'plan_result',
                planId,
                planTitle: plan.planTitle,
                summary: plan.summary,
                risk: 'low',
                requiresConfirmation: true,
                tasks: plan.tasks.map((t) => ({
                  taskId: t.id,
                  planId,
                  title: t.title,
                  description: t.description,
                  agentType: t.agentType,
                  dependsOn: t.dependsOn,
                  expectedOutput: t.expectedOutput,
                  priority: t.priority,
                  status: 'waiting',
                })),
                missingAgents: plan.missingAgents,
              });
              console.log(`[AgentRuntime] Plan parsed from text fallback: planId=${planId} tasks=${plan.tasks.length}`);
            } else {
              console.warn(`[AgentRuntime] Failed to parse planner output for agent ${agentId}`);
            }
          }
          entry.accumulatedOutput = '';
          entry.intentScanOffset = 0;
        }

        // Clear accumulated output for ALL agents after done
        entry.accumulatedOutput = '';

        // Backfill QuoteReference with the agent's response message ID (exact ID match)
        if (agentMessageId) {
          const backfillInfo = quoteBackfillMap.get(agentMessageId);
          if (backfillInfo) {
            quoteBackfillMap.delete(agentMessageId);
            prisma.quoteReference.update({
              where: { id: backfillInfo.quoteReferenceId },
              data: { targetMessageId: agentMessageId, agentId: backfillInfo.agentId || undefined },
            }).catch(() => {});
          }
        }
        // Persist token usage to database
        if (agentMessageId) {
          const tokenUsage = this.tokenUsageMap.get(agentMessageId);
          if (tokenUsage) {
            // 1. Update Message record with token usage
            prisma.message.update({
              where: { id: agentMessageId },
              data: {
                inputTokens: tokenUsage.input,
                outputTokens: tokenUsage.output,
                cacheReadTokens: tokenUsage.cacheRead,
                cacheCreateTokens: tokenUsage.cacheCreate,
              },
            }).catch((e) => console.error('[AgentRuntime] Failed to persist token usage:', e));

            // 2. Update SessionAgent summary
            if (entry.currentAgentId) {
              prisma.sessionAgent.update({
                where: {
                  sessionId_agentId: { sessionId, agentId: entry.currentAgentId },
                },
                data: {
                  totalInputTokens: { increment: tokenUsage.input },
                  totalOutputTokens: { increment: tokenUsage.output },
                  totalCacheReadTokens: { increment: tokenUsage.cacheRead },
                  totalCacheCreateTokens: { increment: tokenUsage.cacheCreate },
                  messageCount: { increment: 1 },
                },
              }).catch((e) => console.error('[AgentRuntime] Failed to update session agent stats:', e));
            }

            this.tokenUsageMap.delete(agentMessageId);
          }
        }
        entry.currentSession = null;
        entry.currentMessageId = null;
        entry.currentAgentId = null;
        this.processNextOrIdle(agentId, entry);
        break;
      case 'error':
        broadcast(sessionId, { type: 'stream_error', error: event.message, agentMessageId });
        if (agentMessageId) {
          void prisma.message.updateMany({
            where: { id: agentMessageId, status: 'streaming' },
            data: {
              status: 'error',
              ...(entry.accumulatedOutput ? { content: entry.accumulatedOutput } : {}),
            },
          }).catch(() => {});
          clearRunningAgent(sessionId, agentMessageId);
          this.tokenUsageMap.delete(agentMessageId);
        }
        // Reset accumulated output for all agents
        entry.accumulatedOutput = '';
        entry.intentScanOffset = 0;
        entry.currentSession = null;
        entry.currentMessageId = null;
        entry.currentAgentId = null;
        this.processNextOrIdle(agentId, entry);
        break;
      case 'token_usage': {
        // Use current message context, or fall back to last* (after 'done' cleared current*)
        const tokMsgId = agentMessageId || entry.lastMessageId;
        const tokSessionId = sessionId !== 'unknown' ? sessionId : entry.lastSessionId || sessionId;
        const tokAgentId = entry.currentAgentId || entry.lastAgentId;
        // Accumulate token usage across multiple API calls per message
        if (tokMsgId) {
          const prev = this.tokenUsageMap.get(tokMsgId);
          const cumulative = {
            input: (prev?.input ?? 0) + (event.inputTokens ?? 0),
            output: (prev?.output ?? 0) + (event.outputTokens ?? 0),
            cacheRead: (prev?.cacheRead ?? 0) + (event.cacheReadTokens ?? 0),
            cacheCreate: (prev?.cacheCreate ?? 0) + (event.cacheCreateTokens ?? 0),
          };
          this.tokenUsageMap.set(tokMsgId, cumulative);
          // Broadcast cumulative totals so the dashboard shows overall consumption
          broadcast(tokSessionId, {
            type: 'token_update',
            agentMessageId: tokMsgId,
            details: {
              tokenUsage: {
                input: cumulative.input,
                output: cumulative.output,
                cacheRead: cumulative.cacheRead,
                cacheCreate: cumulative.cacheCreate,
                contextPct: calcPct(cumulative.input, entry.model),
                model: entry.model,  // pass model to frontend so it doesn't need to guess
              },
            },
          });
          // Check if context usage exceeds compression threshold
          const contextPct = calcPct(cumulative.input, entry.model);
          if (contextPct > COMPRESSION_THRESHOLD_PCT) {
            entry.needsCompression = true;
          }
        }
        // If done already fired, persist now since the done handler couldn't
        if (!agentMessageId && tokMsgId) {
          const tokUsage = this.tokenUsageMap.get(tokMsgId);
          if (tokUsage) {
            prisma.message.update({
              where: { id: tokMsgId },
              data: {
                inputTokens: tokUsage.input,
                outputTokens: tokUsage.output,
                cacheReadTokens: tokUsage.cacheRead,
                cacheCreateTokens: tokUsage.cacheCreate,
              },
            }).catch((e) => console.error('[AgentRuntime] Late token persist failed:', e));
            if (tokAgentId) {
              prisma.sessionAgent.update({
                where: { sessionId_agentId: { sessionId: tokSessionId, agentId: tokAgentId } },
                data: {
                  totalInputTokens: { increment: tokUsage.input },
                  totalOutputTokens: { increment: tokUsage.output },
                  totalCacheReadTokens: { increment: tokUsage.cacheRead },
                  totalCacheCreateTokens: { increment: tokUsage.cacheCreate },
                  messageCount: { increment: 1 },
                },
              }).catch(() => {});
            }
            this.tokenUsageMap.delete(tokMsgId);
          }
        }
        break;
      }
    }
  }

  /** Process next queue item or start idle timer */
  private processNextOrIdle(agentId: string, entry: AgentEntry): void {
    const next = entry.queue.shift();
    if (next) {
      entry.currentSession = next.sessionId;
      entry.currentMessageId = next.agentMessageId || null;
      entry.currentAgentId = agentId;
      // Reset intent scan offset for the new prompt
      entry.intentScanOffset = 0;
      entry.accumulatedOutput = '';
      entry.provider.sendPrompt(next.prompt);
    } else {
      // Agent becomes idle — check if other agents have pending inbox messages
      const sessionId = entry.currentSession || entry.lastSessionId;
      if (sessionId && sessionId !== 'unknown') {
        import('./InboxWakeup.js').then(({ InboxWakeup }) => {
          // Check inboxes of agents known to this runtime
          for (const [id, otherEntry] of this.agents) {
            const name = otherEntry.currentAgentName || otherEntry.lastAgentId;
            if (name && name !== (entry.currentAgentName || entry.lastAgentId)) {
              InboxWakeup.check(
                sessionId, name, entry.hostWorkDir,
                (n) => this.isAgentActive(n),
                broadcast,
              );
            }
          }
        }).catch(() => {});
        // Drain sequential multi-@mention queue (dynamic import to avoid circular dep)
        import('../ws/chatHandlers.js').then(({ startNextSequential }) => {
          startNextSequential(sessionId);
        }).catch(() => {});
      }
      entry.idleTimer = setTimeout(() => {
        this.stopContainer(agentId);
      }, config.agentContainer.idleTimeoutMs);
    }
  }

  /** Stop agent container after idle timeout */
  async stopContainer(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    this.clearIdleTimer(entry);
    try { entry.provider.stop(); } catch { /* best effort */ }

    // Only destroy dedicated agent containers, NOT shared session sandboxes
    if (!entry.sharedContainer) {
      await AgentContainer.destroy(entry.containerId).catch(() => {});
      await prisma.agent.update({
        where: { id: agentId },
        data: { containerStatus: 'stopped' },
      }).catch(() => {});
    }

    this.agents.delete(agentId);
    console.log(`[AgentRuntime] Agent ${agentId.slice(0, 8)} ${entry.sharedContainer ? 'detached from sandbox' : 'container stopped'} (idle timeout)`);
  }

  /** Get queue status for an agent */
  getQueueStatus(agentId: string): { pending: number; currentSession: string | null } {
    const entry = this.agents.get(agentId);
    return {
      pending: entry?.queue.length ?? 0,
      currentSession: entry?.currentSession ?? null,
    };
  }

  /** Check if agent is currently running */
  isRunning(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** Check if an agent (by name) is currently active (has a current session). */
  isAgentActive(agentName: string): boolean {
    for (const [id, entry] of this.agents) {
      const name = entry.currentAgentName || entry.lastAgentId;
      if (name === agentName && entry.currentSession !== null) return true;
    }
    return false;
  }

  /** Switch agent to a different session's container without losing persistent identity. */
  private async rehomeAgent(agentId: string, entry: AgentEntry, sandbox: SandboxInfo): Promise<void> {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    console.log(`[AgentRuntime] Rehome agent ${agent.name}: container ${entry.containerId.slice(0, 12)} → ${sandbox.containerId.slice(0, 12)}`);

    // Stop current provider
    try { entry.provider.stop(); } catch { /* best effort */ }

    // Create new provider in target container
    const provider = ProviderFactory.create(agent.provider);
    const agentHomeDir = AgentDirectoryManager.getAgentHome(agentId);
    await provider.start(
      'agent-' + agentId,
      'Standby — waiting for tasks',
      sandbox.containerId,
      '/workspace',
      {
        apiKey: (agent.providerConfig as any)?.apiKey,
        model: (agent.providerConfig as any)?.model,
        hostWorkDir: sandbox.hostWorkDir,
        hostSandboxDir: sandbox.hostSandboxDir,
        agentHomeDir,
        agentName: agent.name,
        trustMode: entry.trustMode,
        sessionPermissionMode: entry.sessionPermissionMode,
      },
    );

    provider.onEvent((event: UnifiedAgentEvent) => {
      void this.handleAgentEvent(agentId, entry, event);
    });

    // Update entry to point to new container
    entry.provider = provider;
    entry.containerId = sandbox.containerId;
    entry.hostWorkDir = sandbox.hostWorkDir;

    // Update DB
    await prisma.agent.update({
      where: { id: agentId },
      data: { containerId: sandbox.containerId, containerStatus: 'running', hostWorkDir: sandbox.hostWorkDir },
    }).catch((e) => console.error('[AgentRuntime] Failed to update agent after rehome:', e));
  }

  /** Stop current task processing for an agent. Provider stays alive for next task. */
  stopProcessing(agentId: string): { sessionId: string | null; messageId: string | null } {
    const entry = this.agents.get(agentId);
    if (!entry) return { sessionId: null, messageId: null };

    const sessionId = entry.currentSession;
    const messageId = entry.currentMessageId;
    try { entry.provider.stopChild?.(); } catch { /* best effort */ }
    entry.currentSession = null;
    entry.currentMessageId = null;
    this.processNextOrIdle(agentId, entry);
    return { sessionId, messageId };
  }

  private clearIdleTimer(entry: AgentEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}

export const agentRuntime = new AgentRuntime();
