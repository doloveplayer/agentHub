import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function norm(name: string): string {
  return name.toLowerCase();
}

export interface InboxEntry {
  type: 'intervention_request' | 'intervention_response';
  id: string;
  from: string;       // agent name
  to: string;         // target agent name or messageId
  summary?: string;
  risk?: 'low' | 'high';
  accepted?: boolean;
  message?: string;
  timestamp: number;
}

export class InboxManager {
  /**
   * Create an empty inbox file if it doesn't exist.
   * Inbox files live at {hostWorkDir}/_inbox_{agentName}.jsonl
   */
  static init(hostWorkDir: string, agentName: string): void {
    const inboxPath = resolve(hostWorkDir, `_inbox_${norm(agentName)}.jsonl`);
    if (!existsSync(inboxPath)) {
      try {
        writeFileSync(inboxPath, '', 'utf-8');
      } catch (err: any) {
        console.error(`[inbox] Failed to init inbox for ${agentName}: ${err.message}`);
      }
    }
  }

  /**
   * Write an entry to an agent's inbox file.
   * Inbox files live at {hostWorkDir}/_inbox_{agentName}.jsonl
   */
  static write(hostWorkDir: string, targetAgentName: string, entry: InboxEntry): void {
    if (entry.summary && entry.summary.length > 500) {
      console.warn(`[inbox] Large summary (${entry.summary.length} chars) from ${entry.from} to ${targetAgentName}`);
    }
    const inboxPath = resolve(hostWorkDir, `_inbox_${norm(targetAgentName)}.jsonl`);
    const line = JSON.stringify(entry) + '\n';
    try {
      appendFileSync(inboxPath, line, 'utf-8');
    } catch (err: any) {
      console.error(`[inbox] Failed to write to ${targetAgentName}: ${err.message}`);
    }
  }

  /**
   * Read all unprocessed entries from an agent's inbox.
   * Returns entries and clears the file.
   */
  static read(hostWorkDir: string, agentName: string): InboxEntry[] {
    const inboxPath = resolve(hostWorkDir, `_inbox_${norm(agentName)}.jsonl`);
    if (!existsSync(inboxPath)) return [];

    try {
      const raw = readFileSync(inboxPath, 'utf-8');
      // Clear after reading to prevent re-processing
      writeFileSync(inboxPath, '', 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line) as InboxEntry; }
          catch { return null; }
        })
        .filter((e): e is InboxEntry => e !== null);
    } catch {
      return [];
    }
  }

  /**
   * Build the inbox-awareness system prompt fragment to inject
   * into agent prompts so they know how to check their inbox.
   */
  static inboxPrompt(agentName: string): string {
    return `\n## Multi-Agent Collaboration

You are part of a multi-agent session. Other agents may observe your work and contact you.

INBOX: Your inbox is at /workspace/_inbox_${norm(agentName)}.jsonl. Other agents may send you intervention requests here.
After completing each significant tool_use, read your inbox file and respond to any intervention requests:
  - If helpful and relevant, respond with accepted:true
  - If not relevant, respond with accepted:false and a brief reason

INTERVENE: You may offer help to other agents by asking the user to relay a message, or by noting your observations about their work.
  - LOW RISK (sharing info, suggesting approaches): mention it in your output
  - HIGH RISK (modifying code, running commands): ask the user first

BROADCAST: When you complete a significant phase or produce key output files, mention it so other agents can coordinate.`;
  }

  /**
   * Hub-driven coordination prompt fragment.
   * Injected into agent prompts so agents know they are part of
   * a hub-orchestrated multi-agent session.
   */
  static hubModePrompt(agentName: string): string {
    return `\n## Multi-Agent Coordination
You are part of a multi-agent session coordinated by AgentHub.

OTHER AGENTS: The hub will route important messages from other agents to you automatically.
When you receive a message from another agent, consider it carefully and respond if relevant.

PERMISSIONS: You have defined capabilities. If you attempt an operation outside your scope,
the hub will notify you and suggest delegating to the right agent.

COLLABORATION: If you encounter a problem that another agent should handle, output
a clear message like "NEEDS HELP from @CodeAgent: <description>" and the hub will route it.`;
  }

  /**
   * Count unread entries in an agent's inbox file.
   * Returns the number of non-empty lines. Returns 0 if the file doesn't exist.
   * Does NOT clear the file (unlike read()).
   */
  static unreadCount(hostWorkDir: string, agentName: string): number {
    const inboxPath = resolve(hostWorkDir, `_inbox_${norm(agentName)}.jsonl`);
    if (!existsSync(inboxPath)) return 0;
    try {
      const raw = readFileSync(inboxPath, 'utf-8');
      return raw.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }
}
