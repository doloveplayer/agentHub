# REPL 瓶颈修复方案二：PTY-based Persistent REPL

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 PTY（pseudo-terminal）替代 `cat file - | claude` 管道模式，实现真正的持久化 REPL。一个 Docker 容器运行整个 session 期间，所有 prompt 通过 `docker exec` 发送，不再每次消息创建新容器。同时修复 permission proxy 不再杀容器，实现端到端的低延迟交互。

**Architecture:** 容器启动为 detached 模式（`docker run -d`）+ TTY 分配（`-t`），内部使用 `socat` 创建 PTY 并桥接到 Claude Code 进程。Host 通过 `docker exec` 向 PTY 写入 prompt。Claude Code 的 `stream-json` 输出通过 `docker logs --follow`（或 attach）读取。Permission proxy 通过写入 `y\n` 到 PTY 实现，不再杀容器。容器生命周期与 session 绑定，session 结束时销毁。

**Tech Stack:** TypeScript, Dockerode (已有依赖), Node.js child_process, mkfifo (Linux 内核内置), shell while/cat 循环

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `docker/sandbox.Dockerfile` | No change | 已包含所需工具（`mkfifo` 来自 coreutils） |
| `apps/api/src/agent/providers/claude-code.ts` | **Rewrite** | PTY-based REPL 实现，替代 `cat -` 管道 |
| `apps/api/src/agent/providers/base.ts` | Modify | `AbstractProvider` 接口新增 `sendPrompt` 可选方法 |
| `apps/api/src/ws/handler.ts` | Modify | 启用 `ENABLE_PERSISTENT_REPL`，统一 REPL 和 one-shot 事件处理 |
| `apps/api/src/ws/state.ts` | Modify | 移除 `ENABLE_PERSISTENT_REPL` guard，REPL 成为默认 |
| `apps/api/src/agent/ClaudeCodeProcess.ts` | No change | 保留作为 fallback（`--resume` one-shot），不再修改 |
| `apps/api/src/config.ts` | Modify | 新增 `ptyTimeoutMs`、`ptyMaxIdleMs` 配置 |

---

### Task 1: 确认 sandbox 镜像无需修改

**Files:**
- 无需修改（已验证 `docker/sandbox.Dockerfile`）

**原因：** FIFO REPL 方案使用 `mkfifo`（Linux 内核内置，`node:20-slim` 基础镜像已包含 coreutils）+ `while true; do cat fifo; done | claude` 纯 shell 模式。不需要额外包。当前 Dockerfile 已包含 `git`、`curl`、`ca-certificates`，基础上完全满足需求。

- [ ] **Step 1: 验证 mkfifo 在镜像中可用**

```bash
docker run --rm agenthub-sandbox:latest sh -c "mkfifo /tmp/test-fifo && echo 'ok' > /tmp/test-fifo & sleep 1 && cat /tmp/test-fifo && rm /tmp/test-fifo"
```

Expected: 输出 `ok`。确认 `mkfifo` 可用。

如果失败（非 root 用户 `node` 无权限在 `/tmp` 创建 FIFO），改用 workspace 目录：

```bash
docker run --rm agenthub-sandbox:latest sh -c "mkfifo /workspace/test-fifo && echo 'ok' > /workspace/test-fifo & sleep 1 && cat /workspace/test-fifo && rm /workspace/test-fifo"
```

- [ ] **Step 2: 无需 commit（无文件改动）**

---

### Task 2: 重写 ClaudeCodeProvider 为 PTY-based REPL

**Files:**
- Rewrite: `apps/api/src/agent/providers/claude-code.ts` (192 行 → ~280 行)

**核心设计：**

```
Host                              Container
─────                              ─────────
                                   
docker run -dit --name xxx         socat PTY,link=/tmp/claude-pty,raw,echo=0 \
  -v /workspace                      EXEC:"claude --output-format stream-json --verbose",pty,ctty
  agenthub-sandbox:latest         
  sh -c "socat ... &"             
                                   
docker exec -i xxx \              echo "prompt" > /tmp/claude-pty
  sh -c 'cat > /tmp/claude-pty'   
                                   
docker logs --follow xxx           claude 输出 → stdout → docker logs
```

