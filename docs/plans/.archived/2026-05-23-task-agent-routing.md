# Plan: Task-to-Agent 路由重构

## Context

当前 Phase 3 Orchestrator 存在两个核心问题：

1. **任务绕过群聊 Agent**：Planner 拆解的任务通过 BullMQ Worker 启动独立的 `docker run -i` 一次性容器执行，群聊中已有的 Agent 成员完全未被复用。这违背了 PRD 的设计原则——AgentHub 是消息转发层，任务的执行应该由群内 Agent 完成。

2. **Docker 容器名冲突**：上一个修复尝试将 `promptFileId` 从 `task-{id}` 改为 `{agentName}-{id}`，但由于多个并行任务使用同一个 agentName，Docker 容器名被截断为相同的 12 字符前缀，导致 `Conflict. The container name is already in use`。

根本原因：当前架构将"任务执行"和"Agent 通信"视为两个独立通道，而正确的做法是**统一为一个通道**——任务就是发给群内 Agent 的一条消息。

## 目标架构

```
Planner 拆解 Plan
  ↓
handleConfirmPlan 解析每个 task 的 agentType
  ↓
匹配群内已有 Agent 实例（按 agentId，支持多人同类型不同专长）
  ↓
┌─ task-1 (CodeAgent) → 分配给 群内的CodeAgent → REPL sendPrompt()
├─ task-2 (CodeAgent) → 分配给 群内的CodeAgent → REPL sendPrompt()  [并行]
├─ task-3 (CodeAgent) → 分配给 群内的CodeAgent → 排队等待 task-1 完成       [串行]
├─ task-4 (ReviewAgent) → 群内无此类型 → 提示用户添加/匹配近似Agent
└─ ...
  ↓
Agent 通过现有 REPL 通道接收 prompt → 执行 → done 事件携带 taskId
  ↓
WebSocket 推送 task_completed/task_failed → 前端更新 DAG + AgentCard
```

## 实现分两个 Tier

### Tier 1: 核心路由（本次实现）

任务不再走 BullMQ one-shot 容器，改为通过群内 Agent 的 REPL 通道投递。

### Tier 2: Agent 缺失处理 + Planner 感知（依赖 Tier 1）

Planner 感知群内成员，智能分配；缺失 Agent 时交互式提示用户。

---

## Tier 1: 任务路由到群内 Agent

### 1.1 后端改造

#### A. 启用 TaskQueue 的新分发模式

当前 `TaskQueue.startWorker()` 为每个 task 启动独立 `ClaudeCodeProcess`。需要新增一个 **REPL 分发模式**，绕过 BullMQ Worker，直接向群内 Agent 的 REPL provider 投递 prompt。

在 `handler.ts` 中新增 `dispatchTasksToAgents()`:

```ts
async function dispatchTasksToAgents(
  sessionId: string,
  planId: string,
  tasks: TaskNode[],
  sandbox: SandboxInfo,
): Promise<void> {
  // 1. 获取群内 Agent 列表
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: true },
  });

  // 2. 建立 agentType → Agent实例[] 的映射
  const agentsByType = new Map<string, Agent[]>();
  for (const sa of sessionAgents) {
    const list = agentsByType.get(sa.agent.displayName) ?? [];
    list.push(sa.agent);
    agentsByType.set(sa.agent.displayName, list);
  }

  // 3. DAG 拓扑排序，分 layer 执行
  const layers = topologicalSort(tasks);

  // 4. 每个 agent 维护自己的任务队列
  // agentId → { queue: TaskNode[], current: TaskNode | null }
  const agentQueues = new Map<string, AgentTaskQueue>();

  for (const layer of layers) {
    for (const task of layer) {
      const candidates = agentsByType.get(task.agentType) ?? [];
      if (candidates.length === 0) {
        // → Tier 2: 缺失 Agent 处理
        broadcast(sessionId, {
          type: 'agent_missing',
          planId, taskId: task.id,
          agentType: task.agentType,
          taskTitle: task.title,
        });
        continue;
      }
      // 选择负载最低的候选 Agent
      const agent = selectLeastLoaded(candidates, agentQueues);
      enqueueTaskForAgent(agentQueues, agent, task, planId, sessionId, sandbox);
    }
  }

  // 5. 触发每个 agent 开始执行队列中的第一个任务
  for (const [agentId, queue] of agentQueues) {
    processNextInQueue(sessionId, agentId, queue, sandbox);
  }
}
```

