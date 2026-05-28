# AgentCard Redesign & Core Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 critical bugs (agent ID case-mismatch, inbox truncation, [object Object] rendering), remove devops/deps agents, make Planner speak naturally, add code-block folding, and redesign AgentCard with 3-face flip.

**Architecture:** Foundation-first ordering — shared types first, then backend bugs, then frontend. Planner rewrite is surgical: change systemPrompt + strip hidden plan JSON in handler, keep existing dispatch pipeline. AgentCard is a full component rewrite with face components in a separate file, fade transitions, and dot-indicator navigation.

**Tech Stack:** TypeScript (Hono 4), React 18 + Tailwind, Prisma, Zustand store

---

### Task 1: Shared types — narrow agentType union

**Files:**
- Modify: `packages/shared/src/types.ts:80-85`

- [ ] **Step 1: Update TaskNode.agentType union**

```typescript
// packages/shared/src/types.ts:80-85 — replace existing TaskNode.agentType
export interface TaskNode {
  id: string;
  title: string;
  description: string;
  agentType: 'code-agent' | 'review-agent' | 'test-agent';  // was: 'CodeAgent' | 'ReviewAgent' | 'DevOpsAgent' | 'TestAgent' | 'DepsAgent'
  dependsOn: string[];
  expectedOutput: string;
  priority: 'high' | 'medium' | 'low';
  requiresApproval?: boolean;
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: TS errors in files using old agentType literals — those will be fixed in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "fix: narrow TaskNode.agentType to kebab-case agent names"
```

---

### Task 2: Agent ID case normalization — InboxManager + taskDispatcher

**Files:**
- Modify: `apps/api/src/agent/InboxManager.ts:21-55`
- Modify: `apps/api/src/ws/taskDispatcher.ts:271-346`
- Modify: `apps/api/src/ws/handler.ts:220-235`

- [ ] **Step 1: Normalize agent name in InboxManager**

In `apps/api/src/agent/InboxManager.ts`, add a private helper and apply to all path-generating methods:

```typescript
// Add after the imports, before the class
function norm(name: string): string {
  return name.toLowerCase();
}

// In init() line 21, change:
const inboxPath = resolve(hostWorkDir, `_inbox_${agentName}.jsonl`);
// To:
const inboxPath = resolve(hostWorkDir, `_inbox_${norm(agentName)}.jsonl`);

// In write() line 36, change:
const inboxPath = resolve(hostWorkDir, `_inbox_${targetAgentName}.jsonl`);
// To:
const inboxPath = resolve(hostWorkDir, `_inbox_${norm(targetAgentName)}.jsonl`);

// In read() line 50, change:
const inboxPath = resolve(hostWorkDir, `_inbox_${agentName}.jsonl`);
// To:
const inboxPath = resolve(hostWorkDir, `_inbox_${norm(agentName)}.jsonl`);
```

- [ ] **Step 2: Case-insensitive agent lookup in taskDispatcher**

In `apps/api/src/ws/taskDispatcher.ts:287-292`, normalize when building agentsByType:

```typescript
// Line 287-292, change:
const agentsByType = new Map<string, typeof sessionAgents[number]['agent'][]>();
for (const sa of sessionAgents) {
  const list = agentsByType.get(sa.agent.displayName) || [];
  list.push(sa.agent);
  agentsByType.set(sa.agent.displayName, list);
}
// To:
const agentsByType = new Map<string, typeof sessionAgents[number]['agent'][]>();
for (const sa of sessionAgents) {
  // Index by both name and displayName (normalized) for robust matching
  const key = sa.agent.name.toLowerCase();
  const list = agentsByType.get(key) || [];
  list.push(sa.agent);
  agentsByType.set(key, list);
  // Also index by displayName normalized for backward compat
  const altKey = sa.agent.displayName.toLowerCase();
  if (altKey !== key) {
    const altList = agentsByType.get(altKey) || [];
    altList.push(sa.agent);
    agentsByType.set(altKey, altList);
  }
}
```

In the same file, line 299, normalize the lookup key:

```typescript
// Line 298-300, change:
for (const task of tasks) {
  const candidates = agentsByType.get(task.agentType) || [];
// To:
for (const task of tasks) {
  const candidates = agentsByType.get(task.agentType.toLowerCase()) || [];
```

Also fix the fallback name generation at line 315:

