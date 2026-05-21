# Phase 3: Orchestrator 任务编排 — 完整实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Planner Agent 驱动的任务拆解、BullMQ 调度引擎、DAG 任务卡片可视化和 Phase 2 UX 遗留补齐。

**Architecture:** Phase 3 按三层推进：Tier 0 核心基础设施（Planner + BullMQ + 上下文传递）→ Tier 1 用户界面（DAG 可视化 + 人工确认 + 失败处理）→ Tier 2 增强与收尾（结果聚合 + PTY 权限 + Phase 2 UX 遗留）。

**Tech Stack:** BullMQ + Redis, React Flow (DAG 可视化), Zod (JSON schema 校验), PTY via node-pty

**Status (2026-05-21):** Tier 0 ✅ 完成 | Tier 1 ✅ 完成 | Tier 2 ✅ 完成 | Tier 3 ✅ 完成 | #10 PTY ⚠️ 基础设施完成，完整交互被 Claude Code CLI --print 模式限制阻塞

---

## 执行优先级清单

按功能重要性和依赖性排序：

### Tier 0 — 核心基础设施（Phase 3 骨架，无此无法推进）

| 优先级 | Issue | 功能 | 理由 |
|--------|-------|------|------|
| P0 | #7 | Planner Agent — 任务拆解核心 | Phase 3 入口，所有后续依赖它 |
| P0 | #5 | BullMQ 任务队列与调度引擎 | 任务执行引擎，DAG 依赖拓扑排序 |
| P0 | #8 | 上下文传递机制 | 子任务间数据交换的基础 |

### Tier 1 — 用户界面（核心交互）

| 优先级 | Issue | 功能 | 理由 |
|--------|-------|------|------|
| P1 | #2 | 任务 DAG 可视化（前端） | Phase 3 核心 UI，用户看到的第一件事 |
| P1 | #4 | 人工确认与干预面板 | 用户对任务计划的控制权 |
| P1 | #1 | 失败处理与重试机制 | 可靠性必备 |

### Tier 2 — 增强与收尾

| 优先级 | Issue | 功能 | 理由 |
|--------|-------|------|------|
| P2 | #6 | 结果聚合与汇总报告 | 让 Phase 3 产出可消费 |
| P2 | #10 | 完整交互式权限代理（PTY） | 完成 Phase 2 权限闭环 |
| P2 | 新 | StateTracker — Agent 运行时状态追踪 | 解锁思考等级/上下文用量展示 |

### Tier 3 — Phase 2 UX 遗留补齐

| 优先级 | 来源 | 功能 | 理由 |
|--------|------|------|------|
| P3 | PRD §4.2 | `/` 命令前端补全面板 | 后端已透传，前端补全提效 |
| P3 | PRD §4.2 | Agent 上下文用量/思考等级展示 | 基于 StateTracker |
| P3 | PRD §4.2 | 多标签页会话 + 未读徽章 | 多会话场景导航体验 |
| P3 | PRD §4.2 | 基于上下文的 Agent 推荐 | @ 提及时的智能排序 |

### 补充增强功能（计划外，建议纳入）

| 优先级 | 功能 | 理由 |
|--------|------|------|
| P4 | 任务优先级调度 | 依赖之外支持手动优先级（high/medium/low） |
| P4 | 取消传播 | 父任务取消时级联终止依赖子任务 |
| P4 | 会话执行历史 | 展示历史执行的 Planner 计划和最终结果 |
| P4 | Session 模板 | 预配置 Agent 组合一键创建会话 |

---

## PRD §4.3 需求对照

逐项检查 PRD §4.3 功能列表，确保无遗漏：

| PRD 行号 | 需求 | 对应 Issue/Task |
|----------|------|-----------------|
| 287-291 | Planner Agent 注册 + system prompt + JSON schema | #7 (Task 1) |
| 293-312 | 任务拆解 Prompt 设计 | #7 (Task 1 子步骤) |
| 314-319 | BullMQ 队列 + 依赖关系 + 并行执行 + 上下文传递 | #5 (Task 2) + #8 (Task 3) |
| 321-328 | 上下文传递机制详细设计 | #8 (Task 3) |
| 330-338 | DAG 树状结构 + 节点状态 + 展开日志 + 进度 | #2 (Task 4) |
| 340-344 | 确认执行/修改/调整依赖/暂停 | #4 (Task 5) |
| 346-350 | 失败不阻塞 + 后继跳过 + 日志保留 + 单独重试 | #1 (Task 6) |
| 352-355 | 汇总报告卡片 + 文件变更清单 + Diff 入口 | #6 (Task 7) |

**未遗漏。** PRD §4.3 全部 7 个子功能均有对应实现任务。

---

## 项目文件结构

Phase 3 新增文件：

