import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';

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
   * Write an entry to an agent's inbox file.
   * Inbox files live at {hostWorkDir}/_inbox_{agentName}.jsonl
   */
  static write(hostWorkDir: string, targetAgentName: string, entry: InboxEntry): void {
    const inboxPath = resolve(hostWorkDir, `_inbox_${targetAgentName}.jsonl`);
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
    const inboxPath = resolve(hostWorkDir, `_inbox_${agentName}.jsonl`);
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

INBOX: Your inbox is at /workspace/_inbox_${agentName}.jsonl. Other agents may send you intervention requests here.
After completing each significant tool_use, read your inbox file and respond to any intervention requests:
  - If helpful and relevant, respond with accepted:true
  - If not relevant, respond with accepted:false and a brief reason

INTERVENE: You may offer help to other agents by asking the user to relay a message, or by noting your observations about their work.
  - LOW RISK (sharing info, suggesting approaches): mention it in your output
  - HIGH RISK (modifying code, running commands): ask the user first

BROADCAST: When you complete a significant phase or produce key output files, mention it so other agents can coordinate.`;
  }
}
