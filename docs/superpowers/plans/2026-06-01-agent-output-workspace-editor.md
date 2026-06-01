# Agent Output Workspace Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open agent-produced workspace files in the browser, edit them, save them back to the session sandbox, and download the current editor contents locally.

**Architecture:** Extend the existing authenticated workspace REST route with a guarded UTF-8 file write endpoint. Add a focused browser editor in the existing Files tab, using `FileTree` for selection and Monaco for editing. Keep file metadata, dirty state, save, refresh, download, and close behavior inside a new `WorkspaceFileEditor` component.

**Tech Stack:** Hono, Prisma, Node `fs`, React 18, Zustand, `@monaco-editor/react`, TypeScript node:test.

---

## File Structure

### Create

- `apps/api/src/routes/workspaceFileAccess.ts`: Pure workspace path and file helpers shared by read/write routes and unit tests.
- `apps/api/src/routes/workspaceFileAccess.test.ts`: TDD coverage for workspace path confinement and file write behavior.
- `apps/web/src/lib/workspaceFile.ts`: Pure frontend helpers for editor language inference, path labels, and safe download file names.
- `apps/web/src/lib/workspaceFile.test.ts`: TDD coverage for frontend workspace file helpers.
- `apps/web/src/components/WorkspaceFileEditor.tsx`: Monaco-based editor with load, dirty state, save, refresh, download, and close controls.

### Modify

- `apps/api/src/routes/workspace.ts`: Reuse workspace helper functions for file reads and add `PUT /:sessionId/file`.
- `apps/web/src/lib/api.ts`: Add `updateWorkspaceFile(sessionId, path, content)`.
- `apps/web/src/components/AgentStatusPanel.tsx`: Store selected file path and render `WorkspaceFileEditor` in the Files tab.
- `apps/web/src/store/appStore.ts`: Include `file_produced` and `phase_complete` in `AgentEvent['type']` so existing milestone events are type-safe.

## Task 1: Backend Workspace File Helpers

**Files:**
- Create: `apps/api/src/routes/workspaceFileAccess.test.ts`
- Create: `apps/api/src/routes/workspaceFileAccess.ts`

- [ ] **Step 1: Write failing helper tests**

Create `apps/api/src/routes/workspaceFileAccess.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspaceRoot,
  resolveWorkspaceFilePath,
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
```

- [ ] **Step 2: Run helper tests to verify RED**

Run:

```bash
npx tsx --test apps/api/src/routes/workspaceFileAccess.test.ts
```

Expected: FAIL with module-not-found for `workspaceFileAccess.js`.

- [ ] **Step 3: Implement helper module**

Create `apps/api/src/routes/workspaceFileAccess.ts`:

```typescript
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';

export interface WorkspaceFileMetadata {
  path: string;
  size: number;
  modifiedAt: string;
}

export type WorkspacePathResult =
  | { ok: true; absolutePath: string; workspacePath: string }
  | { ok: false; status: 400 | 403; error: string };

export function getWorkspaceRoot(sessionId: string, baseDir = resolve(process.cwd(), '..', '..', '.sandboxes')): string {
  return resolve(baseDir, sessionId);
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

  const normalizedRelative = relative(workspaceRoot, absolutePath).split(sep).join('/');
  const workspacePath = normalizedRelative ? `/workspace/${normalizedRelative}` : '/workspace';
  return { ok: true, absolutePath, workspacePath };
}

export function readWorkspaceTextFile(workspaceRoot: string, inputPath: string): WorkspaceFileMetadata & { content: string } {
  const resolved = resolveWorkspaceFilePath(workspaceRoot, inputPath);
  if (!resolved.ok) throw Object.assign(new Error(resolved.error), { status: resolved.status });
  const stat = statSync(resolved.absolutePath);
  if (stat.isDirectory()) throw Object.assign(new Error('Cannot read a directory'), { status: 400 });
  const content = readFileSync(resolved.absolutePath, 'utf-8');
  return {
    path: resolved.workspacePath,
    content,
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
```

- [ ] **Step 4: Run helper tests to verify GREEN**

Run:

```bash
npx tsx --test apps/api/src/routes/workspaceFileAccess.test.ts
```

Expected: PASS.

## Task 2: Backend Workspace Write Route

**Files:**
- Modify: `apps/api/src/routes/workspace.ts`
- Test: `apps/api/src/routes/workspaceFileAccess.test.ts`

- [ ] **Step 1: Add failing route-facing assertions to helper tests**

