# Codex Project Rules

These rules apply to the entire AgentHub repository. Codex must follow them when
editing, reviewing, committing, or preparing pull requests for this project.

## Mandatory Planning Before Code Changes

Before any code is written or modified, invoke `/superpowers:writing-plans` and
produce an implementation plan.

- For local, narrow changes such as a one-file bug fix, copy change, or small
  style adjustment, the plan may stay in the conversation.
- For architecture-level changes, save the plan under
  `docs/superpowers/plans/` before editing. Architecture-level changes include
  multi-file coordinated changes, data model changes, API protocol changes, new
  modules, or changes that alter cross-module contracts.
- If `/superpowers:writing-plans` is unavailable in the current Codex session,
  state that explicitly and ask the user to approve a fallback planning process
  before editing. Do not silently skip the planning step.

## Branch And Merge Rules

All GitHub-bound code changes must be committed to a non-`master` branch.

- Create a fork or feature branch before committing changes.
- Do not commit directly to `master`.
- Do not push directly to `master`.
- Do not merge into `master` unless the user has explicitly approved that merge.
- When a merge is needed, open a PR and wait for human review or explicit user
  approval.

## PR Preparation Against Latest Master

Before opening a PR, or when asked to prepare changes for merging with
`master`, always run the full update and conflict-check process:

1. Run `git fetch origin`.
2. Run `git rebase origin/master` for the local work branch.
3. Check carefully for conflicts even if the latest `master` changes look
   unrelated.
4. If conflicts exist, resolve them using the latest `master` content as the
   baseline and adapt local changes on top of it.
5. Review the resulting code using the code review checklist below.
6. Only then proceed with the PR.

Do not skip this flow because `master` appears to be only one commit ahead or
because `git log` suggests there should be no conflicts.

## Code Review Checklist

After code changes, and during any review step, invoke the relevant
`/superpowers` review or verification workflow when available. Then check and
report these five items:

1. Scope: confirm the diff stays within the user's request and does not include
   opportunistic unrelated changes.
2. File boundaries: confirm no sensitive or unrelated files were changed by
   accident, especially `package-lock.json`, `.env`, generated files, and
   configuration files.
3. Compatibility: confirm existing interfaces and data structures remain
   backward compatible. New fields should be optional when appropriate; existing
   field types, WebSocket message contracts, and API response shapes must not be
   broken without explicit approval.
4. Exceptional states: confirm null or undefined values, network failures,
   timeouts, process crashes, and missing-user cases have appropriate guards or
   fallback behavior.
5. Duplication: confirm the change does not add hard-to-maintain repeated logic.
   Compare with existing helpers before adding new utility logic; extract shared
   code when meaningful repeated blocks are introduced.

If the required `/superpowers` review or verification workflow is unavailable,
state that explicitly and perform the checklist manually in the response.

## Current-Code Project Guide

The current code is the source of truth for this repository. Prose documents such
as `README.md`, `RUNBOOK.md`, `PRD.md`, `CLAUDE.md`, `CLAUDE.local.md`, specs,
and old plans are historical references unless their claims are confirmed in
code. When project behavior is unclear, inspect the implementation before
changing docs or code.

## Repository Overview

AgentHub is a local web app for IM-style multi-agent sessions backed by Claude
Code processes running in Docker sandboxes. Users authenticate with GitHub
OAuth, create solo or group sessions, send messages through REST plus
WebSocket, and observe streamed agent output, tool activity, permissions, task
plans, and sandbox file changes in the browser.

The project is an npm workspace:

- `apps/api`: Hono backend, Prisma/PostgreSQL persistence, WebSocket execution
  coordinator, Docker sandbox management, BullMQ task queue, Claude provider
  integration.
- `apps/web`: React 18 plus Vite frontend, Zustand state, Tailwind styling,
  chat UI, session list, agent status panel, file tree, task plan confirmation,
  and task DAG visualization.
- `packages/shared`: TypeScript interfaces shared by API and Web. It covers
  core REST/domain shapes, but many WebSocket payloads are still defined only by
  usage in `apps/api/src/ws/handler.ts` and `apps/web/src/hooks/useChat.ts`.
