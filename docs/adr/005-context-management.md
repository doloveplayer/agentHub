# ADR-005: Context Management

## 状态

已接受

## 背景

多 agent 协作中，上下文管理是核心挑战：历史消息重复注入、agent 间信息传递不畅、context window 容量有限。

## 决策

1. **ContextBus 全局状态黑板**：agent 间通过 ContextBus 共享上下文，替代直接消息传递
2. **结构化 Session Context**：`buildSessionContext()` 替代 `buildHistory()`，注入 session agents、plan 状态、pinned messages
3. **Token 计数 + 自动压缩**：context > 70% 时触发 agent 自总结 + SDK session reset
4. **消息置顶**：UI 书签 + agent prompt 自动注入，确保关键信息不被压缩丢失
5. **Intent 路由**：`IntentParser.scan()` 解析 agent 输出中的 NEEDS HELP 意图，自动路由到协调 agent

## 替代方案

### 方案 A: ContextBus KV 黑板 + 自动压缩（✅ 采用）

- 优点：agent 间松耦合通信、自动压缩避免 overflow、用户可通过置顶控制上下文
- 缺点：KV 黑板是全局状态，需要并发安全；压缩可能丢失历史细节

### 方案 B: 消息队列（Redis Pub/Sub）

- 优点：事件驱动、天然支持多消费者、解耦更彻底
- 缺点：需要消费者处理历史累积、上下文注入需要额外聚合逻辑、运维成本高

### 方案 C: 滑动窗口截断

- 优点：实现简单、无 LLM 调用成本
- 缺点：截断无语义理解、可能丢失关键上下文、无法区分重要/不重要信息

## 后果

- **正面**：ContextBus 解耦了 agent 间通信；自动压缩避免了 context overflow
- **负面**：ContextBus 引入了全局状态管理复杂度（LRU 淘汰、7 天衰减、引用计数加权）
- **中性**：消息置顶提供了用户级的上下文控制；Intent 路由实现了 agent 间自动协作

## 代码依据

- `agent/ContextBus.ts` — KV 状态黑板、条目类型、权重排序
- `agent/AgentRuntime.ts:75` — COMPRESSION_THRESHOLD_PCT = 70
- `agent/AgentRuntime.ts:120` — buildCompressionPrompt
- `agent/PinnedStore.ts` — 消息置顶
- `agent/IntentParser.ts` — NEEDS HELP 意图解析

## 关联

- Changelog: `docs/changelog/2026-06-smart-hub-expansion.md`
- Spec: `docs/architecture/specs/2026-06-03-contextbus-pinned-design.md`
- ADR: 011（自动上下文压缩机制，本 ADR 的子决策）