#### B. 向 REPL Agent 投递任务 prompt

```ts
function enqueueTaskForAgent(
  agentQueues: Map<string, AgentTaskQueue>,
  agent: Agent,
  task: TaskNode,
  planId: string,
  sessionId: string,
  sandbox: SandboxInfo,
): void {
  if (!agentQueues.has(agent.id)) {
    agentQueues.set(agent.id, { queue: [], current: null, planId, sessionId });
  }
  agentQueues.get(agent.id)!.queue.push(task);
}

function processNextInQueue(
  sessionId: string,
  agentId: string,
  agentQueue: AgentTaskQueue,
  sandbox: SandboxInfo,
): void {
  if (agentQueue.queue.length === 0) {
    agentQueues.delete(agentId);
    return;
  }

  const task = agentQueue.queue.shift()!;
  agentQueue.current = task;

  // 查找此 agent 是否有运行的 REPL provider
  const procMap = agentProcesses.get(sessionId);
  const agentName = /* lookup agent.name from DB or cache */;
  const procInfo = procMap?.get(agentName);

  if (procInfo?.provider.isAlive()) {
    // 向现有 REPL 进程注入任务
    const taskPrompt = buildTaskPrompt(task, agentQueue.planId);
    procInfo.provider.sendPrompt(taskPrompt);

    broadcast(sessionId, {
      type: 'task_assigned',
      planId: agentQueue.planId,
      taskId: task.id,
      agentId,
      agentName,
    });
  } else {
    // Agent 不在线，启动新的 REPL provider
    // （使用现有 handler.ts 中的 REPL 启动逻辑）
    startAgentForTask(sessionId, agentId, task, sandbox);
  }
}
```

#### C. Agent done 事件关联 taskId

当 agent 完成执行时（`Agent done`），需要携带 `taskId` 以便前端更新 DAG：

```ts
// 在 agent done 处理中:
broadcast(sessionId, {
  type: 'task_completed',
  planId, taskId, agentId,
  output: fullContent,
});

// 触发同一 agent 的下一个任务
processNextInQueue(sessionId, agentId, agentQueues.get(agentId), sandbox);
```

#### D. 移除 BullMQ task execution worker

`TaskQueue.startWorker()` 中的 one-shot `ClaudeCodeProcess` 逻辑不再使用。保留 BullMQ 仅用于 Plan 的持久化和重试队列（可选），但实际执行通过 REPL 通道。

### 1.2 前端改造

#### A. task_assigned 事件处理

```ts
// useChat.ts 新增
case 'task_assigned':
  store.updateTaskStatus(data.planId, data.taskId, 'running');
  // 关联 agentId 到 task，用于 AgentCard 显示
  store.setTaskAgent(data.planId, data.taskId, data.agentId, data.agentName);
  break;
```

#### B. DAG 节点显示 assigned agent

`TaskDAG.tsx` 中每个节点显示被分配的 Agent 名称（如 "CodeAgent"），状态变化时颜色/图标更新。

#### C. AgentCard 任务执行状态

AgentCard 新增：
- 顶部 banner："🔨 正在执行: {task.title}"（当有 current task 时）
- 任务队列指示器："队列: 3 个待执行"
- Activity feed 事件关联 task 上下文

```
┌─ CodeAgent ──────────────────────────┐
│ 🔨 Task: 实现 Snake 核心逻辑 (2/5)    │
│ 队列: 数据模型 → UI渲染 → 样式打磨    │
│                                       │
│ 💭 正在分析 Snake 类的移动逻辑...     │
│ 🔧 Write(js/snake.js)                │
│ 📋 tool_result: File created         │
└───────────────────────────────────────┘
```