- `docker`: `sandbox.Dockerfile` for Claude Code execution, `api.Dockerfile`,
  and `nginx.conf`.
- `docs/superpowers`: historical plans and specs. Treat as reference material,
  not as authoritative behavior.

## Runtime Architecture

Current code flow:

```text
Browser React UI
  -> REST /api/* for auth, sessions, chat rows, agents, workspace reads
  -> WebSocket /ws?token=...&sessionId=... for agent execution events
  -> apps/api/src/ws/handler.ts
  -> .sandboxes/{sessionId} host directory
  -> Docker sandbox / provider containers
  -> Claude Code stream-json output
  -> EventParser / provider event conversion
  -> WebSocket events back to Zustand and React components
```

Important boundaries:

- `POST /api/chat/send` only validates ownership, writes the human message, and
  creates one or more streaming agent placeholder messages. Execution starts
  only when the frontend sends a `chat` message over WebSocket.
- A session sandbox is lazy-created on WebSocket connect through
  `SandboxManager.create(sessionId)` and mounted at `/workspace`.
- Named agents use `ClaudeCodeProvider`, which starts a persistent REPL-style
  Docker process with `docker run --rm -i` and keeps per-agent Claude config in
  `_agent_{agentName}/.claude`.
- The legacy `ClaudeCodeProcess` one-shot path still exists and uses
  `claude --print --output-format stream-json --verbose
  --dangerously-skip-permissions`.
- On API startup, `apps/api/src/index.ts` removes stale sandbox containers and
  `.sandboxes/*`, resets stale `streaming` messages to `done`, seeds default
  agents, initializes providers, tries to start the BullMQ worker, then attaches
  the WebSocket server.

## Local Runtime Commands

Run commands from the repository root unless noted.

```bash
# Install dependencies
npm install

# Build the sandbox image used by agent execution
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# Start backing services
docker compose up -d postgres redis

# Run database migrations
export $(grep -v '^#' .env | grep -v '^$' | xargs) && cd apps/api && npx prisma migrate dev

# Optional: regenerate Prisma client
cd apps/api && npx prisma generate

# Start API on port 3000
cd apps/api && npx tsx src/index.ts

# Or use the workspace script with watch mode
npm run dev --workspace @agenthub/api

# Start Web UI on port 5173
cd apps/web && npx vite

# Or use the workspace script
npm run dev --workspace @agenthub/web
```

Verification commands:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npm run build --workspace @agenthub/web
```

There is no committed unit/integration test suite in the current codebase. When
changing behavior, add focused tests if the project gains a test harness; until
then, pair TypeScript checks with manual verification of the touched flow.

## Environment And Services

`apps/api/src/config.ts` loads `.env` from the repository root. Required values:

- `DATABASE_URL`
- `JWT_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_CALLBACK_URL`
- `GITHUB_ALLOWED_USERS`

Common optional values:

- `PORT`, default `3000`
- `HOST_DOCKER_SOCKET`, default `/var/run/docker.sock`
- `SANDBOX_IMAGE`, default `agenthub-sandbox:latest`
- `SANDBOXES_ROOT`, default repository `.sandboxes`
- `AGENT_TIMEOUT_MS`, default `300000`
- `MAX_CONCURRENT_AGENTS`, default `5`
- `TASK_CONCURRENCY`, default `3`
- `TASK_MAX_RETRIES`, default `2`
- `TASK_RETRY_DELAY_MS`, default `30000`
- `REDIS_HOST`, default `localhost`
- `REDIS_PORT`, default `6379`
- `REDIS_URL` is present in config and docker compose, but current BullMQ code
  uses `REDIS_HOST` and `REDIS_PORT`.
- Claude auth is read through safe environment forwarding. The code recognizes
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN`.

Never print or commit `.env`, OAuth secrets, JWT secrets, Anthropic tokens, or
generated local key material. `.env` and `.env.*` are ignored except
`.env.example`.

## Database Model

The Prisma schema is in `apps/api/prisma/schema.prisma`.

