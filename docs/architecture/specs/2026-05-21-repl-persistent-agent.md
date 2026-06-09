# AgentHub — REPL Persistent Agent Architecture Design

> Status: Implemented · Date: 2026-05-21 · Updated: 2026-05-21

## Motivation

当前 ClaudeCodeProcess 使用 `claude --print` 一次性 CLI 调用。每次 @Agent 消息都 spawn 一个全新进程，回复完即退出。导致：

- **无持久上下文**：每轮对话必须从 DB 重建 chat history 注入 prompt
- **无独立记忆**：无法使用 Claude Code 原生的 `.claude/memory/` 系统
- **无个性化配置**：所有 Agent 共享同一个 system prompt，无法独立配置 CLAUDE.md/skills/MCP

**目标**：将 Agent 执行模型从 "一次性 CLI" 升级为 "每 Agent 独立容器 + 原生管道"，每个 Agent 拥有独立记忆、配置和会话状态，同时保持共享沙箱文件系统以支持协作。

## Key Decisions

1. **spawn + docker run -i 替代 docker exec**：`child_process.spawn('docker', ['run', '-i', ...])`，原生 Node.js 管道，无 Docker 多路复用
2. **每 Agent 独立容器**：`docker run --rm -i --name agenthub-agent-{session}-{agent}`，`--rm` 自动清理
3. **每 Agent 独立 CLAUDE_CONFIG_DIR**：`_agent_{name}/.claude/` bind-mount 到容器内 `/home/node/.claude/`，包含 memory/、skills/、CLAUDE.md
4. **共享 workspace bind-mount**：所有容器挂载同一 `hostWorkDir:/workspace`，文件协作不受影响
5. **默认 --dangerously-skip-permissions**：沙箱隔离 + git 快照 + 用户最终确认 = 三层保护，权限代理（#10）被 Claude Code CLI stream-json 模式阻塞

## Architecture

### 进程模型

```
当前 (docker exec):
  SandboxManager.execStream → docker exec 多路复用 → muxWrite 编码/手动 demux
  ❌ stdin 开放时 stdout 阻塞（Docker 多路复用协议限制）

新 (spawn + docker run -i):
  child_process.spawn('docker', ['run', '-i', ...]) → 原生 Node.js stdin/stdout pipe
  ✅ 全双工原生管道，无多路复用层
```

### Agent 目录结构

```
.sandboxes/{sessionId}/
  _env.sh                              # 共享 API 凭证
  _agent_code-agent/
    CLAUDE.md                          # 独立角色定义 + 协作规则
    .claude/
      memory/                          # 独立持久记忆（bind-mount 到容器）
      skills/                          # 独立 skills 挂载
    _inbox_{agentMessageId}.jsonl      # 收件箱文件
  _agent_review-agent/
    .claude/ ...
  _agent_planner/
    .claude/ ...
```

### 容器配置

```
docker run --rm -i \
  --name agenthub-agent-{sessionId8}-{messageId12} \
  -v {hostWorkDir}:/workspace \                          # 共享工作区
  -v {hostWorkDir}/_agent_{name}/.claude:/home/node/.claude \  # 独立记忆/配置
  -e CLAUDE_CONFIG_DIR=/home/node/.claude \              # Claude Code 记忆路径
  -w /workspace \
  agenthub-sandbox:latest \
  sh -c '. /workspace/_env.sh && cat /workspace/_prompt.txt | claude \
    --print --output-format stream-json --verbose --dangerously-skip-permissions'
```

### 当前状态

| 能力 | 状态 |
|------|------|
| spawn + docker run -i | ✅ 已实现 |
| 独立 CLAUDE_CONFIG_DIR bind-mount | ✅ 已实现 |
| AgentDirectoryManager 懒加载 | ✅ 已实现 |
| REPL 进程复用（同一 Agent 多次 @） | ⏳ Phase 3.5 Task 1 |
| 独立 CLAUDE.md / skills 内容定制 | ⏳ Phase 3.5 |
| 权限代理（#10） | ⚠️ Claude Code CLI stream-json 不支持交互式 stdin 权限 |

## File Structure

```
apps/api/src/agent/
  ClaudeCodeProcess.ts     # [REWRITTEN] spawn + docker run -i, 独立 CLAUDE_CONFIG_DIR
  AgentDirectoryManager.ts  # [DONE] 创建/清理 Agent 独立目录
  providers/
    base.ts                 # [DONE] AbstractProvider + capabilities
    claude-code.ts          # [STUB] ClaudeCodeProvider 骨架
    factory.ts              # [DONE] ProviderFactory

apps/api/src/ws/
  handler.ts                # [MODIFIED] Agent 目录懒加载，REPL 进程复用检查

apps/api/src/
  index.ts                  # [MODIFIED] ProviderFactory.init()，agent 容器清理
```

## Verification Checklist

- [x] spawn + docker run -i 原生管道 stdout 流正常
- [x] 独立 CLAUDE_CONFIG_DIR bind-mount 到容器
- [x] Agent 退出后 `--rm` 自动清理容器
- [x] AgentDirectoryManager 首次 @ 时懒加载目录
- [ ] 同一 Agent 第二次 @ 时复用已有 REPL 进程
- [ ] 独立 CLAUDE.md 内容生效（协作规则注入）
- [ ] Agent 空闲超时自动终止
- [ ] Session 关闭清理所有 agent 容器
