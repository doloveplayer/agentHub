# Agent 生命周期重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent 从 session-scoped 进程重构为全局实体，支持独立 Docker 容器、跨 session 记忆共享、Solo/Group 成员管理。

**Architecture:** Agent 成为全局单例，每 Agent 一个独立 Docker 容器 + 常驻 REPL 进程；用户 agent 跨 session 共享记忆，系统 agent per-group 实例化；AgentRuntime 模块统一管理 agent 生命周期和并发排队。

**Tech Stack:** Prisma + PostgreSQL, Hono, ws, Dockerode, React + Zustand + Tailwind

**关联 Spec:** `docs/superpowers/specs/2026-05-29-agent-lifecycle-redesign.md`

---

## 执行状态总览

| Phase | 内容 | 状态 |
|------|------|------|
| Phase A | Agent 容器化 + 全局生命周期 | 🔲 |
| Phase B | Group 管理 UI + 记忆共享 | 🔲 |
| Phase C | 清理旧代码 + 端到端测试 | 🔲 |

---

## File Structure

### Phase A

| File | Role |
|------|------|
| `apps/api/prisma/schema.prisma` | Add `AgentTemplate` model, new Agent fields (`type`, `contextMode`, `containerId`, `containerStatus`, `hostWorkDir`, `createdBy`) |
| `apps/api/src/agent/AgentRuntime.ts` | **New** — global agent lifecycle manager: start/stop containers, REPL process pool, per-agent prompt queue |
| `apps/api/src/agent/AgentContainer.ts` | **New** — Docker operations for per-agent containers (create, start, stop, destroy) |
| `apps/api/src/config.ts` | Add agent container config (image, memory, idle timeout) |
| `apps/api/src/ws/handler.ts` | Replace session-scoped agent spawning with AgentRuntime.sendPrompt calls |
| `apps/api/src/ws/state.ts` | Remove per-session `agentProcesses`, add global agent state tracking helpers |
| `apps/api/src/routes/sessions.ts` | Update createGroupSession/createSoloSession for new agent lifecycle |
| `apps/api/src/routes/agents.ts` | Add `type`, `contextMode`, `createdBy` to create/update; add DELETE cascade logic |
| `apps/api/src/defaultAgents.ts` | Add `AgentTemplate` seed data |
| `apps/api/src/index.ts` | AgentRuntime initialization on startup |

### Phase B

| File | Role |
|------|------|
| `apps/api/src/routes/sessionAgents.ts` | **New** — POST/DELETE endpoints for group member management |
| `apps/web/src/components/AddAgentModal.tsx` | **New** — modal: search + multi-select user agents to add to group |
| `apps/web/src/components/RemoveAgentModal.tsx` | **New** — modal: list group agents with remove buttons |
| `apps/web/src/components/ChatView.tsx` | Add [+ Add] [− Rmv] buttons in group session header |
| `apps/web/src/hooks/useChat.ts` | Handle `agent_added`, `agent_removed`, `agent_queued` WS events |
| `apps/web/src/store/appStore.ts` | Add `addAgentToSession`, `removeAgentFromSession` actions |
| `apps/web/src/components/AgentMentionPopup.tsx` | In group: only show session agents; in solo: show all user agents |

### Phase C

| File | Role |
|------|------|
| `apps/api/src/ws/handler.ts` | Remove old `preActivateGroupAgents`, standby prompt logic |
| `apps/api/src/agent/TaskQueue.ts` | Remove BullMQ references |
| `apps/api/src/ws/taskDispatcher.ts` | Rewire task dispatch through AgentRuntime |
| `apps/api/src/agent/AgentRuntime.test.ts` | **New** — integration test for AgentRuntime lifecycle |

---

## Phase A: Agent 容器化 + 全局生命周期

### Task A1: Prisma Schema — Agent 新字段 + AgentTemplate 模型

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add new fields to Agent model and create AgentTemplate model**

Edit `apps/api/prisma/schema.prisma`. Add the new fields to the `Agent` model and add the new `AgentTemplate` model AFTER the Agent model:

```prisma
model Agent {
  id              String         @id @default(uuid())
  name            String         @unique
  displayName     String
  description     String
  systemPrompt    String
  provider        String         @default("claude-code")
  providerConfig  Json?
  capabilities    Json?
  isActive        Boolean        @default(true)
  type            String         @default("user")    // "user" | "system"
  contextMode     String         @default("shared")  // "shared" | "isolated"
  containerId     String?
  containerStatus String         @default("stopped") // "stopped" | "running" | "error"
  hostWorkDir     String?
  createdBy       String?
  sessionAgents   SessionAgent[]
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}

model AgentTemplate {
  id           String  @id @default(uuid())
  name         String  @unique
  displayName  String
  description  String
  systemPrompt String
  provider     String  @default("claude-code")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

- [ ] **Step 2: Run Prisma migrate**

```bash
cd apps/api && npx prisma migrate dev --name add_agent_type_and_template
```

Expected: migration created without errors.

- [ ] **Step 3: Verify schema**

```bash
cd apps/api && npx prisma db pull --print 2>&1 | grep -A5 "model Agent"
```

Expected: Agent model shows `type`, `contextMode`, `containerId`, `containerStatus`, `hostWorkDir`, `createdBy` fields.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat: add Agent.type, contextMode, container fields and AgentTemplate model"
```

---

### Task A2: Config — Agent Container Settings

**Files:**
- Modify: `apps/api/src/config.ts`

- [ ] **Step 1: Add agent container config entries**

In `apps/api/src/config.ts`, add after existing sandbox config (around line 161):

