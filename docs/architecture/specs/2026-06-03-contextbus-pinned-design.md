# ContextBus 上下文管理 + 消息置顶功能设计

## Context

当前 ContextBus 是一个带 LRU 淘汰的内存 KV store（500 条上限），存在以下问题：
- Token 计数用 `maxTokens * 4` 字符估算，不准确
- LRU 淘汰只看 `updatedAt`，不考虑条目重要性
- `getProjectDigest()` 超限直接截断，不压缩
- 无置顶/长期保留机制

本设计增加：1) ContextBus 智能上下文管理；2) 消息置顶功能（UI 书签 + agent 上下文注入）。

---

## 1. ContextBus 上下文管理策略

### 1.1 Token 计数

用中英混合加权估算，替换字符粗估：

```typescript
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[a-zA-Z]+/g) || []).length;
  const other = text.length - cjk - (text.match(/[a-zA-Z]/g) || []).length;
  return Math.ceil(cjk * 1.5 + words * 1.3 + other * 0.5);
}
```

### 1.2 优先级权重淘汰

`getProjectDigest()` 按权重排序，替代简单的类型优先级：

```
权重 = 类型基础分 × 时效衰减 + 引用次数加分

类型基础分: convention=100, decision=80, known-issue=70,
           dependency-map=60, task-handoff=50, project-fact=40, artifact=20
时效衰减: max(0, 1 - ageHours / 168)  // 7 天线性衰减到 0
引用次数: 每被 getRelevantExperience 命中一次 +10（在 ContextEntry 上新增 `_refCount: number` 内存字段，不持久化，session 重置为 0）
```

### 1.3 三级压缩

当 token 预算不足时：

| 级别 | 触发条件 | 操作 |
|------|----------|------|
| Level 1 | 超出预算 | 截断长 value（保留前 200 字符） |
| Level 2 | 超出预算 30% | 合并同类型低权重条目（如多个 task-handoff 合并为摘要） |
| Level 3 | 超出预算 50% | 调用 LLM 生成压缩摘要 |

### 1.4 生命周期管理

```
active → (7天无更新) → stale → (被新版本覆盖) → superseded → (30天后) → 删除
active → (任务完成) → resolved → (7天后) → 删除
pinned → 永不自动删除（仅用户手动删除）
```

ContextBus 不新增 pinned 状态。置顶条目完全由 PinnedStore（DB）管理，与 ContextBus 内存 store 解耦。ContextBus 的 LRU/GC 只管理自动上下文条目。

---

## 2. PinnedStore 架构

### 2.1 数据模型

```prisma
model PinnedMessage {
  id              String   @id @default(uuid())
  sessionId       String
  sourceType      String   @default("message")  // message | file | text
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

Session 模型新增关系：`pinnedMessages PinnedMessage[]`

### 2.2 PinnedStore 模块

```typescript
// apps/api/src/agent/PinnedStore.ts
export class PinnedStore {
  static async add(sessionId, sourceType, content, options?): Promise<PinnedMessage>
  static async remove(sessionId, pinnedId): Promise<void>
  static async list(sessionId): Promise<PinnedMessage[]>
  static async update(sessionId, pinnedId, data): Promise<PinnedMessage>
  static async reorder(sessionId, ids: string[]): Promise<void>
  static async buildInjectionPrompt(sessionId, maxTokens: number): Promise<string>
  static async pinFromMessage(sessionId, messageId): Promise<PinnedMessage>
  static async pinFromFile(sessionId, filePath): Promise<PinnedMessage>
}
```

### 2.3 与 ContextBus 的关系

- PinnedStore 独立存储在 DB，不占用 ContextBus 的 500 条内存上限
- PinnedStore 和 ContextBus 的注入在 `buildTaskPrompt()` 中独立调用，最终拼接
- Pinned 条目注入时排在最前面，标记为 `[PINNED]`

---

## 3. Token 预算分配

总预算 **10000 tokens**（默认值，可在 Settings → Agent Config 中调整）：

```
总预算: 10000 tokens
├─ Pinned Context:  4000 tokens (40%)  — 用户置顶，永不淘汰
├─ Project State:   4000 tokens (40%)  — ContextBus 自动上下文
└─ Experience:      2000 tokens (20%)  — 匹配的历史经验
```

某个分区内容不足时，剩余预算可被其他分区借用。

### 3.1 配置集成

- `GlobalConfig` 表新增 `contextTokenBudget` key（默认 10000）
- `RuntimeConfigForm` 新增 "Context Token Budget" 输入框（min: 2000, max: 50000）
- `runtimeConfig.agent` 新增 `contextTokenBudget` getter/setter

---

## 4. Agent Prompt 注入流程

```
startReplForTask() / buildTaskPrompt()
    ↓
1. PinnedStore.buildInjectionPrompt(sessionId, 4000)
   → 查询 DB 中该 session 的所有 pinned 条目（injectToAgent=true）
   → 按 sortOrder 排序
   → 逐条估算 token，拼接直到预算耗尽
   → 文件类型：读取文件最新内容（截断到 200 字符），附带路径
   → 文件不存在时：跳过该条目并记录警告日志，不影响其他条目注入
    ↓