- `User`: GitHub OAuth user keyed by unique `githubId`.
- `Session`: user-owned chat session with `title`, `type` (`solo` or `group`),
  optional `sandboxContainerId`, messages, and agent join rows.
- `SessionAgent`: join table from sessions to agents, unique by
  `(sessionId, agentId)`, cascade deleted with session or agent.
- `Message`: session message with `senderType` (`human` or `agent`), optional
  `agentId`, string `content`, and status string. Runtime status values used in
  code are `sending`, `streaming`, `done`, and `error`.
- `Agent`: configurable agent record with unique `name`, `displayName`,
  `description`, `systemPrompt`, and `isActive`.

Default agents are seeded from `apps/api/src/defaultAgents.ts` on startup and by
`apps/api/prisma/seed.ts`: `code-agent`, `review-agent`, `devops-agent`, and
`planner`.

## Backend Map

- `apps/api/src/index.ts`: app startup, cleanup, seed, CORS, route mounting,
  debug Claude auth endpoint, TaskQueue initialization, shutdown handling, and
  WebSocket attachment.
- `apps/api/src/config.ts`: root `.env` loading and config object.
- `apps/api/src/db/prisma.ts`: shared Prisma client.
- `apps/api/src/lib/jwt.ts`: JWT signing and verification.
- `apps/api/src/middleware/auth.ts`: Bearer token auth plus DB user existence
  check. Preserve the DB check so stale tokens after DB resets fail cleanly.
- `apps/api/src/middleware/whitelist.ts`: GitHub login whitelist.
- `apps/api/src/routes/auth.ts`: GitHub OAuth redirect/callback and `/me`.
- `apps/api/src/routes/sessions.ts`: session list/create/get/delete. Group
  sessions without explicit `agentIds` get all active agents. Solo sessions get
  default `code-agent` when available.
- `apps/api/src/routes/chat.ts`: message validation and placeholder creation.
  Mentions are rejected for solo sessions.
- `apps/api/src/routes/agents.ts`: active agent listing, custom agent create,
  update, and soft delete.
- `apps/api/src/routes/workspace.ts`: sandbox file tree, file read with path
  traversal guard, and git diff file list.
- `apps/api/src/ws/handler.ts`: central orchestration for all WebSocket events,
  sandbox lifecycle, agent process maps, persistent REPL reuse, permission
  responses, stop-agent, planner task confirmation, task modification, task
  retry, sequential queues, and broadcast helpers.

## Agent, Provider, And Sandbox Details

`SandboxManager` creates a per-session host directory under `.sandboxes` and a
long-lived `agenthub-sandbox-{sessionId}` container. Current named-agent
execution does not run inside that long-lived container; `ClaudeCodeProvider`
starts per-agent `agenthub-repl-{session}-{agent}` containers with the same host
workspace bind-mounted. Keep both concepts straight when changing cleanup or
workspace paths.

Provider implementation notes:

- `ProviderFactory.init()` currently registers only `claude-code`.
- `ClaudeCodeProvider` advertises persistent sessions, permission proxy,
  streaming output, independent memory, and independent config.
- Named agents are keyed by agent name in
  `agentProcesses: Map<sessionId, Map<agentName, provider>>`.
- REPL reuse calls `provider.sendPrompt(mention.subPrompt)`. Initial provider
  start receives the full agent prompt with system prompt, history, and inbox
  instructions.
- Per-agent config is mounted from
  `.sandboxes/{sessionId}/_agent_{agentName}/.claude` to `/home/node/.claude`.
- `AgentDirectoryManager` also writes
  `.sandboxes/{sessionId}/_agent_{agentName}/CLAUDE.md` and memory/skills
  directories for each agent.
- `InboxManager` writes JSONL inbox files under the session sandbox host
  directory and injects inbox instructions into agent prompts.
- `MilestoneBroadcaster` broadcasts `file_produced` for `Write`/`Edit` events
  and `phase_complete` on successful `done`, but current provider code only
  classifies `done` events.
- `EventParser` parses Claude Code `stream-json`, guards against duplicated text
  from final assistant messages after delta streaming, and converts provider
  events with `toUnified`.

