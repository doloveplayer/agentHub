# OpenCode Provider 实现计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 实现。步骤使用 checkbox (`- [ ]`) 追踪。

**Goal:** 接入 OpenCode 作为第二个 agent provider，搭载 DeepSeek 国产模型，与 Claude Code 完全独立

**Architecture:** 新建 3 个文件（OpenCodeProvider、OpenCodeContainer、OpenCodeEventParser），修改 6 个文件（factory、routes、types、AgentCard、AgentCreator、Dockerfile）。全部走独立路径，不改动任何 Claude Code 代码。

**Tech Stack:** TypeScript, Node.js, Docker, OpenCode CLI 1.15.13, @ai-sdk/openai-compatible

**Design Spec:** `docs/superpowers/specs/2026-06-04-opencode-provider-design.md`

---

### Task 1: OpenCodeEventParser — NDJSON 事件解析

**Files:**
- Create: `apps/api/src/agent/OpenCodeEventParser.ts`

- [ ] **Step 1: 创建 OpenCodeEventParser 类**

```typescript
import type { UnifiedAgentEvent } from './providers/base.js';

interface OpenCodeEvent {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: {
    id: string;
    messageID: string;
    sessionID: string;
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    reason?: string;
    tokens?: { total: number; input: number; output: number; reasoning: number; cache: { write: number; read: number } };
    cost?: number;
    state?: {
      status: string;
      input: Record<string, unknown>;
      output: string;
      metadata?: Record<string, unknown>;
      title?: string;
      time?: { start: number; end: number };
    };
    time?: { start: number; end: number };
  };
  error?: {
    name: string;
    data?: {
      message?: string;
      statusCode?: number;
    };
  };
}

export class OpenCodeEventParser {
  private sessionId: string | null = null;

  /** Reset parser state for a new run. */
  reset(): void {
    this.sessionId = null;
  }

  /** Get the captured session ID from the last step_start event. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Parse one NDJSON line from `opencode run --format json` stdout.
   * Returns an array of UnifiedAgentEvent (tool_use produces two events).
   * Returns empty array for events with no user-visible content.
   */
  parseLine(rawLine: string): UnifiedAgentEvent[] {
    const trimmed = rawLine.trim();
    if (!trimmed) return [];

    let event: OpenCodeEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON line — treat as plain text
      return [{ type: 'thinking', content: trimmed, timestamp: Date.now() }];
    }

    if (!event || typeof event !== 'object' || !event.type) {
      return [];
    }

    const base: Pick<UnifiedAgentEvent, 'timestamp'> = {
      timestamp: event.timestamp || Date.now(),
    };

    switch (event.type) {
      case 'step_start': {
        // Capture session ID, don't emit to UI
        if (event.sessionID) {
          this.sessionId = event.sessionID;
        }
        // Also extract from nested part.sessionID
        if (event.part?.sessionID) {
          this.sessionId = event.part.sessionID;
        }
        return [];
      }

      case 'text': {
        const content = event.part?.text;
        if (!content) return [];
        return [{ ...base, type: 'thinking', content }];
      }

      case 'tool_use': {
        if (!event.part || event.part.type !== 'tool') return [];
        const toolName = event.part.tool || 'unknown';
        const toolInput = (event.part.state?.input || {}) as Record<string, unknown>;
        const toolOutput = event.part.state?.output || '';

        // Emit tool_use + tool_result as two separate events
        const toolUseEvent: UnifiedAgentEvent = {
          ...base,
          type: 'tool_use',
          toolName,
          toolInput,
          content: event.part.state?.title,
        };
        const toolResultEvent: UnifiedAgentEvent = {
          ...base,
          type: 'tool_result',
          content: toolOutput,
        };
        return [toolUseEvent, toolResultEvent];
      }

      case 'step_finish': {
        if (!event.part?.tokens) return [];
        const tokens = event.part.tokens;
        return [{
          ...base,
          type: 'token_usage',
          inputTokens: tokens.input,
          outputTokens: tokens.output,
        }];
      }

      case 'error': {
        const message = event.error?.data?.message
          || event.error?.name
          || 'Unknown OpenCode error';
        return [{ ...base, type: 'error', message }];
      }

      default:
        // Unknown event types — ignore, don't crash
        return [];
    }
  }
}
```

- [ ] **Step 2: 编译检查**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

---

### Task 2: OpenCodeContainer — Docker 进程管理

**Files:**
- Create: `apps/api/src/agent/OpenCodeContainer.ts`

- [ ] **Step 1: 创建 spawnOpenCodeInDocker 函数**

