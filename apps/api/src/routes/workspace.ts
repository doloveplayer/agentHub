import { Hono } from 'hono';
import { readdirSync, readFileSync, statSync, realpathSync, existsSync } from 'fs';
import { resolve, relative } from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';
import archiver from 'archiver';

const workspace = new Hono();
workspace.use('*', authMiddleware);

const SANDBOX_ROOT = resolve(process.cwd(), '..', '..', '.sandboxes');

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileNode[];
  source?: 'sandbox' | 'workspace'; // which root this file comes from
}

function readFileTree(dirPath: string, maxDepth = 4, currentDepth = 0, source: 'sandbox' | 'workspace' = 'sandbox'): FileNode[] {
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
          nodes.push({ name: entry.name, path: relPath, type: 'directory', children: [], source });
          continue;
        }
        const children = readFileTree(fullPath, maxDepth, currentDepth + 1, source);
        nodes.push({ name: entry.name, path: relPath, type: 'directory', children, source });
      } else {
        if (skipPrefixes.some(p => entry.name.startsWith(p))) continue;
        try {
          const stat = statSync(fullPath);
          nodes.push({ name: entry.name, path: relPath, type: 'file', size: stat.size, source });
        } catch {
          nodes.push({ name: entry.name, path: relPath, type: 'file', source });
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

// GET /api/workspace/:sessionId/tree — merged sandbox + workspace tree
workspace.get('/:sessionId/tree', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  // Always include sandbox tree
  const sandboxDir = resolve(SANDBOX_ROOT, sessionId);
  const sandboxTree = readFileTree(sandboxDir, 4, 0, 'sandbox');

  // Merge workspace tree if a custom workspace is configured
  let workspaceTree: FileNode[] = [];
  let workspacePath: string | null = null;
  if (session.workspacePath) {
    try {
      const real = realpathSync(session.workspacePath);
      if (existsSync(real)) {
        workspacePath = real;
        workspaceTree = readFileTree(real, 4, 0, 'workspace');
      }
    } catch { /* workspace unavailable */ }
  }

  return c.json({
    tree: sandboxTree,
    workspaceTree,
    sandboxDir: '/workspace',
    workspaceDir: workspacePath,
  });
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

// GET /api/workspace/:sessionId/download — zip entire sandbox
workspace.get('/:sessionId/download', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const sandboxDir = resolve(SANDBOX_ROOT, sessionId);
  if (!existsSync(sandboxDir)) return c.json({ error: 'Sandbox not found' }, 404);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err: Error) => {
    console.error(`[workspace] Zip error for session ${sessionId.slice(0, 8)}:`, err.message);
  });

  archive.glob('**/*', {
    cwd: sandboxDir,
    ignore: ['_agent_*/**', '.git/**', '_inbox_*.jsonl', '_prompt_*.txt', 'plan.json'],
    dot: false,
  });

  archive.finalize();

  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="sandbox-${sessionId.slice(0, 8)}.zip"`);
  return c.body(archive as any);
});

export default workspace;
