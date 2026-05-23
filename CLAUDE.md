# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AgentHub is an IM-style web chat app that serves as a **smart collaboration hub** for multiple AI coding agents. Users log in via GitHub OAuth, create sessions (solo or group), and interact with agents from multiple platforms (Claude Code, Codex, OpenCode, and user-registered agents) through a WebSocket-driven streaming interface. Each session gets an isolated Docker sandbox with a bind-mounted workspace at `.sandboxes/{sessionId}/`.

### Core design philosophy

AgentHub is a **Smart Hub** — it actively coordinates, orchestrates, and manages multi-agent collaboration. It is NOT a passive message pipe.

What AgentHub owns as a platform:
- **Interaction experience**: conversation list, solo/group chat modes, deployment status cards, artifact preview/edit/re-interaction, message operations, context management
- **Main Agent coordination**: a PM/PMO-style orchestrator that understands user intent, decomposes complex tasks, dispatches to sub-agents, handles parallel scheduling, failure degradation, and code conflict resolution
- **Multi-agent integration**: provider-agnostic agent接入层, supports at least Claude Code + one other mainstream platform (Codex/OpenCode), plus user-registered custom agents. Each agent has avatar, display name, and capability tags in the chat interface
- **Artifact preview & editing**: inline preview and editing of agent-produced artifacts — web pages, rendered documents, PPT browsing, code with diff view and version history. Users can quote document passages and hand them to agents for further processing
- **Session & sandbox management**: Docker sandbox lifecycle, WebSocket multiplexing, message persistence, permission proxy
- **Task orchestration**: DAG-based task decomposition, BullMQ scheduling, parallel execution, failure retry/downgrade, result aggregation

What AgentHub does NOT reimplement:
- Code generation, editing, file operations — those are the agent CLI tools' job
- Shell command execution, git operations — executed by agents inside sandboxes
- Language-specific analysis (linting, type-checking, vulnerability scanning) — delegated to agents

In short: AgentHub is a **smart hub with a chat UI**. The intelligence is distributed — coordination lives in the hub, execution lives in the agents.

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
Browser → WebSocket /ws → backend spawns agent process (provider-agnostic) inside Docker
Agent stdout → EventParser → WebSocket → Browser renders stream chunks
Agent done → DB updated with final content
```

### Data flow (multi-agent with @mentions)

```
Browser → parse @agent from text (mentionParser.ts) → POST /api/chat/send with mentions[]
  → DB creates 1 user msg + N agent placeholder msgs (each with agentId)
  → WebSocket sends { type: 'chat', mentions: [{ agentId, subPrompt, messageId }] }
  → Backend spawns N agent instances IN PARALLEL inside same Docker container
  → Each instance: systemPrompt + history + subPrompt → agent CLI (provider-agnostic)
  → Per-agent prompt file `_prompt_{messageId}.txt` (prevents parallel overwrite)
  → stdout → EventParser → agent_status + stream_chunk → WebSocket multiplexed by agentMessageId
  → Frontend routes stream chunks to correct MessageBubble; tool events to correct AgentCard
```

### / command passthrough

```
Input starts with "/" → backend skips mention parsing + system prompt injection
  → raw prompt forwarded to agent CLI (agent handles /commands natively)
```

### Main Agent → DAG execution flow (Task Orchestration)

```
User sends complex requirement (with planner trigger keyword, or @Planner in group session)
  → Main Agent (dual-role: chat host + PM/PMO coordinator) decomposes requirement
  → Outputs TaskPlan JSON (3-8 tasks with dependsOn DAG)
  → Frontend renders TaskDAG visualization; user can confirm, modify, or retry tasks
  → On confirm: plan submitted to BullMQ (Redis-backed queue)
  → Topological sort → parallel layers; each task spawns agent process via provider
  → Task results streamed back via plan_executing / agent_status messages
  → Failed tasks auto-retried (configurable attempts); exhausted tasks block dependents
  → Code conflicts between parallel agents detected and surfaced for user resolution
