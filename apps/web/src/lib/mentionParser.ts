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

    // Find matching agent (case-insensitive alias/prefix match)
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
  const normalized = normalizeAgentHandle(name);
  if (!normalized) return undefined;

  // Exact match first
  const exact = agents.find((a) =>
    normalizeAgentHandle(a.name) === normalized ||
    normalizeAgentHandle(a.displayName) === normalized
  );
  if (exact) return exact;

  // Prefix match
  const prefix = agents.find((a) =>
    normalizeAgentHandle(a.name).startsWith(normalized) ||
    normalizeAgentHandle(a.displayName).startsWith(normalized)
  );
  if (prefix) return prefix;
  return undefined;
}

function normalizeAgentHandle(handle: string): string {
  return handle
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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

/** Keyword → agent type scoring map for context-based recommendation */
const KEYWORD_SCORES: Record<string, Record<string, number>> = {
  'code-agent': { bug: 10, fix: 10, error: 10, crash: 10, broken: 8, code: 8, implement: 8, write: 7, refactor: 7, feature: 6, build: 5, create: 5, generate: 5 },
  'review-agent': { review: 10, check: 8, audit: 8, inspect: 8, security: 7, lint: 7, quality: 6, style: 5 },
  'devops-agent': { deploy: 10, docker: 10, build: 8, release: 8, ci: 7, pipeline: 7, infra: 7, production: 8, scale: 6 },
  'planner': { plan: 10, design: 8, architect: 8, structure: 7, roadmap: 7, schema: 6 },
};

/**
 * Reorder matched agents by context relevance based on recent messages.
 * Agents matching keywords in the chat context get boosted in the sort order.
 */
export function recommendAgents(
  query: string,
  agents: AgentConfig[],
  recentMessages: string[],
): AgentConfig[] {
  const matched = matchAgents(query, agents);
  if (matched.length <= 1 || recentMessages.length === 0) return matched;

  const context = recentMessages.join(' ').toLowerCase();

  const scored = matched.map(agent => {
    const name = agent.name;
    const scores = KEYWORD_SCORES[name] || {};
    let score = 0;
    for (const [keyword, weight] of Object.entries(scores)) {
      if (context.includes(keyword)) score += weight;
    }
    return { agent, score };
  });

  return scored.sort((a, b) => b.score - a.score).map(s => s.agent);
}
