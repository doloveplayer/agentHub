# Phase 3: Smart Hub 核心能力 — 实现计划

> **合并自：** `2026-05-20-phase3-orchestrator.md`, `2026-05-21-phase3.5-task0-repl-architecture.md`, `2026-05-21-phase3.5-collab-workspace.md`, `2026-05-21-phase4a-multi-provider.md`, `2026-05-23-task-agent-routing.md`
>
> **关联 PRD：** `PRD.md` §4.3

**Goal:** 实现 Smart Hub 三大核心能力：Main Agent 协调、多平台 Agent 接入、消息增强交互。

**Architecture:** Main Agent (Planner) 拆解需求 → TaskPlan JSON → DAG 可视化 → 用户确认 → 任务路由到群内 Agent 的 REPL 通道执行（非 one-shot 容器）→ 失败降级 + 代码冲突检测。

---

## 执行状态总览

| Tier | 内容 | 状态 |
|------|------|------|
| Tier 0 | 基础协调设施 | ✅ 完成 |
| Tier 1 | 多平台 Provider 接入 | 🟡 Claude Code 完成，第二平台待选型 |
| Tier 2 | Task-to-Agent 路由 | ✅ 完成 |
| Tier 3 | 代码冲突 + 面板降噪 + 交互 DAG + 追问 + 消息增强 | ✅ 完成 |

---

## Tier 0: 基础协调设施 ✅

> **来源：** Phase 3 Orchestrator (Tier 0-2) + Phase 3.5 REPL Architecture + Phase 3.5 Collab Workspace + Turn Provider Core

### Main Agent (Planner)

- [x] **Main Agent 双重身份**：默认群聊主持人（对话回复，无 JSON）；触发词激活规划模式（探查项目 → 输出 TaskPlan JSON）
  - 文件：`apps/api/src/defaultAgents.ts` (Planner system prompt)
- [x] **TaskPlan JSON schema**：planTitle, summary, tasks[] (id, title, description, agentType, dependsOn, expectedOutput, priority)
  - 文件：`packages/shared/src/types.ts` (TaskNode, TaskPlan)
- [x] **Plan JSON 提取**：支持 fence-wrapped, bare JSON, inline 三种格式
  - 文件：`apps/api/src/agent/turns.ts` (`extractPlannerPlan`, `toTaskStates`)

### 任务调度

- [x] **BullMQ 队列**：拓扑排序 → 并行层 → 依赖管理
  - 文件：`apps/api/src/agent/TaskQueue.ts` (`topologicalSort`, `submitPlan`)
- [x] **上下文传递**：任务 prompt 注入前置任务产出 + 项目文件树
  - 文件：`apps/api/src/agent/TaskQueue.ts` (`contextPrompt` 构建)
- [x] **失败处理**：自动重试（可配置次数）+ 耗尽后阻塞依赖 (`blockDependents`)
  - **已知不足**：重试耗尽后仅阻塞，未将错误上下文反馈给 Main Agent 重新规划。改进方案见 Tier 2.4
- [x] **结果聚合**：plan_summary（文件变更清单 + 完成/失败统计）
  - 文件：`apps/api/src/index.ts` (Worker completed 回调)

### 前端 DAG 与确认

- [x] **TaskDAG 可视化**：React Flow 渲染节点（waiting/running/done/failed 颜色）+ 依赖边
  - 文件：`apps/web/src/components/TaskDAG.tsx`, `TaskCard.tsx`
- [x] **人工确认面板**：确认执行 / 修改任务描述 / 取消
  - 文件：`apps/web/src/components/ConfirmationPanel.tsx`
- [x] **Task modification 存储**：`taskModifications` Map 在确认前暂存修改
- [x] **重试失败任务**：`retry_task` WS 消息 → TaskQueueManager.retryTask

### Agent 状态追踪

- [x] **StateTracker**：追踪每个 agent 的 token 用量、当前工具、打开文件、子 agent 列表
  - 文件：`apps/api/src/agent/StateTracker.ts`
- [x] **Agent Card 实时活动流**：thinking/tool_use/tool_result/subagent/permission 事件
  - 文件：`apps/web/src/components/AgentCard.tsx`, `AgentStatusPanel.tsx`

