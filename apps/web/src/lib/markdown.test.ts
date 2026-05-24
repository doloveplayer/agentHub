import test from 'node:test';
import assert from 'node:assert/strict';
import { safeMarkdownUrl } from './markdown.js';

test('safeMarkdownUrl allows http, https, relative, and image data URLs', () => {
  assert.equal(safeMarkdownUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(safeMarkdownUrl('http://example.com/a.png'), 'http://example.com/a.png');
  assert.equal(safeMarkdownUrl('/assets/a.png'), '/assets/a.png');
  assert.equal(safeMarkdownUrl('./notes.md'), './notes.md');
  assert.equal(safeMarkdownUrl('../notes.md'), '../notes.md');
  assert.equal(
    safeMarkdownUrl('data:image/png;base64,iVBORw0KGgo='),
    'data:image/png;base64,iVBORw0KGgo=',
  );
});

test('safeMarkdownUrl rejects script-like and non-image data URLs', () => {
  assert.equal(safeMarkdownUrl('javascript:alert(1)'), null);
  assert.equal(safeMarkdownUrl('vbscript:msgbox(1)'), null);
  assert.equal(safeMarkdownUrl('data:text/html;base64,PGgxPkJhZDwvaDE+'), null);
});