```typescript
// Line 314-317, remove the fallback that generates wrong-case names.
// Change:
suggestedAgent: {
  name: task.agentType.toLowerCase().replace('agent', '-agent'),
  displayName: task.agentType,
  ...
}
// To: just use task.agentType directly since it's now already correct kebab-case.
```

- [ ] **Step 3: Case-insensitive resolveAgentNameInSession**

In `apps/api/src/ws/handler.ts:220-235`:

```typescript
function resolveAgentNameInSession(sessionId: string, agentType: string): string | null {
  const normalized = agentType.toLowerCase();
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    for (const [name] of procMap) {
      if (name.toLowerCase() === normalized) return name;
    }
  }
  for (const [name] of agentTaskQueues) {
    if (name.toLowerCase() === normalized) return name;
  }
  return agentType;
}
```

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/InboxManager.ts apps/api/src/ws/taskDispatcher.ts apps/api/src/ws/handler.ts
git commit -m "fix: normalize agent IDs to lowercase for inbox routing and task dispatch"
```

---

### Task 3: Default agent cleanup — remove devops-agent + deps-agent

**Files:**
- Modify: `apps/api/src/defaultAgents.ts`
- Modify: `apps/api/src/ws/handler.ts:270-291`
- DB migration: Prisma

- [ ] **Step 1: Remove from defaultAgents**

In `apps/api/src/defaultAgents.ts`, delete the devops-agent (lines 59-88) and deps-agent (lines 112-131) entries from the array. Keep only: code-agent, review-agent, test-agent, planner.

- [ ] **Step 2: Update Planner prompt agentType enum**

In `apps/api/src/defaultAgents.ts`, the Planner's systemPrompt references:

```
agentType 必须是 CodeAgent / ReviewAgent / DevOpsAgent / TestAgent / DepsAgent 之一
```

Change to:

```
agentType 必须是 code-agent / review-agent / test-agent 之一
```

And in the plan JSON schema within the prompt, update:

```json
"agentType": "code-agent | review-agent | test-agent"
```

- [ ] **Step 3: Remove deps-agent special case in broadcastStructuredArtifact**

In `apps/api/src/ws/handler.ts:270-291`, remove the deps-agent block:

```typescript
// Delete lines 281-290:
if (agentName === 'deps-agent') {
  try {
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const report = parseNpmAuditJson(content.slice(jsonStart, jsonEnd + 1));
      if (report.total > 0) broadcast(sessionId, { type: 'security_report', report, exitCode: 0, timestamp: Date.now() });
    }
  } catch { /* content was not npm audit JSON */ }
}
```

- [ ] **Step 4: DB cleanup — delete session agents + agents**

Write and run a one-shot migration script:

```typescript
// Run via: npx tsx scripts/cleanup-default-agents.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Find the agent IDs
  const devops = await prisma.agent.findUnique({ where: { name: 'devops-agent' } });
  const deps = await prisma.agent.findUnique({ where: { name: 'deps-agent' } });

  for (const agent of [devops, deps]) {
    if (!agent) continue;
    // Delete sessionAgent links
    await prisma.sessionAgent.deleteMany({ where: { agentId: agent.id } });
    // Delete the agent
    await prisma.agent.delete({ where: { id: agent.id } });
    console.log(`Deleted agent: ${agent.name}`);
  }
}

main().then(() => prisma.$disconnect());
```

Run: `cd apps/api && npx tsx scripts/cleanup-default-agents.ts`

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/defaultAgents.ts apps/api/src/ws/handler.ts scripts/cleanup-default-agents.ts
git commit -m "feat: remove devops-agent and deps-agent from default agents"
```

---

### Task 4: Fix code block `[object Object]` rendering

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Add safe content serializer in ChatView**

Find the message content rendering path. The issue is when `event.content` is an object, `String()` produces `[object Object]`. Add a helper and apply it wherever content is rendered as text.

In `apps/web/src/components/ChatView.tsx`, add near the top:

```typescript
function safeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
```

Find the `stream_chunk` rendering path where content is added to message text. Ensure `safeContent()` wraps the content value before it's appended. The exact location is in the message rendering logic — where `event.content` or `msg.content` is displayed.

- [ ] **Step 2: Verify with test**

