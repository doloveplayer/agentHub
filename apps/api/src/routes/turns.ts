import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { TurnManager } from '../agent/TurnManager.js';
import { broadcast } from '../ws/state.js';
import type {
  TurnDeleteResult,
  TurnRegenerateResult,
  AgentUndoResult,
} from '@agenthub/shared';

const turns = new Hono();
turns.use('*', authMiddleware);

/**
 * DELETE /api/turns/:turnId
 * Delete an entire Turn: cascade-delete messages and clean up artifacts.
 * Query: ?keepUndone=true to preserve undone messages as placeholders.
 */
turns.delete('/:turnId', async (c) => {
  const user = c.get('user');
  const turnId = c.req.param('turnId');
  const keepUndone = c.req.query('keepUndone') === 'true';

  const turn = await prisma.conversationTurn.findUnique({
    where: { id: turnId },
    include: { session: { select: { userId: true } } },
  });
  if (!turn) return c.json({ error: 'Turn not found' }, 404);
  if (turn.session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const result = await TurnManager.deleteTurn(turnId, {
    keepUndoneAsPlaceholder: keepUndone,
  });

  const msg: TurnDeleteResult = {
    type: 'turn_deleted',
    turnId,
    sessionId: turn.sessionId,
    messageIds: result.deletedMessageIds,
    undoneMessageIds: result.undoneMessageIds,
    revertedFiles: result.revertedFiles,
  };
  broadcast(turn.sessionId, msg);

  return c.json({ ok: true, ...result });
});

/**
 * POST /api/turns/:turnId/regenerate
 * Regenerate a Turn: create a new Turn branching from this one.
 * Body: { editContent?: string }
 */
turns.post('/:turnId/regenerate', async (c) => {
  const user = c.get('user');
  const turnId = c.req.param('turnId');
  const body = await c.req.json().catch(() => ({}));
  const { editContent } = body as { editContent?: string };

  const turn = await prisma.conversationTurn.findUnique({
    where: { id: turnId },
    include: { session: { select: { userId: true } } },
  });
  if (!turn) return c.json({ error: 'Turn not found' }, 404);
  if (turn.session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const result = await TurnManager.regenerateTurn(turnId, editContent);

  const msg: TurnRegenerateResult = {
    type: 'turn_regenerated',
    sessionId: result.sessionId,
    oldTurnId: result.oldTurnId,
    parentTurnId: result.oldTurnId,
    originalContent: result.originalContent,
    userMessageId: '',
    agentMessageIds: [],
  };
  broadcast(result.sessionId, msg);

  return c.json({ ok: true, ...result });
});

/**
 * POST /api/turns/:turnId/messages/:messageId/undo
 * Soft-undo a single agent message within a Turn.
 */
turns.post('/:turnId/messages/:messageId/undo', async (c) => {
  const user = c.get('user');
  const turnId = c.req.param('turnId');
  const messageId = c.req.param('messageId');

  // Ownership check via Turn -> Session -> User
  const turn = await prisma.conversationTurn.findUnique({
    where: { id: turnId },
    include: { session: { select: { userId: true } } },
  });
  if (!turn) return c.json({ error: 'Turn not found' }, 404);
  if (turn.session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const result = await TurnManager.undoAgentMessage(messageId);

  const msg: AgentUndoResult = {
    type: 'agent_undone',
    messageId: result.messageId,
    sessionId: result.sessionId,
    turnId: result.turnId,
    agentId: result.agentId,
    agentName: result.agentId,
  };
  broadcast(result.sessionId, msg);

  return c.json({ ok: true, ...result });
});

/**
 * GET /api/turns/:turnId/versions
 * Get the full version chain for a Turn.
 */
turns.get('/:turnId/versions', async (c) => {
  const turnId = c.req.param('turnId');

  const versions = await TurnManager.getTurnVersions(turnId);
  const versionsWithMessages = await Promise.all(
    versions.map(async (v) => ({
      turnId: v.id,
      sequence: v.sequence,
      parentTurnId: v.parentTurnId,
      status: v.status,
      messages: await TurnManager.getTurnMessages(v.id),
      createdAt: v.createdAt,
    })),
  );

  return c.json({ versions: versionsWithMessages });
});

export default turns;
