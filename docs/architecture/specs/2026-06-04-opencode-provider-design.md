# OpenCode Provider 接入设计文档

> **状态:** 设计已确认，待实现
> **日期:** 2026-06-04

## 1. 背景与目标

AgentHub 当前仅支持 Claude Code 作为 agent provider。项目通过 `ANTHROPIC_BASE_URL` 接入 DeepSeek 国产模型，工作良好。但 Codex 已确认不适合国产模型接入（协议不匹配），因此决定：

- 已删除 Codex provider（`codex.ts`、工厂注册、路由校验、前端标签）
- 接入 OpenCode 作为第二个 agent provider 平台，搭载 DeepSeek 等国产模型

### 核心原则

1. **完全独立路径**：OpenCode 的所有实现与 Claude Code 零交叉，各自走独立的代码路径
2. **前端无感知切换**：用户在前端选 Claude Code 或 OpenCode，所有差异在 provider 层消化
3. **最小改动**：复用现有架构模式（AbstractProvider、ProviderFactory、ProviderConfig），不改动 Claude Code 代码

---

## 2. 技术架构

### 2.1 整体数据流

```
┌─ Frontend ─────────────────────────────────────────────────────────────┐
│                                                                         │
│  AgentCreator (markdown frontmatter)                                    │
│    provider: opencode                                                   │
│         │                                                               │
│  AgentCard                                                              │
│    getProviderInfo('opencode') → label: 'OpenCode', color: blue-500     │
│                                                                         │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ POST /api/agents/from-md
                                   ▼
┌─ Backend ───────────────────────────────────────────────────────────────┐
│                                                                         │
│  routes/agents.ts                                                       │
│    z.enum(['claude-code', 'opencode']) ← 新增 opencode                  │
│                                                                         │
│  AgentRuntime.ts                                                        │
│    ProviderFactory.create(agent.provider) → OpenCodeProvider            │
│                                                                         │
│  providers/factory.ts                                                   │
│    register('opencode', () => new OpenCodeProvider())                   │
│                                                                         │
│  providers/opencode.ts                                                  │
│    OpenCodeProvider implements AbstractProvider                         │
│      │                                                                  │
│      ├── start() → spawnOpenCodeInDocker() → docker exec               │
│      ├── sendPrompt() → stopChild() + runInContainer(prompt, sessionId) │
│      ├── onEvent() → EventHandler 注册                                  │
│      └── isAlive() / stop() / write() / ...                            │
│                                                                         │
│  OpenCodeContainer.ts                                                   │
│    spawnOpenCodeInDocker({ containerId, prompt, sessionId, ... })       │
│      → writeFile(sandboxDir/opencode.json, config)                      │
│      → docker exec -e DEEPSEEK_API_KEY opencode run --format json ...   │
│      → stdout NDJSON 行解析                                             │
│                                                                         │
│  OpenCodeEventParser.ts                                                 │
│    NDJSON line → UnifiedAgentEvent                                      │
│      step_start → 捕获 sessionID                                        │
│      text      → thinking                                              │
│      tool_use  → tool_use + tool_result                                │
│      step_finish → token_usage                                         │
│      error     → error                                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─ Docker Sandbox ─────────────────────────────────────────────────────────┐
│                                                                         │
│  sandbox.Dockerfile                                                     │
│    + npm install -g opencode-ai@1.15.13                                 │
│                                                                         │
│  /sandbox/opencode.json  (宿主机写入, bind mount)                       │
│    {                                                                    │
│      "model": "deepseek/deepseek-chat",                                 │
│      "provider": {                                                      │
│        "deepseek": {                                                    │
│          "npm": "@ai-sdk/openai-compatible",                            │
│          "options": {                                                   │
│            "baseURL": "https://api.deepseek.com/v1",                    │
│            "apiKey": "{env:DEEPSEEK_API_KEY}"                           │
│          },                                                             │
│          "models": { "deepseek-chat": { "name": "DeepSeek Chat" } }     │
│        }                                                                │
│      }                                                                  │
│    }                                                                    │
│                                                                         │
│  执行:                                                                   │
│    opencode run --format json --session <id> --dangerously-skip-perms   │
│      -m deepseek/deepseek-chat "prompt"                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 多轮对话时序

```
Turn 1: 用户输入 "写一个 todo app"
  → OpenCodeProvider.start(prompt="写一个 todo app")
    → spawnOpenCodeInDocker({ prompt, resumeSession: undefined })
      → 写入 opencode.json
      → docker exec ... opencode run --format json "写一个 todo app"
        → stdout: {"type":"step_start","sessionID":"ses_abc123",...}
        → OpenCodeProvider.openCodeSessionId = "ses_abc123"
        → 流式输出 text、tool_use、step_finish 事件
      → 进程退出

