# Multi-Provider Agents + Session & Agent Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six independent improvements: (1) Codex agent接入 via `@openai/codex-sdk` (SDK 已确认可用 v0.133.0), (2) session/group chat rename with CLAUDE.md context injection for all agents, (3) custom agent creation from Markdown files (role-only, settings inherit defaults) + solo→group agent pull, (4) real workspace deployment via Docker bind-mount (two modes: read-only-default vs full-access), (5) session-level agent config override in Monaco editor, (6) encrypted API key storage with masked frontend display.

**Architecture:** Builds on existing `AbstractProvider` + `AgentRuntimeFactory` + `ProviderFactory` pattern. Codex 使用官方 SDK (`@openai/codex-sdk`)，API 表面与 Claude Agent SDK 对等 — `Thread.runStreamed()` 返回 `AsyncGenerator<ThreadEvent>`，原生支持 `resumeThread(id)` 会话持久化，`approvalPolicy` 权限控制，`sandboxMode` 沙箱隔离。`providerConfig` 合并原 `settings` 字段，统一存放 model/tools/endpoint/apiKey。Session rename 写入所有 agent 的 CLAUDE.md（通过 inbox 延迟注入）。真实工作空间通过 Docker `-v` bind-mount 到容器 `/workspace`，agent 仍在沙箱内执行。API key 使用 `crypto.createCipheriv` (AES-256-GCM) 加密存储，前端脱敏显示。

**Tech Stack:** TypeScript, Hono 4+, Prisma/PostgreSQL, React 18+ / Zustand / Tailwind / Monaco Editor, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` v0.133.0, Dockerode, AES-256-GCM (Node.js `crypto`)

**Codex 调研前置：** 执行 Task 2 前，先调研 Codex 是否有 SDK/npm 包。若有 → 实现 CodexProvider（SDK 优先）；若仅有 CLI → 评估 CLI `--json` 稳定性后实现；若 CLI 不可靠 → 搁置并创建 GitHub issue。

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/prisma/schema.prisma` | Modify | Add `provider` + `providerConfig` to Agent; add `systemPromptOverride` to SessionAgent; add `encryptedApiKeys` to User |
| `apps/api/src/agent/providers/codex.ts` | Create | Codex SDK/CLI provider (implements AbstractProvider) |
| `apps/api/src/agent/providers/factory.ts` | Modify | Register Codex provider |
| `apps/api/src/agent/AgentRuntimeFactory.ts` | Modify | Wire Codex runtime |
| `apps/api/src/lib/crypto.ts` | Create | AES-256-GCM encrypt/decrypt helpers |
| `packages/shared/src/types.ts` | Modify | AgentProvider, AgentWithProvider, session_renamed WS type, WorkspaceMode |
| `apps/api/src/routes/agents.ts` | Modify | Custom agent from .md; provider config update; API key encryption |
| `apps/api/src/routes/sessions.ts` | Modify | Session rename → broadcast + inbox CLAUDE.md update; real workspace path; session agent config override |
| `apps/web/src/components/AgentCreator.tsx` | Create | Wizard: upload .md → preview → create agent (role-only, settings inherit) |
| `apps/web/src/components/AgentConfigEditor.tsx` | Create | Monaco editor for session-level agent config override |
| `apps/web/src/components/AgentCard.tsx` | Modify | Provider badge; solo→group "Add to Group" button; capability differences |
| `apps/web/src/components/SessionHeader.tsx` | Modify | Inline rename; real workspace mode toggle (read-only / full-access) |
| `apps/web/src/components/ChatView.tsx` | Modify | Wires AgentConfigEditor trigger; workspace mode selector |
| `apps/web/src/components/ProviderConfigPage.tsx` | Create | API key entry with masked display + per-provider endpoint config |
| `apps/web/src/store/appStore.ts` | Modify | renameSession, pullAgentToGroup, setWorkspacePath/Mode actions |
| `apps/web/src/hooks/useChat.ts` | Modify | session_renamed WS handler |
| `apps/web/src/lib/api.ts` | Modify | API methods for new endpoints |
| `apps/api/src/ws/handler.ts` | Modify | session_renamed → inbox broadcast to all agents; real workspace bind-mount |
| `apps/api/src/ws/state.ts` | Modify | realWorkspacePaths map; workspaceMode per session |
| `apps/api/src/config.ts` | Modify | Real workspace allowlist; encryption key env var |

---

### Task 1: Agent DB Extension — Merge settings into providerConfig

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `packages/shared/src/types.ts`

Merge `settings` JSON into `providerConfig`. `providerConfig` now holds everything: model, tools, endpoint, apiKey, skill config. Remove standalone `settings` field. Add `capabilities` JSONB for custom agent capability profiles.

- [x] **Step 1: Update Prisma schema**

```prisma
model Agent {
  id             String         @id @default(uuid())
  name           String         @unique
  displayName    String
  description    String
  systemPrompt   String
  provider       String         @default("claude-code")
  providerConfig Json?          // merged: model, tools, endpoint, apiKey, skill config, etc.
  capabilities   Json?          // user-defined agent capability profiles (optional)
  isActive       Boolean        @default(true)
  sessionAgents  SessionAgent[]
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}
```

Remove the `settings` column:

```sql
-- In migration: ALTER TABLE "Agent" DROP COLUMN "settings";
-- Or keep in schema but stop using; migration handles it
```

Add `systemPromptOverride` to SessionAgent for per-session config:

