# 会话 `7a9d6b7f` 诊断报告与修复方案

> Date: 2026-05-21 · Status: Implementing

## 诊断概要

审查 `.sandboxes/7a9d6b7f-2b89-4feb-b755-0a57077c44ae/` 历史会话，用户通过群聊 @Planner 排查"Windows 代理无法打开 ChatGPT"问题。共发现 9 个问题，本文档聚焦其中 4 个并给出修复方案。

---

## 问题 3：REPL 进程复用完全未生效（P0）

### 现象

5 次对话轮次 spawn 了 5 个独立 Claude Code 进程，各有独立 `.claude/` 目录和 userID。REPL 模式（`cat file - | claude`）设计的复用能力完全没有生效。

### 根因

`ClaudeCodeProvider`（REPL 模式，`apps/api/src/agent/providers/claude-code.ts`）已完整实现但从未被实例化：
- `handler.ts:22` 声明了 `agentProcesses` Map
- `handler.ts:362-388` 有完整的复用检查逻辑
- 但 `agentProcesses.set()` 从未被调用
- 因此 `handler.ts:368` 的 `existingProc` 永远是 null
- `handler.ts:391` 永远走 `new ClaudeCodeProcess()`（一次性，`docker run --rm`）

### 修复方案

在 handler.ts 中，当 existingProc 为 null 时，创建 `ClaudeCodeProvider` 实例并注册到 `agentProcesses`。

---

## 问题 4：上下文无限膨胀（P1）

### 现象

5 轮 prompt 从 2368 字节增长到 9879 字节。每轮注入完整 system prompt（~2500 bytes）+ 最近 20 条历史消息全文。

### 修复方案

REPL 复用后，`sendPrompt()` 只发本轮用户消息文本，不再拼接 system prompt 和历史——Claude Code REPL 自行管理上下文。

---

## 问题 8：Planner 双角色混淆（P2）

### 现象

Planner system prompt 第一句"你是群聊管理员+任务规划专家"导致其来者不拒，处理了它不擅长的网络诊断。handler.ts Branch C（没人 @ 就找 Planner）加剧了这个问题。

### 修复方案

重写 Planner system prompt：明确"群聊主持人"和"任务规划器"的能力边界，增加拒止机制。

---

## 问题 9：CLAUDE.md 与 system prompt 高度重复（P1）

### 现象

`AgentDirectoryManager.initialize()` 把 system prompt 原样写入 CLAUDE.md，然后 handler.ts 又在 prompt 中注入一次。且当前 one-shot 模式下 CLAUDE.md 从未被实际读取。

### 修复方案

趁 REPL 修复之机，分离持久身份（CLAUDE.md）和一次性指令（sendPrompt 参数）：
- CLAUDE.md：agent 身份定义、能力边界、双模式规则、协作规则
- prompt 注入：仅本轮用户消息

---

## 涉及文件

| 文件 | 改动 |
|------|------|
| `apps/api/src/ws/handler.ts` | 接入 ProviderFactory 创建 REPL 实例并注册到 agentProcesses；REPL 路径 sendPrompt 简化 |
| `apps/api/src/defaultAgents.ts` | 重写 Planner system prompt：双角色边界 + 拒止规则 |
| `apps/api/src/agent/AgentDirectoryManager.ts` | 更新写入 CLAUDE.md 的内容结构 |

## 验证方法

1. 创建群聊会话，连续发送多条消息给同一 Agent
2. 检查 `.sandboxes/` 下只有 1 个 `_agent_{name}/` 目录
3. 后端日志出现 `[ws] Reusing REPL process for agent=xxx`
4. TypeScript: `npx tsc --noEmit -p apps/api/tsconfig.json` 零错误
