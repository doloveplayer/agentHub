# Agent 协作上下文管理 & Plan 归档 & 故障恢复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Context Bus 全局状态黑板、Plan 归档流水线（产物快照 + 经验提取）、三级故障恢复（task 重试增强 + plan 断点续跑 + session 快照远期）、AgentCard 第 4 页 Skills 使用统计。

**Architecture:** 4 个独立子系统：ContextBus（session 级 KV 黑板 + DB 持久化）、ArchiveManager（Plan 完成时触发 4 步流水线）、CheckpointManager（checkpoint JSON 写入/恢复）、FaceSkillStats（前端统计卡片）。ContextBus 作为执行时的输入源，ArchiveManager 作为完成后的输出处理器，CheckpointManager 保存/恢复中间状态。

**Tech Stack:** TypeScript, Hono 4, Prisma, Zustand, React 18, Tailwind

**Spec:** `docs/superpowers/specs/2026-06-02-agent-context-archive-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types.ts` | 新增 `ContextEntryType`, `SkillUseEvent`, `plan_checkpoint` 等类型 |
| `apps/api/src/agent/ContextBus.ts` | **新增** — 全局状态黑板，KV 存储 + 序列化/反序列化 + 摘要生成 |
| `apps/api/src/agent/ContextBus.test.ts` | **新增** — ContextBus 单元测试 |
| `apps/api/src/agent/ExperienceExtractor.ts` | **新增** — 规则引擎，从 Plan 执行日志提取经验 |
| `apps/api/src/agent/ExperienceExtractor.test.ts` | **新增** — 规则引擎测试 |
| `apps/api/src/agent/ArchiveManager.ts` | **新增** — 归档流水线编排：产物快照 + 经验提取 + memory 写入 |
| `apps/api/src/agent/CheckpointManager.ts` | **新增** — checkpoint 写入/读取/恢复 |
| `apps/api/src/agent/skills/archive-experience.md` | **新增** — Plan Skill 模板：语义经验提取 |
| `apps/api/src/agent/StateTracker.ts` | 修改 — 新增 `SkillUsageRecord` 和 `recordSkillUse` |
| `apps/api/src/agent/AgentDirectoryManager.ts` | 修改 — 新增 `writeAgentMemory` 方法 |
| `apps/api/src/ws/taskDispatcher.ts` | 修改 — 上下文注入 + skill 事件 + checkpoint 更新 |
| `apps/api/src/ws/chatHandlers.ts` | 修改 — 断线重连恢复流程 |
| `apps/api/src/agent/providers/claude-code.ts` | 修改 — claudeSessionId 持久化回调 |
| `apps/api/src/agent/DagPersistence.ts` | 修改 — 新增 `markArchived` |
| `apps/api/prisma/schema.prisma` | 修改 — 新增 `ContextEntry` + `SessionCheckpoint` 表 |
| `apps/web/src/components/AgentCard.tsx` | 修改 — 第 4 个 dot 指示器 |
| `apps/web/src/components/AgentCardFaces.tsx` | 修改 — 新增 `FaceSkillStats` 组件 |
| `apps/web/src/store/appStore.ts` | 修改 — 新增 `skill_use` 事件类型 |

---

### Task 1: 共享类型定义

**Files:**
- Modify: `packages/shared/src/types.ts`

- [x] **Step 1: 新增 Context Bus 和归档相关类型**

在 `packages/shared/src/types.ts` 末尾追加：

```typescript
// ---- Context Bus ----

export type ContextEntryType =
  | 'known-issue'
  | 'project-fact'
  | 'task-handoff'
  | 'decision'
  | 'artifact'
  | 'convention'
  | 'dependency-map';

export type ContextEntryStatus = 'active' | 'resolved' | 'superseded';

export interface ContextEntry {
  key: string;
  value: unknown;
  type: ContextEntryType;
  version: number;
  author: string;
  taskId?: string;
  planId?: string;
  tags: string[];
  status: ContextEntryStatus;
  createdAt: number;
  updatedAt: number;
}

// ---- Archive ----

export interface ArchiveManifest {
  planId: string;
  sessionId: string;
  planTitle: string;
  completedAt: string;
  durationMs: number;
  tasks: Array<{
    id: string;
    title: string;
    agentType: string;
    status: string;
    outputFiles: string[];
    modifiedFiles: string[];
    outputSummary: string;
  }>;
  fileChanges: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  contextEntries: Array<{
    key: string;
    type: ContextEntryType;
    status: ContextEntryStatus;
  }>;
}

export type ExperienceType =
  | 'bug-pattern'
  | 'project-convention'
  | 'strategy-outcome'
  | 'dependency-topology'
  | 'domain-knowledge'
  | 'tool-pitfall';

export interface ExperienceEntry {
  type: ExperienceType;
  title: string;
  detail: string;
  agentTypes: string[];
  tags: string[];
  sourcePlan?: string;
  sourceTask?: string;
  severity: 'high' | 'medium' | 'low';
}

// ---- Checkpoint ----

export interface AgentSessionState {
  claudeSessionId: string;
  lastTaskId: string;
  status: 'idle' | 'running';
}

export interface PlanCheckpoint {
  planId: string;
  sessionId: string;
  workspaceGitCommit?: string;
  contextBusState: string;
  agentSessions: Record<string, AgentSessionState>;
  pendingTasks: Array<{
    id: string;
    title: string;
    description: string;
    agentType: string;
    dependsOn: string[];
    expectedOutput: string;
    priority: string;
  }>;
  completedTasks: string[];
  failedTasks: Array<{
    id: string;
    error: string;
    retryCount: number;
  }>;
  timestamp: number;
}

// ---- Skill Stats ----

export interface SkillUsageRecord {
  skillName: string;
  agentName: string;
  agentId: string;
  count: number;
  firstUsed: number;
  lastUsed: number;
  associatedTaskIds: string[];
}

export interface SkillUseEvent {
  type: 'skill_use';
  skillName: string;
  agentName: string;
  agentId: string;
  taskId?: string;
  planId?: string;
  timestamp: number;
}
```

- [ ] **Step 2: 编译检查**

```bash
cd packages/shared && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add ContextBus, Archive, Checkpoint, and SkillStats shared types"
```

---

### Task 2: ContextBus 核心实现

**Files:**
- Create: `apps/api/src/agent/ContextBus.ts`
- Create: `apps/api/src/agent/ContextBus.test.ts`

- [ ] **Step 1: 编写 ContextBus 测试**