Concurrency and cleanup rules:

- Global running agent limit comes from `MAX_CONCURRENT_AGENTS`.
- Per-session active process limit is hard-coded to `3` in `ws/handler.ts`.
- Agent timeout uses `AGENT_TIMEOUT_MS`.
- Always update `runningAgentCount`, clear timers, remove `agentStates`, and
  clean permission timeouts when adding or changing process lifecycle code.
- WebSocket cleanup currently destroys the sandbox when the last client for a
  session disconnects.

## Planner And Task Queue

Planner behavior is split across the default `planner` agent prompt,
`ws/handler.ts`, `PlannerAgent.ts`, and `TaskQueue.ts`.

Current behavior from code:

- If the WebSocket chat payload has no explicit mention, the backend routes the
  message to the `planner` agent and links the agent message to Planner.
- Planner's seeded prompt is Chinese and has two modes: default group host chat,
  and task planning only when trigger words such as "plan", "task breakdown",
  "decompose", "create a plan", or the listed Chinese trigger phrases appear.
- The legacy one-shot path tries to parse Planner JSON and broadcast
  `plan_result`; named agents currently use the REPL provider path. When working
  on Planner features, verify this code path directly instead of assuming the
  legacy parser runs.
- `confirm_plan` WebSocket messages submit tasks to `TaskQueueManager`.
- `modify_task` stores description changes in memory until plan confirmation.
- `retry_task` requires the frontend to send the full task object.
- `TaskQueueManager` uses BullMQ with Redis and executes tasks with
  `ClaudeCodeProcess`.
- `TaskQueueManager.submitPlan()` computes topological layers but enqueues all
  layer jobs immediately. Dependency handling is therefore mostly prompt-level
  context, not BullMQ flow dependency enforcement.
- Task completion and failure are broadcast as `task_completed`, `task_failed`,
  and eventually `plan_summary`.

## WebSocket Contract

The WebSocket contract is implemented by convention between
`apps/api/src/ws/handler.ts` and `apps/web/src/hooks/useChat.ts`. It is not fully
centralized in `packages/shared`.

Client to server message types:

- `chat`: `{ content, mentions, trustMode, orchestrationMode }`
- `permission_response`: `{ permissionId, allowed }`
- `stop_agent`: `{ agentMessageId }`
- `confirm_plan`: `{ planId, tasks }`
- `modify_task`: `{ planId, taskId, newDescription }`
- `retry_task`: `{ planId, taskId, task }`

Server to client message types:

- `connected`
- `stream_chunk`
- `stream_end`
- `stream_error`
- `agent_status`
- `permission_request`
- `plan_result`
- `plan_executing`
- `task_completed`
- `task_failed`
- `task_modified`
- `plan_summary`
- Milestone events from `MilestoneBroadcaster` such as `phase_complete` and
  `file_produced`

When adding, renaming, or changing any WebSocket payload, update the backend
sender, frontend receiver, and any relevant shared types together. Preserve
`agentMessageId` routing; frontend streaming, Agent Cards, permissions, and stop
buttons depend on it.

## Frontend Map

- `apps/web/src/App.tsx`: routes `/`, `/login`, and `/auth/callback`.
- `apps/web/src/pages/ChatPage.tsx`: loads agents and lays out `SessionList`
  plus `ChatView`.
- `apps/web/src/store/appStore.ts`: Zustand state for token, user, sessions,
  messages, agents, agent events, streaming message IDs, trust mode,
  orchestration mode, task plans, plan summaries, and unread counts.
- `apps/web/src/lib/api.ts`: REST client. Any 401 clears
  `agenthub_token` and redirects to `/login`.
- `apps/web/src/hooks/useAuth.ts`: GitHub OAuth redirect and callback token
  handling.
- `apps/web/src/hooks/useChat.ts`: WebSocket pooling by session, message send
  flow, stream event handling, permissions, plan confirmation, and stop-agent.
- `apps/web/src/lib/mentionParser.ts`: `@agent` parsing, prefix matching, and
  context-based recommendation scoring.
