import { InboxManager } from './InboxManager.js';

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
    hostWorkDir: string,
    isAgentRunning: (agentName: string) => boolean,
    broadcast: (sessionId: string, data: unknown) => void,
  ): boolean {
    const count = InboxManager.unreadCount(hostWorkDir, agentName);
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
  static buildInboxPrompt(agentName: string, hostWorkDir: string): string {
    const entries = InboxManager.read(hostWorkDir, agentName);
    if (entries.length === 0) return '';

    const highRisk = entries.filter(e => e.risk === 'high');
    const lowRisk = entries.filter(e => e.risk !== 'high');

    let block = `\n\n## Inbox (${entries.length} new messages from other agents)\n\n`;
    if (highRisk.length > 0) {
      block += `### High Priority — please address these\n`;
      for (const e of highRisk) {
        block += `- [HIGH] From **${e.from}**: ${e.summary}\n`;
      }
    }
    if (lowRisk.length > 0) {
      block += `### Info\n`;
      for (const e of lowRisk) {
        block += `- From **${e.from}**: ${e.summary}\n`;
      }
    }
    block += `\nRespond to high-priority messages first. You can reply to other agents by outputting "NEEDS HELP from @AgentName: <your response>" or by completing the requested work.`;

    return block;
  }
}