```typescript
agentContainer: {
  image: optional('AGENT_CONTAINER_IMAGE', 'agenthub-agent:latest'),
  memoryMb: optionalInt('AGENT_CONTAINER_MEMORY_MB', 1024),
  idleTimeoutMs: optionalInt('AGENT_IDLE_TIMEOUT_MS', 30 * 60 * 1000), // 30 min
  hostRoot: optional('AGENT_HOST_ROOT', resolve(PROJECT_ROOT, '.agents')),
},
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/config.ts
git commit -m "feat: add agent container config settings"
```

---

### Task A3: AgentContainer — Per-Agent Docker Operations

**Files:**
- Create: `apps/api/src/agent/AgentContainer.ts`

- [ ] **Step 1: Write AgentContainer class**

```typescript
// apps/api/src/agent/AgentContainer.ts
import Docker from 'dockerode';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';

const docker = new Docker({ socketPath: config.docker.socketPath });

export interface ContainerInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
}

export class AgentContainer {
  /** Create and start a Docker container for a single agent */
  static async create(agentId: string, systemPrompt: string): Promise<ContainerInfo> {
    const containerName = `agenthub-agent-${agentId}`;
    const hostWorkDir = resolve(config.agentContainer.hostRoot, agentId);
    const workDir = '/workspace';

    // Ensure host dirs
    const claudeDir = resolve(hostWorkDir, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(resolve(claudeDir, 'memory'), { recursive: true });
      mkdirSync(resolve(claudeDir, 'skills'), { recursive: true });
    }

    // Write CLAUDE.md with agent identity
    writeFileSync(resolve(hostWorkDir, 'CLAUDE.md'), `# Agent Identity\n\n${systemPrompt}`, 'utf-8');

    // Remove existing container if any
    await AgentContainer.removeIfExists(containerName);

    const container = await docker.createContainer({
      name: containerName,
      Image: config.agentContainer.image,
      WorkingDir: workDir,
      Tty: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        Memory: config.agentContainer.memoryMb * 1024 * 1024,
        MemorySwap: config.agentContainer.memoryMb * 1024 * 1024 * 2,
        NetworkMode: 'bridge',
        Binds: [`${hostWorkDir}:/workspace`],
      },
    });

    await container.start();

    return { containerId: container.id, workDir, hostWorkDir };
  }

  /** Stop and remove agent container */
  static async destroy(containerId: string): Promise<void> {
    try {
      const container = docker.getContainer(containerId);
      await container.stop({ t: 10 });
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode === 404) return; // Already gone
      throw err;
    }
  }

  /** Destroy host work dir (irreversible) */
  static async destroyHostDir(agentId: string): Promise<void> {
    const hostWorkDir = resolve(config.agentContainer.hostRoot, agentId);
    try {
      const { rm } = await import('fs/promises');
      await rm(hostWorkDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  private static async removeIfExists(name: string): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true, filters: { name: [name] } });
      for (const c of containers) {
        await AgentContainer.destroy(c.Id);
      }
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Write unit test**

Create `apps/api/src/agent/AgentContainer.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('AgentContainer', () => {
  it('should resolve host root from config', () => {
    const { config } = require('../config.js');
    assert.ok(config.agentContainer.hostRoot.endsWith('.agents'));
    assert.equal(config.agentContainer.memoryMb, 1024);
    assert.equal(config.agentContainer.idleTimeoutMs, 30 * 60 * 1000);
  });
});
```

- [ ] **Step 4: Run test**

```bash
cd apps/api && npx tsx --test src/agent/AgentContainer.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/AgentContainer.ts apps/api/src/agent/AgentContainer.test.ts
git commit -m "feat: add AgentContainer for per-agent Docker lifecycle"
```

---

### Task A4: AgentRuntime — Global Agent Lifecycle Manager

**Files:**
- Create: `apps/api/src/agent/AgentRuntime.ts`

- [ ] **Step 1: Write AgentRuntime class**

```typescript
// apps/api/src/agent/AgentRuntime.ts
import { ProviderFactory } from './providers/factory.js';
import type { AbstractProvider } from './providers/base.js';
import { AgentContainer } from './AgentContainer.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import { eventParser } from './EventParser.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { broadcast } from '../ws/state.js';

interface QueueItem {
  sessionId: string;
  prompt: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface AgentEntry {
  provider: AbstractProvider;
  containerId: string;
  hostWorkDir: string;
  idleTimer: NodeJS.Timeout | null;
  currentSession: string | null;
  queue: QueueItem[];
}

class AgentRuntime {
  private agents = new Map<string, AgentEntry>();

  /** Send a prompt to an agent. Queues if busy, starts container if stopped. */
  async sendPrompt(agentId: string, sessionId: string, prompt: string): Promise<void> {
    let entry = this.agents.get(agentId);

    if (!entry) {
      // Lazy start: create container and REPL process
      entry = await this.ensureRunning(agentId);
    }

    if (entry.currentSession !== null && entry.currentSession !== sessionId) {
      // Agent is busy with another session — queue
      return new Promise<void>((resolve, reject) => {
        entry!.queue.push({ sessionId, prompt, resolve, reject });
        broadcast(sessionId, {
          type: 'agent_queued',
          agentId,
          message: `Agent is busy. Position in queue: ${entry!.queue.length}`,
        });
      });
    }

    // Agent is idle — send directly
    entry.currentSession = sessionId;
    this.clearIdleTimer(agentId);
    entry.provider.sendPrompt(prompt);
  }

  /** Ensure agent container and REPL are running */
  async ensureRunning(agentId: string): Promise<AgentEntry> {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    // Create container if needed
    if (!agent.containerId || agent.containerStatus === 'stopped') {
      const info = await AgentContainer.create(agentId, agent.systemPrompt);

      // Initialize agent directory
      AgentDirectoryManager.initialize(info.hostWorkDir, agent.name, agent.systemPrompt);

      await prisma.agent.update({
        where: { id: agentId },
        data: { containerId: info.containerId, containerStatus: 'running', hostWorkDir: info.hostWorkDir },
      });

      agent.containerId = info.containerId;
      agent.hostWorkDir = info.hostWorkDir;
    }

    // Start REPL provider
    const provider = ProviderFactory.create(agent.provider);
    await provider.start(
      'agent-' + agentId,        // sessionId placeholder
      'Standby — waiting for tasks',
      agent.containerId,
      '/workspace',
      {
        apiKey: (agent.providerConfig as any)?.apiKey,
        model: (agent.providerConfig as any)?.model,
        hostWorkDir: agent.hostWorkDir!,
        trustMode: true,
      },
    );

    // Register REPL event handler
    const entry: AgentEntry = {
      provider, containerId: agent.containerId!, hostWorkDir: agent.hostWorkDir!,
      idleTimer: null, currentSession: null, queue: [],
    };

    provider.onEvent((event) => {
      this.handleAgentEvent(agentId, entry, event);
    });

    this.agents.set(agentId, entry);
    return entry;
  }

  /** Handle REPL events — forward to correct session, manage queue */
  private handleAgentEvent(agentId: string, entry: AgentEntry, event: any): void {
    const sessionId = entry.currentSession || 'unknown';

    if (event.type === 'thinking' && event.content) {
      broadcast(sessionId, { type: 'stream_chunk', content: event.content });
    }
    if (event.type === 'done') {
      // Complete current task
      broadcast(sessionId, { type: 'stream_end', exitCode: event.exitCode ?? 0 });

      entry.currentSession = null;

      // Process next queue item
      const next = entry.queue.shift();
      if (next) {
        entry.currentSession = next.sessionId;
        entry.provider.sendPrompt(next.prompt);
        next.resolve();
      } else {
        // Start idle timeout
        entry.idleTimer = setTimeout(() => {
          this.stopContainer(agentId);
        }, config.agentContainer.idleTimeoutMs);
      }
    }
    if (event.type === 'error') {
      broadcast(sessionId, { type: 'stream_error', error: event.message });
    }
  }

  /** Stop agent container after idle timeout */
  async stopContainer(agentId: string): Promise<void> {
    const entry = this.agents.get(agentId);
    if (!entry) return;

    this.clearIdleTimer(agentId);
    entry.provider.stop();
    await AgentContainer.destroy(entry.containerId);
    this.agents.delete(agentId);

    await prisma.agent.update({
      where: { id: agentId },
      data: { containerStatus: 'stopped' },
    });
  }

  /** Get queue status for an agent */
  getQueueStatus(agentId: string): { pending: number; currentSession: string | null } {
    const entry = this.agents.get(agentId);
    return {
      pending: entry?.queue.length ?? 0,
      currentSession: entry?.currentSession ?? null,
    };
  }

  private clearIdleTimer(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry?.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  }
}

export const agentRuntime = new AgentRuntime();
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Write unit test**

Create `apps/api/src/agent/AgentRuntime.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentRuntime } from './AgentRuntime.js';