Start the app, create a message that triggers a code block in agent output. Verify the JSON renders as readable text, not `[object Object]`.

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "fix: serialize objects in chat content to avoid [object Object] rendering"
```

---

### Task 5: Inbox summary truncation fix

**Files:**
- Modify: `apps/api/src/ws/handler.ts` (text event handling section)
- Modify: `apps/api/src/agent/InboxManager.ts`

- [ ] **Step 1: Investigate — log full summary length**

In `apps/api/src/agent/InboxManager.ts:36-48` (`write` method), add a length check:

```typescript
static write(hostWorkDir: string, targetAgentName: string, entry: InboxEntry): void {
  if (entry.summary && entry.summary.length > 500) {
    console.warn(`[inbox] Large summary (${entry.summary.length} chars) from ${entry.from} to ${targetAgentName}`);
  }
  // ... rest unchanged
}
```

- [ ] **Step 2: Fix — ensure complete text before IntentParser.scan**

In `apps/api/src/ws/handler.ts`, the `case 'done'` handler (around line 594). Currently `IntentParser.scan` may only run on partial stream_chunk text. Move intent scanning to the `done` event where `accumulatedContent` is complete.

In the `done` event handler, after final content save, add:

```typescript
// Scan complete agent output for cross-agent intents
const helpIntents = IntentParser.scan(accumulatedContent);
for (const intent of helpIntents) {
  InboxManager.write(sandbox.hostWorkDir, intent.targetAgentName, {
    type: 'intervention_request',
    id: generateId(),
    from: agentNameForProc || 'agent',
    to: intent.targetAgentName,
    summary: intent.description,
    risk: 'high',
    timestamp: Date.now(),
  });
}
```

This replaces any mid-stream IntentParser.scan that may be receiving truncated text chunks.

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/ws/handler.ts apps/api/src/agent/InboxManager.ts
git commit -m "fix: scan agent intents on complete text, not streaming chunks"
```

---

### Task 6: Planner natural-language replies

**Files:**
- Modify: `apps/api/src/defaultAgents.ts` (Planner systemPrompt)
- Modify: `apps/api/src/ws/handler.ts` (planner text event processing ~lines 493-507)

- [ ] **Step 1: Rewrite Planner systemPrompt**

Replace the entire Planner entry's `systemPrompt` in `apps/api/src/defaultAgents.ts` with:

```typescript
systemPrompt: `## 你的身份

你是本群的 Planner，一个资深技术主管。你用中文以自然对话方式与用户交流。

## 行为准则

1. **自然对话** — 像技术主管那样友好、专业、直接。不要说你"检测到触发词"、"现在开始规划"或类似机器人用语。直接回应即可。

2. **默认闲聊模式** — 用户没有明确开发需求时，以对话方式回应。一般性技术讨论、项目问答、需求澄清都是闲聊。