### Agent 协作原语

- [x] **InboxManager**：文件收件箱 (`_inbox_{agentName}.jsonl`)，agent 间 intervention request/response
  - 文件：`apps/api/src/agent/InboxManager.ts`
- [x] **MilestoneBroadcaster**：`file_produced` 和 `phase_complete` 事件广播
  - 文件：`apps/api/src/agent/MilestoneBroadcaster.ts`
- [x] **Agent Directory**：每个 agent 独立目录 (`_agent_{name}/CLAUDE.md` + `.claude/memory/` + `.claude/skills/`)
  - 文件：`apps/api/src/agent/AgentDirectoryManager.ts`

### 顺序编排

- [x] **Sequential mode**：`orchestrationMode: 'sequential'` → 只启动第一个 agent，done 后自动启动下一个
  - 文件：`apps/api/src/ws/handler.ts` (`sequentialQueues`, `startNextSequential`)

### 权限代理

- [x] **permission_request 解析**：EventParser 解析 + WebSocket 推送权限卡片 + 120s 超时 auto-deny
  - 已知限制：Claude Code `--print` 模式不发出 permission_request 事件（#10）

### Provider 抽象层

- [x] **AbstractProvider 接口**：`start/sendPrompt/write/stop/onEvent/isAlive` + `UnifiedAgentEvent` 标准化
  - 文件：`apps/api/src/agent/providers/base.ts`
- [x] **ClaudeCodeProvider**：`docker run -i` REPL 模式
  - 文件：`apps/api/src/agent/providers/claude-code.ts`
- [x] **ProviderFactory**：注册机制 + `init()` 启动注册
  - 文件：`apps/api/src/agent/providers/factory.ts`
- [x] **Fallback ClaudeCodeProcess**：one-shot `docker run --rm` 兼容路径
  - 文件：`apps/api/src/agent/ClaudeCodeProcess.ts`
- [x] **EventParser.toUnified()**：ParsedEvent → UnifiedAgentEvent 转换
  - 文件：`apps/api/src/agent/EventParser.ts`

### Turn 路由

- [x] **@mention 匹配**：`normalizeAgentHandle` + `matchAgentByHandle`（精确 → 前缀）
- [x] **默认 Agent 选择**：solo → code-agent, group → planner
- [x] **测试覆盖**：`apps/api/src/agent/turns.test.ts`

### 工作区管理

- [x] **WorkspaceManager**：git stash snapshot + rollback + getChanges
  - 文件：`apps/api/src/agent/WorkspaceManager.ts`
- [x] **FileTree**：前端文件树组件 + 后端 workspace API
  - 文件：`apps/web/src/components/FileTree.tsx`, `apps/api/src/routes/workspace.ts`

---

## Tier 1: 多平台 Provider 接入 🟡

> **来源：** Phase 4a Multi-Provider

**目标：** 至少接入 2 个主流 Agent 平台；用户可自建 Agent；Agent 联系人卡片展示头像/名称/能力标签。

- [x] **Provider 接口定义**：`AbstractProvider` + capabilities 声明
- [x] **Claude Code Provider**：完整实现（REPL + one-shot fallback）
- [x] **Agent DB 扩展**：Agent 模型新增 `provider` (default: "claude-code") + `providerConfig` (JSON) 字段
  - → 迁移至 `2026-05-26-multi-provider-agents.md` Task 1
- [x] **第二平台 Provider**（Codex 或 OpenCode）：
  - → 迁移至 `2026-05-26-multi-provider-agents.md` Task 2 + Task 3
- [x] **Agent 创建 UI**：创建/编辑表单新增 provider 下拉选择 + 对应配置字段（model、endpoint 等）
  - → 迁移至 `2026-05-26-multi-provider-agents.md` Task 4
- [x] **用户 Provider 配置页**：每种 provider 的 API key / base URL 配置
  - → 迁移至 `2026-05-26-multi-provider-agents.md` Task 11
- [x] **Agent 联系人卡片**：在 SessionList 和 ChatView 中展示头像、名称、能力标签（如"代码生成"/"代码审查"/"部署运维"）、在线状态
  - 文件：`apps/web/src/components/SessionList.tsx`, `ChatView.tsx`
