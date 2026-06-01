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

export function inferWorkspaceLanguage(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return 'plaintext';
  return LANGUAGE_BY_EXTENSION[match[1]] || 'plaintext';
}

export function safeDownloadName(path: string): string {
  if (path.endsWith('/')) return 'artifact.txt';
  const name = path.split('/').filter(Boolean).pop() || '';
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'artifact.txt';
}

export function displayWorkspacePath(path: string): string {
  return path.replace(/^\/workspace\/?/, '').replace(/^\//, '') || '/';
}