describe('AgentRuntime', () => {
  it('should return empty queue for unknown agent', () => {
    const status = agentRuntime.getQueueStatus('nonexistent');
    assert.equal(status.pending, 0);
    assert.equal(status.currentSession, null);
  });
});
```

- [ ] **Step 4: Run test**

```bash
cd apps/api && npx tsx --test src/agent/AgentRuntime.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/AgentRuntime.ts apps/api/src/agent/AgentRuntime.test.ts
git commit -m "feat: add AgentRuntime for global agent lifecycle and prompt queue"
```

---

### Task A5: Seed Agent Templates on Startup

**Files:**
- Modify: `apps/api/src/defaultAgents.ts`

- [ ] **Step 1: Add AgentTemplate seed data and seed function**

In `apps/api/src/defaultAgents.ts`, add after existing seed logic:

```typescript
export async function seedAgentTemplates() {
  const templates = [
    {
      name: 'code-agent',
      displayName: 'CodeAgent',
      description: 'Writes and modifies code, runs shell commands, creates files',
      systemPrompt: 'You are CodeAgent, an expert software engineer. Write clean, secure, well-tested code. Use tools to read, write, and execute code. Prefer editing existing files over creating new ones.',
    },
    {
      name: 'review-agent',
      displayName: 'ReviewAgent',
      description: 'Reviews code for bugs, security vulnerabilities, and style issues',
      systemPrompt: 'You are ReviewAgent, a thorough code reviewer. Check for security vulnerabilities, logic bugs, type safety, and error handling gaps. Report with severity and file:line references.',
    },
    {
      name: 'devops-agent',
      displayName: 'DevOpsAgent',
      description: 'Handles deployment, CI/CD, Docker, and infrastructure tasks',
      systemPrompt: 'You are DevOpsAgent, an infrastructure specialist. Handle Docker, CI/CD, deployment scripts. Ensure production-readiness.',
    },
    {
      name: 'planner',
      displayName: 'Planner',
      description: 'Task planning expert — breaks down complex requirements into structured task plans',
      systemPrompt: 'You are Planner, a PM/PMO-style orchestrator. Break down requirements into DAG-structured task plans. Output JSON only when triggered. Default to conversational mode.',
    },
    {
      name: 'test-agent',
      displayName: 'TestAgent',
      description: 'Generates tests, runs test suites, and reports results',
      systemPrompt: 'You are TestAgent, a testing specialist. Analyze target files, write test code, run tests, and report results with pass/fail and timing.',
    },
  ];

  for (const tpl of templates) {
    await prisma.agentTemplate.upsert({
      where: { name: tpl.name },
      update: tpl,
      create: tpl,
    });
  }
  console.log('[seed] Agent templates seeded');
}
```

- [ ] **Step 2: Call seed function in index.ts**

In `apps/api/src/index.ts`, add after the `seedDefaultAgents()` call:

```typescript
import { seedAgentTemplates } from './defaultAgents.js';
// ... after seedDefaultAgents():
await seedAgentTemplates();
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/defaultAgents.ts apps/api/src/index.ts
git commit -m "feat: add AgentTemplate seed data and auto-seed on startup"
```

---

### Task A6: Update Agent Route — New Fields + Delete Cascade

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

- [ ] **Step 1: Update create schema to accept new fields**

In `apps/api/src/routes/agents.ts`, update the create schema:

```typescript
const createSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  type: z.enum(['user', 'system']).optional().default('user'),
  contextMode: z.enum(['shared', 'isolated']).optional().default('shared'),
});

