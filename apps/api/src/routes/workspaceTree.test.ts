import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceFileTreeForTest } from './workspace.js';

test('workspace file tree emits /workspace-relative paths, not host paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-workspace-tree-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true;');

    const tree = readWorkspaceFileTreeForTest(root, 'sandbox');
    const src = tree.find((node) => node.name === 'src');

    assert.equal(src?.path, '/workspace/src');
    assert.equal(src?.children?.[0]?.path, '/workspace/src/index.ts');
    assert.ok(!src?.children?.[0]?.path.includes(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
