# ContextBus 上下文管理 + 消息置顶 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ContextBus 增加智能上下文管理（token 计数、权重排序、压缩），并实现消息置顶功能（UI 书签 + agent prompt 自动注入）。

**Architecture:** ContextBus 重构为基于 token 预算的加权淘汰系统。PinnedStore 独立于 ContextBus，存储在 DB，通过 buildTaskPrompt 注入 agent prompt。前端新增 Pinned tab 面板。

**Tech Stack:** TypeScript, Prisma, Hono, React, Zustand, Tailwind CSS

---

## File Structure

### Backend (apps/api)

| File | Action | Responsibility |
|------|--------|----------------|
| `prisma/schema.prisma` | Modify | 新增 PinnedMessage 模型，Session 加 pinnedMessages 关系 |
| `src/agent/ContextBus.ts` | Refactor | estimateTokens、权重排序、getProjectDigest 重构、getRelevantExperience token 限制 |
| `src/agent/PinnedStore.ts` | Create | 置顶消息 CRUD + buildInjectionPrompt |
| `src/config.ts` | Modify | RuntimeAgentConfig 新增 contextTokenBudget |
| `src/routes/settings.ts` | Modify | 新增 contextTokenBudget 设置项 |
| `src/routes/pinned.ts` | Create | 置顶消息 REST API |
| `src/ws/taskDispatcher.ts` | Modify | buildTaskPrompt 集成 PinnedStore |

### Frontend (apps/web)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/api.ts` | Modify | 新增 pinned API 调用 |
| `src/components/PinnedPanel.tsx` | Create | 置顶消息面板 |
| `src/components/PinnedPinMenu.tsx` | Create | Pin 下拉菜单（消息/文件/文本） |
| `src/components/MessageActions.tsx` | Modify | 新增 Pin 按钮 |
| `src/components/ChatView.tsx` | Modify | 新增 Pinned tab |
| `src/components/RuntimeConfigForm.tsx` | Modify | 新增 contextTokenBudget 输入框 |

### Shared (packages/shared)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | 新增 PinnedMessage 接口 |

---

## Phase 1: ContextBus 上下文管理

### Task 1: Token 估算函数 + ContextEntry 类型扩展

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `apps/api/src/agent/ContextBus.ts`

- [ ] **Step 1: 在 shared types 中新增 estimateTokens 函数**

在 `packages/shared/src/types.ts` 的 ContextBus 区域新增：

```typescript
/**
 * Estimate token count for mixed CJK/English text.
 * CJK chars ~1.5 tokens, English words ~1.3 tokens, other chars ~0.5 tokens.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[a-zA-Z]+/g) || []).length;
  const other = text.length - cjk - (text.match(/[a-zA-Z]/g) || []).length;
  return Math.ceil(cjk * 1.5 + words * 1.3 + other * 0.5);
}
```

- [ ] **Step 2: 在 ContextEntry 上新增 _refCount 内存字段**

在 `packages/shared/src/types.ts` 的 `ContextEntry` 接口中新增：

```typescript
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
  /** In-memory reference count for weight calculation. Not persisted. */
  _refCount?: number;
}
```

- [ ] **Step 3: 在 ContextBus.ts 中导入 estimateTokens 并新增 calcWeight 方法**

在 `apps/api/src/agent/ContextBus.ts` 顶部导入：

```typescript
import type { ContextEntry, ContextEntryType, ContextEntryStatus } from '@agenthub/shared';
import { estimateTokens } from '@agenthub/shared';
```

在 ContextBus 类中新增私有方法：

```typescript
/** Calculate priority weight for an entry. */
private calcWeight(e: ContextEntry): number {
  const typeScores: Record<string, number> = {
    'convention': 100, 'decision': 80, 'known-issue': 70,
    'dependency-map': 60, 'task-handoff': 50, 'project-fact': 40, 'artifact': 20,
  };
  const baseScore = typeScores[e.type] ?? 0;
  const ageHours = (Date.now() - e.updatedAt) / (1000 * 60 * 60);
  const decayFactor = Math.max(0, 1 - ageHours / 168); // 7-day linear decay
  const refBonus = (e._refCount ?? 0) * 10;
  return baseScore * decayFactor + refBonus;
}
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p apps/api/tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts apps/api/src/agent/ContextBus.ts
git commit -m "feat: add estimateTokens function and ContextEntry._refCount field"
```

---

### Task 2: getProjectDigest 重构（权重排序 + token 预算）

**Files:**
- Modify: `apps/api/src/agent/ContextBus.ts`

- [ ] **Step 1: 重写 getProjectDigest 方法**

将 `apps/api/src/agent/ContextBus.ts` 中的 `getProjectDigest` 方法替换为：

