import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkspaceZip,
  collectArchiveFiles,
  workspaceDownloadName,
} from './workspaceArchive.js';

function withTempWorkspace(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'agenthub-archive-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('collectArchiveFiles collects nested files under a workspace directory', () => {
  withTempWorkspace((root) => {
    mkdirSync(join(root, 'docs', 'nested'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), 'A');
    writeFileSync(join(root, 'docs', 'nested', 'b.txt'), 'B');

    const files = collectArchiveFiles(root, '/workspace/docs');

    assert.deepEqual(files.map((file) => file.archivePath), ['docs/a.md', 'docs/nested/b.txt']);
  });
});

test('collectArchiveFiles rejects traversal outside the workspace', () => {
  withTempWorkspace((root) => {
    assert.throws(
      () => collectArchiveFiles(root, '/workspace/../../secret'),
      /Path traversal denied/,
    );
  });
});

test('collectArchiveFiles skips internal agent and prompt files', () => {
  withTempWorkspace((root) => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, '_agent_code-agent'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, 'docs', 'visible.md'), 'visible');
    writeFileSync(join(root, '_agent_code-agent', 'memory.md'), 'internal');
    writeFileSync(join(root, '.claude', 'settings.json'), '{}');
    writeFileSync(join(root, '_prompt_secret.txt'), 'prompt');
    writeFileSync(join(root, '_env.secret'), 'env');

    const files = collectArchiveFiles(root, '/workspace');

    assert.deepEqual(files.map((file) => file.archivePath), ['docs/visible.md']);
  });
});

test('buildWorkspaceZip emits a zip file with central directory entries', () => {
  const zip = buildWorkspaceZip([
    { archivePath: 'docs/a.md', absolutePath: '/unused/a.md', content: Buffer.from('A') },
    { archivePath: 'docs/nested/b.txt', absolutePath: '/unused/b.txt', content: Buffer.from('B') },
  ]);

  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(zip.includes(Buffer.from('docs/a.md')));
  assert.ok(zip.includes(Buffer.from('docs/nested/b.txt')));
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
});

test('workspaceDownloadName returns zip names for directories and original names for files', () => {
  assert.equal(workspaceDownloadName('/workspace/docs', true), 'docs.zip');
  assert.equal(workspaceDownloadName('/workspace/docs/report.md', false), 'report.md');
  assert.equal(workspaceDownloadName('/workspace', true), 'workspace.zip');
});
