import { Hono } from 'hono';
import { readdirSync, statSync, realpathSync, existsSync } from 'fs';
import { resolve } from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';
import { getWorkspaceRoot, readWorkspaceTextFile, toWorkspacePath, writeWorkspaceTextFile } from './workspaceFileAccess.js';
import { buildWorkspaceZip, collectArchiveFiles, workspaceDownloadName } from './workspaceArchive.js';

const workspace = new Hono();
workspace.use('*', authMiddleware);

const SANDBOX_ROOT = resolve(process.cwd(), '..', '..', '.sandboxes');

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: number;
  children?: FileNode[];
  source?: 'sandbox' | 'workspace'; // which root this file comes from
}

function readFileTree(
  workspaceRoot: string,
  dirPath: string,
  maxDepth = 4,
  currentDepth = 0,
  source: 'sandbox' | 'workspace' = 'sandbox',
): FileNode[] {
  if (currentDepth >= maxDepth) return [];
  const skipDirs = new Set(['node_modules', '.git', '.claude', '_agent_', '.sandboxes']);
  const skipPrefixes = ['_prompt_', '_env.', '_repl_prompt_', '_inbox_'];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const entry of entries) {
      const fullPath = resolve(dirPath, entry.name);
      const relPath = toWorkspacePath(workspaceRoot, fullPath);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith('_agent_')) {
          nodes.push({ name: entry.name, path: relPath, type: 'directory', children: [], source });
          continue;
        }
        const children = readFileTree(workspaceRoot, fullPath, maxDepth, currentDepth + 1, source);
        nodes.push({ name: entry.name, path: relPath, type: 'directory', children, source });
      } else {
        if (skipPrefixes.some(p => entry.name.startsWith(p))) continue;
        try {
          const stat = statSync(fullPath);
          nodes.push({ name: entry.name, path: relPath, type: 'file', size: stat.size, modifiedAt: stat.mtimeMs, source });
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

export function readWorkspaceFileTreeForTest(workspaceRoot: string, source: 'sandbox' | 'workspace' = 'sandbox'): FileNode[] {
  return readFileTree(workspaceRoot, workspaceRoot, 4, 0, source);
}

// GET /api/workspace/:sessionId/tree — merged sandbox + workspace tree
workspace.get('/:sessionId/tree', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  // Always include sandbox tree
  const sandboxDir = resolve(SANDBOX_ROOT, sessionId);
  const sandboxTree = readFileTree(sandboxDir, sandboxDir, 4, 0, 'sandbox');

  // Merge workspace tree if a custom workspace is configured
  let workspaceTree: FileNode[] = [];
  let workspacePath: string | null = null;
  if (session.workspacePath) {
    try {
      const real = realpathSync(session.workspacePath);
      if (existsSync(real)) {
        workspacePath = real;
        workspaceTree = readFileTree(real, real, 4, 0, 'workspace');
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

  const workDir = getWorkspaceRoot(sessionId);
  try {
    return c.json(readWorkspaceTextFile(workDir, filePath));
  } catch (err: any) {
    const status = typeof err.status === 'number' ? err.status : 404;
    const message = status === 400 || status === 403 ? err.message : 'Failed to read file';
    return c.json({ error: message }, status as any);
  }
});

// PUT /api/workspace/:sessionId/file
workspace.put('/:sessionId/file', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.path !== 'string' || !body.path) {
    return c.json({ error: 'Missing path' }, 400);
  }
  if (typeof body.content !== 'string') {
    return c.json({ error: 'content must be a string' }, 400);
  }

  const workDir = getWorkspaceRoot(sessionId);
  try {
    return c.json(writeWorkspaceTextFile(workDir, body.path, body.content));
  } catch (err: any) {
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = status === 400 || status === 403 ? err.message : 'Failed to write file';
    return c.json({ error: message }, status as any);
  }
});

// GET /api/workspace/:sessionId/download?path=/workspace/docs
workspace.get('/:sessionId/download', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const filePath = c.req.query('path');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  if (!filePath) return c.json({ error: 'Missing path query param' }, 400);

  const workDir = getWorkspaceRoot(sessionId);
  try {
    const files = collectArchiveFiles(workDir, filePath);
    const isDirectory = files.length !== 1 || files[0].archivePath !== workspaceDownloadName(filePath, false);
    const body = isDirectory ? buildWorkspaceZip(files) : files[0].content;
    const downloadName = workspaceDownloadName(filePath, isDirectory);
    c.header('Content-Disposition', `attachment; filename="${downloadName}"`);
    c.header('Content-Type', isDirectory ? 'application/zip' : 'application/octet-stream');
    const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return c.body(arrayBuffer);
  } catch (err: any) {
    const status = typeof err.status === 'number' ? err.status : 404;
    const message = status === 400 || status === 403 ? err.message : 'Failed to download path';
    return c.json({ error: message }, status as any);
  }
});

// GET /api/workspace/:sessionId/changes
workspace.get('/:sessionId/changes', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const workDir = getWorkspaceRoot(sessionId);
  const changes = WorkspaceManager.getChanges(workDir);
  return c.json({ changes });
});

// GET /api/workspace/browse?path=/home/user — list child directories for directory picker
workspace.get('/browse', async (c) => {
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