```typescript
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

export interface OpenCodeContainerOptions {
  containerId: string;
  prompt: string;
  hostSandboxDir: string;
  trustMode: boolean;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  resumeSession?: string;
}

/** Generate opencode.json config for DeepSeek / OpenAI-compatible providers. */
export function generateOpenCodeConfig(
  baseUrl?: string,
  model?: string,
): object {
  const endpoint = baseUrl || 'https://api.deepseek.com/v1';
  const modelName = model || 'deepseek-chat';

  return {
    model: `deepseek/${modelName}`,
    provider: {
      deepseek: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepSeek',
        options: {
          baseURL: endpoint,
          apiKey: '{env:AGENTHUB_OPENCODE_API_KEY}',
          timeout: 300000,
        },
        models: {
          [modelName]: { name: modelName },
        },
      },
    },
  };
}

/**
 * Spawn `docker exec` running `opencode run --format json`.
 * Writes opencode.json to the sandbox directory (bind-mounted into container).
 * Returns the child process and a cleanup function.
 */
export function spawnOpenCodeInDocker(
  opts: OpenCodeContainerOptions,
): { proc: ChildProcess; cleanup: () => void } {
  // Write opencode.json to sandbox dir (bind-mounted at /sandbox in container)
  const config = generateOpenCodeConfig(opts.baseUrl, opts.model);
  const configPath = resolve(opts.hostSandboxDir, 'opencode.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  const model = opts.model || 'deepseek-chat';

  // Build docker exec command
  const dockerArgs = [
    'exec', '-i',
    '-e', `AGENTHUB_OPENCODE_API_KEY=${opts.apiKey}`,
    '-e', 'OPENCODE_CONFIG=/sandbox/opencode.json',
    '-w', '/workspace',
    opts.containerId,
    'opencode', 'run',
    '--format', 'json',
    '-m', `deepseek/${model}`,
  ];

  if (opts.resumeSession) {
    dockerArgs.push('--session', opts.resumeSession);
  }

  if (opts.trustMode) {
    dockerArgs.push('--dangerously-skip-permissions');
  }

  dockerArgs.push(opts.prompt);

  const proc = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  const cleanup = () => {
    try { unlinkSync(configPath); } catch { /* best-effort */ }
  };

  return { proc, cleanup };
}
```

- [ ] **Step 2: 编译检查**

---

### Task 3: OpenCodeProvider — 实现 AbstractProvider

**Files:**
- Create: `apps/api/src/agent/providers/opencode.ts`

- [ ] **Step 1: 创建 OpenCodeProvider 类**

```typescript
import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { spawnOpenCodeInDocker } from '../OpenCodeContainer.js';
import { OpenCodeEventParser } from '../OpenCodeEventParser.js';

export class OpenCodeProvider implements AbstractProvider {
  readonly name = 'opencode';
  readonly capabilities = {
    persistentSession: true,
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private handlers: EventHandler[] = [];
  private killed = false;
  private openCodeSessionId: string | undefined;
  private currentContainerId = '';
  private currentHostWorkDir = '';
  private currentHostSandboxDir = '';
  private currentTrustMode = true;
  private currentAgentName = '';
  private currentModel: string | undefined;
  private currentBaseUrl: string | undefined;
  private currentApiKey = '';
  private childProc: import('child_process').ChildProcess | null = null;
  private pendingCleanup: (() => void) | null = null;
  private partialLine = '';
  private runSeq = 0;
  private eventParser: OpenCodeEventParser = new OpenCodeEventParser();
  private onSessionIdChange?: (sessionId: string) => void;

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    this.emit({ type: 'done', exitCode, timestamp: Date.now() });
  }

  getAgentHome(): string { return '/workspace'; }

  isAlive(): boolean {
    return !this.killed && this.childProc !== null;
  }

  setSessionIdCallback(cb: (sessionId: string) => void): void {
    this.onSessionIdChange = cb;
  }

  updateTrustMode(mode: boolean): void {
    this.currentTrustMode = mode;
  }

  async start(
    _sessionId: string,
    prompt: string,
    containerId: string,
    _workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.killed = false;
    this.currentContainerId = containerId;
    this.currentHostWorkDir = config.hostWorkDir || _workDir;
    this.currentHostSandboxDir = config.hostSandboxDir || config.hostWorkDir || _workDir;
    this.currentTrustMode = config.trustMode ?? true;
    this.currentAgentName = config.agentName || 'agent';
    this.currentModel = config.model;
    this.currentBaseUrl = config.baseUrl;
    this.currentApiKey = config.apiKey || '';

    return this.runInContainer(prompt, undefined);
  }

  sendPrompt(prompt: string): void {
    if (this.killed) return;
    this.stopChild();
    this.runInContainer(prompt, this.openCodeSessionId).catch((err) => {
      console.error(`[opencode:sendPrompt] ${err.message}`);
    });
  }

  private async runInContainer(prompt: string, resumeSession?: string): Promise<void> {
    this.partialLine = '';
    this.pendingCleanup = null;
    this.eventParser.reset();

    const { proc, cleanup } = spawnOpenCodeInDocker({
      containerId: this.currentContainerId,
      prompt,
      hostSandboxDir: this.currentHostSandboxDir,
      trustMode: this.currentTrustMode,
      apiKey: this.currentApiKey,
      baseUrl: this.currentBaseUrl,
      model: this.currentModel,
      resumeSession,
    });

    this.childProc = proc;
    this.pendingCleanup = cleanup;
    const runId = ++this.runSeq;

    return new Promise<void>((resolve) => {
      proc.stdout!.on('data', (chunk: Buffer) => {
        if (this.killed || runId !== this.runSeq) return;
        this.partialLine += chunk.toString();
        const lines = this.partialLine.split('\n');
        this.partialLine = lines.pop() ?? '';
        for (const line of lines) {
          const events = this.eventParser.parseLine(line);
          for (const event of events) {
            // After parsing step_start, check for new sessionId
            const sid = this.eventParser.getSessionId();
            if (sid && sid !== this.openCodeSessionId) {
              this.openCodeSessionId = sid;
              if (this.onSessionIdChange) {
                this.onSessionIdChange(sid);
              }
            }
            this.emit(event);
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        if (runId !== this.runSeq) return;
        const msg = chunk.toString().trim();
        if (msg) {
          console.log(`[opencode:stderr] ${msg.slice(0, 500)}`);
        }
      });

      proc.on('close', (code) => {
        if (runId !== this.runSeq) return;
        cleanup();
        this.childProc = null;
        this.pendingCleanup = null;
        if (!this.killed) {
          if (this.partialLine.trim()) {
            const events = this.eventParser.parseLine(this.partialLine);
            for (const event of events) {
              if (event.type !== 'done') this.emit(event);
            }
          }
          this.emitDone(code ?? 1);
          resolve();
        }
      });

      proc.on('error', (err) => {
        if (runId !== this.runSeq) return;
        cleanup();
        if (!this.killed) {
          this.emit({ type: 'error', message: `docker exec error: ${err.message}`, timestamp: Date.now() });
          this.emitDone(1);
          resolve();
        }
      });
    });
  }

  stopChild(): void {
    if (this.childProc) {
      try { this.childProc.kill('SIGTERM'); } catch { /* ignore */ }
      this.childProc = null;
    }
    if (this.pendingCleanup) {
      this.pendingCleanup();
      this.pendingCleanup = null;
    }
  }

  write(input: string): void {
    if (input.trim()) {
      this.sendPrompt(input);
    }
  }

  stop(): void {
    this.killed = true;
    this.stopChild();
  }
}
```