```typescript
getProjectDigest(maxTokens: number): string {
  const active = this.query({ status: 'active' });
  if (active.length === 0) return '';

  // Sort by weight descending
  const weighted = active
    .map(e => ({ entry: e, weight: this.calcWeight(e) }))
    .sort((a, b) => b.weight - a.weight);

  let digest = '## Project State\n\n';
  let remainingTokens = maxTokens - estimateTokens(digest);

  for (const { entry } of weighted) {
    const valStr = typeof entry.value === 'string'
      ? entry.value.slice(0, 200)
      : JSON.stringify(entry.value).slice(0, 200);
    const line = `- [${entry.type}] **${entry.key}**: ${valStr}\n`;
    const lineTokens = estimateTokens(line);

    if (lineTokens > remainingTokens) {
      // Level 1 compression: try truncated value
      const maxValChars = Math.floor((remainingTokens - 20) / 1.5); // rough estimate
      if (maxValChars > 20) {
        const truncated = valStr.slice(0, maxValChars) + '...';
        digest += `- [${entry.type}] **${entry.key}**: ${truncated}\n`;
      }
      break;
    }

    digest += line;
    remainingTokens -= lineTokens;
  }

  return digest;
}
```

- [ ] **Step 2: 重写 getRelevantExperience 方法（增加 token 预算参数）**

将 `getRelevantExperience` 替换为：

```typescript
getRelevantExperience(agentType: string, taskDescription: string, maxTokens = 400): string {
  const normalizedType = agentType.toLowerCase();
  const experiences = this.query({ status: 'active' }).filter(e =>
    e.type === 'known-issue' || e.type === 'convention'
  );

  if (experiences.length === 0) return '';

  // Match by agent type tag
  let relevant = experiences.filter(e =>
    e.tags.some(t => t.toLowerCase() === normalizedType)
  );

  // Match by keyword
  const taskWords = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const keywordMatches = experiences.filter(e =>
    !relevant.includes(e) &&
    e.tags.some(t => taskWords.some(w => t.toLowerCase().includes(w) || w.includes(t.toLowerCase())))
  );
  relevant = [...relevant, ...keywordMatches.slice(0, 3)];

  if (relevant.length === 0) return '';

  // Increment refCount for matched entries
  for (const e of relevant) {
    e._refCount = (e._refCount ?? 0) + 1;
  }

  let result = '\n## Relevant Experience\n\n';
  let remainingTokens = maxTokens - estimateTokens(result);

  for (const e of relevant.slice(0, 5)) {
    const label = typeof e.value === 'string'
      ? e.value.slice(0, 150)
      : JSON.stringify(e.value).slice(0, 150);
    const line = `- [${e.type}] ${e.key}: ${label}\n`;
    const lineTokens = estimateTokens(line);
    if (lineTokens > remainingTokens) break;
    result += line;
    remainingTokens -= lineTokens;
  }

  return result;
}
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent/ContextBus.ts
git commit -m "feat: refactor getProjectDigest with weight-based sorting and token budget"
```

---

### Task 3: 生命周期管理（stale 状态 + gc 增强）

**Files:**
- Modify: `apps/api/src/agent/ContextBus.ts`

- [ ] **Step 1: 增强 gc 方法支持 stale 转换**

在 ContextBus 类中新增 `markStale` 方法，并增强 `gc`：

```typescript
/** Mark entries older than staleHours as 'stale'. */
markStale(staleHours = 168): number {
  const cutoff = Date.now() - staleHours * 60 * 60 * 1000;
  let marked = 0;
  for (const [key, entry] of this.store) {
    if (entry.status === 'active' && entry.updatedAt < cutoff) {
      entry.status = 'stale' as any;
      marked++;
    }
  }
  return marked;
}

/** Enhanced GC: remove stale entries older than staleGcDays, resolved older than resolvedGcDays. */
gc(staleGcDays = 30, resolvedGcDays = 7): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of this.store) {
    const ageMs = now - entry.updatedAt;
    if (entry.status === 'stale' && ageMs > staleGcDays * 24 * 60 * 60 * 1000) {
      this.store.delete(key);
      this.newKeys.delete(key);
      removed++;
    } else if (entry.status === 'resolved' && ageMs > resolvedGcDays * 24 * 60 * 60 * 1000) {
      this.store.delete(key);
      this.newKeys.delete(key);
      removed++;
    }
  }
  return removed;
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/ContextBus.ts
git commit -m "feat: add lifecycle management with stale status and enhanced GC"
```

---

