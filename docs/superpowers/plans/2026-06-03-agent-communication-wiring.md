# Agent Communication Wiring Plan

**Date**: 2026-06-03
**Branch**: `feature/agent-output-editor`

## Context

当 ReviewAgent 产出代码审查报告后，没有任何 agent 收到通知去修复问题。Planner 的收件箱是空的，只有用户手动让 Planner 去翻 ReviewAgent 的聊天记录才能找到问题报告。

根因是 **AgentCoordinator 的核心路由方法（`onToolUse/onToolResult/onAgentDone`）虽然实现了完整的逻辑，但从未被调用**——`AgentRuntime.handleAgentEvent()` 和 `taskDispatcher.handleProviderTaskEvent()` 这两个 agent 事件处理入口都没有接入 Coordinator。加上 `InboxManager.init()` 和 `InboxWakeup.check()` 也是零调用者。

## Goals

1. Agent 之间能够直接通信（通过 Inbox 机制自动路由） ✅
2. Agent 察觉到其他 agent 需要帮助时能够及时介入（InboxWakeup + EventRoutingRules） ✅
3. 审查→修复→验证 的闭环能自动运转 ✅

## 实现状态

**已完成所有 5 个步骤。** TypeScript 编译零错误，14 个现有测试全部通过。

### 修改的文件

| 文件 | 变更 |
|------|------|
| `apps/api/src/agent/EventRoutingRules.ts` | +2 规则；修复 senderTypes 前缀匹配 |
| `apps/api/src/ws/taskDispatcher.ts` | 接入 AgentCoordinator 四个方法；IntentParser；InboxWakeup；协调 prompt；resolveAgentNameInSession 前缀匹配 |
| `apps/api/src/agent/AgentRuntime.ts` | 接入 AgentCoordinator 到全部事件；实时 NEEDS HELP 扫描；空闲时 inbox 唤醒；intentScanOffset 跟踪 |
| `apps/api/src/ws/chatHandlers.ts` | 初始化所有 session agent inbox 文件 |

### 关键修复点

1. **senderTypes 前缀匹配**: `ruleMatches()` 从精确匹配改为 `'review-agent'` 可匹配 `'review-agent-6064e856'`
2. **Agent 名称解析**: `resolveAgentNameInSession` 同步支持前缀匹配
3. **双向接线**: AgentRuntime (chat) + taskDispatcher (DAG) 两路都接入 Coordinator
4. **Inbox 初始化**: Session 启动时预创建所有 agent inbox 文件
5. **主动唤醒**: Agent 空闲/任务完成时检查 inbox 并广播通知

## Implementation Steps

### Step 1: 补充事件路由规则

**文件**: `apps/api/src/agent/EventRoutingRules.ts`

在 `DEFAULT_RULES` 数组（约 line 186 之前）增加两条规则：

```typescript
// 规则1: ReviewAgent 写入审查报告文件 → 通知 code-agent + planner
{
  id: 'review-report-file-written',
  eventType: 'tool_use',
  toolName: 'Write',
  senderTypes: ['review-agent'],
  filePathPattern: '**/*review*',
  notifyTypes: ['code-agent', 'planner'],
  priority: 12,
  summaryTemplate: '[{{senderName}}] 写入了审查报告 {{filePath}} — 请检查并修复',
  risk: 'high',
},
// 规则2: CodeAgent 修复完成 → 通知 review-agent 复验 + test-agent 测试
{
  id: 'code-agent-done-after-fix',
  eventType: 'done',
  senderTypes: ['code-agent'],
  notifyTypes: ['review-agent', 'test-agent'],
  priority: 6,
  summaryTemplate: '[{{senderName}}] 完成代码修改 — 需复验和回归测试',
  risk: 'high',
},
```

### Step 2: 将 AgentCoordinator 接入 taskDispatcher

**文件**: `apps/api/src/ws/taskDispatcher.ts`

`handleProviderTaskEvent`（line 186）处理 DAG 任务分发的 agent 事件。需要在三个事件分支中加入 AgentCoordinator 调用：

**2a. `tool_use` 分支（line 212）**:
```typescript
case 'tool_use':
  // 现有广播 ...
  // 新增：权限检查 + 事件路由
  agentCoordinator.onToolUse({
    sessionId, agentName, agentType: agentName,
    messageId: run.taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  }, event as any);
  break;
```

