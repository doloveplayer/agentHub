import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspaceRoot,
  resolveWorkspaceFilePath,
  toWorkspacePath,
  writeWorkspaceTextFile,
} from './workspaceFileAccess.js';

test('resolveWorkspaceFilePath accepts /workspace-prefixed paths inside the sandbox', () => {
  const root = getWorkspaceRoot('session-1', join(tmpdir(), 'agenthub-test-root'));
  const resolved = resolveWorkspaceFilePath(root, '/workspace/docs/report.md');
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.workspacePath, '/workspace/docs/report.md');
    assert.ok(resolved.absolutePath.endsWith('session-1/docs/report.md'));
  }
});

test('resolveWorkspaceFilePath rejects traversal outside the sandbox', () => {
  const root = getWorkspaceRoot('session-1', join(tmpdir(), 'agenthub-test-root'));
  const resolved = resolveWorkspaceFilePath(root, '/workspace/../../secret.txt');
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.status, 403);
    assert.equal(resolved.error, 'Path traversal denied');
  }
});

test('writeWorkspaceTextFile writes UTF-8 content and returns public metadata', () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'agenthub-write-'));
  try {
    const result = writeWorkspaceTextFile(sandboxRoot, '/workspace/notes.md', '# Updated\n');
    assert.equal(result.path, '/workspace/notes.md');
    assert.equal(result.size, Buffer.byteLength('# Updated\n', 'utf-8'));
    assert.match(result.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(readFileSync(join(sandboxRoot, 'notes.md'), 'utf-8'), '# Updated\n');
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('writeWorkspaceTextFile refuses to write directories', () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'agenthub-dir-'));
  try {
    const result = resolveWorkspaceFilePath(sandboxRoot, '/workspace');
    assert.equal(result.ok, true);
    assert.throws(
      () => writeWorkspaceTextFile(sandboxRoot, '/workspace', 'content'),
      /Cannot write a directory/,
    );
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('writeWorkspaceTextFile creates missing parent directories inside the sandbox', () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'agenthub-nested-'));
  try {
    const result = writeWorkspaceTextFile(sandboxRoot, '/workspace/docs/generated/report.md', 'generated');
    assert.equal(result.path, '/workspace/docs/generated/report.md');
    assert.equal(readFileSync(join(sandboxRoot, 'docs/generated/report.md'), 'utf-8'), 'generated');
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('toWorkspacePath maps host sandbox paths to browser-safe workspace paths', () => {
  const root = getWorkspaceRoot('session-1', join(tmpdir(), 'agenthub-test-root'));
  assert.equal(toWorkspacePath(root, join(root, 'docs', 'report.md')), '/workspace/docs/report.md');
  assert.equal(toWorkspacePath(root, root), '/workspace');
});
