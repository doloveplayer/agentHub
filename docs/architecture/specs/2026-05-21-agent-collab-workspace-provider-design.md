# AgentHub — Agent 协作协议、生产项目集成、多厂商适配设计规格

> Status: Partial Implementation · Date: 2026-05-21 · Updated: 2026-05-25
> 
> Implementation status (2026-05-25):
> - **§1 Collaboration Protocol**: Backend done (InboxManager, MilestoneBroadcaster exist); frontend UI NOT implemented (no MilestoneBubble, InboxIndicator)
> - **§2 Workspace Integration**: **Fully implemented** (WorkspaceManager, routes, FileTree, VersionTimeline all exist)
> - **§3 Provider Adapter**: Backend abstraction layer done (Claude Code only); Codex/OpenCode providers NOT implemented; ProviderSettings/AgentProviderBadge UI NOT implemented

## §1 Agent 协作协议（Agent Collaboration Protocol）

### Key Decisions

1. **三级广播模型**：Agent 活动分私聊（thinking/tool_use/tool_result）、群聊广播（milestone/产出/阻塞）、收件箱直投（介入请求）三个通道
2. **收件箱侧通道**：基于共享沙箱文件 `_inbox_{agentMessageId}.jsonl`，不占用 stdin，Agent 在 tool_use 自然间隙检查
3. **混合介入权限**：低风险自动执行 + 高风险需被介入方确认
4. **编排模式可选**：并行（当前）/ 顺序（Agent B 等待 A 完成）/ 自动（Planner DAG）

### Architecture

```
群聊消息 @CodeAgent @ReviewAgent
    ↓
用户选择编排模式：并行 / 顺序 / 自动
    ↓
┌─ 并行: 同时启动，各自独立（当前行为）
├─ 顺序: Agent A → milestone 广播 → Agent B 自动启动
└─ 自动: Planner 拆解 DAG → BullMQ 调度
    ↓
每个 Agent 附带:
  - 私聊流: agent_status WS → Agent Card 实时活动
  - 收件箱: _inbox_{agentMessageId}.jsonl（介入请求/响应）
  - 观察权限: 可读取其他 Agent 的 milestone 事件摘要
    ↓
Agent B 在 tool_use 间隙检查收件箱 → 发现介入请求
  → 摘要内容 + accept/decline → 回复到请求方收件箱
  → 不打断 Agent B 当前主工作流
```

### Event Classification

| Level | Event | Destination | Trigger |
|-------|-------|-------------|---------|
| internal | thinking | Agent Card (private) | every Claude Code text event |
| internal | tool_use | Agent Card (private) | every tool invocation |
| internal | tool_result | Agent Card (private) | every tool completion |
| **milestone** | **phase_complete** | **Group Chat + Agent Cards** | **task phase/subtask finishes** |
| **milestone** | **file_produced** | **Group Chat** | **Write/Edit tool produces output file** |
| **blocked** | **waiting_for** | **Group Chat + target inbox** | **Agent blocked on dependency** |
| **blocked** | **permission_hold** | **Group Chat** | **Permission request pending > 30s** |

### Inbox Protocol

```jsonl
{"type":"intervention_request","id":"inv-001","from":"review-agent","to":"code-agent-msg-123",
 "summary":"建议帮你补充 src/auth.ts 的错误处理逻辑","risk":"low","timestamp":1716259200000}

{"type":"intervention_response","id":"inv-001-resp","from":"code-agent-msg-123","to":"review-agent",
 "accepted":true,"message":"好的，请基于我目前的代码补充","timestamp":1716259260000}
```

### Intervention Rules (injected into system prompt)

```
You are part of a multi-agent session. Other agents may observe your work.

INBOX: Check /workspace/_inbox_{your_message_id}.jsonl after each tool_use completes.
If an intervention_request is found:
  - Read the summary
  - If it's helpful and relevant, respond with "accepted":true
  - If not relevant, respond with "accepted":false + brief reason

INTERVENE: You may offer help to other agents by writing to their inbox.
  - LOW RISK (sharing info, suggesting approaches): auto-send, no confirm needed
  - HIGH RISK (modifying code, running commands on their behalf): send intervention_request first

BROADCAST: When you complete a significant phase or produce key output files,
emit a milestone update to the group chat (type: 'milestone').
```

### File Structure (Phase 3.5)

```
apps/api/src/agent/
  InboxManager.ts          # read/write inbox files, check on interval
  MilestoneBroadcaster.ts   # classify events → milestone level, broadcast to WS

apps/api/src/ws/
  handler.ts                # [modify] new WS types: milestone, agent_intervene

apps/web/src/components/
  MilestoneBubble.tsx       # Group chat milestone message rendering
  InboxIndicator.tsx        # Agent Card inbox notification badge
```

---