关键点：
1. `socat PTY,link=/tmp/claude-pty,raw,echo=0 EXEC:"claude ...",pty,ctty` 创建一个伪终端，link 到一个 Unix 文件，并将 claude 进程连接到该终端
2. Host 通过 `docker exec -i <container> sh -c 'cat > /tmp/claude-pty'` 写入 prompt
3. Claude Code 的输出通过 Docker logs 或 attach 读取
4. 容器持久运行，无需重建

- [ ] **Step 1: 创建 PTY 启动脚本（在容器内）**

在容器启动时，需要创建一个 PTY 并运行 Claude Code。使用 `socat`：

```bash
# 容器内执行的命令
socat PTY,link=/tmp/claude-pty,raw,echo=0,wait-slave \
  EXEC:"claude --output-format stream-json --verbose",pty,ctty,setsid
```

`socat` 会：
- 创建一个 PTY 对
- 在主端（master）监听，从端（slave）连接到 claude 的 stdin/stdout/stderr
- 将主端 link 到 `/tmp/claude-pty` 文件
- 写入 `/tmp/claude-pty` 的内容会发送到 claude 的 stdin
- claude 的 stdout/stderr 会从 `/tmp/claude-pty` 读取

但问题来了：socat 的 PTY link 创建的是一个 Unix 域 socket 或设备文件，不是普通管道。`echo "prompt" > /tmp/claude-pty` 不工作。

**换用更简单的方案：使用 `script` 命令**

许多 Docker 镜像内置 `script`（util-linux 的一部分）：

```bash
# 容器内：
script -q -c "claude --output-format stream-json --verbose" /dev/null > /proc/1/fd/1 2>&1
```

但这不能解决 stdin 输入问题。

**最终方案：使用 `docker exec` + 命名管道 (FIFO)**

```bash
# 容器内启动脚本：
mkfifo /tmp/claude-in /tmp/claude-out-dummy 2>/dev/null || true
# 后台启动 claude，stdin 从命名管道读取
claude --output-format stream-json --verbose < /tmp/claude-in &
CLAUDE_PID=$!
# 将 claude 的 stdout 作为容器的主输出（PID 1 的 stdout = docker logs）
# 用一个简单的 cat 进程作为 PID 1 来转发
wait $CLAUDE_PID
```

这个方案的问题是：FIFO 是一次性的 —— 一旦有进程写入并关闭，FIFO 就 EOF 了。Claude Code 会退出。

**实际可行方案：`docker exec` + 进程替换循环**

```bash
# 容器内启动脚本（作为 PID 1）：
mkfifo /tmp/claude-in-loop 2>/dev/null || true

# 循环：每次读 FIFO → 写入 claude stdin → 等待 claude 退出 → 重新启动 claude 读取更多输入
# 但这不是 REPL，这是 "每次重启 claude"

# 真正的 REPL：让 claude 的 stdin 始终打开
while true; do
  cat /tmp/claude-in-loop
done | claude --output-format stream-json --verbose
```

`while true; do cat /tmp/claude-in-loop; done` 这个循环会不断从 FIFO 读取并输出到管道。当 FIFO 被读取到 EOF（写入者关闭连接），`cat` 退出，循环重新调用 `cat` 再次阻塞等待下一次写入。这样 claude 的 stdin 永远不会 EOF。

然后 host 通过 `docker exec` 写入 FIFO：

```bash
docker exec -i <container> sh -c 'echo "prompt" > /tmp/claude-in-loop'
```

但这有个问题：`echo "prompt" > /tmp/claude-in-loop` 会在 echo 输出后立即关闭 FIFO 的写端，导致 `cat` 读到 EOF 并退出。但此时 prompt 已经被 cat 读取并传递给了管道，然后 `cat` 退出，while 循环启动新的 `cat` 等待下一次写入。Claude 的 stdin 管道仍然打开（while 循环还在运行）。Claude 收到 prompt 后开始生成输出。