### Task 4: contextTokenBudget 设置集成

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/routes/settings.ts`
- Modify: `apps/web/src/components/RuntimeConfigForm.tsx`

- [ ] **Step 1: 在 RuntimeAgentConfig 中新增 contextTokenBudget**

在 `apps/api/src/config.ts` 的 `RuntimeAgentConfig` 类中：

新增私有字段（在 `_perSessionMax` 之后）：
```typescript
private _contextTokenBudget: number;
```

在 constructor 中新增：
```typescript
this._contextTokenBudget = optionalInt('CONTEXT_TOKEN_BUDGET', 10_000);
```

在 `loadPersisted` 的 `findMany` where 条件中新增 `'contextTokenBudget'`：
```typescript
where: { key: { in: ['maxConcurrent', 'timeoutMs', 'queueTimeoutMs', 'perSessionMax', 'contextTokenBudget'] } },
```

新增 setter：
```typescript
async setContextTokenBudget(prisma: any, v: number) {
  if (v >= 2000 && v <= 50000) { this._contextTokenBudget = v; await this.persist(prisma, 'contextTokenBudget', v); }
}
```

新增 getter/setter：
```typescript
get contextTokenBudget(): number { return this._contextTokenBudget; }
set contextTokenBudget(v: number) {
  if (v >= 2000 && v <= 50000) this._contextTokenBudget = v;
}
```

在 `toJSON()` 中新增：
```typescript
contextTokenBudget: this._contextTokenBudget,
```

在 `config.agent` getter 区新增：
```typescript
get contextTokenBudget() { return runtimeConfig.agent.contextTokenBudget; },
```

- [ ] **Step 2: 在 settings API 中新增 contextTokenBudget**

在 `apps/api/src/routes/settings.ts` 的 `updateRuntimeSchema` 中新增：
```typescript
contextTokenBudget: z.number().int().min(2000).max(50000).optional(),
```

在 PUT handler 中新增：
```typescript
if (parsed.data.contextTokenBudget !== undefined) {
  await runtimeConfig.agent.setContextTokenBudget(prisma, parsed.data.contextTokenBudget);
}
```

- [ ] **Step 3: 在前端 RuntimeConfigForm 中新增输入框**

在 `apps/web/src/components/RuntimeConfigForm.tsx` 的 `FIELDS` 数组中新增：
```typescript
{
  key: 'contextTokenBudget',
  label: 'Context Token Budget',
  min: 2000,
  max: 50000,
  hint: 'Total token budget for context injection (pinned + state + experience)',
},
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/routes/settings.ts apps/web/src/components/RuntimeConfigForm.tsx
git commit -m "feat: add contextTokenBudget runtime config setting"
```

---

## Phase 2: PinnedStore 后端

### Task 5: Prisma Schema + Migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: 新增 PinnedMessage 模型**

在 `apps/api/prisma/schema.prisma` 的 `SessionCheckpoint` 模型之后新增：

```prisma
model PinnedMessage {
  id              String   @id @default(uuid())
  sessionId       String
  sourceType      String   @default("message") // message | file | text
  sourceMessageId String?
  filePath        String?
  content         String
  title           String?
  injectToAgent   Boolean  @default(true)
  sortOrder       Int      @default(0)
  session         Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([sessionId])
}
```

- [ ] **Step 2: 在 Session 模型中新增 pinnedMessages 关系**

在 `apps/api/prisma/schema.prisma` 的 Session 模型中，在 `quoteReferences` 之后新增：
```prisma
  pinnedMessages     PinnedMessage[]
```

- [ ] **Step 3: 运行 Prisma migration**

Run: `cd apps/api && npx prisma migrate dev --name add-pinned-message`

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/
git commit -m "feat: add PinnedMessage Prisma model"
```

---

### Task 6: PinnedStore 模块

**Files:**
- Create: `apps/api/src/agent/PinnedStore.ts`

- [ ] **Step 1: 创建 PinnedStore.ts**

创建 `apps/api/src/agent/PinnedStore.ts`：

