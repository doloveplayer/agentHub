import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayWorkspacePath,
  inferWorkspaceLanguage,
  isEditableWorkspaceFile,
  isPptxWorkspaceFile,
  isPptPreviewableFile,
  isLegacyPptFile,
  safeDownloadName,
  workspaceDownloadName,
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

test('isEditableWorkspaceFile rejects binary office artifacts', () => {
  assert.equal(isEditableWorkspaceFile('/workspace/deck.pptx'), false);
  assert.equal(isEditableWorkspaceFile('/workspace/legacy.ppt'), false);
  assert.equal(isEditableWorkspaceFile('/workspace/spec.docx'), false);
  assert.equal(isEditableWorkspaceFile('/workspace/docs/report.md'), true);
});

test('isPptxWorkspaceFile identifies previewable pptx files only', () => {
  assert.equal(isPptxWorkspaceFile('/workspace/deck.pptx'), true);
  assert.equal(isPptxWorkspaceFile('/workspace/DECK.PPTX'), true);
  assert.equal(isPptxWorkspaceFile('/workspace/legacy.ppt'), false);
  assert.equal(isPptxWorkspaceFile('/workspace/report.md'), false);
});

test('isPptPreviewableFile matches both .ppt and .pptx', () => {
  assert.equal(isPptPreviewableFile('/workspace/deck.pptx'), true);
  assert.equal(isPptPreviewableFile('/workspace/legacy.ppt'), true);
  assert.equal(isPptPreviewableFile('/workspace/Legacy.PPT'), true);
  assert.equal(isPptPreviewableFile('/workspace/report.md'), false);
  assert.equal(isPptPreviewableFile('/workspace/data.xlsx'), false);
});

test('isLegacyPptFile identifies only .ppt (not .pptx)', () => {
  assert.equal(isLegacyPptFile('/workspace/legacy.ppt'), true);
  assert.equal(isLegacyPptFile('/workspace/LEGACY.PPT'), true);
  assert.equal(isLegacyPptFile('/workspace/modern.pptx'), false);
  assert.equal(isLegacyPptFile('/workspace/report.md'), false);
  // Edge: file with both extensions
  assert.equal(isLegacyPptFile('/workspace/weird.ppt.pptx'), false);
});

test('workspaceDownloadName returns zip names for directories', () => {
  assert.equal(workspaceDownloadName('/workspace/docs', 'directory'), 'docs.zip');
  assert.equal(workspaceDownloadName('/workspace', 'directory'), 'workspace.zip');
  assert.equal(workspaceDownloadName('/workspace/deck.pptx', 'file'), 'deck.pptx');
});