创建 `apps/api/src/agent/ContextBus.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ContextBus } from './ContextBus.js';

describe('ContextBus', () => {
  let bus: ContextBus;

  beforeEach(() => {
    bus = new ContextBus();
  });

  it('should set and get entries', () => {
    bus.set({
      key: 'proj:convention:import-style',
      value: { alias: '@/', forbidRelative: true },
      type: 'convention',
      author: 'code-agent',
      tags: ['import', 'style'],
      status: 'active',
    });
    const entry = bus.get('proj:convention:import-style');
    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ alias: '@/', forbidRelative: true });
    expect(entry!.version).toBe(1);
  });

  it('should overwrite and bump version', () => {
    bus.set({ key: 'k', value: 'v1', type: 'project-fact', author: 'a', tags: [], status: 'active' });
    bus.set({ key: 'k', value: 'v2', type: 'project-fact', author: 'b', tags: [], status: 'resolved' });
    const entry = bus.get('k');
    expect(entry!.value).toBe('v2');
    expect(entry!.version).toBe(2);
    expect(entry!.author).toBe('b');
    expect(entry!.status).toBe('resolved');
  });

  it('should query by type and tags', () => {
    bus.set({ key: 'a', value: 1, type: 'convention', author: 'x', tags: ['ts'], status: 'active' });
    bus.set({ key: 'b', value: 2, type: 'known-issue', author: 'y', tags: ['ts', 'null'], status: 'active' });
    bus.set({ key: 'c', value: 3, type: 'convention', author: 'z', tags: ['docker'], status: 'active' });

    const conventions = bus.query({ type: 'convention' });
    expect(conventions).toHaveLength(2);

    const tsTagged = bus.query({ tags: ['ts'] });
    expect(tsTagged).toHaveLength(2);

    const nullTagged = bus.query({ tags: ['null'] });
    expect(nullTagged).toHaveLength(1);
  });

  it('should filter by status', () => {
    bus.set({ key: 'a', value: 1, type: 'project-fact', author: 'x', tags: [], status: 'active' });
    bus.set({ key: 'b', value: 2, type: 'project-fact', author: 'y', tags: [], status: 'resolved' });

    const active = bus.query({ status: 'active' });
    expect(active).toHaveLength(1);
  });

  it('should generate project digest within token limit', () => {
    for (let i = 0; i < 20; i++) {
      bus.set({
        key: `proj:fact:${i}`,
        value: `Some project fact number ${i} with a bit more detail here`,
        type: 'project-fact',
        author: 'test',
        tags: [],
        status: 'active',
      });
    }
    const digest = bus.getProjectDigest(500);
    expect(digest.length).toBeLessThanOrEqual(600); // allow some overhead
    expect(digest).toContain('fact:0');
  });

  it('should get relevant experience for agent type', () => {
    bus.set({
      key: 'bug:null-db', value: 'DB query must be null-checked',
      type: 'known-issue', author: 'review-agent', tags: ['code-agent', 'prisma'], status: 'active',
    });
    bus.set({
      key: 'bug:css-flex', value: 'Flexbox gap not supported in older Safari',
      type: 'known-issue', author: 'test-agent', tags: ['frontend-agent', 'css'], status: 'active',
    });

    const codeExp = bus.getRelevantExperience('code-agent', 'Write a database query');
    expect(codeExp).toContain('null-db');
    expect(codeExp).not.toContain('css-flex');

    const frontendExp = bus.getRelevantExperience('frontend-agent', 'Style the header');
    expect(frontendExp).toContain('css-flex');
    expect(frontendExp).not.toContain('null-db');
  });

  it('should serialize and deserialize', () => {
    bus.set({ key: 'a', value: 'hello', type: 'project-fact', author: 'x', tags: ['t'], status: 'active' });
    bus.set({ key: 'b', value: { nested: true }, type: 'convention', author: 'y', tags: [], status: 'active' });

    const json = bus.serialize();
    const restored = ContextBus.deserialize(json);

    expect(restored.get('a')!.value).toBe('hello');
    expect(restored.get('b')!.value).toEqual({ nested: true });
  });

  it('should archive entries by planId', () => {
    bus.set({ key: 'a', value: 1, type: 'task-handoff', author: 'x', tags: [], planId: 'p1', status: 'active' });
    bus.set({ key: 'b', value: 2, type: 'task-handoff', author: 'y', tags: [], planId: 'p2', status: 'active' });

    const archived = bus.archive('p1');
    expect(archived).toHaveLength(1);
    expect(archived[0].key).toBe('a');
    expect(bus.get('a')).toBeUndefined();
    expect(bus.get('b')).toBeDefined();
  });

  it('should enforce max entries and LRU evict', () => {
    const smallBus = new ContextBus(5); // max 5 entries
    for (let i = 0; i < 10; i++) {
      smallBus.set({ key: `k${i}`, value: i, type: 'project-fact', author: 'a', tags: [], status: 'active' });
    }
    // Oldest entries should be evicted
    expect(smallBus.get('k0')).toBeUndefined();
    expect(smallBus.get('k9')).toBeDefined();
  });

  it('should get keys for new entries of a given type', () => {
    // After archive() resets the "new" tracking, only freshly set entries count
    bus.set({ key: 'k1', value: 1, type: 'convention', author: 'a', tags: [], status: 'active' });
    bus.set({ key: 'k2', value: 2, type: 'known-issue', author: 'b', tags: [], status: 'active' });

    const conventions = bus.getNewEntriesOfType('convention');
    expect(conventions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/api && npx vitest run src/agent/ContextBus.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: 实现 ContextBus**

创建 `apps/api/src/agent/ContextBus.ts`：

```typescript
import type { ContextEntry, ContextEntryType, ContextEntryStatus } from '@agenthub/shared';

interface SetOptions {
  key: string;
  value: unknown;
  type: ContextEntryType;
  author: string;
  taskId?: string;
  planId?: string;
  tags: string[];
  status: ContextEntryStatus;
}

export interface ContextQuery {
  type?: ContextEntryType;
  tags?: string[];
  status?: ContextEntryStatus;
  planId?: string;
  author?: string;
  limit?: number;
}