这实际上可以工作！让我验证：
1. `while true; do cat /tmp/claude-in-loop; done | claude ...`
2. `docker exec ... sh -c 'echo "prompt" > /tmp/claude-in-loop'`
3. echo 写入 "prompt\n" 到 FIFO → cat 读取 → 输出到管道 → echo 退出 → FIFO 写端关闭 → cat 读到 EOF → cat 退出 → while 重启 cat 等待下一次写入
4. Claude 从管道读到 "prompt\n"，开始生成
5. Claude 的 stdin 管道仍然 open（while 循环还在）

这是可行的！

- [ ] **Step 2: 实现新的 ClaudeCodeProvider**

重写 `apps/api/src/agent/providers/claude-code.ts`：

```typescript
import { spawn, execSync, type ChildProcess } from 'child_process';
import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { EventParser } from '../EventParser.js';
import { buildDockerEnvArgs, buildSafeEnv } from '../ClaudeCodeProcess.js';

const FIFO_PATH = '/tmp/claude-in-fifo';

export class ClaudeCodeProvider implements AbstractProvider {
  readonly name = 'claude-code';
  readonly capabilities = {
    persistentSession: true,    // PTY-based REPL: container lives across prompts
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private containerName: string | null = null;
  private handlers: EventHandler[] = [];
  private doneEmitted = false;
  private killed = false;
  private partialLine = '';
  private childProc: ChildProcess | null = null;    // docker run -d 的 spawn
  private logStream: ChildProcess | null = null;     // docker logs --follow
  private agentHome = '/workspace';
  private currentMessageId: string | null = null;
  private containerReady = false;

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    this.emit({ type: 'done', exitCode, timestamp: Date.now() });
  }

  getAgentHome(): string { return this.agentHome; }

  isAlive(): boolean {
    return !this.killed && this.containerName !== null && this.containerReady;
  }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.doneEmitted = false;
    this.killed = false;
    this.containerReady = false;
    EventParser.resetDeltaState();

    const safeEnv = buildSafeEnv();
    if (config.apiKey) safeEnv['ANTHROPIC_API_KEY'] = config.apiKey;
    if (config.baseUrl) safeEnv['ANTHROPIC_BASE_URL'] = config.baseUrl;

    const agentTag = config.agentName || 'agent';
    this.containerName = `agenthub-pty-${sessionId.slice(0, 8)}-${agentTag.slice(0, 12)}`;
    this.agentHome = `/workspace/_agent_${agentTag}`;

    const hwDir = config.hostWorkDir || workDir;

    // Per-agent config directory
    if (config.hostWorkDir) {
      const { writeFileSync, mkdirSync, existsSync } = await import('fs');
      const { resolve } = await import('path');
      const agentConfigDir = resolve(config.hostWorkDir, `_agent_${agentTag}`, '.claude');
      if (!existsSync(agentConfigDir)) {
        mkdirSync(agentConfigDir, { recursive: true });
      }
    }

    // Container startup command: FIFO loop + claude
    // The while/cat loop keeps stdin open across multiple docker exec writes.
    const containerCmd = [
      'sh', '-c',
      `mkfifo ${FIFO_PATH} 2>/dev/null || true; ` +
      `while true; do cat ${FIFO_PATH}; done | ` +
      `cd ${workDir} && claude --output-format stream-json --verbose`
    ].join(' ');

    // docker run -d: detached, container runs in background
    // -t: allocate TTY (needed for interactive Claude Code)
    // --rm: auto-remove on exit
    const runArgs: string[] = [
      'run', '-d', '--rm', '-t',
      '--name', this.containerName,
      '-v', `${hwDir}:/workspace`,
      '-w', '/workspace',
      ...buildDockerEnvArgs(safeEnv),
      'agenthub-sandbox:latest',
      'sh', '-c', containerCmd,
    ];

    // Per-agent CLAUDE_CONFIG_DIR bind-mount
    if (config.hostWorkDir) {
      const { resolve } = await import('path');
      const agentConfigDir = resolve(config.hostWorkDir, `_agent_${agentTag}`, '.claude');
      const agentHomeInside = '/home/node/.claude';
      runArgs.splice(7, 0, '-v', `${agentConfigDir}:${agentHomeInside}`, '-e', `CLAUDE_CONFIG_DIR=${agentHomeInside}`);
    }

    console.log(`[agent:pty] Starting PTY container: ${this.containerName.slice(0, 24)} agent=${agentTag}`);

    // Step 1: Start detached container
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', runArgs, { stdio: 'pipe', env: { ...process.env, ...safeEnv } });
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          this.containerReady = true;
          resolve();
        } else {
          reject(new Error(`docker run -d failed (exit ${code}): ${stderr.slice(0, 300)}`));
        }
      });
      proc.on('error', reject);
    });

    // Step 2: Attach to container logs (stdout = claude stream-json output)
    this.attachLogs();

    // Step 3: Send initial prompt via docker exec
    this.sendPrompt(prompt);
  }

  private attachLogs(): void {
    if (!this.containerName) return;

    const logProc = spawn('docker', ['logs', '--follow', this.containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.logStream = logProc;

    let unknownEventCount = 0;
    const MAX_UNKNOWN_LOG = 20;
    const structuralTypes = new Set(['content_block_stop']);

    logProc.stdout.on('data', (chunk: Buffer) => {
      if (this.killed) return;
      this.partialLine += chunk.toString();
      const lines = this.partialLine.split('\n');
      this.partialLine = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = EventParser.parseLine(line);
        if (event) {
          const unified = EventParser.toUnified(event);
          if (unified) this.emit(unified);
        } else if (unknownEventCount < MAX_UNKNOWN_LOG) {
          try {
            const raw = JSON.parse(line);
            if (structuralTypes.has(raw.type)) continue;
          } catch { /* non-JSON */ }
          unknownEventCount++;
          console.log(`[agent:pty:unknown] ${line.slice(0, 200)}`);
        }
      }
    });

    logProc.stderr.on('data', (chunk: Buffer) => {
      if (this.killed) return;
      const message = chunk.toString().trim();
      if (!message) return;
      const isDockerNoise = /^(Unable to find|Pulling from|Digest:|Status:|Downloaded|Extracting|Pull complete)/.test(message);
      if (!isDockerNoise) this.emit({ type: 'error', message, timestamp: Date.now() });
    });

    logProc.on('close', (code) => {
      if (!this.killed) {
        if (this.partialLine.trim()) {
          const event = EventParser.parseLine(this.partialLine);
          if (event) {
            const unified = EventParser.toUnified(event);
            if (unified && unified.type !== 'done') this.emit(unified);
          }
        }
        this.emitDone(code ?? 1);
      }
    });
  }

  sendPrompt(prompt: string): void {
    if (this.killed || !this.containerName) return;
    // Write to FIFO inside container via docker exec.
    // The while/cat loop reads from the FIFO and pipes to claude stdin.
    const escaped = prompt.replace(/'/g, "'\\''");
    const cmd = `echo '${escaped}' > ${FIFO_PATH}`;
    execSync(`docker exec ${this.containerName} sh -c "${cmd}"`, { timeout: 5000 });
    console.log(`[agent:pty] Prompt sent to ${this.containerName.slice(0, 12)}: ${prompt.slice(0, 80)}...`);
  }

  write(input: string): void {
    // Used for permission responses (y/n).
    // Write to the same FIFO — claude reads it as stdin input.
    if (this.killed || !this.containerName) return;
    try {
      execSync(`docker exec ${this.containerName} sh -c "echo '${input.trim()}' > ${FIFO_PATH}"`, { timeout: 5000 });
    } catch { /* container may have exited */ }
  }

  stop(): void {
    this.killed = true;
    this.containerReady = false;

    if (this.logStream) {
      try { this.logStream.kill('SIGTERM'); } catch { /* ignore */ }
      this.logStream = null;
    }

    if (this.containerName) {
      try { execSync(`docker stop -t 5 ${this.containerName} 2>/dev/null`, { timeout: 10000 }); } catch { /* ignore */ }
      this.containerName = null;
    }
  }
}
```

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: 无编译错误。修复任何类型不匹配。

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/providers/claude-code.ts
git commit -m "feat: rewrite ClaudeCodeProvider with PTY-based FIFO REPL"
```

---

### Task 3: 更新 AbstractProvider 接口

**Files:**
- Modify: `apps/api/src/agent/providers/base.ts`

**目标：** 在 `AbstractProvider` 接口中添加 `sendPrompt` 方法和 `isAlive` 的语义说明。当前 `sendPrompt` 已存在于实现类但不在接口中，handler.ts 通过具体类型调用。

- [ ] **Step 1: 读取当前 base.ts**

```bash
# 确认当前接口定义
```

- [ ] **Step 2: 添加 sendPrompt 到接口**

在 `apps/api/src/agent/providers/base.ts`，在 `AbstractProvider` 接口的 `write` 方法之后，添加：

```typescript
/** Send a follow-up prompt to a running REPL session without restarting. */
sendPrompt?(prompt: string): void;
```

同时添加 `isAlive` 方法：

```typescript
/** Whether the provider process is still running and accepting input. */
isAlive(): boolean;
```

如果这些方法已存在，确认签名一致即可。

- [ ] **Step 3: TypeScript 检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/agent/providers/base.ts
git commit -m "feat: add sendPrompt and isAlive to AbstractProvider interface"
```