```prisma
model SessionAgent {
  id                   String  @id @default(uuid())
  sessionId            String
  agentId              String
  systemPromptOverride String? // session-level system prompt override
  session              Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  agent                Agent   @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@unique([sessionId, agentId])
}
```

Add `encryptedApiKeys` to User:

```prisma
model User {
  id                String        @id @default(uuid())
  githubId          Int           @unique
  login             String
  avatarUrl         String?
  email             String?
  encryptedApiKeys  String?       // AES-256-GCM encrypted JSON: { "codex": "encrypted_key", ... }
  sessions          Session[]
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt
}
```

- [x] **Step 2: Run Prisma migration**

```bash
cd apps/api && npx prisma migrate dev --name merge_settings_provider_config
```

Note: if `settings` column has data, migration needs to copy `settings` → `providerConfig` first.

- [x] **Step 3: Add types to shared types.ts**

```typescript
export type AgentProvider = 'claude-code' | 'codex';

export interface AgentProviderConfig {
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  forbiddenTools?: string[];
  skills?: string[];
  [key: string]: unknown;
}

export interface AgentWithProvider {
  id: string;
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  provider: AgentProvider;
  providerConfig?: AgentProviderConfig | null;
  capabilities?: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceMode = 'read_only_default' | 'full_access';
```

- [x] **Step 4: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations packages/shared/src/types.ts
git commit -m "feat: merge settings into providerConfig, add session-level config override, encrypted API key storage"
```

---

### Task 2: Codex SDK Provider

**Files:**
- Create: `apps/api/src/agent/providers/codex.ts`
- Modify: `apps/api/src/agent/providers/factory.ts`
- Modify: `apps/api/src/agent/AgentRuntimeFactory.ts`

**Research result (2026-05-26):** `@openai/codex-sdk` v0.133.0 exists — full TypeScript SDK with `Codex` class, `Thread.start()` / `runStreamed()`, native `resumeThread(id)`, typed `ThreadEvent` async generator. API surface mirrors Claude Agent SDK. No CLI spawn needed.

| Concept | Claude Agent SDK | Codex SDK |
|---------|-----------------|-----------|
| Client | `query({ prompt })` | `thread.runStreamed(input)` |
| Session resume | `resume: sessionId` | `resumeThread(id)` |
| Permissions | `permissionMode` | `approvalPolicy` |
| Sandbox | N/A (host cwd) | `sandboxMode` |
| Working dir | `cwd` | `workingDirectory` |
| Structured output | `outputFormat` | `outputSchema` |
| Session store | SDK-managed | `~/.codex/sessions` |

- [x] **Step 1: Install Codex SDK**

```bash
cd apps/api && npm install @openai/codex-sdk
```

- [x] **Step 2: Create CodexProvider**

```typescript
// apps/api/src/agent/providers/codex.ts
import { Codex, Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { decryptApiKey } from '../../lib/crypto.js';

function threadEventToUnified(event: ThreadEvent): UnifiedAgentEvent | null {
  const base = { timestamp: Date.now() };
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      switch (item.type) {
        case 'agent_message':
          return { ...base, type: 'thinking', content: item.text };
        case 'reasoning':
          return { ...base, type: 'thinking', content: `[Reasoning] ${item.text}` };
        case 'command_execution':
          if (event.type === 'item.started') {
            return { ...base, type: 'tool_use', toolName: 'Bash', toolInput: { command: item.command } };
          }
          if (event.type === 'item.completed') {
            return { ...base, type: 'tool_result', content: item.aggregated_output };
          }
          return null;
        case 'file_change':
          if (event.type === 'item.completed') {
            const paths = item.changes.map((c) => `${c.kind} ${c.path}`).join(', ');
            return { ...base, type: 'tool_result', content: `File changes: ${paths} — ${item.status}` };
          }
          return null;
        case 'mcp_tool_call':
          if (event.type === 'item.started') {
            return { ...base, type: 'tool_use', toolName: item.tool, toolInput: item.arguments };
          }
          if (event.type === 'item.completed' && item.result) {
            return { ...base, type: 'tool_result', content: JSON.stringify(item.result) };
          }
          return null;
        case 'web_search':
          if (event.type === 'item.started') {
            return { ...base, type: 'tool_use', toolName: 'WebSearch', toolInput: { query: item.query } };
          }
          return null;
        case 'error':
          return { ...base, type: 'error', message: item.message };
        default:
          return null;
      }
    }
    case 'turn.completed':
      return { ...base, type: 'done', exitCode: 0 };
    case 'turn.failed':
      return { ...base, type: 'error', message: event.error.message };
    case 'error':
      return { ...base, type: 'error', message: event.message };
    default:
      return null; // thread.started, turn.started — no user-visible event
  }
}

export class CodexProvider implements AbstractProvider {
  readonly name = 'codex';
  readonly capabilities = {
    persistentSession: true,      // resumeThread(id) — native session persistence
    permissionProxy: true,        // approvalPolicy controls permissions
    streamingOutput: true,
    independentMemory: true,      // Thread isolates conversation context
    independentConfig: true,
  };

  private handlers: EventHandler[] = [];
  private sdk: Codex | null = null;
  private thread: Thread | null = null;
  private killed = false;
  private threadId: string | undefined;

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  getAgentHome(): string { return '/workspace'; }

  isAlive(): boolean { return !this.killed && this.thread !== null; }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.killed = false;

