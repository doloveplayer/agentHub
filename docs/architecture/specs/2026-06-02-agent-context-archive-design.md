# Agent 协作上下文管理 & Plan 归档 & 故障恢复 设计方案

> 2026-06-02 | 统一设计，覆盖 DAG 多 agent 协作 + 自由对话 + 跨 session 知识积累

## 一、设计全景

```
                        ┌─────────────────────────┐
                        │     Context Bus (黑板)    │
                        │   in-memory Map + DB持久化 │
                        │   key → {value, version,  │
                        │    author, timestamp}      │
                        └──┬───────┬──────────┬────┘
            ┌──────────────┴─┐ ┌──┴──────────┴──────────┐
            │  Agent Runtime  │ │  Archive Pipeline       │
            │  启动时注入上下文 │ │  Plan完成时触发          │
            │  运行时读取/写入  │ │  提取经验 → agent memory │
            └────────────────┘ └─────────────────────────┘

  ┌──────────────────────────────────────────────────────┐
  │                    Fault Recovery                     │
  │  L1: Task自动重试(增强) → L2: Plan断点续跑 → L3: Session快照 │
  └──────────────────────────────────────────────────────┘
```

---

## 二、Context Bus — 全局状态黑板

### 2.1 与群聊消息的本质区别

| | 群聊消息流 | Context Bus 黑板 |
|---|---|---|
| **形式** | 时序流，append-only | 键值空间，可覆盖更新 |
| **内容** | agent 思考**过程**（"我打算改 X"） | 执行后**事实**（"X 已被改成 Y"） |
| **消费** | Push，全部接收 | Pull，按需读取 |
| **生命周期** | 永久保留在消息历史中 | 状态可过期、可覆盖、可标记 resolved |

群聊 = "大家说了什么"，黑板 = "现在事实是什么"。

### 2.2 数据模型

```typescript
interface ContextEntry {
  key: string;                    // 全局唯一键，如 "auth-oauth-callback"
  value: unknown;                 // 任意结构化值
  type: ContextEntryType;         // 见下方枚举
  version: number;                // 乐观锁版本号
  author: string;                 // agentName
  taskId?: string;                // 关联 task
  planId?: string;                // 关联 plan
  tags: string[];                 // 索引标签
  status: 'active' | 'resolved' | 'superseded';
  createdAt: number;
  updatedAt: number;
}

type ContextEntryType =
  | 'known-issue'        // 已知问题/陷阱
  | 'project-fact'       // 项目结构事实
  | 'task-handoff'       // task 间交接信息
  | 'decision'           // 架构决策记录
  | 'artifact'           // 产物引用
  | 'convention'         // 项目约定
  | 'dependency-map';    // 依赖拓扑
```

### 2.3 Key 命名规范

```
{scope}:{category}:{descriptor}

示例:
  proj:convention:import-style        → 项目导入路径约定
  task:auth-oauth:output-summary      → 某 task 的产出摘要
  bug:null-check:db-query             → 缺陷模式记录
  arch:decision:state-management      → 架构决策
  deps:topology:types.ts              → 依赖拓扑
```

### 2.4 Agent 上下文注入流程

Agent 启动时（REPL 或 task dispatch），Hub 层从 Context Bus 构建上下文注入 prompt：

```
注入顺序:
1. 项目全局状态摘要（黑板中所有 active 条目按 scope=proj 过滤）
2. 上游 task 的 handoff 消息（scope=task-handoff, 关联当前 task 的 dependsOn）
3. 匹配 agent type 的已知缺陷（type=known-issue, tags 匹配）
4. 匹配 agent type 的项目约定（type=convention）
5. Inbox 消息（保留现有 inbox 机制）
```

注入量上限：2000 tokens。超出时按 priority 截断。

### 2.5 Context Bus 实现