3. **规划模式** — 当用户描述了一个需要多步骤实现的开发需求时：
   a. 先用 ls 和 cat package.json 了解项目结构
   b. 用中文自然地解释你的规划思路（每项任务做什么、为什么这样安排、预估产出）
   c. 在消息末尾用 \`<!--AGENTHUB_PLAN{...}-->\` 格式嵌入任务计划 JSON。这个 JSON 不会被用户看到。

   用户可见的回复示例：
   "好的，让我先看看项目结构。…[探索结果]… 这个番茄钟项目我拆成 3 个任务：先写核心逻辑，再写测试，最后审查。@code-agent 来写 CLI 主程序，@test-agent 负责测试用例。"

   任务计划 JSON 格式（嵌入在消息末尾，用户不可见）：
   <!--AGENTHUB_PLAN{"planTitle":"...","summary":"...","tasks":[{"id":"task-1","title":"...","description":"...","agentType":"code-agent","dependsOn":[],"expectedOutput":"...","priority":"high"}]}-->

4. **任务指派** — 在自然对话中用 @agentName 提及负责的 agent。不要使用 "NEEDS HELP from" 或任何指令语法。@mention 是给用户看的，实际调度由系统根据隐藏的 JSON 完成。

5. **能力边界** — 超出能力范围的请求礼貌说明并引导用户。你只做规划，不写代码。

## 关键约束
- 输出 <!--AGENTHUB_PLAN...--> 后立即停止
- 不要调用 Write、Edit 或 Agent 工具
- 你的产出是规划蓝图，执行交给群内其他 agent`,
```

- [ ] **Step 2: Strip hidden plan JSON in handler.ts**

In `apps/api/src/ws/handler.ts`, in the text event handler (around lines 493-507, the `case 'text':` block with `isPlannerAgent` check), replace the existing JSON block filtering logic:

```typescript
case 'text': {
  accumulatedContent += event.content;
  let chatContent = event.content;
  if (isPlannerAgent) {
    // Strip <!--AGENTHUB_PLAN{...}--> from user-visible content
    chatContent = chatContent.replace(/<!--AGENTHUB_PLAN\{[\s\S]*?\}-->/g, '');
    if (!chatContent.trim()) break; // nothing user-visible in this chunk
  }
  if (chatContent) broadcast(sessionId, { type: 'stream_chunk', content: chatContent, agentMessageId: mention.messageId });
  broadcast(sessionId, { type: 'agent_status', status: 'thinking', details: { content: event.content.slice(0, 120) }, agentMessageId: mention.messageId, timestamp: Date.now() });
  break;
}
```

- [ ] **Step 3: Extract plan JSON on done event**

In the `case 'done':` handler, after finalizing the message, add plan extraction:

```typescript
// Extract hidden plan JSON from Planner output
if (isPlannerAgent) {
  const planMatch = accumulatedContent.match(/<!--AGENTHUB_PLAN(\{[\s\S]*?\})-->/);
  if (planMatch) {
    try {
      const plan = JSON.parse(planMatch[1]);
      const validated = extractAndValidate(JSON.stringify(plan));
      if (validated) {
        // Save plan to DB and dispatch tasks
        const planId = `plan-${Date.now()}`;
        await prisma.taskPlan.create({
          data: {
            id: planId,
            sessionId,
            userId: (await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } }))!.userId,
            plan: plan,
            status: 'pending_confirmation',
          },
        });
        broadcast(sessionId, {
          type: 'plan_ready',
          planId,
          planTitle: validated.planTitle,
          summary: validated.summary,
          tasks: validated.tasks.map(t => ({
            taskId: t.id,
            title: t.title,
            agentType: t.agentType,
            dependsOn: t.dependsOn,
            expectedOutput: t.expectedOutput,
            priority: t.priority,
            status: 'waiting',
          })),
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      console.error(`[ws] Failed to parse embedded plan: ${err.message}`);
    }
  }
}
```

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS (may need to import `extractAndValidate` if not already in scope — it's already imported at line 11)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/defaultAgents.ts apps/api/src/ws/handler.ts
git commit -m "feat: Planner natural-language replies with hidden plan JSON embedding"
```

---

### Task 7: Code block fold in chat

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Create foldable code block component**

Add a `FoldableCodeBlock` component in `ChatView.tsx`:

```typescript
function FoldableCodeBlock({ language, code }: { language: string; code: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const shouldFold = lines.length > 6;
  const displayLines = expanded || !shouldFold ? lines : lines.slice(0, 6);
  const displayCode = displayLines.join('\n');

  return (
    <div className="relative my-2 rounded-hub-lg overflow-hidden bg-hub-raised border border-hub">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-hub-surface border-b border-hub text-[11px] text-hub-tertiary">
        <span className="font-mono">{language || 'code'}</span>
        <button
          onClick={() => navigator.clipboard.writeText(code)}
          className="hover:text-hub-secondary transition"
          title="Copy"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </div>
      {/* Code */}
      <pre className="p-3 text-[12px] leading-relaxed overflow-x-auto font-mono text-hub-primary">
        <code>{displayCode}</code>
      </pre>
      {/* Fold toggle */}
      {shouldFold && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full py-1.5 text-[11px] text-hub-link hover:bg-hub-hover transition border-t border-hub"
        >
          {expanded ? '收起' : `展开全部 (${lines.length} 行)`}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Integrate into message rendering**

Find the existing code block rendering in ChatView's message content. Wrap existing pre/code blocks with `FoldableCodeBlock`. Parse the language tag from markdown code fences (```language). Replace inline code rendering with the foldable component.

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Visual test**

Run: start dev servers, send a message that produces a long code block (>6 lines). Verify fold button appears and expand/collapse works.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat: foldable code blocks in chat (default 6 lines, expandable)"
```

---

### Task 8: AgentCard flip redesign — face components

**Files:**
- Create: `apps/web/src/components/AgentCardFaces.tsx`
- Modify: `apps/web/src/components/AgentCard.tsx`

- [ ] **Step 1: Create AgentCardFaces.tsx**

```typescript
import type { AgentEvent } from '../store/appStore';

