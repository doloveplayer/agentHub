# AgentHub

IM-style multi-agent chat application managing Claude Code instances inside Docker sandboxes.

## Architecture

```
Browser (React) → REST API (Hono) → WebSocket → Claude Code inside Docker container
                                                └── stream-json → Browser
```

| Layer | Stack | Responsibility |
|-------|-------|----------------|
| `apps/web` | React 18 + Vite + Tailwind + Zustand | Chat UI, session list, streaming, @mentions, agent panel |
| `apps/api` | Hono + Prisma + ws | REST, JWT auth, WebSocket, sandbox lifecycle |
| `docker/` | Dockerode + sandbox image | Per-session isolation, Claude Code exec |

## Features

- **GitHub OAuth** login with whitelist control
- **Streaming chat** via WebSocket with real-time tool event visibility
- **Multi-agent** group sessions — `@CodeAgent` / `@ReviewAgent` / `@DevOpsAgent`
- **Docker sandbox** per session with bind-mounted workspace
- **Conversation history** injected across sessions

## Quick Start

```bash
# 1. Build sandbox image
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# 2. Start databases
docker compose up -d postgres

# 3. Migrate + seed
export $(grep -v '^#' .env | grep -v '^$' | xargs) && cd apps/api && npx prisma migrate dev --name init

# 4. Backend (port 3000)
cd apps/api && npx tsx src/index.ts

# 5. Frontend (port 5173)
cd apps/web && npx vite
```

Open `http://localhost:5173`.

## Environment

Required in `.env` at project root:

```
DATABASE_URL=postgresql://...
JWT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=http://localhost:3000/api/auth/github/callback
GITHUB_ALLOWED_USERS=your-github-username
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_BASE_URL=...
```

## Project Structure

```
apps/
├── api/                  # Hono backend
│   ├── src/
│   │   ├── agent/        # ClaudeCodeProcess, SandboxManager, EventParser
│   │   ├── routes/       # auth, sessions, chat, agents
│   │   ├── ws/           # WebSocket handler
│   │   ├── middleware/    # JWT auth, whitelist
│   │   └── db/           # Prisma client
│   └── prisma/           # Schema, migrations, seed
├── web/                  # React frontend
│   └── src/
│       ├── components/   # ChatView, SessionList, MessageBubble, AgentStatusPanel, etc.
│       ├── hooks/        # useChat, useAuth
│       ├── store/        # Zustand state
│       └── lib/          # API client, mention parser
packages/
└── shared/               # Shared TypeScript types
docker/                   # Dockerfiles, compose
docs/                     # Specs and plans
```

## Commands

```bash
# TypeScript check
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# Prisma studio
cd apps/api && npx prisma studio

# Force stop
fuser -k 3000/tcp  # backend
fuser -k 5173/tcp  # frontend

# Cleanup sandboxes
docker rm -f $(docker ps -aq --filter name=agenthub-sandbox)
```
