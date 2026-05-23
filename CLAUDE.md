# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AgentHub is an IM-style web chat app that manages multiple Claude Code instances inside Docker sandboxes. Users log in via GitHub OAuth, create sessions (solo or group), and chat with Claude Code agents through a WebSocket-driven streaming interface. Each session gets an isolated Docker container with a bind-mounted workspace directory at `.sandboxes/{sessionId}/`.

### Core design philosophy

AgentHub is a **message forwarding and input injection layer** — nothing more. It does NOT implement agent architecture, agent-to-agent communication protocols, or multi-agent collaboration logic. Those belong to the underlying CLI tools (Claude Code, Codex, OpenCode, etc.).

What AgentHub does:
- **Message routing**: user message → parse @mentions → deliver sub-prompt to the right agent instance
- **Input injection**: write prompt to agent stdin, stream stdout back to the frontend
- **Session management**: Docker sandbox lifecycle, WebSocket multiplexing, message persistence

What AgentHub does NOT do:
- Agent architecture (spawning, tool execution, planning) — that's the CLI tool's job
- Agent-to-agent communication — agents don't talk to each other; they only receive prompts from the hub and respond to the user
- Multi-agent orchestration — no DAG scheduling, no result aggregation, no inter-agent dependency resolution (those are Phase 3 features implemented by a dedicated Planner agent, not by AgentHub itself)

In short: AgentHub is a **dumb pipe with a chat UI**. The intelligence lives in the agents, not in the hub.

## Commands

```bash
# Start PostgreSQL
docker compose up -d postgres

# Build sandbox image (after Dockerfile changes)
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# Prisma migrate (project root — .env must export DATABASE_URL)
export $(grep -v '^#' .env | grep -v '^$' | xargs) && cd apps/api && npx prisma migrate dev --name init

# Backend (port 3000)
cd apps/api && npx tsx src/index.ts

# Frontend (port 5173, proxies /api and /ws to backend)
cd apps/web && npx vite

# TypeScript check
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# Force stop
fuser -k 3000/tcp  # backend
fuser -k 5173/tcp  # frontend

# Cleanup orphaned sandboxes
docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null
rm -rf .sandboxes/*

# Git push (HTTPS blocked by GFW — use SSH)
git remote set-url origin git@github.com:doloveplayer/agentHub.git
```

## Architecture

### Data flow (single agent)

```
Browser (React) → POST /api/chat/send → DB (user + agent placeholder messages)
Browser → WebSocket /ws → backend spawns Claude Code inside Docker container
Claude Code stdout → EventParser → WebSocket → Browser renders stream chunks
Agent done → DB updated with final content
```

### Data flow (multi-agent with @mentions)

```
Browser → parse @agent from text (mentionParser.ts) → POST /api/chat/send with mentions[]
  → DB creates 1 user msg + N agent placeholder msgs (each with agentId)
  → WebSocket sends { type: 'chat', mentions: [{ agentId, subPrompt, messageId }] }
  → Backend spawns N Claude Code instances IN PARALLEL inside same Docker container
  → Each instance: systemPrompt + history + subPrompt → Claude Code CLI
  → Per-agent prompt file `_prompt_{messageId}.txt` (prevents parallel overwrite)
  → stdout → EventParser → agent_status + stream_chunk → WebSocket multiplexed by agentMessageId
  → Frontend routes stream chunks to correct MessageBubble; tool events to correct AgentCard
```

### / command passthrough

```
Input starts with "/" → backend skips mention parsing + system prompt injection
  → raw prompt forwarded to Claude Code (Claude handles /commands natively)
```

### Key boundaries

| Layer | Tech | Responsibility |
|-------|------|----------------|
| `apps/web` | React 18 + Vite + Tailwind + Zustand + Inter font | Chat UI, session list, streaming display, @mentions, agent status panel, GitHub OAuth callback |
| `apps/api` | Hono + @hono/node-server | REST routes (`/api/auth`, `/api/sessions`, `/api/chat`, `/api/agents`), JWT auth, WebSocket handler |
| `apps/api/src/agent/` | Dockerode | Sandbox lifecycle, Claude Code exec inside Docker, env filtering, stream-json parsing, cross-frame line buffering |
| `packages/shared` | TypeScript interfaces | `User`, `Session`, `Message`, `AgentConfig`, `Mention`, `SendRequest`, `SendResponse` |
| `docker/` | Dockerfile + compose | Sandbox image (`node:20-slim` + claude-code, `node` user), PostgreSQL, Redis |

### Database (Prisma + PostgreSQL)

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `User` | id, githubId, login, avatarUrl | GitHub OAuth |
| `Session` | id, userId, type ("solo"\|"group"), sandboxContainerId | FK→User |
| `SessionAgent` | sessionId, agentId | Join table, cascade delete |
| `Message` | id, sessionId, senderType, agentId, content, status | status: sending/streaming/done/error |
| `Agent` | id, name, displayName, description, systemPrompt, isActive | 3 defaults seeded at startup |

### Claude Code integration