**2b. `tool_result` 分支（line 225）**:
```typescript
case 'tool_result':
  // 现有广播 ...
  // 新增：路由工具结果
  agentCoordinator.onToolResult({
    sessionId, agentName, agentType: agentName,
    messageId: run.taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  }, event.content || '');
  break;
```

**2c. `done` 分支（line 282）**:
```typescript
case 'done':
  // 现有广播 ...
  // 新增：完成事件路由 + IntentParser 扫描
  agentCoordinator.onAgentDone({
    sessionId, agentName, agentType: agentName,
    messageId: run.taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  }, event.exitCode ?? 0, accumulatedOutput?.slice(0, 3000) || '');

  // 扫描 NEEDS HELP 意图
  if (accumulatedOutput) {
    const intents = IntentParser.scan(accumulatedOutput);
    for (const intent of intents) {
      const targetName = resolveAgentNameInSession(sessionId, intent.targetAgentName) || intent.targetAgentName;
      InboxManager.write(queue.sandbox.hostWorkDir, targetName, {
        type: 'help_request',
        id: `help-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`,
        from: agentName, to: targetName,
        summary: intent.description, risk: 'low',
        timestamp: Date.now(),
      }, sessionId);
    }
  }
  break;
```

**2d. `processNextInQueue` reuse 路径**（line 438 附近）:
当前复用已有 provider 时直接 `sendPrompt(taskPrompt)`，缺少 inbox 上下文。改为注入协调 prompt：
```typescript
const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
  sessionId, agentName, agentType: agentName,
  messageId: taskMessageId, hostWorkDir: queue.sandbox.hostWorkDir,
  resolveAgent: (type: string) => resolveAgentNameInSession(sessionId, type),
  broadcast,
});
procInfo.provider.sendPrompt(`${taskPrompt}\n${coordinationPrompt}`);
```

**2e. Done 后主动检查 inbox**（line 326 `processNextInQueue` 之后）:
```typescript
// 检查是否有其他 agent 需要关注
const procMap = agentProcesses.get(sessionId);
if (procMap) {
  for (const [name] of procMap) {
    if (name !== agentName) {
      InboxWakeup.check(sessionId, name, queue.sandbox.hostWorkDir,
        (n) => procMap.has(n), broadcast);
    }
  }
}
```

新增 imports:
```typescript
import { IntentParser } from '../agent/IntentParser.js';
import { InboxWakeup } from '../agent/InboxWakeup.js';
```

### Step 3: 将 AgentCoordinator 接入 AgentRuntime

**文件**: `apps/api/src/agent/AgentRuntime.ts`

**3a. 新增 import**:
```typescript
import { agentCoordinator } from './AgentCoordinator.js';
```

**3b. `tool_use` case（line 292）** — 在现有广播之后加入:
```typescript
// 权限检查 + 事件路由
agentCoordinator.onToolUse({
  sessionId, agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
  agentType: entry.currentAgentName || entry.currentAgentId || 'unknown',
  messageId: agentMessageId || '',
  hostWorkDir: entry.hostWorkDir,
  resolveAgent: (type: string) => resolveAgentNameInSessionSync(entry, type),
  broadcast,
}, {
  type: 'tool_use',
  toolName: event.toolName,
  input: event.toolInput,
} as any);
```

**3c. 新增 `tool_result` case** — 当前 switch 中没有 tool_result 分支:
```typescript
case 'tool_result':
  broadcast(sessionId, {
    type: 'agent_status',
    status: 'tool_result',
    agentMessageId,
    details: { content: (event.content || '').slice(0, 200) },
  });
  agentCoordinator.onToolResult({
    sessionId, agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
    agentType: entry.currentAgentName || entry.currentAgentId || 'unknown',
    messageId: agentMessageId || '',
    hostWorkDir: entry.hostWorkDir,
    resolveAgent: (type: string) => resolveAgentByNameSync(sessionId, type),
    broadcast,
  }, event.content || '');
  break;
```

**3d. `done` case** — 在现有 `IntentParser.scan()` 之前（line 335）加入:
```typescript
// AgentCoordinator: 路由完成事件
agentCoordinator.onAgentDone({
  sessionId, agentName: entry.currentAgentName || entry.currentAgentId || 'unknown',
  agentType: entry.currentAgentName || entry.currentAgentId || 'unknown',
  messageId: agentMessageId || '',
  hostWorkDir: entry.hostWorkDir,
  resolveAgent: (type: string) => resolveAgentByNameSync(sessionId, type),
  broadcast,
}, event.exitCode ?? 0, entry.accumulatedOutput?.slice(0, 3000) || '');
```