## §2 生产项目集成（Live Workspace + Auto-Sync + Rollback）

### Key Decisions

1. **直接 bind-mount**：不是复制到 `.sandboxes/` 再同步回，而是 Docker 容器直接挂载真实项目目录为 `/workspace`
2. **Git 快照保护**：Agent 执行前自动创建 git commit/branch 快照，失败可一键回滚
3. **自动同步**：Docker 内修改实时反映到宿主文件系统（bind-mount 天然行为），无需 "确认后才覆盖"
4. **Files 标签页**：前端文件树直接浏览 `/workspace`，取代当前 Phase 3 占位符

### Architecture

```
Session 创建时指定 workspacePath: /home/user/my-project/
    ↓
SandboxManager.create(sessionId, { workspacePath })
    ↓
Docker 容器创建:
  HostConfig.Binds: [`${workspacePath}:/workspace`]  ← 直接挂载真实目录
    ↓
Agent 在容器内修改 /workspace → 宿主文件实时同步（bind-mount 行为）
    ↓
AgentHub 在 agent.start() 前自动执行:
  git -C ${workspacePath} stash create → snapshotRef
  （轻量快照，不产生 dangling commit）
    ↓
Agent 执行完成 / 用户确认 → 快照清理
Agent 执行出错 / 用户拒绝 → git -C ${workspacePath} stash apply snapshotRef → 回滚
```

### Session Config Extension

```typescript
// Session 创建时新增可选参数
POST /api/sessions
{
  "type": "group",
  "workspacePath": "/home/user/my-project/",  // 真实项目路径
  "autoSnapshot": true,                       // 自动 git 快照（默认 true）
  "snapshotMode": "stash" | "branch"          // 快照方式
}
```

### Files Tab (替换 Phase 3 占位符)

```
右侧面板 Files 标签页:
┌─────────────────────────┐
│ /workspace              │
│ ├── src/                │
│ │   ├── index.ts    ✏️   │  ← ✏️ = Agent 刚修改
│ │   ├── auth.ts         │
│ │   └── utils.ts        │
│ ├── package.json        │
│ └── tsconfig.json       │
│                         │
│ [展开文件内容]           │
│ [Diff 对比（入口）]      │
└─────────────────────────┘
```

### Rollback Flow

```
Agent 执行中修改了 3 个文件
  ↓
stream_end → 前端展示 "文件变更: src/auth.ts, src/index.ts, package.json"
  ↓
用户检查变更 → 满意 → 确认保留
  或 不满意 → 点击 Rollback → git stash apply → 恢复原状
```

### File Structure (Phase 3.5)

```
apps/api/src/agent/
  WorkspaceManager.ts      # workspace mount, git snapshot, rollback
  SandboxManager.ts        # [modify] create() accepts workspacePath

apps/web/src/components/
  FileTree.tsx             # Files tab — read /workspace tree, mark modified files
  RollbackConfirm.tsx      # rollback confirmation dialog

apps/api/src/routes/
  workspace.ts             # GET file tree, GET file content, POST rollback
```

---

## §3 多厂商 Agent 适配层（Provider Adapter）

### Key Decisions

1. **AbstractProvider 接口**：所有 CLI Agent 工具实现统一接口，`ClaudeCodeProcess` 重构为实现类
2. **用户自带配置**：每种 provider 的 API key / base URL 由用户在设置页填入，系统注入环境变量
3. **差异化展示**：Agent Card 骨架统一（状态/操作/文件），具体活动流内容因 provider 而异
4. **渐进接入**：先支持 Claude Code（已有），再新增 Codex / OpenCode

### Architecture

```
AgentConfig 表新增字段:
  provider: 'claude-code' | 'codex' | 'opencode'
  providerConfig: JSON { apiKey?, baseUrl?, model?, additionalEnv? }

Agent 创建时:
  用户选择 provider → 下拉框展示可用 CLI 工具
  系统从用户设置中读取对应的 API key → 注入 AgentConfig.providerConfig

Agent 启动时:
  TaskQueueManager / handleChatMessage
    → ProviderFactory.create(agent.provider, agent.providerConfig)
    → 返回 AbstractProvider 实例
    → provider.start(sessionId, prompt, workDir, config)
```

### AbstractProvider Interface

```typescript
interface AbstractProvider {
  readonly name: string;

  // Lifecycle
  start(
    sessionId: string,
    prompt: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void>;

  stop(): void;
  write(input: string): void;

  // Unified event stream
  onEvent(handler: (event: UnifiedAgentEvent) => void): void;
}

interface UnifiedAgentEvent {
  type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start'
      | 'subagent_result' | 'permission_request' | 'milestone'
      | 'blocked' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  filePath?: string;
  exitCode?: number;
  providerRaw?: unknown;  // raw provider event for Agent Card diff display
  timestamp: number;
}

interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  env?: Record<string, string>;
}
```

