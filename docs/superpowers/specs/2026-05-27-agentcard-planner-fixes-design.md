# AgentCard Redesign & Core Bug Fixes

## Scope

This spec covers 5 workstreams:

1. **Bug fix**: Agent ID case-mismatch causing inbox routing failure
2. **Bug fix**: Inbox summary truncation
3. **Bug fix**: Code block rendering `[object Object]`
4. **Default agent cleanup**: Remove devops-agent and deps-agent
5. **Planner natural-language replies**: Hide structured dispatch instructions from users
6. **Plaintext code block fold**: Default-collapsed code blocks in chat
7. **AgentCard flip redesign**: 3-face card with fade transition

## 1. Agent ID Case Normalization

### Problem

Planner prompt uses displayName-style agent types (`CodeAgent`, `ReviewAgent`), but actual agent names are kebab-case (`code-agent`, `review-agent`). This causes:

- `dispatchTasksToAgents` fails to match, writes inbox to `_inbox_CodeAgent.jsonl`
- `InboxManager.read` looks up `_inbox_code-agent.jsonl` (empty)
- CodeAgent never receives the task

### Fix

**Backend — `defaultAgents.ts`:**
- Planner systemPrompt: agentType enum changed from `CodeAgent | ReviewAgent | DevOpsAgent | TestAgent | DepsAgent` to `code-agent | review-agent | test-agent`

**Backend — `taskDispatcher.ts`:**
- `dispatchTasksToAgents`: normalize both `task.agentType` and agent `name`/`displayName` to lowercase before comparison
- `resolveAgentNameInSession`: case-insensitive agent name lookup

**Backend — `InboxManager.ts`:**
- All paths normalized to lowercase: `_inbox_${agentName.toLowerCase()}.jsonl`

**Shared — `packages/shared/src/types.ts`:**
- `TaskNode.agentType` union narrowed to `'code-agent' | 'review-agent' | 'test-agent'`

### Verification

- Create group session with Planner + CodeAgent + ReviewAgent + TestAgent
- Send planning trigger; verify plan JSON uses kebab-case agentType
- Verify single inbox file per agent (no case variants)
- Verify CodeAgent receives and executes assigned tasks

## 2. Inbox Summary Truncation

### Problem

In `_inbox_CodeAgent.jsonl`, the summary field ends abruptly (`"要求："`). Root cause: the Planner's text output (from which `IntentParser.scan` extracts `description`) may be truncated by the streaming pipeline, or `JSON.stringify` on the InboxEntry may lose tail content.

### Fix

Investigation steps:
1. Check if `IntentParser.scan` receives complete text — verify accumulated text in handler.ts is not being cut off before scan
2. Check InboxManager.write — ensure no silent truncation in `appendFileSync`
3. Add length guard: if summary exceeds 500 chars, log warning

If root cause is streaming chunk boundaries, buffer text until `done` event before scanning for intents.

## 3. Code Block `[object Object]` Rendering

### Problem

When a code block contains JavaScript objects (not strings), the frontend renders `[object Object]` because `String(obj)` is called instead of `JSON.stringify(obj)`.

### Fix

**Frontend — `ChatView.tsx`:**
- In the code-to-text path, detect if content is an object type and serialize with `JSON.stringify(content, null, 2)` before rendering
- This applies to the `stream_chunk` handler that builds message content

## 4. Default Agent Cleanup

### What

Remove `devops-agent` and `deps-agent` from the default agent lineup.

### Changes

- `defaultAgents.ts`: delete devops-agent and deps-agent entries
- `handler.ts:handleDeployToPlatform` and `broadcastStructuredArtifact`: remove deps-agent special case
- Database migration: delete `SessionAgent` rows for devops-agent/deps-agent, then delete the agents themselves
- `shared/types.ts`: `TaskNode.agentType` updated (covered in section 1)

## 5. Planner Natural-Language Replies

### Problem

Users see internal dispatch syntax in chat:
- "检测到触发规划，现在开始规划"
- "NEEDS HELP from @CodeAgent: 请用 Node.js 写一个 CLI 番茄钟工具..."

Planner should converse naturally like a tech lead, not emit machine-readable directives.

### Design

**Planner prompt rewrite (`defaultAgents.ts`):**

- Remove trigger-word detection gating ("检测到触发词..."). Planner judges intent from context.
- Planning output format: explain reasoning in natural Chinese, then embed plan JSON in `<!--AGENTHUB_PLAN{...}-->` HTML comment at message end
- Task handoff: use natural @-mentions ("@CodeAgent 来实现后端接口"), NOT "NEEDS HELP from @CodeAgent:"
- Remove all "不要调用 Write/Edit/Agent" instruction leakage — those are system constraints, not user-facing text

