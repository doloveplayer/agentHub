# ADR-004: Multi-Provider Abstraction

## 状态

已接受

## 背景

AgentHub 需要支持多个 AI agent 平台（Claude Code、Codex、OpenCode），而非绑定单一供应商。

## 决策

1. **AbstractProvider 接口**：统一的 provider 抽象层，每个平台实现 `start()`, `sendMessage()`, `stop()` 等方法
2. **ProviderFactory 注册**：运行时按 provider 名称查找实现，支持热切换
3. **Claude Code Provider**：通过 docker exec 运行 Claude Code SDK，AsyncGenerator 流式输出
4. **OpenCode Provider**：接入 DeepSeek 国产模型，与 Claude Code 完全独立
5. **providerConfig 统一配置**：合并原 settings 字段，统一存放 model/tools/endpoint/apiKey
6. **API Key 加密存储**：AES-256-GCM 加密，前端脱敏显示

## 后果

- 新 provider 接入只需实现 AbstractProvider 接口
- 不同 provider 的能力差异需要在 UI 层处理（如 Codex 不支持某些工具）
- API Key 管理增加了加密/解密复杂度

## 关联

- Changelog: `docs/changelog/2026-05-mvp-to-smart-hub.md`, `2026-06-smart-hub-expansion.md`
- 原始 Plan: `docs/superpowers/plans/2026-05-26-multi-provider-agents.md`, `2026-06-04-opencode-provider.md`
