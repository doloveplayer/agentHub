# Phase 4 — 多厂商 Agent 适配层 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.
> **Parent Spec:** `docs/superpowers/specs/2026-05-21-agent-collab-workspace-provider-design.md` §3

**Goal:** 实现 AbstractProvider 接口，将 ClaudeCodeProcess 重构为接口实现，新增 Codex / OpenCode CLI 适配器，前端支持用户自带 API 配置和多 provider 差异化 Agent Card 展示。

**Architecture:** 在现有 Agent 适配层之上抽象统一接口，ProviderFactory 按 AgentConfig.provider 字段路由到对应实现。每种 provider 内部将 CLI 原生输出转换为 UnifiedAgentEvent。前端 Agent Card 骨架统一、活动流内容差异化。

**Tech Stack:** AbstractProvider (TypeScript interface), ProviderFactory, Codex CLI, OpenCode CLI

**Dependencies:** Phase 3.5 完成，系统稳定

---

## 执行优先级清单

| 优先级 | 功能 | 依赖 |
|--------|------|------|
| P0 | AbstractProvider 接口 + UnifiedAgentEvent 类型 | 无 |
| P0 | Claude Code provider 重构（从 ClaudeCodeProcess 抽取） | AbstractProvider |
| P0 | ProviderFactory — 按 provider 名路由 | AbstractProvider |
| P1 | AgentConfig DB 扩展 + Agent 创建 UI 选 provider | ProviderFactory |
| P1 | 用户 Provider 配置页（API key / base URL） | 无 |
| P2 | Codex CLI provider | AbstractProvider |
| P2 | OpenCode CLI provider | AbstractProvider |
| P2 | Agent Card 差异化活动流 | Provider 事件差异 |

---

## Task 1: AbstractProvider 接口 + UnifiedAgentEvent

**Files:**
- Create: `apps/api/src/agent/providers/base.ts`

### Step 1: 定义接口和通用类型

```typescript
// apps/api/src/agent/providers/base.ts
export interface UnifiedAgentEvent {
  type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start'
      | 'subagent_result' | 'permission_request' | 'milestone'
      | 'blocked' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  filePath?: string;
  exitCode?: number;
  message?: string;
  providerRaw?: unknown;
  timestamp: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  env?: Record<string, string>;
}

export type EventHandler = (event: UnifiedAgentEvent) => void;

export interface AbstractProvider {
  readonly name: string;  // 'claude-code' | 'codex' | 'opencode'

  start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    config: ProviderConfig,
    hostWorkDir?: string,
    messageId?: string,
  ): Promise<void>;

  stop(): void;
  write(input: string): void;
  onEvent(handler: EventHandler): void;
}
```

---

## Task 2: Claude Code Provider 重构

**Files:**
- Create: `apps/api/src/agent/providers/claude-code.ts`
- Modify: `apps/api/src/agent/ClaudeCodeProcess.ts` → 标记 deprecated，委托给新 provider

### Step 1: 实现 ClaudeCodeProvider

将 `ClaudeCodeProcess` 的核心逻辑（Docker exec、EventParser 转换、partialLine buffer、prompt 文件写入）移入 `ClaudeCodeProvider`，实现 `AbstractProvider` 接口。原有 `ClaudeCodeProcess` 保留为兼容 wrapper，内部委托给 `ClaudeCodeProvider`。