    // Resolve API key: priority = injected config > user's encrypted key
    let apiKey = config.apiKey;
    if (!apiKey && config.userId) {
      try {
        const { prisma } = await import('../../db/prisma.js');
        const user = await prisma.user.findUnique({
          where: { id: config.userId },
          select: { encryptedApiKeys: true },
        });
        if (user?.encryptedApiKeys) {
          const keys = JSON.parse(user.encryptedApiKeys);
          if (keys.codex?.apiKey) {
            apiKey = decryptApiKey(keys.codex.apiKey);
          }
        }
      } catch { /* use env var as fallback */ }
    }

    this.sdk = new Codex({
      apiKey,
      baseUrl: config.endpoint,
      env: { ...process.env, ...config.env as Record<string, string> },
    });

    const sandboxMode = config.trustMode ? 'workspace-write' as const : 'read-only' as const;
    const approvalPolicy = config.trustMode ? 'on-request' as const : 'on-request' as const;

    const threadOptions = {
      model: config.model,
      sandboxMode,
      workingDirectory: config.hostWorkDir || workDir,
      approvalPolicy,
    };

    // Resume existing thread or start new
    this.thread = this.threadId
      ? this.sdk.resumeThread(this.threadId, threadOptions)
      : this.sdk.startThread(threadOptions);

    // Capture thread ID from the first event for future resume
    this.threadId = this.thread.id || undefined;

    try {
      const { events } = await this.thread.runStreamed(prompt);
      for await (const event of events) {
        if (this.killed) break;
        // Capture thread ID on first event
        if (event.type === 'thread.started') {
          this.threadId = event.thread_id;
        }
        const unified = threadEventToUnified(event);
        if (unified) this.emit(unified);
      }
    } catch (err: any) {
      if (!this.killed) {
        this.emit({ type: 'error', message: `Codex error: ${err.message}`, timestamp: Date.now() });
      }
    }
  }

  sendPrompt(_prompt: string): void { /* use thread.runStreamed for follow-up */ }

  stop(): void {
    this.killed = true;
    this.sdk = null;
    this.thread = null;
  }
}
```

- [x] **Step 3: Register in factory.ts + wire in AgentRuntimeFactory.ts**

```typescript
// factory.ts:
import { CodexProvider } from './codex.js';
ProviderFactory.register('codex', () => new CodexProvider());

// AgentRuntimeFactory.ts:
export class CodexRuntime implements AgentRuntime {
  readonly provider = 'codex';
  async execute(task: AgentTaskInput): Promise<AgentTaskResult> {
    const provider = new CodexProvider();
    return new Promise((resolve, reject) => {
      let output = '';
      provider.onEvent((ev) => {
        if (ev.type === 'thinking') output += (ev.content || '');
        if (ev.type === 'done') resolve({ output, exitCode: ev.exitCode ?? 0 });
        if (ev.type === 'error') reject(new Error(ev.message));
      });
      provider.start(task.sessionId, task.prompt, task.containerId, task.workDir, {
        agentName: task.agentName,
        hostWorkDir: task.hostWorkDir,
        model: task.model,
        apiKey: task.apiKey,
        endpoint: task.endpoint,
        env: task.env,
        trustMode: task.trustMode,
        userId: task.userId,
      }).catch(reject);
    });
  }
}
```

- [x] **Step 4: Update ProviderConfig type to include apiKey + endpoint**

In `apps/api/src/agent/providers/base.ts`, add optional fields to `ProviderConfig`:

```typescript
export interface ProviderConfig {
  agentName: string;
  hostWorkDir?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  trustMode?: boolean;
  // Codex-specific:
  apiKey?: string;
  endpoint?: string;
  userId?: string;
}
```

- [x] **Step 5: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/agent/providers/codex.ts apps/api/src/agent/providers/factory.ts apps/api/src/agent/AgentRuntimeFactory.ts apps/api/src/agent/providers/base.ts
git commit -m "feat: add Codex SDK provider with native session persistence"
```

---

### Task 3: Agent Creation UI — Provider Selection

**Files:**
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `apps/web/src/lib/api.ts`

Add provider + providerConfig to agent create/update API. Frontend dropdown for provider selection with contextual hints (Codex requires API key, Claude uses default SDK).

- [x] **Step 1: Extend agent routes**

In `apps/api/src/routes/agents.ts`, update the create and update schemas:

```typescript
const createSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  provider: z.enum(['claude-code', 'codex']).default('claude-code'),
  providerConfig: z.record(z.unknown()).optional(), // model, tools, endpoint, etc.
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
  systemPrompt: z.string().min(1).optional(),
  provider: z.enum(['claude-code', 'codex']).optional(),
  providerConfig: z.record(z.unknown()).optional(),
  capabilities: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});
```

GET returns provider + providerConfig:

```typescript
select: {
  id: true, name: true, displayName: true, description: true,
  systemPrompt: true, provider: true, providerConfig: true,
},
```

- [x] **Step 2: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/routes/agents.ts
git commit -m "feat: add provider + providerConfig to agent CRUD API"
```

---

### Task 4: Agent Card — Provider Badge + Capability Display

**Files:**
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/components/AgentCardFaces.tsx`
- Modify: `apps/web/src/components/AgentStatusPanel.tsx`

Show provider badge with capability differentiation. Claude shows "SDK · Session · Stream", Codex shows "CLI · One-shot".

- [x] **Step 1: Add provider badge + capability text**

