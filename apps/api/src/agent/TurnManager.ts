import { prisma } from '../db/prisma.js';
import { WorkspaceManager } from './WorkspaceManager.js';
import type { ConversationTurn, WorkspaceSnapshot } from '@agenthub/shared';

export class TurnManager {
  /**
   * Create a new Turn for an incoming user message.
   * Completes any currently active Turn first, then creates a new one.
   */
  static async createTurn(params: {
    sessionId: string;
    userMessageId: string;
    workspacePath?: string | null;
    parentTurnId?: string;
  }): Promise<ConversationTurn> {
    const { sessionId, userMessageId, workspacePath, parentTurnId } = params;

    // Complete any currently active Turn
    await prisma.conversationTurn.updateMany({
      where: { sessionId, status: 'active' },
      data: { status: 'completed' },
    });

    // Compute next sequence number
    const lastTurn = await prisma.conversationTurn.findFirst({
      where: { sessionId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const sequence = (lastTurn?.sequence ?? 0) + 1;

    // Take workspace snapshot for future rollback
    let workspaceSnapshot: WorkspaceSnapshot | null = null;
    if (workspacePath) {
      const snap = WorkspaceManager.snapshot(workspacePath, sessionId);
      if (snap) {
        workspaceSnapshot = {
          ref: snap.ref,
          mode: snap.mode,
          workspacePath: snap.workspacePath,
          createdAt: snap.createdAt,
        };
      }
    }

    const turn = await prisma.conversationTurn.create({
      data: {
        sessionId,
        sequence,
        parentTurnId: parentTurnId ?? null,
        triggerMsgId: userMessageId,
        status: 'active',
        workspaceSnapshot: workspaceSnapshot as any,
        contextEntryKeys: [],
        planIds: [],
      },
    });

    // Associate the triggering message with this Turn
    await prisma.message.update({
      where: { id: userMessageId },
      data: { turnId: turn.id },
    });

    return turn as unknown as ConversationTurn;
  }

  /** Get the currently active Turn for a session */
  static async getActiveTurn(sessionId: string): Promise<ConversationTurn | null> {
    const turn = await prisma.conversationTurn.findFirst({
      where: { sessionId, status: 'active' },
      orderBy: { sequence: 'desc' },
    });
    return turn as unknown as ConversationTurn | null;
  }

  /** Find a Turn by ID with its messages */
  static async getTurn(turnId: string) {
    return prisma.conversationTurn.findUnique({
      where: { id: turnId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** Record a ContextEntry key created during this Turn */
  static async trackContextEntry(turnId: string, key: string): Promise<void> {
    const turn = await prisma.conversationTurn.findUnique({
      where: { id: turnId },
      select: { contextEntryKeys: true },
    });
    if (!turn) return;
    const keys = [...new Set([...(turn.contextEntryKeys as string[]), key])];
    await prisma.conversationTurn.update({
      where: { id: turnId },
      data: { contextEntryKeys: keys },
    });
  }

  /** Record a PlanExecution planId created during this Turn */
  static async trackPlanId(turnId: string, planId: string): Promise<void> {
    const turn = await prisma.conversationTurn.findUnique({
      where: { id: turnId },
      select: { planIds: true },
    });
    if (!turn) return;
    const planIds = [...new Set([...(turn.planIds as string[]), planId])];
    await prisma.conversationTurn.update({
      where: { id: turnId },
      data: { planIds },
    });
  }

  /** Mark a Turn as completed */
  static async completeTurn(turnId: string): Promise<void> {
    await prisma.conversationTurn.update({
      where: { id: turnId },
      data: { status: 'completed' },
    });
  }

  /**
   * Delete a Turn and all associated artifacts:
   * 1. Rollback workspace to pre-turn snapshot
   * 2. Mark ContextEntry records as stale
   * 3. Cancel PlanExecutions
   * 4. Clean up QuoteReferences involving this Turn's messages
   * 5. Clean up PinnedMessages sourced from this Turn's messages
   * 6. Delete or soft-delete messages
   * 7. Mark Turn as cancelled
   */
  static async deleteTurn(
    turnId: string,
    options: { keepUndoneAsPlaceholder?: boolean } = {},
  ): Promise<{
    revertedFiles: string[];
    deletedMessageIds: string[];
    undoneMessageIds: string[];
  }> {
    const turn = await prisma.conversationTurn.findUnique({
      where: { id: turnId },
      include: {
        messages: { select: { id: true, senderType: true, agentId: true, turnStatus: true } },
      },
    });
    if (!turn) throw new Error(`Turn ${turnId} not found`);

    // 1. Rollback workspace
    const revertedFiles: string[] = [];
    const snapshot = turn.workspaceSnapshot as WorkspaceSnapshot | null;
    if (snapshot) {
      const ok = WorkspaceManager.rollback({
        ref: snapshot.ref,
        mode: snapshot.mode,
        workspacePath: snapshot.workspacePath,
        createdAt: snapshot.createdAt,
      });
      if (ok) {
        revertedFiles.push(...WorkspaceManager.getChanges(snapshot.workspacePath));
      }
    }

    // 2. Mark ContextEntry records as stale
    const contextKeys = turn.contextEntryKeys as string[];
    if (contextKeys.length > 0) {
      await prisma.contextEntryRecord.updateMany({
        where: { key: { in: contextKeys }, sessionId: turn.sessionId },
        data: { status: 'stale' },
      });
    }

    // 3. Cancel PlanExecutions
    const planIds = turn.planIds as string[];
    if (planIds.length > 0) {
      await prisma.planExecution.updateMany({
        where: { planId: { in: planIds }, sessionId: turn.sessionId },
        data: { status: 'failed' },
      });
    }

    // 4. Clean up QuoteReferences
    const allMessageIds = turn.messages.map((m) => m.id);
    await prisma.quoteReference.deleteMany({
      where: {
        sessionId: turn.sessionId,
        OR: [
          { sourceMessageId: { in: allMessageIds } },
          { targetMessageId: { in: allMessageIds } },
        ],
      },
    });

    // 5. Clean up PinnedMessages sourced from Turn messages
    await prisma.pinnedMessage.deleteMany({
      where: {
        sessionId: turn.sessionId,
        sourceMessageId: { in: allMessageIds },
      },
    });

    // 6. Delete messages
    const { keepUndoneAsPlaceholder } = options;
    let deletedIds: string[] = [];
    let undoneIds: string[] = [];

    if (keepUndoneAsPlaceholder) {
      const undoneMessages = turn.messages.filter((m) => m.turnStatus === 'undone');
      const regularMessages = turn.messages.filter((m) => m.turnStatus !== 'undone');
      undoneIds = undoneMessages.map((m) => m.id);
      deletedIds = regularMessages.map((m) => m.id);

      if (deletedIds.length > 0) {
        await prisma.message.deleteMany({ where: { id: { in: deletedIds } } });
      }
      if (undoneIds.length > 0) {
        await prisma.message.updateMany({
          where: { id: { in: undoneIds } },
          data: { content: '', turnStatus: 'undone' },
        });
      }
    } else {
      deletedIds = allMessageIds;
      await prisma.message.deleteMany({ where: { id: { in: deletedIds } } });
    }

    // 7. Mark Turn as cancelled
    await prisma.conversationTurn.update({
      where: { id: turnId },
      data: { status: 'cancelled' },
    });

    return { revertedFiles, deletedMessageIds: deletedIds, undoneMessageIds: undoneIds };
  }

  /**
   * Prepare for Turn regeneration: rollback workspace to old snapshot,
   * mark old Turn as superseded. Does NOT create a new Turn — that is
   * done by the standard chat/send flow so parentTurnId is set once.
   */
  static async regenerateTurn(
    oldTurnId: string,
    editContent?: string,
  ): Promise<{
    oldTurnId: string;
    originalContent: string;
    sessionId: string;
    workspacePath: string | null;
  }> {
    const oldTurn = await prisma.conversationTurn.findUnique({
      where: { id: oldTurnId },
      include: {
        messages: {
          where: { senderType: 'human' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { content: true },
        },
      },
    });
    if (!oldTurn) throw new Error(`Turn ${oldTurnId} not found`);

    const originalContent = editContent || oldTurn.messages[0]?.content || '';

    // Rollback workspace to old snapshot
    const snapshot = oldTurn.workspaceSnapshot as WorkspaceSnapshot | null;
    const workspacePath = snapshot?.workspacePath ?? null;
    if (snapshot) {
      WorkspaceManager.rollback({
        ref: snapshot.ref,
        mode: snapshot.mode,
        workspacePath: snapshot.workspacePath,
        createdAt: snapshot.createdAt,
      });
    }

    // Mark old Turn superseded
    await prisma.conversationTurn.update({
      where: { id: oldTurnId },
      data: { status: 'superseded' },
    });

    return {
      oldTurnId,
      originalContent,
      sessionId: oldTurn.sessionId,
      workspacePath,
    };
  }

  /**
   * Soft-undo a single agent message within a Turn.
   * Clears content and marks turnStatus='undone'.
   * Does NOT rollback workspace or affect other messages.
   */
  static async undoAgentMessage(messageId: string): Promise<{
    messageId: string;
    agentId: string;
    turnId: string;
    sessionId: string;
  }> {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, agentId: true, turnId: true, senderType: true, sessionId: true },
    });
    if (!message || message.senderType !== 'agent') {
      throw new Error(`Agent message ${messageId} not found`);
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { content: '', turnStatus: 'undone' },
    });

    return {
      messageId: message.id,
      agentId: message.agentId || '',
      turnId: message.turnId || '',
      sessionId: message.sessionId,
    };
  }

  /**
   * Get the full version chain for a Turn (parent chain + siblings).
   * Returns all versions ordered by sequence.
   */
  static async getTurnVersions(rootTurnId: string): Promise<ConversationTurn[]> {
    let current = await prisma.conversationTurn.findUnique({ where: { id: rootTurnId } });
    if (!current) return [];

    // Walk up to the root
    while (current!.parentTurnId) {
      const parent = await prisma.conversationTurn.findUnique({
        where: { id: current!.parentTurnId },
      });
      if (!parent) break;
      current = parent;
    }

    const root = current as unknown as ConversationTurn;
    const versions: ConversationTurn[] = [root];

    // Walk down through children (breadth-first, limited depth)
    let children = await prisma.conversationTurn.findMany({
      where: { parentTurnId: root.id },
      orderBy: { sequence: 'asc' },
    });
    for (const child of children) {
      versions.push(child as unknown as ConversationTurn);
      const grandchildren = await prisma.conversationTurn.findMany({
        where: { parentTurnId: child.id },
        orderBy: { sequence: 'asc' },
      });
      for (const gc of grandchildren) {
        versions.push(gc as unknown as ConversationTurn);
      }
    }

    return versions;
  }

  /** Load all messages for a Turn (including undone ones) */
  static async getTurnMessages(turnId: string) {
    return prisma.message.findMany({
      where: { turnId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
