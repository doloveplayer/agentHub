/**
 * Parses agent text output for cross-agent collaboration intents.
 * When an agent outputs "NEEDS HELP from @AgentName: <description>",
 * the hub routes it to the target agent's inbox.
 */
export interface HelpIntent {
  targetAgentName: string;
  description: string;
}

const NEEDS_HELP_RE = /NEEDS HELP from @([\w][\w-]*):\s*(.+)/gim;

export class IntentParser {
  /**
   * Scan text for NEEDS HELP patterns.
   * Returns all matched intents with target agent name and description.
   */
  static scan(text: string): HelpIntent[] {
    const intents: HelpIntent[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = NEEDS_HELP_RE.exec(text)) !== null) {
      const targetAgentName = match[1].trim();
      const description = match[2].trim();
      const key = `${targetAgentName}:${description}`;
      if (!seen.has(key)) {
        seen.add(key);
        intents.push({ targetAgentName, description });
      }
    }
    NEEDS_HELP_RE.lastIndex = 0;
    return intents;
  }
}
