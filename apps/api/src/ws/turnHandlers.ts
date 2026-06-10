import { TurnManager } from '../agent/TurnManager.js';
import { prisma } from '../db/prisma.js';
import { broadcast, sendTo } from './state.js';
import type { WebSocket } from 'ws';
import type {
  TurnDeleteRequest,
  TurnDeleteResult,
  TurnRegenerateRequest,
  TurnRegenerateResult,
  AgentUndoRequest,
  AgentUndoResult,
} from '@agenthub/shared';

/** Handle turn_delete WS message. Verifies ownership then delegates to TurnManager. */
export async function handleTurnDelete(
  sessionId: string,
  ws: WebSocket,
  data: TurnDeleteRequest,
): Promise<void> {
  try {
    const turn = await prisma.conversationTurn.findUnique({
      where: { id: data.turnId },
      select: { sessionId: true },
    });
    if (!turn || turn.sessionId !== sessionId) {
      sendTo(ws, { type: 'error', message: 'Turn not found or access denied' });
      return;
    }

    const result = await TurnManager.deleteTurn(data.turnId);

    const msg: TurnDeleteResult = {
      type: 'turn_deleted',
      turnId: data.turnId,
      sessionId,
      messageIds: result.deletedMessageIds,
      undoneMessageIds: result.undoneMessageIds,
      revertedFiles: result.revertedFiles,
    };
    broadcast(sessionId, msg);
  } catch (err: any) {
    sendTo(ws, { type: 'error', message: `Turn delete failed: ${err.message}` });
  }
}

/** Handle turn_regenerate WS message. Rollback & create child Turn, send prompt to frontend. */
export async function handleTurnRegenerate(
  sessionId: string,
  ws: WebSocket,
  data: TurnRegenerateRequest,
): Promise<void> {
  try {
    const turn = await prisma.conversationTurn.findUnique({
      where: { id: data.turnId },
      select: { sessionId: true },
    });
    if (!turn || turn.sessionId !== sessionId) {
      sendTo(ws, { type: 'error', message: 'Turn not found or access denied' });
      return;
    }

    const result = await TurnManager.regenerateTurn(data.turnId, data.editContent);

    const msg: TurnRegenerateResult = {
      type: 'turn_regenerated',
      sessionId,
      oldTurnId: result.oldTurnId,
      parentTurnId: result.oldTurnId,
      originalContent: result.originalContent,
      userMessageId: '',
      agentMessageIds: [],
    };
    broadcast(sessionId, msg);

    // Send the original prompt back so frontend can auto-resend
    sendTo(ws, {
      type: 'turn_regenerate_prompt',
      parentTurnId: result.oldTurnId,
      content: result.originalContent,
    });
  } catch (err: any) {
    sendTo(ws, { type: 'error', message: `Turn regenerate failed: ${err.message}` });
  }
}

/** Handle agent_undo WS message. Soft-undo a single agent message in a Turn. */
export async function handleAgentUndo(
  sessionId: string,
  ws: WebSocket,
  data: AgentUndoRequest,
): Promise<void> {
  try {
    const message = await prisma.message.findUnique({
      where: { id: data.messageId },
      select: { sessionId: true, agentId: true },
    });
    if (!message || message.sessionId !== sessionId) {
      sendTo(ws, { type: 'error', message: 'Message not found or access denied' });
      return;
    }

    const result = await TurnManager.undoAgentMessage(data.messageId);

    const msg: AgentUndoResult = {
      type: 'agent_undone',
      messageId: result.messageId,
      sessionId,
      turnId: result.turnId,
      agentId: result.agentId,
      agentName: message.agentId || '',
    };
    broadcast(sessionId, msg);
  } catch (err: any) {
    sendTo(ws, { type: 'error', message: `Agent undo failed: ${err.message}` });
  }
}