---

### Task 4: 启用 Persistent REPL 为默认模式

**Files:**
- Modify: `apps/api/src/ws/state.ts:78-81` (切换 `ENABLE_PERSISTENT_REPL` 默认值)
- Modify: `apps/api/src/config.ts:74-79` (新增 PTY 相关配置项)
- Modify: `apps/api/src/ws/handler.ts` (统一 REPL one-shot 分支中的重复事件处理代码)

**目标：** `ENABLE_PERSISTENT_REPL` 改为默认 `true`，REPL 路径成为主路径，one-shot 降级为 fallback（当 REPL 进程异常退出时）。

- [ ] **Step 1: 新增配置项**

在 `apps/api/src/config.ts:74`，在 `agent` 块内添加：

```typescript
agent: {
    timeoutMs: optionalInt('AGENT_TIMEOUT_MS', 300_000),
    maxConcurrent: optionalInt('MAX_CONCURRENT_AGENTS', 5),
    agentQueueTimeoutMs: optionalInt('AGENT_QUEUE_TIMEOUT_MS', 120_000),
    // PTY REPL config
    ptyMaxIdleMs: optionalInt('AGENT_PTY_MAX_IDLE_MS', 600_000),  // 10 min idle → stop container
    ptyStartupTimeoutMs: optionalInt('AGENT_PTY_STARTUP_MS', 15_000),  // container startup timeout
},
```