- [x] **Agent Card 差异化渲染**：根据 `agent.provider` 渲染不同活动流区域
  - → 迁移至 `2026-05-26-multi-provider-agents.md` Task 5

---

## Tier 2: Task-to-Agent 路由 🟡

> **来源：** `2026-05-23-task-agent-routing.md`

**目标：** 任务不再走 BullMQ one-shot 容器，改为路由到群内已有 Agent 的 REPL 通道。Agent 负载均衡 + 缺失检测 + Planner 感知群成员。

### 2.0 Agent 进程注册（修复 REPL 复用）✅

> **2026-05-23 完成**

- [x] **启用 REPL 模式**：`ENABLE_PERSISTENT_REPL = true`，解除硬编码关闭
  - 文件：`apps/api/src/ws/handler.ts`
- [x] **首次启动注册**：命名 Agent 首次消息 → `ProviderFactory.create('claude-code')` → `agentProcesses.set(agentName, ...)` + `agentCurrentMessage.set(agentName, msgId)`
- [x] **复用路径**：同 agent 第二条消息 → `agentProcesses.get(agentName)` → `sendPrompt(subPrompt)` 复用进程
- [x] **闭包修复**：`agentCurrentMessage: Map<agentName, msgId>` 解决事件处理器 `messageId` 闭包捕获问题；done 后 `accumulatedContent = ''` 重置
- [x] **资源清理**：`cleanupSessionResources` 和 `handleStopAgent` 清理 `agentCurrentMessage` + `agentProcesses`

### 2.1 后端：任务分发到 REPL Agent ✅

> **2026-05-23 完成**

- [x] **`dispatchTasksToAgents()`**：拓扑排序 → 按 agentType 匹配群内 Agent → 负载均衡（选队列最短）→ 入队 → `processNextInQueue()`
  - 文件：`apps/api/src/ws/handler.ts`
- [x] **Agent 负载均衡**：同类型多个 Agent 时选队列最短的（`bestLoad` 追踪）
- [x] **任务队列 per Agent**：`agentTaskQueues: Map<agentName, AgentTaskQueue>` 维护独立任务队列
- [x] **`buildTaskPrompt(task)`**：注入任务 title/description/expectedOutput/dependsOn
- [x] **`processNextInQueue()`**：从队列取任务 → 查 `agentProcesses` → REPL 复用 → `sendPrompt(taskPrompt)` → 广播 `task_assigned`
- [x] **`startTaskAgent()`**：Agent 不在线时启动新 REPL Provider 执行任务
- [x] **REPL done 回调**：检测 `agentCurrentTask` → 广播 `task_completed`/`task_failed` → `processNextInQueue()` 执行下一个
- [x] **Agent 缺失通知**：无匹配类型 Agent 时广播 `agent_missing` WS 消息
- [x] **`topologicalSort` 导出**：从 `TaskQueue.ts` 导出供 handler 使用
- [x] **移除 BullMQ one-shot worker**：`index.ts` 不再调用 `startWorker()`；所有 task 执行通过 REPL 分发。保留 `TaskQueueManager` 仅用于 `drain()` 和 `shutdown()`
- [x] **handleRetryTask 迁移**：retry 不再走 `taskQueueManager.retryTask()`，改为直接将 task 插入 `agentTaskQueues` → `processNextInQueue()` REPL 分发
- [x] **新增 WS 消息类型**：`task_assigned`, `task_completed`, `task_failed`, `agent_missing`

### 2.2 前端：DAG + AgentCard 联动 ✅

> **2026-05-23 完成**

- [x] **task_assigned 事件**：`useChat.ts` 处理 → `store.setTaskAgent()` → 更新 task status + 关联 agentName
- [x] **DAG 节点显示 assigned agent**：`TaskDAG.tsx` 节点在 agentType 下方显示 `↳ agentName`（紫色）
- [x] **AgentCard 任务状态**：顶部紫色 banner 显示 `🔧 {task.title}` + 队列计数 `{N} queued`
- [x] **TaskState 扩展**：新增 `assignedAgentId`, `assignedAgentName`；状态新增 `queued`
- [x] **agentCurrentTask / agentTaskCounts 状态**：`appStore.ts` 新增 `setTaskAgent` action + 两个 Map
- [x] **task_completed/failed 清理**：完成时自动清除 `agentCurrentTask`

