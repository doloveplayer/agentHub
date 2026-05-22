export interface MilestoneEvent {
  type: 'milestone' | 'blocked' | 'phase_complete' | 'file_produced';
  agentName: string;
  agentMessageId: string;
  summary: string;
  filePath?: string;
  timestamp: number;
}

type MilestoneHandler = (event: MilestoneEvent) => void;

export class MilestoneBroadcaster {
  private static handlers = new Map<string, MilestoneHandler[]>();

  static on(sessionId: string, handler: MilestoneHandler): void {
    const existing = MilestoneBroadcaster.handlers.get(sessionId) || [];
    existing.push(handler);
    MilestoneBroadcaster.handlers.set(sessionId, existing);
  }

  static off(sessionId: string, handler: MilestoneHandler): void {
    const existing = MilestoneBroadcaster.handlers.get(sessionId) || [];
    MilestoneBroadcaster.handlers.set(sessionId, existing.filter(h => h !== handler));
  }

  static clear(sessionId: string): void {
    MilestoneBroadcaster.handlers.delete(sessionId);
  }

  /**
   * Classify an agent event and broadcast if it's a milestone-worthy event.
   * Called from handler.ts after each agent event.
   */
  static classify(params: {
    sessionId: string;
    agentName: string;
    agentMessageId: string;
    eventType: string;
    toolName?: string;
    filePath?: string;
    content?: string;
  }): void {
    const handlers = MilestoneBroadcaster.handlers.get(params.sessionId);
    if (!handlers || handlers.length === 0) return;

    let milestone: MilestoneEvent | null = null;

    // File production milestones
    if (['Write', 'Edit'].includes(params.eventType) && params.filePath) {
      milestone = {
        type: 'file_produced',
        agentName: params.agentName,
        agentMessageId: params.agentMessageId,
        summary: `${params.agentName} modified ${params.filePath}`,
        filePath: params.filePath,
        timestamp: Date.now(),
      };
    }

    // Phase complete (done event with exitCode 0)
    if (params.eventType === 'done') {
      milestone = {
        type: 'phase_complete',
        agentName: params.agentName,
        agentMessageId: params.agentMessageId,
        summary: `${params.agentName} completed work successfully`,
        timestamp: Date.now(),
      };
    }

    if (milestone) {
      for (const h of handlers) {
        try { h(milestone); } catch { /* isolate */ }
      }
    }
  }
}