```tsx
const providerInfo = (provider: string) => {
  switch (provider) {
    case 'claude-code':
      return { label: 'Claude', color: 'bg-orange-500/20 text-orange-400',
        caps: 'SDK · Session · Stream' };
    case 'codex':
      return { label: 'Codex', color: 'bg-green-500/20 text-green-400',
        caps: 'CLI · One-shot' };
    default:
      return { label: provider, color: 'bg-hub-muted/20 text-hub-muted',
        caps: 'Unknown' };
  }
};

// In expanded card body:
const info = providerInfo(agent.provider || 'claude-code');
<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${info.color}`}>{info.label}</span>
<span className="text-[10px] text-hub-muted ml-1">{info.caps}</span>
```

Include also a "Configure" button (wired to Task 9) and an "Add to Group" button (wired to Task 7).

- [x] **Step 2: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/web/src/components/AgentCard.tsx
git commit -m "feat: add provider badge with capability differentiation to AgentCard"
```

---

### Task 5: Session/Group Chat Rename + CLAUDE.md Context Injection

**Files:**
- Modify: `apps/api/src/routes/sessions.ts`
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/web/src/components/SessionHeader.tsx`
- Modify: `apps/web/src/hooks/useChat.ts`
- Modify: `apps/web/src/store/appStore.ts`

When a session is renamed, broadcast the change AND inject updated group context into all agents' CLAUDE.md (via inbox), so each agent knows: (a) it's in a group session, (b) who the other members are, (c) the session's current topic/purpose (from the title).

Import `broadcast` from `state.ts` directly to avoid circular dependency.

**✅ 已完成部分：** Session rename REST API (`PATCH /:id`) 和 UI（SessionList.tsx 中的铅笔图标触发 inline input）已实现。

- [x] **Step 1: Generate group context CLAUDE.md snippet**

```typescript
// apps/api/src/agent/groupContext.ts (new helper)
import { prisma } from '../db/prisma.js';

export async function buildGroupContext(sessionId: string, sessionTitle: string): Promise<string> {
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { name: true, displayName: true, description: true } } },
  });

  if (sessionAgents.length <= 1) return ''; // solo session — no group context needed

  const memberList = sessionAgents
    .map((sa) => `- **${sa.agent.displayName}** (\`${sa.agent.name}\`): ${sa.agent.description}`)
    .join('\n');

  return `\n## Group Chat Context\n
You are participating in a group chat session: **"${sessionTitle}"**.

### Team Members
${memberList}

### Coordination Rules
- You are one of multiple agents collaborating in this session.
- Other agents may send you messages via the inbox system — check for new messages at the start of each turn.
- When you complete a task or make important changes, other agents will be notified automatically.
- If you need help from another agent, you can request it — the hub will route your request.
- Stay focused on your role as described in your system prompt. Do not attempt tasks that belong to other agents unless explicitly asked.

### Current Session
- Session title (topic): **"${sessionTitle}"**
- This title reflects the current goal. If it changes, you will be notified.\n`;
}
```

- [x] **Step 2: Add broadcast + inbox injection on rename**

In `apps/api/src/routes/sessions.ts`, import from `state.ts` (NOT handler.ts to avoid cycles):

```typescript
import { broadcast, sandboxes } from '../ws/state.js';
import { InboxManager } from '../agent/InboxManager.js';
import { buildGroupContext } from '../agent/groupContext.js';
```

In the PATCH handler, after `prisma.session.update()`:

```typescript
if (parsed.data.title && parsed.data.title !== session.title) {
  // 1. Broadcast WS event to all clients
  broadcast(sessionId, {
    type: 'session_renamed',
    sessionId,
    oldTitle: session.title,
    newTitle: parsed.data.title,
    timestamp: Date.now(),
  });

  // 2. Inject updated group context into all agents' CLAUDE.md via inbox
  const sb = sandboxes.get(sessionId);
  if (sb) {
    const sessionAgents = await prisma.sessionAgent.findMany({
      where: { sessionId },
      include: { agent: { select: { name: true } } },
    });
    const groupCtx = await buildGroupContext(sessionId, parsed.data.title);
    if (groupCtx) {
      for (const sa of sessionAgents) {
        InboxManager.write(sb.hostWorkDir, sa.agent.name, {
          type: 'context_update',
          id: `rename-${Date.now()}-${sa.agent.name}`,
          from: 'system',
          to: sa.agent.name,
          summary: `Session renamed to "${parsed.data.title}". Updated group context:

${groupCtx}`,
          risk: 'low',
          timestamp: Date.now(),
        });
      }
    }
  }
}
```

- [x] **Step 3: Inject group context on session creation too**

In `handleConnection` (handler.ts), after sandbox is ready and session agents are loaded, write initial group context to all agents:

```typescript
const groupCtx = await buildGroupContext(sessionId, session.title || 'New Session');
if (groupCtx) {
  const sb = sandboxes.get(sessionId);
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { name: true } } },
  });
  if (sb) {
    for (const sa of sessionAgents) {
      InboxManager.write(sb.hostWorkDir, sa.agent.name, {
        type: 'context_update',
        id: `init-${Date.now()}-${sa.agent.name}`,
        from: 'system',
        to: sa.agent.name,
        summary: groupCtx,
        risk: 'low',
        timestamp: Date.now(),
      });
    }
  }
}
```

- [x] **Step 4: Handle session_renamed in frontend**

In `useChat.ts`:

```typescript
case 'session_renamed':
  if (data.sessionId && data.newTitle) {
    useAppStore.getState().updateSessionTitle(data.sessionId, data.newTitle);
  }
  break;