### 2.3 Agent 缺失处理 ✅

> **2026-05-23 完成**

- [x] **Planner 感知群成员**：Planner prompt 注入当前群聊 Agent 列表（name, displayName, description）及 `missingAgents` JSON 格式说明
  - 文件：`apps/api/src/ws/handler.ts` (prompt 构建)
- [x] **`findClosestAgent()`**：精确匹配 → 前缀匹配 → code-agent 兜底
  - 文件：`apps/api/src/agent/turns.ts`
- [x] **缺失 Agent 自动兜底**：`dispatchTasksToAgents()` 中无精确匹配时调用 `findClosestAgent`，fallback 成功则自动分配并广播（含 `fallbackAgent` 字段）
- [x] **`agent_missing` 增强**：携带 `suggestedAgent` (name/displayName/description) 和 `fallbackAgent`（如果已兜底）
- [x] **前端通知**：`useChat.ts` 收到 `agent_missing` → 以系统消息气泡通知用户（显示兜底结果或建议添加的 Agent 信息）

### 2.4 失败降级：Main Agent 重新规划

> **关联：** Tier 0 失败处理已知不足（重试耗尽后仅阻塞，未反馈 Main Agent）

- [x] **错误上下文收集**：任务重试耗尽时，自动收集：最后一次错误日志、任务 prompt、前置依赖产出、当前文件树
- [x] **`replan_failed_task` WS 消息**：将收集的上下文发给 Main Agent，Main Agent 分析失败原因并输出修正后的 TaskPlan（可为单个任务或子 DAG）
  - 文件：`apps/api/src/ws/handler.ts` (新增消息类型)
- [x] **Main Agent 重新规划 prompt**：注入"该任务已失败 N 次，错误日志如下，请分析原因并给出修正方案"
- [x] **前端失败节点操作**：DAG 失败节点新增"让 Main Agent 重新规划"按钮（替代仅手动重试）
  - 文件：`apps/web/src/components/TaskCard.tsx`, `TaskDAG.tsx`
- [x] **降级策略链**：自动重试 → 重新规划 → 人工介入（按优先级升级）

---

## Tier 3: 代码冲突与消息增强 🔜

### 3.1 代码冲突检测 ✅

> **2026-05-23 完成**（基础版；Diff 集成视图中橙色高亮延后至 Phase 4 Tier 0）

- [x] **并发修改检测**：`perSessionFileMods` Map 追踪 Write/Edit 工具调用 → done 时 `detectConflicts()` 检查同一文件被多 Agent 修改
  - 文件：`apps/api/src/ws/handler.ts` (trackFileMod, detectConflicts, clearFileMods)
- [x] **`conflict_detected` WS 消息**：携带 `conflicts[{filePath, agents[]]` 广播
- [x] **前端通知**：`useChat.ts` 以系统消息气泡列出冲突文件和涉及的 Agent

### 3.2 状态面板降噪 ✅

> **2026-05-23 完成**

- [x] **视图模式切换**：AgentStatusPanel 新增三模式按钮 [详细] [聚合] [仅异常]
  - **详细**：全部展开，保留调试价值（当前行为）
  - **聚合**：空闲 Agent 折叠为单行状态条，点击展开；顶部显示概览文字
  - **仅异常**：只显示有 permission_request 或非空闲的 Agent
- [x] **Agent 卡片折叠**：`collapsed` prop → 渲染单行 `{displayName} {status}` 状态条；运行中自动展开；点击展开
- [x] **概览条**：面板顶部显示 `"3/5 运行 · 2 空闲"` 计数 + 聚合模式下显示 `"CodeAgent 正在 Write(src/index.ts)"`
- [x] **Agent 排序**：running → done → idle，运行中优先显示

### 3.3 可交互 TaskDAG ✅

> **2026-05-23 完成**