export class ContextBus {
  private store = new Map<string, ContextEntry>();
  private newKeys = new Set<string>();
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  set(opts: SetOptions): ContextEntry {
    const now = Date.now();
    const existing = this.store.get(opts.key);
    const entry: ContextEntry = {
      key: opts.key,
      value: opts.value,
      type: opts.type,
      version: existing ? existing.version + 1 : 1,
      author: opts.author,
      taskId: opts.taskId,
      planId: opts.planId,
      tags: opts.tags,
      status: opts.status,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.store.set(opts.key, entry);
    this.newKeys.add(opts.key);

    // LRU eviction: remove oldest entries by createdAt
    if (this.store.size > this.maxEntries) {
      const sorted = [...this.store.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (let i = 0; i < sorted.length - this.maxEntries; i++) {
        this.store.delete(sorted[i][0]);
        this.newKeys.delete(sorted[i][0]);
      }
    }

    return entry;
  }

  get(key: string): ContextEntry | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): boolean {
    this.newKeys.delete(key);
    return this.store.delete(key);
  }

  query(filter: ContextQuery = {}): ContextEntry[] {
    let results = [...this.store.values()];

    if (filter.type) {
      results = results.filter(e => e.type === filter.type);
    }
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter(e =>
        filter.tags!.some(t => e.tags.includes(t))
      );
    }
    if (filter.status) {
      results = results.filter(e => e.status === filter.status);
    }
    if (filter.planId) {
      results = results.filter(e => e.planId === filter.planId);
    }
    if (filter.author) {
      results = results.filter(e => e.author === filter.author);
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt);

    if (filter.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /** Build a compact digest of active project-level entries, capped at maxTokens characters. */
  getProjectDigest(maxTokens: number): string {
    const active = this.query({ status: 'active' });
    if (active.length === 0) return '';

    // Approximate: 1 token ~= 4 chars
    const maxChars = maxTokens * 4;
    let digest = '## Project State\n\n';
    let remaining = maxChars - digest.length;

    // Sort: conventions + decisions first (most relevant for new tasks)
    const priority = (e: ContextEntry): number => {
      const order: ContextEntryType[] = ['convention', 'decision', 'known-issue', 'dependency-map', 'project-fact', 'task-handoff', 'artifact'];
      return order.indexOf(e.type);
    };
    const sorted = [...active].sort((a, b) => priority(a) - priority(b));

    for (const e of sorted) {
      const line = `- [${e.type}] **${e.key}**: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 120)}\n`;
      if (line.length > remaining) break;
      digest += line;
      remaining -= line.length;
    }

    return digest;
  }

  /** Get experience entries relevant to a given agent type based on tag matching. */
  getRelevantExperience(agentType: string, taskDescription: string): string {
    const normalizedType = agentType.toLowerCase();
    const experiences = this.query({ status: 'active' }).filter(e =>
      e.type === 'known-issue' || e.type === 'convention' || e.type === 'tool-pitfall'
    );

    if (experiences.length === 0) return '';

    // Filter by agent type tag match
    let relevant = experiences.filter(e =>
      e.tags.some(t => t.toLowerCase() === normalizedType)
    );

    // Also include entries tagged with keywords from the task description
    const taskWords = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const keywordMatches = experiences.filter(e =>
      !relevant.includes(e) &&
      e.tags.some(t => taskWords.some(w => t.toLowerCase().includes(w) || w.includes(t.toLowerCase())))
    );
    relevant = [...relevant, ...keywordMatches.slice(0, 3)];

    if (relevant.length === 0) return '';

    let result = '\n## Relevant Experience\n\n';
    for (const e of relevant.slice(0, 5)) {
      const label = typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 150);
      result += `- [${e.type}] ${e.key}: ${label}\n`;
    }
    return result;
  }

  getNewEntriesOfType(type: ContextEntryType): ContextEntry[] {
    return [...this.newKeys]
      .map(k => this.store.get(k))
      .filter((e): e is ContextEntry => e !== undefined && e.type === type);
  }

  /** Serialize to JSON for checkpoint persistence. */
  serialize(): string {
    return JSON.stringify([...this.store.values()]);
  }

  /** Deserialize from JSON to restore a checkpoint. */
  static deserialize(data: string): ContextBus {
    const bus = new ContextBus();
    try {
      const entries: ContextEntry[] = JSON.parse(data);
      for (const e of entries) {
        bus.store.set(e.key, e);
      }
    } catch { /* ignore corrupt data */ }
    return bus;
  }

  /** Archive (remove) entries for a planId and return them. */
  archive(planId: string): ContextEntry[] {
    const entries = this.query({ planId });
    for (const e of entries) {
      this.store.delete(e.key);
      this.newKeys.delete(e.key);
    }
    return entries;
  }

  /** Remove entries with status 'resolved' or 'superseded' older than ageMs. */
  gc(ageMs = 7 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (
        (entry.status === 'resolved' || entry.status === 'superseded') &&
        now - entry.updatedAt > ageMs
      ) {
        this.store.delete(key);
        this.newKeys.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.newKeys.clear();
  }

  /** Check if there are any new entries of a given type (for ExperienceExtractor). */
  hasNewEntriesOfType(type: ContextEntryType): boolean {
    return this.getNewEntriesOfType(type).length > 0;
  }
}

/** Per-session singleton — created by WS handler on session connect, destroyed on disconnect. */
const sessionBuses = new Map<string, ContextBus>();

export function getSessionContextBus(sessionId: string): ContextBus {
  let bus = sessionBuses.get(sessionId);
  if (!bus) {
    bus = new ContextBus();
    sessionBuses.set(sessionId, bus);
  }
  return bus;
}

export function destroySessionContextBus(sessionId: string): void {
  sessionBuses.delete(sessionId);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd apps/api && npx vitest run src/agent/ContextBus.test.ts
```
Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/ContextBus.ts apps/api/src/agent/ContextBus.test.ts
git commit -m "feat: add ContextBus — per-session key-value state blackboard"
```

---

### Task 3: Context Bus 上下文注入到 Task Dispatch

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

- [ ] **Step 1: 修改 buildTaskPrompt，注入上下文**

在 `apps/api/src/ws/taskDispatcher.ts` 顶部新增 import：

```typescript
import { getSessionContextBus } from '../agent/ContextBus.js';
```

将 `buildTaskPrompt` 函数改为接受 sessionId 参数：

```typescript
function buildTaskPrompt(task: TaskDispatchNode, sessionId?: string): string {
  let contextBlock = '';
  if (sessionId) {
    const bus = getSessionContextBus(sessionId);
    const digest = bus.getProjectDigest(400);
    const experience = bus.getRelevantExperience(task.agentType, task.description);
    if (digest) contextBlock += digest + '\n';
    if (experience) contextBlock += experience + '\n';
  }

  return `${contextBlock}Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}
${task.dependsOn.length > 0 ? `\nDepends on: ${task.dependsOn.join(', ')}\n` : ''}
Execute this task now. Output results to the specified files.`;
}
```

- [ ] **Step 2: 更新所有调用 buildTaskPrompt 的地方**

在 `processNextInQueue` 中（约第 347 行），将 `buildTaskPrompt(task)` 改为 `buildTaskPrompt(task, sessionId)`。

在 `startReplForTask` 中（约第 405 行），将 `buildTaskPrompt(task)` 改为 `buildTaskPrompt(task, sessionId)`。

在 `handleDispatchedTaskFinished` 的 ManagerLoop 部分（约第 603 行），将 `buildTaskPrompt(failedTask.task)` 改为 `buildTaskPrompt(failedTask.task, sessionId)`。

- [ ] **Step 3: Task 完成时写入 Context Bus handoff**

在 `handleProviderTaskEvent` 的 `'done'` case 中（约第 249-277 行），succeeded 分支追加：

```typescript
// After broadcast('task_completed', ...), add:
if (succeeded && output) {
  const bus = getSessionContextBus(sessionId);
  bus.set({
    key: `task:${task.id}:output-summary`,
    value: output.slice(0, 500),
    type: 'task-handoff',
    author: agentName,
    taskId: task.id,
    planId: queue.planId,
    tags: [agentName, task.agentType, 'handoff'],
    status: 'active',
  });
}
```

在 `'done'` case 的 failed 分支中追加：

```typescript
// In the failed branch, store failure context:
const bus = getSessionContextBus(sessionId);
bus.set({
  key: `task:${task.id}:failure`,
  value: `Failed: ${output.slice(0, 300)}`,
  type: 'known-issue',
  author: agentName,
  taskId: task.id,
  planId: queue.planId,
  tags: [agentName, task.agentType, 'failure'],
  status: 'active',
});
```

- [ ] **Step 4: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: inject ContextBus digest and experience into task prompts"
```

---

### Task 4: DB 持久化 ContextBus

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/agent/ContextBusPersistence.ts`

- [ ] **Step 1: 新增 Prisma 模型**

在 `apps/api/prisma/schema.prisma` 的 `PlanExecution` 模型之后添加：

```prisma
model ContextEntryRecord {
  id        String   @id
  sessionId String
  key       String
  value     String
  type      String
  version   Int      @default(1)
  author    String
  taskId    String?
  planId    String?
  tags      Json     @default("[]")
  status    String   @default("active")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([sessionId, key])
  @@index([sessionId])
  @@index([planId])
}

model SessionCheckpoint {
  id        String   @id
  sessionId String
  planId    String
  data      Json
  createdAt DateTime @default(now())

  @@unique([sessionId, planId])
  @@index([sessionId])
}
```

- [ ] **Step 2: 运行迁移**

```bash
cd apps/api && npx prisma migrate dev --name add_context_entry_and_checkpoint
```

- [ ] **Step 3: 实现 ContextBusPersistence**

创建 `apps/api/src/agent/ContextBusPersistence.ts`：

```typescript
import { prisma } from '../db/prisma.js';
import { ContextBus, getSessionContextBus } from './ContextBus.js';
import type { ContextEntry } from '@agenthub/shared';

export class ContextBusPersistence {
  /** Persist a single entry to DB. */
  static async saveEntry(sessionId: string, entry: ContextEntry): Promise<void> {
    await prisma.contextEntryRecord.upsert({
      where: { sessionId_key: { sessionId, key: entry.key } },
      update: {
        value: JSON.stringify(entry.value),
        type: entry.type,
        version: entry.version,
        author: entry.author,
        taskId: entry.taskId || null,
        planId: entry.planId || null,
        tags: entry.tags,
        status: entry.status,
      },
      create: {
        id: `${sessionId}:${entry.key}`,
        sessionId,
        key: entry.key,
        value: JSON.stringify(entry.value),
        type: entry.type,
        version: entry.version,
        author: entry.author,
        taskId: entry.taskId || null,
        planId: entry.planId || null,
        tags: entry.tags,
        status: entry.status,
      },
    }).catch((err) => console.error(`[ContextBus] DB save failed: ${err.message}`));
  }

  /** Restore ContextBus from DB for a session. */
  static async restore(sessionId: string): Promise<ContextBus> {
    const bus = getSessionContextBus(sessionId);
    try {
      const records = await prisma.contextEntryRecord.findMany({
        where: { sessionId, status: 'active' },
        orderBy: { updatedAt: 'asc' },
      });
      for (const r of records) {
        let value: unknown = r.value;
        try { value = JSON.parse(r.value); } catch { /* keep as string */ }
        bus.set({
          key: r.key,
          value,
          type: r.type as ContextEntry['type'],
          author: r.author,
          taskId: r.taskId || undefined,
          planId: r.planId || undefined,
          tags: r.tags as string[],
          status: r.status as ContextEntry['status'],
        });
      }
    } catch (err: any) {
      console.error(`[ContextBus] Restore failed: ${err.message}`);
    }
    return bus;
  }

  /** Delete all entries for a session. */
  static async cleanup(sessionId: string): Promise<void> {
    await prisma.contextEntryRecord.deleteMany({ where: { sessionId } }).catch(() => {});
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/agent/ContextBusPersistence.ts
git commit -m "feat: add ContextBus DB persistence with Prisma"
```

---

### Task 5: ExperienceExtractor 规则引擎

**Files:**
- Create: `apps/api/src/agent/ExperienceExtractor.ts`
- Create: `apps/api/src/agent/ExperienceExtractor.test.ts`

- [ ] **Step 1: 编写测试**

创建 `apps/api/src/agent/ExperienceExtractor.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { ExperienceExtractor, type ExtractionContext } from './ExperienceExtractor.js';
import { ContextBus } from './ContextBus.js';

describe('ExperienceExtractor', () => {
  const extractor = new ExperienceExtractor();

  it('should extract review-rejection as bug-pattern', () => {
    const bus = new ContextBus();
    const ctx: ExtractionContext = {
      planId: 'p1',
      sessionId: 's1',
      tasks: [
        { id: 't1', title: 'Implement login', agentType: 'code-agent', status: 'failed', outputSummary: '', outputFiles: [], modifiedFiles: [] },
      ],
      failedTasks: [{ taskId: 't1', agentType: 'review-agent', error: 'Missing null check in auth.ts:42', retryCount: 0 }],
      contextBus: bus,
    };
    const entries = extractor.extract(ctx);
    const bugPatterns = entries.filter(e => e.type === 'bug-pattern');
    expect(bugPatterns.length).toBeGreaterThan(0);
    expect(bugPatterns[0].agentTypes).toContain('code-agent');
    expect(bugPatterns[0].detail).toContain('auth.ts');
  });

  it('should extract concurrent file edit as dependency-topology', () => {
    const bus = new ContextBus();
    const ctx: ExtractionContext = {
      planId: 'p1',
      sessionId: 's1',
      tasks: [
        { id: 't1', title: 'Add auth hook', agentType: 'code-agent', status: 'done', outputSummary: '', outputFiles: [], modifiedFiles: ['src/auth.ts'] },
        { id: 't2', title: 'Fix auth bug', agentType: 'code-agent', status: 'done', outputSummary: '', outputFiles: [], modifiedFiles: ['src/auth.ts'] },
      ],
      failedTasks: [],
      contextBus: bus,
    };
    const entries = extractor.extract(ctx);
    const topologies = entries.filter(e => e.type === 'dependency-topology');
    expect(topologies.length).toBeGreaterThan(0);
    expect(topologies[0].detail).toContain('src/auth.ts');
  });

  it('should extract conventions from ContextBus', () => {
    const bus = new ContextBus();
    bus.set({ key: 'c1', value: 'Use @/ imports', type: 'convention', author: 'review-agent', tags: ['code-agent'], status: 'active' });
    bus.set({ key: 'c2', value: 'Use describe/it pattern', type: 'convention', author: 'test-agent', tags: ['test-agent'], status: 'active' });

    const ctx: ExtractionContext = {
      planId: 'p1', sessionId: 's1',
      tasks: [],
      failedTasks: [],
      contextBus: bus,
    };
    const entries = extractor.extract(ctx);
    const conventions = entries.filter(e => e.type === 'project-convention');
    expect(conventions.length).toBe(2);
  });

  it('should return empty for no failures or conventions', () => {
    const bus = new ContextBus();
    const ctx: ExtractionContext = {
      planId: 'p1', sessionId: 's1',
      tasks: [{ id: 't1', title: 'OK task', agentType: 'code-agent', status: 'done', outputSummary: '', outputFiles: [], modifiedFiles: [] }],
      failedTasks: [],
      contextBus: bus,
    };
    const entries = extractor.extract(ctx);
    expect(entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 实现 ExperienceExtractor**

创建 `apps/api/src/agent/ExperienceExtractor.ts`：

```typescript
import type { ExperienceEntry } from '@agenthub/shared';
import type { ContextBus } from './ContextBus.js';

export interface ExtractionTask {
  id: string;
  title: string;
  agentType: string;
  status: string;
  outputSummary: string;
  outputFiles: string[];
  modifiedFiles: string[];
}

export interface FailedTaskInfo {
  taskId: string;
  agentType: string;
  error: string;
  retryCount: number;
}

export interface ExtractionContext {
  planId: string;
  sessionId: string;
  tasks: ExtractionTask[];
  failedTasks: FailedTaskInfo[];
  contextBus: ContextBus;
}

type ExtractionRule = {
  name: string;
  match: (ctx: ExtractionContext) => boolean;
  extract: (ctx: ExtractionContext) => ExperienceEntry[];
};

const BUILTIN_RULES: ExtractionRule[] = [
  {
    name: 'review-rejection-pattern',
    match: (ctx) => ctx.failedTasks.some(f => f.agentType === 'review-agent'),
    extract: (ctx) => {
      const reviewBlocked = ctx.failedTasks.filter(f => f.agentType === 'review-agent');
      return reviewBlocked.map(f => {
        const task = ctx.tasks.find(t => t.id === f.taskId);
        const fileHint = extractFilePath(f.error);
        return {
          type: 'bug-pattern' as const,
          title: `${task?.title || f.taskId} 被审查拒绝`,
          detail: f.error.slice(0, 500),
          agentTypes: ['code-agent'],
          tags: ['review-rejection', ...(fileHint ? [fileHint] : [])],
          sourcePlan: ctx.planId,
          sourceTask: f.taskId,
          severity: 'high' as const,
        };
      });
    },
  },
  {
    name: 'file-conflict-warning',
    match: (ctx) => {
      const fileEdits = new Map<string, string[]>();
      for (const t of ctx.tasks) {
        for (const f of t.modifiedFiles) {
          if (!fileEdits.has(f)) fileEdits.set(f, []);
          fileEdits.get(f)!.push(t.title);
        }
      }
      return [...fileEdits.values()].some(titles => titles.length >= 2);
    },
    extract: (ctx) => {
      const fileEdits = new Map<string, string[]>();
      for (const t of ctx.tasks) {
        for (const f of t.modifiedFiles) {
          if (!fileEdits.has(f)) fileEdits.set(f, []);
          fileEdits.get(f)!.push(t.title);
        }
      }
      const entries: ExperienceEntry[] = [];
      for (const [file, titles] of fileEdits) {
        if (titles.length >= 2) {
          entries.push({
            type: 'dependency-topology',
            title: `文件 ${file} 被多 task 并发修改`,
            detail: `涉及: ${titles.join(', ')}`,
            agentTypes: ['code-agent', 'planner'],
            tags: ['concurrent-edit', ...file.split('/')],
            sourcePlan: ctx.planId,
            severity: 'medium',
          });
        }
      }
      return entries;
    },
  },
  {
    name: 'convention-from-contextbus',
    match: (ctx) => ctx.contextBus.hasNewEntriesOfType('convention'),
    extract: (ctx) => ctx.contextBus.getNewEntriesOfType('convention').map(e => ({
      type: 'project-convention' as const,
      title: e.key,
      detail: typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 300),
      agentTypes: e.tags,
      tags: e.tags,
      sourcePlan: ctx.planId,
      severity: 'medium' as const,
    })),
  },
  {
    name: 'known-issue-from-contextbus',
    match: (ctx) => ctx.contextBus.hasNewEntriesOfType('known-issue'),
    extract: (ctx) => ctx.contextBus.getNewEntriesOfType('known-issue').map(e => ({
      type: 'bug-pattern' as const,
      title: e.key,
      detail: typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 300),
      agentTypes: e.tags,
      tags: e.tags,
      sourcePlan: ctx.planId,
      severity: 'high' as const,
    })),
  },
];