### 1.3 TaskState 扩展

```ts
// packages/shared/src/types.ts
export interface TaskState {
  taskId: string;
  planId: string;
  title: string;
  agentType: string;
  status: 'waiting' | 'queued' | 'running' | 'done' | 'failed';
  dependsOn: string[];
  expectedOutput: string;
  priority: 'high' | 'medium' | 'low';
  description: string;
  // 新增:
  assignedAgentId?: string;     // 实际分配的 Agent ID
  assignedAgentName?: string;   // 实际分配的 Agent 显示名
}
```

状态新增 `queued`：任务已分配给 Agent 但尚未开始执行。

---

## Tier 2: Planner 感知 + Agent 缺失处理

### 2.1 Planner 感知群成员

Planner 的 system prompt 中注入当前群聊的 Agent 列表：

```
## 当前群聊成员
- CodeAgent (code-agent): 全栈代码开发
- CodeAgent (frontend-specialist): 专注前端界面设计
- DevOpsAgent (devops-agent): 部署运维

请根据成员专长分配任务。agentType 仅限以上成员。
如需其他类型 Agent，在 plan 的 missingAgents 字段中列出。
```

Planner 的 TaskPlan JSON 扩展：

```json
{
  "planTitle": "...",
  "tasks": [
    {
      "id": "task-1",
      "agentType": "CodeAgent",
      "suggestedAgent": "frontend-specialist",
      ...
    }
  ],
  "missingAgents": [
    {
      "name": "review-agent",
      "displayName": "ReviewAgent",
      "description": "代码审查专家，检查安全漏洞和代码质量",
      "reason": "需要审查前端代码的安全性"
    }
  ]
}
```

### 2.2 Agent 缺失交互流程

```
Plan 提交 → 检测 missingAgents 非空
  ↓
WebSocket → { type: 'agent_missing', agents: [...] }
  ↓
前端弹出确认卡片（每个缺失 Agent 一个卡片或一个列表）:
  ┌──────────────────────────────────────────┐
  │ 📋 此计划需要以下 Agent：                 │
  │                                          │
  │ ┌ ReviewAgent ─────────────────────────┐ │
  │ │ Planner 建议：                        │ │
  │ │   名称: ReviewAgent                   │ │
  │ │   描述: 代码审查专家，检查安全漏洞     │ │
  │ │   理由: 需要审查前端代码的安全性      │ │
  │ │                                       │ │
  │ │ 你的补充（可选）：                    │ │
  │ │   名称: [ReviewAgent            ]     │ │
  │ │   描述: [专注前端安全审查         ]   │ │
  │ │   职责: [检查XSS/CSRF/敏感信息泄露]  │ │
  │ └───────────────────────────────────────┘ │
  │                                          │
  │ [确认添加] [跳过，匹配近似Agent]          │
  └──────────────────────────────────────────┘
  ↓
用户编辑 Agent 属性（可选）→ 点击"确认添加"：
  → 后端以用户修改后的属性（合并 Planner 建议 + 用户补充）创建 Agent
  → prisma.agent.create({ name, displayName, description, systemPrompt })
  → SessionAgent.create({ sessionId, agentId })
  → 重新 dispatchTasksToAgents() 包含新 Agent
  → Agent 立即参与任务执行
用户选择"跳过"：
  → findClosestAgent(agentType, sessionAgents)
  → 例如 ReviewAgent → 匹配 CodeAgent（相似度最高）
  → 提示用户已自动匹配："未添加 ReviewAgent，已自动分配给 CodeAgent"
```

**用户可编辑的属性：**

| 字段 | Planner 提供 | 用户可修改 | 说明 |
|------|-------------|-----------|------|
| `name` | 建议值（英文slug） | ✅ | 如 `security-reviewer` |
| `displayName` | 建议值 | ✅ | 如 `ReviewAgent` |
| `description` | 建议值 | ✅ | Agent 能力简述 |
| 职责说明 | 建议值 | ✅ | 自由文本，会注入 systemPrompt |

