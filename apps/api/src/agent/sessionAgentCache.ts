/**
 * Session agent name cache — shared by AgentRuntime and taskDispatcher
 * for inbox file name resolution. Populated at sandbox init time.
 */

const cache = new Map<string, string[]>();

/** Store session agent names (with full session suffix) for later resolution. */
export function setSessionAgentNames(sessionId: string, agentNames: string[]): void {
  cache.set(sessionId, agentNames);
}

/** Get cached session agent names. Returns empty array if not cached. */
export function getSessionAgentNames(sessionId: string): string[] {
  return cache.get(sessionId) ?? [];
}

/** Clear cache for a session (cleanup). */
export function clearSessionAgentNames(sessionId: string): void {
  cache.delete(sessionId);
}

/**
 * Resolve an agent type (base name like 'code-agent') to its full
 * session-suffixed name (like 'code-agent-570327b1'). Returns null
 * when the target agent is not in the session.
 */
export function resolveAgentNameInCache(sessionId: string, agentType: string): string | null {
  const names = getSessionAgentNames(sessionId);
  if (names.length === 0) return null;
  const normalized = agentType.toLowerCase();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === normalized || lower.startsWith(normalized + '-')) return name;
  }
  return null;
}