Turn 2: 用户输入 "加暗色模式"
  → OpenCodeProvider.sendPrompt("加暗色模式")
    → stopChild() ← 杀掉可能残留的 docker exec
    → spawnOpenCodeInDocker({ prompt="加暗色模式", resumeSession: "ses_abc123" })
      → docker exec ... opencode run --format json --session ses_abc123 "加暗色模式"
        → 恢复历史上下文
        → 流式输出
      → 进程退出
```

---

## 3. 详细设计

### 3.1 `opencode.json` 动态生成

```typescript
// 在 OpenCodeContainer.ts 中
function generateOpenCodeConfig(providerConfig: ProviderConfig): object {
  const baseURL = providerConfig.baseUrl || "https://api.deepseek.com/v1";
  const model = providerConfig.model || "deepseek-chat";

  return {
    model: `deepseek/${model}`,
    provider: {
      deepseek: {
        npm: "@ai-sdk/openai-compatible",
        name: "DeepSeek",
        options: {
          baseURL,
          apiKey: "{env:DEEPSEEK_API_KEY}",
          timeout: 300000,
        },
        models: {
          [model]: { name: model },
        },
      },
    },
  };
}
```

配置写入 sandbox 目录：`/sandbox/opencode.json`，通过 bind mount 在容器内可见。

### 3.2 权限模式映射

```
Session PermissionMode (前端 4 级)
  │
  ├── read_only / ask  → trustMode = false  → OpenCode: 无 flag（严格模式）
  └── smart / trust    → trustMode = true   → OpenCode: --dangerously-skip-permissions
```

映射在 `chatHandlers.ts` 已有（`trustMode` 布尔值），OpenCode 侧只读取布尔值。

### 3.3 NDJSON 事件映射 (OpenCodeEventParser)

| OpenCode 事件 | 解析逻辑 | UnifiedAgentEvent |
|------|------|------|
| `step_start` | 提取 `sessionID`，不发射外部事件 | 内部: `this.sessionId = event.sessionID` |
| `text` | `event.part.text` → content | `{ type: 'thinking', content }` |
| `tool_use` | `event.part.tool` → toolName<br>`event.part.state.input` → toolInput<br>`event.part.state.output` → content | 先: `{ type: 'tool_use', toolName, toolInput }`<br>后: `{ type: 'tool_result', content }` |
| `step_finish` | `event.part.tokens` → token counts | `{ type: 'token_usage', inputTokens, outputTokens, ... }` |
| `error` | `event.error` → message | `{ type: 'error', message }` |
| 无法解析的行 | 作为文本 | `{ type: 'text', content: rawLine }` |

### 3.4 Docker 命令构造 (OpenCodeContainer)

```bash
docker exec -i \
  -e DEEPSEEK_API_KEY=<from encryptedApiKeys> \
  -e OPENCODE_CONFIG=/sandbox/opencode.json \
  -w /workspace \
  <containerId> \
  opencode run \
    --format json \
    --model deepseek/deepseek-chat \
    [--session <sessionId>] \
    [--dangerously-skip-permissions] \
    "<prompt>"