```typescript
// apps/api/src/agent/ContextBus.ts

export class ContextBus {
  private store: Map<string, ContextEntry>;
  
  // 写入/覆盖
  set(entry: Omit<ContextEntry, 'version' | 'createdAt' | 'updatedAt'>): void;
  
  // 批量查询（按 scope、type、tags 过滤）
  query(filter: ContextQuery): ContextEntry[];
  
  // 获取项目摘要（注入 agent prompt 用）
  getProjectDigest(maxTokens: number): string;
  
  // 获取 agent type 相关经验
  getRelevantExperience(agentType: string, taskDescription: string): string;
  
  // 序列化（checkpoint 用）
  serialize(): string;
  
  // 反序列化恢复
  static deserialize(data: string): ContextBus;
  
  // Plan 完成时清理已 resolved 的条目
  archive(planId: string): ContextEntry[];
}
```

生命周期：每个 session 一个 ContextBus 实例，WebSocket 连接期间在内存中，同时关键条目写入 DB（`ContextEntry` 表）做持久化恢复。

---

## 三、Archive Pipeline — 归档流水线

### 3.1 触发时机与流程

```
Plan 所有 task 完成 (plan_summary 事件)
  │
  ├── Step 1: 产物快照 (规则引擎)
  │     - git diff workspace → 文件变更列表
  │     - task → 文件映射（通过 agent tool_use 事件中的 file_path 追踪）
  │     - 写入 .sandboxes/{sessionId}/archive/{planId}/
  │       ├── manifest.json       # 元信息
  │       ├── diff.patch          # 完整 git diff
  │       └── task-outputs/       # 每个 task 的 output 摘要
  │
  ├── Step 2: 经验提取 (规则引擎结构化 + Plan Skill LLM 语义)
  │     规则引擎提取:
  │     - Context Bus 黑板中新增的 known-issue / convention / decision 条目
  │     - 失败的 task → 错误模式
  │     - Review agent 对 Code agent 产出的 reject → 缺陷模式
  │     
  │     Plan Skill (archive-experience.md) 语义提取:
  │     - 读取整个 Plan 执行日志 + 黑板状态
  │     - 生成结构化经验条目
  │     - 更新 agent memory 说明书
  │
  ├── Step 3: Plan 骨架化 (可选，用户触发)
  │     - 将 DAG 结构 + task 描述抽象为可复用模板
  │     - 客户参数化（项目路径、技术栈等替换为占位符）
  │     - 写入 .agents/planner/.claude/skills/plan-templates/
  │
  └── Step 4: 清理
        - Context Bus 归档已 resolved 条目
        - agent inbox 清空
        - 标记 Plan 为 archived
```

### 3.2 产物快照 manifest.json

```json
{
  "planId": "plan-abc123",
  "sessionId": "session-xyz",
  "planTitle": "Add OAuth login to React app",
  "completedAt": "2026-06-02T10:30:00Z",
  "durationMs": 180000,
  "tasks": [
    {
      "id": "task-1",
      "title": "Analyze auth module",
      "agentType": "code-agent",
      "status": "done",
      "outputFiles": ["src/auth/analysis.md"],
      "modifiedFiles": [],
      "outputSummary": "Found hardcoded callback URL in auth.ts:42"
    }
  ],
  "fileChanges": {
    "added": ["src/auth/OAuthLogin.tsx", "src/auth/callback.ts"],
    "modified": ["src/auth/auth.ts", "package.json"],
    "removed": []
  },
  "contextEntries": [
    { "key": "bug:hardcoded-callback", "type": "known-issue", "status": "resolved" }
  ]
}
```

### 3.3 经验提取规则引擎

