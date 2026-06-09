# Context Management: Eliminate Double Injection + Wire NEEDS HELP + Session Context

Date: 2026-06-02
Issue: #41

## Problem Statement

Three architectural issues in the agent prompt pipeline:

1. **Double injection**: `buildHistory()` injects last 20 messages into every prompt, but Claude Code SDK maintains its own session history via `resume`. The same messages appear twice — wasted tokens and potential inconsistency.

2. **NEEDS HELP disconnected**: `IntentParser.ts` defines `scan()` for parsing "NEEDS HELP from @Agent:" patterns, but no code ever calls it. Agent-to-agent help requests are silently lost.

3. **No session-level context**: Agents don't know what other agents exist in the session, their capabilities, or the current plan state. Environment awareness depends entirely on static CLAUDE.md files.

## Goals

- G1: Eliminate redundant conversation history injection (SDK owns history, Hub owns structured context)
- G2: Wire NEEDS HELP intent parsing so agents can request and offer help
- G3: Replace raw history with structured session context (agent roster, plan state)
- G4: Maintain AgentCoordinator (path A) stability — no regressions in event-driven inbox routing

## Non-Goals

- NG1: Per-message token counting UI (deferred)
- NG2: Context window configuration UI (deferred)

## Design

### Part 1: Replace `buildHistory()` with `buildSessionContext()`

**Current** (`chatHandlers.ts:100-108`):
```
buildHistory(sessionId) → last 20 messages → text dump → inject into prompt
```

**New** (`chatHandlers.ts`):
```
buildSessionContext(sessionId, agentName) → structured context → inject into prompt
```

#### `buildSessionContext()` output format

```markdown
## Session Context

**Mode**: Group (3 agents)
**Agents**:
- **planner** — Task planning and DAG orchestration
- **code-agent** — Code implementation and file editing
- **review-agent** — Code review and quality checks

**Active Plan**: "实现登录功能" — 2/5 tasks completed, 1 running
**Workspace**: /workspace
```

#### Implementation

1. New function `buildSessionContext(sessionId, agentName)` in `chatHandlers.ts`:
   - Query session agents from `prisma.sessionAgent` (include agent name + description)
   - Query active plan from in-memory `planExecutions` (if any)
   - Format as structured markdown block
   - Exclude current agent from the "Agents" list (it knows itself)

2. Modify prompt assembly (line 274):
   ```typescript
   // Before:
   agentPrompt = `${agent.systemPrompt}${inboxPrompt}${inboxWakeup}${sessionMemberBlock}${lang}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;

   // After:
   const sessionContext = await buildSessionContext(sessionId, agent.name);
   agentPrompt = `${agent.systemPrompt}${inboxPrompt}${inboxWakeup}${sessionMemberBlock}${lang}\n\n${sessionContext ? sessionContext + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
   ```

3. Delete `buildHistory()` function.

#### SDK session loss fallback

When an agent's SDK session is lost (container rebuild, rehome), the agent starts fresh. In this case:
- `buildSessionContext()` still provides agent roster + plan state
- The agent's CLAUDE.md provides persistent identity
- The agent's memory (`.claude/memory/`) provides accumulated experience
- No raw conversation history is needed — the SDK will rebuild context through its new session

### Part 2: Wire NEEDS HELP IntentParser

**Current state**: `IntentParser.ts` defines `scan()` but nothing calls it.

**Wiring point**: `handler.ts` — in the agent output processing path, after accumulating agent text output.

#### Implementation

1. In `handler.ts`, find the agent output accumulation point (where `accumulatedOutput` or similar is built from agent text events).

2. After each text event (or on `done`), call:
   ```typescript
   import { IntentParser } from '../agent/IntentParser.js';
   import { InboxManager } from '../agent/InboxManager.js';

   const intents = IntentParser.scan(textChunk);
   for (const intent of intents) {
     const targetAgent = resolveAgentByName(sessionId, intent.targetAgentName);
     if (targetAgent) {
       InboxManager.write(hostWorkDir, intent.targetAgentName, {
         type: 'help_request',
         id: `help-${Date.now()}`,
         from: agentName,
         to: intent.targetAgentName,
         summary: intent.description,
         risk: 'low',
         timestamp: Date.now(),
       }, sessionId);
     }
   }
   ```

