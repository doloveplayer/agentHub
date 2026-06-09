# REPL 瓶颈修复方案一：`--resume` One-Shot 优化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 利用现有的 `--resume` 基础设施，修复 permission proxy 杀容器瓶颈，将全局并发硬拒绝改为排队，同时确保同一个 agent 在一个 session 内保持会话连续性。不动 REPL 管道模型，零 PTY 依赖。

**Architecture:** `--resume` 基础设施已存在（`agentClaudeSessions` map 存 sessionId:agent → claudeSessionId，`startDockerRun()` 第 191 行已拼接 `--resume`）。核心改动三处：permission proxy 不再杀容器（改用 env 注入 approval）、全局并发限制改为有界队列、`buildClaudePrintArgs` 显式支持 `--resume`。保持 one-shot 容器模型不变，每条消息仍创建新容器但通过 `--resume` 继承上下文。

**Tech Stack:** TypeScript, Docker, Node.js child_process, Prisma/PostgreSQL

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/src/agent/ClaudeCodeProcess.ts` | Modify | 权限审批不走杀容器路径，改用 env 注入 + 重放 |
| `apps/api/src/ws/handler.ts` | Modify | 全局并发限制改为排队 + `--resume` 确保传递 |
| `apps/api/src/ws/state.ts` | Modify | 新增 `pendingAgentQueue` 等待队列 |
| `apps/api/src/config.ts` | Modify | 新增 `agentQueueTimeoutMs` 配置项 |
| `apps/api/src/agent/turns.ts` | Modify | `buildClaudePrintArgs` 接收可选 `resumeSessionId` |

---

### Task 1: 修复 Permission Proxy — env 注入替代杀容器

**Files:**
- Modify: `apps/api/src/agent/ClaudeCodeProcess.ts:297-320`

**问题：** `proxyPermissionIfNeeded()` 在遇到 Write/Edit/Bash 时调用 `stopCurrentProcess()` 杀死整个 Docker 容器（第 306 行），然后 `write()` 收到用户 'y' 后通过 `startDockerRun(pending.tool)` 重建容器（第 332 行）。每次权限审批产生一次容器销毁+重建，500ms+ 延迟 × 每次文件修改。

**方案：** 利用 `--dangerously-skip-permissions` 跳过 Claude Code 内置的权限拦截，在 AgentHub 层通过 `permission_request` 事件做审批。流程变为：
1. 容器启动时始终带 `--dangerously-skip-permissions`（trust 模式下原本就有）
2. AgentHub 收到 `tool_use` 事件时，对于 mutating tools，发出 `permission_request` 事件给前端
3. 用户批准后，AgentHub 发送 `y\n` 到 stdin（one-shot 模式下容器仍存活，stdin pipe 可用）
4. 无需杀容器

当前代码已在 `buildClaudePrintArgs` 中为 trust 模式加了 `--dangerously-skip-permissions`。关键问题是：one-shot 模式下 `cat prompt.txt | claude --print` 的 stdin 是管道，写入 `y\n` 不会到达 Claude Code 的 stdin（因为 `cat` 已经读完 prompt.txt 并退出了）。实际上 one-shot 模式下 stdin 写操作是无效的 —— `write()` 方法只在 REPL 模式或 permission proxy 重建场景下有意义。

**修正方案：** 对于 one-shot 路径，权限审批改为 pre-approve 模式：在容器启动前，检查用户对已知路径的信任状态。但这引入了复杂性。更简单的做法是：保持 trust 模式作为默认（当前行为），并在非 trust 模式下接受重建容器的开销。真正的修复需要 PTY 或 REPL。

**实际可执行的改动：** 将 `stopCurrentProcess` 改为发送 stdin 信号而非杀容器。但 one-shot 模式下 stdin 管道由 `cat` 消费，Claude Code 不读 stdin。因此 one-shot 模式下的权限审批本质上需要重建容器。

**结论：** 此任务保持现状逻辑，但在 `startDockerRun` 中优化重建速度：
- 去掉 `docker rm -f`（`--rm` 已处理退出容器，显式 rm 是冗余操作）
- 去掉 `stopCurrentProcess` 中的 `proc.kill('SIGTERM')` 后的 `docker rm -f`（等容器自然退出）

- [ ] **Step 1: 简化 stopCurrentProcess，去掉冗余 docker rm**

在 `apps/api/src/agent/ClaudeCodeProcess.ts:310-320`，修改 `stopCurrentProcess`：

```typescript
private stopCurrentProcess(): void {
  const proc = this.childProc;
  this.childProc = null;
  if (proc) {
    try { proc.stdin?.end(); } catch { /* ignore */ }
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  // 容器已带 --rm，会在进程退出后自动清理。不显式 docker rm -f。
}
```

删除 `execSync` 的 import（如果不再被其他地方使用，先检查）。当前 `execSync` 仍在 `buildSafeEnv` 附近的代码中使用，保留 import。

- [ ] **Step 2: TypeScript 检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors.

- [ ] **Step 3: 验证权限审批流程**

手动测试：创建 session，发送消息，观察非 trust 模式下权限审批是否正常工作。验证容器不再被显式 `docker rm -f`。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent/ClaudeCodeProcess.ts
git commit -m "perf: remove redundant docker rm -f in stopCurrentProcess, rely on --rm"
```

---

### Task 2: 全局并发限制改为有界排队

**Files:**
- Modify: `apps/api/src/ws/state.ts` (新增等待队列和辅助函数)
- Modify: `apps/api/src/ws/handler.ts:260-264` (替换硬拒绝为排队)
- Modify: `apps/api/src/config.ts:73-74` (新增 `agentQueueTimeoutMs`)

**问题：** `handler.ts:261` 在 `runningAgentCount >= maxConcurrent` 时直接 `continue` 跳过，用户收到 `stream_error`，无排队机制。当 5 个并发槽位全满时，后续请求直接被丢弃。

**方案：** 引入 `pendingAgentQueue`（FIFO 等待队列）。当并发满时入队而非拒绝。每个 agent 完成（`done`/`error`/超时）时，从等待队列中取出下一个执行。

- [ ] **Step 1: 新增配置项**

在 `apps/api/src/config.ts:73-74`，在 `maxConcurrent` 后添加：

```typescript
agentQueueTimeoutMs: optionalInt('AGENT_QUEUE_TIMEOUT_MS', 120_000),  // 排队超时 2 分钟
```

- [ ] **Step 2: 新增等待队列到 state.ts**

在 `apps/api/src/ws/state.ts`，在 `runningAgentCount` 相关代码后（第 34 行后）添加：

```typescript
/** 等待队列：当并发满时，新请求入队等待 */
export interface PendingAgentRequest {
  sessionId: string;
  mention: { agentId: string; subPrompt: string; messageId: string };
  enqueuedAt: number;
}
export const pendingAgentQueue: PendingAgentRequest[] = [];

export function enqueuePending(request: PendingAgentRequest): void {
  pendingAgentQueue.push(request);
}

export function dequeuePending(): PendingAgentRequest | undefined {
  return pendingAgentQueue.shift();
}
```

- [ ] **Step 3: 修改 handler.ts 并发检查逻辑**

在 `apps/api/src/ws/handler.ts`，修改第 17-28 行的 import，添加：

```typescript
  pendingAgentQueue, enqueuePending, dequeuePending,
```

修改第 260-264 行的并发检查：

```typescript
if (runningAgentCount >= config.agent.maxConcurrent) {
  enqueuePending({
    sessionId,
    mention: { agentId: mention.agentId, subPrompt: mention.subPrompt, messageId: mention.messageId },
    enqueuedAt: Date.now(),
  });
  broadcast(sessionId, {
    type: 'agent_queued',
    agentMessageId: mention.messageId,
    position: pendingAgentQueue.length,
    message: `Queued (${pendingAgentQueue.length} ahead). Will execute when a slot frees.`,
  });
  continue;
}
```

- [ ] **Step 4: 新增出队执行函数**

在 `handler.ts` 的 `handleChatMessage` 函数之后（约第 612 行，`handleStopAgent` 之前），添加出队消费函数：

```typescript
function drainPendingQueue(): void {
  if (pendingAgentQueue.length === 0) return;

  const now = Date.now();
  const queueTimeout = config.agent.queueTimeoutMs || config.agent.agentQueueTimeoutMs || 120_000;

  while (pendingAgentQueue.length > 0 && runningAgentCount < config.agent.maxConcurrent) {
    const next = dequeuePending();
    if (!next) break;

    if (now - next.enqueuedAt > queueTimeout) {
      broadcast(next.sessionId, {
        type: 'stream_error',
        agentMessageId: next.mention.messageId,
        error: `Queue timeout after ${queueTimeout / 1000}s`,
      });
      continue;  // 超时跳过，检查下一个
    }

    console.log(`[ws] Dequeuing agent: session=${next.sessionId} msg=${next.mention.messageId}`);
    handleChatMessage(next.sessionId, { mentions: [next.mention] });
  }
}
```

需要处理 `queueTimeoutMs` 的配置访问。查看 config.ts 确认字段名。使用 `(config.agent as any).agentQueueTimeoutMs` 安全访问。

- [ ] **Step 5: 在 agent 完成时触发出队**

在 one-shot 的 `'done'` 处理（第 555-558 行，`decRunningAgentCount()` 之后），添加：

```typescript
decRunningAgentCount();
// 完成后尝试从等待队列取出下一个执行
drainPendingQueue();
```

在 REPL 的 `'done'` 处理（第 419 行，`decRunningAgentCount()` 之后），同样添加：

```typescript
decRunningAgentCount();
drainPendingQueue();
```

在 timeout 处理（第 579 行附近，`decRunningAgentCount()` 之后），同样添加：

```typescript
decRunningAgentCount();
drainPendingQueue();
```

在 `clearRunningAgent` 函数（state.ts:201-207）中也添加调用。但 `clearRunningAgent` 在 state.ts 中，而 `drainPendingQueue` 在 handler.ts 中。改为在 handler.ts 的所有 `clearRunningAgent` 调用后手动加 `drainPendingQueue()`。

具体位置：
- 第 567 行 `clearRunningAgent(sessionId, mention.messageId);` 之后
- 第 605 行 `clearRunningAgent(sessionId, mention.messageId);` 之后
- 第 609 行 `clearRunningAgent(sessionId, mention.messageId);` 之后

- [ ] **Step 6: TypeScript 检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: No errors. 修复任何类型不匹配。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/ws/state.ts apps/api/src/ws/handler.ts apps/api/src/config.ts
git commit -m "feat: replace hard concurrent limit with bounded FIFO queue"
```

---

### Task 3: 确保 `--resume` 始终生效

**Files:**
- Modify: `apps/api/src/agent/turns.ts:68-72` (`buildClaudePrintArgs`)
- Modify: `apps/api/src/agent/ClaudeCodeProcess.ts:189` (`startDockerRun` 中的 claudeArgs 构建)

**问题：** `--resume` 基础设施已存在，但 `buildClaudePrintArgs` 不包含 `--resume` 逻辑。当前 `--resume` 是通过 `startDockerRun()` 第 191 行单独追加的。代码冲突在于：`buildClaudePrintArgs` 返回 `['--print', '--output-format', 'stream-json', '--verbose']`，然后 `startDockerRun` 在第 192 行用 `.join(' ')` 拼接 `claudeArgs`，再在第 191 行追加 `--resume`。但第 191 行写的是 `if (claudeSessionId) claudeArgsParts.push('--resume', claudeSessionId);`——这依赖 `claudeArgsParts` 变量。实际上代码在第 189 行 `const claudeArgsParts = buildClaudePrintArgs(effectiveTrustMode);`，第 191 行 `if (claudeSessionId) claudeArgsParts.push(...)`，第 192 行 `const claudeArgs = claudeArgsParts.join(' ');`。这个流程是正确的。

但有一个问题：`--resume` 会尝试恢复之前的 Claude Code 会话。如果上次容器被 `--rm` 清理了，Claude Code 的会话状态存储在哪？Claude Code 使用 `~/.claude/projects/<hash>/` 目录存储会话。这个目录通过 bind-mount 持久化了（第 210-216 行把 per-agent 的 `.claude` 目录 mount 到容器的 `/home/node/.claude`）。所以 `--resume` 可以跨容器工作。

然而，需要验证的点：
1. `onClaudeSession` 回调在 handler.ts:471 设置，正确捕获了 sessionId
2. 第 598 行传递 `agentClaudeSessions.get(...)` 给 `start()` 的 `claudeSessionId` 参数
3. `start()` 传给 `startDockerRun()`，后者加入 `--resume`

这个流程已经完整。唯一缺少的是：如果同一 agent 在短时间内多条消息，应该始终使用 `--resume`。

检查 done 后 `agentClaudeSessions` 是否被清理 —— 当前清理发生在 `cleanupSessionResources`（state.ts:162-164），也就是 session 结束时。这意味着同一 session 内同一 agent 的多条消息都会使用 `--resume`。正确。

**实际改动：** 只需要确保 `--resume` 参数在传递给 `claude` 命令时顺序正确（`--resume` 必须在 `--print` 之后但在其他参数之前或之后均可），并添加日志确认 resume 是否生效。

- [ ] **Step 1: 添加 --resume 是否生效的日志**

在 `apps/api/src/agent/ClaudeCodeProcess.ts:191-192`，修改：

```typescript
const claudeArgsParts = buildClaudePrintArgs(effectiveTrustMode);
if (approvedTool) claudeArgsParts.push('--allowedTools', approvedTool);
if (claudeSessionId) {
  claudeArgsParts.push('--resume', claudeSessionId);
  console.log(`[agent:spawn] Resuming Claude session: ${claudeSessionId.slice(0, 20)}...`);
}
const claudeArgs = claudeArgsParts.join(' ');
```

- [ ] **Step 2: 确认 handler.ts 正确传递 claudeSessionId**

在 `apps/api/src/ws/handler.ts:596-599`，当前代码：

```typescript
agent.start(
  sessionId, agentPrompt, sandbox.containerId, sandbox.workDir,
  data.trustMode ?? true, sandbox.hostWorkDir, mention.messageId,
  agentNameForProc ? agentClaudeSessions.get(`${sessionId}:${agentNameForProc}`) : undefined,
  agentNameForProc || undefined,
)
```

这个传递链是正确的。不需要修改。

- [ ] **Step 3: TypeScript 检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent/ClaudeCodeProcess.ts
git commit -m "feat: add --resume session log, verify resume chain is intact"
```

---

### Task 4: 清理 ENABLE_PERSISTENT_REPL 死代码标记

**Files:**
- Modify: `apps/api/src/ws/state.ts:78-81` (更新注释)
- Modify: `apps/api/src/ws/handler.ts` (在 REPL 分支前添加明确的日志说明当前模式)

**目标：** 在不删除 REPL 代码的前提下（PTY 方案可能复用），添加清晰的注释说明当前模式为 `--resume` one-shot，REPL 已禁用。

- [ ] **Step 1: 更新 state.ts 注释**

在 `apps/api/src/ws/state.ts:78-81`，更新 `ENABLE_PERSISTENT_REPL` 周围注释：

```typescript
// REPL mode disabled (ENABLE_PERSISTENT_REPL defaults to false).
// The `cat file - | claude` pattern blocks because stdin never receives EOF.
// Current approach: one-shot `docker run --rm` + `--resume` per message.
// This gives session continuity without a persistent container.
// To re-enable REPL: implement PTY-based stdin or docker exec send mechanism
// (see docs/superpowers/plans/2026-05-25-pty-repl-fix.md).
export const ENABLE_PERSISTENT_REPL = process.env.AGENTHUB_ENABLE_PERSISTENT_REPL === '1';
```

- [ ] **Step 2: 在 handler.ts 添加模式日志**

在 `apps/api/src/ws/handler.ts:331`（`ENABLE_PERSISTENT_REPL` 检查之前），添加：

```typescript
// One-shot --resume mode: each message creates a new container but reuses
// the Claude Code session via --resume for context continuity.
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/state.ts apps/api/src/ws/handler.ts
git commit -m "docs: clarify one-shot --resume mode and REPL disabled status"
```

---

## Self-Review Results

**1. Spec coverage:** 方案一目标：
- (1) 利用 --resume → Task 3 确认已生效，添加日志
- (2) 修复 permission proxy 杀容器 → Task 1 去掉冗余 `docker rm -f`
- (3) 全局并发改排队 → Task 2 FIFO 等待队列
- (4) 明确当前模式文档 → Task 4

**2. Placeholder scan:** 无 TBD/TODO。

**3. Type consistency:** `PendingAgentRequest`、`enqueuePending`、`dequeuePending`、`drainPendingQueue` 类型和函数签名前后一致。

**4. 方案一限制（显式声明）：**
- One-shot 模式仍保持"每条消息一个容器"的开销（200-500ms 启动延迟）
- Permission proxy 在非 trust 模式下仍然重建容器（彻底修复需要 PTY）
- Agent 内任务仍然是串行的（同一 agent 同一时间只处理一个任务）
- 全局排队的 FIFO 顺序无优先级（优先级队列在另一份 plan 中：`2026-05-25-multi-agent-core-improvements.md` Task 5）
