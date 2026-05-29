// AgentRuntime — Global Agent Lifecycle Manager
// Manages all agent REPL processes globally (not per-session), handling
// lazy container startup, prompt queueing, and idle timeout shutdown.

import { ProviderFactory } from './providers/factory.js';
import type { AbstractProvider, UnifiedAgentEvent } from './providers/base.js';
import { AgentContainer } from './AgentContainer.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { broadcast, clearRunningAgent, quoteBackfillMap } from '../ws/state.js';

interface QueueItem {
  sessionId: string;
  prompt: string;
  agentMessageId?: string;
}

interface AgentEntry {
  provider: AbstractProvider;
  containerId: string;
  hostWorkDir: string;
  idleTimer: NodeJS.Timeout | null;
  currentSession: string | null;
  currentMessageId: string | null;
  queue: QueueItem[];
}

class AgentRuntime {
  private agents = new Map<string, AgentEntry>();

  /** Send a prompt to an agent. Queues if busy, starts container if stopped. */
  async sendPrompt(agentId: string, sessionId: string, prompt: string, agentMessageId?: string): Promise<void> {
    let entry = this.agents.get(agentId);

    if (!entry) {
      entry = await this.ensureRunning(agentId);
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
    this.clearIdleTimer(entry);
    entry.provider.sendPrompt(prompt);
  }

  /** Ensure agent container and REPL are running. Lazy-start if stopped. */
  async ensureRunning(agentId: string): Promise<AgentEntry> {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    if (!agent.containerId || agent.containerStatus === 'stopped') {
      const info = await AgentContainer.create(agentId, agent.systemPrompt);
      AgentDirectoryManager.initialize(info.hostWorkDir, agent.name, agent.systemPrompt);
      await prisma.agent.update({
        where: { id: agentId },
        data: { containerId: info.containerId, containerStatus: 'running', hostWorkDir: info.hostWorkDir },
      });
      agent.containerId = info.containerId;
      agent.hostWorkDir = info.hostWorkDir;
    }

    const provider = ProviderFactory.create(agent.provider);
    await provider.start(
      'agent-' + agentId,
      'Standby — waiting for tasks',
      agent.containerId!,
      '/workspace',
      {
        apiKey: (agent.providerConfig as any)?.apiKey,
        model: (agent.providerConfig as any)?.model,
        hostWorkDir: agent.hostWorkDir!,
        trustMode: true,
      },
    );

    const entry: AgentEntry = {
      provider,
      containerId: agent.containerId!,
      hostWorkDir: agent.hostWorkDir!,
      idleTimer: null,
      currentSession: null,
      currentMessageId: null,
      queue: [],
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
        entry.currentSession = null;
        entry.currentMessageId = null;
        this.processNextOrIdle(agentId, entry);
        break;
      case 'error':
        broadcast(sessionId, { type: 'stream_error', error: event.message, agentMessageId });
        break;
      case 'token_usage':
        broadcast(sessionId, {
          type: 'token_update',
          agentMessageId,
          details: {
            tokenUsage: {
              input: event.inputTokens ?? 0,
              output: event.outputTokens ?? 0,
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
    await AgentContainer.destroy(entry.containerId).catch(() => {});
    this.agents.delete(agentId);

    await prisma.agent.update({
      where: { id: agentId },
      data: { containerStatus: 'stopped' },
    }).catch(() => {});

    console.log(`[AgentRuntime] Agent ${agentId.slice(0, 8)} container stopped (idle timeout)`);
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