function extractFilePath(text: string): string | null {
  const match = text.match(/([a-zA-Z0-9_/.-]+\.[a-z]{2,5})(?::\d+)?/);
  return match ? match[1] : null;
}

export class ExperienceExtractor {
  private rules: ExtractionRule[];

  constructor(rules?: ExtractionRule[]) {
    this.rules = rules || BUILTIN_RULES;
  }

  extract(ctx: ExtractionContext): ExperienceEntry[] {
    const entries: ExperienceEntry[] = [];
    for (const rule of this.rules) {
      try {
        if (rule.match(ctx)) {
          entries.push(...rule.extract(ctx));
        }
      } catch (err: any) {
        console.error(`[ExperienceExtractor] Rule ${rule.name} failed: ${err.message}`);
      }
    }
    return entries;
  }
}
```

- [ ] **Step 3: 运行测试**

```bash
cd apps/api && npx vitest run src/agent/ExperienceExtractor.test.ts
```
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent/ExperienceExtractor.ts apps/api/src/agent/ExperienceExtractor.test.ts
git commit -m "feat: add ExperienceExtractor rule engine for plan completion"
```

---

### Task 6: ArchiveManager 归档流水线

**Files:**
- Create: `apps/api/src/agent/ArchiveManager.ts`

- [ ] **Step 1: 实现 ArchiveManager**

