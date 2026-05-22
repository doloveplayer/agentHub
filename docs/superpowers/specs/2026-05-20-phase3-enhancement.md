# AgentHub Phase 3 — Enhancement & Polish Design (Tier 2)

> Status: Draft · Date: 2026-05-20

## Key Decisions

1. **Result aggregation via git diff**: After all tasks complete, run `git diff --stat` in sandbox to collect file change list. Generate summary card with change inventory and diff entry point.
2. **StateTracker as in-memory snapshot store**: Not Redis-backed (defer to Phase 4). In-memory Map keyed by agentMessageId, updated on each event, throttled to 500ms push intervals. Sufficient for single-server deployment.
3. **PTY permission via Tty:true**: Swap Docker exec from `Tty:false` to `Tty:true` to make Claude Code believe it's in an interactive terminal. Parse ANSI-escaped JSON events from TTY stdout.

## Architecture

```
Result Aggregation:
  TaskQueue onPlanComplete → execCapture("git diff --stat") → buildSummaryCard
  → WS result_summary → frontend renders summary bubble with file list + "View Diff" placeholder

StateTracker:
  onEvent callback → StateTracker.update*(agentMessageId, ...)
  → every 500ms: throttle push agent_status snapshot to WS
  → AgentCard renders: token bar, thinking level, opened files

PTY Permission:
  ClaudeCodeProcess.start({ trustMode: false })
  → Docker exec Tty:true → Claude Code thinks it's interactive
  → emits permission_request JSON events → EventParser → WS → PermissionCard
  → user Allow/Deny → write("y\n") via /proc/pid/fd/0
```

## File Structure

```
apps/api/src/agent/
  StateTracker.ts          # AgentSnapshot, getOrCreate, update* methods
  ClaudeCodeProcess.ts     # [modified] Tty:true + ANSI output parsing
  SandboxManager.ts        # [modified] PTY mode support

apps/web/src/components/
  AgentCard.tsx            # [modified] token bar, thinking level display
  ChatView.tsx             # [modified] summary report bubble rendering
```

## Key Interfaces

```
AgentSnapshot {
  agentMessageId, status, currentTool?, currentToolInput?,
  openedFiles[], tokenUsage?, thinkingLevel?,
  subAgents[], updatedAt
}
```

## Summary Card Schema

```
SummaryReport {
  planId, planTitle,
  total: number, completed: number, failed: number,
  fileChanges: string[],         // from git diff --stat
  summary: string,
  diffEntryUrl?: string           // Phase 4 Diff view deep link
}
```

## Verification

- [ ] Result summary card shows correct file change count (deferred to Phase 3 Tier 2)
- [ ] StateTracker updates reflect in AgentCard within 500ms (backend ready, frontend pending)
- [ ] Token usage bar renders when system events received (StateTracker.updateTokenUsage never called)
- [ ] PTY mode Claude Code emits permission_request events (blocked by Claude Code CLI #10)
- [ ] Allow/Deny response reaches Claude Code via stdin (blocked by Claude Code CLI #10)