- [ ] **Step 2: 编译检查**

---

### Task 4: 注册 Provider + 更新路由 + 更新类型

**Files:**
- Modify: `apps/api/src/agent/providers/factory.ts`
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: factory.ts — 注册 opencode**

在 `init()` 方法中 claude-code 注册之后添加：
```typescript
ProviderFactory.register('opencode', () => new OpenCodeProvider());
console.log('[provider] Registered: opencode');
```

需要添加 import:
```typescript
import { OpenCodeProvider } from './opencode.js';
```

- [ ] **Step 2: routes/agents.ts — zod enum + 默认配置**

createSchema (line 29) 和 updateSchema (line 74):
```typescript
provider: z.enum(['claude-code', 'opencode']).default('claude-code'),
provider: z.enum(['claude-code', 'opencode']).optional(),
```

getDefaultProviderConfig (line 188):
```typescript
function getDefaultProviderConfig(provider: string): Record<string, unknown> {
  if (provider === 'claude-code') return { model: 'claude-sonnet-4-6' };
  if (provider === 'opencode') return { model: 'deepseek-chat' };
  return {};
}
```

- [ ] **Step 3: shared/types.ts — AgentProvider 加 'opencode'**

```typescript
export type AgentProvider = 'claude-code' | 'opencode';
```

- [ ] **Step 4: 编译检查**

---

### Task 5: 前端渲染 + 创建提示更新

**Files:**
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/components/AgentCreator.tsx`

- [ ] **Step 1: AgentCard.tsx — getProviderInfo 加 case**

```typescript
function getProviderInfo(provider?: AgentProvider) {
  switch (provider) {
    case 'opencode':
      return { label: 'OpenCode', color: 'bg-blue-500/20 text-blue-400', caps: 'SDK · Session · Stream' };
    case 'claude-code':
    default:
      return { label: 'Claude', color: 'bg-orange-500/20 text-orange-400', caps: 'SDK · Session · Stream' };
  }
}
```

- [ ] **Step 2: AgentCreator.tsx — 更新 placeholder 提示**

placeholder 第 143 行:
```
provider: claude-code  (or opencode)
```

错误提示第 26 行:
```
provider: claude-code (or opencode)\n---
```

---

### Task 6: Dockerfile — 安装 OpenCode

**Files:**
- Modify: `docker/sandbox.Dockerfile`

- [ ] **Step 1: 在 Dockerfile 中加 opencode-ai 安装**

在第 11 行 (`npm install -g zod`) 之后插入:
```dockerfile
RUN npm install -g opencode-ai@1.15.13
```

---

### 验证

- [ ] `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json`
- [ ] `grep -rn "ProviderFactory.list\|opencode" apps/api/src/agent/providers/factory.ts` 确认注册