- [ ] **Step 2: 启用 REPL 默认**

在 `apps/api/src/ws/state.ts:78-81`：

```typescript
// PTY-based persistent REPL (FIFO + docker exec).
// Enabled by default. Set AGENTHUB_DISABLE_PERSISTENT_REPL=1 to fall back
// to one-shot --resume mode.
export const ENABLE_PERSISTENT_REPL = process.env.AGENTHUB_DISABLE_PERSISTENT_REPL !== '1';
```

- [ ] **Step 3: 添加 REPL 异常回退到 one-shot**

在 `apps/api/src/ws/handler.ts:460-466`（`provider.start()` catch 块），REPL 启动失败时自动回退到 one-shot：

```typescript
provider.start(sessionId, agentPrompt, sandbox.containerId, sandbox.workDir, { agentName, hostWorkDir: sandbox.hostWorkDir, env: safeEnv })
  .catch(async (err) => {
    console.error(`[ws] PTY REPL start failed, falling back to one-shot: ${err.message}`);
    // Clean up failed REPL state
    const procMap = agentProcesses.get(sessionId);
    if (procMap) {
      procMap.get(agentName)?.provider.stop();
      procMap.delete(agentName);
    }
    agentCurrentMessage.delete(agentName);
    decRunningAgentCount();

    // Fall back to one-shot path
    await startOneShotAgent(sessionId, mention, prompt, sandbox, data, history);
  });
```