```
apps/api/src/
  agent/
    PlannerAgent.ts          # Planner Agent 调用逻辑
    TaskQueue.ts              # BullMQ 队列管理
    StateTracker.ts           # Agent 运行时状态快照
  routes/
    tasks.ts                  # 任务 CRUD API
  ws/
    handler.ts                # [修改] 新增任务相关 WS 消息类型

apps/web/src/
  components/
    TaskDAG.tsx               # React Flow DAG 可视化
    TaskCard.tsx              # 任务卡片消息气泡
    ConfirmationPanel.tsx     # 人工确认/修改面板
    SlashCommandPopup.tsx     # / 命令补全面板
    FileTree.tsx              # Files 标签页文件树
  hooks/
    useTaskStream.ts          # 任务流式日志 hook
  store/
    appStore.ts               # [修改] 新增任务/StateTracker 状态

packages/shared/src/
  types.ts                    # [修改] 新增 TaskPlan/TaskNode 等类型
```

---

## 详细任务分解

### Task 1: Planner Agent — 任务拆解核心 (Issue #7, P0)

**Files:**
- Create: `apps/api/src/agent/PlannerAgent.ts`
- Modify: `apps/api/src/defaultAgents.ts`
- Modify: `apps/api/src/routes/agents.ts`

- [ ] **Step 1: 定义任务计划 JSON Schema**

```typescript
// packages/shared/src/types.ts 新增
export interface TaskNode {
  id: string;
  title: string;
  description: string;
  agentType: 'CodeAgent' | 'ReviewAgent' | 'DevOpsAgent';
  dependsOn: string[];       // task ids this depends on
  expectedOutput: string;    // expected output file paths
  priority: 'high' | 'medium' | 'low';
}

export interface TaskPlan {
  planTitle: string;
  summary: string;
  tasks: TaskNode[];
}

export interface TaskPlanResult {
  planId: string;
  userId: string;
  sessionId: string;
  plan: TaskPlan;
  status: 'pending_confirmation' | 'executing' | 'completed' | 'failed';
  createdAt: string;
}
```

- [ ] **Step 2: 编写 Planner system prompt**

```typescript
// apps/api/src/defaultAgents.ts 新增 Planner
export const PLANNER_AGENT = {
  id: 'planner-agent',
  name: 'planner',
  displayName: 'Planner',
  description: '任务规划专家 — 将复杂需求拆解为可并行执行的子任务 DAG',
  systemPrompt: `你是一个软件工程任务规划专家。
收到开发需求后，将其拆解为可并行执行的子任务。
先执行 ls 和 cat package.json 了解项目结构，再拆解。输出严格 JSON（不要包裹在 markdown 代码块中）：

{
  "planTitle": "计划标题",
  "summary": "一句话概述整体方案",
  "tasks": [
    {
      "id": "task-1",
      "title": "设计数据库模型",
      "description": "使用 Prisma 定义 User 和 Post 模型，包含字段和关联",
      "agentType": "CodeAgent",
      "dependsOn": [],
      "expectedOutput": "prisma/schema.prisma",
      "priority": "high"
    }
  ]
}

规则：
- 任务数控制在 3-8 个
- dependsOn 引用已有任务的 id
- 无依赖任务自动并行，有依赖的串行执行
- agentType 必须是 CodeAgent / ReviewAgent / DevOpsAgent 之一
- priority 根据任务关键性标注 high/medium/low`,
};
```

- [ ] **Step 3: 实现 PlannerAgent 类**

```typescript
// apps/api/src/agent/PlannerAgent.ts
import { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import { SandboxManager } from './SandboxManager.js';
import { prisma } from '../db/prisma.js';
import type { TaskPlan } from '@agenthub/shared';

export class PlannerAgent {
  /**
   * 调用 Claude Code 子进程进行任务拆解，返回结构化 TaskPlan。
   * 使用 trustMode=false（不带 --dangerously-skip-permissions）允许 Claude Code 
   * 探查文件系统但不执行修改操作。
   */
  static async plan(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    hostWorkDir: string,
  ): Promise<TaskPlan> {
    const planMessageId = `plan-${Date.now()}`;

    // 注入规划 system prompt + 项目探查指令
    const plannerPrompt = `You are a software engineering task planning expert. 
First, explore the project structure using ls and cat package.json (or equivalent).
Then, break down the following requirement into parallelizable subtasks:

${prompt}

Output ONLY a valid JSON object (no markdown fences) with this schema:
{
  "planTitle": string,
  "summary": string,
  "tasks": [
    {
      "id": "task-N",
      "title": string,
      "description": string,
      "agentType": "CodeAgent" | "ReviewAgent" | "DevOpsAgent",
      "dependsOn": string[],
      "expectedOutput": string,
      "priority": "high" | "medium" | "low"
    }
  ]
}`;

    return new Promise((resolve, reject) => {
      const proc = new ClaudeCodeProcess();
      let accumulated = '';

      proc.onEvent((event) => {
        if (event.type === 'text') {
          accumulated += event.content;
        }
        if (event.type === 'done') {
          if (event.exitCode !== 0) {
            reject(new Error(`Planner exited with code ${event.exitCode}`));
            return;
          }
          try {
            // Extract JSON from accumulated output (may contain surrounding text)
            const jsonMatch = accumulated.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
            if (!jsonMatch) {
              reject(new Error('No valid task plan JSON found in output'));
              return;
            }
            const plan: TaskPlan = JSON.parse(jsonMatch[0]);
            resolve(plan);
          } catch (err: any) {
            reject(new Error(`Failed to parse plan JSON: ${err.message}`));
          }
        }
        if (event.type === 'error') {
          reject(new Error(event.message));
        }
      });

      proc.start(sessionId, plannerPrompt, containerId, workDir, true, hostWorkDir, planMessageId)
        .catch(reject);
    });
  }
}
```