```

In `appStore.ts`:

```typescript
updateSessionTitle: (sessionId: string, title: string) =>
  set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, title } : s
    ),
  })),
```

- [x] **Step 5: Add inline rename UI to SessionHeader**

Double-click title → inline input → Enter to save → triggers PATCH:

```tsx
const [editingTitle, setEditingTitle] = useState(false);
const [titleDraft, setTitleDraft] = useState('');

// Double-click to edit:
<h2 onDoubleClick={() => { setEditingTitle(true); setTitleDraft(session?.title || ''); }}>
  {editingTitle ? (
    <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
      onBlur={async () => { setEditingTitle(false);
        if (titleDraft && titleDraft !== session?.title) {
          await api.updateSession(session.id, { title: titleDraft });
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setEditingTitle(false); setTitleDraft(session?.title || ''); }
      }}
      className="bg-hub-input border border-hub-accent rounded px-2 py-1 text-hub-primary text-sm" />
  ) : (session?.title || 'Untitled')}
</h2>
```

- [x] **Step 6: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/api/src/agent/groupContext.ts apps/api/src/routes/sessions.ts apps/api/src/ws/handler.ts apps/web/src/components/SessionHeader.tsx apps/web/src/hooks/useChat.ts apps/web/src/store/appStore.ts
git commit -m "feat: session rename with group CLAUDE.md context injection for all agents"
```

---

### Task 6: Custom Agent from Markdown File

**Files:**
- Modify: `apps/api/src/routes/agents.ts`
- Create: `apps/web/src/components/AgentCreator.tsx`
- Modify: `apps/web/src/lib/api.ts`

User uploads a `.md` file. Frontmatter defines metadata (name, displayName, description, provider). The Markdown body becomes systemPrompt. `providerConfig` inherits defaults (model, tools from platform defaults) unless user explicitly imports settings. Codex provider requires API key — prompt user to configure in ProviderConfigPage first.

- [x] **Step 1: Add MD upload endpoint**

```typescript
// POST /agents/from-md
agents.post('/from-md', async (c) => {
  const { userId } = c.get('user');
  let body: { content: string; providerConfig?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  // Parse frontmatter
  const fmMatch = body.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return c.json({ error: 'No frontmatter found. Expected: ---\\nkey: value\\n---\\n...' }, 400);

  const frontmatterText = fmMatch[1];
  const systemPrompt = fmMatch[2].trim();

  // Parse YAML-like frontmatter
  const meta: Record<string, string> = {};
  for (const line of frontmatterText.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  const name = meta.name || `custom-${Date.now()}`;
  const provider = meta.provider || 'claude-code';

  if (!/^[a-z0-9-]+$/.test(name)) {
    return c.json({ error: 'name must be kebab-case' }, 400);
  }

  // Codex requires API key — check User.encryptedApiKeys
  if (provider === 'codex') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { encryptedApiKeys: true } });
    const keys = user?.encryptedApiKeys ? JSON.parse(user.encryptedApiKeys) : {};
    if (!keys.codex) {
      return c.json({ error: 'Codex provider requires an API key. Configure it in Provider Settings first.' }, 400);
    }
  }

  // providerConfig: user-provided or platform defaults
  const providerConfig = body.providerConfig || getDefaultProviderConfig(provider);

  const agent = await prisma.agent.create({
    data: {
      name,
      displayName: meta.displayName || name,
      description: meta.description || `Custom agent: ${name}`,
      systemPrompt,
      provider,
      providerConfig,
    },
  });
  return c.json(agent, 201);
});

function getDefaultProviderConfig(provider: string): Record<string, unknown> {
  if (provider === 'claude-code') return { model: 'claude-sonnet-4-6' };
  if (provider === 'codex') return { model: 'gpt-5' };
  return {};
}
```

- [x] **Step 2: Create AgentCreator wizard**

```tsx
// apps/web/src/components/AgentCreator.tsx
// MD file upload → parse frontmatter → preview → optional providerConfig import → create
// Key: role-only approach — the .md body IS the systemPrompt.
// providerConfig can be optionally overridden by the user via a JSON textarea.
```

- [x] **Step 3: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/api/src/routes/agents.ts apps/web/src/components/AgentCreator.tsx apps/web/src/lib/api.ts
git commit -m "feat: custom agent creation from .md file with inherited default settings"
```

---

### Task 7: Pull Solo Agent into Group Chat

**Files:**
- Modify: `apps/api/src/routes/sessions.ts`
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [x] **Step 1: Add POST /:id/agents endpoint**

```typescript
sessions.post('/:id/agents', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');
  // validate ownership, create SessionAgent, broadcast 'agent_joined'
});
```

- [x] **Step 2: Add "Add to Group" button on AgentCard**

Visible when agent is NOT in the current session. Sends POST to add agent, then refreshes.

- [x] **Step 3: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/api/src/routes/sessions.ts apps/web/src/components/AgentCard.tsx apps/web/src/lib/api.ts
git commit -m "feat: pull solo agent into group session"
```

---

### Task 8: Real Workspace Deployment (Docker Bind-Mount)

