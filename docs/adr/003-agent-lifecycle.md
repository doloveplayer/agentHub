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

## 替代方案

### 方案 A: 全局单例 + 常驻 REPL（✅ 采用）

- 优点：跨 session 记忆共享、无启动延迟、agent 配置全局生效
- 缺点：常驻容器增加内存占用、需要空闲超时回收机制

### 方案 B: Session-scoped 进程（原方案）

- 优点：资源随 session 销毁自动释放、实现简单
- 缺点：每次会话重新启动、记忆无法跨 session、配置无法全局管理

### 方案 C: 进程池 + LRU 淘汰

- 优点：平衡资源占用和启动延迟
- 缺点：实现复杂度高、LRU 淘汰可能丢失活跃 agent 状态

## 后果

- **正面**：跨 session 记忆共享提升了 agent 连续性；常驻容器消除了启动延迟
- **负面**：常驻容器增加资源占用，需要空闲超时回收（idleTimer）；全局 agent 实体需要更复杂的 CRUD 和权限管理
- **中性**：AgentDirectoryManager 管理每个 agent 的独立目录结构

## 代码依据

- `agent/AgentRuntime.ts` — agents Map、AgentEntry、idleTimer
- `agent/AgentContainer.ts` — 独立容器管理
- `agent/AgentDirectoryManager.ts` — 持久化目录管理

## 关联

- Changelog: `docs/changelog/2026-06-smart-hub-expansion.md`
- Spec: `docs/architecture/specs/2026-05-29-agent-lifecycle-redesign.md`