- `apps/web/src/components/SessionList.tsx`: session list, solo/group session
  creation, deletion, unread counts.
- `apps/web/src/components/ChatView.tsx`: message stream, agent event rendering,
  permission cards, Planner confirmation panel, and group side panel.
- `apps/web/src/components/MessageInput.tsx`: textarea, @ mention popup, slash
  command popup, trust checkbox, and parallel/sequential orchestration select.
- `apps/web/src/components/AgentStatusPanel.tsx`: side panel tabs for Files,
  Agents, and Tasks.
- `apps/web/src/components/AgentCard.tsx`: per-agent activity feed and stop
  button.
- `apps/web/src/components/FileTree.tsx`: sandbox file tree fetch and display.
- `apps/web/src/components/ConfirmationPanel.tsx`: review and edit Planner
  tasks before confirmation.
- `apps/web/src/components/TaskCard.tsx` and `TaskDAG.tsx`: active task plan
  status and React Flow DAG.

Styling is Tailwind plus custom CSS in `index.css`. The current UI is a dark
slate interface with Inter font, muted panels, green/accent status highlights,
small rounded controls, and lucide icons for most buttons. Keep new UI dense and
consistent with existing app surfaces.

## Shared Types And Compatibility

`packages/shared/src/types.ts` defines `User`, `Session`, `Message`,
`AgentConfig`, `Mention`, `SendRequest`, `SendResponse`, `PermissionRequest`,
`PermissionResponse`, `TaskNode`, `TaskPlan`, and `TaskPlanResult`.

Compatibility rules:

- Keep existing REST response shapes backward compatible unless the user
  explicitly asks for a breaking change.
- Add optional fields instead of changing existing field meanings where possible.
- Keep `Message.status` values aligned across Prisma data, shared types, the API,
  WebSocket events, and Zustand updates.
- Be careful with task IDs. Shared `TaskNode` uses `id`; frontend `TaskState`
  uses `taskId`; WebSocket confirmation normalizes between them.
- If a type is only implicit in WebSocket code, consider moving it into
  `packages/shared` before expanding it.

## Security And Safety Notes

- Preserve GitHub OAuth whitelist checks and JWT validation.
- Preserve the DB user existence check in both REST auth and WebSocket connect.
- Workspace file reads must remain confined to the session sandbox path.
- Treat any shell command string with user-controlled content as high risk.
  Prefer argument arrays or explicit validation when adding shell execution.
- Do not loosen `buildSafeEnv()` without reviewing secret leakage. It forwards
  Anthropic/Claude auth and filters obvious secret suffixes for non-whitelisted
  variables.
- Docker cleanup commands remove containers named `agenthub-sandbox-*`,
  `agenthub-agent-*`, and provider containers named `agenthub-repl-*`. Be
  precise with name filters.
- Do not print OAuth, JWT, Anthropic, GitHub, or user environment secrets.

## Coding Conventions

- TypeScript is strict in both apps.
- The project uses ESM imports with `.js` extensions in API TypeScript where
  runtime imports need them.
- Prefer existing helper classes and state maps over new global state.
- Keep API behavior in route files and execution behavior in `ws/handler.ts` or
  focused agent modules.
- Keep frontend state mutations in `appStore.ts` and protocol handling in
  `useChat.ts` unless there is a clear reason to split.
- Avoid broad refactors while fixing a narrow issue.
- Do not edit `package-lock.json`, `.env`, generated Prisma migrations, or
  Docker files unless the task requires it.
- If Prisma schema changes, include migration/generate steps in the plan and
  verification.
- If Docker or sandbox behavior changes, test container creation, cleanup,
  bind-mounted workspace paths, and Claude auth propagation.

## Completion Verification

Before claiming a change is complete, run fresh verification appropriate to the
change. For code changes, prefer:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

For frontend changes that affect bundling, also run:

```bash
npm run build --workspace @agenthub/web
```

For documentation-only changes, at minimum inspect the diff and run:

```bash
git diff --check -- AGENTS.md
```

Report any commands that could not be run and why.