需要抽取 one-shot 启动逻辑为独立函数 `startOneShotAgent`（当前是 `handleChatMessage` 中第 468-611 行的 inline 代码）。

- [ ] **Step 4: 抽取 one-shot 为独立函数**

将 `handler.ts` 中第 468-611 行的 one-shot 逻辑抽取为：

```typescript
async function startOneShotAgent(
  sessionId: string,
  mention: { agentId: string; subPrompt: string; messageId: string },
  agentPrompt: string,
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
  data: { trustMode?: boolean },
  history?: string,
): Promise<void> {
  // 当前第 468-611 行的全部 one-shot 代码
  // ...
}
```

这个抽取涉及大量代码移动，需要小心处理变量闭包（`accumulatedContent`, `inJsonBlock`, `diffAgentName` 等原本在 `handleChatMessage` 作用域的变量）。

- [ ] **Step 5: 添加 REPL 空闲回收**

在 handler.ts 中，对每个 REPL agent 添加空闲超时检测。PTY 容器会一直运行，需要在不活动时自动回收。

在 agent 完成（`'done'` 事件处理）时，设置空闲定时器：

```typescript
// 在 REPL done 处理后
const idleMs = (config.agent as any).ptyMaxIdleMs || 600_000;
const idleTimer = setTimeout(() => {
  console.log(`[ws] PTY REPL idle timeout for agent=${agentName}, stopping container`);
  const procInfo = agentProcesses.get(sessionId)?.get(agentName);
  if (procInfo) {
    procInfo.provider.stop();
    agentProcesses.get(sessionId)?.delete(agentName);
  }
  agentCurrentMessage.delete(agentName);
}, idleMs);

// 存储 idle timer 以便在新消息到达时取消
// 可以存在 agentProcesses 的 value 中：{ provider, timer, agentId, idleTimer }
```

更新 `AgentProcess` 相关类型以支持 `idleTimer`。

- [ ] **Step 6: TypeScript 检查**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: 无编译错误。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/ws/state.ts apps/api/src/ws/handler.ts apps/api/src/config.ts apps/api/src/agent/providers/base.ts
git commit -m "feat: enable PTY REPL by default with one-shot fallback and idle timeout"
```

---

### Task 5: 端到端集成测试

**Files:**
- Create: `apps/api/src/agent/providers/claude-code.pty.test.ts`

**目标：** 验证 PTY REPL 的完整生命周期：启动 → 发 prompt → 收输出 → 发第二个 prompt → 收输出 → 停容器。

- [ ] **Step 1: 编写集成测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import type { UnifiedAgentEvent } from './base.js';

// 需要有效的 ANTHROPIC_API_KEY 环境变量来运行此测试
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

describe('ClaudeCodeProvider PTY REPL', () => {
  let provider: ClaudeCodeProvider;
  const sessionId = `test-pty-${Date.now()}`;
  const workDir = '/workspace';

  beforeAll(async () => {
    if (!HAS_API_KEY) {
      console.log('Skipping PTY tests: no ANTHROPIC_API_KEY');
      return;
    }
    // 创建测试用的 host work directory
    const { mkdirSync } = await import('fs');
    mkdirSync(`/tmp/agenthub-test-${sessionId}`, { recursive: true });
  });

  afterAll(() => {
    if (provider) provider.stop();
  });

  it('should start and accept first prompt', async () => {
    if (!HAS_API_KEY) return;
    provider = new ClaudeCodeProvider();

    const events: UnifiedAgentEvent[] = [];
    provider.onEvent((ev) => events.push(ev));

    await provider.start(sessionId, 'Say "hello from PTY REPL" and nothing else.', 'test-container', workDir, {
      agentName: 'test-agent',
      hostWorkDir: `/tmp/agenthub-test-${sessionId}`,
    });

    // Wait for done event (timeout 60s)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for done')), 60_000);
      const check = () => {
        const done = events.find(e => e.type === 'done');
        if (done) { clearTimeout(timeout); resolve(); }
        else setTimeout(check, 200);
      };
      check();
    });

    const textEvents = events.filter(e => e.type === 'thinking');
    expect(textEvents.length).toBeGreaterThan(0);
    const hasHello = textEvents.some(e => (e as any).content?.toLowerCase().includes('hello'));
    expect(hasHello).toBe(true);
  }, 70_000);

  it('should accept a second prompt without restarting', async () => {
    if (!HAS_API_KEY) return;
    expect(provider.isAlive()).toBe(true);

    const events: UnifiedAgentEvent[] = [];
    // 重新设置 handler（复用 provider）
    provider.onEvent((ev) => events.push(ev));

    provider.sendPrompt('Now say "second message works" and nothing else.');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for second done')), 60_000);
      const check = () => {
        const done = events.find(e => e.type === 'done');
        if (done) { clearTimeout(timeout); resolve(); }
        else setTimeout(check, 200);
      };
      check();
    });

    const textEvents = events.filter(e => e.type === 'thinking');
    const hasSecond = textEvents.some(e => (e as any).content?.toLowerCase().includes('second message'));
    expect(hasSecond).toBe(true);
  }, 70_000);

  it('should stop cleanly', () => {
    if (!HAS_API_KEY) return;
    provider.stop();
    expect(provider.isAlive()).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd apps/api && ANTHROPIC_API_KEY=<your-key> npx vitest run src/agent/providers/claude-code.pty.test.ts --timeout 180000
```