### Provider Implementations

| Provider | Execution Model | Output Format | Parser |
|----------|----------------|---------------|--------|
| claude-code | `spawn docker run -i` native pipes | stream-json (JSON lines) | EventParser (existing) |
| codex | `spawn docker run -i` native pipes | JSON lines + plain text | CodexParser (new) |
| opencode | `spawn docker run -i` native pipes | JSON lines | OpenCodeParser (new) |

### Agent Card Differentiation

```
Agent Card (骨架统一):
┌─────────────────────────────────┐
│ 🟢 AgentName          [Claude]  │  ← provider badge
│ ├─ 当前: Write(src/auth.ts)     │  ← unified event, all providers
│ ├─ 修改: src/auth.ts            │  ← unified, all providers
│ └─ 活动流 (差异化):             │
│     Claude: 💭thinking → 🔧tool │  ← Claude-specific rendering
│     Codex:  📊analysis → ✏️edit │  ← Codex-specific rendering
└─────────────────────────────────┘
```

### User Settings Page

```
设置页（新页面或弹窗）:
┌─────────────────────────────────────────┐
│ Agent Provider 配置                      │
│                                         │
│ Claude Code                             │
│   API Key:  [••••••••••••••••]  [编辑]  │
│   Base URL: [https://api.anthropic.com] │
│   Status: ✅ 已配置                      │
│                                         │
│ Codex                                   │
│   API Key:  [未配置]            [编辑]  │
│   Status: ⚠️ 未配置                      │
│                                         │
│ OpenCode                                │
│   API Key:  [未配置]            [编辑]  │
│   Status: ⚠️ 未配置                      │
└─────────────────────────────────────────┘
```

### File Structure (Phase 4)

```
apps/api/src/agent/providers/
  base.ts                  # AbstractProvider interface + UnifiedAgentEvent
  claude-code.ts           # ClaudeCode provider (refactored from ClaudeCodeProcess)
  codex.ts                 # Codex CLI provider
  opencode.ts              # OpenCode CLI provider
  factory.ts               # ProviderFactory.create(providerName, config)

apps/api/prisma/
  schema.prisma            # [modify] Agent model: +provider +providerConfig (JSON)

apps/web/src/
  components/
    ProviderSettings.tsx   # API key management per provider
    AgentProviderBadge.tsx # Badge on AgentCard showing provider name
  pages/
    SettingsPage.tsx       # User settings page (if not already)

packages/shared/src/
  types.ts                 # [modify] AgentConfig: +provider +providerConfig
```

---

## Development Roadmap

| Phase | Content | Dependencies | Timeline |
|-------|---------|-------------|----------|
| **Phase 3** | Planner + BullMQ + DAG Viz (existing plan) | None (in progress) | Current |
| **Phase 3.5 §1** | Agent Collaboration Protocol | Phase 3 Tier 0 complete | After Tier 1 |
| **Phase 3.5 §2** | Production Workspace Integration | Phase 3.5 §1 (Files tab) | After Tier 1 |
| **Phase 4a** | Multi-vendor Provider Adapter (§3) | Phase 3.5 stable | After 3.5 |
| **Phase 4b** | Diff Viz + Preview + Code Review + Deploy + Test + Security (§4.4) | Phase 4a + Phase 3.5 | After 4a |

---

## Verification Checklist

### §1 Agent Collaboration
- [ ] Group chat shows milestone messages at phase boundaries
- [ ] Inbox file created per agent, writable by all agents in session
- [ ] Agent checks inbox between tool_use cycles (not during active tool)
- [ ] Intervention request → accepted/declined → low-risk auto-approved
- [ ] Irrelevant agent cannot intervene (system prompt domain constraint)
- [ ] Sequential mode: Agent B waits for Agent A milestone → auto-starts
- [ ] User can choose parallel/sequential/auto mode per message

### §2 Production Workspace
- [ ] Session created with workspacePath → Docker bind-mounts it
- [ ] Agent modifies file → host file updated immediately (bind-mount)
- [ ] Git snapshot created before agent.start(), cleaned after confirm
- [ ] Rollback restores workspace to snapshot state
- [ ] Files tab shows real directory tree with modified-file indicators
- [ ] Workspace without git repo gracefully handles snapshot failure

### §3 Multi-vendor Provider
- [ ] Claude Code provider works identically to current ClaudeCodeProcess
- [ ] Codex provider starts CLI, parses output to UnifiedAgentEvent
- [ ] OpenCode provider starts CLI, parses output to UnifiedAgentEvent
- [ ] Agent Card shows provider badge + provider-specific activity stream
- [ ] User settings page stores/retrieves per-provider API keys
- [ ] ProviderFactory routes to correct implementation by provider name
- [ ] Switching provider does not require code changes — config-driven
