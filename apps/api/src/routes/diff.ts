import { Hono } from 'hono';
import { resolve } from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';

const diff = new Hono();
diff.use('*', authMiddleware);

async function getSessionWorkspace(sessionId: string, userId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return null;
  return resolve(process.cwd(), '..', '..', '.sandboxes', sessionId);
}

diff.get('/:sessionId/versions', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ versions: WorkspaceManager.listVersions(workDir) });
});

diff.post('/:sessionId/versions', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const version = WorkspaceManager.recordVersion(workDir, {
    sessionId,
    agentName: String(body.agentName || 'Agent'),
    summary: String(body.summary || 'Workspace snapshot'),
  });
  return c.json({ version }, 201);
});

diff.get('/:sessionId/files', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const baseVersionId = c.req.query('baseVersionId') || undefined;
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ files: WorkspaceManager.getWorkspaceDiff(workDir, baseVersionId) });
});

diff.get('/:sessionId/file', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const filePath = c.req.query('path');
  const baseVersionId = c.req.query('baseVersionId') || undefined;
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  if (!filePath) return c.json({ error: 'Missing path query param' }, 400);
  return c.json({ file: WorkspaceManager.getFileDiff(workDir, filePath, baseVersionId) });
});

diff.get('/:sessionId/versions/diff', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const filePath = c.req.query('path') || undefined;
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  if (!from || !to) return c.json({ error: 'Missing from/to query params' }, 400);
  return c.json({ diff: WorkspaceManager.diffVersions(workDir, from, to, filePath) });
});

diff.post('/:sessionId/restore', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  if (!body.versionId) return c.json({ error: 'Missing versionId' }, 400);
  return c.json({ ok: WorkspaceManager.restoreVersion(workDir, String(body.versionId)) });
});

diff.post('/:sessionId/accept', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  if (!body.path) return c.json({ error: 'Missing path' }, 400);
  return c.json({ ok: WorkspaceManager.acceptFileChanges(workDir, String(body.path)) });
});

diff.post('/:sessionId/reject', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  if (!body.path) return c.json({ error: 'Missing path' }, 400);
  return c.json({ ok: WorkspaceManager.rejectFileChanges(workDir, String(body.path), body.baseVersionId ? String(body.baseVersionId) : undefined) });
});

export default diff;
