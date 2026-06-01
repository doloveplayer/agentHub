import { Hono } from 'hono';
import { readdirSync, readFileSync, statSync, realpathSync } from 'fs';
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

// GET /api/workspace/browse?path=/home/user — list child directories for directory picker
workspace.get('/browse', async (c) => {
  const { userId } = c.get('user');
  const dirPath = c.req.query('path');

  if (!dirPath) return c.json({ error: 'Missing path query param' }, 400);

  // Resolve and validate
  const resolved = resolve(dirPath);
  let real: string;
  try { real = realpathSync(resolved); } catch {
    return c.json({ error: 'Path does not exist' }, 400);
  }
  if (!statSync(real).isDirectory()) return c.json({ error: 'Not a directory' }, 400);

  // Path traversal check
  if (!real.startsWith('/')) return c.json({ error: 'Absolute path required' }, 400);

  // List child directories (sorted, skip hidden)
  try {
    const entries = readdirSync(real, { withFileTypes: true });
    const dirs: { name: string; path: string }[] = [];
    // Always include parent directory for navigation
    const parent = resolve(real, '..');
    if (parent !== real) {
      dirs.push({ name: '..', path: parent });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // skip hidden
      dirs.push({ name: entry.name, path: resolve(real, entry.name) });
    }
    dirs.sort((a, b) => {
      if (a.name === '..') return -1;
      if (b.name === '..') return 1;
      return a.name.localeCompare(b.name);
    });
    return c.json({ path: real, dirs });
  } catch (err: any) {
    return c.json({ error: `Failed to read directory: ${err.message}` }, 500);
  }
});

export default workspace;
