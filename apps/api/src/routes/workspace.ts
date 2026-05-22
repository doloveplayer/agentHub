import { Hono } from 'hono';
import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';

const workspace = new Hono();
workspace.use('*', authMiddleware);

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileNode[];
}

function readFileTree(dirPath: string, maxDepth = 4, currentDepth = 0): FileNode[] {
  if (currentDepth >= maxDepth) return [];
  const skipDirs = new Set(['node_modules', '.git', '.claude', '_agent_', '.sandboxes']);
  const skipPrefixes = ['_prompt_', '_env.', '_repl_prompt_', '_inbox_'];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      const fullPath = resolve(dirPath, entry.name);
      const relPath = '/' + relative('/workspace', fullPath);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('_agent_')) {
          // Still show as a directory but don't recurse into internal files
          nodes.push({ name: entry.name, path: relPath, type: 'directory', children: [] });
          continue;
        }
        const children = readFileTree(fullPath, maxDepth, currentDepth + 1);
        nodes.push({ name: entry.name, path: relPath, type: 'directory', children });
      } else {
        if (skipPrefixes.some(p => entry.name.startsWith(p))) continue;
        try {
          const stat = statSync(fullPath);
          nodes.push({ name: entry.name, path: relPath, type: 'file', size: stat.size });
        } catch {
          nodes.push({ name: entry.name, path: relPath, type: 'file' });
        }
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

// GET /api/workspace/:sessionId/tree
workspace.get('/:sessionId/tree', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const workDir = resolve(process.cwd(), '..', '..', '.sandboxes', sessionId);
  const tree = readFileTree(workDir);
  return c.json({ tree, workDir: `/workspace` });
});

// GET /api/workspace/:sessionId/file?path=/workspace/src/index.ts
workspace.get('/:sessionId/file', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const filePath = c.req.query('path');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  if (!filePath) return c.json({ error: 'Missing path query param' }, 400);

  // Security: only allow paths under workspace
  const workDir = resolve(process.cwd(), '..', '..', '.sandboxes', sessionId);
  const resolved = resolve(workDir, filePath.replace(/^\/workspace\/?/, ''));
  if (!resolved.startsWith(workDir)) return c.json({ error: 'Path traversal denied' }, 403);

  try {
    const content = readFileSync(resolved, 'utf-8');
    const stat = statSync(resolved);
    return c.json({ path: filePath, content, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  } catch (err: any) {
    return c.json({ error: `Failed to read file: ${err.message}` }, 404);
  }
});

// GET /api/workspace/:sessionId/changes
workspace.get('/:sessionId/changes', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const workDir = resolve(process.cwd(), '..', '..', '.sandboxes', sessionId);
  const changes = WorkspaceManager.getChanges(workDir);
  return c.json({ changes });
});

export default workspace;