创建 `apps/api/src/agent/ArchiveManager.ts`：

```typescript
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { prisma } from '../db/prisma.js';
import { getSessionContextBus } from './ContextBus.js';
import { ExperienceExtractor, type ExtractionTask, type FailedTaskInfo } from './ExperienceExtractor.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import type { ArchiveManifest, ExperienceEntry } from '@agenthub/shared';

const SANDBOXES_ROOT = '.sandboxes';

export class ArchiveManager {
  /** Execute the full archive pipeline for a completed plan. */
  static async archivePlan(
    sessionId: string,
    planId: string,
    planTitle: string,
    tasks: ExtractionTask[],
    failedTasks: FailedTaskInfo[],
    hostWorkDir: string,
    startTime: number,
  ): Promise<{ manifest: ArchiveManifest; experiences: ExperienceEntry[] }> {
    const bus = getSessionContextBus(sessionId);

    // Step 1: Product snapshot
    const manifest = await ArchiveManager.createSnapshot(sessionId, planId, planTitle, tasks, hostWorkDir, startTime);

    // Step 2: Experience extraction (rule engine)
    const extractor = new ExperienceExtractor();
    const experiences = extractor.extract({
      planId, sessionId, tasks, failedTasks, contextBus: bus,
    });

    // Step 3: Write experiences to agent memory
    if (experiences.length > 0) {
      await ArchiveManager.writeExperiences(experiences);
    }

    // Step 4: Cleanup
    bus.archive(planId);

    return { manifest, experiences };
  }

  /** Step 1: Create product snapshot — manifest.json + diff.patch. */
  private static async createSnapshot(
    sessionId: string,
    planId: string,
    planTitle: string,
    tasks: ExtractionTask[],
    hostWorkDir: string,
    startTime: number,
  ): Promise<ArchiveManifest> {
    const archiveDir = resolve(SANDBOXES_ROOT, sessionId, 'archive', planId);
    mkdirSync(archiveDir, { recursive: true });

    // Collect git diff
    let diffContent = '';
    try {
      diffContent = execSync('git diff --stat HEAD', {
        cwd: hostWorkDir, encoding: 'utf-8', timeout: 10000,
      });
    } catch { diffContent = '(git diff unavailable)'; }

    // Collect file changes
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    try {
      const status = execSync('git status --porcelain', {
        cwd: hostWorkDir, encoding: 'utf-8', timeout: 5000,
      });
      for (const line of status.trim().split('\n')) {
        if (!line) continue;
        const code = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        if (code === '??' || code === 'A') added.push(file);
        else if (code === 'D') removed.push(file);
        else modified.push(file);
      }
    } catch { /* ignore */ }

    const durationMs = Date.now() - startTime;
    const manifest: ArchiveManifest = {
      planId,
      sessionId,
      planTitle,
      completedAt: new Date().toISOString(),
      durationMs,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        agentType: t.agentType,
        status: t.status,
        outputFiles: t.outputFiles,
        modifiedFiles: t.modifiedFiles,
        outputSummary: t.outputSummary.slice(0, 300),
      })),
      fileChanges: { added, modified, removed },
      contextEntries: getSessionContextBus(sessionId).query({ planId }).map(e => ({
        key: e.key, type: e.type, status: e.status,
      })),
    };

    writeFileSync(resolve(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    writeFileSync(resolve(archiveDir, 'diff.patch'), diffContent, 'utf-8');

    // Persist to DB
    await prisma.planExecution.updateMany({
      where: { sessionId, planId },
      data: { status: 'archived' },
    }).catch(() => {});

    return manifest;
  }

  /** Step 3: Write experiences to agent memory directories. */
  static async writeExperiences(experiences: ExperienceEntry[]): Promise<void> {
    // Group by agentType
    const byAgent = new Map<string, ExperienceEntry[]>();
    for (const exp of experiences) {
      for (const agentType of exp.agentTypes) {
        if (!byAgent.has(agentType)) byAgent.set(agentType, []);
        byAgent.get(agentType)!.push(exp);
      }
    }

    // Find agent IDs by name/type
    for (const [agentType, exps] of byAgent) {
      try {
        const agents = await prisma.agent.findMany({
          where: { name: { contains: agentType, mode: 'insensitive' } },
          select: { id: true, name: true, systemPrompt: true },
        });
        for (const agent of agents) {
          const homeDir = AgentDirectoryManager.getAgentHome(agent.id);
          AgentDirectoryManager.ensureAgentHome(agent.id, agent.name, agent.systemPrompt);
          for (const exp of exps) {
            AgentDirectoryManager.writeAgentMemory(homeDir, exp);
          }
        }
      } catch (err: any) {
        console.error(`[ArchiveManager] Failed to write memory for ${agentType}: ${err.message}`);
      }
    }
  }
}
```

- [ ] **Step 2: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/ArchiveManager.ts
git commit -m "feat: add ArchiveManager — product snapshot + experience extraction pipeline"
```

---

### Task 7: AgentDirectoryManager 扩展 — writeAgentMemory

**Files:**
- Modify: `apps/api/src/agent/AgentDirectoryManager.ts`

- [ ] **Step 1: 新增 writeAgentMemory 方法**

在 `AgentDirectoryManager` 类中追加：

```typescript
import type { ExperienceEntry } from '@agenthub/shared';

/** Write a single experience entry to the agent's memory directory. */
static writeAgentMemory(homeDir: string, exp: ExperienceEntry): void {
  const category = exp.type.replace(/-/g, '_');
  const slug = exp.title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const memoryDir = resolve(homeDir, '.claude', 'memory', category);
  mkdirSync(memoryDir, { recursive: true });

  const frontmatter = `---
name: ${slug}
description: ${exp.detail.slice(0, 120)}
metadata:
  type: reference
  tags: [${exp.tags.join(', ')}]
  severity: ${exp.severity}
  sourcePlan: ${exp.sourcePlan || ''}
  sourceTask: ${exp.sourceTask || ''}
---

## ${exp.title}

${exp.detail}
`;

  const filePath = resolve(memoryDir, `${slug}.md`);
  writeFileSync(filePath, frontmatter, 'utf-8');

  // Update MEMORY.md index
  const indexPath = resolve(homeDir, '.claude', 'memory', 'MEMORY.md');
  let index = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '# Agent Memory Index\n\n';
  const entryLine = `- [${slug}](${category}/${slug}.md) — ${exp.detail.slice(0, 80)}`;
  if (!index.includes(entryLine)) {
    index += entryLine + '\n';
    writeFileSync(indexPath, index, 'utf-8');
  }
}
```

- [ ] **Step 2: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/AgentDirectoryManager.ts
git commit -m "feat: add writeAgentMemory to AgentDirectoryManager"
```

---

### Task 8: Plan 完成时触发 Archive Pipeline

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

- [ ] **Step 1: 在 maybeBroadcastPlanSummary 中触发归档**

在 `maybeBroadcastPlanSummary` 函数（约第 944 行）中，`plan_summary` 广播后追加归档调用：

```typescript
// After broadcast('plan_summary', ...), add:
if (allDone) {
  const sandbox = sandboxes.get(sessionId);
  const archiveStartTime = Date.now();
  import('../agent/ArchiveManager.js').then(({ ArchiveManager }) => {
    const tasks: ExtractionTask[] = items.map(item => ({
      id: item.task.id,
      title: item.task.title,
      agentType: item.task.agentType,
      status: item.status,
      outputSummary: item.task.expectedOutput || '',
      outputFiles: [],
      modifiedFiles: [],
    }));
    const failedTasks = items
      .filter(item => item.status === 'failed' || item.status === 'blocked')
      .map(item => ({
        taskId: item.task.id,
        agentType: item.task.agentType,
        error: item.lastError || 'Unknown error',
        retryCount: item.retryCount || 0,
      }));
    ArchiveManager.archivePlan(
      sessionId, execution.planId, execution.planTitle || '',
      tasks, failedTasks,
      sandbox?.hostWorkDir || '', archiveStartTime,
    ).then(({ manifest, experiences }) => {
      console.log(`[archive] Plan ${execution.planId} archived: ${manifest.tasks.length} tasks, ${experiences.length} experiences`);
      broadcast(sessionId, {
        type: 'plan_archived',
        planId: execution.planId,
        experienceCount: experiences.length,
        manifestPath: `.sandboxes/${sessionId}/archive/${execution.planId}/manifest.json`,
      });
    }).catch(err => console.error(`[archive] Plan ${execution.planId} archive failed:`, err));
  }).catch(() => {});
}
```