**Backend — `handler.ts` text event processing:**

- When `isPlannerAgent`: scan accumulated text for `<!--AGENTHUB_PLAN` ... `-->` blocks
- Strip plan JSON blocks from content before broadcasting `stream_chunk` to frontend
- Parse extracted JSON for task dispatch via existing `extractAndValidate` + `dispatchTasksToAgents` pipeline

**Backend — `IntentParser.ts`:**

- Deprecate NEEDS_HELP_RE pattern. Cross-agent task dispatch is now driven by the parsed plan JSON, not by scanning agent text for directives.

### User-visible behavior change

| Before | After |
|--------|-------|
| "检测到触发规划，现在开始规划..." | "好的，让我先看看项目结构，然后给你拆解任务。" |
| "NEEDS HELP from @CodeAgent: 请用 Node.js 写..." | "@CodeAgent 来写一个 Node.js CLI 番茄钟工具，文件名为 pomo.js" |
| JSON shown directly in chat | JSON hidden from chat, visible only if user inspects plan card |

## 6. Plaintext Code Block Fold

### Design

- Code blocks default to showing first 6 lines
- Below line 6: "展开全部 (N 行)" button, centered, subtle style
- Click to expand: full code visible
- Expanded state: "收起" button at bottom
- No `max-height` + scroll approach — purely fold/unfold

### Implementation

**Frontend — ChatView message rendering:**
- Detect markdown code fences in message content
- If code block exceeds 6 lines, render fold wrapper
- State per code block (use a Set of expanded block indices)

## 7. AgentCard Flip Redesign

### Layout

```
┌─────────────────────────────────────┐
│ 🔴 Avatar  AgentName  [状态badge] ○○○│  ← fixed header
├─────────────────────────────────────┤
│                                     │
│         Flip content area           │  ← transitions with fade
│         (one of 3 faces)            │
│                                     │
└─────────────────────────────────────┘
```

### Fixed Header (always visible)

- **Left**: colored avatar circle (first letter) + displayName
- **Right of name**: status badge — `在线` (running, green), `空闲` (idle, gray), `完成` (done, blue)
- **Rightmost**: three dot indicators ○○● representing face 1/2/3, clickable to jump to face

### Face Transition

- CSS `opacity` + `transform: translateY(4px)` fade, 250ms duration
- `opacity: 0` → swap content → `opacity: 1`
- Dot indicator updates to reflect active face

### Face 1 — Business Card (名片)

- Large avatar (48px), display name, one-line description from agent config
- "擅长" section: capability tags as chips (代码生成, 代码审查, 测试, 任务规划)

### Face 2 — Terminal Log (终端日志)

- Monospace font (`JetBrains Mono` / `Consolas` / monospace fallback)
- Each event one line: `[HH:MM:SS] TYPE  message`
- Event types: `THINK`, `TOOL`, `RESULT`, `SUBAGENT`, `PERM`
- Only populated when agent status is `running`
- Cleared automatically when status transitions to `done` or `error`
- Empty state: dim text "等待任务..." centered

### Face 3 — Dashboard (仪表盘)

- **Model**: config model name (e.g., `deepseek-v4-pro`)
- **Context usage**: horizontal progress bar, label "上下文消耗 73% (146K/200K)"
  - Color: green < 50%, yellow 50-80%, red > 80%
- **Token usage**: horizontal stacked bar (input blue / output green / cache gray), with absolute numbers below
- **Thinking level**: badge (e.g., `high` / `medium` / `off`)
- **Session stats**: running duration, cumulative tokens, total tool calls

### Component changes

- `AgentCard.tsx`: full rewrite with flip state management
- New file: `AgentCardFaces.tsx` — face content components
- State: `activeFace` (0|1|2), managed in component local state
- Store: ensure `agentEvents` is kept per agent and cleared on done (already partially implemented via `StateTracker`)

### AgentCard removal from default session agents

The current implementation already allows a subset of agents in session. No code change needed — by removing devops-agent and deps-agent from defaults (section 4), new sessions won't have them. Existing sessions get cleaned up via DB migration.

## Verification Checklist

- [ ] New group session: only code-agent, review-agent, test-agent, planner present
- [ ] Planner output is natural Chinese, no "NEEDS HELP" or trigger-detection text visible
- [ ] Task plan JSON hidden from chat, but plan card shows in UI
- [ ] CodeAgent receives and executes tasks (no case-mismatch dead letter)
- [ ] Code blocks > 6 lines show fold button, expand works
- [ ] AgentCard flip: click dots to switch faces, fade animation visible
- [ ] Face 2 content appears only during running, clears on done
- [ ] Face 3 shows real model name, context %, token numbers
- [ ] `[object Object]` no longer appears in code blocks
- [ ] Inbox summary not truncated