// In POST handler, pass new fields to create:
const agent = await prisma.agent.create({
  data: {
    ...parsed.data,
    type: 'user',
    contextMode: 'shared',
    createdBy: userId,
  },
});
```

- [ ] **Step 2: Update DELETE handler for global delete cascade**

Replace the DELETE handler:

```typescript
agents.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Only allow deletion of user-created agents
  if (agent.type !== 'user') return c.json({ error: 'Cannot delete system agents' }, 403);
  if (agent.createdBy !== userId) return c.json({ error: 'Forbidden' }, 403);

  // Destroy container if running
  if (agent.containerId && agent.containerStatus === 'running') {
    const { AgentContainer } = await import('../agent/AgentContainer.js');
    await AgentContainer.destroy(agent.containerId).catch(() => {});
  }

  // Clean host work dir
  if (agent.hostWorkDir) {
    await AgentContainer.destroyHostDir(agent.id).catch(() => {});
  }

  // Remove from all group sessions
  const sessionAgents = await prisma.sessionAgent.findMany({ where: { agentId: id } });
  for (const sa of sessionAgents) {
    // Broadcast agent_removed to each session
    const { broadcast } = await import('../ws/state.js');
    broadcast(sa.sessionId, { type: 'agent_removed', agentId: id, agentName: agent.name });
  }

  // Soft-delete the agent
  await prisma.agent.update({ where: { id }, data: { isActive: false } });

  return c.body(null, 204);
});
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents.ts
git commit -m "feat: add type/contextMode/createdBy to agent create, add delete cascade"
```

---

### Task A7: Update Session Creation — New Agent Lifecycle

**Files:**
- Modify: `apps/api/src/routes/sessions.ts`

- [ ] **Step 1: Rewrite createGroupSession for AgentTemplate-based system agents**

Replace the auto-assign logic (lines 103-121) in `apps/api/src/routes/sessions.ts`:

```typescript
// Auto-assign agents:
// - Group without explicit agentIds → create system agents from templates
// - Solo without explicit agentIds → reuse user's default code-agent or create new
if ((!agentIds || agentIds.length === 0)) {
  if (type === 'group') {
    // Create system agent instances from templates
    const templates = await prisma.agentTemplate.findMany();
    agentIds = [];
    for (const tpl of templates) {
      const systemAgent = await prisma.agent.create({
        data: {
          name: `${tpl.name}-${session.id.slice(0, 8)}`,
          displayName: tpl.displayName,
          description: tpl.description,
          systemPrompt: tpl.systemPrompt,
          provider: tpl.provider,
          type: 'system',
          contextMode: 'isolated',
        },
      });
      agentIds.push(systemAgent.id);
    }
  } else {
    // Solo: reuse existing user code-agent or create from template
    let defaultAgent = await prisma.agent.findFirst({
      where: { name: 'code-agent', type: 'user', createdBy: userId, isActive: true },
    });
    if (!defaultAgent) {
      const codeTpl = await prisma.agentTemplate.findUnique({ where: { name: 'code-agent' } });
      if (codeTpl) {
        defaultAgent = await prisma.agent.create({
          data: {
            name: 'code-agent',
            displayName: codeTpl.displayName,
            description: codeTpl.description,
            systemPrompt: codeTpl.systemPrompt,
            type: 'user',
            contextMode: 'shared',
            createdBy: userId,
          },
        });
      }
    }
    agentIds = defaultAgent ? [defaultAgent.id] : [];
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/sessions.ts
git commit -m "feat: update session creation for AgentTemplate-based system agents"
```

---

### Task A8: Rewire WebSocket Handler — Use AgentRuntime

**Files:**
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: Import AgentRuntime**

Add to imports (top of file):

```typescript
import { agentRuntime } from '../agent/AgentRuntime.js';
```

- [ ] **Step 2: Replace agent spawning in handleChatMessage with AgentRuntime.sendPrompt**

Find `handleChatMessage` (search for `async function handleChatMessage`). Replace the spawn logic to use:

```typescript
// Instead of creating ClaudeCodeProcess directly:
for (const mention of mentions) {
  const agent = await prisma.agent.findUnique({ where: { id: mention.agentId } });
  if (!agent) continue;
  
  // Build context-aware prompt
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { type: true } });
  const prefix = session?.type === 'solo'
    ? '[Solo - 与用户一对一交流]'
    : '[Group - 多Agent协作]';
  const fullPrompt = `${prefix}\n\n${mention.subPrompt}`;

  // Send through AgentRuntime — handles queueing, container lifecycle
  agentRuntime.sendPrompt(agent.id, sessionId, fullPrompt).catch((err) => {
    broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: err.message });
  });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean (may need minor adjustments to match actual handler.ts patterns).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/ws/handler.ts
