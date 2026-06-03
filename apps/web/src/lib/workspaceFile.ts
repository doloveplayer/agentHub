const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  txt: 'plaintext',
  log: 'plaintext',
};

const NON_EDITABLE_EXTENSIONS = new Set([
  'ppt',
  'pptx',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'zip',
  'gz',
  'tar',
]);

export function inferWorkspaceLanguage(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return 'plaintext';
  return LANGUAGE_BY_EXTENSION[match[1]] || 'plaintext';
}

export function isEditableWorkspaceFile(path: string): boolean {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return true;
  return !NON_EDITABLE_EXTENSIONS.has(match[1]);
}

const HTML_EXTENSIONS = new Set(['html', 'htm']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

export function isHtmlFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return HTML_EXTENSIONS.has(ext);
}

export function isMarkdownFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MARKDOWN_EXTENSIONS.has(ext);
}

export function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

export function isPptxWorkspaceFile(path: string): boolean {
  return /\.pptx$/i.test(path);
}

export function safeDownloadName(path: string): string {
  if (path.endsWith('/')) return 'artifact.txt';
  const name = path.split('/').filter(Boolean).pop() || '';
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'artifact.txt';
}

export function workspaceDownloadName(path: string, type: 'file' | 'directory'): string {
  if (type === 'file') return safeDownloadName(path);
  const clean = path.replace(/^\/workspace\/?/, '').replace(/\/+$/, '');
  const name = clean.split('/').filter(Boolean).pop() || 'workspace';
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'workspace'}.zip`;
}

export function displayWorkspacePath(path: string): string {
  return path.replace(/^\/workspace\/?/, '').replace(/^\//, '') || '/';
}