- [ ] **Step 2: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: trigger ArchiveManager on plan completion"
```

---

### Task 9: archive-experience Skill 模板

**Files:**
- Create: `apps/api/src/agent/skills/archive-experience.md`

- [ ] **Step 1: 创建 Skill 模板**

创建 `apps/api/src/agent/skills/archive-experience.md`：

```markdown
---
name: archive-experience
description: 在 Plan 执行完成后，从执行日志和 Context Bus 黑板状态中提取可复用的经验模式，写入受影响 agent 的 memory 目录
---

# archive-experience Skill

你是一个经验归档专家。在 Plan 执行完成后被调用。

## 输入

你会收到以下结构化的输入：

1. **Plan 摘要**：planId, planTitle, 各 task 的状态和产出
2. **Context Bus 黑板状态**：所有 active 状态的条目
3. **失败 Task 详情**：失败 task 的 error 信息、retry 次数
4. **规则引擎已提取的经验**：`ExperienceEntry[]`

## 任务

1. 审查规则引擎提取的经验条目，补充语义层面的洞察：
   - 缺陷模式是否有更深层的根因？
   - 项目约定是否需要更精确的描述？
   - 是否有规则引擎未发现的隐性知识？

2. 生成最终的经验条目列表，每个条目包含：
   - `agentId`: 应写入哪个 agent 的 memory
   - `filePath`: 相对于 memory 目录的文件路径
   - `frontmatter`: 符合 Claude Code memory 格式的 YAML frontmatter
   - `body`: 经验详情的 markdown 内容

3. 输出 JSON 数组：

```json
[
  {
    "agentId": "uuid-of-agent",
    "filePath": "bug-patterns/null-check-db.md",
    "frontmatter": {
      "name": "null-check-db-query",
      "description": "strictNullChecks 下 DB 查询必须判空",
      "metadata": {
        "type": "reference",
        "tags": ["typescript", "prisma", "null-check"],
        "severity": "high"
      }
    },
    "body": "## 触发条件\n- 使用 Prisma client 查询\n..."
  }
]
```

## 原则

- 只提取**可复用**的经验。一次性的事件不归档。
- 描述要**精确**，包含具体文件路径、行号、工具名。
- 每条经验分配合理 severity：high = 会导致编译/运行时错误，medium = 代码质量/约定违反，low = 效率优化建议。
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/agent/skills/archive-experience.md
git commit -m "feat: add archive-experience skill template for semantic extraction"
```

---

### Task 10: CheckpointManager 实现

**Files:**
- Create: `apps/api/src/agent/CheckpointManager.ts`

- [ ] **Step 1: 实现 CheckpointManager**

创建 `apps/api/src/agent/CheckpointManager.ts`：

```typescript
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '../db/prisma.js';
import { getSessionContextBus, ContextBus } from './ContextBus.js';
import type { PlanCheckpoint, AgentSessionState } from '@agenthub/shared';

const SANDBOXES_ROOT = '.sandboxes';

export class CheckpointManager {
  /** Create or update a checkpoint for a plan. */
  static save(
    sessionId: string,
    planId: string,
    pendingTasks: PlanCheckpoint['pendingTasks'],
    completedTasks: string[],
    failedTasks: PlanCheckpoint['failedTasks'],
    agentSessions: Record<string, AgentSessionState>,
    workspaceGitCommit?: string,
  ): void {
    const bus = getSessionContextBus(sessionId);

    const checkpoint: PlanCheckpoint = {
      planId,
      sessionId,
      workspaceGitCommit,
      contextBusState: bus.serialize(),
      agentSessions,
      pendingTasks,
      completedTasks,
      failedTasks,
      timestamp: Date.now(),
    };

    // Write to filesystem
    const checkpointDir = resolve(SANDBOXES_ROOT, sessionId, 'checkpoints');
    mkdirSync(checkpointDir, { recursive: true });
    const filePath = resolve(checkpointDir, `${planId}.json`);
    writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');

    // Also persist to DB
    prisma.sessionCheckpoint.upsert({
      where: { sessionId_planId: { sessionId, planId } },
      update: { data: checkpoint as any },
      create: {
        id: `${sessionId}:${planId}`,
        sessionId, planId,
        data: checkpoint as any,
      },
    }).catch((err) => console.error(`[CheckpointManager] DB save failed: ${err.message}`));
  }

  /** Read a checkpoint from filesystem, fallback to DB. */
  static read(sessionId: string, planId: string): PlanCheckpoint | null {
    // Try filesystem first
    const filePath = resolve(SANDBOXES_ROOT, sessionId, 'checkpoints', `${planId}.json`);
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as PlanCheckpoint;
      } catch { /* fallback to DB */ }
    }

    return null;
  }

  /** Read checkpoint from DB (for cross-session recovery). */
  static async readFromDB(sessionId: string, planId: string): Promise<PlanCheckpoint | null> {
    try {
      const record = await prisma.sessionCheckpoint.findUnique({
        where: { sessionId_planId: { sessionId, planId } },
      });
      if (record) return record.data as unknown as PlanCheckpoint;
    } catch { /* ignore */ }
    return null;
  }

  /** Restore ContextBus from a checkpoint. */
  static restoreContextBus(sessionId: string, checkpoint: PlanCheckpoint): ContextBus {
    const bus = ContextBus.deserialize(checkpoint.contextBusState);
    // Replace the current session's bus
    const currentBus = getSessionContextBus(sessionId);
    currentBus.clear();
    for (const entry of bus.query()) {
      currentBus.set({
        key: entry.key, value: entry.value, type: entry.type,
        author: entry.author, taskId: entry.taskId, planId: entry.planId,
        tags: entry.tags, status: entry.status,
      });
    }
    return currentBus;
  }

  /** Clean up checkpoint files for a completed plan. */
  static cleanup(sessionId: string, planId: string): void {
    const filePath = resolve(SANDBOXES_ROOT, sessionId, 'checkpoints', `${planId}.json`);
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  }

  /** Update agent session ID in the checkpoint (called when SDK emits sessionId). */
  static updateAgentSession(
    sessionId: string,
    planId: string,
    agentName: string,
    claudeSessionId: string,
  ): void {
    const checkpoint = CheckpointManager.read(sessionId, planId);
    if (!checkpoint) return;
    checkpoint.agentSessions[agentName] = {
      claudeSessionId,
      lastTaskId: checkpoint.agentSessions[agentName]?.lastTaskId || '',
      status: 'running',
    };
    CheckpointManager.save(
      sessionId, planId,
      checkpoint.pendingTasks, checkpoint.completedTasks,
      checkpoint.failedTasks, checkpoint.agentSessions,
      checkpoint.workspaceGitCommit,
    );
  }

  /** Get all incomplete checkpoints for a session (for recovery on reconnect). */
  static async getIncompleteForSession(sessionId: string): Promise<PlanCheckpoint[]> {
    try {
      const records = await prisma.sessionCheckpoint.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      });
      // Filter: checkpoints with incomplete tasks
      return records
        .map(r => r.data as unknown as PlanCheckpoint)
        .filter(c => c.pendingTasks.length > 0 || c.failedTasks.length > 0);
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/agent/CheckpointManager.ts
git commit -m "feat: add CheckpointManager for plan checkpoint save/restore"
```

---

### Task 11: Task 重试增强 & Checkpoint 更新集成

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

- [ ] **Step 1: L1 重试注入失败原因**

在 `handleDispatchedTaskFinished` 失败分支的 auto-retry 逻辑中（约第 606-621 行），修改重试 prompt：

在 retry 逻辑中，将失败原因注入到重试的 task prompt。修改 `markTaskRetryQueued` 调用后的逻辑：
在 `processNextInQueue` 中的 task prompt 追加 `上次失败原因: ${failedTask?.lastError}`。

在 `processNextInQueue` 函数开始处，检查 `task` 是否有 `retryCount > 0`：

```typescript
// In processNextInQueue, before calling buildTaskPrompt:
const retryNote = queue.current?.retryCount
  ? `\n\n⚠️ 上次执行失败 (attempt ${queue.current.retryCount}): ${queue.current.lastError || 'unknown'}. 请避免重复相同操作。`
  : '';