```

- `--session` 仅在 `resumeSession` 有值时添加
- `--dangerously-skip-permissions` 仅在 `trustMode=true` 时添加
- prompt 直接作为命令行参数（不需要文件传递）
- stderr 重定向到日志

### 3.5 OpenCodeProvider 接口实现

```typescript
export class OpenCodeProvider implements AbstractProvider {
  readonly name = 'opencode';
  readonly capabilities = {
    persistentSession: true,    // --session <id> 原生支持
    permissionProxy: true,      // --dangerously-skip-permissions
    streamingOutput: true,      // NDJSON stdout
    independentMemory: true,    // OpenCode session 隔离
    independentConfig: true,
  };

  // 核心方法:
  // start(sessionId, prompt, containerId, workDir, config)
  // sendPrompt(prompt)          → stopChild() + runInContainer(prompt, this.sessionId)
  // write(input)                → sendPrompt(input)
  // stop()                      → stopChild(), killed=true
  // stopChild()                 → kill 当前 docker exec 进程
  // isAlive()                   → !killed && childProc !== null
  // onEvent(handler)            → handlers.push(handler)
  // getAgentHome()              → '/workspace'
  // updateTrustMode(mode)       → this.trustMode = mode
}
```

---

## 4. 文件清单

### 4.1 新建文件

| 文件 | 职责 |
|------|------|
| `apps/api/src/agent/providers/opencode.ts` | `OpenCodeProvider` 实现 `AbstractProvider` |
| `apps/api/src/agent/OpenCodeContainer.ts` | `spawnOpenCodeInDocker()` 进程管理 + opencode.json 生成 |
| `apps/api/src/agent/OpenCodeEventParser.ts` | NDJSON → `UnifiedAgentEvent` 映射 |

### 4.2 修改文件

| 文件 | 改动 |
|------|------|
| `apps/api/src/agent/providers/factory.ts` | `init()` 中注册 `opencode` provider & log |
| `apps/api/src/routes/agents.ts` | zod enum 加 `'opencode'` ×2；`getDefaultProviderConfig` 加 opencode 默认值 |
| `packages/shared/src/types.ts` | `AgentProvider` 加 `'opencode'` |
| `apps/web/src/components/AgentCard.tsx` | `getProviderInfo()` 加 `case 'opencode'` |
| `docker/sandbox.Dockerfile` | `RUN npm install -g opencode-ai@1.15.13` |

### 4.3 不改动文件

- `apps/api/src/agent/providers/claude-code.ts` — 零改动
- `apps/api/src/agent/SDKContainer.ts` — 零改动
- `apps/api/src/agent/EventParser.ts` — 零改动
- `apps/api/src/agent/ClaudeAgentSDK.ts` — 零改动
- `docker/sdk-runner.mjs` — 零改动
- `apps/api/src/ws/chatHandlers.ts` — 零改动
- `apps/api/src/agent/AgentRuntime.ts` — 零改动（通用接口调用）

---

## 5. 验证计划

### 5.1 单元验证

```bash
# TypeScript 编译
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# 确认 provider 注册
# ProviderFactory.list() → ['claude-code', 'test', 'opencode']

# 确认 OpenCode 事件解析器正确映射 4 种事件类型
```

### 5.2 集成测试

1. **创建 OpenCode agent**：通过 markdown frontmatter 创建 `provider: opencode` 的 agent
2. **发送消息**：在 session 中 @OpenCode agent，发送 "hello"
3. **验证流式输出**：确认前端展示 thinking 文本
4. **验证工具调用**：发送 "read README.md"，确认文件读取结果
5. **验证多轮对话**：发送 "my name is Alice"，再发送 "what is my name"，确认 OpenCode 记住了上下文
6. **验证信任模式**：切换 session 权限模式，确认 `--dangerously-skip-permissions` 的开关

### 5.3 隔离验证

- 确认 Claude Code agent 依然正常工作（`provider: claude-code`）
- 确认两个 provider 的 agent 在同一个 session 中能分别响应
