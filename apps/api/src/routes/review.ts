import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { parseReviewReport } from '../artifacts/ArtifactTools.js';
import { broadcast } from '../ws/state.js';

const review = new Hono();
review.use('*', authMiddleware);

review.post('/:sessionId/report', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const report = parseReviewReport(String(body.content || ''));
  broadcast(sessionId, { type: 'review_report', report, timestamp: Date.now() });
  return c.json({ report });
});

export default review;