```typescript
import { prisma } from '../db/prisma.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { estimateTokens } from '@agenthub/shared';

export interface PinnedMessageData {
  id: string;
  sessionId: string;
  sourceType: string;
  sourceMessageId: string | null;
  filePath: string | null;
  content: string;
  title: string | null;
  injectToAgent: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export class PinnedStore {
  static async add(
    sessionId: string,
    sourceType: 'message' | 'file' | 'text',
    content: string,
    options?: { sourceMessageId?: string; filePath?: string; title?: string; injectToAgent?: boolean },
  ): Promise<PinnedMessageData> {
    // Determine max sortOrder
    const maxOrder = await prisma.pinnedMessage.aggregate({
      where: { sessionId },
      _max: { sortOrder: true },
    });
    const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;

    return prisma.pinnedMessage.create({
      data: {
        sessionId,
        sourceType,
        content,
        sourceMessageId: options?.sourceMessageId ?? null,
        filePath: options?.filePath ?? null,
        title: options?.title ?? null,
        injectToAgent: options?.injectToAgent ?? true,
        sortOrder: nextOrder,
      },
    });
  }

  static async remove(sessionId: string, pinnedId: string): Promise<void> {
    await prisma.pinnedMessage.deleteMany({
      where: { id: pinnedId, sessionId },
    });
  }

  static async list(sessionId: string): Promise<PinnedMessageData[]> {
    return prisma.pinnedMessage.findMany({
      where: { sessionId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  static async update(
    sessionId: string,
    pinnedId: string,
    data: { injectToAgent?: boolean; sortOrder?: number; title?: string },
  ): Promise<PinnedMessageData | null> {
    const existing = await prisma.pinnedMessage.findFirst({
      where: { id: pinnedId, sessionId },
    });
    if (!existing) return null;

    return prisma.pinnedMessage.update({
      where: { id: pinnedId },
      data,
    });
  }

  static async reorder(sessionId: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      await prisma.pinnedMessage.updateMany({
        where: { id: ids[i], sessionId },
        data: { sortOrder: i },
      });
    }
  }

  static async pinFromMessage(sessionId: string, messageId: string): Promise<PinnedMessageData | null> {
    const message = await prisma.message.findFirst({
      where: { id: messageId, sessionId },
    });
    if (!message) return null;

    const content = message.content.slice(0, 2000);
    const title = content.slice(0, 80).split('\n')[0];

    return PinnedStore.add(sessionId, 'message', content, {
      sourceMessageId: messageId,
      title,
    });
  }

  static async pinFromFile(sessionId: string, filePath: string, hostWorkDir?: string): Promise<PinnedMessageData | null> {
    // Store the path reference; content will be read at injection time
    return PinnedStore.add(sessionId, 'file', filePath, {
      filePath,
      title: filePath.split('/').pop() ?? filePath,
    });
  }

  /**
   * Build the pinned context injection prompt for an agent.
   * Reads file content at injection time for file-type pins.
   */
  static async buildInjectionPrompt(sessionId: string, maxTokens: number, hostWorkDir?: string): Promise<string> {
    const pinned = await PinnedStore.list(sessionId);
    const injectable = pinned.filter(p => p.injectToAgent);
    if (injectable.length === 0) return '';

    let result = '## Pinned Context (用户置顶)\n';
    let remainingTokens = maxTokens - estimateTokens(result);

    for (const pin of injectable) {
      let line: string;

      if (pin.sourceType === 'file' && pin.filePath) {
        // Read file content at injection time
        let fileContent = '';
        if (hostWorkDir) {
          const fullPath = resolve(hostWorkDir, pin.filePath.replace(/^\/workspace\/?/, ''));
          if (existsSync(fullPath)) {
            try {
              fileContent = readFileSync(fullPath, 'utf-8').slice(0, 200);
            } catch {
              fileContent = '(read error)';
            }
          } else {
            fileContent = '(file not found)';
          }
        }
        line = `- [PINNED] ${pin.filePath} — ${fileContent}\n`;
      } else if (pin.sourceType === 'message') {
        const preview = pin.content.slice(0, 150).replace(/\n/g, ' ');
        line = `- [PINNED] ${pin.title ?? 'Message'}: ${preview}\n`;
      } else {
        // text type
        const preview = pin.content.slice(0, 150).replace(/\n/g, ' ');
        line = `- [PINNED] ${pin.title ?? 'Note'}: ${preview}\n`;
      }

      const lineTokens = estimateTokens(line);
      if (lineTokens > remainingTokens) break;
      result += line;
      remainingTokens -= lineTokens;
    }

    return result;
  }
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/PinnedStore.ts
git commit -m "feat: add PinnedStore module with CRUD and injection prompt builder"
```

---

### Task 7: Pinned Messages REST API

**Files:**
- Create: `apps/api/src/routes/pinned.ts`
- Modify: `apps/api/src/index.ts` (register route)

- [ ] **Step 1: 创建 pinned.ts 路由**

创建 `apps/api/src/routes/pinned.ts`：

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { getUser } from '../lib/auth.js';
import { PinnedStore } from '../agent/PinnedStore.js';
import { broadcast } from '../ws/state.js';

const pinned = new Hono();

// GET /api/sessions/:sessionId/pinned
pinned.get('/:sessionId/pinned', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const sessionId = c.req.param('sessionId');
  const items = await PinnedStore.list(sessionId);
  return c.json(items);
});

// POST /api/sessions/:sessionId/pinned
const createSchema = z.object({
  sourceType: z.enum(['message', 'file', 'text']),
  content: z.string().min(1),
  sourceMessageId: z.string().optional(),
  filePath: z.string().optional(),
  title: z.string().optional(),
  injectToAgent: z.boolean().optional(),
});

pinned.post('/:sessionId/pinned', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const sessionId = c.req.param('sessionId');
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const item = await PinnedStore.add(sessionId, parsed.data.sourceType, parsed.data.content, {
    sourceMessageId: parsed.data.sourceMessageId,
    filePath: parsed.data.filePath,
    title: parsed.data.title,
    injectToAgent: parsed.data.injectToAgent,
  });
  broadcast(sessionId, { type: 'pinned_added', sessionId, pinned: item });
  return c.json(item, 201);
});

// DELETE /api/sessions/:sessionId/pinned/:id
pinned.delete('/:sessionId/pinned/:id', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const sessionId = c.req.param('sessionId');
  const id = c.req.param('id');
  await PinnedStore.remove(sessionId, id);
  broadcast(sessionId, { type: 'pinned_removed', sessionId, pinnedId: id });
  return c.json({ ok: true });
});

// PATCH /api/sessions/:sessionId/pinned/:id
const updateSchema = z.object({
  injectToAgent: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  title: z.string().optional(),
});

pinned.patch('/:sessionId/pinned/:id', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const sessionId = c.req.param('sessionId');
  const id = c.req.param('id');
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const item = await PinnedStore.update(sessionId, id, parsed.data);
  if (!item) return c.json({ error: 'Not found' }, 404);
  broadcast(sessionId, { type: 'pinned_updated', sessionId, pinned: item });
  return c.json(item);
});

// PATCH /api/sessions/:sessionId/pinned/reorder
const reorderSchema = z.object({
  ids: z.array(z.string()),
});

pinned.patch('/:sessionId/pinned/reorder', async (c) => {
  const result = await getUser(c);
  if (result instanceof Response) return result;
  const sessionId = c.req.param('sessionId');
  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  await PinnedStore.reorder(sessionId, parsed.data.ids);
  return c.json({ ok: true });
});