3. Add `resolveAgentByName()` helper — looks up session agents by name to validate the target exists.

4. AgentCoordinator stability: This wiring is additive — it does NOT modify AgentCoordinator or EventRoutingRules. Path A remains untouched.

### Part 3: Enhance Inbox Context

When injecting inbox messages via `InboxWakeup.buildInboxPrompt()`, include the sender's capability description so the receiving agent can judge relevance.

#### Implementation

In `InboxWakeup.buildInboxPrompt()`:
- For each inbox entry, look up the sender agent's description from DB or cache
- Append a brief capability tag: `From **code-agent** (Code implementation): ...`

This is a small enhancement to existing code — no new files needed.

### Part 4: Auto-Compression via Agent Self-Summarization (Plan B)

When cumulative token usage exceeds 70% of the context window, the Hub triggers
the agent to summarize the conversation, then resets the SDK session with the
compressed summary injected.

#### Trigger detection

`AgentRuntime.tokenUsageMap` already tracks cumulative tokens per agent per
session. When `contextPct > 70%`, set a flag `needsCompression` on the agent
entry. The flag is checked in `sendPrompt()` before the next message.

#### Four-step cycle

```
1. [DETECT]  sendPrompt() sees needsCompression === true
2. [SUMMARIZE] Hub sends a compression prompt instead of the user message:
     "## Context Compression\n\nYour context window is X% full.
      Please write a concise summary of the conversation so far.
      Include: key decisions, active tasks, current state.
      Your summary will be used as the starting context for the next session."
     → Agent produces summary in its response
3. [EXTRACT] Hub captures the agent's text output as the summary
4. [RESET]   provider.stop() → provider.start(summary + user message)
             New SDK session (no resume), summary injected as initial context
```

#### Summary storage

The summary is persisted to `{sandboxDir}/_agent_{agentName}/_context_summary.md`.
On SDK session loss (rehome, rebuild), the Hub reads this file and injects it
as the initial context for the new session — no data loss.

#### Implementation

1. In `AgentRuntime.ts`: add `needsCompression` flag to `AgentEntry`, set when
   `contextPct > 70%` in `handleAgentEvent` (case `token_usage`).

2. In `AgentRuntime.sendPrompt()`: check `needsCompression`. If true:
   - Send compression prompt instead of user prompt
   - Capture agent response text as summary
   - Call `provider.stop()` then `provider.start()` with summary + user prompt
   - Clear `needsCompression` flag

3. New helper `buildCompressionPrompt(contextPct)`: generates the compression
   instruction for the agent.

## File Changes Summary

| File | Change |
|------|--------|
| `apps/api/src/ws/chatHandlers.ts` | Delete `buildHistory()`, add `buildSessionContext()`, update prompt assembly |
| `apps/api/src/ws/handler.ts` | Wire `IntentParser.scan()` in agent output path |
| `apps/api/src/agent/InboxWakeup.ts` | Enhance inbox entries with sender capability info |
| `apps/api/src/agent/AgentRuntime.ts` | Add `needsCompression` flag, compression trigger in `sendPrompt()`, helper `buildCompressionPrompt()` |
| `apps/api/src/agent/IntentParser.ts` | No changes needed (already correct) |
| `apps/api/src/agent/AgentCoordinator.ts` | No changes (stability preserved) |
| `apps/api/src/agent/InboxManager.ts` | No changes needed |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| SDK session loss loses conversation history | CLAUDE.md + memory + session context + `_context_summary.md` provide sufficient recovery |
| Agent needs conversation history for complex multi-turn tasks | SDK session resume handles this — agent's own history is preserved |
| IntentParser false positives on code content containing "NEEDS HELP" | Regex is specific enough (`from @AgentName:` pattern); code rarely contains this |
| AgentCoordinator regression | No changes to AgentCoordinator — additive only |
| Compression agent response doesn't contain usable summary | Fallback: Hub builds summary from ContextBus + last agent outputs |
| Compression during task dispatch | Skip compression for `buildTaskPrompt()` path — only applies to chat messages |