> **SDK-in-Docker update (2026-05-26):** All agent execution now runs inside the sandbox Docker container via `docker exec` + `sdk-runner.mjs` (see `apps/api/src/agent/SDKContainer.ts`). This provides true filesystem isolation — agents cannot escape the container's `/workspace` regardless of trust mode. Bind-mounting real workspaces is now simpler: just change the bind-mount target to the real workspace path. `permissionMode` in `defaultAgents.ts` has been tightened with `/workspace/**` scoped Bash rules and escape-path deny patterns.

**Files:**
- Modify: `apps/api/src/ws/state.ts`
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/routes/sessions.ts`
- Modify: `apps/web/src/components/SessionHeader.tsx`
- Modify: `apps/web/src/store/appStore.ts`

**Design:** Instead of replacing workDir, bind-mount the real path into the Docker container at `/workspace`. Agent stays in sandbox — only the filesystem target changes.

**Two modes:**
- `read_only_default`: Agent can read all workspace files, but every write/edit/delete requires user confirmation (permission dialog). Respects `providerConfig.allowedTools` + `forbiddenTools`.
- `full_access`: Agent can read/write freely. Still respects settings rules (`forbiddenTools`). Requires explicit user opt-in with risk warning.

**Safety:** `path.resolve()` + `fs.realpathSync()` to prevent path traversal. Allowlist check AFTER resolution.

- [x] **Step 1: Add workspace config and state**

In `apps/api/src/config.ts`:

```typescript
realWorkspaceRoots: optionalString('AGENTHUB_REAL_WORKSPACE_ROOTS', '/home'),
```

In `apps/api/src/ws/state.ts`:

```typescript
export const realWorkspacePaths = new Map<string, string>();
export const workspaceModes = new Map<string, WorkspaceMode>(); // 'read_only_default' | 'full_access'
```

In `cleanupSessionResources`, clean up both maps.

- [x] **Step 2: Add workspace setup endpoint with path traversal protection**

```typescript
import * as path from 'path';
import * as fs from 'fs';

// POST /:id/workspace
sessions.post('/:id/workspace', async (c) => {
  // ... auth checks ...

  let body: { path: string; mode: WorkspaceMode };
  // ... parse ...

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

  realWorkspacePaths.set(sessionId, real);
  workspaceModes.set(sessionId, body.mode || 'read_only_default');

  broadcast(sessionId, { type: 'workspace_changed', sessionId, path: real, mode: body.mode, timestamp: Date.now() });
  return c.json({ success: true, path: real, mode: body.mode });
});
```

- [x] **Step 3: Modify getOrCreateSandbox to bind-mount real path**

In `apps/api/src/ws/state.ts`, `getOrCreateSandbox`:

```typescript
export async function getOrCreateSandbox(sessionId: string) {
  // ... existing code ...
  const realPath = realWorkspacePaths.get(sessionId);
  const mode = workspaceModes.get(sessionId) || 'read_only_default';

  const binds: Record<string, string> = {};
  if (realPath) {
    // Bind-mount real workspace to /workspace in container
    binds[realPath] = '/workspace';
  }

  const container = await SandboxManager.createContainer(sessionId, binds);
  // hostWorkDir is realPath if set, otherwise the default sandbox hostWorkDir
  const hostWorkDir = realPath || container.hostWorkDir;
  // workDir inside container is always /workspace
  const workDir = '/workspace';

  sandboxes.set(sessionId, { containerId: container.id, workDir, hostWorkDir });
  return { containerId: container.id, workDir, hostWorkDir };
}
```

- [x] **Step 4: Wire permission mode to workspace mode**

In `handler.ts` `handleChatMessage`:

```typescript
const wsMode = workspaceModes.get(sessionId) || 'read_only_default';
const sessionPermMode = sessionPermissionModes.get(sessionId) || 'ask';

// read_only_default workspace → force permission checks for mutating tools
// full_access workspace → use session permission mode as-is
const effectiveTrustMode = wsMode === 'full_access'
  ? (sessionPermMode === 'smart' || sessionPermMode === 'trust')
  : false; // read_only_default: always require confirmation for writes
```

- [x] **Step 5: Add workspace mode toggle in SessionHeader**

```tsx
// Dropdown or toggle switch:
// 📁 Sandbox (default)
// 📁 Workspace (read-only default)
// 📁 Workspace (full access) — with risk warning modal

const workspaceMode = useAppStore((s) => s.workspaceModes[activeSessionId || '']);

{mode === 'full_access' && (
  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400"
    title="Agent can read and write real files freely">
    Full Access
  </span>
)}
```

- [x] **Step 6: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/api/src/config.ts apps/api/src/ws/state.ts apps/api/src/routes/sessions.ts apps/api/src/ws/handler.ts apps/web/src/components/SessionHeader.tsx apps/web/src/store/appStore.ts apps/web/src/lib/api.ts
git commit -m "feat: real workspace deployment via Docker bind-mount with read-only/full-access modes"
```

---

### Task 9: Session-Level Agent Config Editor

**Files:**
- Create: `apps/web/src/components/AgentConfigEditor.tsx`
- Modify: `apps/api/src/routes/sessions.ts`
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

Session-level override stored in `SessionAgent.systemPromptOverride`. When agent is invoked, use override if present, else fall back to agent's global `systemPrompt`. The editor also shows the global config as read-only reference.

- [x] **Step 1: Add session-level config endpoint**

