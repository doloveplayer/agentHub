# ADR-006: Planner 双重身份设计

## 状态

已接受

## 背景

Planner Agent 需要同时承担两种角色——日常群聊中的对话主持人，以及复杂任务的规划器。两种角色的输出格式和行为完全不同。

## 决策

1. **通过 agent name 前缀自动识别**：`agent.name === 'planner' || agent.name.startsWith('planner-')` 标记 `isPlanner`
2. **累积输出模式**：`accumulatedOutput` 累积所有 thinking 事件内容，在 `done` 事件时统一提取 TaskPlan JSON
3. **隐藏式 JSON 嵌入**：`<!--AGENTHUB_PLAN{...}-->` 格式，用户不可见
4. **追问行为**：需求不明确时 Planner 主动追问技术栈/目标平台/功能边界（由 system prompt 定义）
5. **Zod 校验 + 自动重试**：`extractAndValidate()` 校验 JSON schema，失败时自动重试

## 替代方案

### 方案 A: 双重身份 + 累积输出（✅ 采用）

- 优点：单 agent 进程同时支持对话和规划；累积输出避免中间解析错误
- 缺点：JSON 输出在 done 时才被处理，中间无法实时校验

### 方案 B: 独立 Planner Agent（与对话 Agent 分离）

- 优点：职责单一、输出格式稳定、可独立优化
- 缺点：需要额外 agent 进程、用户需要显式切换对话/规划模式

### 方案 C: 前端解析触发词 + 直接调用规划 API

- 优点：Planner 不需要特殊逻辑、规划请求走独立 API
- 缺点：前端需要理解规划语义、与 agent 流式输出模型不兼容

## 后果

- **正面**：用户无需切换模式，自然语言即可触发规划；隐藏式 JSON 不干扰阅读体验
- **负面**：追问行为依赖 system prompt 质量；JSON 校验失败时需要重试整个 done 流程
- **中性**：Planner 的 system prompt 需要明确定义触发词和追问策略

## 代码依据

- `agent/AgentRuntime.ts:315` — isPlanner 识别
- `agent/AgentRuntime.ts:362` — accumulatedOutput 累积
- `agent/AgentRuntime.ts:624` — extractAndValidate 提取
- `agent/PlanValidator.ts` — Zod schema 校验

## 关联

- PRD: §8.1 双重身份
- 技术文档: §4.2 任务编排
- Spec: `docs/architecture/specs/2026-06-01-planner-skill-dispatch-design.md`
