# ADR-004: Multi-Provider Abstraction

## 状态

已接受

## 背景

AgentHub 需要支持多个 AI agent 平台（Claude Code、Codex、OpenCode），而非绑定单一供应商。

## 决策

1. **AbstractProvider 接口**：统一的 provider 抽象层，每个平台实现 `start()`, `sendPrompt()`, `stop()` 等方法
2. **5 个 capability 布尔值**：persistentSession / permissionProxy / streamingOutput / independentMemory / independentConfig
3. **UnifiedAgentEvent 统一事件**：13 种事件类型，所有平台输出标准化
4. **ProviderFactory 注册**：运行时按 provider 名称查找实现，支持热切换
5. **Claude Code Provider**：通过 docker exec 运行 Claude Code SDK，AsyncGenerator 流式输出
6. **OpenCode Provider**：接入 OpenAI 兼容 API（DeepSeek、OpenRouter 等）

## 替代方案

### 方案 A: AbstractProvider + capability 布尔值（✅ 采用）

- 优点：统一接口 + 能力声明，Hub 可根据 capability 差异化处理
- 缺点：capability 粒度可能不够细（5 个布尔值无法覆盖所有差异）

### 方案 B: 每平台独立适配器（无抽象层）

- 优点：每个平台完全定制化，无接口约束
- 缺点：Hub 层需要大量 if-else 分支、新平台接入成本高、无法复用通用逻辑

### 方案 C: Plugin 系统 + 配置文件驱动

- 优点：平台接入通过配置而非代码、支持第三方插件
- 缺点：配置表达能力有限、复杂交互（如权限代理）难以用配置描述

## 后果

- **正面**：新平台接入约 200 行接口代码；事件格式差异由各 Provider 内部转换
- **负面**：capability 布尔值可能无法精确描述平台差异；Provider 内部转换逻辑可能有 bug
- **中性**：API Key 管理增加了 AES-256-GCM 加密/解密复杂度

## 代码依据

- `agent/providers/base.ts` — AbstractProvider + UnifiedAgentEvent + ProviderConfig
- `agent/providers/claude-code.ts` — ClaudeCodeProvider
- `agent/providers/opencode.ts` — OpenCodeProvider
- `agent/providers/factory.ts` — ProviderFactory

## 关联

- Changelog: `docs/changelog/2026-05-mvp-to-smart-hub.md`, `2026-06-smart-hub-expansion.md`
- Spec: `docs/architecture/specs/2026-06-04-opencode-provider-design.md`