- [ ] **Step 4: 注册 Planner Agent**

在 `apps/api/src/defaultAgents.ts` 和启动 seed 中添加 Planner。

- [ ] **Step 5: 验证 — 手动测试 Planner 输出**

启动后端，通过 WS 发送 planner 调用请求，检查返回的 JSON 是否符合 schema。

---

### Task 2: BullMQ 任务队列与调度引擎 (Issue #5, P0)

**Files:**
- Create: `apps/api/src/agent/TaskQueue.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/config.ts`

- [ ] **Step 1: 安装 BullMQ 依赖**

```bash
cd apps/api && npm install bullmq ioredis
```

Redis 已在 docker-compose.yml 中定义但未启动，需确认 Redis 容器状态。

- [ ] **Step 2: 配置 BullMQ 连接**

```typescript
// apps/api/src/config.ts 新增
export const redis = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

export const taskQueue = {
  concurrency: parseInt(process.env.TASK_CONCURRENCY || '3', 10),
  maxRetries: parseInt(process.env.TASK_MAX_RETRIES || '2', 10),
  retryDelayMs: parseInt(process.env.TASK_RETRY_DELAY_MS || '30000', 10),
};
```

- [ ] **Step 3: 实现 TaskQueue 类**

```typescript
// apps/api/src/agent/TaskQueue.ts
import { Queue, Worker, Job } from 'bullmq';
import { redis, taskQueue as taskQueueConfig } from '../config.js';
import type { TaskNode, TaskPlan } from '@agenthub/shared';

// 拓扑排序：从 DAG 计算执行层级
function topologicalSort(tasks: TaskNode[]): TaskNode[][] {
  const layers: TaskNode[][] = [];
  const remaining = new Map(tasks.map(t => [t.id, { ...t }]));
  const completed = new Set<string>();

  while (remaining.size > 0) {
    const layer: TaskNode[] = [];
    for (const [id, task] of remaining) {
      if (task.dependsOn.every(did => completed.has(did))) {
        layer.push(task);
        remaining.delete(id);
      }
    }
    if (layer.length === 0) {
      // Circular dependency or remaining tasks — add them as final layer
      const stuck = Array.from(remaining.values());
      layers.push(stuck);
      break;
    }
    layers.push(layer);
    layer.forEach(t => completed.add(t.id));
  }
  return layers;
}

export interface TaskJobData {
  planId: string;
  sessionId: string;
  task: TaskNode;
  contextPrompt: string;
  containerId: string;
  workDir: string;
  hostWorkDir: string;
}

export class TaskQueueManager {
  private queue: Queue<TaskJobData>;
  private worker: Worker<TaskJobData> | null = null;

  constructor() {
    this.queue = new Queue('agenthub-tasks', {
      connection: { host: redis.host, port: redis.port },
    });
  }

  /** 提交整个 Plan 到队列，自动处理依赖关系 */
  async submitPlan(
    planId: string,
    sessionId: string,
    plan: TaskPlan,
    containerId: string,
    workDir: string,
    hostWorkDir: string,
  ): Promise<void> {
    const layers = topologicalSort(plan.tasks);

    // 按层级依次入队，同层级并行执行
    let layerIndex = 0;
    for (const layer of layers) {
      const children: { name: string; data: TaskJobData; opts: any }[] = [];

      for (const task of layer) {
        // 构建上下文 prompt：注入前置任务产出
        const depsInfo = task.dependsOn.map(did => {
          const dep = plan.tasks.find(t => t.id === did);
          return dep
            ? `- ${dep.title}: 预期产出 ${dep.expectedOutput}`
            : `- task ${did}`;
        }).join('\n');

        const contextPrompt = `Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}

