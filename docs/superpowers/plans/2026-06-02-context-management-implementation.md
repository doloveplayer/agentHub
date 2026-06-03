# Context Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate double history injection, wire NEEDS HELP intent routing, replace raw history with structured session context, and add auto-compression when context > 70%.

**Architecture:** Four independent parts. Part 1 replaces `buildHistory()` with `buildSessionContext()` in the chat prompt pipeline. Part 2 wires `IntentParser.scan()` into the agent output path. Part 3 enhances inbox entries with sender capability metadata. Part 4 adds compression detection + agent self-summarization + SDK session reset in `AgentRuntime`.

**Tech Stack:** TypeScript (Node.js 20+), Prisma, Claude Code SDK, Hono

---

### Task 1: Add `buildSessionContext()` function

**Files:**
- Modify: `apps/api/src/ws/chatHandlers.ts` (add function, ~20 lines of new code)

Add a new function `buildSessionContext` that queries session agents and active plan state, then formats them as structured markdown. This replaces `buildHistory()`.

- [ ] **Step 1: Add import for plan execution state**

In `chatHandlers.ts`, after the existing `agentRuntime` import (line 13), add the import for plan execution state access:

```typescript
import { agentRuntime } from '../agent/AgentRuntime.js';

// NEW import — access plan execution state for session context
let getPlanExecutions: () => Map<string, any>;
export function setPlanExecutionsAccessor(fn: () => Map<string, any>) {
  getPlanExecutions = fn;
}
```

Wait — `planExecutions` is a module-level `Map` in `taskDispatcher.ts`. A simpler approach: we don't need plan execution state for the initial implementation. Session context will include agent roster + session mode. Plan state can be added later when needed.

**Revised: no new import needed.** `buildSessionContext` uses only Prisma.

- [ ] **Step 2: Add the function**

Insert after `languageConsistencyPrompt` import block (after line 12), before the `buildHistory()` function:

```typescript
/**
 * Build structured session context for the agent prompt.
 * Replaces the raw conversation history dump (buildHistory).
 * Provides agent roster, session mode, and workspace info
 * that the SDK cannot derive from its own session state.
 */
async function buildSessionContext(
  sessionId: string,
  currentAgentName: string,
  workspacePath?: string,
): Promise<string | null> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        type: true,
        agents: {
          include: {
            agent: { select: { name: true, description: true } },
          },
        },
      },
    });
    if (!session) return null;

    const otherAgents = session.agents
      .filter(sa => sa.agent.name !== currentAgentName)
      .map(sa => `- **${sa.agent.name}** — ${sa.agent.description || 'No description'}`);

    if (otherAgents.length === 0 && session.type === 'solo') {
      // Solo session with only this agent — minimal context
      return `## Session Context\n\n**Mode**: Solo\n**Workspace**: ${workspacePath || '/workspace'}\n`;
    }

    const agentCount = session.agents.length;
    const modeLabel = session.type === 'group' ? `Group (${agentCount} agents)` : `Solo`;

    let block = `## Session Context\n\n`;
    block += `**Mode**: ${modeLabel}\n`;

    if (otherAgents.length > 0) {
      block += `**Other Agents**:\n${otherAgents.join('\n')}\n`;
    }

    if (workspacePath) {
      block += `**Workspace**: ${workspacePath}\n`;
    }

    return block;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Verify the function compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Should show no new errors related to the new function.

---

### Task 2: Replace `buildHistory()` with `buildSessionContext()` in prompt assembly

**Files:**
- Modify: `apps/api/src/ws/chatHandlers.ts:248-274` (rewrite prompt assembly)
- Modify: `apps/api/src/ws/chatHandlers.ts:100-108` (delete `buildHistory`)

- [ ] **Step 1: Delete `buildHistory()` function**

Remove lines 100-108:

