# ADR-010: 三级失败降级策略

## 状态

已接受

## 背景

DAG 任务执行失败时，简单的重试或阻塞都不够——需要根据失败原因动态决策。

## 决策

1. **Stage 1：自动重试**（MAX_AUTO_RETRIES = 3）：`markTaskRetryQueued` → 重新入队，retry context 注入 prompt
2. **Stage 2：ManagerLoop 重规划**：收集失败上下文 → 调用 Main Agent → continue/replan/abort
3. **Stage 3：人工介入**：ManagerLoop abort 或 replan 失败 → broadcast `pending_task_confirmation` → 用户手动决策

## 替代方案

### 方案 A: 三级降级（自动重试 → 重规划 → 人工）（✅ 采用）

- 优点：根据失败原因动态决策、不阻塞兄弟任务、人工兜底保证安全
- 缺点：ManagerLoop 调用 LLM 有延迟和成本；三级链路调试复杂

### 方案 B: 固定重试次数 + 直接阻塞

- 优点：实现简单、行为可预测
- 缺点：无法区分瞬时错误和结构性失败；阻塞会拖慢整个 DAG

### 方案 C: 用户手动重试（无自动重试）

- 优点：用户完全控制、无误判风险
- 缺点：用户体验差、高频失败场景下操作成本高

## 后果

- **正面**：单个任务失败不阻塞无依赖的兄弟任务；replan 可生成替换任务
- **负面**：ManagerLoop 调用 LLM 有 1-3s 延迟；三级链路增加了状态管理复杂度
- **中性**：替换任务可以引用已完成的上游任务 ID 作为 dependsOn

## 代码依据

- `ws/taskDispatcher.ts:212` — `MAX_AUTO_RETRIES = 3`
- `ws/taskDispatcher.ts:967-1070` — 三级降级链
- `agent/ManagerLoop.ts:58-155` — ManagerLoop 类 + DECISION_OUTPUT_SCHEMA

## 关联

- PRD: §4.3.1 Main Agent 协调器 — 失败降级
- 技术文档: §4.2 任务编排
- ADR: 002（Smart Hub 核心能力，DAG 调度是其子系统）