- [x] **节点拖拽开启**：`nodesDraggable={true}` — 可自由调整节点位置
- [x] **依赖边拖拽创建**：`nodesConnectable={true}` + `onConnect` → 从 source Handle 拖线到 target Handle 创建新依赖 → 回调 `onConnectDep` 通知父组件
- [x] **右键菜单**：节点右键 → [编辑描述] [删除任务]，固定定位弹出菜单
- [x] **动画边**：running 状态任务的依赖边添加动画效果
- [x] **queued 样式**：`STATUS_STYLES` 新增 `queued` 状态（紫色边框 `#5E5CE6`）
- [x] **Handle 尺寸增大**：target/source Handle 10×10px（便于拖线操作）
- [x] **Grid background**：`<Background>` 组件添加网格背景

### 3.4 Main Agent 追问 ✅

> **2026-05-23 完成**（system prompt 层面）

- [x] **追问行为强化**：Planner system prompt 增加「需求不明确时主动追问」行为准则，含追问示例（技术栈、目标平台、功能边界）
  - 文件：`apps/api/src/defaultAgents.ts`

### 3.5 消息增强 🟡

> **2026-05-23 部分完成；部署状态卡片延后至 Phase 4 Tier 2**

- [x] **复制消息**：`MessageBubble.tsx` 新增 hover 复制按钮（`navigator.clipboard.writeText`），2s 绿色勾确认
- [x] **部署状态卡片**：→ Phase 4 Tier 2（`deployment_status` WS 消息 + `DeployCard.tsx`）
- [x] **引用回复、删除、上下文管理**：→ Phase 4 Tier 3（#31 消息操作菜单已实现）

---

## 修改文件清单

### Tier 1
| 文件 | 改动 |
|------|------|
| `apps/api/prisma/schema.prisma` | Agent 模型新增 provider + providerConfig |
| `apps/api/src/agent/providers/codex.ts` | **新建** — Codex CLI Provider |
| `apps/api/src/agent/providers/opencode.ts` | **新建** — OpenCode CLI Provider |
| `apps/api/src/agent/providers/factory.ts` | 注册 codex/opencode provider |
| `apps/web/src/components/ProviderSettings.tsx` | **新建** — 用户 Provider 配置页 |
| `apps/web/src/components/AgentCard.tsx` | 差异化 provider 活动流 |
| `apps/web/src/components/SessionList.tsx` | Agent 能力标签 |

### Tier 2
| 文件 | 改动 |
|------|------|
| `apps/api/src/ws/handler.ts` | dispatchTasksToAgents, 任务队列, task_assigned 广播 |
| `apps/api/src/agent/turns.ts` | selectLeastLoaded, buildTaskPrompt, findClosestAgent |
| `apps/api/src/agent/TaskQueue.ts` | 移除 one-shot worker，保留 BullMQ 仅持久化 |
| `apps/api/src/defaultAgents.ts` | Planner prompt 注入群成员 |
| `packages/shared/src/types.ts` | TaskState 扩展; agent_missing WS 类型 |
| `apps/web/src/hooks/useChat.ts` | task_assigned/agent_missing 事件处理 |
| `apps/web/src/store/appStore.ts` | setTaskAgent action; TaskState 扩展 |
| `apps/web/src/components/TaskDAG.tsx` | 节点显示 assigned agent |
| `apps/web/src/components/AgentCard.tsx` | 任务 banner + 队列计数 |
| `apps/web/src/components/ChatView.tsx` | Agent 缺失确认弹窗 |

### Tier 3
| 文件 | 改动 |
|------|------|
| `apps/api/src/ws/handler.ts` | 代码冲突检测; 上下文管理 |
| `apps/web/src/components/ConflictResolver.tsx` | **新建** — 冲突裁决 UI |
| `apps/web/src/components/MessageBubble.tsx` | 消息操作（复制/引用/删除）、部署状态卡片 |

---

## 验证方案

1. **多 Provider**：创建 Agent 时选 Codex → 发送消息 → 验证走 Codex CLI 路径，事件正确转换为 UnifiedAgentEvent
2. **Task Routing**：群聊 Plan 提交 → 验证 task 分配到群内 Agent（非新容器）→ AgentCard 显示队列
3. **Agent 缺失**：Plan 指定不存在类型 → 验证弹窗 → 用户创建 Agent → 继续执行
4. **代码冲突**：两个 Agent 修改同一文件 → 验证橙色高亮 + 手动选择
5. **消息增强**：复制/引用/删除操作正常；部署状态卡片从 Building 到 Success 实时更新
