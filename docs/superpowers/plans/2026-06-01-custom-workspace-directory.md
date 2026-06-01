# Custom Workspace Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to specify an existing directory on their machine as the workspace for a session, instead of using the default `.sandboxes/{sessionId}/` directory.

**Architecture:** Extend the existing `realWorkspacePaths` infrastructure to persist workspace configuration in the database, modify `SandboxManager` to bind-mount user-specified directories, and add a UI component for workspace selection. The sandbox container will mount the user's directory as `/workspace`, allowing agents to work directly on the user's actual project files.

**Tech Stack:** Prisma (database), Hono (API), React (frontend), Dockerode (container management)

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/prisma/schema.prisma` | Add workspace fields to Session model |
| `apps/api/src/agent/SandboxManager.ts` | Modify create() to accept custom hostWorkDir |
| `apps/api/src/routes/sessions.ts` | Persist workspace config to database |
| `apps/api/src/ws/handler.ts` | Pass workspace info to sandbox creation |
| `apps/web/src/components/WorkspaceSelector.tsx` | New: UI for selecting workspace directory |
| `apps/web/src/components/ChatView.tsx` | Integrate WorkspaceSelector |
| `apps/web/src/lib/api.ts` | Add workspace API methods |
| `packages/shared/src/types.ts` | Add workspace types |

---

## Task 1: Database Schema - Add Workspace Fields to Session

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/YYYYMMDD_add_workspace_fields/migration.sql`

- [ ] **Step 1: Add workspace fields to Session model**

```prisma
model Session {
  id                 String         @id @default(uuid())
  title              String         @default("New Session")
  type               String         @default("solo")
  permissionMode     String         @default("ask")
  userId             String
  sandboxContainerId String?
  // New workspace fields
  workspacePath      String?        // Custom workspace path on host
  workspaceMode      String         @default("sandbox") // "sandbox" | "custom"
  writePermission    String         @default("ask")     // "ask" | "auto"
  user               User           @relation(fields: [userId], references: [id])
  messages           Message[]
  agents             SessionAgent[]
  quoteReferences    QuoteReference[]
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
}
```

- [ ] **Step 2: Generate migration**

Run: `cd apps/api && npx prisma migrate dev --name add-workspace-fields`

- [ ] **Step 3: Verify migration**