```typescript
// apps/api/src/agent/ExperienceExtractor.ts

interface ExtractionRule {
  name: string;
  match: (ctx: ExtractionContext) => boolean;
  extract: (ctx: ExtractionContext) => ExperienceEntry[];
}

// 内置规则:
const BUILTIN_RULES: ExtractionRule[] = [
  {
    name: 'review-rejection-pattern',
    // review-agent 拒绝了 code-agent 的产出 → 缺陷模式
    match: (ctx) => ctx.hasEvent('task_failed') && ctx.failedBy === 'review-agent',
    extract: (ctx) => [{
      type: 'bug-pattern',
      title: `${ctx.failedTask.title} 被审查拒绝`,
      detail: ctx.failedTask.lastError,
      agentTypes: ['code-agent'],
      tags: ctx.extractKeywords(ctx.failedTask.description),
    }],
  },
  {
    name: 'file-conflict-warning',
    // 多个 task 修改了同一文件 → 依赖拓扑
    match: (ctx) => ctx.concurrentFileEdits.length >= 2,
    extract: (ctx) => [{
      type: 'dependency-topology',
      title: `文件 ${ctx.concurrentFileEdits[0].file} 被多 task 并发修改`,
      detail: `涉及: ${ctx.concurrentFileEdits.map(e => e.taskTitle).join(', ')}`,
      agentTypes: ['code-agent', 'planner'],
      tags: ['concurrent-edit', ...ctx.concurrentFileEdits[0].file.split('/')],
    }],
  },
  {
    name: 'convention-discovery',
    // 从 Context Bus 中提取项目约定
    match: (ctx) => ctx.contextBus.hasNewEntriesOfType('convention'),
    extract: (ctx) => ctx.contextBus.getNewEntriesOfType('convention')
      .map(e => ({ type: 'project-convention' as const, ...e })),
  },
];
```

---

## 四、Agent 经验说明书（渐进披露）

### 4.1 目录结构

利用 Claude Code SDK 内置的 `MEMORY.md` 索引机制（`settingSources: ["user", "project"]` → 自动读取 `CLAUDE_CONFIG_DIR` 下的 memory 文件）：

```
.agents/{agentId}/.claude/memory/
├── MEMORY.md                 ← SDK 自动加载的索引（200行以内）
│                               每次 agent 启动时自动注入上下文
│                               包含摘要 + 触发词，命中后 agent 自行读取详情
│
├── bug-patterns/             ← 缺陷模式案例库
│   ├── null-check-db.md
│   ├── strict-mode-type.md
│   └── import-path-convention.md
│
├── project-conventions/      ← 项目约定
│   ├── import-style.md
│   ├── testing-pattern.md
│   └── docker-usage.md
│
├── strategy-outcomes/        ← 方案优劣记录
│   ├── state-management-choice.md
│   └── api-design-pattern.md
│
├── dependency-topology/      ← 依赖拓扑
│   └── types.ts-dependents.md
│
└── domain-knowledge/         ← 领域知识
    └── oauth-flow.md
```

### 4.2 MEMORY.md 格式

```markdown
# Agent Code-Agent 经验索引

## 缺陷模式
- [null-check-db-query](bug-patterns/null-check-db.md) — strictNullChecks 下 DB 查询返回值必须判空
- [import-path-convention](bug-patterns/import-path-convention.md) — 本项目统一用 @/ 别名禁止相对引用

## 项目约定
- [import-style](project-conventions/import-style.md) — import 顺序和别名规则
- [testing-pattern](project-conventions/testing-pattern.md) — 测试文件命名和 mock 约定

## 依赖拓扑
- [types.ts-dependents](dependency-topology/types.ts-dependents.md) — types.ts 的 12 个下游依赖

## 领域知识
- [oauth-flow](domain-knowledge/oauth-flow.md) — OAuth token 刷新在 middleware 层
```

### 4.3 经验条目文件格式

每个 `.md` 文件遵循 Claude Code memory 的 frontmatter 格式：

```markdown
---
name: null-check-db-query
description: strictNullChecks 下所有 DB 查询返回值必须在访问属性前判空，否则编译报错
metadata:
  type: reference
  tags: [typescript, prisma, null-check, database]
  severity: high
  discoveredAt: 2026-06-02
  sourcePlan: plan-abc123
  sourceTask: task-review-1
---

## 触发条件
- 使用 Prisma client 进行数据库查询
- TypeScript strictNullChecks 开启
- 直接访问查询结果的关联属性（如 `user.profile.name`）

## 正确做法
```typescript
const user = await prisma.user.findUnique({ where: { id }, include: { profile: true } });
if (!user?.profile) throw new NotFoundError('Profile not found');
// 现在可以安全访问 user.profile.name
```

## 错误示例
```typescript
const user = await prisma.user.findUnique({ where: { id }, include: { profile: true } });
const name = user.profile.name;  // ❌ TS18049: 'user.profile' is possibly null
```
```

