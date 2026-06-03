import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

function norm(name: string): string {
  return name.toLowerCase();
}

export interface InboxEntry {
  type: 'intervention_request' | 'intervention_response' | 'context_update' | 'help_request';
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
   * Resolve the inbox file path for an agent.
   * Inbox files live at {hostSandboxDir}/_agent_{agentName}/_inbox.jsonl
   * which maps to /sandbox/_agent_{agentName}/_inbox.jsonl inside the container.
   */
  static resolveInboxPath(hostSandboxDir: string, agentName: string): string {
    const agentDir = resolve(hostSandboxDir, `_agent_${norm(agentName)}`);
    return resolve(agentDir, '_inbox.jsonl');
  }

  /**
   * Create an empty inbox file if it doesn't exist.
   */
  static init(hostSandboxDir: string, agentName: string): void {
    const inboxPath = InboxManager.resolveInboxPath(hostSandboxDir, agentName);
    const dir = resolve(inboxPath, '..');
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
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
   */
  static write(hostSandboxDir: string, targetAgentName: string, entry: InboxEntry, sessionId?: string): void {
    if (entry.summary && entry.summary.length > 500) {
      console.warn(`[inbox] Large summary (${entry.summary.length} chars) from ${entry.from} to ${targetAgentName}`);
    }
    const inboxPath = InboxManager.resolveInboxPath(hostSandboxDir, targetAgentName);
    const dir = resolve(inboxPath, '..');
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
    const line = JSON.stringify(entry) + '\n';
    try {
      appendFileSync(inboxPath, line, 'utf-8');
    } catch (err: any) {
      console.error(`[inbox] Failed to write to ${targetAgentName}: ${err.message}`);
    }

    // Log to SessionCommLog
    if (sessionId) {
      import('./SessionCommLog.js').then(({ SessionCommLog }) => {
        SessionCommLog.log(sessionId, 'inbox', 'write', {
          from: entry.from,
          to: targetAgentName,
          type: entry.type,
          summary: entry.summary?.slice(0, 200),
          risk: entry.risk,
        });
      }).catch(() => {});
    }
  }

  /**
   * Read all unprocessed entries from an agent's inbox.
   * Returns entries and clears the file.
   */
  static read(hostSandboxDir: string, agentName: string, sessionId?: string): InboxEntry[] {
    const inboxPath = InboxManager.resolveInboxPath(hostSandboxDir, agentName);
    if (!existsSync(inboxPath)) return [];

    try {
      const raw = readFileSync(inboxPath, 'utf-8');
      // Clear after reading to prevent re-processing
      writeFileSync(inboxPath, '', 'utf-8');
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line) as InboxEntry; }
          catch { return null; }
        })
        .filter((e): e is InboxEntry => e !== null);

      // Log to SessionCommLog
      if (sessionId && entries.length > 0) {
        import('./SessionCommLog.js').then(({ SessionCommLog }) => {
          SessionCommLog.log(sessionId, 'inbox', 'read', {
            agentName,
            entryCount: entries.length,
            fromAgents: entries.map(e => e.from),
          });
        }).catch(() => {});
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Build the inbox-awareness system prompt fragment to inject
   * into agent prompts so they know how to check their inbox.
   */
  static inboxPrompt(agentName: string): string {
    const myInbox = `/sandbox/_agent_${norm(agentName)}/_inbox.jsonl`;
    return `\n## Multi-Agent Collaboration

You are part of a multi-agent session. Other agents may observe your work and contact you.

### YOUR INBOX: ${myInbox}

When the user asks about inbox contents (e.g. "check your inbox", "收件箱里有什么", "what's in your inbox"):
1. IMMEDIATELY read YOUR OWN inbox file at **${myInbox}** — use Bash: \`cat ${myInbox}\`
2. Report ONLY what is in YOUR inbox. Do NOT read or mention other agents' inbox files.
3. If your inbox is empty, say "My inbox is empty" — do NOT describe other agents' inboxes.

CRITICAL RULES:
- NEVER read inbox files belonging to other agents (e.g. _agent_code-agent, _agent_planner).
- NEVER volunteer to check what other agents received.
- Only access **${myInbox}**.

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
  static unreadCount(hostSandboxDir: string, agentName: string): number {
    const inboxPath = InboxManager.resolveInboxPath(hostSandboxDir, agentName);
    if (!existsSync(inboxPath)) return 0;
    try {
      const raw = readFileSync(inboxPath, 'utf-8');
      return raw.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }
}