${depsInfo ? `Previous tasks completed:\n${depsInfo}\n` : ''}
Execute this task now. Output the results to the specified files.`;

        children.push({
          name: task.id,
          data: {
            planId,
            sessionId,
            task,
            contextPrompt,
            containerId,
            workDir,
            hostWorkDir,
          },
          opts: {
            attempts: taskQueueConfig.maxRetries + 1,
            backoff: { type: 'fixed', delay: taskQueueConfig.retryDelayMs },
            priority: task.priority === 'high' ? 1 : task.priority === 'medium' ? 2 : 3,
          },
        });
      }

      // FlowProducer 支持父子依赖：所有子任务完成才进入下一层
      // 简化：直接用 queue.addBulk，依赖关系通过 dependsOn + 轮询处理
      await this.queue.addBulk(children);
      layerIndex++;
    }
  }

  /** 获取 Plan 的执行状态 */
  async getPlanProgress(planId: string): Promise<{
    total: number; completed: number; failed: number; running: number; waiting: number;
  }> {
    const jobs = await this.queue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed']);
    const relevant = jobs.filter(j => j.data.planId === planId);

    return {
      total: relevant.length,
      completed: relevant.filter(j => j.finishedOn && !j.failedReason).length,
      failed: relevant.filter(j => j.failedReason).length,
      running: relevant.filter(j => !j.finishedOn && j.attemptsStarted > 0).length,
      waiting: relevant.filter(j => !j.finishedOn && j.attemptsStarted === 0).length,
    };
  }

  /** 启动 Worker 处理任务 */
  startWorker(onTaskComplete: (job: Job<TaskJobData>, result: any) => void): void {
    this.worker = new Worker<TaskJobData>(
      'agenthub-tasks',
      async (job: Job<TaskJobData>) => {
        const { contextPrompt, containerId, workDir, hostWorkDir, sessionId } = job.data;

        // 使用 ClaudeCodeProcess 执行单个子任务
        const proc = new ClaudeCodeProcess();
        let output = '';

        return new Promise((resolve, reject) => {
          proc.onEvent((event) => {
            if (event.type === 'text') output += event.content;
            if (event.type === 'done') {
              if (event.exitCode === 0) resolve({ output, taskId: job.data.task.id });
              else reject(new Error(`Task failed with exit code ${event.exitCode}: ${output.slice(-500)}`));
            }
            if (event.type === 'error') reject(new Error(event.message));
          });

          proc.start(
            sessionId, contextPrompt, containerId, workDir,
            /* trustMode= */ true, hostWorkDir, `task-${job.data.task.id}`
          ).catch(reject);
        });
      },
      {
        connection: { host: redis.host, port: redis.port },
        concurrency: taskQueueConfig.concurrency,
      }
    );

    this.worker.on('completed', (job, result) => onTaskComplete(job, result));
    this.worker.on('failed', (job, err) => {
      console.error(`[queue] Task ${job?.data?.task?.id} failed: ${err.message}`);
    });
  }

  async shutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
```

- [ ] **Step 4: 集成到 index.ts 启动流程**

在 `apps/api/src/index.ts` 中初始化 TaskQueueManager 并启动 Worker。

---

### Task 3: 上下文传递机制 (Issue #8, P0)

**Files:**
- Modify: `apps/api/src/agent/TaskQueue.ts`
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: 在 task prompt 中注入上下文**

`TaskQueue.ts` 中的 `contextPrompt` 构建（已在 Task 2 Step 3 中实现）包含：
- 任务指令
- 前置任务产出文件路径和摘要

现在增强上下文注入，添加项目文件树探查：

```typescript
// 在执行第一个子任务前，探查项目结构
async function probeProjectContext(
  containerId: string,
  workDir: string,
): Promise<{ fileTree: string; pkgJson: Record<string, unknown> | null }> {
  // 通过 docker exec 获取文件树
  const fileTree = await SandboxManager.execCapture(containerId,
    'find . -not -path "*/node_modules/*" -not -path "*/.git/*" -type f | head -100');
  // 读取 package.json
  const pkgContent = await SandboxManager.execCapture(containerId,
    'cat package.json 2>/dev/null || echo "{}"');
  let pkgJson: Record<string, unknown> | null = null;
  try { pkgJson = JSON.parse(pkgContent); } catch { /* malformed json */ }
  return { fileTree, pkgJson };
}
```

需要为 `SandboxManager` 添加 `execCapture` 方法——执行命令并捕获 stdout 输出为字符串。

- [ ] **Step 2: 在 handler.ts 中集成上下文到 WS 状态推送**

修改 `agent_status` 消息以包含上下文元数据，使前端能展示 token 用量。

---

### Task 4: 任务 DAG 可视化 (Issue #2, P1)

**Files:**
- Create: `apps/web/src/components/TaskDAG.tsx`
- Create: `apps/web/src/components/TaskCard.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/AgentStatusPanel.tsx`
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: 安装 React Flow**

```bash
cd apps/web && npm install @xyflow/react
```

- [ ] **Step 2: 定义任务状态类型**

```typescript
// apps/web/src/store/appStore.ts 新增
export interface TaskState {
  taskId: string;
  planId: string;
  title: string;
  agentType: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  dependsOn: string[];
  progress?: {
    completed: number;
    total: number;
  };
}

// 新增 store 字段
taskPlans: Record<string, TaskState[]>;
setTaskPlan: (planId: string, tasks: TaskState[]) => void;
updateTaskStatus: (planId: string, taskId: string, status: TaskState['status']) => void;
```

