# ADR-001: Multi-Agent Architecture

## 状态

已接受

## 背景

AgentHub 需要支持多个 AI agent 在同一会话中协作。核心问题是：agent 如何注册、如何通信、如何隔离。

## 决策

1. **Monorepo 架构**：`apps/api`（Hono + WebSocket + Dockerode）、`apps/web`（React + Vite + Tailwind）、`packages/shared`（共享类型）
2. **每个 session 独立 Docker 沙箱**：容器名 `agenthub-sandbox-{sessionId}`，挂载 `/workspace`, `/sandbox`, `/home/agents`
3. **Agent 注册表**：Prisma 持久化 agent 配置（name, provider, providerConfig），支持 Solo 和 Group 两种模式
4. **WebSocket 多路复用**：单连接承载 chat、status、artifact 等多种消息类型
5. **Planner agent 协调**：理解用户意图 → DAG 任务拆解 → 分配到子 agent → 依赖感知调度

## 替代方案

### 方案 A: Monorepo + Docker 沙箱 + WebSocket（✅ 采用）

- 优点：前后端语言统一（TypeScript）、Docker 隔离安全性高、WebSocket 实时性好
- 缺点：Docker 容器启动有开销、Monorepo 构建链较复杂

### 方案 B: 微服务 + K8s Pod + gRPC

- 优点：天然支持水平扩展、Pod 级隔离更细粒度
- 缺点：运维复杂度高、对单机部署场景过度设计、gRPC 浏览器支持差

### 方案 C: 单体 + 进程级隔离 + SSE

- 优点：部署简单、SSE 浏览器兼容性好
- 缺点：进程隔离安全性不足、SSE 单向通信限制多

## 后果

- **正面**：每个 session 的沙箱保证了安全性；WebSocket 多路复用减少连接数
- **负面**：容器启动增加延迟（首次 ~2s）；Planner 模式引入 DAG 调度复杂度
- **中性**：Multi-agent 群聊需要 @mention 机制和消息路由

## 代码依据

- `ws/state.ts` — getOrCreateSandbox、sandboxes Map
- `agent/SandboxManager.ts` — Docker 容器创建和挂载
- `ws/handler.ts` — WebSocket 多路复用

## 关联

- Changelog: `docs/changelog/2026-05-mvp-to-smart-hub.md`
- 原始 Plan: `docs/superpowers/plans/2026-05-18-agenthub-mvp-phase1.md`