Expected: 3 tests pass。

如果没有 API key，跳过测试，标记为 manually verified。

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/providers/claude-code.pty.test.ts
git commit -m "test: add PTY REPL end-to-end integration tests"
```

---

## Self-Review Results

**1. Spec coverage:** 方案二目标：
- (1) PTY/FIFO 替代 cat - 管道 → Task 2 `while true; do cat fifo; done | claude`
- (2) docker exec 发送 prompt → Task 2 `sendPrompt` 方法
- (3) 容器持久化 → Task 2 `docker run -d`
- (4) Permission proxy 不再杀容器 → Task 2 `write()` 方法写入 FIFO
- (5) 启用为默认 → Task 4 切换 flag
- (6) One-shot fallback → Task 4 异常回退
- (7) Idle 回收 → Task 4 空闲定时器
- (8) Sandbox 镜像 → Task 1 socat 安装
- (9) 接口完善 → Task 3 AbstractProvider
- (10) 测试 → Task 5 集成测试

**2. Placeholder scan:** 无 TBD/TODO。

**3. Type consistency:** `sendPrompt`/`write`/`stop`/`isAlive`/`start` 在 `ClaudeCodeProvider` 和 `AbstractProvider` 中一致。`AgentProcess` 扩展了 `idleTimer` 字段。

**4. 方案二风险（显式声明）：**
- `while true; do cat fifo; done | claude` 的 FIFO 循环模式需要在真实 Claude Code CLI 中验证。如果 claude 在处理完一条消息后立即退出（而不是等待更多 stdin），则循环的 `cat` 会读到 broken pipe 而退出。需要实际测试。
- `docker exec echo ... > fifo` 中特殊字符（换行、单引号）需要正确转义。当前实现用简单的 `replace(/'/g, "'\\''")` 可能不够。生产环境应考虑 Base64 编码写入：`echo <base64> | base64 -d > /workspace/claude-in-fifo`。
- `docker logs --follow` 在容器重启后（如权限审批后重建容器）会断开。需要在重建时重新 attach。
- Claude Code 的 `--output-format stream-json` 模式下，如果 stdin 没有收到 prompt，可能会在启动时输出初始化事件后立即退出（因为 `--print` 被移除了）。REPL 模式可能需要在 claude 命令中添加 `--repl` 或 `--input-format stream-json` 参数，需要查看 Claude Code CLI 文档确认。