Run: `npx prisma studio` and check Session table has new fields

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat: add workspace fields to Session schema"
```

---

## Task 2: Backend API - Workspace Configuration Endpoints

**Files:**
- Modify: `apps/api/src/routes/sessions.ts`

- [ ] **Step 1: Update POST /:id/workspace to persist to database**

Replace the existing workspace endpoint with database persistence:

```typescript
// POST /:id/workspace — set workspace path
sessions.post('/:id/workspace', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  let body: { path: string; mode?: 'sandbox' | 'custom'; writePermission?: 'ask' | 'auto' };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  if (!body.path) return c.json({ error: 'path is required' }, 400);

  // Resolve and validate path (prevent traversal)
  const resolved = path.resolve(body.path);
  let real: string;
  try { real = fs.realpathSync(resolved); } catch {
    return c.json({ error: 'Path does not exist' }, 400);
  }
  if (!fs.statSync(real).isDirectory()) return c.json({ error: 'Not a directory' }, 400);

  // Allowlist check against RESOLVED path
  const roots = config.realWorkspaceRoots.split(':');
  const allowed = roots.some((root) => real.startsWith(path.resolve(root)));
  if (!allowed) return c.json({ error: `Path not allowed. Must be under: ${roots.join(', ')}` }, 403);

  // Persist to database
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      workspacePath: real,
      workspaceMode: body.mode || 'custom',
      writePermission: body.writePermission || 'ask',
    },
  });

  // Update in-memory maps for backward compatibility
  realWorkspacePaths.set(sessionId, real);
  workspaceModes.set(sessionId, body.mode || 'custom');

  broadcast(sessionId, {
    type: 'workspace_changed',
    sessionId,
    path: real,
    mode: body.mode || 'custom',
    writePermission: body.writePermission || 'ask',
    timestamp: Date.now(),
  });

  return c.json({
    success: true,
    path: real,
    mode: body.mode || 'custom',
    writePermission: body.writePermission || 'ask',
  });
});
```

- [ ] **Step 2: Update GET /:id/workspace to read from database**

```typescript
// GET /:id/workspace — get current workspace config
sessions.get('/:id/workspace', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { workspacePath: true, workspaceMode: true, writePermission: true },
  });
  if (!session) return c.json({ error: 'Session not found' }, 404);

  return c.json({
    path: session.workspacePath || null,
    mode: session.workspaceMode || 'sandbox',
    writePermission: session.writePermission || 'ask',
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/sessions.ts
git commit -m "feat: persist workspace configuration to database"
```

---

## Task 3: SandboxManager - Support Custom Workspace Directory

**Files:**
- Modify: `apps/api/src/agent/SandboxManager.ts`

- [ ] **Step 1: Add customHostWorkDir parameter to create method**

```typescript
export class SandboxManager {
  static async create(
    sessionId: string,
    memoryMb?: number,
    customHostWorkDir?: string,  // New parameter
  ): Promise<SandboxInfo> {
    // Use custom path if provided, otherwise use default sandbox path
    const hostWorkDir = customHostWorkDir || resolve(SANDBOXES_ROOT, sessionId);

    // Only create directory if using default sandbox path
    if (!customHostWorkDir && !existsSync(hostWorkDir)) {
      mkdirSync(hostWorkDir, { recursive: true });
    }

    // Validate that custom directory exists
    if (customHostWorkDir && !existsSync(customHostWorkDir)) {
      throw new Error(`Custom workspace directory does not exist: ${customHostWorkDir}`);
    }

    const containerName = `agenthub-sandbox-${sessionId}`;

    // Clean up any stale container with same name
    await this.cleanupContainer(containerName);

    const mem = memoryMb ?? config.sandbox.soloMemoryMb;

    const container = await docker.createContainer({
      name: containerName,
      Image: config.sandbox.image,
      WorkingDir: '/workspace',
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        Memory: mem * 1024 * 1024,
        Binds: [`${hostWorkDir}:/workspace`],
      },
    });

    await container.start();

    return {
      containerId: container.id,
      workDir: '/workspace',
      hostWorkDir,
    };
  }

  // ... rest of the class
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/agent/SandboxManager.ts
git commit -m "feat: SandboxManager supports custom workspace directory"
```

---

## Task 4: WebSocket Handler - Use Workspace Config for Sandbox Creation

**Files:**
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: Load workspace config in handleConnection**

In the `handleConnection` function, after loading the session, load the workspace config:

```typescript
// After session verification
const sessionWithWorkspace = await prisma.session.findUnique({
  where: { id: sessionId },
  select: {
    id: true,
    userId: true,
    permissionMode: true,
    type: true,
    workspacePath: true,
    workspaceMode: true,
    writePermission: true,
  },
});

// Store workspace config in memory
if (sessionWithWorkspace?.workspacePath) {
  realWorkspacePaths.set(sessionId, sessionWithWorkspace.workspacePath);
  workspaceModes.set(sessionId, sessionWithWorkspace.workspaceMode || 'custom');
}
```

- [ ] **Step 2: Modify getOrCreateSandbox to use workspace path**

Update the `getOrCreateSandbox` function in `state.ts`:

```typescript
export async function getOrCreateSandbox(sessionId: string, sessionType?: string | null) {
  let sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    // Check for custom workspace path
    const customWorkDir = realWorkspacePaths.get(sessionId);
    const memoryMb = sessionType === 'group' ? config.sandbox.groupMemoryMb : config.sandbox.soloMemoryMb;

    // Check if a container already exists for this session
    const containerName = `agenthub-sandbox-${sessionId}`;
    const Docker = (await import('dockerode')).default;
    const docker = new Docker({ socketPath: config.sandbox.hostDockerSocket });
    const existingContainers = await docker.listContainers({
      all: true,
      filters: { name: [containerName] },
    });

    if (existingContainers.length > 0) {
      // Reuse existing container
      const hostWorkDir = customWorkDir || resolve(config.sandbox.root, sessionId);
      sandbox = {
        containerId: existingContainers[0].Id,
        workDir: '/workspace',
        hostWorkDir,
      };
      if (existingContainers[0].State !== 'running') {
        await docker.getContainer(existingContainers[0].Id).start().catch(() => {});
      }
    } else {
      // Create new container with custom or default workspace
      sandbox = await SandboxManager.create(sessionId, memoryMb, customWorkDir);
    }
    sandboxes.set(sessionId, sandbox);
  }
  return sandbox;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/handler.ts apps/api/src/ws/state.ts
git commit -m "feat: use custom workspace path for sandbox creation"
```

---

## Task 5: Shared Types - Add Workspace Types

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add workspace types**

```typescript
export type WorkspaceMode = 'sandbox' | 'custom';
export type WritePermission = 'ask' | 'auto';

export interface WorkspaceConfig {
  path: string | null;
  mode: WorkspaceMode;
  writePermission: WritePermission;
}

export interface Session {
  // ... existing fields
  workspacePath?: string | null;
  workspaceMode?: WorkspaceMode;
  writePermission?: WritePermission;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add workspace types to shared types"
```

---

## Task 6: Frontend API - Add Workspace Methods

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add workspace API methods**

```typescript
export const api = {
  // ... existing methods

  async getSessionWorkspace(sessionId: string): Promise<{ path: string | null; mode: string; writePermission: string }> {
    return request(`/sessions/${sessionId}/workspace`);
  },

  async setSessionWorkspace(sessionId: string, config: { path: string; mode?: string; writePermission?: string }): Promise<{ success: boolean; path: string; mode: string; writePermission: string }> {
    return request(`/sessions/${sessionId}/workspace`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat: add workspace API methods to frontend"
```

---

## Task 7: Frontend UI - WorkspaceSelector Component

**Files:**
- Create: `apps/web/src/components/WorkspaceSelector.tsx`

- [ ] **Step 1: Create WorkspaceSelector component**

```tsx
import { useState, useEffect } from 'react';
import { FolderOpen, Shield, Zap, X } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  sessionId: string;
  onClose: () => void;
  onWorkspaceChanged?: (path: string) => void;
}

export function WorkspaceSelector({ sessionId, onClose, onWorkspaceChanged }: Props) {
  const [path, setPath] = useState('');
  const [writePermission, setWritePermission] = useState<'ask' | 'auto'>('ask');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentWorkspace, setCurrentWorkspace] = useState<{ path: string | null; writePermission: string } | null>(null);

  useEffect(() => {
    api.getSessionWorkspace(sessionId).then(setCurrentWorkspace).catch(console.error);
  }, [sessionId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError('Path is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.setSessionWorkspace(sessionId, {
        path: path.trim(),
        mode: 'custom',
        writePermission,
      });
      onWorkspaceChanged?.(result.path);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to set workspace');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-96 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-hub-primary">Set Workspace Directory</h3>
          <button onClick={onClose} className="p-1 hover:bg-hub-hover rounded">
            <X className="w-4 h-4 text-hub-tertiary" />
          </button>
        </div>

        {currentWorkspace?.path && (
          <div className="mb-4 p-3 bg-hub-surface rounded-hub-lg">
            <div className="text-[10px] text-hub-tertiary uppercase tracking-wider mb-1">Current Workspace</div>
            <div className="text-xs text-hub-secondary font-mono break-all">{currentWorkspace.path}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-hub-tertiary mb-1 block">Directory Path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/user/projects/my-project"
                className="flex-1 px-3 py-2 text-xs bg-hub-surface border border-hub-border rounded-hub-lg text-hub-primary focus:outline-none focus:border-hub-accent font-mono"
              />
              <button
                type="button"
                onClick={() => {
                  // Native file dialog would go here
                  // For now, just focus the input
                }}
                className="p-2 bg-hub-surface border border-hub-border rounded-hub-lg hover:bg-hub-hover transition"
                title="Browse"
              >
                <FolderOpen className="w-4 h-4 text-hub-tertiary" />
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-hub-tertiary mb-2 block">Write Permission</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setWritePermission('ask')}
                className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-hub-lg border transition ${
                  writePermission === 'ask'
                    ? 'border-hub-warning bg-hub-warning/10 text-hub-warning'
                    : 'border-hub-border bg-hub-surface text-hub-tertiary hover:bg-hub-hover'
                }`}
              >
                <Shield className="w-4 h-4" />
                <div className="text-left">
                  <div className="text-xs font-medium">Ask</div>
                  <div className="text-[10px] opacity-70">Request approval</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setWritePermission('auto')}
                className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-hub-lg border transition ${
                  writePermission === 'auto'
                    ? 'border-hub-success bg-hub-success/10 text-hub-success'
                    : 'border-hub-border bg-hub-surface text-hub-tertiary hover:bg-hub-hover'
                }`}
              >
                <Zap className="w-4 h-4" />
                <div className="text-left">
                  <div className="text-xs font-medium">Auto</div>
                  <div className="text-[10px] opacity-70">Auto-approve</div>
                </div>
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs text-hub-danger bg-hub-danger/10 px-3 py-2 rounded-hub-lg">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs text-hub-secondary hover:bg-hub-hover rounded-hub-lg transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !path.trim()}
              className="px-4 py-2 text-xs bg-hub-accent text-white rounded-hub-lg hover:bg-hub-accent-hover transition disabled:opacity-50"
            >
              {loading ? 'Setting...' : 'Set Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/WorkspaceSelector.tsx
git commit -m "feat: add WorkspaceSelector component"
```

---

## Task 8: Frontend UI - Integrate WorkspaceSelector into ChatView

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Add workspace state and button**

Add state for workspace selector visibility:

```typescript
const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
```

Add a button in the session header (near the settings button):

```tsx
<button
  onClick={() => setShowWorkspaceSelector(true)}
  className="p-1.5 rounded hover:bg-hub-hover text-hub-tertiary transition shrink-0"
  title="Set Workspace Directory"
>
  <FolderOpen className="w-3.5 h-3.5" />
</button>
```

Add the WorkspaceSelector modal at the bottom of the component:

```tsx
{showWorkspaceSelector && activeSessionId && (
  <WorkspaceSelector
    sessionId={activeSessionId}
    onClose={() => setShowWorkspaceSelector(false)}
    onWorkspaceChanged={(path) => {
      console.log('Workspace changed to:', path);
    }}
  />
)}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat: integrate WorkspaceSelector into ChatView"
```

---

## Task 9: Backend - Permission Proxy for Write Operations

**Files:**
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: Add write permission check to tool_use events**

When an agent attempts a write operation (Write, Edit, Bash), check the session's writePermission setting:

```typescript
// In the tool_use handler
case 'tool_use': {
  const isWriteOperation = ['Write', 'Edit', 'Bash', 'write', 'edit'].includes(event.toolName);
  const sessionWritePermission = workspaceModes.get(sessionId) === 'custom'
    ? (await prisma.session.findUnique({ where: { id: sessionId }, select: { writePermission: true } }))?.writePermission || 'ask'
    : 'auto';

  if (isWriteOperation && sessionWritePermission === 'ask') {
    // Convert to permission_request
    broadcast(sessionId, {
      type: 'permission_request',
      tool: event.toolName,
      path: event.filePath,
      agentMessageId,
    });
  } else {
    // Auto-approve
    broadcast(sessionId, {
      type: 'agent_status',
      status: 'tool_use',
      agentMessageId,
      details: { toolName: event.toolName, input: event.toolInput },
    });
  }
  break;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/ws/handler.ts
git commit -m "feat: add write permission proxy for custom workspace"
```

---

## Task 10: Testing and Verification

- [ ] **Step 1: Test custom workspace selection**

1. Create a test directory: `mkdir -p /tmp/test-workspace`
2. Start the application
3. Create a new session
4. Click the workspace button
5. Enter `/tmp/test-workspace`
6. Set permission to "Auto"
7. Click "Set Workspace"
8. Verify the workspace is set (check API response)

- [ ] **Step 2: Test agent writes to custom workspace**

1. Send a message to the agent: "Create a file called test.txt with content 'Hello World'"
2. Verify the file is created in `/tmp/test-workspace/test.txt`
3. Check the file content

- [ ] **Step 3: Test write permission (Ask mode)**

1. Create a new session with "Ask" permission
2. Send a message asking agent to create a file
3. Verify a permission request appears
4. Approve the request
5. Verify the file is created

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test: verify custom workspace functionality"
```

---

## Summary

| Task | Description | Dependencies |
|------|-------------|--------------|
| 1 | Database schema | None |
| 2 | Backend API | Task 1 |
| 3 | SandboxManager | None |
| 4 | WebSocket handler | Task 3 |
| 5 | Shared types | None |
| 6 | Frontend API | Task 5 |
| 7 | WorkspaceSelector UI | Task 6 |
| 8 | ChatView integration | Task 7 |
| 9 | Permission proxy | Task 4 |
| 10 | Testing | All |

Total: 10 tasks, ~30 steps
