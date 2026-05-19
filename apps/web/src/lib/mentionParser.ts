import type { Mention, AgentConfig } from '@agenthub/shared';

/**
 * Parse @AgentName mentions from input text.
 * Text between mentions is assigned to the preceding agent.
 * Text before the first @mention is broadcast context (prepended to all sub-prompts).
 */
export function parseMentions(text: string, agents: AgentConfig[]): {
  broadcastContext: string;
  mentions: Mention[];
} {
  const mentionRegex = /@(\S+)/g;
  const matches: { name: string; index: number; endIndex: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    matches.push({ name: match[1], index: match.index, endIndex: match.index + match[0].length });
  }

  if (matches.length === 0) {
    return { broadcastContext: '', mentions: [] };
  }

  // Text before first mention = broadcast context
  const broadcastContext = text.slice(0, matches[0].index).trim();

  const mentions: Mention[] = [];
  for (let i = 0; i < matches.length; i++) {
    const startIndex = matches[i].endIndex;
    const endIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const subPrompt = text.slice(startIndex, endIndex).trim();

    // Find matching agent (case-insensitive prefix match)
    const agent = findAgent(matches[i].name, agents);
    if (agent) {
      const fullPrompt = broadcastContext
        ? `${broadcastContext}\n\n${subPrompt}`
        : subPrompt;
      mentions.push({
        agentId: agent.id,
        agentName: agent.name,
        subPrompt: fullPrompt || text,
      });
    }
  }

  return { broadcastContext, mentions };
}

function findAgent(name: string, agents: AgentConfig[]): AgentConfig | undefined {
  const lower = name.toLowerCase();
  // Exact match first
  const exact = agents.find((a) => a.name === lower);
  if (exact) return exact;
  // Prefix match
  const prefix = agents.find((a) => a.name.startsWith(lower));
  if (prefix) return prefix;
  return undefined;
}

/**
 * Find agents matching @query for autocomplete.
 * Returns [] for empty query; otherwise prefix matches against name and displayName.
 */
export function matchAgents(query: string, agents: AgentConfig[]): AgentConfig[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  return agents.filter(
    (a) => a.name.toLowerCase().startsWith(lower) || a.displayName.toLowerCase().startsWith(lower),
  );
}