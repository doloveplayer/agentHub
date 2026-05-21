# AgentHub — REPL Persistent Agent Architecture Design

> Status: Draft · Date: 2026-05-21

## Motivation

当前 ClaudeCodeProcess 使用 `claude --print` 一次性 CLI 调用。每次 @Agent 消息都 spawn 一个全新进程，回复完即退出。导致：

- **无持久上下文**：每轮对话必须从 DB 重建 chat history 注入 prompt
- **无独立记忆**：无法使用 Claude Code 原生的 `.claude/memory/` 系统
- **无个性化配置**：所有 Agent 共享同一个 system prompt，无法独立配置 CLAUDE.md/skills/MCP
- **无权限交互**：`--print` 模式下 `permission_request` 事件不被发出（#10 阻塞根因）
- **无 Agent 间直接通信**：Inbox 无法通过 stdin 投递，必须迂回使用 `/proc/pid/fd/0`

**目标**：将 Agent 执行模型从 "一次性 CLI" 升级为 "持久 REPL 进程"，每个 Agent 拥有独立记忆、配置和会话状态，同时保持共享沙箱文件系统以支持协作。

## Key Decisions

1. **REPL 替代 --print**：`claude --output-format stream-json --verbose`（无 `--print`）。进程持续运行，通过 stdin 接收 prompt + 后续指令
2. **每 Agent 独立目录**：`hostWorkDir/_agent_{agentName}/` 下挂载 `CLAUDE.md`、`.claude/memory/`、`.claude/skills/`
3. **共享沙箱 + 认知隔离**：Docker 容器仍共享，文件系统协作不受影响；但每个 Agent 的 HOME 目录或工作配置指向独立子目录
4. **AbstractProvider 兼容**：接口支持 `capabilities.persistentSession` 标志，不支持 REPL 的 provider 降级为旧的一次性模式
5. **最早执行**：在 Phase 3.5 所有功能之前完成，因为 InboxManager、MilestoneBroadcaster、顺序编排均依赖持久 stdin

## Architecture

### 进程模型对比

```
旧模式 (--print):
  docker exec → cat prompt | claude --print → stdout → done → process exits
  每次 @Agent 都是一次全新的 docker exec

新模式 (REPL):
  docker exec → cat prompt - | claude → stdout → 等待下一行 stdin → 不退出
  进程常驻，后续消息通过 stdin 投递新一轮 prompt
```

### Agent 目录结构

```
.sandboxes/{sessionId}/
  _env.sh                          # 共享 API key（所有 Agent 共用）
  _agent_code-agent/
    CLAUDE.md                      # 独立角色定义 + 工具权限
    .claude/
      memory/                      # 独立持久记忆
      skills/                      # 独立 skills 挂载
    _inbox_{agentMessageId}.jsonl  # 收件箱文件
  _agent_review-agent/
    CLAUDE.md
    .claude/
      memory/
      skills/
    _inbox_{agentMessageId}.jsonl
  workspace/                       # 共享工作区（Agent 间协作文件）
```

### REPL 生命周期

```
Session 创建时:
  → 为每个注册 Agent 创建独立目录 + CLAUDE.md
  → 不启动进程（懒惰启动，等首次 @）

首次 @Agent 时:
  → 检查进程是否已存在
  → 不存在: docker exec 启动 REPL 进程，stdin 投递 prompt
  → 已存在: stdin 投递下一轮 prompt

Agent 空闲时:
  → 超时 5 分钟无 stdin 输入 → 自动终止进程
  → 终止时保存 memory 到磁盘（Claude Code 自动处理）

Session 关闭时:
  → 终止所有 Agent REPL 进程
  → 清理 Agent 目录
```

### 交互流程

```
用户 @CodeAgent "写一个 auth.ts"
  → handler 检查 Agent 进程是否存活
  → 存活: stdin.write("新的任务: 写一个 auth.ts\n")
  → 未存活: start REPL → stdin.write(prompt)
  ↓
Claude Code REPL 处理:
  → 输出 thinking → stream_chunk → 前端流式显示
  → 需要写文件 → emit tool_use(Write) → 等待权限
  → handler 收到 permission_request → 广播到前端
  → 用户 Allow → stdin.write("y\n")
  → Claude Code 继续执行 → tool_result → done
  → REPL 等待下一行 stdin（不退出）
```

## AbstractProvider Extension

```typescript
interface AbstractProvider {
  readonly name: string;
  readonly capabilities: {
    persistentSession: boolean;  // REPL 持久会话支持
    permissionProxy: boolean;    // 权限请求事件支持
    streamingOutput: boolean;    // 流式输出支持
    independentMemory: boolean;  // 独立记忆系统支持
    independentConfig: boolean;  // 独立 CLAUDE.md/skills 支持
  };

  start(sessionId, prompt, containerId, workDir, config): Promise<void>;
  sendPrompt(prompt: string): void;  // NEW: 向已有 REPL 投递新一轮 prompt
  write(input: string): void;
  stop(): void;
  onEvent(handler): void;
  isAlive(): boolean;           // NEW: 检查进程是否存活
}
```

## Provider Capability Matrix

| Provider | persistentSession | permissionProxy | independentMemory | independentConfig |
|----------|-------------------|-----------------|--------------------|--------------------|
| claude-code | ✅ | ✅ | ✅ | ✅ |
| codex | ❓ | ❓ | ❓ | ❓ |
| opencode | ❓ | ❓ | ❓ | ❓ |

不支持 `persistentSession` 的 provider 降级为旧模式：
- 每次消息 = 新 `docker exec --print` 调用
- 无独立记忆/配置
- 权限静默跳过

## File Structure

```
apps/api/src/agent/
  ClaudeCodeProcess.ts     # [MAJOR REFACTOR] --print → REPL, +sendPrompt, +isAlive
  AgentDirectoryManager.ts  # NEW: 创建/清理 Agent 独立目录
  providers/
    base.ts                 # NEW: AbstractProvider + capabilities
    claude-code.ts          # NEW: ClaudeCodeProvider 实现
    factory.ts              # NEW: ProviderFactory

apps/api/src/ws/
  handler.ts                # [MODIFY] 检查 Agent 进程存活，复用 REPL 进程

apps/api/src/
  defaultAgents.ts          # [MODIFY] 新增 agentDir 模板
```

---

## Verification Checklist

- [ ] Agent 首次 @ 时启动 REPL 进程，stdout 流正常
- [ ] 同一 Agent 第二次 @ 时复用已有进程，不启动新进程
- [ ] 每个 Agent 拥有独立的 `_agent_{name}/CLAUDE.md`、`memory/`、`skills/` 目录
- [ ] 共享 workspace/ 文件系统不受影响
- [ ] Agent 空闲 5 分钟自动终止
- [ ] REPL 模式下 permission_request 事件正常发出并路由到前端
- [ ] 权限 Allow/Deny 通过 stdin 投递到 REPL 进程
- [ ] 不支持 REPL 的 provider 降级为旧的一次性模式
- [ ] 现有一次性 `--print` 模式通道保留（向后兼容）
