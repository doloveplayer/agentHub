// AgentRuntime — Global Agent Lifecycle Manager
// Manages all agent REPL processes globally (not per-session), handling
// lazy container startup, prompt queueing, and idle timeout shutdown.

import { existsSync } from 'fs';
import { ProviderFactory } from './providers/factory.js';
import type { AbstractProvider, UnifiedAgentEvent } from './providers/base.js';
import { AgentContainer } from './AgentContainer.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import { extractAndValidate } from './PlanValidator.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { broadcast, clearRunningAgent, quoteBackfillMap } from '../ws/state.js';

interface QueueItem {
  sessionId: string;
  prompt: string;
  agentMessageId?: string;
}

interface SandboxInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
}

interface AgentEntry {
  provider: AbstractProvider;
  containerId: string;
  hostWorkDir: string;
  idleTimer: NodeJS.Timeout | null;
  currentSession: string | null;
  currentMessageId: string | null;
  currentAgentId: string | null; // agent ID for current message
  queue: QueueItem[];
  sharedContainer: boolean; // true when using session sandbox (don't destroy on idle)
  isPlanner: boolean; // true if this agent is a planner
  accumulatedOutput: string; // accumulate output for planner agents
  model: string; // model name for context window calculation
}

/** Estimated context window sizes per model. Default 200K for Claude models. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-6': 200000,
  'claude-opus-4-7': 200000,
  'claude-haiku-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-opus-4-5': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'claude-3.5-sonnet': 200000,
  'claude-3.5-haiku': 200000,
  'gemini-2.5-pro': 1048576,
  'gemini-2.5-flash': 1048576,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
};

function calcContextPct(inputTokens: number, model: string): number {
  const window = MODEL_CONTEXT_WINDOWS[model] || 200000;
  return Math.round((inputTokens / window) * 100);
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

  /** Send a prompt to an agent. Queues if busy, starts container if stopped. */
  async sendPrompt(agentId: string, sessionId: string, prompt: string, agentMessageId?: string, sandbox?: SandboxInfo): Promise<void> {
    let entry = this.agents.get(agentId);

    if (!entry) {
      entry = await this.ensureRunning(agentId, sandbox);
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
    entry.accumulatedOutput = ''; // Reset accumulated output for new task
    this.clearIdleTimer(entry);
    entry.provider.sendPrompt(prompt);
  }

  /** Ensure agent container and REPL are running. Lazy-start if stopped. */
  async ensureRunning(agentId: string, sandbox?: SandboxInfo): Promise<AgentEntry> {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    // Use session sandbox if provided (solo sessions), otherwise create agent container
    let containerId: string;
    let hostWorkDir: string;

    if (sandbox) {
      // Reuse session sandbox — agent files go to .sandboxes/{sessionId}/
      containerId = sandbox.containerId;
      hostWorkDir = sandbox.hostWorkDir;
      // Initialize agent directory in the session sandbox
      AgentDirectoryManager.initialize(hostWorkDir, agent.name, agent.systemPrompt, null, undefined);
      // Update agent record with session sandbox info
      await prisma.agent.update({
        where: { id: agentId },
        data: { containerId, containerStatus: 'running', hostWorkDir },
      }).catch((e) => console.error('[AgentRuntime] Failed to update agent sandbox info:', e));
    } else {
      // Fallback: create dedicated agent container
      if (!agent.containerId || agent.containerStatus === 'stopped') {
        const info = await AgentContainer.create(agentId, agent.systemPrompt);
        AgentDirectoryManager.initialize(info.hostWorkDir, agent.name, agent.systemPrompt, null, undefined);
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

    const provider = ProviderFactory.create(agent.provider);
    await provider.start(
      'agent-' + agentId,
      'Standby — waiting for tasks',
      containerId,
      '/workspace',
      {
        apiKey: (agent.providerConfig as any)?.apiKey,
        model: (agent.providerConfig as any)?.model,
        hostWorkDir,
        trustMode: true,
      },
    );

    const isPlanner = agent.name === 'planner' || agent.name.startsWith('planner-');
    const model = (agent.providerConfig as any)?.model || 'claude-sonnet-4-6';
    const entry: AgentEntry = {
      provider,
      containerId,
      hostWorkDir,
      idleTimer: null,
      currentSession: null,
      currentMessageId: null,
      currentAgentId: null,
      queue: [],
      sharedContainer: !!sandbox,
      isPlanner,
      accumulatedOutput: '',
      model,
    };

    provider.onEvent((event: UnifiedAgentEvent) => {
      this.handleAgentEvent(agentId, entry, event);
    });

    this.agents.set(agentId, entry);
    console.log(`[AgentRuntime] Agent ${agent.name} running (container=${entry.containerId.slice(0, 12)})`);
    return entry;
  }

  /** Forward REPL events to the correct session, manage queue lifecycle */
  private handleAgentEvent(agentId: string, entry: AgentEntry, event: UnifiedAgentEvent): void {
    const sessionId = entry.currentSession || 'unknown';
    const agentMessageId = entry.currentMessageId || undefined;

    switch (event.type) {
      case 'thinking':
        if (event.content) {
          // Accumulate output for planner agents
          if (entry.isPlanner) {
            entry.accumulatedOutput += event.content;
          }
          broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId });
        }
        break;
      case 'tool_use':
        broadcast(sessionId, {
          type: 'agent_status',
          status: 'tool_use',
          agentMessageId,
          details: { toolName: event.toolName, input: event.toolInput },
        });
        break;
      case 'done':
        broadcast(sessionId, { type: 'stream_end', exitCode: event.exitCode ?? 0, agentMessageId });
        if (agentMessageId) clearRunningAgent(sessionId, agentMessageId);

        // Parse planner output and broadcast plan_result.
        // Primary path: plan.json written by Planner (detected by PlanWatcher).
        // Fallback: text extraction from output (when Write tool unavailable).
        if (entry.isPlanner && entry.accumulatedOutput) {
          const planPath = `${entry.hostWorkDir}/plan.json`;
          let planHandled = false;

          try {
            if (existsSync(planPath)) {
              // File watcher will handle this — skip text extraction
              planHandled = true;
            }
          } catch {}

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
        }

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
        // Clean up agent state on error (same as done case)
        if (agentMessageId) {
          clearRunningAgent(sessionId, agentMessageId);
          // Clean up token usage map
          this.tokenUsageMap.delete(agentMessageId);
        }
        // Reset planner accumulated output
        if (entry.isPlanner) {
          entry.accumulatedOutput = '';
        }
        entry.currentSession = null;
        entry.currentMessageId = null;
        entry.currentAgentId = null;
        this.processNextOrIdle(agentId, entry);
        break;
      case 'token_usage':
        // Store token usage in memory for persistence on completion
        if (agentMessageId) {
          this.tokenUsageMap.set(agentMessageId, {
            input: event.inputTokens ?? 0,
            output: event.outputTokens ?? 0,
            cacheRead: event.cacheReadTokens ?? 0,
            cacheCreate: event.cacheCreateTokens ?? 0,
          });
        }
        broadcast(sessionId, {
          type: 'token_update',
          agentMessageId,
          details: {
            tokenUsage: {
              input: event.inputTokens ?? 0,
              output: event.outputTokens ?? 0,
              cacheRead: event.cacheReadTokens ?? 0,
              cacheCreate: event.cacheCreateTokens ?? 0,
              contextPct: calcContextPct(event.inputTokens ?? 0, entry.model),
            },
          },
        });
        break;
    }
  }

  /** Process next queue item or start idle timer */
  private processNextOrIdle(agentId: string, entry: AgentEntry): void {
    const next = entry.queue.shift();
    if (next) {
      entry.currentSession = next.sessionId;
      entry.currentMessageId = next.agentMessageId || null;
      entry.currentAgentId = agentId;
      entry.provider.sendPrompt(next.prompt);
    } else {
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
