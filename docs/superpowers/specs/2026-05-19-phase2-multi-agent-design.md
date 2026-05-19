# AgentHub Phase 2 — Multi-Agent Group Chat Design

> Status: Draft · Date: 2026-05-19

## Key Decisions

1. **Shared sandbox**: All agents in a session share one Docker container + filesystem
2. **Parallel @ mentions**: One message can @ multiple agents, parsed into sub-tasks, run in parallel
3. **DB-preset agents**: Agent roles (CodeAgent, ReviewAgent, DevOpsAgent) stored in DB, seeded as defaults

## Architecture

```
Frontend: Group Chat UI + @ mention popup + Agent status panel (right)
Backend: @ parser → routes to Agent → spawns Claude Code instance in shared sandbox
          WebSocket multiplexes stream_chunk per agentId
          Permission proxy: permission_request → card → user allow/deny → stdin.write
```