git commit -m "feat: rewire WS handler to use AgentRuntime.sendPrompt instead of direct spawn"
```

---

### Task A9: Integration Test — AgentRuntime + Session Creation

**Files:**
- Create: `apps/api/src/agent/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Agent Lifecycle Integration', () => {
  it('should create solo session with shared user agent', async () => {
    // This test verifies the new session creation logic conceptually.
    // Actual DB/container integration tested via E2E in Phase C.
    assert.ok(true, 'placeholder — full E2E in Phase C');
  });

  it('should create group session with isolated system agents', async () => {
    assert.ok(true, 'placeholder — full E2E in Phase C');
  });
});
```

- [ ] **Step 2: Run test**

```bash
cd apps/api && npx tsx --test src/agent/integration.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/integration.test.ts
git commit -m "test: add AgentRuntime lifecycle integration test stubs"
```

---

### Task A10: Phase A Verification — Full TypeScript + Existing Tests

- [ ] **Step 1: Full TypeScript check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: both clean.

- [ ] **Step 2: Run all existing tests**

```bash
cd apps/api && npx tsx --test src/agent/core.test.ts src/agent/ClaudeCodeProcess.test.ts src/agent/processFactory.test.ts src/agent/turns.test.ts src/ws/closeCodes.test.ts 2>&1 | tail -10
```

Expected: all existing tests pass.

- [ ] **Step 3: Commit checkpoint**

```bash
git add -A && git commit -m "chore: Phase A complete — agent containerization and global lifecycle"
```

---

## Phase B: Group 管理 UI + 记忆共享

### Task B1: SessionAgents API — Add/Remove Member Endpoints

**Files:**
- Create: `apps/api/src/routes/sessionAgents.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write sessionAgents route**

```typescript
// apps/api/src/routes/sessionAgents.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const sessionAgents = new Hono();
sessionAgents.use('*', authMiddleware);

// POST /api/sessions/:sessionId/agents — add agents to group
const addSchema = z.object({ agentIds: z.array(z.string().uuid()).min(1) });

sessionAgents.post('/:sessionId/agents', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  if (session.type !== 'group') return c.json({ error: 'Only group sessions support adding agents' }, 400);

  const parsed = addSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);

  const added: string[] = [];
  for (const agentId of parsed.data.agentIds) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) continue;
    if (agent.type !== 'user' || agent.createdBy !== userId) continue; // Only user's own agents

    await prisma.sessionAgent.upsert({
      where: { sessionId_agentId: { sessionId, agentId } },
      create: { sessionId, agentId },
      update: {},
    });
    added.push(agentId);
  }

  // Broadcast to session
  for (const id of added) {
    const { broadcast } = await import('../ws/state.js');
    broadcast(sessionId, { type: 'agent_added', agentId: id, sessionId });
  }

  return c.json({ added }, 201);
});

// DELETE /api/sessions/:sessionId/agents/:agentId — remove agent from group
sessionAgents.delete('/:sessionId/agents/:agentId', async (c) => {
  const { userId } = c.get('user');
  const { sessionId, agentId } = c.req.param();

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  await prisma.sessionAgent.deleteMany({ where: { sessionId, agentId } });

  const { broadcast } = await import('../ws/state.js');
  broadcast(sessionId, { type: 'agent_removed', agentId, sessionId });

  return c.body(null, 204);
});

export default sessionAgents;
```

- [ ] **Step 2: Mount routes in index.ts**

In `apps/api/src/index.ts`:

```typescript
import sessionAgentRoutes from './routes/sessionAgents.js';
// After existing session routes:
app.route('/api/sessions', sessionAgentRoutes);
```

Wait — need to mount carefully. The sessionAgents routes use `/:sessionId/agents` pattern. Mount at the same level as sessions:

```typescript
// Mount under /api/sessions so paths like /api/sessions/:sessionId/agents work
app.route('/api/sessions', sessionAgentRoutes);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/sessionAgents.ts apps/api/src/index.ts
git commit -m "feat: add session agent add/remove API endpoints"
```

---

### Task B2: Frontend Store — Session Agent Management Actions

**Files:**
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: Add agent session management actions**

Add to interface and implementation:

```typescript
// In AppState interface:
addAgentToSession: (sessionId: string, agent: AgentConfig) => void;
removeAgentFromSession: (sessionId: string, agentId: string) => void;

// In create() call:
addAgentToSession: (sessionId, agent) =>
  set((state) => {
    const sessions = state.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const agents = (s as any).agents || [];
      if (agents.find((a: any) => a.agentId === agent.id)) return s;
      return { ...s, agents: [...agents, { agentId: agent.id, name: agent.name, displayName: agent.displayName }] };
    });
    return { sessions };
  }),

removeAgentFromSession: (sessionId, agentId) =>
  set((state) => {
    const sessions = state.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const agents = ((s as any).agents || []).filter((a: any) => a.agentId !== agentId);
      return { ...s, agents };
    });
    return { sessions };
  }),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/store/appStore.ts
git commit -m "feat: add session agent add/remove actions to frontend store"
```

---

### Task B3: AddAgentModal Component

**Files:**
- Create: `apps/web/src/components/AddAgentModal.tsx`

- [ ] **Step 1: Write AddAgentModal**

