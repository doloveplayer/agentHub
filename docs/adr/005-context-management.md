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

## 后果

- ContextBus 解耦了 agent 间通信，但引入了全局状态管理复杂度
- 自动压缩避免了 context overflow，但可能丢失历史细节
- 消息置顶提供了用户级的上下文控制

## 关联

- Changelog: `docs/changelog/2026-06-smart-hub-expansion.md`
- Spec: `docs/architecture/specs/2026-06-03-contextbus-pinned-design.md`