### 4.4 经验生命周期

```
提取 → 写入 MEMORY.md 索引 + 详情文件
      ↓
Agent 启动 → SDK 读取 MEMORY.md → 自动注入上下文
      ↓
Agent 执行中发现匹配 → 主动读取详情文件（Skill/Read 工具）
      ↓
经验条目 stale 检测 → 连续 N 次未命中 → 降级为 low-priority
      ↓
经验条目过期 → 移至 memory/archive/ 保留但不再注入
```

### 4.5 Plan Skill: archive-experience

当 Plan 完成后，Hub 调用一个专用的 Planner Skill 做语义提取：

```markdown
# archive-experience Skill

你是一个经验归档专家。你收到的输入包括:
1. 完整的 Plan 执行日志
2. Context Bus 黑板最终状态
3. 每个 task 的产出摘要
4. 失败的 task 及错误信息

你的任务:
1. 识别可复用的经验模式
2. 为每个受影响的 agent 生成经验条目
3. 将条目写入对应的 .agents/{agentId}/.claude/memory/ 目录
4. 更新 MEMORY.md 索引

输出格式: JSON 数组，每个条目包含 agentId, filePath, frontmatter, body
```

---

## 五、故障恢复

### 5.1 三级恢复体系

```
L1: Task 自动重试（已有，增强）
    ┌────────────────────────────────────────────┐
    │ 失败时自动保存 workspace diff               │
    │ 重试前注入"上次失败原因 + 建议"到 prompt      │
    │ MAX_AUTO_RETRIES: 3（可配置）               │
    │ 每次重试前广播 "task_retry" 事件告知前端      │
    └────────────────────────────────────────────┘

L2: Plan 断点续跑（新增）
    ┌────────────────────────────────────────────┐
    │ Checkpoint 数据结构:                        │
    │ {                                          │
    │   planId, sessionId,                       │
    │   workspaceGitCommit: string,  // git sha  │
    │   contextBusState: string,     // JSON序列化│
    │   agentSessions: {                          │
    │     [agentName]: {                          │
    │       claudeSessionId: string,              │
    │       lastTaskId: string,                   │
    │       status: 'idle' | 'running'            │
    │     }                                       │
    │   },                                        │
    │   pendingTasks: TaskDispatchNode[],         │
    │   completedTasks: string[],                 │
    │   failedTasks: Array<{ id, error, retry }>, │
    │   timestamp: number                         │
    │ }                                          │
    │                                            │
    │ 写入: .sandboxes/{sessionId}/checkpoints/   │
    │       {planId}.json                         │
    │                                            │
    │ 恢复流程:                                    │
    │ 1. WebSocket 重连 → 检测未完成的 Plan        │
    │ 2. 读取 checkpoint JSON                     │
    │ 3. 恢复 Context Bus 黑板（反序列化）          │
    │ 4. 恢复 agent REPL session (resume)         │
    │ 5. 从未完成的 task 继续 dispatch             │
    │                                            │
    │ 降级: resume 失败 → sendPrompt 冷启动       │
    └────────────────────────────────────────────┘

L3: Session 快照（远期）
    ┌────────────────────────────────────────────┐
    │ 用户手动触发（关键 milestone 前）            │
    │ 保存: 完整 workspace + agent状态 + 黑板     │
    │ 可操作: 回滚 / 克隆到新 session / 导出       │
    │ 实现: git branch + tag 标记                │
    └────────────────────────────────────────────┘
```

### 5.2 Checkpoint 写入时机

| 事件 | 操作 |
|------|------|
| Plan 开始执行 | 创建初始 checkpoint |
| 每个 task 完成后 | 更新 checkpoint（agentSessions、completedTasks） |
| 每个 task 失败重试 | 更新 checkpoint（failedTasks） |
| ManagerLoop re-plan | 创建新 checkpoint（标记 re-plan 来源） |
| WebSocket 断开 | 最终 checkpoint 写入 DB |
| Plan 完成 | 保留最后一个 checkpoint，删掉中间文件 |