// ---- Face 1: Business Card ----
export function FaceBusinessCard({
  displayName,
  description,
  capabilityTags,
  avatarBg,
  avatarLetter,
}: {
  displayName: string;
  description: string;
  capabilityTags: string[];
  avatarBg: string;
  avatarLetter: string;
}) {
  return (
    <div className="flex flex-col items-center py-4 px-3 space-y-3">
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold text-white"
        style={{ backgroundColor: avatarBg }}
      >
        {avatarLetter}
      </div>
      <div className="text-center">
        <h3 className="text-body font-semibold text-hub-primary">{displayName}</h3>
        <p className="text-caption text-hub-tertiary mt-0.5">{description}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-1">
        {capabilityTags.map(tag => (
          <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-hub-accent/10 text-hub-accent">
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Face 2: Terminal Log ----
export function FaceTerminalLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-hub-muted text-caption italic">
        等待任务...
      </div>
    );
  }

  return (
    <div className="max-h-52 overflow-y-auto panel-scroll p-2 font-mono text-[10px] leading-relaxed space-y-0.5">
      {events.map((ev, i) => {
        const time = new Date(ev.timestamp || Date.now()).toISOString().slice(11, 19);
        switch (ev.type) {
          case 'thinking':
            return <div key={i} className="text-hub-muted">{`[${time}] THINK  ${(ev.details as any)?.content?.slice(0, 80) || '...'}`}</div>;
          case 'tool_use':
            return <div key={i} className="text-hub-accent">{`[${time}] TOOL   ${(ev.details as any)?.toolName || '?'} ${(ev.details as any)?.inputPreview || ''}`}</div>;
          case 'tool_result':
            return <div key={i} className="text-hub-success">{`[${time}] RESULT ${((ev.details as any)?.resultPreview || (ev.details as any)?.content || '').slice(0, 80)}`}</div>;
          case 'subagent_start':
            return <div key={i} className="text-hub-link">{`[${time}] AGENT  ${(ev.details as any)?.agentType || '?'} started`}</div>;
          case 'subagent_result':
            return <div key={i} className="text-hub-success/80">{`[${time}] AGENT  ${(ev.details as any)?.agentType || '?'} done`}</div>;
          case 'permission_request':
            return <div key={i} className="text-hub-warning">{`[${time}] PERM   ${(ev.details as any)?.tool || '?'}`}</div>;
          default:
            return null;
        }
      })}
    </div>
  );
}

// ---- Face 3: Dashboard ----
export function FaceDashboard({
  model,
  contextPct,
  inputTokens,
  outputTokens,
  cacheTokens,
  thinkingLevel,
  toolCount,
  duration,
}: {
  model: string;
  contextPct: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  thinkingLevel: string;
  toolCount: number;
  duration: string;
}) {
  const barColor = contextPct > 80 ? 'bg-hub-danger' : contextPct > 50 ? 'bg-hub-warning' : 'bg-hub-success';
  const totalTokens = inputTokens + outputTokens + cacheTokens;
  const inputPct = totalTokens > 0 ? (inputTokens / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? (outputTokens / totalTokens) * 100 : 0;
  const cachePct = totalTokens > 0 ? (cacheTokens / totalTokens) * 100 : 0;

  return (
    <div className="py-3 px-3 space-y-3 text-[11px]">
      {/* Model */}
      <div className="flex items-center justify-between">
        <span className="text-hub-tertiary">模型</span>
        <span className="text-hub-primary font-medium font-mono">{model}</span>
      </div>

      {/* Context usage */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-hub-tertiary">上下文消耗</span>
          <span className={contextPct > 80 ? 'text-hub-danger' : 'text-hub-primary'}>{contextPct}%</span>
        </div>
        <div className="h-2 bg-hub-raised rounded-full overflow-hidden">
          <div className={`h-full ${barColor} rounded-full transition-all duration-500`} style={{ width: `${contextPct}%` }} />
        </div>
      </div>

      {/* Token usage */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-hub-tertiary">Token 用量</span>
          <span className="text-hub-primary font-mono">{formatTokens(inputTokens + outputTokens)}</span>
        </div>
        <div className="h-2 bg-hub-raised rounded-full overflow-hidden flex">
          <div className="h-full bg-hub-link" style={{ width: `${inputPct}%` }} title={`Input: ${formatTokens(inputTokens)}`} />
          <div className="h-full bg-hub-success" style={{ width: `${outputPct}%` }} title={`Output: ${formatTokens(outputTokens)}`} />
          <div className="h-full bg-hub-muted" style={{ width: `${cachePct}%` }} title={`Cache: ${formatTokens(cacheTokens)}`} />
        </div>
        <div className="flex gap-3 mt-1 text-[10px] text-hub-tertiary">
          <span>↑ {formatTokens(inputTokens)} in</span>
          <span>↓ {formatTokens(outputTokens)} out</span>
          {cacheTokens > 0 && <span>⊕ {formatTokens(cacheTokens)} cache</span>}
        </div>
      </div>

      {/* Thinking level */}
      <div className="flex items-center justify-between">
        <span className="text-hub-tertiary">思考等级</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
          thinkingLevel === 'high' ? 'bg-hub-accent/20 text-hub-accent' :
          thinkingLevel === 'medium' ? 'bg-hub-warning/20 text-hub-warning' :
          'bg-hub-muted/20 text-hub-muted'
        }`}>{thinkingLevel || 'off'}</span>
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-hub-tertiary">
        <span>{toolCount} 次工具调用</span>
        <span>{duration}</span>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS (may need to fix AgentEvent type imports — ensure AgentEvent has `timestamp`, `type`, `details` fields)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AgentCardFaces.tsx
git commit -m "feat: AgentCard face components — business card, terminal log, dashboard"
```

---

### Task 9: AgentCard flip redesign — main component rewrite

**Files:**
- Modify: `apps/web/src/components/AgentCard.tsx`

- [ ] **Step 1: Rewrite AgentCard.tsx**

Full rewrite with flip state, fixed header, dot indicators, and fade transition between faces:

```typescript
import { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { FaceBusinessCard, FaceTerminalLog, FaceDashboard } from './AgentCardFaces';

function deriveCapabilityTags(agentName?: string, displayName?: string): string[] {
  const name = (agentName || displayName || '').toLowerCase();
  const tags: string[] = [];
  if (name.includes('code')) tags.push('代码生成');
  if (name.includes('review')) tags.push('代码审查');
  if (name.includes('test')) tags.push('测试');
  if (name.includes('planner')) tags.push('任务规划');
  if (name.includes('frontend')) tags.push('前端开发');
  if (name.includes('backend')) tags.push('后端开发');
  if (tags.length === 0) tags.push('通用');
  return tags;
}

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

interface Props {
  agentId: string;
  displayName: string;
  status: 'running' | 'done' | 'idle';
  events: AgentEvent[];
  onStop?: () => void;
  agentName?: string;
  collapsed?: boolean;
  viewMode?: 'detailed' | 'aggregated' | 'errors';
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  running: { label: '在线', cls: 'bg-hub-success/20 text-hub-success' },
  done:    { label: '完成', cls: 'bg-hub-link/20 text-hub-link' },
  idle:    { label: '空闲', cls: 'bg-hub-muted/20 text-hub-muted' },
};

export function AgentCard({ agentId, displayName, status, events, onStop, agentName, collapsed, viewMode }: Props) {
  const [activeFace, setActiveFace] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [fading, setFading] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === 'running') setExpanded(true);
  }, [status]);

  // Clear terminal log on done/error
  const terminalEvents = status === 'running' ? events : [];

  const capabilityTags = deriveCapabilityTags(agentName, displayName);
  const avatarBg = avatarColor(agentName || displayName);
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const badge = STATUS_BADGE[status] || STATUS_BADGE.idle;

  // Dashboard data
  const tokenEvents = events.filter((e) => e.type === 'token_update');
  const lastToken = tokenEvents.length > 0 ? tokenEvents[tokenEvents.length - 1].details?.tokenUsage : null;
  const toolCount = events.filter((e) => e.type === 'tool_use').length;
  const inputTokens = lastToken?.input ?? 0;
  const outputTokens = lastToken?.output ?? 0;
  const cacheTokens = (lastToken?.cacheRead ?? 0) + (lastToken?.cacheCreate ?? 0);
  const contextPct = lastToken?.contextPct ?? 0;

  // Model from agent config
  const agentConfig = useAppStore(s => s.agents.find(a => a.name === agentName));
  const model = (agentConfig as any)?.settings?.model || 'unknown';

  // Thinking level from store
  const currentTask = useAppStore(s => agentName ? s.agentCurrentTask[agentName] : null);

  const isCollapsed = collapsed && !expanded;

  const switchFace = (face: number) => {
    if (face === activeFace) return;
    setFading(true);
    setTimeout(() => {
      setActiveFace(face);
      setFading(false);
    }, 200);
  };

  if (isCollapsed) {
    return (
      <div
        onClick={() => setExpanded(true)}
        className="bg-hub-surface border-hub rounded-hub-lg mb-2 px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-hub-hover transition"
      >
        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0" style={{ backgroundColor: avatarBg }}>
          {avatarLetter}
        </div>
        <span className="text-caption font-medium text-hub-secondary truncate">{displayName}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.cls}`}>{badge.label}</span>
      </div>
    );
  }

  return (
    <div className="bg-hub-surface border-hub rounded-hub-lg mb-2.5 overflow-hidden">
      {/* ---- Fixed Header ---- */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-hub">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
          style={{ backgroundColor: avatarBg }}
        >
          {avatarLetter}
        </div>
        <span className="text-body font-semibold text-hub-primary truncate">{displayName}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${badge.cls}`}>
          {badge.label}
        </span>
        {/* Dot indicators */}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          {[0, 1, 2].map(face => (
            <button
              key={face}
              onClick={(e) => { e.stopPropagation(); switchFace(face); }}
              className={`w-2 h-2 rounded-full transition-all ${
                activeFace === face
                  ? 'bg-hub-accent scale-110'
                  : 'bg-hub-muted/30 hover:bg-hub-muted/60'
              }`}
              title={['摘要', '日志', '仪表盘'][face]}
            />
          ))}
        </div>
        {status === 'running' && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="p-1 rounded hover:bg-hub-danger/15 text-hub-danger/80 flex-shrink-0 transition"
            title="Stop"
          >
            <Square className="w-3 h-3" fill="currentColor" />
          </button>
        )}
      </div>

      {/* ---- Flip Content Area ---- */}
      <div
        className={`transition-all duration-200 ${
          fading ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'
        }`}
      >
        {activeFace === 0 && (
          <FaceBusinessCard
            displayName={displayName}
            description={agentConfig?.description || ''}
            capabilityTags={capabilityTags}
            avatarBg={avatarBg}
            avatarLetter={avatarLetter}
          />
        )}
        {activeFace === 1 && (
          <FaceTerminalLog events={terminalEvents} />
        )}
        {activeFace === 2 && (
          <FaceDashboard
            model={model}
            contextPct={contextPct}
            inputTokens={inputTokens}
            outputTokens={outputTokens}
            cacheTokens={cacheTokens}
            thinkingLevel={(agentConfig as any)?.settings?.thinking ? 'high' : 'off'}
            toolCount={toolCount}
            duration="-"
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Visual verification**

Run: start dev servers, open a group session. Verify:
- AgentCard shows fixed header with avatar, name, status badge, 3 dot indicators
- Clicking dots switches faces with fade animation
- Face 1 shows business card layout
- Face 2 shows terminal log when agent is running, "等待任务..." when idle
- Face 3 shows dashboard with model, context bar, token bars
- Dot indicators highlight active face

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/AgentCard.tsx
git commit -m "feat: AgentCard flip redesign with 3 faces and fade transitions"
```

---

### Task 10: Integration test — end-to-end validation

- [ ] **Step 1: Start dev servers and run through spec checklist**

```bash
# Start backend + frontend
bash scripts/startup.sh
```

Manual verification:
1. Create new group session — verify only 4 agents (code-agent, review-agent, test-agent, planner)
2. Send planning request — verify Planner replies in natural Chinese, no "NEEDS HELP" or trigger text
3. Confirm plan — verify CodeAgent receives and executes tasks
4. Check sandbox inbox files — verify single inbox per agent (no case variants)
5. Send message producing long code — verify fold button appears
6. Click AgentCard dots — verify 3 faces with correct content
7. Check Face 3 — verify model name, context %, token bars are real values

- [ ] **Step 2: TypeScript full check**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: ALL PASS

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: integration fixes from end-to-end validation"
```