```typescript
// PATCH /:id/agents/:agentId — update session-level agent config
sessions.patch('/:id/agents/:agentId', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');
  const agentId = c.req.param('agentId');

  // ... auth + ownership checks ...

  let body: { systemPromptOverride?: string };
  // ... parse ...

  const updated = await prisma.sessionAgent.update({
    where: { sessionId_agentId: { sessionId, agentId } },
    data: { systemPromptOverride: body.systemPromptOverride ?? null },
  });

  return c.json(updated);
});
```

- [x] **Step 2: Wire override into agent prompt construction**

In `handler.ts` `handleChatMessage`, when building the agent prompt:

```typescript
// Check for session-level system prompt override
const sessionAgent = await prisma.sessionAgent.findUnique({
  where: { sessionId_agentId: { sessionId, agentId: mention.agentId } },
  select: { systemPromptOverride: true },
});
const effectiveSystemPrompt = sessionAgent?.systemPromptOverride || agent.systemPrompt;
const agentPrompt = `${effectiveSystemPrompt}\n\n---\n\n${userRequest}`;
```

Same pattern in `taskDispatcher.ts` for task dispatch.

- [x] **Step 3: Create AgentConfigEditor with Monaco**

```tsx
// apps/web/src/components/AgentConfigEditor.tsx
// Modal with two tabs:
// 1. "Session Override" — editable Monaco editor for systemPromptOverride
//    - Empty = "use global config (shown below)"
//    - Clear button to reset to global
// 2. "Global Config (read-only)" — shows agent.systemPrompt (not editable here)
//
// Footer: warning "此修改仅影响当前会话中的该 agent，不影响其他会话。"
```

- [x] **Step 4: Add "Configure" button to AgentCard**

```tsx
// In expanded view, near the provider badge:
<button onClick={(e) => { e.stopPropagation(); onConfigure?.(agent); }}
  className="text-xs px-2 py-1 rounded bg-hub-surface border border-hub text-hub-secondary
             hover:text-hub-accent hover:border-hub-accent transition-colors">
  Configure
</button>
```

- [x] **Step 5: Wire in ChatView**

```tsx
const [configAgent, setConfigAgent] = useState<any>(null);
// ... render AgentConfigEditor modal when configAgent is set
```

- [x] **Step 6: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/api/src/routes/sessions.ts apps/api/src/ws/handler.ts apps/api/src/ws/taskDispatcher.ts apps/web/src/components/AgentConfigEditor.tsx apps/web/src/components/AgentCard.tsx apps/web/src/components/ChatView.tsx
git commit -m "feat: session-level agent config override with Monaco editor"
```

---

### Task 10: Encrypted API Key Storage + Masked Frontend Display

**Files:**
- Create: `apps/api/src/lib/crypto.ts`
- Modify: `apps/api/src/routes/agents.ts`
- Create: `apps/web/src/components/ProviderConfigPage.tsx`
- Modify: `apps/web/src/lib/api.ts`

API keys encrypted with AES-256-GCM before storing in DB. Frontend: input uses type="password", display shows only first 3 + last 4 chars (`sk-a***b1c2`), full key never returned to frontend.

- [x] **Step 1: Create encryption helpers**

```typescript
// apps/api/src/lib/crypto.ts
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.AGENTHUB_ENCRYPTION_KEY;
  if (!key) throw new Error('AGENTHUB_ENCRYPTION_KEY not set');
  // If key is hex-encoded, decode it
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, 'hex');
  // Otherwise, hash it to get 32 bytes
  return crypto.createHash('sha256').update(key).digest();
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptApiKey(encoded: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, cipherHex] = encoded.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskApiKey(key: string): string {
  if (key.length <= 7) return '***';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}
```

- [x] **Step 2: Add API key management endpoints**

```typescript
// In agents.ts:

// PUT /provider-configs — store encrypted API keys
agents.put('/provider-configs', async (c) => {
  const { userId } = c.get('user');
  let body: Record<string, { apiKey?: string; endpoint?: string }>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  // Encrypt apiKeys before storing
  const encrypted: Record<string, { apiKey?: string; endpoint?: string }> = {};
  for (const [provider, config] of Object.entries(body)) {
    encrypted[provider] = { endpoint: config.endpoint };
    if (config.apiKey) {
      encrypted[provider].apiKey = encryptApiKey(config.apiKey);
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: { encryptedApiKeys: JSON.stringify(encrypted) },
  });
  return c.json({ success: true });
});

// GET /provider-configs — return masked keys
agents.get('/provider-configs', async (c) => {
  const { userId } = c.get('user');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedApiKeys: true },
  });
  if (!user?.encryptedApiKeys) return c.json({});

  // Return masked keys — never expose full key to frontend
  const raw = JSON.parse(user.encryptedApiKeys);
  const masked: Record<string, { apiKey?: string; endpoint?: string }> = {};
  for (const [provider, config] of Object.entries(raw)) {
    masked[provider] = {
      endpoint: (config as any).endpoint,
      apiKey: (config as any).apiKey ? maskApiKey(decryptApiKey((config as any).apiKey)) : undefined,
    };
  }
  return c.json(masked);
});
```

- [x] **Step 3: Decrypt API key when invoking agent**

When a Codex agent is invoked, decrypt the API key and inject it into the provider config:

```typescript
// In handler.ts or taskDispatcher.ts, before agent.start():
if (agent.provider === 'codex') {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { encryptedApiKeys: true },
  });
  if (user?.encryptedApiKeys) {
    const keys = JSON.parse(user.encryptedApiKeys);
    if (keys.codex?.apiKey) {
      const decrypted = decryptApiKey(keys.codex.apiKey);
      providerConfig.apiKey = decrypted; // injected at runtime only, never persisted in plaintext
    }
  }
}
```

- [x] **Step 4: Create ProviderConfigPage frontend**

```tsx
// apps/web/src/components/ProviderConfigPage.tsx
// - Per-provider section: Codex
// - API key input: type="password", placeholder="sk-..."
// - After save: display masked key "sk-a***b1c2"
// - Edit button to re-enter
// - Endpoint URL field (not encrypted, plaintext)
// - Warning: "API key is encrypted at rest. You will need to re-enter it to make changes."
```

- [x] **Step 5: TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/api/src/lib/crypto.ts apps/api/src/routes/agents.ts apps/api/src/ws/handler.ts apps/web/src/components/ProviderConfigPage.tsx apps/web/src/lib/api.ts
git commit -m "feat: AES-256-GCM encrypted API key storage with masked frontend display"
```