Append to `apps/api/src/routes/workspaceFileAccess.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests and verify RED or existing GREEN**

Run:

```bash
npx tsx --test apps/api/src/routes/workspaceFileAccess.test.ts
```

Expected: PASS if Task 1 already created parent directories; if it fails, fix `writeWorkspaceTextFile` before continuing.

- [ ] **Step 3: Wire helpers into workspace route and add PUT endpoint**

Update imports in `apps/api/src/routes/workspace.ts`:

```typescript
import { readdirSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import {
  getWorkspaceRoot,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from './workspaceFileAccess.js';
```

Replace the file-read endpoint implementation with:

```typescript
workspace.get('/:sessionId/file', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const filePath = c.req.query('path');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  if (!filePath) return c.json({ error: 'Missing path query param' }, 400);

  const workDir = getWorkspaceRoot(sessionId);
  try {
    return c.json(readWorkspaceTextFile(workDir, filePath));
  } catch (err: any) {
    const status = typeof err.status === 'number' ? err.status : 404;
    return c.json({ error: `Failed to read file: ${err.message}` }, status as any);
  }
});
```

Add below it:

```typescript
workspace.put('/:sessionId/file', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.path !== 'string' || !body.path) {
    return c.json({ error: 'Missing path' }, 400);
  }
  if (typeof body.content !== 'string') {
    return c.json({ error: 'content must be a string' }, 400);
  }

  const workDir = getWorkspaceRoot(sessionId);
  try {
    return c.json(writeWorkspaceTextFile(workDir, body.path, body.content));
  } catch (err: any) {
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = status === 403 ? err.message : `Failed to write file: ${err.message}`;
    return c.json({ error: message }, status as any);
  }
});
```

- [ ] **Step 4: Run API TypeScript check**

Run:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit backend route work**

Run:

```bash
git add apps/api/src/routes/workspace.ts apps/api/src/routes/workspaceFileAccess.ts apps/api/src/routes/workspaceFileAccess.test.ts
git commit -m "feat: add workspace file write endpoint"
```

## Task 3: Frontend Workspace File Helpers

**Files:**
- Create: `apps/web/src/lib/workspaceFile.test.ts`
- Create: `apps/web/src/lib/workspaceFile.ts`

- [ ] **Step 1: Write failing frontend helper tests**

Create `apps/web/src/lib/workspaceFile.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run frontend helper tests to verify RED**

Run:

```bash
npx tsx --test apps/web/src/lib/workspaceFile.test.ts
```

Expected: FAIL with module-not-found for `workspaceFile.js`.

- [ ] **Step 3: Implement frontend helper module**

Create `apps/web/src/lib/workspaceFile.ts`:

```typescript
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
  const withoutQuery = path.split(/[?#]/)[0] || '';
  const name = withoutQuery.split('/').filter(Boolean).pop() || '';
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'artifact.txt';
}

export function displayWorkspacePath(path: string): string {
  return path.replace(/^\/workspace\/?/, '') || '/';
}
```

- [ ] **Step 4: Run frontend helper tests to verify GREEN**

Run:

```bash
npx tsx --test apps/web/src/lib/workspaceFile.test.ts
```

Expected: PASS.

