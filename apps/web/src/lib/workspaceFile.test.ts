import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayWorkspacePath,
  inferWorkspaceLanguage,
  safeDownloadName,
} from './workspaceFile.js';

test('inferWorkspaceLanguage maps common agent artifact extensions', () => {
  assert.equal(inferWorkspaceLanguage('/workspace/src/App.tsx'), 'typescript');
  assert.equal(inferWorkspaceLanguage('/workspace/package.json'), 'json');
  assert.equal(inferWorkspaceLanguage('/workspace/docs/report.md'), 'markdown');
  assert.equal(inferWorkspaceLanguage('/workspace/styles/index.css'), 'css');
  assert.equal(inferWorkspaceLanguage('/workspace/index.html'), 'html');
  assert.equal(inferWorkspaceLanguage('/workspace/scripts/start.sh'), 'shell');
  assert.equal(inferWorkspaceLanguage('/workspace/query.sql'), 'sql');
  assert.equal(inferWorkspaceLanguage('/workspace/unknown.artifact'), 'plaintext');
});

test('safeDownloadName uses basename and removes unsafe characters', () => {
  assert.equal(safeDownloadName('/workspace/docs/report.md'), 'report.md');
  assert.equal(safeDownloadName('/workspace/a/b/weird:name?.txt'), 'weird_name_.txt');
  assert.equal(safeDownloadName('/workspace/'), 'artifact.txt');
});

test('displayWorkspacePath strips workspace prefix for compact labels', () => {
  assert.equal(displayWorkspacePath('/workspace/docs/report.md'), 'docs/report.md');
  assert.equal(displayWorkspacePath('/notes.md'), 'notes.md');
});
