# ADR-002: Smart Hub 核心能力

## 状态

已接受

## 背景

MVP 完成后，AgentHub 需要从被动消息管道升级为智能协作中枢——主动协调、编排、管理多 agent 协作。

## 决策

1. **Main Agent 双重身份**：默认群聊主持人（对话模式）；触发词激活规划模式（输出 TaskPlan JSON）
2. **DAG 任务调度**：进程内调度（`ws/taskDispatcher.ts`），并行执行，依赖解析，失败重试/重规划
3. **消息增强**：代码块折叠、agent 状态面板、agent 输出 inline 预览
4. **代码冲突检测**：多 agent 并发编辑同一文件时，pairwise merge 检测冲突并升级处理
5. **Provider 无关设计**：`AbstractProvider` + `ProviderFactory` 模式，支持多平台 agent 接入

## 替代方案

### 方案 A: Smart Hub 协调层 + DAG 调度（✅ 采用）

- 优点：Hub 主动编排，用户只需描述需求；DAG 支持并行和依赖
- 缺点：Planner 拆解质量依赖 LLM 能力；DAG 调度逻辑复杂

### 方案 B: 纯聊天 + 手动 @ 分发

- 优点：实现简单，用户完全控制任务分配
- 缺点：用户需要了解每个 agent 的能力边界；无法自动并行化

### 方案 C: Workflow Engine（如 Temporal/Airflow）

- 优点：成熟的 DAG 引擎、可视化 UI、重试机制完善
- 缺点：引入外部依赖、运维成本高、对 LLM 任务的动态性支持差

## 后果

- **正面**：Smart Hub 模式使 AgentHub 从聊天工具升级为协作平台
- **负面**：DAG 调度引入了任务状态持久化需求（plan.json）；冲突检测需要文件级 diff 和 merge 能力
- **中性**：Provider 抽象层增加了接口设计复杂度，但降低了新平台接入成本

## 代码依据

- `ws/taskDispatcher.ts` — DAG 拓扑排序、并行层分发、失败降级
- `agent/AgentRuntime.ts` — isPlanner 识别、accumulatedOutput、extractAndValidate
- `agent/ManagerLoop.ts` — 失败重规划

## 关联

- Changelog: `docs/changelog/2026-05-mvp-to-smart-hub.md`
- 原始 Plan: `docs/superpowers/plans/2026-05-23-phase3-smart-hub-core.md`