- Runs **inside Docker** via `docker exec`, `cwd=/workspace`, `--print --output-format stream-json --verbose --dangerously-skip-permissions`
- **Prompt**: per-agent `_prompt_{messageId}.txt` written to hostWorkDir (bind-mounted), piped via `cat file | claude`
- **Auth**: Only 3 vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) written to `_env.sh`, sourced before claude
- **Env filter** (`buildSafeEnv()`): Whitelist prefixes (`ANTHROPIC_`, `CLAUDE_`, `PATH`, `HOME`, `NVM_`, `LANG`, `LC_`, `TERM`, `COLOR`, `TZ`, `DEBIAN_FRONTEND`) pass through. Blocklist suffixes (`_TOKEN`, `_SECRET`, `_KEY`, `_PASSWORD`) blocked for non-whitelisted vars. Host-specific `CLAUDE_CODE_SESSION_ID`/`SSE_PORT` excluded.
- **Line buffering**: `ClaudeCodeProcess.partialLine` accumulates across Docker multiplex frames to prevent split JSON lines from being lost
- **Permissions**: `--dangerously-skip-permissions` (trustMode=true). Container runs as `node` user (non-root). Permission proxy deferred to Phase 3.
- **Config** (`apps/api/src/config.ts`): `AGENT_TIMEOUT_MS` (default 5 min), `MAX_CONCURRENT_AGENTS` (default 5 global). Per-session max: 3.

### WebSocket message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `chat` | Client→Server | Send message with optional `mentions[]` and `trustMode` |
| `stream_chunk` | Server→Client | Text content appended to message bubble (by `agentMessageId`) |
| `stream_end` | Server→Client | Agent finished: `exitCode`, `fullContent`, `stopped` flag |
| `stream_error` | Server→Client | Agent error message |
| `agent_status` | Server→Client | Real-time event: `thinking`/`tool_use`/`tool_result`/`subagent_start`/`subagent_result` |
| `permission_request` | Server→Client | Permission needed (currently suppressed by trustMode) |
| `permission_response` | Client→Server | User allow/deny (routed to single agent only; multi-agent blocked) |
| `stop_agent` | Client→Server | Kill running agent by `agentMessageId` |
| `connected` | Server→Client | Connection confirmation |

### Startup sequence (`index.ts`)

1. `docker rm -f` all `agenthub-sandbox-*` containers (clean orphans)
2. `rm -rf .sandboxes/*` (clean host sandbox dirs)
3. Reset stale `streaming` messages to `done` in DB (prevent phantom running state)
4. Seed 3 default agents (upsert: code-agent, review-agent, devops-agent)
5. Mount routes + WebSocket + listen on port 3000

### Key patterns

- **Multi-agent state**: `Map<sessionId, Map<agentMessageId, { process, timer, agentId }>>` in `handler.ts`. Each agent tracked independently for timeout, stop, cleanup.
- **Agent defaults**: Shared in `apps/api/src/defaultAgents.ts`, imported by both `seed.ts` (standalone) and `index.ts` (startup seed).
- **Auth middleware** (`auth.ts`): Verifies JWT THEN checks user exists in DB (defense against DB resets). Returns 401 "User not found — please re-authenticate" if user missing.
- **WS connection** (`handler.ts`): Same user-existence check as REST auth middleware.
- **Frontend 401 handling** (`api.ts`): Any 401 response → clears `agenthub_token` from localStorage → redirects to `/login`.
- **Zustand store** (`appStore.ts`): `agents`, `streamingMessages`, `agentEvents` (with `thinking` type). Stable empty references (`EMPTY_MESSAGES`, `EMPTY_ARR`) to prevent infinite re-renders.
- **Agent Card activity feed**: Shows 💭thinking / 🔧tool_use / 📋tool_result / 🔀subagent events, last 20 entries, auto-scrolls while running.
- **Concurrency**: Per-session max 3 agents + global max from `config.agent.maxConcurrent`.
- **Group session auto-assign**: Creating group session without `agentIds` → backend assigns ALL active agents.
- **Solo session protection**: Mentions rejected with 400 on solo sessions.
- **Agent stop**: Stop button in AgentCard → WebSocket `stop_agent` → backend kills process + clears state + updates DB.
- **Git**: Uses SSH remote (`git@github.com:doloveplayer/agentHub.git`) because HTTPS/443 blocked by GFW.
- **Design system**: Inter font, slate-based dark palette (slate-900/slate-800), green accent (#22C55E), 150ms ease-out transitions, lucide-react icons.
- **Refer to `RUNBOOK.md`** for startup/shutdown/reset procedures and `PRD.md` for feature roadmap.

## Code Review Workflow

每完成一个功能板块，必须进行代码审查：

- 输入 `/code-review` 触发自动化代码审查（调用 `superpowers:requesting-code-review` 技能）
- 审查基于当前未提交的改动（或最近一次 commit）对比计划/需求文档
- 修复 Critical 和 Important 问题
- 不要跳过审查认为"改动简单没必要"
- 每当确认功能代码无误后，需要更新计划/需求文档中的完成状态