```typescript
// apps/api/src/agent/providers/claude-code.ts
import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { SandboxManager } from '../SandboxManager.js';
import { EventParser } from '../EventParser.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { buildSafeEnv } from '../ClaudeCodeProcess.js';  // reuse existing env filter

export class ClaudeCodeProvider implements AbstractProvider {
  readonly name = 'claude-code';
  private containerId: string | null = null;
  private handlers: EventHandler[] = [];
  private killed = false;
  private partialLine = '';

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  async start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    config: ProviderConfig,
    hostWorkDir?: string,
    messageId?: string,
  ): Promise<void> {
    this.killed = false;
    this.containerId = containerId;

    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    // Claude Code trust mode: always skip permissions in this provider
    // (permission proxy handled by upper layer if needed)
    args.push('--dangerously-skip-permissions');

    // Write env + prompt files (reuse existing pattern)
    const safeEnv = buildSafeEnv();
    if (config.apiKey) safeEnv['ANTHROPIC_API_KEY'] = config.apiKey;
    if (config.baseUrl) safeEnv['ANTHROPIC_BASE_URL'] = config.baseUrl;

    const promptFile = messageId ? `_prompt_${messageId}.txt` : '_prompt.txt';
    if (hostWorkDir) {
      writeFileSync(resolve(hostWorkDir, promptFile), prompt, 'utf-8');
      const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
      const envLines = authKeys
        .filter(k => safeEnv[k])
        .map(k => `export ${k}='${String(safeEnv[k]).replace(/'/g, "'\\''")}'`);
      writeFileSync(resolve(hostWorkDir, '_env.sh'), envLines.join('\n'), 'utf-8');
    }

    const shellCmd = `. /workspace/_env.sh && cat /workspace/${promptFile} | claude ${args.join(' ')}`;

    SandboxManager.execStream(containerId, ['sh', '-c', shellCmd], {
      workDir,
      onStdout: (chunk) => {
        if (this.killed) return;
        this.partialLine += chunk;
        const lines = this.partialLine.split('\n');
        this.partialLine = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = EventParser.parseLine(line);
          if (event) {
            // Convert ParsedEvent → UnifiedAgentEvent
            const unified = EventParser.toUnified(event);
            if (unified) this.emit(unified);
          }
        }
      },
      onStderr: (chunk) => {
        if (this.killed) return;
        const msg = chunk.trim();
        if (msg) this.emit({ type: 'error', message: msg, providerRaw: msg, timestamp: Date.now() });
      },
    }).catch((err) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: `Docker exec error: ${err.message}`, timestamp: Date.now() });
      }
    });
  }

  stop(): void {
    this.killed = true;
    if (this.containerId) {
      SandboxManager.execShell(this.containerId, 'pkill -f "claude.*--print" 2>/dev/null || true');
    }
  }

  write(input: string): void {
    if (!this.containerId || this.killed) return;
    const escaped = input.replace(/'/g, "'\\''");
    SandboxManager.execShell(this.containerId,
      `echo '${escaped}' > /proc/$(pgrep -f 'claude.*--print' 2>/dev/null | head -1)/fd/0 2>/dev/null || true`);
  }
}
```

### Step 2: EventParser.toUnified() 转换方法

在 EventParser 中新增：

```typescript
// apps/api/src/agent/EventParser.ts 新增
static toUnified(event: ParsedEvent): UnifiedAgentEvent | null {
  const base = { providerRaw: event, timestamp: Date.now() };
  switch (event.type) {
    case 'text':         return { ...base, type: 'thinking', content: event.content };
    case 'tool_use':     return { ...base, type: 'tool_use', toolName: event.toolName, toolInput: event.input };
    case 'tool_result':  return { ...base, type: 'tool_result', content: event.content };
    case 'subagent_start':   return { ...base, type: 'subagent_start', content: event.agentType };
    case 'subagent_result':  return { ...base, type: 'subagent_result', content: event.agentType };
    case 'permission_request': return { ...base, type: 'permission_request', toolName: event.tool, filePath: event.path };
    case 'done':         return { ...base, type: 'done', exitCode: event.exitCode };
    case 'error':        return { ...base, type: 'error', message: event.message };
    default:             return null;
  }
}
```

---

## Task 3: ProviderFactory

**Files:**
- Create: `apps/api/src/agent/providers/factory.ts`

```typescript
// apps/api/src/agent/providers/factory.ts
import { AbstractProvider, ProviderConfig } from './base.js';
import { ClaudeCodeProvider } from './claude-code.js';
// Future: import { CodexProvider } from './codex.js';
// Future: import { OpenCodeProvider } from './opencode.js';

const registry = new Map<string, () => AbstractProvider>();

export class ProviderFactory {
  static register(name: string, factory: () => AbstractProvider): void {
    registry.set(name, factory);
  }

  static create(providerName: string): AbstractProvider {
    const factory = registry.get(providerName);
    if (!factory) {
      throw new Error(`Unknown provider: ${providerName}. Available: ${[...registry.keys()].join(', ')}`);
    }
    return factory();
  }

  static list(): string[] {
    return [...registry.keys()];
  }

  /** Initialize built-in providers — called once on startup */
  static init(): void {
    ProviderFactory.register('claude-code', () => new ClaudeCodeProvider());
    // Phase 4: register codex, opencode providers
    // ProviderFactory.register('codex', () => new CodexProvider());
    // ProviderFactory.register('opencode', () => new OpenCodeProvider());
  }
}
```

---

## Task 4: AgentConfig DB + UI 扩展

**Files:**
- Modify: `apps/api/prisma/schema.prisma` — Agent 模型新增 `provider` + `providerConfig` 字段
- Modify: `apps/web/src/components/` — Agent 创建/编辑表单

### DB Migration

```prisma
model Agent {
  id             String   @id @default(uuid())
  name           String   @unique
  displayName    String
  description    String
  systemPrompt   String   @default("")
  provider       String   @default("claude-code")
  providerConfig Json     @default("{}")
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  sessionAgents  SessionAgent[]
}
```

### UI: Agent 创建表单加入 provider 下拉框

在 Agent 管理页面的创建/编辑对话框中，添加 provider 选择。当选择不同 provider 时，显示对应的配置字段（如 model 选择）。

---

## Task 5: 用户 Provider 配置页

**Files:**
- Create: `apps/web/src/components/ProviderSettings.tsx`

配置页存储用户每种 provider 的 API key / base URL。密钥加密存储在后端（或调用现有安全环境变量机制）。

---

## Task 6: 差异化 Agent Card 渲染

**Files:**
- Modify: `apps/web/src/components/AgentCard.tsx`

Agent Card 根据 `agent.provider` 字段渲染不同的活动流区域：

```tsx
{agent.provider === 'claude-code' && (
  // Current: 💭 thinking → 🔧 tool_use → 📋 tool_result
)}
{agent.provider === 'codex' && (
  // Codex-specific: 📊 analysis → ✏️ edit → ✅ result
)}
```

骨架区域（状态灯、当前操作、文件列表、Stop 按钮）保持不变。

---

## Verification

- [ ] AbstractProvider interface compiles and is implemented by ClaudeCodeProvider
- [ ] Existing behavior preserved through provider refactor
- [ ] ProviderFactory routes correctly by provider name
- [ ] Agent creation UI shows provider dropdown with available options
- [ ] User can configure API keys per provider in settings
- [ ] Agent Card shows provider badge + correct activity stream rendering
- [ ] Switching provider does not require code changes
- [ ] Unknown provider returns clear error message