## Task 4: API Client and Workspace Editor Component

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/WorkspaceFileEditor.tsx`

- [ ] **Step 1: Add API client method**

In `apps/web/src/lib/api.ts`, add near `getWorkspaceFile`:

```typescript
updateWorkspaceFile: (sessionId: string, path: string, content: string) =>
  request<{ path: string; size: number; modifiedAt: string }>(`/workspace/${sessionId}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  }),
```

- [ ] **Step 2: Create editor component**

Create `apps/web/src/components/WorkspaceFileEditor.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Download, FileText, RefreshCw, Save, X } from 'lucide-react';
import { api } from '../lib/api';
import { displayWorkspacePath, inferWorkspaceLanguage, safeDownloadName } from '../lib/workspaceFile';

interface Props {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
}

interface LoadedFile {
  content: string;
  size?: number;
  modifiedAt?: string;
}

export function WorkspaceFileEditor({ sessionId, path, onClose, onSaved }: Props) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useMemo(() => inferWorkspaceLanguage(path), [path]);
  const dirty = loaded !== null && content !== loaded.content;

  const loadFile = async () => {
    setLoading(true);
    setError(null);
    try {
      const file = await api.getWorkspaceFile(sessionId, path);
      const next = {
        content: String(file.content ?? ''),
        size: typeof file.size === 'number' ? file.size : undefined,
        modifiedAt: typeof file.modifiedAt === 'string' ? file.modifiedAt : undefined,
      };
      setLoaded(next);
      setContent(next.content);
    } catch (err: any) {
      setError(err?.message || 'Failed to load file');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoaded(null);
    setContent('');
    loadFile();
  }, [sessionId, path]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateWorkspaceFile(sessionId, path, content);
      setLoaded({ content, size: result.size, modifiedAt: result.modifiedAt });
      onSaved?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  };

  const download = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeDownloadName(path);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-[420px] flex-col overflow-hidden rounded-md border border-hub bg-hub-surface">
      <div className="flex items-center gap-2 border-b border-hub px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-hub-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-hub-primary">{safeDownloadName(path)}</div>
          <div className="truncate text-[11px] text-hub-muted">{displayWorkspacePath(path)}</div>
        </div>
        {dirty && <span className="rounded bg-hub-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-hub-warning">Unsaved</span>}
        <button onClick={loadFile} disabled={loading || saving} className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover disabled:opacity-50" title="Refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button onClick={save} disabled={loading || saving || !dirty} className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-success hover:bg-hub-hover disabled:opacity-40" title="Save">
          <Save className="h-3.5 w-3.5" />
        </button>
        <button onClick={download} disabled={loading || loaded === null} className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-link hover:bg-hub-hover disabled:opacity-40" title="Save as local file">
          <Download className="h-3.5 w-3.5" />
        </button>
        <button onClick={onClose} className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover" title="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {(loaded?.size !== undefined || loaded?.modifiedAt) && (
        <div className="border-b border-hub px-3 py-1 text-[11px] text-hub-muted">
          {loaded.size !== undefined && <span>{loaded.size < 1024 ? `${loaded.size}B` : `${(loaded.size / 1024).toFixed(1)}KB`}</span>}
          {loaded.modifiedAt && <span className="ml-2">{new Date(loaded.modifiedAt).toLocaleString()}</span>}
        </div>
      )}
      {error && <div className="border-b border-hub bg-hub-danger/10 px-3 py-2 text-xs text-hub-danger">{error}</div>}
      <div className="min-h-0 flex-1">
        <Editor
          height="420px"
          language={language}
          value={content}
          theme="vs-dark"
          loading={<div className="px-3 py-2 text-xs text-hub-muted">Loading...</div>}
          onChange={(value) => setContent(value ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run web TypeScript check**

Run:

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: PASS or fail only for missing integration in Task 5; fix direct component/client type errors before continuing.

## Task 5: Files Tab Integration

**Files:**
- Modify: `apps/web/src/components/AgentStatusPanel.tsx`
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: Import the editor component**

In `apps/web/src/components/AgentStatusPanel.tsx`, add:

```typescript
import { WorkspaceFileEditor } from './WorkspaceFileEditor';
```

- [ ] **Step 2: Store selected file path**

Inside `AgentStatusPanel`, add:

```typescript
const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
```

- [ ] **Step 3: Render file tree and editor together**

Replace the Files tab body with:

```tsx
{activeTab === 'Files' && activeSessionId && (
  <div className="space-y-4">
    <FileTree sessionId={activeSessionId} onSelectFile={setSelectedFilePath} />
    {selectedFilePath && (
      <WorkspaceFileEditor
        sessionId={activeSessionId}
        path={selectedFilePath}
        onClose={() => setSelectedFilePath(null)}
      />
    )}
    <VersionTimeline sessionId={activeSessionId} />
  </div>
)}
```

- [ ] **Step 4: Widen agent event type for existing milestone events**

In `apps/web/src/store/appStore.ts`, update `AgentEvent['type']`:

```typescript
type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request' | 'token_update' | 'file_produced' | 'phase_complete';
```

- [ ] **Step 5: Run web checks**

Run:

```bash
npx tsx --test apps/web/src/lib/workspaceFile.test.ts
npx tsc --noEmit -p apps/web/tsconfig.json
npm run build --workspace @agenthub/web
```

Expected: PASS.

- [ ] **Step 6: Commit frontend editor work**

Run:

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/workspaceFile.ts apps/web/src/lib/workspaceFile.test.ts apps/web/src/components/WorkspaceFileEditor.tsx apps/web/src/components/AgentStatusPanel.tsx apps/web/src/store/appStore.ts
git commit -m "feat: add browser workspace file editor"
```

## Task 6: Full Verification and Review Checklist

**Files:**
- Review changed files only.

- [ ] **Step 1: Run backend checks**

Run:

```bash
npx tsx --test apps/api/src/routes/workspaceFileAccess.test.ts
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: PASS.

- [ ] **Step 2: Run frontend checks**

Run:

```bash
npx tsx --test apps/web/src/lib/workspaceFile.test.ts
npx tsc --noEmit -p apps/web/tsconfig.json
npm run build --workspace @agenthub/web
```

Expected: PASS.

- [ ] **Step 3: Inspect diff scope**

Run:

```bash
git diff --stat HEAD~2..HEAD
git diff --check HEAD~2..HEAD
git status --short
```

Expected: Only planned files are committed for this feature. Pre-existing untracked or modified files may remain unstaged.

- [ ] **Step 4: Manual code review checklist**

Confirm and report:

1. Scope: diff is limited to workspace file editing and docs/plans.
2. File boundaries: no `.env`, generated migrations, Docker files, or unrelated config were changed.
3. Compatibility: existing workspace read API remains compatible; new API method is additive.
4. Exceptional states: missing paths, non-string content, traversal, directory writes, load failures, save failures, and download fallback are handled.
5. Duplication: shared workspace path/file logic and frontend filename/language helpers avoid repeated ad hoc logic.
