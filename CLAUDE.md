# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AgentHub is an IM-style web chat app that manages multiple Claude Code instances inside Docker sandboxes. Users log in via GitHub OAuth, create sessions, and chat with Claude Code agents through a WebSocket-driven streaming interface. Each session gets an isolated Docker container with a bind-mounted workspace directory at `.sandboxes/{sessionId}/`.

## Commands

```bash
# Start PostgreSQL + Redis
docker compose up -d postgres redis

# Build sandbox image (after Dockerfile changes)
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# Prisma migrate (after schema changes)
cd apps/api && source ../.env 2>/dev/null; npx prisma migrate dev --name init

# Backend (port 3000)
cd apps/api && npx tsx src/index.ts

# Frontend (port 5173, proxies /api and /ws to backend)
cd apps/web && npx vite

# TypeScript check
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# Cleanup orphaned sandboxes
docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null
rm -rf .sandboxes/*
```

## Architecture

### Data flow (chat message)

```
Browser (React) → POST /api/chat/send → DB (user + agent placeholder messages)
Browser → WebSocket /ws → backend spawns Claude Code inside Docker container
Claude Code stdout → EventParser → WebSocket → Browser renders stream chunks
Agent done → DB updated with final content
```

### Key boundaries

| Layer | Tech | Responsibility |
|-------|------|----------------|
| `apps/web` | React 18 + Vite + Tailwind + Zustand | Chat UI, session list, streaming display, GitHub OAuth callback |
| `apps/api` | Hono + @hono/node-server | REST routes (`/api/auth`, `/api/sessions`, `/api/chat`), JWT auth, WebSocket handler |
| `agent/` | Dockerode + child_process | Sandbox lifecycle, Claude Code exec inside Docker, env filtering, stream-json parsing |
| `packages/shared` | TypeScript interfaces | `User`, `Session`, `Message`, `AgentConfig` types |
| `docker/` | Dockerfile + compose | Sandbox image (`node:20-slim` + claude-code, `node` user), PostgreSQL, Redis |

### Claude Code integration

Claude Code runs **inside a Docker container** via `docker exec`. The container is created per-session with a bind-mounted workspace at `.sandboxes/{sessionId}/`.

**Prompt delivery**: Written to `_prompt.txt` on the host (bind-mounted to `/workspace/_prompt.txt`), piped via `cat /workspace/_prompt.txt | claude`.

**Auth delivery**: Only `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` are written to `_env.sh` and sourced before claude runs. All other env vars are filtered by `buildSafeEnv()` — whitelist prefixes (`ANTHROPIC_`, `CLAUDE_`, `PATH`, `HOME`, `NVM_`) pass through; blocklist suffixes (`_TOKEN`, `_SECRET`, `_KEY`) are blocked for non-whitelisted vars.

**Auth env vars MUST be in the project `.env` file** — they are loaded by dotenv at startup. The backend process does NOT inherit them from the shell unless they're in `.env`.

**Permissions**: `--dangerously-skip-permissions` is used (trustMode=true from frontend). Container runs as `node` user (non-root) for this flag to work.

### Debug endpoint

`GET /api/debug/claude-auth` — creates a temp sandbox, runs Claude Code with a test prompt, returns the output. Useful for diagnosing auth/env issues without browser/WebSocket.

### Database

PostgreSQL via Prisma. Models: `User` (GitHub OAuth), `Session` (per-user, linked to sandbox container), `Message` (per-session, with `senderType` and `status`), `Agent` (config for future multi-agent support).

### Key patterns

- **Env vars**: Config loaded from project root `.env` by `apps/api/src/config.ts` using dotenv. Required: `DATABASE_URL`, `JWT_SECRET`, `GITHUB_CLIENT_ID/SECRET/CALLBACK_URL/ALLOWED_USERS`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`.
- **Auth**: JWT tokens (7d expiry) issued after GitHub OAuth callback. Stored in localStorage as `agenthub_token`. Middleware checks `Authorization: Bearer <token>` on protected routes. Whitelist middleware validates GitHub username.
- **WebSocket**: Authenticated via `?token=JWT&sessionId=UUID` query params. Message types: `chat`, `stream_chunk`, `stream_end`, `stream_error`, `agent_status`, `permission_request`, `permission_response`.
- **Frontend state**: Zustand store (`appStore.ts`) manages `token`, `user`, `sessions`, `messages`, `agentEvents`. Selectors must return stable references — never return `[]` literal.
- **Startup cleanup**: `index.ts` runs `docker rm -f` on all `agenthub-sandbox-*` containers and `rm -rf .sandboxes/*` on boot.