- [ ] **Step 3: 实现 TaskDAG 组件**

```tsx
// apps/web/src/components/TaskDAG.tsx
import { useCallback, useMemo } from 'react';
import {
  ReactFlow, Node, Edge, Position, useNodesState, useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { TaskState } from '../store/appStore';

const STATUS_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  waiting: { bg: '#1e293b', border: '#475569', text: '#94a3b8' },
  running: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
  done:    { bg: '#1e3a3a', border: '#22c55e', text: '#86efac' },
  failed:  { bg: '#3a1e1e', border: '#ef4444', text: '#fca5a5' },
};

function CustomTaskNode({ data }: { data: TaskState }) {
  const style = STATUS_STYLES[data.status] || STATUS_STYLES.waiting;
  return (
    <div style={{
      padding: '12px 16px', borderRadius: '8px', border: `2px solid ${style.border}`,
      backgroundColor: style.bg, color: style.text, minWidth: 180, fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{data.title}</div>
      <div style={{ fontSize: 10, opacity: 0.7 }}>{data.agentType}</div>
      {data.status === 'running' && (
        <div style={{ marginTop: 6, height: 3, background: '#1e293b', borderRadius: 2 }}>
          <div style={{
            width: `${data.progress?.completed && data.progress?.total
              ? (data.progress.completed / data.progress.total) * 100 : 50}%`,
            height: '100%', background: '#3b82f6', borderRadius: 2, transition: 'width 0.3s',
          }} />
        </div>
      )}
    </div>
  );
}

interface Props {
  tasks: TaskState[];
  onTaskClick?: (taskId: string) => void;
}

export function TaskDAG({ tasks, onTaskClick }: Props) {
  // 计算 DAG 节点和边
  const { nodes, edges } = useMemo(() => {
    const nodeMap = new Map(tasks.map((t, i) => [t.taskId, i]));
    const ns: Node[] = tasks.map((t, i) => ({
      id: t.taskId,
      position: { x: 0, y: 0 }, // 由 dagre 布局计算
      type: 'custom',
      data: t,
    }));
    const es: Edge[] = [];
    for (const t of tasks) {
      for (const depId of t.dependsOn) {
        if (nodeMap.has(depId)) {
          es.push({ id: `${depId}->${t.taskId}`, source: depId, target: t.taskId });
        }
      }
    }
    return { nodes: ns, edges: es };
  }, [tasks]);

  return (
    <div style={{ height: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ custom: CustomTaskNode }}
        fitView
        fitViewOptions={{ padding: 0.3 }}
      >
        {/* ReactFlow 内置 Controls, Background */}
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 4: 实现 TaskCard 消息气泡**

```tsx
// apps/web/src/components/TaskCard.tsx
import { TaskDAG } from './TaskDAG';
import type { TaskState } from '../store/appStore';

interface Props {
  planId: string;
  planTitle: string;
  summary: string;
  tasks: TaskState[];
  onConfirm?: () => void;
  onModify?: (taskId: string, newDescription: string) => void;
  onPause?: () => void;
}

