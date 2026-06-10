import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import { config } from '../config.js';

export interface WorkspaceFileMetadata {
  path: string;
  size: number;
  modifiedAt: string;
}

export type WorkspacePathResult =
  | { ok: true; absolutePath: string; workspacePath: string }
  | { ok: false; status: 400 | 403; error: string };

export function getWorkspaceRoot(sessionId: string, baseDir = config.sandbox.root): string {
  return resolve(baseDir, sessionId);
}

export function toWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const normalizedRelative = relative(workspaceRoot, absolutePath).split(sep).join('/');
  return normalizedRelative ? `/workspace/${normalizedRelative}` : '/workspace';
}

export function resolveWorkspaceFilePath(workspaceRoot: string, inputPath: string): WorkspacePathResult {
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, status: 400, error: 'Missing path' };
  }

  const relativePath = inputPath.replace(/^\/workspace\/?/, '');
  const absolutePath = resolve(workspaceRoot, relativePath);
  const rootWithSeparator = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;

  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(rootWithSeparator)) {
    return { ok: false, status: 403, error: 'Path traversal denied' };
  }

  return { ok: true, absolutePath, workspacePath: toWorkspacePath(workspaceRoot, absolutePath) };
}

export function readWorkspaceTextFile(workspaceRoot: string, inputPath: string): WorkspaceFileMetadata & { content: string } {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) throw Object.assign(new Error(resolved.error), { status: resolved.status });

  const stat = statSync(resolved.absolutePath);
  if (stat.isDirectory()) throw Object.assign(new Error('Cannot read a directory'), { status: 400 });

  return {
    path: resolved.workspacePath,
    content: readFileSync(resolved.absolutePath, 'utf-8'),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export function writeWorkspaceTextFile(workspaceRoot: string, inputPath: string, content: string): WorkspaceFileMetadata {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) throw Object.assign(new Error(resolved.error), { status: resolved.status });

  try {
    const stat = statSync(resolved.absolutePath);
    if (stat.isDirectory()) throw Object.assign(new Error('Cannot write a directory'), { status: 400 });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  mkdirSync(dirname(resolved.absolutePath), { recursive: true });
  writeFileSync(resolved.absolutePath, content, 'utf-8');

  const stat = statSync(resolved.absolutePath);
  return {
    path: resolved.workspacePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}
