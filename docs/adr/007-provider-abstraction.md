# ADR-007: Provider 抽象层设计

## 状态

已接受

## 背景

需要接入多个 Agent 平台（Claude Code、OpenCode、Codex），每个平台的进程模型、输出格式、权限机制都不同。

## 决策

1. **AbstractProvider 接口**：定义统一契约（start/sendPrompt/write/stop/onEvent/isAlive/getAgentHome/updateTrustMode）
2. **5 个 capability 布尔值**：persistentSession / permissionProxy / streamingOutput / independentMemory / independentConfig
3. **UnifiedAgentEvent 统一事件**：13 种事件类型
4. **ProviderFactory 注册**：插件式注册，新平台只需实现接口 + 注册

## 替代方案

（本 ADR 是 ADR-004 的细化，替代方案见 ADR-004。此处补充接口层面的选型。）

### 方案 A: 5 个 capability 布尔值（✅ 采用）

- 优点：简单直观、Hub 可快速判断平台能力
- 缺点：布尔值粒度粗，无法表达"部分支持"或"条件支持"

### 方案 B: Capability 枚举 + 版本号

- 优点：可表达更细粒度的能力（如 permissionProxy: "full" | "partial" | "none"）
- 缺点：枚举值膨胀、版本兼容性管理复杂

### 方例 C: 运行时能力探测

- 优点：无需预声明，运行时自动发现
- 缺点：探测逻辑复杂、可能在生产环境暴露不支持的操作

## 后果

- **正面**：新平台接入约 200 行接口代码；事件格式差异由各 Provider 内部转换
- **负面**：capability 布尔值可能无法精确描述平台差异
- **中性**：ProviderFactory 支持运行时热切换

## 代码依据

- `agent/providers/base.ts` — AbstractProvider + UnifiedAgentEvent + ProviderConfig
- `agent/providers/claude-code.ts` — ClaudeCodeProvider
- `agent/providers/opencode.ts` — OpenCodeProvider

## 关联

- PRD: §7 多平台 Agent 接入层设计
- 技术文档: §4.6 多 Agent 平台接入
- ADR: 004（Multi-Provider Abstraction，本 ADR 的父决策）