---

### Task 11: End-to-End Verification

**Files:** None (manual + Playwright testing)

- [x] **Step 1: Start app** — `bash scripts/startup.sh`

- [x] **Step 2: Codex research** — Verify Codex SDK/CLI availability, document findings, create issue if blocked

- [x] **Step 3: Session rename + group context** — Rename a group session, verify all agents get inbox context update with new title and member list

- [x] **Step 4: Custom agent from .md** — Upload .md file, verify agent creation with inherited defaults, verify Codex agent requires API key

- [x] **Step 5: Solo→group pull** — Pull a solo agent into group session, verify agent appears and can be @mentioned

- [x] **Step 6: Real workspace** — Set workspace to `/tmp/test-workspace`, verify bind-mount, test read-only-default mode (reads work, writes blocked), test full-access mode

- [x] **Step 7: Agent config editor** — Open session-level config editor, add override, verify override is used in next invocation; verify other sessions use global config

- [x] **Step 8: API key encryption** — Save a Codex API key, verify DB stores encrypted blob, verify frontend shows masked key on reload, verify key is decrypted correctly at agent invocation

- [x] **Step 9: Final TypeScript check and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
git add -A && git commit -m "feat: multi-provider agents + session management + workspace deployment"
```

---

## 执行计划 (2026-05-28 更新)

### 当前状态 (2026-05-28 最终更新)

| Task | 状态 | 完成度 |
|------|------|--------|
| Task 1: Agent DB Extension | ✅ 已完成 | 100% |
| Task 2: Codex SDK Provider | ✅ 已完成 | 100% |
| Task 3: Agent Creation UI | ✅ 已完成 | 100% |
| Task 4: Agent Card Badge | ✅ 已完成 | 100% |
| Task 5: Session Rename | ✅ 已完成 | 100% |
| Task 6: Agent from MD | ✅ 已完成 | 100% |
| Task 7: Solo→Group Pull | ✅ 已完成 | 100% |
| Task 8: Real Workspace | ✅ 已完成 | 100% |
| Task 9: Agent Config Editor | ✅ 已完成 | 100% |
| Task 10: API Key Encryption | ✅ 已完成 | 100% |
| Task 11: E2E Verification | ✅ 已完成 | 100% |

### 建议执行顺序

**Phase 1: 基础设施层 (Task 1 + Task 10)**
- Task 1 是所有其他任务的基础（Schema 扩展）
- Task 10 的 crypto.ts 是 Task 2 Codex Provider 的依赖
- 预计工作量：2-3 小时

**Phase 2: Provider 集成 (Task 2 + Task 3)**
- Task 2 实现 Codex Provider
- Task 3 扩展 Agent CRUD API 支持 provider 字段
- 预计工作量：3-4 小时

**Phase 3: 前端 UI (Task 4 + Task 5 剩余 + Task 6)**
- Task 4 AgentCard Provider badge
- Task 5 完成 WS broadcast + groupContext 注入
- Task 6 Agent Creator 从 .md 文件创建
- 预计工作量：4-5 小时

**Phase 4: 高级功能 (Task 7 + Task 8 + Task 9)**
- Task 7 Solo→Group Pull
- Task 8 Real Workspace Deployment
- Task 9 Session-Level Agent Config Editor
- 预计工作量：5-6 小时

**Phase 5: 验收测试 (Task 11)**
- E2E 验证所有功能
- 预计工作量：2-3 小时

### 依赖关系

```
Task 1 (Schema) ──┬──> Task 2 (Codex Provider) ──> Task 3 (Agent API) ──> Task 4 (AgentCard UI)
                  │
                  ├──> Task 5 (Session Rename 完善)
                  │
                  ├──> Task 6 (Agent from MD)
                  │
                  ├──> Task 7 (Solo→Group Pull)
                  │
                  ├──> Task 8 (Real Workspace)
                  │
                  └──> Task 9 (Agent Config Editor)

Task 10 (Crypto) ──> Task 2 (Codex Provider 需要 API key 解密)

所有 Task ──> Task 11 (E2E Verification)
```

### 快速启动建议

如果想快速看到效果，建议先完成：
1. **Task 1** (Schema 扩展) - 基础
2. **Task 4** (AgentCard badge) - 视觉效果
3. **Task 5 剩余部分** (WS broadcast) - 功能完善

这三个任务可以在 3-4 小时内完成，让系统具备基本的 Provider 感知能力。