这些属性合并后由后端 `prisma.agent.create()` 创建 Agent 记录，并在 `handleConfirmPlan` 中通过 `AgentDirectoryManager.initialize()` 生成 CLAUDE.md。

如果用户点击"跳过"，该任务通过 `findClosestAgent()` 匹配群内已有 Agent，并在 DAG 节点上标注"近似匹配"。

### 2.3 近似 Agent 匹配

```ts
function findClosestAgent(
  neededType: string,
  available: Agent[],
): Agent | null {
  // 优先级: 同类型 > 同前缀(Code→CodeAgent) > 任意可用
  const exact = available.find(a => a.displayName === neededType);
  if (exact) return exact;

  const prefix = available.find(a =>
    a.displayName.includes(neededType.replace('Agent', ''))
  );
  if (prefix) return prefix;

  // 默认回退到 CodeAgent
  return available.find(a => a.name === 'code-agent') ?? available[0] ?? null;
}
```

---

## 状态展示：DAG 与 AgentCard 的分工

| 层级 | DAG 卡片（聊天区） | AgentCard（右侧面板） |
|------|-------------------|---------------------|
| **粒度** | 任务级别 | 事件级别 |
| **更新频率** | 状态变更时（waiting→queued→running→done） | 实时流（每秒多次） |
| **显示内容** | 节点颜色+图标+assigned agent名 | 当前 task banner + 活动流 |
| **示例** | `task-2 🔄 CodeAgent` | `🔨 Task: 实现 Snake 类` + `💭 正在分析...` |

**关键**：`agent_status` 事件新增 `taskId` 字段。当 agent 在执行 task 时，其所有活动事件都带上 `taskId`。AgentCard 据此展示对应的 task 标签。

---

## 修改文件清单

### 后端
| 文件 | 改动 |
|------|------|
| `apps/api/src/ws/handler.ts` | 新增 `dispatchTasksToAgents()`, `processNextInQueue()`, agent 缺失检测；修改 `handleConfirmPlan` 调用新分发逻辑 |
| `apps/api/src/agent/TaskQueue.ts` | 移除 one-shot worker，保留 BullMQ 队列仅用于持久化/重试；或新增 `REPLTaskDispatcher` |
| `apps/api/src/agent/turns.ts` | 新增 `buildTaskPrompt()`, `findClosestAgent()` |
| `apps/api/src/defaultAgents.ts` | Planner systemPrompt 注入群成员信息 |
| `packages/shared/src/types.ts` | `TaskState` 新增 `assignedAgentId`, `assignedAgentName`；新增 `agent_missing` WS 消息类型 |

### 前端
| 文件 | 改动 |
|------|------|
| `apps/web/src/hooks/useChat.ts` | 新增 `task_assigned`, `agent_missing` 事件处理 |
| `apps/web/src/store/appStore.ts` | 新增 `setTaskAgent()` action；`TaskState` 接口扩展 |
| `apps/web/src/components/TaskDAG.tsx` | 节点显示 assigned agent 名称 |
| `apps/web/src/components/AgentCard.tsx` | 新增 task banner、队列计数 |
| `apps/web/src/components/ChatView.tsx` | 新增 Agent 缺失确认弹窗 |

---

## 验证方案

1. **单 Agent 串行**：创建群聊包含 1 个 CodeAgent，Planner 拆解 3 个 CodeAgent 任务 → 验证 3 个任务串行执行，AgentCard 显示队列进度
2. **多 Agent 并行**：群聊包含 CodeAgent + ReviewAgent，Plan 中 task-1(Code)+task-2(Code)+task-3(Review)，task-1/task-3 无依赖 → 验证 task-1 和 task-3 并行执行，task-2 等 task-1 完成
3. **Agent 缺失**：Plan 中指定 DevOpsAgent 但群内无此类型 → 验证前端弹出确认卡片，添加后继续执行
4. **DAG 状态同步**：任务执行过程中检查 DAG 节点状态变化是否正确（waiting→queued→running→done）
5. **Docker 容器名冲突**：不复现——任务不再创建独立容器
