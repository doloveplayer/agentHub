import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { WorkspaceManager } from './WorkspaceManager.js';

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-wm-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'app.txt'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

test('WorkspaceManager creates version records, diffs versions, and restores files', () => {
  const dir = createRepo();
  try {
    const first = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-1',
      agentName: 'CodeAgent',
      summary: 'initial baseline',
    });

    writeFileSync(join(dir, 'app.txt'), 'hello\nworld\n');
    const diff = WorkspaceManager.getFileDiff(dir, 'app.txt', first.id);

    assert.match(diff.diff, /\+world/);
    assert.equal(diff.path, 'app.txt');
    assert.equal(diff.hunks.length, 1);

    const second = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-1',
      agentName: 'CodeAgent',
      summary: 'add world',
    });
    const versions = WorkspaceManager.listVersions(dir);
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.agentName, 'CodeAgent');

    const between = WorkspaceManager.diffVersions(dir, first.id, second.id);
    assert.match(between.diff, /\+world/);

    assert.equal(WorkspaceManager.restoreVersion(dir, first.id), true);
    assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8'), 'hello\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager marks overlapping changed lines as conflicts', () => {
  const dir = createRepo();
  try {
    const base = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-1',
      agentName: 'CodeAgent',
      summary: 'base',
    });

    writeFileSync(join(dir, 'app.txt'), 'hello from code\n');
    const codeDiff = WorkspaceManager.getFileDiff(dir, 'app.txt', base.id).diff;

    execFileSync('git', ['checkout', '--', 'app.txt'], { cwd: dir });
    writeFileSync(join(dir, 'app.txt'), 'hello from review\n');
    const reviewDiff = WorkspaceManager.getFileDiff(dir, 'app.txt', base.id).diff;

    const conflicts = WorkspaceManager.detectConflicts([
      { agentName: 'CodeAgent', filePath: 'app.txt', diff: codeDiff },
      { agentName: 'ReviewAgent', filePath: 'app.txt', diff: reviewDiff },
    ]);

    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0]?.agents.sort(), ['CodeAgent', 'ReviewAgent']);
    assert.equal(conflicts[0]?.filePath, 'app.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager accepts and rejects diff hunks', () => {
  const dir = createRepo();
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'one.txt'), 'before\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add one'], { cwd: dir });

    const base = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-1',
      agentName: 'CodeAgent',
      summary: 'before edit',
    });
    writeFileSync(join(dir, 'src', 'one.txt'), 'after\n');

    assert.equal(WorkspaceManager.rejectFileChanges(dir, 'src/one.txt', base.id), true);
    assert.equal(readFileSync(join(dir, 'src', 'one.txt'), 'utf8'), 'before\n');

    writeFileSync(join(dir, 'src', 'one.txt'), 'after\n');
    assert.equal(WorkspaceManager.acceptFileChanges(dir, 'src/one.txt'), true);
    const status = execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' });
    assert.match(status, /M  src\/one.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager accepts and rejects individual hunks without affecting other hunks', () => {
  const dir = createRepo();
  try {
    writeFileSync(join(dir, 'app.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'multi hunk base'], { cwd: dir });

    const base = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-1',
      agentName: 'CodeAgent',
      summary: 'before multi hunk edit',
    });

    writeFileSync(join(dir, 'app.txt'), 'line 1 edited\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10 edited\n');
    const diff = WorkspaceManager.getFileDiff(dir, 'app.txt', base.id);
    assert.equal(diff.hunks.length, 2);
    const firstHunkId = diff.hunks[0]!.id;
    const secondHunkId = diff.hunks[1]!.id;

    assert.equal(WorkspaceManager.rejectHunkChanges(dir, 'app.txt', base.id, firstHunkId), true);
    assert.equal(
      readFileSync(join(dir, 'app.txt'), 'utf8'),
      'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10 edited\n',
    );

    assert.equal(WorkspaceManager.acceptHunkChanges(dir, 'app.txt', base.id, secondHunkId), true);
    const staged = execFileSync('git', ['diff', '--cached', '--', 'app.txt'], { cwd: dir, encoding: 'utf8' });
    assert.match(staged, /line 10 edited/);
    assert.doesNotMatch(staged, /line 1 edited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager initializes an empty workspace before recording versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-wm-empty-'));
  try {
    const base = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-empty',
      agentName: 'CodeAgent',
      summary: 'empty baseline',
    });
    assert.equal(base.files.length, 0);

    writeFileSync(join(dir, 'created.txt'), 'new content\n');
    const next = WorkspaceManager.recordVersion(dir, {
      sessionId: 'session-empty',
      agentName: 'CodeAgent',
      summary: 'created file',
    });

    assert.deepEqual(next.files, ['created.txt']);
    const diff = WorkspaceManager.diffVersions(dir, base.id, next.id);
    assert.match(diff.diff, /created.txt/);
    assert.match(diff.diff, /\+new content/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