### 5.3 claudeSessionId 持久化

当前 `claudeSessionId` 只在 `ClaudeCodeProvider` 内存中。改动：

```typescript
// ClaudeCodeProvider 中
case 'system':
  if (event.sessionId) {
    this.claudeSessionId = event.sessionId;
    // 新增: 持久化到 checkpoint
    getCheckpointManager().updateAgentSession(
      sessionId, planId, this.currentAgentConfigId, event.sessionId
    );
  }
```

---

## 六、AgentCard 第四页：Skills 使用统计

### 6.1 数据追踪

在 `handleProviderTaskEvent` 中新增 skill 事件处理：

```typescript
// taskDispatcher.ts: handleProviderTaskEvent
case 'skill_use': {
  // Claude SDK 的 skill 调用事件
  stateTracker.recordSkillUse(taskMessageId, {
    skillName: event.skillName,
    agentName,
    taskId: task.id,
    planId: queue.planId,
    timestamp: Date.now(),
  });
  break;
}
```

同时在 `StateTracker` 中新增聚合：

```typescript
// StateTracker.ts
interface SkillUsageRecord {
  skillName: string;
  agentName: string;
  count: number;
  firstUsed: number;
  lastUsed: number;
  associatedTaskIds: string[];
}

class StateTracker {
  private skillUsage: Map<string, SkillUsageRecord>;
  
  recordSkillUse(messageId: string, info: SkillUseInfo): void;
  getAgentSkillStats(agentName: string): SkillUsageRecord[];
  getSessionSkillStats(sessionId: string): SkillUsageRecord[];
}
```

### 6.2 前端组件

AgentCard 新增第 4 个 dot 指示器（在现有的摘要/日志/仪表盘之外），展示 FaceSkillStats：

```
┌──────────────────────────────┐
│  Skills 调用统计              │
│                              │
│  ┌─────────────────────────┐ │
│  │ plan-and-dispatch   3次  │ │
│  │ code-review         2次  │ │
│  │ archive-experience  1次  │ │
│  │ test-driven-dev     1次  │ │
│  └─────────────────────────┘ │
│                              │
│  总计: 7 次调用 · 4 个 skills │
└──────────────────────────────┘
```

```typescript
// AgentCardFaces.tsx 新增
export function FaceSkillStats({ skills }: { skills: SkillUsageRecord[] }) {
  if (skills.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-hub-muted text-caption italic">
        尚未使用 skills
      </div>
    );
  }
  
  const total = skills.reduce((s, r) => s + r.count, 0);
  const unique = skills.length;
  
  return (
    <div className="py-3 px-3 space-y-2 text-[11px]">
      {skills.sort((a, b) => b.count - a.count).map((s) => (
        <div key={s.skillName} className="flex items-center justify-between">
          <span className="text-hub-primary font-mono">{s.skillName}</span>
          <span className="text-hub-accent font-medium">{s.count}次</span>
        </div>
      ))}
      <div className="pt-2 border-t border-hub text-hub-tertiary">
        总计: {total} 次调用 · {unique} 个 skills
      </div>
    </div>
  );
}
```

---

## 七、数据流整合

```
Session 创建
  │
  ├→ Context Bus 初始化 (per-session)
  │
  ├→ Planner 生成 Plan
  │     │
  │     ├→ 写入 Context Bus: key=plan:{planId}:structure
  │     │
  │     └→ Task dispatch
  │           │
  │           ├→ Agent 启动前: 从 Context Bus 注入上下文
  │           │                  从 agent memory 注入经验 (MEMORY.md)
  │           │
  │           ├→ 执行中: Agent 读写 Context Bus
  │           │           Agent 间 inbox 消息传递
  │           │           Skill 调用记录到 StateTracker
  │           │
  │           ├→ Task 完成: 写入 Context Bus handoff
  │           │              更新 checkpoint
  │           │
  │           └→ Task 失败: 自动重试 → ManagerLoop → re-plan
  │                         更新 checkpoint
  │
  ├→ Plan 完成: Archive Pipeline 触发
  │     │
  │     ├→ 产物快照 → .sandboxes/{id}/archive/{planId}/
  │     ├→ 规则引擎提取经验
  │     ├→ Plan Skill (archive-experience) 语义提取
  │     ├→ 更新 agent memory (.agents/{id}/.claude/memory/)
  │     └→ 清理 Context Bus
  │
  └→ Session 断开: 最终 checkpoint 写入 DB
        │
        └→ 重连恢复: 读取 checkpoint → 恢复 Context Bus → resume agent session
```

