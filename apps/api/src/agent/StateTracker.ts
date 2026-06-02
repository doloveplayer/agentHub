export interface AgentSnapshot {
  agentId: string;
  agentMessageId: string;
  status: 'running' | 'done' | 'error';
  currentTool?: string;
  currentToolInput?: string;
  openedFiles: string[];
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  thinkingLevel?: string;
  subAgents: { type: string; description: string; status: string }[];
  updatedAt: number;
}

export class StateTracker {
  private snapshots = new Map<string, AgentSnapshot>();

  getOrCreate(agentMessageId: string, agentId: string): AgentSnapshot {
    const existing = this.snapshots.get(agentMessageId);
    if (existing) return existing;
    const snap: AgentSnapshot = {
      agentId, agentMessageId, status: 'running',
      openedFiles: [], subAgents: [], updatedAt: Date.now(),
    };
    this.snapshots.set(agentMessageId, snap);
    return snap;
  }

  updateTool(agentMessageId: string, toolName: string, input: Record<string, unknown>): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.currentTool = toolName;
    snap.currentToolInput = JSON.stringify(input).slice(0, 200);
    snap.updatedAt = Date.now();
    // Track opened files from tool input
    const filePath = input.file_path || input.path || input.filePath;
    if (typeof filePath === 'string' && !snap.openedFiles.includes(filePath)) {
      snap.openedFiles.push(filePath);
    }
  }

  updateTokenUsage(agentMessageId: string, usage: AgentSnapshot['tokenUsage']): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    // Accumulate token usage across multiple API calls per message
    const prev = snap.tokenUsage;
    snap.tokenUsage = {
      input: (prev?.input ?? 0) + (usage?.input ?? 0),
      output: (prev?.output ?? 0) + (usage?.output ?? 0),
      cacheRead: (prev?.cacheRead ?? 0) + (usage?.cacheRead ?? 0),
      cacheCreate: (prev?.cacheCreate ?? 0) + (usage?.cacheCreate ?? 0),
    };
    snap.updatedAt = Date.now();
  }

  updateThinkingLevel(agentMessageId: string, level: string): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.thinkingLevel = level;
    snap.updatedAt = Date.now();
  }

  addSubagent(agentMessageId: string, type: string, description: string): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.subAgents.push({ type, description, status: 'running' });
    snap.updatedAt = Date.now();
  }

  setDone(agentMessageId: string): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.status = 'done';
    snap.updatedAt = Date.now();
  }

  setError(agentMessageId: string): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.status = 'error';
    snap.updatedAt = Date.now();
  }

  getSnapshot(agentMessageId: string): AgentSnapshot | undefined {
    return this.snapshots.get(agentMessageId);
  }

  remove(agentMessageId: string): void {
    this.snapshots.delete(agentMessageId);
  }
}

/** Global singleton for the WS handler */
export const stateTracker = new StateTracker();
