# ADR-011: 自动上下文压缩机制

## 状态

已接受

## 背景

长对话中 Agent 的上下文窗口会逐渐耗尽，需要自动压缩以维持对话质量。

## 决策

1. **70% 阈值触发**：`COMPRESSION_THRESHOLD_PCT = 70`，通过 `token_usage` 事件的 `contextPct` 检测
2. **Agent 自总结**：发送 `buildCompressionPrompt()` 要求 Agent 生成结构化摘要（用户目标/关键决策/当前状态/待办事项）
3. **Session 重置**：摘要生成后重置 SDK session，以摘要作为前缀继续
4. **pendingPrompt 保存**：`compressionPendingPrompt` 保存用户原始 prompt，压缩完成后自动注入
5. **事件监听器清理**：`removeAllListeners()` 后重新注册，防止重复

## 替代方案

### 方案 A: Agent 自总结 + session 重置（✅ 采用）

- 优点：Agent 自己生成摘要，保留语义理解；session 重置彻底释放上下文空间
- 缺点：压缩过程有 1-2s 延迟；摘要可能丢失历史细节

### 方案 B: 滑动窗口截断

- 优点：实现简单、无 LLM 调用成本、无延迟
- 缺点：截断无语义理解、可能丢失关键上下文、无法区分重要/不重要信息

### 方案 C: Embedding 相似度检索（RAG）

- 优点：按相关性检索历史消息、不丢失信息
- 缺点：需要 embedding 模型、检索延迟高、实现复杂度远超当前方案

## 后果

- **正面**：压缩过程对用户透明；摘要由 Agent 自己生成，保留语义理解
- **负面**：压缩过程有 1-2s 延迟；摘要可能丢失历史细节
- **中性**：旧事件监听器清理防止重复；tokenUsageMap 5 分钟清理防止内存泄漏

## 代码依据

- `agent/AgentRuntime.ts:75` — `COMPRESSION_THRESHOLD_PCT = 70`
- `agent/AgentRuntime.ts:120-133` — `buildCompressionPrompt()`
- `agent/AgentRuntime.ts:761-763` — contextPct 检测
- `agent/AgentRuntime.ts:240-242` — 压缩触发
- `agent/AgentRuntime.ts:508-513` — 摘要响应处理

## 关联

- PRD: §4.3.3 统一 REPL 架构 — 上下文压缩
- 技术文档: §4.4 会话上下文管理
- ADR: 005（Context Management，本 ADR 是其子决策）