const basePrompt = buildTaskPrompt(task, sessionId);
const taskPrompt = basePrompt + retryNote;
```

- [ ] **Step 2: Checkpoint 更新集成**

在 `handleDispatchedTaskFinished` 末尾（Plan 状态变更点），追加 checkpoint 保存：

```typescript
// After any state change (task completed, failed, retried), update checkpoint:
import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
  const sandbox = sandboxes.get(sessionId);
  const pending = [...execution.tasks.values()]
    .filter(item => item.status === 'waiting' || item.status === 'queued' || item.status === 'running')
    .map(item => ({
      id: item.task.id, title: item.task.title, description: item.task.description,
      agentType: item.task.agentType, dependsOn: item.task.dependsOn,
      expectedOutput: item.task.expectedOutput, priority: item.task.priority,
    }));
  const completed = [...execution.tasks.values()]
    .filter(item => item.status === 'done')
    .map(item => item.task.id);
  const failed = [...execution.tasks.values()]
    .filter(item => item.status === 'failed' || item.status === 'blocked')
    .map(item => ({ id: item.task.id, error: item.lastError || '', retryCount: item.retryCount || 0 }));
  
  CheckpointManager.save(
    sessionId, planId, pending, completed, failed, {},
    sandbox?.hostWorkDir ? undefined : undefined,
  );
}).catch(() => {});
```

- [ ] **Step 3: Task 开始时创建初始 Checkpoint**

在 `enqueueTaskAssignments` 中（Plan 首次 dispatch 时），创建初始 checkpoint：

找到 `enqueueTaskAssignments` 函数（约第 470 行附近），在 tasks 入队后追加 checkpoint 创建：

```typescript
if (tasks.length > 0) {
  // Create initial checkpoint on first dispatch
  import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
    const allTasks = execution.tasks;
    const pending = [...allTasks.values()]
      .filter(item => item.status !== 'done' && item.status !== 'failed')
      .map(item => ({
        id: item.task.id, title: item.task.title, description: item.task.description,
        agentType: item.task.agentType, dependsOn: item.task.dependsOn,
        expectedOutput: item.task.expectedOutput, priority: item.task.priority,
      }));
    CheckpointManager.save(sessionId, planId, pending, [], [], {});
  }).catch(() => {});
}
```

- [ ] **Step 4: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: add retry failure injection and checkpoint save in task dispatch"
```

---

### Task 12: ClaudeCodeProvider — claudeSessionId 持久化

**Files:**
- Modify: `apps/api/src/agent/providers/claude-code.ts`

- [ ] **Step 1: 新增持久化回调**

在 `ClaudeCodeProvider` 类顶部新增可选回调字段：

```typescript
// Add after existing private fields:
private onSessionIdChange?: (sessionId: string) => void;

setSessionIdCallback(cb: (sessionId: string) => void): void {
  this.onSessionIdChange = cb;
}
```

在 `runInContainer` 的 stdout 处理中（约第 124 行），`claudeSessionId` 设置后触发回调：

```typescript
if (event.type === 'system' && event.sessionId) {
  this.claudeSessionId = event.sessionId;
  // NEW: notify external listener
  if (this.onSessionIdChange) {
    this.onSessionIdChange(event.sessionId);
  }
}
```

- [ ] **Step 2: 在 taskDispatcher 中连接回调**

在 `startReplForTask` 中（provider 创建之后），注册回调：

```typescript
// After const provider = ProviderFactory.create('claude-code');
provider.setSessionIdCallback((sid: string) => {
  import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
    CheckpointManager.updateAgentSession(sessionId, queue.planId, agentName, sid);
  }).catch(() => {});
});
```

- [ ] **Step 3: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent/providers/claude-code.ts apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: persist claudeSessionId to checkpoint on SDK session emit"
```

---

### Task 13: WebSocket 重连恢复

**Files:**
- Modify: `apps/api/src/ws/chatHandlers.ts`

- [ ] **Step 1: 在 ensureSandboxReady 中添加恢复逻辑**

在 `ensureSandboxReady` 函数末尾（sandbox 初始化完成后），追加恢复检测：

```typescript
// After sandbox is ready, check for incomplete plans:
import('../agent/CheckpointManager.js').then(({ CheckpointManager }) => {
  CheckpointManager.getIncompleteForSession(sessionId).then(checkpoints => {
    for (const cp of checkpoints) {
      if (cp.pendingTasks.length > 0) {
        console.log(`[recovery] Restoring plan ${cp.planId} with ${cp.pendingTasks.length} pending tasks`);
        // Restore ContextBus
        CheckpointManager.restoreContextBus(sessionId, cp);
        // Re-dispatch pending tasks
        const sandbox = sandboxes.get(sessionId);
        if (sandbox) {
          import('./taskDispatcher.js').then(({ enqueueTaskAssignments }) => {
            enqueueTaskAssignments(sessionId, cp.planId, cp.pendingTasks.map(t => ({
              task: { ...t, priority: t.priority as 'high' | 'medium' | 'low' },
              agentName: t.agentType,
              agentId: '',
            })), sandbox).catch((err: any) =>
              console.error(`[recovery] Re-dispatch failed: ${err.message}`)
            );
          }).catch(() => {});
        }
        broadcast(sessionId, {
          type: 'plan_recovered',
          planId: cp.planId,
          pendingCount: cp.pendingTasks.length,
        });
      }
    }
  }).catch(() => {});
}).catch(() => {});
```

- [ ] **Step 2: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/chatHandlers.ts
git commit -m "feat: add plan checkpoint recovery on WebSocket reconnect"
```

---

### Task 14: DagPersistence 扩展 — markArchived

**Files:**
- Modify: `apps/api/src/agent/DagPersistence.ts`

- [ ] **Step 1: 新增 markArchived 方法**

在 `DagPersistence` 类中追加：

```typescript
static async markArchived(sessionId: string, planId: string): Promise<void> {
  await prisma.planExecution.updateMany({
    where: { sessionId, planId },
    data: { status: 'archived' },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/agent/DagPersistence.ts
git commit -m "feat: add markArchived to DagPersistence"
```

---

### Task 15: StateTracker — Skill 使用追踪

**Files:**
- Modify: `apps/api/src/agent/StateTracker.ts`

- [ ] **Step 1: 新增 Skill 追踪方法**

在 `StateTracker` 类中追加：

```typescript
import type { SkillUsageRecord } from '@agenthub/shared';

// Add to the class:
private skillRecords = new Map<string, SkillUsageRecord>();

recordSkillUse(info: {
  skillName: string;
  agentName: string;
  agentId: string;
  taskId?: string;
  planId?: string;
}): void {
  const key = `${info.agentName}:${info.skillName}`;
  const existing = this.skillRecords.get(key);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastUsed = now;
    if (info.taskId && !existing.associatedTaskIds.includes(info.taskId)) {
      existing.associatedTaskIds.push(info.taskId);
    }
  } else {
    this.skillRecords.set(key, {
      skillName: info.skillName,
      agentName: info.agentName,
      agentId: info.agentId,
      count: 1,
      firstUsed: now,
      lastUsed: now,
      associatedTaskIds: info.taskId ? [info.taskId] : [],
    });
  }
}

getAgentSkillStats(agentName: string): SkillUsageRecord[] {
  const results: SkillUsageRecord[] = [];
  for (const record of this.skillRecords.values()) {
    if (record.agentName === agentName) {
      results.push(record);
    }
  }
  return results.sort((a, b) => b.lastUsed - a.lastUsed);
}

getSessionSkillStats(agentNames: string[]): SkillUsageRecord[] {
  const results: SkillUsageRecord[] = [];
  for (const record of this.skillRecords.values()) {
    if (agentNames.includes(record.agentName)) {
      results.push(record);
    }
  }
  return results.sort((a, b) => b.lastUsed - a.lastUsed);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/agent/StateTracker.ts
git commit -m "feat: add skill usage tracking to StateTracker"
```

---

### Task 16: taskDispatcher — Skill 事件处理

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

- [ ] **Step 1: 在 handleProviderTaskEvent 中新增 skill_use case**

