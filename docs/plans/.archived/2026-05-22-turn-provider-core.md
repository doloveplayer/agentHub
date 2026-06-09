# Turn Provider Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-center AgentHub around explicit Agent turns and provider capability boundaries so named agents no longer depend on unstable REPL reuse, solo/group routing works, and Planner can produce executable task plans again.

**Architecture:** Introduce small, testable helpers for mention matching, session routing, provider policy, and Planner JSON extraction. Keep the existing WebSocket surface but route every agent execution through a one-turn execution boundary by default. Leave persistent REPL as a provider capability, but do not reuse it until a turn router exists.

**Tech Stack:** TypeScript, Hono, Prisma, WebSocket `ws`, existing Claude Code Docker runner, React/Zustand frontend, `npx tsx --test` for focused helper tests.

---

## File Structure

- Modify `apps/web/src/lib/mentionParser.ts`: make mention matching support display names and normalized aliases.
- Create `apps/api/src/agent/turns.ts`: pure helpers for default target selection, provider policy, and Planner plan extraction.
- Create `apps/api/src/agent/turns.test.ts`: focused tests for turn routing/policy/Planner parsing.
- Modify `apps/api/src/agent/ClaudeCodeProcess.ts`: make `trustMode` control `--dangerously-skip-permissions`.
- Modify `apps/api/src/agent/providers/claude-code.ts`: expose provider as non-persistent until a turn router exists.
- Modify `apps/api/src/ws/handler.ts`: disable REPL reuse from the main path, use turn helpers, restore solo CodeAgent routing and Planner plan parsing for named Planner.
- Modify `apps/api/src/index.ts`: clean stale `agenthub-repl-*` containers as a safety net.

## Task 1: Mention Parser Alias Support

- [ ] Add tests in `apps/api/src/agent/turns.test.ts` for normalized matching behavior that mirrors frontend mention parsing: `@CodeAgent`, `@code-agent`, and `@code` all identify the same agent.
- [ ] Run `npx tsx --test apps/api/src/agent/turns.test.ts`; expected failure because helper does not exist yet.
- [ ] Implement `normalizeAgentHandle()` and `matchAgentByHandle()` in `apps/api/src/agent/turns.ts`.
- [ ] Update `apps/web/src/lib/mentionParser.ts` to use the same normalization logic locally.
- [ ] Re-run `npx tsx --test apps/api/src/agent/turns.test.ts`; expected pass.

## Task 2: Explicit Default Agent Routing

- [ ] Add tests for `selectDefaultAgent()`:
  - solo sessions pick the session's only active agent, preferring `code-agent`;
  - group sessions pick `planner` when no explicit mention exists;
  - missing Planner falls back to the first available session agent.
- [ ] Run focused tests and verify they fail before implementation.
- [ ] Implement `selectDefaultAgent(sessionType, sessionAgents, allAgents)` in `apps/api/src/agent/turns.ts`.
- [ ] Update `apps/api/src/ws/handler.ts` so no-mention chat calls this helper instead of always forcing Planner.
- [ ] Preserve existing REST `/chat/send` response shape; only update the placeholder `agentId` in the WebSocket fallback if REST created it as null.

## Task 3: Provider Policy and Trust Mode

- [ ] Add tests for `buildClaudePrintArgs()`:
  - `trustMode=true` includes `--dangerously-skip-permissions`;
  - `trustMode=false` does not include it;
  - one-shot is the default execution strategy.
- [ ] Run focused tests and verify they fail.
- [ ] Modify `ClaudeCodeProcess.start()` command construction to respect `trustMode`.
- [ ] Change `ClaudeCodeProvider.capabilities.persistentSession` to `false` for now.
- [ ] Remove the fake one-shot permission request generated from `tool_use` when `trustMode=false`; only real provider `permission_request` events should render blocking cards.

## Task 4: Planner Plan Extraction on Named Agent Path

- [ ] Add tests for `extractPlannerPlan()`:
  - parses fenced ```json output with `tasks`;
  - parses plain JSON with `tasks`;
  - returns null for normal chat text.
- [ ] Run focused tests and verify they fail.
- [ ] Implement `extractPlannerPlan(content)` and `toTaskStates(plan, planId)` in `apps/api/src/agent/turns.ts`.
- [ ] Update the named-agent event path in `ws/handler.ts` so when `isPlannerAgent && exitCode === 0`, it broadcasts `plan_result` before `stream_end`.
- [ ] Keep Planner chat text visible; do not strip all content just because a plan exists.

## Task 5: Turn Cleanup and Container Safety

- [ ] Remove the REPL process reuse branch from `ws/handler.ts` or guard it behind a disabled constant named `ENABLE_PERSISTENT_REPL = false`.
- [ ] Ensure each started turn increments `runningAgentCount` once and decrements it on done, error, timeout, and stop.
- [ ] Update startup cleanup to remove `agenthub-repl-*` containers.
- [ ] Keep `agentProcesses` cleanup code harmless for existing stale maps, but no new turn should register there while persistent REPL is disabled.

## Task 6: Verification

- [ ] Run `npx tsx --test apps/api/src/agent/turns.test.ts`; expected pass.
- [ ] Run `npx tsc --noEmit -p apps/api/tsconfig.json`; expected pass.
- [ ] Run `npx tsc --noEmit -p apps/web/tsconfig.json`; expected pass.
- [ ] Inspect `git diff --check`; expected no whitespace errors.
- [ ] Review scope: no Prisma migration, no `.env`, no `package-lock.json`, no unrelated UI redesign.

## Deferred Work

- Persistent REPL turn queue and true multi-turn session reuse.
- Provider database field and multi-provider UI.
- Mailbox persistence and Agent-to-Agent structured protocol.
- Workspace snapshot/diff/file locks.
- BullMQ dependency enforcement beyond Planner plan emission.