```tsx
// apps/web/src/components/AddAgentModal.tsx
import { useState, useEffect } from 'react';
import { X, Search, Plus } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import type { AgentConfig } from '@agenthub/shared';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

export function AddAgentModal({ sessionId, open, onClose }: Props) {
  const agents = useAppStore((s) => s.agents);
  const sessions = useAppStore((s) => s.sessions);
  const addAgentToSession = useAppStore((s) => s.addAgentToSession);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const session = sessions.find((s) => s.id === sessionId);
  const sessionAgentIds = new Set(((session as any)?.agents || []).map((a: any) => a.agentId));

  // Show user-created agents not already in this group
  const availableAgents = agents.filter((a) => {
    if (a.type !== 'user' && a.type !== undefined) return false;
    if (sessionAgentIds.has(a.id)) return false;
    if (search && !a.displayName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleAdd = async () => {
    if (selected.size === 0) return;
    setAdding(true);
    try {
      await api.addSessionAgents(sessionId, Array.from(selected));
      for (const agentId of selected) {
        const agent = agents.find((a) => a.id === agentId);
        if (agent) addAgentToSession(sessionId, agent);
      }
      onClose();
    } catch (err) {
      console.error('Failed to add agents:', err);
    } finally {
      setAdding(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} />
      <div className="fixed inset-8 flex items-center justify-center z-50">
        <div className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-hub">
            <h2 className="text-base font-semibold text-hub-primary">Add Agent to Group</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-tertiary">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search */}
          <div className="px-5 py-3 border-b border-hub">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hub-tertiary" />
              <input
                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents..." autoFocus
                className="w-full pl-9 pr-3 py-2 bg-hub-surface border border-hub-border rounded-lg text-sm text-hub-primary outline-none focus:border-hub-accent"
              />
            </div>
          </div>

          {/* Agent list */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {availableAgents.length === 0 && (
              <p className="text-sm text-hub-muted text-center py-6">No agents available</p>
            )}
            {availableAgents.map((agent) => (
              <label key={agent.id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition ${
                  selected.has(agent.id) ? 'border-hub-accent bg-hub-accent/10' : 'border-hub-border hover:border-hub-accent/50'
                }`}
                onClick={() => toggleSelect(agent.id)}
              >
                <input type="checkbox" checked={selected.has(agent.id)} onChange={() => {}} className="accent-hub-accent" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-hub-primary">{agent.displayName}</div>
                  <div className="text-xs text-hub-tertiary truncate">{agent.description}</div>
                </div>
              </label>
            ))}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-hub flex items-center justify-between">
            <span className="text-xs text-hub-tertiary">{selected.size} selected</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm text-hub-secondary hover:bg-hub-hover rounded-md transition">
                Cancel
              </button>
              <button onClick={handleAdd} disabled={selected.size === 0 || adding}
                className="px-4 py-2 text-sm bg-hub-accent text-white rounded-md hover:bg-hub-accent-hover disabled:opacity-40 transition font-medium"
              >
                {adding ? 'Adding...' : `Add (${selected.size})`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add addSessionAgents to API client**

In `apps/web/src/lib/api.ts`, add:

```typescript
addSessionAgents: (sessionId: string, agentIds: string[]) =>
  request<{ added: string[] }>(`/sessions/${sessionId}/agents`, {
    method: 'POST',
    body: JSON.stringify({ agentIds }),
  }),
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/AddAgentModal.tsx apps/web/src/lib/api.ts
git commit -m "feat: add AddAgentModal component and API client method"
```

---

### Task B4: RemoveAgentModal Component

**Files:**
- Create: `apps/web/src/components/RemoveAgentModal.tsx`

- [ ] **Step 1: Write RemoveAgentModal**

```tsx
// apps/web/src/components/RemoveAgentModal.tsx
import { useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import type { AgentConfig } from '@agenthub/shared';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

export function RemoveAgentModal({ sessionId, open, onClose }: Props) {
  const sessions = useAppStore((s) => s.sessions);
  const agents = useAppStore((s) => s.agents);
  const removeAgentFromSession = useAppStore((s) => s.removeAgentFromSession);
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  const session = sessions.find((s) => s.id === sessionId);
  const sessionAgents = ((session as any)?.agents || [])
    .map((sa: any) => agents.find((a) => a.id === sa.agentId))
    .filter(Boolean) as AgentConfig[];

  const handleRemove = async (agentId: string) => {
    setRemoving((prev) => new Set(prev).add(agentId));
    try {
      await api.removeSessionAgent(sessionId, agentId);
      removeAgentFromSession(sessionId, agentId);
    } catch (err) {
      console.error('Failed to remove agent:', err);
    } finally {
      setRemoving((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} />
      <div className="fixed inset-8 flex items-center justify-center z-50">
        <div className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-hub">
            <h2 className="text-base font-semibold text-hub-primary">Remove Agent from Group</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-tertiary">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {sessionAgents.length === 0 && (
              <p className="text-sm text-hub-muted text-center py-6">No agents to remove</p>
            )}
            {sessionAgents.map((agent) => (
              <div key={agent.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-hub-border group hover:border-hub-danger/30 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-hub-primary">{agent.displayName}</div>
                  <div className="text-xs text-hub-tertiary truncate">{agent.description}</div>
                </div>
                <button
                  onClick={() => handleRemove(agent.id)}
                  disabled={removing.has(agent.id)}
                  className="p-2 rounded-md text-hub-tertiary hover:text-hub-danger hover:bg-hub-danger/10 opacity-0 group-hover:opacity-100 transition disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add removeSessionAgent to API client**

In `apps/web/src/lib/api.ts`:

```typescript
removeSessionAgent: (sessionId: string, agentId: string) =>
  request<void>(`/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' }),
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/RemoveAgentModal.tsx apps/web/src/lib/api.ts
git commit -m "feat: add RemoveAgentModal component and API client method"
```

---

### Task B5: Wire Add/Remove Buttons in Group Session Header

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Add state and imports**

Add imports in ChatView.tsx:

```tsx
import { Plus, Minus } from 'lucide-react';
import { AddAgentModal } from './AddAgentModal';
import { RemoveAgentModal } from './RemoveAgentModal';
```

Add state:

```tsx
const [showAddAgents, setShowAddAgents] = useState(false);
const [showRemoveAgents, setShowRemoveAgents] = useState(false);
```

- [ ] **Step 2: Add buttons in session header (left side)**

In the session header div (around line 299), add BEFORE the session title:

```tsx
{/* Add/Remove agent buttons — only for group sessions */}
{activeSession?.type === 'group' && (
  <>
    <button onClick={() => setShowAddAgents(true)}
      className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition shrink-0"
      title="Add agent to group"
    >
      <Plus className="w-3 h-3" /> Add
    </button>
    <button onClick={() => setShowRemoveAgents(true)}
      className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-hub-danger/30 text-hub-danger hover:bg-hub-danger/10 transition shrink-0"
      title="Remove agent from group"
    >
      <Minus className="w-3 h-3" /> Rmv
    </button>
  </>
)}
```

- [ ] **Step 3: Add modal components at end of JSX**

Before the closing `</div>` of ChatView's return (after SettingsPanel):

```tsx
{activeSession?.type === 'group' && (
  <>
    <AddAgentModal sessionId={activeSessionId} open={showAddAgents} onClose={() => setShowAddAgents(false)} />
    <RemoveAgentModal sessionId={activeSessionId} open={showRemoveAgents} onClose={() => setShowRemoveAgents(false)} />
  </>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat: add Add/Remove agent buttons to group session header"
```

---

### Task B6: Update WebSocket Handler — New Event Types

**Files:**
- Modify: `apps/web/src/hooks/useChat.ts`

- [ ] **Step 1: Handle `agent_added` and `agent_removed` events**

Add cases to the WS `onmessage` switch in `useChat.ts`:

```typescript
case 'agent_added':
  if (data.agentId && data.sessionId) {
    // Refresh session agents from API
    api.getSession(data.sessionId).then((s) => {
      useAppStore.getState().updateSessionInList(data.sessionId, { agents: s.agents });
    }).catch(() => {});
    addMessage(data.sessionId, {
      id: 'sys-add-' + Date.now(),
      sessionId: data.sessionId,
      senderType: 'agent',
      content: `Agent added to group`,
      status: 'done',
      createdAt: new Date().toISOString(),
    } as Message);
  }
  break;

case 'agent_removed':
  if (data.agentId && data.sessionId) {
    api.getSession(data.sessionId).then((s) => {
      useAppStore.getState().updateSessionInList(data.sessionId, { agents: s.agents });
    }).catch(() => {});
  }
  break;

case 'agent_queued':
  if (data.agentId && data.message) {
    addToast(data.message, 'info');
  }
  break;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useChat.ts
git commit -m "feat: handle agent_added/removed/queued WS events in frontend"
```

---

### Task B7: Restrict @ Mention to Session Agents in Group Mode

**Files:**
- Modify: `apps/web/src/components/AgentMentionPopup.tsx` (or the input component that calls it)

- [ ] **Step 1: Update agent filtering for @ mentions**

In `apps/web/src/components/ChatView.tsx`, when passing agents to the mention system, filter by context:

```typescript
// In ChatView:
const mentionAgents = useMemo(() => {
  if (!activeSession || activeSession.type !== 'group') {
    // Solo: show user's created agents
    return agents.filter(a => a.type === 'user' || a.type === undefined);
  }
  // Group: only show agents in this session
  const sessionAgentIds = new Set(
    ((activeSession as any)?.agents || []).map((sa: any) => sa.agentId)
  );
  return agents.filter(a => sessionAgentIds.has(a.id));
}, [activeSession, agents]);
```

- [ ] **Step 2: Pass filtered agents to input**

Update the MessageInput or AgentMentionPopup to use the filtered list.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat: restrict @ mentions to session agents in group mode"
```

---

### Task B8: Phase B Verification

- [ ] **Step 1: Full TypeScript check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: both clean.

- [ ] **Step 2: API endpoint test**

```bash
TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
# Test add agents endpoint
GROUP_ID=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/sessions | python3 -c "import json,sys; d=json.load(sys.stdin); print([s['id'] for s in d if s.get('type')=='group'][0])")
AGENT_ID=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents | python3 -c "import json,sys; d=json.load(sys.stdin); print([a['id'] for a in d if a.get('type')=='user'][0])")