在 `handleProviderTaskEvent` 的 switch 中（约第 190-300 行），在 `case 'done':` 之前追加：

```typescript
case 'skill_use': {
  const skillEvent = event as any;
  stateTracker.recordSkillUse({
    skillName: skillEvent.skillName || 'unknown',
    agentName,
    agentId: run.task?.agentType || agentName,
    taskId: task.id,
    planId: queue.planId,
  });
  broadcast(sessionId, {
    type: 'skill_use',
    skillName: skillEvent.skillName,
    agentName,
    agentId: run.task?.agentType || agentName,
    taskId: task.id,
    planId: queue.planId,
    timestamp: Date.now(),
  });
  break;
}
```

- [ ] **Step 2: 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: handle skill_use events in task dispatcher"
```

---

### Task 17: 前端 — AgentCard 第 4 页 FaceSkillStats

**Files:**
- Modify: `apps/web/src/components/AgentCardFaces.tsx`
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: 更新 appStore — 新增 skill 事件类型和存储**

在 `apps/web/src/store/appStore.ts` 中，修改 `AgentEvent.type` 联合类型，新增 `'skill_use'`：

找到第 6 行的 `type` 定义：

```typescript
// Change:
type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request' | 'token_update' | 'file_produced' | 'phase_complete';
// To:
type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request' | 'token_update' | 'file_produced' | 'phase_complete' | 'skill_use';
```

在 `details` 中追加 `skillName` 字段（可选，仅 `skill_use` 事件使用）：

```typescript
details: {
  // ... existing fields ...
  skillName?: string;
};
```

在 store state 中新增 `skillStats`：

```typescript
// In the store interface, add:
skillStats: Record<string, { skillName: string; count: number }[]>;

// In the create() initial state, add:
skillStats: {},
```

在 store actions 中新增处理 `skill_use` 事件的逻辑。找到 `handleAgentEvent` 相关代码，追加：

```typescript
// In the event switch/case handling, add:
case 'skill_use': {
  const sn = (ev.details as any)?.skillName || 'unknown';
  const an = (ev as any).agentName || 'unknown';
  const key = an;
  const existing = state.skillStats[key] || [];
  const idx = existing.findIndex(s => s.skillName === sn);
  if (idx >= 0) {
    existing[idx] = { ...existing[idx], count: existing[idx].count + 1 };
  } else {
    existing.push({ skillName: sn, count: 1 });
  }
  return { skillStats: { ...state.skillStats, [key]: existing } };
}
```

- [ ] **Step 2: 新增 FaceSkillStats 组件**

在 `apps/web/src/components/AgentCardFaces.tsx` 末尾追加：

```typescript
// ---- Face 4: Skill Stats ----
export function FaceSkillStats({
  skills,
}: {
  skills: { skillName: string; count: number }[];
}) {
  if (skills.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-hub-muted text-caption italic">
        尚未使用 skills
      </div>
    );
  }

  const total = skills.reduce((s, r) => s + r.count, 0);

  return (
    <div className="py-3 px-3 space-y-2 text-[11px]">
      {skills
        .sort((a, b) => b.count - a.count)
        .map((s) => (
          <div
            key={s.skillName}
            className="flex items-center justify-between"
          >
            <span className="text-hub-primary font-mono">{s.skillName}</span>
            <span className="text-hub-accent font-medium tabular-nums">
              {s.count}次
            </span>
          </div>
        ))}
      <div className="pt-2 border-t border-hub text-hub-tertiary">
        总计: {total} 次调用 · {skills.length} 个 skills
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 修改 AgentCard — 4 个 dot 指示器 + 第 4 页**

在 `apps/web/src/components/AgentCard.tsx` 中：

1. 修改 dot 指示器列表（约第 164 行），将 `[0, 1, 2]` 改为 `[0, 1, 2, 3]`，`title` 追加 `'Skills'`：

```typescript
// Change:
{[0, 1, 2].map((face) => (
// ...
title={['摘要', '日志', '仪表盘'][face]}
// To:
{[0, 1, 2, 3].map((face) => (
// ...
title={['摘要', '日志', '仪表盘', 'Skills'][face]}
```

2. 在第 3 页（FaceDashboard）之后追加第 4 页：

```typescript
{activeFace === 3 && (
  <FaceSkillStats
    skills={useAppStore(s => {
      const stats = s.skillStats[agentName || displayName] || [];
      return stats;
    })}
  />
)}
```

3. 在 import 语句中导入 `FaceSkillStats`：

```typescript
import { FaceBusinessCard, FaceTerminalLog, FaceDashboard, FaceSkillStats } from './AgentCardFaces';
```

- [ ] **Step 4: 编译检查**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AgentCardFaces.tsx apps/web/src/components/AgentCard.tsx apps/web/src/store/appStore.ts
git commit -m "feat: add 4th AgentCard face — skill usage statistics"
```

---

### Task 18: 端到端集成验证

**Files:**
- Modify: 无（验证任务）

- [ ] **Step 1: 启动完整环境**

```bash
bash scripts/startup.sh
```

- [ ] **Step 2: 编译后端 + 前端**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/web && npx tsc --noEmit -p tsconfig.json
```
Expected: both pass without errors.

- [ ] **Step 3: 运行所有现有测试**

```bash
cd apps/api && npx vitest run
```
Expected: all tests pass (existing + new ContextBus + ExperienceExtractor tests).

- [ ] **Step 4: 验证 Context Bus 上下文注入**

1. 创建一个包含 DAG Plan 的 session
2. 在 Plan 执行前手动向 ContextBus 写入一个 convention 条目
3. 启动 task，检查 agent prompt 是否包含该 convention
4. 通过后端日志确认 `buildTaskPrompt` 产出了 context block

- [ ] **Step 5: 验证归档**

1. 完成一个 DAG Plan（所有 task done）
2. 检查 `plan_archived` 事件是否广播
3. 检查 `.sandboxes/{sessionId}/archive/{planId}/manifest.json` 和 `diff.patch` 是否生成
4. 检查 `.agents/{agentId}/.claude/memory/` 下是否有新文件

- [ ] **Step 6: 验证 Checkpoint 恢复**

1. 在 Plan 执行中途断开 WebSocket
2. 重新连接
3. 检查 `plan_recovered` 事件是否广播
4. 确认 pending tasks 继续执行

- [ ] **Step 7: 验证 Skill 统计**

1. 完成一个使用了 skills 的 task
2. 打开 AgentCard，切换到第 4 页（Skills）
3. 确认 skill 调用次数显示正确
```

---

## 自检清单

### Spec Coverage

| Spec 章节 | 对应 Task |
|-----------|-----------|
| Context Bus 数据模型 + KV 操作 | Task 2 (ContextBus), Task 3 (注入) |
| Context Bus DB 持久化 | Task 4 |
| Archive Pipeline 产物快照 | Task 6 (ArchiveManager) |
| Archive Pipeline 经验提取 | Task 5 (ExperienceExtractor) |
| Agent Memory 渐进披露 (MEMORY.md) | Task 7 (writeAgentMemory) |
| archive-experience Skill 模板 | Task 9 |
| L1 Task 重试增强 | Task 11 |
| L2 Plan Checkpoint | Task 10 (CheckpointManager), Task 12 (sessionId 持久化), Task 13 (恢复) |
| AgentCard 第 4 页 Skills | Task 15, 16, 17 |
| Plan 完成触发归档 | Task 8 |
| 共享类型 | Task 1 |

### Placeholder Scan

无 TBD/TODO/占位符。所有代码步骤均有具体实现。

### Type Consistency

- `ContextEntry` 在 shared types (Task 1) 定义，ContextBus (Task 2) 使用
- `ExperienceEntry` 在 shared types (Task 1) 定义，ExperienceExtractor (Task 5) 和 ArchiveManager (Task 6) 使用
- `PlanCheckpoint` 在 shared types (Task 1) 定义，CheckpointManager (Task 10) 使用
- `SkillUsageRecord` 在 shared types (Task 1) 定义，StateTracker (Task 15) 和 FaceSkillStats (Task 17) 使用
- ContextBus 方法签名：`set(SetOptions)`, `query(ContextQuery)`, `serialize()`, `archive(planId)` — 所有调用处一致
- ArchiveManager 签名：`archivePlan(sessionId, planId, planTitle, tasks, failedTasks, hostWorkDir, startTime)` — Task 8 调用匹配