**3e. 实时 IntentParser 扫描** — 在 `thinking` case（line 286）中增加增量扫描:
```typescript
case 'thinking':
  if (event.content) {
    entry.accumulatedOutput += event.content;
    broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId });
    // 增量扫描 NEEDS HELP 意图（只扫描新增内容）
    if (event.content.includes('NEEDS HELP')) {
      const intents = IntentParser.scanOnDelta(entry.accumulatedOutput, entry.intentScanOffset);
      for (const intent of intents) {
        resolveAgentByName(sessionId, intent.targetAgentName).then(target => {
          if (target) {
            InboxManager.write(entry.hostWorkDir, target.name, {
              type: 'help_request',
              id: `help-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              from: entry.currentAgentName || 'unknown', to: target.name,
              summary: intent.description, risk: 'low',
              timestamp: Date.now(),
            }, sessionId);
          }
        });
      }
      entry.intentScanOffset = entry.accumulatedOutput.length;
    }
  }
  break;
```

### Step 4: Session 启动时初始化 inbox

**文件**: `apps/api/src/ws/chatHandlers.ts`

在 `ensureSandboxReady` 中（sandbox 就绪后），遍历 session 的所有 agent 并初始化 inbox:
```typescript
// 在 sandbox 就绪后，为所有 session agent 初始化 inbox
import { InboxManager } from '../agent/InboxManager.js';
const sessionAgents = await prisma.sessionAgent.findMany({
  where: { sessionId },
  select: { agent: { select: { name: true } } },
});
for (const sa of sessionAgents) {
  InboxManager.init(sb.hostSandboxDir, sa.agent.name);
}
```

### Step 5: 主动 inbox 唤醒

**文件**: `apps/api/src/ws/chatHandlers.ts`

在 `cleanupSessionClient` 中（agent 变为空闲时），检查是否有其他 agent 有待处理的 inbox 消息：
```typescript
// Agent 空闲后检查 inbox
for (const [agentName] of agentNameToType) {
  InboxWakeup.check(sessionId, agentName, sandbox.hostSandboxDir,
    (name) => agentNameToType.has(name), broadcast);
}
```

## 实现后的完整流程

```
ReviewAgent done
  → AgentCoordinator.onAgentDone()
  → EventRoutingRules: review-issues-notify-code (priority 10, risk:high)
  → InboxManager.write('code-agent', HIGH: "completed review — check findings")
  → InboxWakeup.check() → WebSocket 广播 "inbox_wake_up" 到前端

User @mentions CodeAgent 修复问题
  → chatHandlers 组装 prompt
  → InboxWakeup.buildInboxPrompt() 读取 inbox
  → CodeAgent prompt 中看到: "[HIGH] From review-agent: completed review — check findings"

CodeAgent 修复完成
  → AgentCoordinator.onAgentDone()
  → EventRoutingRules: code-agent-done-after-fix (priority 6, risk:high)
  → InboxManager.write('review-agent', HIGH: "完成代码修改 — 需复验")
  → InboxManager.write('test-agent', HIGH: "完成代码修改 — 需回归测试")

ReviewAgent 收到通知 → 复验
TestAgent 收到通知 → 回归测试
  → 形成完整的审查→修复→验证闭环
```

## 验证方式

1. **TypeScript 编译检查**:
   ```bash
   npx tsc --noEmit -p apps/api/tsconfig.json
   ```

2. **单元测试**:
   ```bash
   npx vitest run apps/api/src/agent/ContextBus.test.ts
   npx vitest run apps/api/src/agent/context-management.test.ts
   ```

3. **端到端验证**（启动后端，模拟完整流程）:
   - 创建 Group session，加入 planner + code-agent + review-agent
   - Planner 规划代码创建 + 审查任务
   - Code-agent 执行代码创建
   - Review-agent 执行审查 → 检查 inbox 是否收到通知
   - Code-agent 接收修复任务 → 检查 inbox 是否有审查报告
   - 验证 `_comm_log.jsonl` 中有完整的 agent 通信记录