2. ContextBus.getProjectDigest(4000)
   → 按权重排序 active 条目（排除 pinned 状态）
   → 逐条估算 token，拼接直到预算耗尽
    ↓
3. ContextBus.getRelevantExperience(agentType, taskDesc, 2000)
   → 关键词匹配 known-issue + convention
   → 限制 token 预算
    ↓
4. 拼接为最终 prompt
```

### 注入格式

```
## Pinned Context (用户置顶)
- [PINNED] 用户认证需求：支持 JWT + OAuth2，参考 /workspace/auth-spec.md
- [PINNED] /workspace/src/config.ts — 项目配置文件（最新内容：...）
- [PINNED] 编码规范：使用 TypeScript strict 模式，禁止 any

## Project State (自动上下文)
- [convention] **key**: value
- [task-handoff] **task:T1:output-summary**: 已完成用户模块...

## Relevant Experience
- [known-issue] **task:T3:failure**: 测试超时...
```

---

## 5. 前端 UI 设计

### 5.1 Tab 位置

ChatView 顶部 tab 栏，Chat 和 Session Log 之间：

```
[ Chat ] [ Pinned (3) ] [ Session Log ]
```

### 5.2 Pinned 面板

```
┌─────────────────────────────────────────────┐
│ Pinned Messages                      [+ Pin] │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────┐ │
│ │ [Message] 用户认证需求...               │ │
│ │ source: msg-abc123  inject: ✓  [✕]     │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ [File] /workspace/src/config.ts         │ │
│ │ source: file path   inject: ✓  [✕]     │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ [Text] 编码规范：TypeScript strict...   │ │
│ │ source: manual      inject: ✓  [✕]     │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 5.3 "+ Pin" 下拉菜单

1. **Pin Message** — 消息选择器（最近 50 条，可搜索）
2. **Pin File** — 文件浏览器（workspace 目录树）
3. **Pin Text** — 文本输入框（标题 + 内容）

### 5.4 MessageActions 新增 Pin

在 Copy / Quote / Regenerate / Delete 菜单中新增 "Pin Message" 选项。

---

## 6. API 设计

### 6.1 Pinned Messages REST API

```
POST   /api/sessions/:sessionId/pinned          — 创建置顶
GET    /api/sessions/:sessionId/pinned           — 获取所有置顶
DELETE /api/sessions/:sessionId/pinned/:id       — 删除置顶
PATCH  /api/sessions/:sessionId/pinned/:id       — 更新（injectToAgent, sortOrder）
PATCH  /api/sessions/:sessionId/pinned/reorder   — 批量排序
```

### 6.2 ContextBus 增强 API

```
GET    /api/sessions/:sessionId/context/stats    — 上下文统计
```

### 6.3 WebSocket 事件

```
{ type: 'pinned_added', sessionId, pinned }
{ type: 'pinned_removed', sessionId, pinnedId }
{ type: 'pinned_updated', sessionId, pinned }
```

---

## 7. 关键文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/shared/src/types.ts` | 修改 | 新增 PinnedMessage 接口 |
| `apps/api/prisma/schema.prisma` | 修改 | 新增 PinnedMessage 模型 |
| `apps/api/src/agent/PinnedStore.ts` | 新增 | 置顶消息 CRUD + prompt 注入 |
| `apps/api/src/agent/ContextBus.ts` | 重构 | token 计数 + 权重排序 + 压缩 |
| `apps/api/src/routes/pinned.ts` | 新增 | 置顶消息 REST API |
| `apps/api/src/ws/taskDispatcher.ts` | 修改 | buildTaskPrompt 集成 |
| `apps/api/src/config.ts` | 修改 | runtimeConfig 新增 contextTokenBudget |
| `apps/api/src/routes/settings.ts` | 修改 | 新增 contextTokenBudget 设置 |
| `apps/web/src/components/PinnedPanel.tsx` | 新增 | 置顶消息面板 |
| `apps/web/src/components/PinnedPinMenu.tsx` | 新增 | Pin 下拉菜单 |
| `apps/web/src/components/MessageActions.tsx` | 修改 | 新增 Pin 按钮 |
| `apps/web/src/components/ChatView.tsx` | 修改 | 新增 Pinned tab |
| `apps/web/src/components/RuntimeConfigForm.tsx` | 修改 | 新增 contextTokenBudget |
| `apps/web/src/lib/api.ts` | 修改 | 新增 pinned API 调用 |

---

## 8. 实施阶段

### Phase 1: ContextBus 上下文管理
- Token 计数函数
- 权重排序 + getProjectDigest 重构
- 生命周期管理（stale 状态 + gc 增强）
- contextTokenBudget 设置集成

### Phase 2: PinnedStore 后端
- Prisma schema + migration
- PinnedStore 模块
- REST API + WebSocket 事件
- buildTaskPrompt 集成

### Phase 3: PinnedStore 前端
- PinnedPanel 组件
- PinnedPinMenu 组件（消息/文件/文本）
- MessageActions Pin 按钮
- ChatView Pinned tab
- API 集成