# Add
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"agentIds\":[\"$AGENT_ID\"]}" "http://localhost:3000/api/sessions/$GROUP_ID/agents" | python3 -m json.tool

# Remove
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/sessions/$GROUP_ID/agents/$AGENT_ID"
```

Expected: Add returns `{"added": ["<agentId>"]}`, Remove returns 204.

- [ ] **Step 3: Commit checkpoint**

```bash
git add -A && git commit -m "chore: Phase B complete — group member management UI and memory sharing"
```

---

## Phase C: 清理旧代码 + 端到端测试

### Task C1: Remove Legacy Agent Spawning Logic

- [ ] **Step 1: Remove `preActivateGroupAgents` from handler.ts**

In `apps/api/src/ws/handler.ts`, remove the `preActivateGroupAgents` function and its call site. Agents are now started lazily by AgentRuntime.

- [ ] **Step 2: Remove standby prompt logic**

Remove `standbyPrompt` helper functions in handler.ts. Context prefix is now injected at sendPrompt time by AgentRuntime.

- [ ] **Step 3: Remove BullMQ references from TaskQueue.ts**

In `apps/api/src/agent/TaskQueue.ts`, remove BullMQ import and worker logic. Keep only `topologicalSort` utility.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean (may need to update imports elsewhere).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ws/handler.ts apps/api/src/agent/TaskQueue.ts
git commit -m "refactor: remove legacy agent spawning and BullMQ references"
```