export default pinned;
```

- [ ] **Step 2: 注册路由到 index.ts**

在 `apps/api/src/index.ts` 中导入并注册 pinned 路由。找到 settings 路由注册的位置，在其附近新增：

```typescript
import pinnedRoutes from './routes/pinned.js';
// ... 在 app.route('/api', settings) 附近：
app.route('/api/sessions', pinnedRoutes);
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/pinned.ts apps/api/src/index.ts
git commit -m "feat: add pinned messages REST API with WebSocket events"
```

---

### Task 8: buildTaskPrompt 集成 PinnedStore

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

- [ ] **Step 1: 导入 PinnedStore 和 config**

在 `apps/api/src/ws/taskDispatcher.ts` 顶部新增导入：

```typescript
import { PinnedStore } from '../agent/PinnedStore.js';
import { config } from '../config.js';
```

- [ ] **Step 2: 重构 buildTaskPrompt 函数**

将 `buildTaskPrompt` 函数替换为：

```typescript
async function buildTaskPrompt(task: TaskDispatchNode, sessionId?: string): Promise<string> {
  let contextBlock = '';
  if (sessionId) {
    const budget = config.agent.contextTokenBudget;
    const pinnedBudget = Math.floor(budget * 0.4);
    const stateBudget = Math.floor(budget * 0.4);
    const experienceBudget = Math.floor(budget * 0.2);

    const sandbox = sandboxes.get(sessionId);
    const hostWorkDir = sandbox?.hostWorkDir;

    // 1. Pinned context
    const pinnedPrompt = await PinnedStore.buildInjectionPrompt(sessionId, pinnedBudget, hostWorkDir);
    if (pinnedPrompt) contextBlock += pinnedPrompt + '\n';

    // 2. Project state
    const bus = getSessionContextBus(sessionId);
    const digest = bus.getProjectDigest(stateBudget);
    if (digest) contextBlock += digest + '\n';

    // 3. Relevant experience
    const experience = bus.getRelevantExperience(task.agentType, task.description, experienceBudget);
    if (experience) contextBlock += experience + '\n';
  }

  return `${contextBlock}Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}
${task.dependsOn.length > 0 ? `\nDepends on: ${task.dependsOn.join(', ')}\n` : ''}
Execute this task now. Output results to the specified files.`;
}
```

- [ ] **Step 3: 更新所有 buildTaskPrompt 调用为 await**

由于 `buildTaskPrompt` 现在是 async，需要在所有调用处添加 `await`。搜索 `buildTaskPrompt(` 并在调用前加 `await`：

```typescript
// taskDispatcher.ts 中的调用点：
const basePrompt = await buildTaskPrompt(task, sessionId);
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: integrate PinnedStore into buildTaskPrompt with token budget"
```

---

## Phase 3: PinnedStore 前端

### Task 9: Shared Types + API Client

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 在 shared types 中新增 PinnedMessage 接口**

在 `packages/shared/src/types.ts` 中新增：

```typescript
export interface PinnedMessage {
  id: string;
  sessionId: string;
  sourceType: 'message' | 'file' | 'text';
  sourceMessageId: string | null;
  filePath: string | null;
  content: string;
  title: string | null;
  injectToAgent: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: 在 api.ts 中新增 pinned API 调用**

在 `apps/web/src/lib/api.ts` 中新增：

```typescript
// Pinned messages
getPinned: (sessionId: string) =>
  request<PinnedMessage[]>(`/sessions/${sessionId}/pinned`),

createPinned: (sessionId: string, data: {
  sourceType: 'message' | 'file' | 'text';
  content: string;
  sourceMessageId?: string;
  filePath?: string;
  title?: string;
  injectToAgent?: boolean;
}) =>
  request<PinnedMessage>(`/sessions/${sessionId}/pinned`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),

deletePinned: (sessionId: string, id: string) =>
  request<void>(`/sessions/${sessionId}/pinned/${id}`, { method: 'DELETE' }),

updatePinned: (sessionId: string, id: string, data: {
  injectToAgent?: boolean;
  sortOrder?: number;
  title?: string;
}) =>
  request<PinnedMessage>(`/sessions/${sessionId}/pinned/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),
```

确保在文件顶部导入 PinnedMessage 类型（如果需要）。

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json`

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts apps/web/src/lib/api.ts
git commit -m "feat: add PinnedMessage type and frontend API client"
```

---

### Task 10: PinnedPanel 组件

**Files:**
- Create: `apps/web/src/components/PinnedPanel.tsx`

- [ ] **Step 1: 创建 PinnedPanel.tsx**

创建 `apps/web/src/components/PinnedPanel.tsx`：

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Pin, PinOff, FileText, MessageSquare, Type, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../lib/api';
import type { PinnedMessage } from '@agenthub/shared';

interface Props {
  sessionId: string;
  wsPinnedEvents: Array<{ type: string; pinned?: PinnedMessage; pinnedId?: string }>;
}

const SOURCE_ICONS: Record<string, typeof Pin> = {
  message: MessageSquare,
  file: FileText,
  text: Type,
};

const SOURCE_LABELS: Record<string, string> = {
  message: 'Message',
  file: 'File',
  text: 'Text',
};

export function PinnedPanel({ sessionId, wsPinnedEvents }: Props) {
  const [items, setItems] = useState<PinnedMessage[]>([]);
  const [loading, setLoading] = useState(false);

  // Load pinned items on mount
  useEffect(() => {
    setLoading(true);
    api.getPinned(sessionId)
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  // Handle real-time WebSocket events
  useEffect(() => {
    for (const event of wsPinnedEvents) {
      if (event.type === 'pinned_added' && event.pinned) {
        setItems(prev => {
          if (prev.some(p => p.id === event.pinned!.id)) return prev;
          return [...prev, event.pinned!].sort((a, b) => a.sortOrder - b.sortOrder);
        });
      } else if (event.type === 'pinned_removed' && event.pinnedId) {
        setItems(prev => prev.filter(p => p.id !== event.pinnedId));
      } else if (event.type === 'pinned_updated' && event.pinned) {
        setItems(prev => prev.map(p => p.id === event.pinned!.id ? event.pinned! : p));
      }
    }
  }, [wsPinnedEvents]);

  const handleDelete = useCallback(async (id: string) => {
    await api.deletePinned(sessionId, id);
    setItems(prev => prev.filter(p => p.id !== id));
  }, [sessionId]);

  const handleToggleInject = useCallback(async (id: string, current: boolean) => {
    const updated = await api.updatePinned(sessionId, id, { injectToAgent: !current });
    setItems(prev => prev.map(p => p.id === id ? updated : p));
  }, [sessionId]);

  if (loading) {
    return <div className="flex items-center justify-center py-8 text-hub-muted text-[11px]">Loading...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {items.length === 0 ? (
          <div className="text-center text-hub-muted text-xs py-8">
            <Pin className="w-6 h-6 mx-auto mb-2 opacity-30" />
            <p>No pinned messages yet.</p>
            <p className="mt-1 text-[10px]">Use the + Pin button to pin messages, files, or text.</p>
          </div>
        ) : (
          items.map(item => {
            const Icon = SOURCE_ICONS[item.sourceType] ?? Pin;
            return (
              <div key={item.id} className="bg-hub-surface border border-hub rounded-lg p-3 group">
                <div className="flex items-start gap-2">
                  <Icon className="w-3.5 h-3.5 text-hub-accent mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-hub-muted uppercase">{SOURCE_LABELS[item.sourceType]}</span>
                      {item.title && (
                        <span className="text-xs text-hub-primary font-medium truncate">{item.title}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-hub-secondary mt-1 line-clamp-2 whitespace-pre-wrap">
                      {item.sourceType === 'file' ? item.filePath : item.content.slice(0, 150)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={() => handleToggleInject(item.id, item.injectToAgent)}
                      className="p-1 rounded hover:bg-hub-hover"
                      title={item.injectToAgent ? 'Disable agent injection' : 'Enable agent injection'}
                    >
                      {item.injectToAgent ? (
                        <ToggleRight className="w-4 h-4 text-hub-accent" />
                      ) : (
                        <ToggleLeft className="w-4 h-4 text-hub-muted" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="p-1 rounded hover:bg-hub-hover text-hub-danger"
                      title="Remove pin"
                    >
                      <PinOff className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/PinnedPanel.tsx
git commit -m "feat: add PinnedPanel component"
```

---

### Task 11: PinnedPinMenu 组件

**Files:**
- Create: `apps/web/src/components/PinnedPinMenu.tsx`

- [ ] **Step 1: 创建 PinnedPinMenu.tsx**

创建 `apps/web/src/components/PinnedPinMenu.tsx`：

```tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, FileText, Type, Pin } from 'lucide-react';
import { api } from '../lib/api';
import type { Message } from '@agenthub/shared';

interface Props {
  sessionId: string;
  messages: Message[];
  onPinned: () => void;
}

type MenuMode = 'main' | 'message' | 'file' | 'text';

export function PinnedPinMenu({ sessionId, messages, onPinned }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<MenuMode>('main');
  const [searchQuery, setSearchQuery] = useState('');
  const [textContent, setTextContent] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [filePath, setFilePath] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setMode('main');
    setSearchQuery('');
    setTextContent('');
    setTextTitle('');
    setFilePath('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, closeMenu]);

  const handlePinMessage = useCallback(async (msg: Message) => {
    await api.createPinned(sessionId, {
      sourceType: 'message',
      content: msg.content,
      sourceMessageId: msg.id,
      title: msg.content.slice(0, 80).split('\n')[0],
    });
    onPinned();
    closeMenu();
  }, [sessionId, onPinned, closeMenu]);

  const handlePinFile = useCallback(async () => {
    if (!filePath.trim()) return;
    await api.createPinned(sessionId, {
      sourceType: 'file',
      content: filePath.trim(),
      filePath: filePath.trim(),
      title: filePath.trim().split('/').pop() ?? filePath.trim(),
    });
    onPinned();
    closeMenu();
  }, [sessionId, filePath, onPinned, closeMenu]);

  const handlePinText = useCallback(async () => {
    if (!textContent.trim()) return;
    await api.createPinned(sessionId, {
      sourceType: 'text',
      content: textContent.trim(),
      title: textTitle.trim() || textContent.trim().slice(0, 80),
    });
    onPinned();
    closeMenu();
  }, [sessionId, textContent, textTitle, onPinned, closeMenu]);

  const filteredMessages = messages
    .filter(m => m.senderType === 'agent' && m.status === 'done')
    .filter(m => !searchQuery || m.content.toLowerCase().includes(searchQuery.toLowerCase()))
    .slice(-50)
    .reverse();

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-[11px] text-hub-accent hover:bg-hub-hover rounded transition"
        title="Pin message, file, or text"
      >
        <Pin className="w-3 h-3" />
        + Pin
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-hub-surface border border-hub rounded-lg shadow-xl animate-in fade-in zoom-in-95 origin-top-right">
          {mode === 'main' && (
            <div className="py-1">
              <button
                onClick={() => setMode('message')}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Pin Message
              </button>
              <button
                onClick={() => setMode('file')}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
              >
                <FileText className="w-3.5 h-3.5" />
                Pin File
              </button>
              <button
                onClick={() => setMode('text')}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
              >
                <Type className="w-3.5 h-3.5" />
                Pin Text
              </button>
            </div>
          )}

          {mode === 'message' && (
            <div className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <button onClick={() => setMode('main')} className="text-hub-muted hover:text-hub-secondary text-xs">←</button>
                <input
                  type="text"
                  placeholder="Search messages..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="flex-1 bg-hub-raised border border-hub rounded px-2 py-1 text-xs text-hub-primary outline-none focus:border-hub-accent"
                  autoFocus
                />
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {filteredMessages.length === 0 ? (
                  <div className="text-hub-muted text-[10px] text-center py-2">No messages found</div>
                ) : (
                  filteredMessages.map(msg => (
                    <button
                      key={msg.id}
                      onClick={() => handlePinMessage(msg)}
                      className="w-full text-left px-2 py-1.5 text-[11px] text-hub-secondary hover:bg-hub-hover rounded transition truncate"
                    >
                      {msg.content.slice(0, 100).replace(/\n/g, ' ')}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {mode === 'file' && (
            <div className="p-2 space-y-2">
              <div className="flex items-center gap-2">
                <button onClick={() => setMode('main')} className="text-hub-muted hover:text-hub-secondary text-xs">←</button>
                <span className="text-xs text-hub-secondary">Pin File Path</span>
              </div>
              <input
                type="text"
                placeholder="/workspace/path/to/file"
                value={filePath}
                onChange={e => setFilePath(e.target.value)}
                className="w-full bg-hub-raised border border-hub rounded px-2 py-1.5 text-xs text-hub-primary outline-none focus:border-hub-accent"
                autoFocus
              />
              <button
                onClick={handlePinFile}
                disabled={!filePath.trim()}
                className="w-full py-1.5 rounded text-xs font-medium bg-hub-accent text-white disabled:opacity-50 transition"
              >
                Pin File
              </button>
            </div>
          )}

          {mode === 'text' && (
            <div className="p-2 space-y-2">
              <div className="flex items-center gap-2">
                <button onClick={() => setMode('main')} className="text-hub-muted hover:text-hub-secondary text-xs">←</button>
                <span className="text-xs text-hub-secondary">Pin Text</span>
              </div>
              <input
                type="text"
                placeholder="Title (optional)"
                value={textTitle}
                onChange={e => setTextTitle(e.target.value)}
                className="w-full bg-hub-raised border border-hub rounded px-2 py-1.5 text-xs text-hub-primary outline-none focus:border-hub-accent"
              />
              <textarea
                placeholder="Content to pin..."
                value={textContent}
                onChange={e => setTextContent(e.target.value)}
                className="w-full bg-hub-raised border border-hub rounded px-2 py-1.5 text-xs text-hub-primary outline-none focus:border-hub-accent resize-none h-20"
                autoFocus
              />
              <button
                onClick={handlePinText}
                disabled={!textContent.trim()}
                className="w-full py-1.5 rounded text-xs font-medium bg-hub-accent text-white disabled:opacity-50 transition"
              >
                Pin Text
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/PinnedPinMenu.tsx
git commit -m "feat: add PinnedPinMenu component with message/file/text pinning"
```

---

### Task 12: MessageActions Pin 按钮 + ChatView Pinned Tab

**Files:**
- Modify: `apps/web/src/components/MessageActions.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: 在 MessageActions 中新增 Pin 按钮**

在 `apps/web/src/components/MessageActions.tsx` 中：

导入 Pin 图标：
```typescript
import { MoreHorizontal, Copy, Quote, RefreshCw, Trash2, Pin } from 'lucide-react';
```

Props 新增 onPin：
```typescript
interface Props {
  message: Message;
  agentDisplayName?: string;
  onCopy: () => void;
  onQuote: () => void;
  onPin: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}
```

解构新增 onPin：
```typescript
export function MessageActions({ message, agentDisplayName, onCopy, onQuote, onPin, onRegenerate, onDelete }: Props) {
```

新增 handlePin：
```typescript
const handlePin = () => {
  onPin();
  closeMenu();
};
```

在菜单中 Copy 按钮之后新增 Pin 按钮：
```tsx
{isAgent && (
  <button
    onClick={handlePin}
    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
  >
    <Pin className="w-3.5 h-3.5" />
    Pin Message
  </button>
)}
```

- [ ] **Step 2: 在 ChatView 中新增 Pinned tab 和集成**

在 `apps/web/src/components/ChatView.tsx` 中：

导入新组件：
```typescript
import { PinnedPanel } from './PinnedPanel';
import { PinnedPinMenu } from './PinnedPinMenu';
```

新增 pinned 状态（在 commLogEntries 附近）：
```typescript
const [pinnedEvents, setPinnedEvents] = useState<Array<{ type: string; pinned?: any; pinnedId?: string }>>([]);
const [pinnedCount, setPinnedCount] = useState(0);
```

在 WebSocket handler 中处理 pinned 事件（在 `case 'comm_log':` 附近新增）：
```typescript
case 'pinned_added':
case 'pinned_removed':
case 'pinned_updated':
  setPinnedEvents(prev => [...prev, data]);
  if (data.type === 'pinned_added') setPinnedCount(c => c + 1);
  if (data.type === 'pinned_removed') setPinnedCount(c => Math.max(0, c - 1));
  break;
```

修改 tab 栏，在 Chat 和 Session Log 之间插入 Pinned tab：
```tsx
<button
  className={`px-4 py-1.5 font-medium transition-colors ${activeTab === 'chat' ? 'text-hub-accent border-b-2 border-hub-accent' : 'text-hub-muted hover:text-hub-secondary'}`}
  onClick={() => setActiveTab('chat')}
>
  Chat
</button>
<button
  className={`px-4 py-1.5 font-medium transition-colors ${activeTab === 'pinned' ? 'text-hub-accent border-b-2 border-hub-accent' : 'text-hub-muted hover:text-hub-secondary'}`}
  onClick={() => setActiveTab('pinned')}
>
  Pinned{pinnedCount > 0 ? ` (${pinnedCount})` : ''}
</button>
<button
  className={`px-4 py-1.5 font-medium transition-colors ${activeTab === 'log' ? 'text-hub-accent border-b-2 border-hub-accent' : 'text-hub-muted hover:text-hub-secondary'}`}
  onClick={() => setActiveTab('log')}
>
  Session Log
</button>
```

修改 tab 内容渲染（在 `{activeTab === 'log' ? (` 之前新增 pinned 分支）：
```tsx
{activeTab === 'pinned' ? (
  <div className="flex flex-col h-full">
    <div className="flex items-center justify-between px-3 py-2 bg-[#252526] border-b border-white/10">
      <span className="text-xs text-hub-secondary font-medium">Pinned Messages</span>
      <PinnedPinMenu
        sessionId={activeSessionId!}
        messages={messages}
        onPinned={() => {
          // Refresh pinned list by re-fetching
          api.getPinned(activeSessionId!).then(items => setPinnedCount(items.length));
        }}
      />
    </div>
    <PinnedPanel sessionId={activeSessionId!} wsPinnedEvents={pinnedEvents} />
  </div>
) : activeTab === 'log' ? (
```

在 MessageItem 组件中，传递 onPin 给 MessageActions。找到 `onCopy`、`onQuote`、`onRegenerate`、`onDelete` 的定义位置，新增 onPin：
```typescript
const handlePin = useCallback((msg: Message) => {
  api.createPinned(activeSessionId!, {
    sourceType: 'message',
    content: msg.content,
    sourceMessageId: msg.id,
    title: msg.content.slice(0, 80).split('\n')[0],
  }).then(() => {
    setPinnedCount(c => c + 1);
  });
}, [activeSessionId]);
```

在 MessageActions 调用处传入 onPin：
```tsx
<MessageActions message={msg} agentDisplayName={agentDisplayName}
  onCopy={onCopy} onQuote={onQuote} onPin={() => handlePin(msg)} onRegenerate={onRegenerate} onDelete={onDelete} />
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/MessageActions.tsx apps/web/src/components/ChatView.tsx
git commit -m "feat: add Pinned tab to ChatView and Pin button to MessageActions"
```

---

## Verification

### 后端验证

1. 启动后端：`cd apps/api && npx tsx src/index.ts`
2. 测试 Pinned API：
   ```bash
   TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
   # 创建置顶
   curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"sourceType":"text","content":"Test pinned message","title":"Test"}' \
     http://localhost:3000/api/sessions/<sessionId>/pinned
   # 获取置顶列表
   curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/sessions/<sessionId>/pinned
   ```
3. 测试 contextTokenBudget 设置：
   ```bash
   curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"contextTokenBudget":15000}' \
     http://localhost:3000/api/settings/runtime
   ```

### 前端验证

1. 启动前端：`cd apps/web && npx vite`
2. 验证 Chat / Pinned / Session Log 三个 tab 正确显示
3. 验证 + Pin 按钮的三种模式（消息/文件/文本）
4. 验证 MessageActions 中的 Pin Message 按钮
5. 验证置顶消息的删除和 injectToAgent 切换

### TypeScript 编译检查

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```