```

### Provider abstraction (`apps/api/src/agent/providers/`)

A pluggable provider layer that decouples the hub from specific CLI tools. This is the foundation for multi-platform agent support:

| File | Role |
|------|------|
| `base.ts` | `AbstractProvider` interface + `UnifiedAgentEvent` (normalized events across all providers) |
| `claude-code.ts` | `ClaudeCodeProvider` — wraps Claude Code CLI via `docker run -i` (REPL mode) |
| `factory.ts` | `ProviderFactory` — registry pattern, `init()` registers built-in providers at startup |

Each provider declares capabilities: `persistentSession`, `permissionProxy`, `streamingOutput`, `independentMemory`, `independentConfig`.

**Target**: at least 2 mainstream providers (Claude Code + Codex or OpenCode), with a stable interface for user-registered custom agents.

REPL mode (`ENABLE_PERSISTENT_REPL`, currently off) keeps a persistent `docker run -i` process per agent, reusing it across turns instead of spawning one-shot `docker exec` per message. The fallback one-shot path (`ClaudeCodeProcess`) still exists for legacy/no-agent-name scenarios.

### Turn routing (`apps/api/src/agent/turns.ts`)

Handles mention-to-agent resolution and orchestrator logic:

- `normalizeAgentHandle()` / `matchAgentByHandle()` — fuzzy match @mentions to registered agents (exact match → prefix match)
- `selectDefaultAgent()` — no @mention: solo session → code-agent, group session → planner
- `extractPlannerPlan()` — parse TaskPlan JSON from Planner output (handles fence-wrapped, inline, and bare JSON)
- `buildClaudePrintArgs()` — shared CLI argument builder for Claude Code invocations
- `toTaskStates()` — convert TaskPlan nodes to frontend-friendly state payloads

### Agent collaboration primitives (Smart Hub coordination layer)

| Component | Mechanism | Purpose |
|-----------|-----------|---------|
| `InboxManager` | Filesystem `.jsonl` files (`_inbox_{agentName}.jsonl`) | Agent-to-agent intervention request/response; inbox awareness injected via system prompt fragment |
| `MilestoneBroadcaster` | In-memory pub/sub per session | `file_produced` and `phase_complete` events so the Main Agent can track sub-agent progress |
| `StateTracker` | In-memory `Map<agentMessageId, AgentSnapshot>` | Per-agent snapshot: token usage, opened files, current tool, subagent list — powers the agent status panel |

### Key boundaries

| Layer | Tech | Responsibility |
|-------|------|----------------|
| `apps/web` | React 18 + Vite + Tailwind + Zustand + Inter font | Chat UI, session list, streaming display, @mentions, agent status panel, TaskDAG visualization, FileTree, artifact preview (web/docs/code/PPT), deployment status cards, GitHub OAuth callback |
| `apps/api` | Hono + @hono/node-server | REST routes (`/api/auth`, `/api/sessions`, `/api/chat`, `/api/agents`, `/api/workspace`), JWT auth, WebSocket handler |
| `apps/api/src/agent/` | Dockerode + BullMQ | Sandbox lifecycle, multi-provider agent execution, Main Agent (Planner), TaskQueue with DAG scheduling, turns routing, StateTracker, InboxManager, MilestoneBroadcaster, code conflict detection |
| `apps/api/src/agent/providers/` | AbstractProvider interface | Pluggable multi-platform agent layer (Claude Code today, Codex/OpenCode in roadmap) |
| `packages/shared` | TypeScript interfaces | `User`, `Session`, `Message`, `AgentConfig`, `Mention`, `TaskNode`, `TaskPlan`, `SendRequest`, `SendResponse`, `Artifact`, `DeploymentStatus` |
| `docker/` | Dockerfile + compose | Sandbox image (`node:20-slim` + agent CLIs, `node` user), PostgreSQL, Redis |

### Database (Prisma + PostgreSQL)

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `User` | id, githubId, login, avatarUrl | GitHub OAuth |
| `Session` | id, userId, type ("solo"\|"group"), sandboxContainerId | FK→User |
| `SessionAgent` | sessionId, agentId | Join table, cascade delete |
| `Message` | id, sessionId, senderType, agentId, content, status | status: sending/streaming/done/error |
| `Agent` | id, name, displayName, description, systemPrompt, isActive | 4 defaults seeded at startup (code-agent, review-agent, devops-agent, planner) |

### Agent integration (multi-provider)

- Agents run **inside Docker** via `docker exec` or `docker run -i`, `cwd=/workspace`
- **Prompt**: per-agent `_prompt_{messageId}.txt` written to hostWorkDir (bind-mounted), piped via `cat file | <agent-cli>`
- **Auth**: provider-specific credentials written to per-agent `_env_{agent}.sh`, sourced before agent CLI
- **Env filter** (`buildSafeEnv()`): Whitelist prefixes (`ANTHROPIC_`, `CLAUDE_`, `OPENAI_`, `CODEX_`, `PATH`, `HOME`, `NVM_`, `LANG`, `LC_`, `TERM`, `COLOR`, `TZ`, `DEBIAN_FRONTEND`) pass through. Blocklist suffixes (`_TOKEN`, `_SECRET`, `_KEY`, `_PASSWORD`) blocked for non-whitelisted vars.
- **Line buffering**: `ClaudeCodeProcess.partialLine` accumulates across Docker multiplex frames to prevent split JSON lines from being lost
- **Permissions**: trustMode uses `--dangerously-skip-permissions` (Claude Code) or equivalent per provider. Container runs as `node` user (non-root).
- **Config** (`apps/api/src/config.ts`): `AGENT_TIMEOUT_MS` (default 5 min), `MAX_CONCURRENT_AGENTS` (default 5 global), `TASK_CONCURRENCY` (default 3), `TASK_MAX_RETRIES` (default 2), `TASK_RETRY_DELAY_MS` (default 30s). Redis host/port from `REDIS_HOST`/`REDIS_PORT` env vars.
- **Two exec modes**: (1) One-shot `ClaudeCodeProcess` — `docker exec` per message, the default path; (2) REPL mode — persistent `docker run -i` per agent, gated by `ENABLE_PERSISTENT_REPL` flag (off by default). REPL mode uses `ProviderFactory` to create provider instances.

### WebSocket message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `chat` | Client→Server | Send message with optional `mentions[]`, `trustMode`, and `orchestrationMode` (`parallel`/`sequential`/`auto`) |
| `stream_chunk` | Server→Client | Text content appended to message bubble (by `agentMessageId`) |
| `stream_end` | Server→Client | Agent finished: `exitCode`, `fullContent`, `stopped` flag |
| `stream_error` | Server→Client | Agent error message |
| `agent_status` | Server→Client | Real-time event: `thinking`/`tool_use`/`tool_result`/`subagent_start`/`subagent_result`/`token_update`/`permission_request` |
| `permission_request` | Server→Client | Permission needed (suppressed by trustMode; auto-deny after 120s timeout) |
| `permission_response` | Client→Server | User allow/deny (routed to single agent only; multi-agent blocked) |
| `stop_agent` | Client→Server | Kill running agent by `agentMessageId` |
| `connected` | Server→Client | Connection confirmation |
| `plan_result` | Server→Client | Planner produced a TaskPlan: `planId`, `planTitle`, `summary`, `tasks[]` |
| `plan_executing` | Server→Client | TaskPlan confirmed and submitted to BullMQ for execution |
| `task_modified` | Server→Client | User modified a task description in the DAG before confirming plan |
| `confirm_plan` | Client→Server | User confirms plan → dispatched to TaskQueueManager |
| `modify_task` | Client→Server | User edits a task description before plan confirmation |
| `retry_task` | Client→Server | Retry a failed task (triggers TaskQueueManager.retryTask) |
| `artifact_preview` | Server→Client | Agent produced an artifact (web page, doc, code, PPT) for inline preview |
| `deployment_status` | Server→Client | Deployment progress update: building/deploying/success/failed with URL |
| `deploy_to_platform` | Client→Server | User triggers deployment to a third-party platform |

### Startup sequence (`index.ts`)

1. `docker rm -f` all `agenthub-sandbox-*` containers (clean orphans)
2. `rm -rf .sandboxes/*` (clean host sandbox dirs)
3. Reset stale `streaming` messages to `done` in DB (prevent phantom running state)
4. Seed 4 default agents (upsert: code-agent, review-agent, devops-agent, planner as Main Agent)
5. `ProviderFactory.init()` — register built-in providers (Claude Code today; Codex/OpenCode in roadmap)
6. `TaskQueueManager.drain()` — obliterate stale BullMQ jobs from previous runs
7. Mount routes + WebSocket + listen on port 3000
8. `TaskQueueManager.startWorker()` — begin processing queued tasks (Main Agent orchestration)

### Key patterns

- **Multi-agent state**: `Map<sessionId, Map<agentMessageId, { process, timer, agentId }>>` in `handler.ts`. Each agent tracked independently for timeout, stop, cleanup.
- **REPL process reuse**: `agentProcesses: Map<sessionId, Map<agentName, { provider, timer, agentId }>>` — persistent `docker run -i` providers reused across turns when `ENABLE_PERSISTENT_REPL` is on.
- **Sequential orchestration**: `sequentialQueues: Map<sessionId, Mention[]>` — when mode is `sequential`, all but the first mention are queued; each `stream_end` dequeues the next.
- **Agent defaults**: Shared in `apps/api/src/defaultAgents.ts`, imported by both `seed.ts` (standalone) and `index.ts` (startup seed).
- **Main Agent (Planner) dual-role**: Default group-session agent; acts as chat host (conversational replies, no JSON) unless triggered by keywords (plan/task breakdown/decompose). When triggered, outputs TaskPlan JSON in a ```json fence; the handler strips JSON blocks from the chat stream so users see only conversational text. This is the PM/PMO coordination layer.
- **Plan lifecycle**: Main Agent → `plan_result` WS message → frontend DAG visualization → user confirm/modify/retry → `confirm_plan` → TaskQueueManager.submitPlan() → BullMQ topological execution (parallel layers, failure degradation, code conflict detection) → `plan_executing` broadcast.
- **TaskQueue persistence**: BullMQ backed by Redis. Tasks survive backend restarts within Redis TTL. `obliterate()` on startup drains stale jobs since sandboxes are also cleaned.
- **Auth middleware** (`auth.ts`): Verifies JWT THEN checks user exists in DB (defense against DB resets). Returns 401 "User not found — please re-authenticate" if user missing.
- **WS connection** (`handler.ts`): Same user-existence check as REST auth middleware.
- **Frontend 401 handling** (`api.ts`): Any 401 response → clears `agenthub_token` from localStorage → redirects to `/login`.
- **Zustand store** (`appStore.ts`): `agents`, `streamingMessages`, `agentEvents` (with `thinking` type). Stable empty references (`EMPTY_MESSAGES`, `EMPTY_ARR`) to prevent infinite re-renders.
- **Agent Card activity feed**: Shows thinking/tool_use/tool_result/subagent events, last 20 entries, auto-scrolls while running.
- **Concurrency**: Per-session max 3 agents + global max from `config.agent.maxConcurrent` + BullMQ worker concurrency from `config.taskQueue.concurrency`.
- **Group session auto-assign**: Creating group session without `agentIds` → backend assigns ALL active agents.
- **Solo session protection**: Mentions rejected with 400 on solo sessions.
- **Agent stop**: Stop button in AgentCard → WebSocket `stop_agent` → backend kills process + clears state + updates DB.
- **Task modification**: Before plan confirmation, user can edit task descriptions (stored in `taskModifications` Map, survives page refresh). Edits applied at submission time via `applyTaskModifications()`.
- **Task retry**: Failed tasks can be retried with full context; exhausted tasks block all dependents via `blockDependents()`.
- **Git**: Uses SSH remote (`git@github.com:doloveplayer/agentHub.git`) because HTTPS/443 blocked by GFW.
- **HTTPS proxy**: `HTTPS_PROXY` env var forwarded to `process.env.https_proxy` for undici fetch (GitHub OAuth behind GFW).
- **Design system**: Inter font, slate-based dark palette (slate-900/slate-800), green accent (#22C55E), 150ms ease-out transitions, lucide-react icons.
- **Token generation**: `apps/api/scripts/gen_token.ts` — CLI tool to generate JWT tokens for API testing.
- **Refer to `RUNBOOK.md`** for startup/shutdown/reset procedures and `PRD.md` for feature roadmap.

## Plan Management Workflow

计划和实现必须保持同步：

- **完成即更新**：每完成一个功能阶段（Phase/Tier/Task），必须同步更新 `docs/superpowers/plans/` 下对应 plan 文件的勾选状态（`- [ ]` → `- [x]`），不允许累积到多个阶段一起更新
- **分歧先讨论**：实施过程中发现 plan 的设计需要调整时，必须先与我讨论更优方案，而不是静默偏离 plan
- **改 Plan 再改 Code**：确认调整方向后，先修改 plan 文件使其反映新方案，再执行代码修改。杜绝 plan 和实际实现各说各话

## Multi-Agent Collaboration SOP

Phase 3+ 开发启用多 Agent 协作模型。Agent 定义在 `.claude/agents/` 目录下。每次开发遵循标准工作流：

**SOP 四步流程：**

1. **[@Main Agent]** — 用户提出功能需求 → 由 Main Agent 输出 DAG 任务拆解 + 接口契约（REST/WS/data model）
   - 文件：`.claude/agents/Main_Agent.md`
2. **确认** — 用户审核 DAG 和契约，确认无误后进入实现阶段
3. **[@Backend / @Frontend]** — 按任务依赖顺序，每次聚焦一个独立节点，完成单文件或单模块闭环
   - 文件：`.claude/agents/Backend_Agent.md`, `.claude/agents/Frontend_Agent.md`
4. **[@Review]** — 模块写完后，自发进行代码审查：类型安全、架构一致性、资源回收、安全边界
   - 文件：`.claude/agents/Review_Agent.md`

**Agent 调度原则：**
- Main Agent 输出 DAG 后自动退出，不参与具体实现
- Backend/Frontend 只实现自己职责范围的代码，不跨界
- Review Agent 发现的问题反馈给对应 Agent 修复，不直接修改代码
- 每个 Agent 完成任务后更新对应 plan 文件的 checkboxes

## Code Review Workflow

每完成一个功能板块，必须进行代码审查：

- 输入 `/code-review` 触发自动化代码审查（调用 `superpowers:requesting-code-review` 技能）
- 审查基于当前未提交的改动（或最近一次 commit）对比计划/需求文档
- 修复 Critical 和 Important 问题
- 不要跳过审查认为"改动简单没必要"