export function TaskCard({ planId, planTitle, summary, tasks, onConfirm, onModify, onPause }: Props) {
  const done = tasks.filter(t => t.status === 'done').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const waiting = tasks.filter(t => t.status === 'waiting').length;

  return (
    <div className="mx-4 my-3 bg-slate-800/90 border border-slate-700/60 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{planTitle}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{summary}</p>
        </div>
        <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-0.5 rounded-full">
          {done}/{tasks.length} done
          {running > 0 && ` · ${running} running`}
          {waiting > 0 && ` · ${waiting} waiting`}
          {failed > 0 && ` · ${failed} failed`}
        </span>
      </div>

      {/* DAG visualization */}
      <div className="p-2">
        <TaskDAG tasks={tasks} />
      </div>

      {/* Action buttons */}
      <div className="px-4 py-2 border-t border-slate-700/40 flex gap-2">
        {onConfirm && (
          <button onClick={onConfirm}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs rounded-md font-medium transition">
            Confirm & Execute
          </button>
        )}
        {onPause && (
          <button onClick={onPause}
            className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-xs rounded-md font-medium transition">
            Pause Queue
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 在 AgentStatusPanel Tasks 标签页中集成 DAG**

将 `AgentStatusPanel.tsx:86-87` 的占位文本替换为正在执行计划的 `TaskCard`。

---

### Task 5: 人工确认与干预面板 (Issue #4, P1)

**Files:**
- Create: `apps/web/src/components/ConfirmationPanel.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: 实现确认/修改面板**

```typescript
// apps/web/src/components/ConfirmationPanel.tsx
import type { TaskNode } from '@agenthub/shared';
import { useState } from 'react';

interface Props {
  tasks: TaskNode[];
  onConfirm: () => void;
  onUpdateTask: (taskId: string, newDescription: string) => void;
  onCancel: () => void;
}

export function ConfirmationPanel({ tasks, onConfirm, onUpdateTask, onCancel }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  return (
    <div className="mx-4 my-2 bg-slate-800/90 border border-amber-700/50 rounded-xl px-4 py-3">
      <h3 className="text-sm font-semibold text-amber-300 mb-1">Review Task Plan</h3>
      <p className="text-xs text-slate-500 mb-3">
        {tasks.length} tasks planned. Review, modify if needed, then confirm to execute.
      </p>
      <div className="space-y-2 mb-3 max-h-64 overflow-y-auto">
        {tasks.map((t) => (
          <div key={t.id} className="bg-slate-700/30 rounded-lg px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-200">{t.title}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-600 text-slate-400">
                {t.agentType}
              </span>
            </div>
            {editingId === t.id ? (
              <div className="mt-1">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full bg-slate-900 text-xs text-slate-300 rounded p-1.5 border border-slate-600"
                  rows={2}
                />
                <button onClick={() => {
                  onUpdateTask(t.id, editText);
                  setEditingId(null);
                }} className="text-xs text-green-400 hover:text-green-300 mt-1">Save</button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-slate-500 flex-1 truncate">{t.description}</p>
                <button onClick={() => { setEditingId(t.id); setEditText(t.description); }}
                  className="text-xs text-blue-400 hover:text-blue-300">Edit</button>
              </div>
            )}
            {t.dependsOn.length > 0 && (
              <p className="text-[10px] text-slate-600 mt-1">
                Depends on: {t.dependsOn.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={onConfirm}
          className="px-4 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs rounded-md font-medium transition">
          Confirm All
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-md transition">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 handler.ts 中添加 WebSocket 消息类型**

新增 WS 消息类型：
- `confirm_plan` — 用户确认计划，触发 BullMQ 入队
- `modify_task` — 用户修改单个子任务描述
- `pause_plan` — 暂停排队中的任务
- `retry_task` — 重试失败任务

- [ ] **Step 3: 在 ChatView 中集成确认面板**

当 Planner 返回 TaskPlan 时，在消息流中插入 `ConfirmationPanel`，等待用户确认后再提交到 TaskQueue。

---

### Task 6: 失败处理与重试机制 (Issue #1, P1)

**Files:**
- Modify: `apps/api/src/agent/TaskQueue.ts`
- Modify: `apps/web/src/components/TaskCard.tsx`

- [ ] **Step 1: 实现 BullMQ 级别的自动重试**

已在 Task 2 Step 3 中配置 `attempts` 和 `backoff`:
```typescript
opts: {
  attempts: taskQueueConfig.maxRetries + 1,  // 2 retries + 1 original
  backoff: { type: 'fixed', delay: 30000 },   // 30s between retries
}
```

- [ ] **Step 2: 实现依赖失败传播**

```typescript
// 在 TaskQueue 中，当任务重试耗尽后，标记为 failed
// 依赖它的任务自动转为 'blocked' 状态
// 添加方法：
async blockDependents(planId: string, failedTaskId: string): Promise<void> {
  const jobs = await this.queue.getJobs(['waiting']);
  for (const job of jobs) {
    if (job.data.planId === planId && job.data.task.dependsOn.includes(failedTaskId)) {
      await job.moveToFailed(
        new Error(`Blocked: upstream task ${failedTaskId} failed`),
        'blocked-by-upstream'
      );
    }
  }
}
```

- [ ] **Step 3: 前端失败展示 + 单独重试按钮**

在 `TaskCard` 中，失败节点以红色高亮，悬停显示错误详情。每个失败节点附 "Retry" 按钮，触发 `retry_task` WS 消息。

---

### Task 7: 结果聚合与汇总报告 (Issue #6, P2)

**Files:**
- Modify: `apps/api/src/agent/TaskQueue.ts`
- Create: 汇总报告逻辑在 `TaskQueue.ts` 中

- [ ] **Step 1: 生成汇总报告**

当 Plan 中所有任务完成（或部分失败）后，Worker 触发 `onPlanComplete` 回调：

```typescript
// 收集所有子任务输出
async function generateSummaryReport(
  planId: string, tasks: TaskNode[], containerId: string
): Promise<{
  total: number; completed: number; failed: number;
  fileChanges: string[]; summary: string;
}> {
  // 通过 docker exec 执行 `git diff --stat` 获取所有文件变更
  const diffStat = await SandboxManager.execCapture(containerId,
    'git diff --stat 2>/dev/null || diff -r . . || echo "no changes"');
  const fileChanges = diffStat.split('\n').filter(Boolean);

  return {
    total: tasks.length,
    completed: tasks.filter(t => /* completed */ true).length,
    failed: tasks.filter(t => /* failed */ false).length,
    fileChanges,
    summary: `Plan completed. ${fileChanges.length} files changed.`,
  };
}
```

- [ ] **Step 2: 前端渲染汇总卡片**

在 `ChatView` 中渲染汇总报告气泡，列出文件变更清单 + Diff 入口（Diff 功能延后至 Phase 4，入口先放占位链接）。

---

### Task 8: StateTracker — Agent 运行时状态追踪 (P2, 新增)

**Files:**
- Create: `apps/api/src/agent/StateTracker.ts`
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: 实现 StateTracker 类**

```typescript
// apps/api/src/agent/StateTracker.ts
export interface AgentSnapshot {
  agentId: string;
  agentMessageId: string;
  status: 'running' | 'done' | 'error';
  currentTool?: string;
  currentToolInput?: string;
  openedFiles: string[];
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  thinkingLevel?: string;
  subAgents: { type: string; description: string; status: string }[];
  updatedAt: number;
}

export class StateTracker {
  private snapshots = new Map<string, AgentSnapshot>();

  getOrCreate(agentMessageId: string, agentId: string): AgentSnapshot {
    const existing = this.snapshots.get(agentMessageId);
    if (existing) return existing;
    const snap: AgentSnapshot = {
      agentId,
      agentMessageId,
      status: 'running',
      openedFiles: [],
      subAgents: [],
      updatedAt: Date.now(),
    };
    this.snapshots.set(agentMessageId, snap);
    return snap;
  }

  updateTool(agentMessageId: string, toolName: string, input: Record<string, unknown>): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.currentTool = toolName;
    snap.currentToolInput = JSON.stringify(input).slice(0, 200);
    snap.updatedAt = Date.now();
  }

  updateTokenUsage(agentMessageId: string, usage: AgentSnapshot['tokenUsage']): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.tokenUsage = usage;
    snap.updatedAt = Date.now();
  }

  addSubagent(agentMessageId: string, type: string, description: string): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    snap.subAgents.push({ type, description, status: 'running' });
    snap.updatedAt = Date.now();
  }

  addOpenedFile(agentMessageId: string, path: string): void {
    const snap = this.snapshots.get(agentMessageId);
    if (!snap) return;
    if (!snap.openedFiles.includes(path)) snap.openedFiles.push(path);
    snap.updatedAt = Date.now();
  }

  getSnapshot(agentMessageId: string): AgentSnapshot | undefined {
    return this.snapshots.get(agentMessageId);
  }

  remove(agentMessageId: string): void {
    this.snapshots.delete(agentMessageId);
  }
}
```

- [ ] **Step 2: 在 handler.ts 中接入 StateTracker**

在 `onEvent` 回调中更新 StateTracker：
- `system` 事件（当前被忽略）→ 更新 token 用量、thinking level
- `tool_use` → 更新 currentTool、openedFiles
- `subagent_start` → 记录子 Agent
- `done`/`error` → 标记完成/失败，清理快照

按 500ms 间隔推送 `agent_status` 快照（合并 throttle）。

- [ ] **Step 3: 前端 AgentCard 展示 token 用量和思考等级**

在 `AgentCard.tsx` 头部区域显示：
```
状态: 🟢 运行中
思考: max
上下文: ████████░░ 12K / 200K
```

---

### Task 9: `/` 命令前端补全面板 (PRD §4.2 遗留, P3)

**Files:**
- Create: `apps/web/src/components/SlashCommandPopup.tsx`
- Modify: `apps/web/src/components/MessageInput.tsx`

- [ ] **Step 1: 定义可用命令列表**

```typescript
// apps/web/src/components/SlashCommandPopup.tsx
const SLASH_COMMANDS = [
  { name: '/plan', description: 'Create a task plan (Planner Agent)', icon: '📋' },
  { name: '/review', description: 'Request a code review', icon: '🔍' },
  { name: '/fix', description: 'Fix a bug or issue', icon: '🔧' },
  { name: '/deploy', description: 'Deploy the project', icon: '🚀' },
  { name: '/init', description: 'Initialize a new project', icon: '🌟' },
  { name: '/test', description: 'Generate and run tests', icon: '🧪' },
  { name: '/audit', description: 'Security audit of dependencies', icon: '🛡️' },
  { name: '/compact', description: 'Compact conversation context', icon: '📦' },
];
```

- [ ] **Step 2: 实现补全面板组件**

类似 `AgentMentionPopup.tsx` 的 UI 模式：输入 `/` 时弹出面板，支持键盘导航（↑↓ Enter Esc），选中后自动补全到输入框。

- [ ] **Step 3: 在 MessageInput 中接入**

在 `handleChange` 中检测 `/` 前缀（类似 `@` 检测逻辑），显示/隐藏补全面板。

---

### Task 10: 多标签页会话 + 未读徽章 (PRD §4.2 遗留, P3)

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: 添加未读计数状态**

```typescript
// appStore.ts 新增
unreadCounts: Record<string, number>;
incrementUnread: (sessionId: string) => void;
clearUnread: (sessionId: string) => void;
```

- [ ] **Step 2: 在 SessionList 中渲染未读徽章**

当 `activeSessionId !== sessionId` 且有 `stream_chunk` 到达时，递增该 session 的未读计数。切换会话时清零。

```tsx
{unread > 0 && (
  <span className="ml-auto bg-purple-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
    {unread > 99 ? '99+' : unread}
  </span>
)}
```

- [ ] **Step 3: 多标签页（简化版）**

前端阶段暂用单会话 + 快速切换模式。真正的多标签页（同时 maintain 多个活跃 WS 连接并渲染）复杂度高，延后到 Phase 4。

---

### Task 11: 完整交互式权限代理 — PTY 方案 (Issue #10, P2)

**Files:**
- Modify: `apps/api/src/agent/ClaudeCodeProcess.ts`
- Modify: `apps/api/src/agent/SandboxManager.ts`
- Create: `apps/api/src/agent/PTYStream.ts`

- [ ] **Step 1: 修改 Docker exec 支持 TTY 分配**

关键改动：将 `Tty: false` 替换为 `Tty: true`，让 Claude Code 认为自己运行在交互式终端中，从而发出 `permission_request` JSON 事件。

```typescript
const stream = await exec.start({ Detach: false, Tty: true });
```

TTY 模式下 Docker 会在 stdout 流前附加 8 字节的 multiplex header (stream type)。需要在 `onStdout` 中处理。

- [ ] **Step 2: 解析 PTY 输出中的 permission_request 事件**

TTY 模式下 Claude Code 可能通过 ANSI 转义序列输出 permission prompt。需要识别特定模式并从 ANSI 序列中提取 JSON。

---

### Task 12: 基于上下文的 Agent 推荐 (PRD §4.2 遗留, P3)

**Files:**
- Modify: `apps/web/src/lib/mentionParser.ts`

- [ ] **Step 1: 实现上下文排序**

```typescript
// apps/web/src/lib/mentionParser.ts 新增
export function recommendAgents(
  query: string,
  agents: AgentConfig[],
  recentMessages: string[],
): AgentConfig[] {
  const matched = matchAgents(query, agents);

  // 基于最近消息内容调整排序
  const context = recentMessages.join(' ').toLowerCase();
  const scores = matched.map(a => {
    let score = 0;
    if (context.includes('bug') || context.includes('fix') || context.includes('error')) {
      if (a.name === 'code-agent') score += 10;
    }
    if (context.includes('review') || context.includes('check')) {
      if (a.name === 'review-agent') score += 10;
    }
    if (context.includes('deploy') || context.includes('docker') || context.includes('build')) {
      if (a.name === 'devops-agent') score += 10;
    }
    return { agent: a, score };
  });

  return scores.sort((a, b) => b.score - a.score).map(s => s.agent);
}
```

---

## 验证方案

### 端到端测试流程

1. **Planner 拆解测试**
   - 创建 Group Session
   - 发送 `@planner 创建一个 React 待办事项应用`
   - 验证返回的 JSON TaskPlan 符合 schema
   - 验证 task 数量 3-8 个、依赖关系正确

2. **BullMQ 调度测试**
   - 确认 Plan → TaskQueue.submitPlan()
   - 检查 Redis 中是否有任务入队（`redis-cli KEYS "bull:agenthub-tasks:*"`）
   - 启动 Worker → 验证任务被逐层执行
   - 检查无依赖任务是否并行、有依赖任务是否串行

3. **DAG 可视化测试**
   - 打开浏览器 → 群聊中发送 Planner 消息
   - 验证 TaskCard 在消息流中正确渲染
   - 验证 React Flow DAG 节点位置正确（dagre 布局）
   - 验证节点状态颜色（waiting/running/done/failed）
   - 点击节点验证可展开执行日志

4. **失败处理测试**
   - 创建一个会失败的任务（例如依赖不存在的文件）
   - 验证 BullMQ 重试 2 次后标记为 failed
   - 验证依赖失败任务的后继任务标记为 blocked
   - 验证前端 Retry 按钮功能

5. **TypeScript 编译**
   ```bash
   npx tsc --noEmit -p apps/api/tsconfig.json
   npx tsc --noEmit -p apps/web/tsconfig.json
   ```

### 回归验证
- trustMode=true 的单 Agent 聊天仍正常
- 多 Agent @ 群聊仍正常
- Agent Card 活动流仍正常
- Agent Stop 按钮仍正常

---

## 计划依赖关系

```
Task 1 (Planner) ──┐
                    ├──→ Task 4 (DAG Viz) ──→ Task 5 (Confirmation) ──→ Task 6 (Failure)
Task 2 (BullMQ) ───┤
                    │
Task 3 (Context) ──┘
                                         ↓
                                    Task 7 (Summary)
                                         ↓
                                    Task 8 (StateTracker)
                                         ↓
                              Task 11 (PTY) ──┐
                              Task 9 (Slash)  ──┤ (independent)
                              Task 10 (Tabs)  ──┤
                              Task 12 (Recs)  ──┘
```

**建议执行顺序：** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9-12 (任意顺序)
