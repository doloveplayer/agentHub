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

## 后果

- 每个 session 的沙箱隔离保证了安全性，但增加了容器启动开销
- Planner 模式引入了任务编排复杂度（DAG、依赖解析、失败重试）
- Multi-agent 群聊需要 @mention 机制和消息路由

## 关联

- Changelog: `docs/changelog/2026-05-mvp-to-smart-hub.md`
- 原始 Plan: `docs/superpowers/plans/2026-05-18-agenthub-mvp-phase1.md`, `2026-05-19-phase2-multi-agent.md`
