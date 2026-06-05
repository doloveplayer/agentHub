import { InboxManager } from './InboxManager.js';
import { prisma } from '../db/prisma.js';

// Lightweight agent description cache per session
const agentDescCache = new Map<string, Map<string, string>>();

async function resolveSenderDescriptions(
  sessionId: string,
  entries: Array<{ from: string }>,
): Promise<Map<string, string>> {
  const cache = agentDescCache.get(sessionId);
  const uniqueSenders = [...new Set(entries.map(e => e.from))];
  const uncached = uniqueSenders.filter(name => !cache?.has(name));

  if (uncached.length > 0 && sessionId) {
    try {
      const agents = await prisma.sessionAgent.findMany({
        where: { sessionId, agent: { name: { in: uncached } } },
        select: { agent: { select: { name: true, description: true } } },
      });
      if (!agentDescCache.has(sessionId)) {
        agentDescCache.set(sessionId, new Map());
      }
      const sessionCache = agentDescCache.get(sessionId)!;
      for (const sa of agents) {
        sessionCache.set(sa.agent.name, sa.agent.description || '');
      }
    } catch { /* graceful degradation */ }
  }

  return cache ?? new Map();
}

/**
 * Checks whether an agent has unread inbox messages and should be awakened.
 * When an agent is idle but has pending inbox messages, broadcasts a
 * suggestion to the user via WebSocket system message.
 */
export class InboxWakeup {
  /**
   * Check an agent's inbox and suggest waking them if needed.
   * @returns true if the agent has unread messages
   */
  static check(
    sessionId: string,
    agentName: string,
    hostSandboxDir: string,
    isAgentRunning: (agentName: string) => boolean,
    broadcast: (sessionId: string, data: unknown) => void,
  ): boolean {
    const count = InboxManager.unreadCount(hostSandboxDir, agentName);
    if (count === 0) return false;

    if (!isAgentRunning(agentName)) {
      broadcast(sessionId, {
        type: 'inbox_wake_up',
        agentName,
        count,
        suggestion: `@${agentName} has ${count} unread message(s) from other agents. @mention to check inbox.`,
        timestamp: Date.now(),
      });
    }

    return true;
  }

  /**
   * Build the inbox injection prompt for an agent that's about to start.
   * Reads and clears the inbox, injecting messages directly into the prompt.
   */
  static async buildInboxPrompt(agentName: string, hostSandboxDir: string, sessionId?: string): Promise<string> {
    const entries = InboxManager.read(hostSandboxDir, agentName, sessionId);
    if (entries.length === 0) return '';

    const descriptions = sessionId
      ? await resolveSenderDescriptions(sessionId, entries)
      : new Map<string, string>();

    const highRisk = entries.filter(e => e.risk === 'high');
    const lowRisk = entries.filter(e => e.risk !== 'high');

    let block = `\n\n## Inbox (${entries.length} new messages from other agents)\n\n`;
    if (highRisk.length > 0) {
      block += `### High Priority — please address these\n`;
      for (const e of highRisk) {
        const desc = descriptions.get(e.from);
        const tag = desc ? ` (${desc})` : '';
        block += `- [HIGH] From **${e.from}**${tag}: ${e.summary}\n`;
      }
    }
    if (lowRisk.length > 0) {
      block += `### Info\n`;
      for (const e of lowRisk) {
        const desc = descriptions.get(e.from);
        const tag = desc ? ` (${desc})` : '';
        block += `- From **${e.from}**${tag}: ${e.summary}\n`;
      }
    }
    block += `\nRespond to high-priority messages first. You can reply to other agents by outputting "NEEDS HELP from @AgentName: <your response>" or by completing the requested work.`;

    return block;
  }
}