---

## 八、实现阶段

### Phase 1: Context Bus 基础 (预估 3-4 天)
- `ContextBus` 类实现（set/query/serialize/deserialize）
- DB 表 `ContextEntry` + Prisma migration
- Agent 启动时上下文注入（修改 `startReplForTask` + `processNextInQueue`）
- 前端不新增 UI（黑板状态暂不展示）

### Phase 2: Archive Pipeline (预估 3-4 天)
- `ExperienceExtractor` 规则引擎
- `ArchiveManager` — 产物快照 manifest.json + diff.patch
- `archive-experience` Skill 模板
- `DagPersistence` 扩展：markArchived
- Agent memory 写入（MEMORY.md + 经验详情文件）

### Phase 3: Checkpoint & Recovery (预估 2-3 天)
- `CheckpointManager` — 写入/读取 checkpoint JSON
- `claudeSessionId` 持久化
- WebSocket 重连恢复流程
- L1 重试增强（注入失败原因到 prompt）

### Phase 4: AgentCard 第四页 & 可视化 (预估 1-2 天)
- `StateTracker` 扩展：skill usage 追踪
- `FaceSkillStats` 组件
- AgentCard dot 指示器扩展为 4 个

### Phase 5: Session 快照 (远期)
- 用户手动触发快照
- git branch + tag 标记
- 回滚/克隆/导出 UI

---

## 九、关键文件清单

| 文件 | 改动类型 |
|------|----------|
| `apps/api/src/agent/ContextBus.ts` | **新增** |
| `apps/api/src/agent/ExperienceExtractor.ts` | **新增** |
| `apps/api/src/agent/ArchiveManager.ts` | **新增** |
| `apps/api/src/agent/CheckpointManager.ts` | **新增** |
| `apps/api/src/agent/StateTracker.ts` | 修改 — 新增 skill 追踪 |
| `apps/api/src/agent/AgentDirectoryManager.ts` | 修改 — 新增 memory 写入 |
| `apps/api/src/agent/skills/archive-experience.md` | **新增** |
| `apps/api/src/ws/taskDispatcher.ts` | 修改 — 注入上下文 + skill 事件 + checkpoint |
| `apps/api/src/ws/chatHandlers.ts` | 修改 — 恢复流程 |
| `apps/api/src/agent/providers/claude-code.ts` | 修改 — claudeSessionId 持久化 |
| `apps/api/src/agent/DagPersistence.ts` | 修改 — archive 状态 |
| `apps/web/src/components/AgentCard.tsx` | 修改 — 第4个 dot |
| `apps/web/src/components/AgentCardFaces.tsx` | 修改 — FaceSkillStats |
| `apps/web/src/store/appStore.ts` | 修改 — skill 事件类型 |
| `packages/shared/src/types.ts` | 修改 — 新增事件类型 |

---

## 十、风险与降级

| 风险 | 降级策略 |
|------|----------|
| Context Bus 内存膨胀 | 单 session 最多 500 条目，超出 LRU 淘汰到 DB |
| Claude SDK resume 失败 | 降级为 sendPrompt 冷启动，广播 warning |
| 经验提取质量差 | 规则引擎兜底，LLM 提取失败不影响 Plan 完成 |
| Checkpoint 写入失败 | 非阻塞，console.error + 广播 warning |
| MEMORY.md 索引过大 | 按 agent type 过滤，每类最多 30 条，旧条目归档到 archive/ |