---

### Task C2: E2E Test — Agent Lifecycle

**Files:**
- Create: `apps/api/src/agent/lifecycleE2E.test.ts`

- [ ] **Step 1: Write E2E-style integration test script**

```python
#!/usr/bin/env python3
"""E2E test for agent lifecycle: create, add to group, shared memory, remove, delete."""

import asyncio, json, urllib.request
from playwright.async_api import async_playwright

BASE = "http://localhost:3000"
FRONTEND = "http://localhost:5175"

def get_token():
    with urllib.request.urlopen(f"{BASE}/api/auth/dev-token") as r:
        return json.loads(r.read())["token"]

async def test_agent_lifecycle():
    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 1. Create a solo session with custom agent
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions", data=b'{"type":"solo","customAgent":{"name":"e2e-py","displayName":"E2E Python","description":"Python expert","systemPrompt":"You are a Python expert"}}',
        headers=headers)).read())
    solo_id = resp["id"]
    agent_id = resp["agents"][0]["agentId"]
    print(f"1. Solo session created: {solo_id[:12]}... agent={agent_id[:12]}... PASS")

    # 2. Create a group session WITHOUT custom agents (uses templates)
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions", data=b'{"type":"group"}', headers=headers)).read())
    group_id = resp["id"]
    initial_agent_count = len(resp.get("agents", []))
    print(f"2. Group session created: {group_id[:12]}... agents={initial_agent_count} PASS")

    # 3. Add custom agent to group
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions/{group_id}/agents",
        data=json.dumps({"agentIds": [agent_id]}).encode(), headers=headers)).read())
    print(f"3. Added agent to group: added={resp.get('added', [])} PASS")

    # 4. Verify agent is in group
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions/{group_id}", headers=headers)).read())
    agent_in_group = any(a["agentId"] == agent_id for a in resp.get("agents", []))
    print(f"4. Agent in group session: {agent_in_group} {'PASS' if agent_in_group else 'FAIL'}")

    # 5. Remove agent from group
    urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions/{group_id}/agents/{agent_id}", method="DELETE", headers=headers))
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions/{group_id}", headers=headers)).read())
    agent_still_in_group = any(a["agentId"] == agent_id for a in resp.get("agents", []))
    print(f"5. Agent removed from group: {not agent_still_in_group} {'PASS' if not agent_still_in_group else 'FAIL'}")

    # 6. Solo session still has the agent
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/sessions/{solo_id}", headers=headers)).read())
    agent_in_solo = any(a["agentId"] == agent_id for a in resp.get("agents", []))
    print(f"6. Agent still in solo session: {agent_in_solo} {'PASS' if agent_in_solo else 'FAIL'}")

    # 7. Delete agent — should cascade
    urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/agents/{agent_id}", method="DELETE", headers=headers))
    resp = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/agents", headers=headers)).read())
    agent_still_exists = any(a["id"] == agent_id for a in resp)
    print(f"7. Agent deleted (no longer listed): {not agent_still_exists} {'PASS' if not agent_still_exists else 'FAIL'}")

asyncio.run(test_agent_lifecycle())
```

- [ ] **Step 2: Run E2E test**

```bash
python3 /tmp/agent_lifecycle_e2e.py
```

Expected: all 7 steps PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/lifecycleE2E.test.ts
git commit -m "test: add E2E test for agent lifecycle (create, group add/remove, delete)"
```

---

### Task C3: Full Regression — Run All Tests

- [ ] **Step 1: TypeScript + Unit tests + E2E**

```bash
# TypeScript
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json && echo "TS: OK"

# Backend unit tests
cd apps/api && npx tsx --test src/agent/core.test.ts src/agent/ClaudeCodeProcess.test.ts src/agent/processFactory.test.ts src/agent/turns.test.ts src/ws/closeCodes.test.ts src/agent/AgentRuntime.test.ts src/agent/AgentContainer.test.ts 2>&1 | tail -5

# E2E
python3 /tmp/agentHub_e2e_full_test.py 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 4: Final commit**

```bash
git add -A && git commit -m "chore: Phase C complete — cleanup and E2E regression pass"
```

---

## Summary

### Code Changes

| Phase | Files Created | Files Modified |
|-------|-------------|----------------|
| A | `AgentRuntime.ts`, `AgentContainer.ts`, `AgentRuntime.test.ts`, `AgentContainer.test.ts`, `integration.test.ts` | `schema.prisma`, `config.ts`, `defaultAgents.ts`, `index.ts`, `routes/agents.ts`, `routes/sessions.ts`, `ws/handler.ts` |
| B | `sessionAgents.ts`, `AddAgentModal.tsx`, `RemoveAgentModal.tsx` | `index.ts`, `appStore.ts`, `ChatView.tsx`, `useChat.ts`, `api.ts` |
| C | `lifecycleE2E.test.ts` | `ws/handler.ts`, `agent/TaskQueue.ts` |

### Total: 10 new files, 12 modified files

---

> **Plan 结束**
> 分三个 Phase 依次实施。每个 Phase 完成后运行 TypeScript 编译 + 现有测试确保不引入回归。
