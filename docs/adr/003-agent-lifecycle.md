# ADR-003: Agent 生命周期重构

## 状态

已接受

## 背景

初期 Agent 是 session-scoped 进程，每次会话重新创建。这导致：记忆无法跨 session 共享、容器启动延迟高、agent 配置无法全局管理。

## 决策

1. **Agent 成为全局单例**：每个 agent 持有独立 Docker 容器 + 常驻 REPL 进程
2. **持久化主目录**：`.agent-runtime/{agentId}/` 存储 CLAUDE.md、memory、skills，跨 session 共享
3. **Solo/Group 成员管理**：Solo session 按 agent 分组展示，Group session 支持多 agent 协作
4. **AgentRuntime 统一管理**：统一管理 agent 生命周期、并发排队、容器健康检查

## 后果

- 跨 session 记忆共享提升了 agent 连续性
- 常驻容器增加了资源占用，需要空闲超时回收机制
- 全局 agent 实体需要更复杂的 CRUD 和权限管理

## 关联

- Changelog: `docs/changelog/2026-06-smart-hub-expansion.md`
- Spec: `docs/architecture/specs/2026-05-29-agent-lifecycle-redesign.md`