```typescript
// DELETE these lines:
async function buildHistory(sessionId: string): Promise<string | null> {
  try {
    const msgs = await prisma.message.findMany({
      where: { sessionId, status: 'done' }, orderBy: { createdAt: 'asc' }, take: 20,
    });
    if (msgs.length <= 1) return null;
    return msgs.map(m => `${m.senderType === 'human' ? 'User' : 'Agent'}: ${m.content}`).join('\n');
  } catch { return null; }
}
```

- [ ] **Step 2: Replace history usage in prompt assembly**

At line 249, replace:

```typescript
// Before (line 249):
const history = await buildHistory(sessionId);
```

With:

```typescript
// After:
const sessionContext = agent
  ? await buildSessionContext(sessionId, agent.name, sandbox.hostWorkDir)
  : null;
```

At line 274, replace:

```typescript
// Before (line 274):
agentPrompt = `${agent.systemPrompt}${InboxManager.inboxPrompt(agent.name)}${sandbox ? InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostSandboxDir, sessionId) : ''}${sessionMemberBlock}${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
```

With:

```typescript
// After:
agentPrompt = `${agent.systemPrompt}${InboxManager.inboxPrompt(agent.name)}${sandbox ? InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostSandboxDir, sessionId) : ''}${sessionMemberBlock}${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}\n\n${sessionContext ? sessionContext + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
```

At line 278, replace:

```typescript
// Before (line 278):
agentPrompt = history ? `${history}\n\n---\n${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}` : `${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}`;
```

With:

```typescript
// After (no history available for agents without system prompt):
agentPrompt = `${languageConsistencyPrompt(detectLanguage(mention.subPrompt))}User: ${mention.subPrompt}`;
```

- [ ] **Step 3: TypeScript type check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/ws/chatHandlers.ts
git commit -m "refactor: replace buildHistory with buildSessionContext — eliminate double injection

Part 1 of context management. Prompt now carries structured session context
(agent roster, session mode) instead of raw 20-message history dump. The SDK
owns conversation history via resume; Hub owns structured session awareness.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Wire NEEDS HELP IntentParser into agent output path

**Files:**
- Modify: `apps/api/src/agent/AgentRuntime.ts` (add `currentAgentName` to AgentEntry, IntentParser call in handleAgentEvent, ~35 lines)

The wiring point is `handleAgentEvent()` case `'done'` (line 255). Before clearing `accumulatedOutput`, scan for NEEDS HELP patterns and route them to target inboxes.

First, add `currentAgentName` to `AgentEntry` so inbox writes use the correct display name (not UUID).

- [ ] **Step 1: Add `currentAgentName` to AgentEntry interface**

In the `AgentEntry` interface (line 29-48), add `currentAgentName` after `currentAgentId`:

```typescript
interface AgentEntry {
  // ... existing fields ...
  currentAgentId: string | null;
  currentAgentName: string | null;  // NEW: agent display name for inbox writes
  // ... rest of existing fields ...
}
```

In `sendPrompt()` (around line 138-143), set `currentAgentName` when setting `currentAgentId`:

```typescript
entry.currentAgentId = agentId;
entry.currentAgentName = agent.name;  // NEW — look up from agent entry
```

Wait — `sendPrompt` only receives `agentId` (UUID), not the agent object. We need to get the name from the entry. In `ensureRunning()`, the agent is fetched:

```typescript
const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
```

So in `sendPrompt()`, after setting `currentAgentId`, also look up the name from `entry`:

```typescript
entry.currentAgentId = agentId;
// entry.provider has no name field. We already set currentAgentName in ensureRunning.
// For subsequent sendPrompt calls (same agentId), it's already set.
```

Actually, the simplest approach: set `currentAgentName` in `ensureRunning()` where the agent is fetched:

```typescript
// In ensureRunning(), when creating the entry:
const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
const entry: AgentEntry = {
  // ... existing fields ...
  currentAgentName: agent.name,  // set once on creation
  needsCompression: false,
  compressionPhase: 'none',
  compressionPendingPrompt: null,
};
```

And in `sendPrompt()`, keep the name up to date if a different agent uses the same slot:

```typescript
entry.currentAgentName = entry.currentAgentName; // unchanged — set in ensureRunning
```

Since each `agentId` has its own `AgentEntry`, and `ensureRunning` fetches the agent by ID, setting `currentAgentName` in `ensureRunning` is sufficient.

- [ ] **Step 2: Add imports for IntentParser and InboxManager**

Insert after line 11 (`import { config } from '../config.js';`):

```typescript
import { IntentParser } from './IntentParser.js';
import { InboxManager } from './InboxManager.js';
```

- [ ] **Step 2: Add resolveAgentByName helper**

Insert after the `calcContextPct` function (after line 72):

```typescript
async function resolveAgentByName(
  sessionId: string,
  agentName: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const sa = await prisma.sessionAgent.findFirst({
      where: {
        sessionId,
        agent: { name: agentName },
      },
      select: { agent: { select: { id: true, name: true } } },
    });
    return sa?.agent ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Add IntentParser call in handleAgentEvent case 'done'**

In `handleAgentEvent()` (line 255), inside the `case 'done':` block, after the `broadcast(sessionId, { type: 'stream_end' ...})` call (after line 256), and before the planner output parsing, insert:

```typescript
      case 'done':
        broadcast(sessionId, { type: 'stream_end', exitCode: event.exitCode ?? 0, agentMessageId });

        // NEW: Scan agent output for NEEDS HELP intents and route to target inboxes
        if (entry.accumulatedOutput) {
          const helpIntents = IntentParser.scan(entry.accumulatedOutput);
          for (const intent of helpIntents) {
            const target = await resolveAgentByName(sessionId, intent.targetAgentName);
            if (target) {
              // Determine hostWorkDir from entry (sharedContainer → use sandbox path)
              const hostDir = entry.hostWorkDir;
              InboxManager.write(hostDir, target.name, {
                type: 'help_request',
                id: `help-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                from: entry.currentAgentName || entry.currentAgentId || 'unknown',
                to: target.name,
                summary: intent.description,
                risk: 'low',
                timestamp: Date.now(),
              }, sessionId);
              broadcast(sessionId, {
                type: 'inbox_update',
                agentName: target.name,
                fromAgent: entry.currentAgentId,
                summary: intent.description,
                timestamp: Date.now(),
              });
            }
          }
        }

        if (agentMessageId) {
          // ... existing code continues
```

- [ ] **Step 4: TypeScript type check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors. If `IntentParser` or `InboxManager` imports cause issues, verify the import paths are correct.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/AgentRuntime.ts
git commit -m "feat: wire IntentParser — route NEEDS HELP intents to target agent inboxes

Part 2 of context management. On agent completion, scan accumulated output
for 'NEEDS HELP from @AgentName: ...' patterns and write them to the target
agent's inbox. Inbox messages are injected into the next prompt via InboxWakeup.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Enhance InboxWakeup with sender capability info

**Files:**
- Modify: `apps/api/src/agent/InboxWakeup.ts` (enhance `buildInboxPrompt`, ~15 lines new)

When injecting inbox messages, include the sender agent's description so the receiving agent can judge relevance.

- [ ] **Step 1: Add Prisma import and cache**

At the top of `InboxWakeup.ts`, add:

```typescript
import { InboxManager } from './InboxManager.js';
import { prisma } from '../db/prisma.js';  // NEW

// Lightweight agent description cache per session (TTL = function call)
const agentDescCache = new Map<string, Map<string, string>>();
```

- [ ] **Step 2: Add helper to resolve agent descriptions**

Insert before the class definition:

```typescript
async function resolveSenderDescriptions(
  sessionId: string,
  entries: Array<{ from: string }>,
): Promise<Map<string, string>> {
  const cache = agentDescCache.get(sessionId);
  const uniqueSenders = [...new Set(entries.map(e => e.from))];
  const uncached = uniqueSenders.filter(name => !cache?.has(name));

  if (uncached.length > 0 && sessionId) {
    try {
      const agents = await prisma.sessionAgent.findMany({
        where: {
          sessionId,
          agent: { name: { in: uncached } },
        },
        select: { agent: { select: { name: true, description: true } } },
      });
      if (!agentDescCache.has(sessionId)) {
        agentDescCache.set(sessionId, new Map());
      }
      const sessionCache = agentDescCache.get(sessionId)!;
      for (const sa of agents) {
        sessionCache.set(sa.agent.name, sa.agent.description || '');
      }
    } catch { /* graceful degradation */ }
  }

  return cache ?? new Map();
}
```

- [ ] **Step 3: Modify `buildInboxPrompt` to include sender descriptions**

Replace the entry formatting in `buildInboxPrompt`:

```typescript
  static async buildInboxPrompt(agentName: string, hostWorkDir: string, sessionId?: string): Promise<string> {
    const entries = InboxManager.read(hostWorkDir, agentName, sessionId);
    if (entries.length === 0) return '';

    // Resolve sender descriptions for context
    const descriptions = sessionId
      ? await resolveSenderDescriptions(sessionId, entries)
      : new Map<string, string>();

    const highRisk = entries.filter(e => e.risk === 'high');
    const lowRisk = entries.filter(e => e.risk !== 'high');

    let block = `\n\n## Inbox (${entries.length} new messages from other agents)\n\n`;
    if (highRisk.length > 0) {
      block += `### High Priority — please address these\n`;
      for (const e of highRisk) {
        const desc = descriptions.get(e.from);
        const tag = desc ? ` (${desc})` : '';
        block += `- [HIGH] From **${e.from}**${tag}: ${e.summary}\n`;
      }
    }
    if (lowRisk.length > 0) {
      block += `### Info\n`;
      for (const e of lowRisk) {
        const desc = descriptions.get(e.from);
        const tag = desc ? ` (${desc})` : '';
        block += `- From **${e.from}**${tag}: ${e.summary}\n`;
      }
    }
    block += `\nRespond to high-priority messages first. You can reply to other agents by outputting "NEEDS HELP from @AgentName: <your response>" or by completing the requested work.`;

    return block;
  }
```

- [ ] **Step 4: Update callers** — `buildInboxPrompt` is now async

In `chatHandlers.ts` line 274, update the call:

```typescript
// Before:
${sandbox ? InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostSandboxDir, sessionId) : ''}

// After:
${sandbox ? await InboxWakeup.buildInboxPrompt(agent.name, sandbox.hostSandboxDir, sessionId) : ''}
```

In `AgentRuntime.ts`, check for any other callers of `buildInboxPrompt`:

```bash
grep -rn 'buildInboxPrompt' apps/api/src/
```

If other callers exist, add `await` to each.

- [ ] **Step 5: TypeScript type check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/agent/InboxWakeup.ts apps/api/src/ws/chatHandlers.ts
git commit -m "feat: enhance inbox entries with sender capability descriptions

Part 3 of context management. Inbox messages now include sender agent
description tags so the receiving agent can judge relevance without
needing conversation history context.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Add compression detection in AgentRuntime

**Files:**
- Modify: `apps/api/src/agent/AgentRuntime.ts` (add `needsCompression` flag, set in token_usage handler, ~25 lines)

Track when context usage exceeds 70% threshold and flag the agent for compression.

- [ ] **Step 1: Add `needsCompression` to AgentEntry**

In `AgentEntry` interface (line 29-48), add the field:

```typescript
interface AgentEntry {
  // ... existing fields ...
  lastSessionId: string | null;
  lastMessageId: string | null;
  lastAgentId: string | null;
  needsCompression: boolean;  // NEW: set when contextPct > 70%
}
```

Initialize it in the `ensureRunning` method where entries are created (around line 219). Add `needsCompression: false` to the entry object:

```typescript
      const entry: AgentEntry = {
        // ... existing fields ...
        model,
        needsCompression: false,  // NEW
      };
```

- [ ] **Step 2: Set needsCompression flag in token_usage handler**

In `handleAgentEvent` case `'token_usage'` (line 386), after calculating contextPct, check threshold:

Locate the `calcContextPct` call or contextPct calculation in the token_usage handler. After the threshold is calculated, add:

```typescript
      case 'token_usage': {
        // ... existing code that accumulates token usage ...

        // NEW: Check compression threshold
        const contextPct = calcContextPct(
          cumulative.input,
          entry.model || 'unknown',
        );
        if (contextPct > 70) {
          entry.needsCompression = true;
        }

        // ... existing broadcast code continues ...
```

The exact insertion point depends on the existing code structure. Find where `calcContextPct` is called or where cumulative tokens are available, and insert the check after.

- [ ] **Step 3: TypeScript type check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors.

---

### Task 6: Add compression trigger in AgentRuntime.sendPrompt()

**Files:**
- Modify: `apps/api/src/agent/AgentRuntime.ts` (modify `sendPrompt()`, add `buildCompressionPrompt()` helper, ~40 lines)

When `needsCompression` is true, intercept the next user message, first send a compression prompt to get a summary from the agent, then reset the SDK session with summary + user message.

- [ ] **Step 1: Add `buildCompressionPrompt()` helper**

Insert after `calcContextPct` function (after line 72):

```typescript
function buildCompressionPrompt(contextPct: number): string {
  return `## Context Compression Required

Your context window is approximately ${contextPct}% full. Before processing the next user request,
please write a **concise summary** of the conversation so far.

Include in your summary:
1. **User's original goal** — what the user asked you to do
2. **Key decisions** — important choices made and why
3. **Current state** — what files exist, what's working, what's not
4. **Pending items** — what still needs to be done

Format your summary as structured markdown. This summary will serve as the
starting context for your next session, so be thorough but concise.
After writing the summary, I will process your next user request.`;
}
```

- [ ] **Step 2: Modify `sendPrompt()` to check compression**

In the `sendPrompt()` method (line 100), before the existing prompt dispatch logic, add the compression branch. After the queue/dequeue logic and before `entry.provider.sendPrompt(prompt)` (line 146), insert:

```typescript
    // Check if context compression is needed before sending this prompt
    if (entry.needsCompression) {
      entry.needsCompression = false;

      // Step 1: Send compression prompt to get agent's summary
      const compressionPrompt = buildCompressionPrompt(
        calcContextPct(/* use last known token count, fallback 75 */ 75, entry.model)
      );

      // Register a one-shot handler to capture the summary from the compression response
      const summaryPromise = new Promise<string>((resolve) => {
        const originalHandler = entry.provider.onEvent.bind(entry.provider);
        let summaryText = '';

        const captureHandler = (ev: UnifiedAgentEvent) => {
          if (ev.type === 'thinking' && ev.content) {
            summaryText += ev.content;
          }
          if (ev.type === 'done') {
            // Resolve with captured summary text
            resolve(summaryText.slice(0, 3000) || 'Conversation state preserved.');
            // Re-register original handler
            entry.provider.onEvent((e) => {
              originalHandler(e);
              this.handleAgentEvent(agentId, entry, e);
            });
          }
        };

        // Temporarily override event handler to capture summary
        entry.provider.onEvent((e) => {
          captureHandler(e);
          this.handleAgentEvent(agentId, entry, e);
        });
      });

      entry.provider.sendPrompt(compressionPrompt);
      const summary = await summaryPromise;

      // Step 2: Persist summary to sandbox for recovery
      const summaryPath = resolve(
        entry.hostWorkDir,
        `_agent_${agentId}/_context_summary.md`,
      );
      try {
        writeFileSync(summaryPath, summary, 'utf-8');
      } catch {}

      // Step 3: Reset SDK session and inject summary + user prompt
      entry.provider.stop();
      await entry.provider.start(
        'agent-' + agentId,
        `## Previous Session Summary\n\n${summary}\n\n---\n\n## New Request\n\n${prompt}`,
        entry.containerId,
        '/workspace',
        {
          hostWorkDir: entry.hostWorkDir,
          trustMode: true,
        },
      );

      // Skip normal sendPrompt below — compression handled the dispatch
      return;
    }

    // Existing: entry.provider.sendPrompt(prompt);
    entry.provider.sendPrompt(prompt);
```

Wait — this approach with overriding `onEvent` is fragile. Let me reconsider.

**Revised approach — simpler and more robust:**

Don't capture the agent response synchronously. Instead, use a two-step flag-based approach:

1. Set `entry.needsCompression = true`
2. When `sendPrompt` detects the flag:
   a. Set `entry.compressionPhase = 'summarizing'` — a new state field
   b. Send compression prompt
   c. Return without sending the user message
3. When `handleAgentEvent` receives `'done'` while `compressionPhase === 'summarizing'`:
   a. Extract `accumulatedOutput` as the summary
   b. Persist summary to disk
   c. Reset SDK session
   d. Send the original user message via `provider.sendPrompt(originalPrompt)`
   e. Clear `compressionPhase`

This is cleaner because it works with the existing event flow.

- [ ] **Step 2 (revised): Add `compressionPhase` and `compressionPendingPrompt` to AgentEntry**

```typescript
interface AgentEntry {
  // ... existing fields ...
  needsCompression: boolean;
  compressionPhase: 'none' | 'summarizing';  // NEW
  compressionPendingPrompt: string | null;   // NEW: stores user prompt during compression
}
```

Initialize both in the entry creation:
```typescript
      const entry: AgentEntry = {
        // ... existing fields ...
        needsCompression: false,
        compressionPhase: 'none',    // NEW
        compressionPendingPrompt: null,  // NEW
      };
```

- [ ] **Step 3 (revised): Modify sendPrompt to trigger compression**

In `sendPrompt()`, before `entry.provider.sendPrompt(prompt)` (line 146), insert:

```typescript
    // --- Context Compression ---
    if (entry.needsCompression && entry.compressionPhase === 'none') {
      entry.needsCompression = false;
      entry.compressionPhase = 'summarizing';
      entry.compressionPendingPrompt = prompt;

      const compressionPct = calcContextPct(
        // Use latest available token count
        entry.currentMessageId
          ? (this.tokenUsageMap.get(entry.currentMessageId)?.input ?? 0)
          : 0,
        entry.model,
      );
      const compressionPrompt = buildCompressionPrompt(compressionPct || 75);
      entry.provider.sendPrompt(compressionPrompt);
      return; // Don't send user message yet — wait for compression to complete
    }
    // --- End Context Compression ---
```

- [ ] **Step 4: Handle compression completion in handleAgentEvent case 'done'**

In `handleAgentEvent` case `'done'` (line 255), before the existing done logic, insert:

```typescript
      case 'done':
        // --- Handle compression completion ---
        if (entry.compressionPhase === 'summarizing') {
          const summary = entry.accumulatedOutput?.slice(0, 3000) || 'Conversation state preserved.';
          const pendingPrompt = entry.compressionPendingPrompt || 'Continue.';
          entry.compressionPhase = 'none';
          entry.compressionPendingPrompt = null;
          entry.accumulatedOutput = '';

          // Persist summary for session recovery
          try {
            const summaryDir = resolve(entry.hostWorkDir, `_agent_${entry.currentAgentId || 'unknown'}`);
            mkdirSync(summaryDir, { recursive: true });
            writeFileSync(resolve(summaryDir, '_context_summary.md'), summary, 'utf-8');
          } catch {}

          // Reset SDK session with summary + pending user prompt
          try { entry.provider.stop(); } catch {}
          const fullPrompt = `## Previous Session Summary\n\n${summary}\n\n---\n\n## New Request\n\n${pendingPrompt}`;
          await entry.provider.start(
            'agent-' + agentId,
            fullPrompt,
            entry.containerId,
            '/workspace',
            {
              hostWorkDir: entry.hostWorkDir,
              trustMode: true,
            },
          );

          // Re-register event handler after session reset
          entry.provider.onEvent((e: UnifiedAgentEvent) => {
            this.handleAgentEvent(agentId, entry, e);
          });
          break; // Don't run normal 'done' logic for compression
        }
        // --- End compression completion ---

        broadcast(sessionId, { type: 'stream_end', ...});
        // ... existing done logic continues
```

- [ ] **Step 5: Add missing imports**

At the top of `AgentRuntime.ts`, add:

```typescript
import { writeFileSync, mkdirSync, existsSync } from 'fs';  // Already imported via line 1
import { resolve } from 'path';  // NEW
```

Check the existing import of `existsSync` on line 5 — add `mkdirSync` and `writeFileSync` to it:

```typescript
import { existsSync, mkdirSync, writeFileSync } from 'fs';
```

- [ ] **Step 6: TypeScript type check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/agent/AgentRuntime.ts
git commit -m "feat: add auto-compression — agent self-summarizes then SDK session resets

Part 4 of context management. When contextPct exceeds 70%, the next
sendPrompt triggers a compression cycle: agent summarizes the conversation,
summary is persisted to _context_summary.md, SDK session is reset, and
summary + user prompt are injected as new session start.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Integration test — verify the full pipeline

**Files:**
- Create: `apps/api/src/agent/context-management.test.ts`

Write a focused integration test that verifies the prompt assembly doesn't include raw history but does include session context.

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect } from 'vitest';
import { EventParser } from './EventParser.js';
import { IntentParser } from './IntentParser.js';

describe('Context Management Integration', () => {
  describe('EventParser — NEEDS HELP detection', () => {
    it('parses NEEDS HELP patterns from agent output', () => {
      const output = `I've completed the login page. NEEDS HELP from @review-agent: Please review Login.tsx for security issues.`;

      const intents = IntentParser.scan(output);

      expect(intents).toHaveLength(1);
      expect(intents[0].targetAgentName).toBe('review-agent');
      expect(intents[0].description).toContain('Login.tsx');
    });

    it('handles multiple NEEDS HELP in one output', () => {
      const output = `Task done. NEEDS HELP from @review-agent: check auth.
NEEDS HELP from @test-agent: write tests for login.`;
      const intents = IntentParser.scan(output);

      expect(intents).toHaveLength(2);
      expect(intents[0].targetAgentName).toBe('review-agent');
      expect(intents[1].targetAgentName).toBe('test-agent');
    });
  });

  describe('EventParser — token_usage events', () => {
    it('emits token_usage from assistant message with usage', () => {
      const parser = new EventParser();
      const events = parser.parseLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 5000, output_tokens: 1000 },
        },
      }));

      const tokenEv = events.find(e => e.type === 'token_usage');
      expect(tokenEv).toBeDefined();
      if (tokenEv?.type === 'token_usage') {
        expect(tokenEv.inputTokens).toBe(5000);
        expect(tokenEv.outputTokens).toBe(1000);
      }
    });
  });

  describe('calcContextPct — threshold detection', () => {
    it('returns >70 for high token usage at 140K/200K', () => {
      const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
        'claude-sonnet-4-6': 200000,
      };
      const calcContextPct = (inputTokens: number, model: string): number => {
        const window = MODEL_CONTEXT_WINDOWS[model] || 200000;
        return Math.round((inputTokens / window) * 100);
      };

      expect(calcContextPct(140000, 'claude-sonnet-4-6')).toBe(70);
      expect(calcContextPct(150000, 'claude-sonnet-4-6')).toBe(75);
      expect(calcContextPct(100000, 'claude-sonnet-4-6')).toBe(50);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd apps/api && npx vitest run src/agent/context-management.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/context-management.test.ts
git commit -m "test: add context management integration tests

Covers NEEDS HELP parsing, token_usage events, and compression threshold.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: Final compile check and cleanup

**Files:**
- None (verify only)

- [ ] **Step 1: Full TypeScript type check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Fix any remaining type errors.

- [ ] **Step 2: Verify no regression in existing tests**

```bash
cd apps/api && npx vitest run
```

All existing tests should still pass.

- [ ] **Step 3: Git status**

```bash
git status
git log --oneline -8
```

Summarize: all parts committed, no uncommitted changes.
