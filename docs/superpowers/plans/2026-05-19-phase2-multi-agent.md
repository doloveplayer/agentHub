# Phase 2 — Multi-Agent Group Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-agent group chat with @mentions, agent registry, and agent status panel to the Phase 1 MVP.

**Architecture:** One Docker sandbox per session shared by all agents. User types `@AgentName sub-task`, frontend parses mentions, REST creates N agent placeholder messages, WebSocket spawns N Claude Code instances in parallel inside the same container, each streaming back with its own `agentMessageId`.

**Tech Stack:** Prisma + PostgreSQL, Hono, ws, React + Zustand + Tailwind, Docker (dockerode)

---

## File Structure

| File | Role |
|------|------|
| `apps/api/prisma/schema.prisma` | Add `Session.type`, `SessionAgent` model |
| `apps/api/prisma/seed.ts` | **New** — seed 3 default agents + run on startup |
| `apps/api/src/routes/agents.ts` | **New** — Agent CRUD endpoints |
| `apps/api/src/routes/chat.ts` | Accept `mentions[]` in send, create N agent placeholders |
| `apps/api/src/routes/sessions.ts` | Accept `type` + `agentIds` on create, return agents on read |
| `apps/api/src/ws/handler.ts` | Multi-agent state map, parallel spawn per mention |
| `apps/api/src/index.ts` | Mount agent routes |
| `packages/shared/src/types.ts` | Add `Mention`, `SendRequest`, `SendResponse`, extend `Session` |
| `apps/web/src/lib/mentionParser.ts` | **New** — parse `@AgentName` from text into mention list |
| `apps/web/src/lib/api.ts` | Add `getAgents`, update `sendMessage` signature |
| `apps/web/src/store/appStore.ts` | Add `agents`, `sessionAgents`, `streamingMessages` |
| `apps/web/src/components/AgentMentionPopup.tsx` | **New** — @ autocomplete dropdown |
| `apps/web/src/components/AgentStatusPanel.tsx` | **New** — right-side agent status panel |
| `apps/web/src/components/AgentCard.tsx` | **New** — single agent card in panel |
| `apps/web/src/components/MessageInput.tsx` | @ detection, mention popup, agent tags |
| `apps/web/src/components/MessageBubble.tsx` | Per-agent avatar + name + color |
| `apps/web/src/components/ChatView.tsx` | Three-column layout, AgentStatusPanel integration |
| `apps/web/src/components/SessionList.tsx` | Solo/group session creation UI |
| `apps/web/src/hooks/useChat.ts` | Multi-agent send with mentions |

---

### Task 1: Database Schema — Session.type + SessionAgent

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add `type` field to Session and new `SessionAgent` model**

Edit `apps/api/prisma/schema.prisma`:

```prisma
model Session {
  id                 String         @id @default(uuid())
  title              String         @default("New Session")
  type               String         @default("solo")   // NEW: "solo" | "group"
  userId             String
  sandboxContainerId String?
  user               User           @relation(fields: [userId], references: [id])
  messages           Message[]
  agents             SessionAgent[]                      // NEW
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
}

model SessionAgent {
  id        String  @id @default(uuid())
  sessionId String
  agentId   String
  session   Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  agent     Agent   @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@unique([sessionId, agentId])
}
```

- [ ] **Step 2: Run Prisma migrate**

```bash
cd apps/api && source ../.env 2>/dev/null && npx prisma migrate dev --name add_session_type_and_session_agent
```

Expected: migration created and applied without errors.

- [ ] **Step 3: Verify schema in DB**

```bash
cd apps/api && source ../.env 2>/dev/null && npx prisma db pull --print 2>&1 | head -40
```

Expected: output shows Session with `type` field and new `SessionAgent` model.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat: add Session.type and SessionAgent join table"
```

---

### Task 2: Seed Default Agents

**Files:**
- Create: `apps/api/prisma/seed.ts`
- Modify: `apps/api/src/index.ts` (1-line import for seed)

- [ ] **Step 1: Write seed script**

```typescript
// apps/api/prisma/seed.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const defaultAgents = [
  {
    name: 'code-agent',
    displayName: 'CodeAgent',
    description: 'Writes and modifies code, runs shell commands, creates files',
    systemPrompt: 'You are CodeAgent, an expert software engineer. Write clean, secure, well-tested code. Use tools to read, write, and execute code. Prefer editing existing files over creating new ones. Default to no comments unless the WHY is non-obvious.',
  },
  {
    name: 'review-agent',
    displayName: 'ReviewAgent',
    description: 'Reviews code for bugs, security vulnerabilities, and style issues',
    systemPrompt: 'You are ReviewAgent, a thorough code reviewer. Check every file for: security vulnerabilities (OWASP Top 10), logic bugs, type safety, error handling gaps, and code style. Report findings with severity (high/medium/low) and specific file:line references. Suggest concrete fixes for each issue.',
  },
  {
    name: 'devops-agent',
    displayName: 'DevOpsAgent',
    description: 'Handles deployment, CI/CD, Docker, and infrastructure tasks',
    systemPrompt: 'You are DevOpsAgent, an infrastructure and deployment specialist. Handle Docker, CI/CD pipelines, environment configuration, and deployment scripts. Ensure production-readiness: health checks, graceful shutdown, logging, monitoring hooks.',
  },
];

async function main() {
  console.log('[seed] Seeding default agents...');
  for (const agent of defaultAgents) {
    await prisma.agent.upsert({
      where: { name: agent.name },
      update: agent,
      create: agent,
    });
    console.log(`[seed] Upserted agent: ${agent.name}`);
  }
  console.log('[seed] Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run seed**

```bash
cd apps/api && source ../.env 2>/dev/null && npx tsx prisma/seed.ts
```

Expected: `[seed] Upserted agent: code-agent` etc.

- [ ] **Step 3: Verify agents in DB**

```bash
cd apps/api && source ../.env 2>/dev/null && npx prisma db execute --stdin <<< "SELECT name, display_name, is_active FROM \"Agent\";"
```

Expected: 3 rows with the seeded agents.

- [ ] **Step 4: Auto-seed on backend startup**

Add import to `apps/api/src/index.ts` (after existing imports, before app creation):

```typescript
// Auto-seed default agents on startup
import '../prisma/seed.js';
```

Wait — this approach won't work cleanly with ESM + Prisma. Better approach: run seed inline at startup.

Edit `apps/api/src/index.ts`, add after line 13 (`import chatRoutes from './routes/chat.js';`):

```typescript
import { PrismaClient } from '@prisma/client';

async function seedDefaultAgents() {
  const prisma = new PrismaClient();
  try {
    const defaults = [
      { name: 'code-agent', displayName: 'CodeAgent', description: 'Writes and modifies code, runs shell commands, creates files', systemPrompt: 'You are CodeAgent, an expert software engineer. Write clean, secure, well-tested code. Use tools to read, write, and execute code.' },
      { name: 'review-agent', displayName: 'ReviewAgent', description: 'Reviews code for bugs, security vulnerabilities, and style issues', systemPrompt: 'You are ReviewAgent, a thorough code reviewer. Check for security vulnerabilities, logic bugs, type safety, and error handling gaps. Report with severity and file:line references.' },
      { name: 'devops-agent', displayName: 'DevOpsAgent', description: 'Handles deployment, CI/CD, Docker, and infrastructure tasks', systemPrompt: 'You are DevOpsAgent, an infrastructure specialist. Handle Docker, CI/CD, deployment scripts. Ensure production-readiness: health checks, graceful shutdown, logging.' },
    ];
    for (const a of defaults) {
      await prisma.agent.upsert({ where: { name: a.name }, update: a, create: a });
    }
    console.log('[seed] Default agents seeded');
  } catch (err: any) {
    console.log('[seed] Agent seed skipped:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}
```

Then add the call after the startup cleanup block (before `const app = new Hono()`):

```typescript
await seedDefaultAgents();
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/seed.ts apps/api/src/index.ts
git commit -m "feat: seed default agents on startup"
```

---

### Task 3: Agent CRUD API

**Files:**
- Create: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write agents route**

```typescript
// apps/api/src/routes/agents.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';

const agents = new Hono();
agents.use('*', authMiddleware);

// GET / — list all active agents
agents.get('/', async (c) => {
  const list = await prisma.agent.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, displayName: true, description: true, systemPrompt: true },
  });
  return c.json(list);
});

const createSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
});

// POST / — create custom agent
agents.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  try {
    const agent = await prisma.agent.create({ data: parsed.data });
    return c.json(agent, 201);
  } catch (err: any) {
    if (err.code === 'P2002') return c.json({ error: 'Agent name already exists' }, 409);
    throw err;
  }
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
  systemPrompt: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

// PUT /:id — update agent
agents.put('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  try {
    const agent = await prisma.agent.update({ where: { id }, data: parsed.data });
    return c.json(agent);
  } catch (err: any) {
    if (err.code === 'P2025') return c.json({ error: 'Agent not found' }, 404);
    throw err;
  }
});

// DELETE /:id — soft-delete
agents.delete('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    await prisma.agent.update({ where: { id }, data: { isActive: false } });
    return c.body(null, 204);
  } catch (err: any) {
    if (err.code === 'P2025') return c.json({ error: 'Agent not found' }, 404);
    throw err;
  }
});

export default agents;
```

- [ ] **Step 2: Mount in index.ts**

Add import after line 13 (`import chatRoutes from './routes/chat.js';`):

```typescript
import agentRoutes from './routes/agents.js';
```

Add route mount after line 43 (`app.route('/api/chat', chatRoutes);`):

```typescript
app.route('/api/agents', agentRoutes);
```

- [ ] **Step 3: Test the endpoint**

Start backend, then:

```bash
curl -s http://localhost:3000/api/agents -H "Authorization: Bearer <token>" | jq
```

Expected: array of 3 agents with id, name, displayName, description, systemPrompt.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents.ts apps/api/src/index.ts
git commit -m "feat: add Agent CRUD API endpoints"
```

---

### Task 4: Update Shared Types

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add new types**

```typescript
// packages/shared/src/types.ts

export interface User {
  id: string;
  githubId: number;
  login: string;
  avatarUrl: string;
  email?: string;
}

export interface Session {
  id: string;
  title: string;
  type?: 'solo' | 'group';        // NEW
  userId: string;
  sandboxContainerId?: string;
  agents?: SessionAgentInfo[];     // NEW — populated when type === 'group'
  createdAt: string;
  updatedAt: string;
}

export interface SessionAgentInfo {  // NEW
  agentId: string;
  name: string;
  displayName: string;
}

export interface Message {
  id: string;
  sessionId: string;
  senderType: 'human' | 'agent';
  agentId?: string;
  content: string;
  status: 'sending' | 'streaming' | 'done' | 'error';
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
}

export interface Mention {           // NEW
  agentId: string;
  agentName: string;                // e.g. "code-agent"
  subPrompt: string;                // text directed at this agent
}

export interface SendRequest {       // NEW
  sessionId: string;
  content: string;
  mentions?: Mention[];
}

export interface SendResponse {      // NEW
  userMessageId: string;
  agentMessages: { agentMessageId: string; agentId: string }[];
}
```

- [ ] **Step 2: Verify no TypeScript errors**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add Mention, SendRequest, SendResponse shared types"
```

---

### Task 5: Chat Route — Accept Mentions

**Files:**
- Modify: `apps/api/src/routes/chat.ts`

- [ ] **Step 1: Rewrite send handler to accept mentions**

```typescript
// apps/api/src/routes/chat.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';

const chat = new Hono();
chat.use('*', authMiddleware);

const mentionSchema = z.object({
  agentId: z.string().uuid(),
  agentName: z.string(),
  subPrompt: z.string().min(1),
});

const sendSchema = z.object({
  sessionId: z.string().uuid(),
  content: z.string().min(1),
  mentions: z.array(mentionSchema).optional(),
});

chat.post('/send', async (c) => {
  const { userId } = c.get('user');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  const { sessionId, content, mentions } = parsed.data;

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  // Create user message
  const userMessage = await prisma.message.create({
    data: { sessionId, senderType: 'human', content, status: 'done' },
  });

  // Create agent placeholder messages — one per mention, or one generic if no mentions
  const targetMentions = (mentions && mentions.length > 0)
    ? mentions
    : [{ agentId: '', agentName: '', subPrompt: content }];

  const agentMessages: { agentMessageId: string; agentId: string }[] = [];
  for (const m of targetMentions) {
    const agentMsg = await prisma.message.create({
      data: {
        sessionId,
        senderType: 'agent',
        agentId: m.agentId || null,
        content: '',
        status: 'streaming',
      },
    });
    agentMessages.push({ agentMessageId: agentMsg.id, agentId: m.agentId });
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  });

  return c.json({ userMessageId: userMessage.id, agentMessages }, 201);
});

export default chat;
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/chat.ts
git commit -m "feat: accept mentions array in chat/send, create N agent placeholders"
```

---

### Task 6: Sessions Route — Support Group Sessions

**Files:**
- Modify: `apps/api/src/routes/sessions.ts`

- [ ] **Step 1: Rewrite sessions route**

```typescript
// apps/api/src/routes/sessions.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { SandboxManager } from '../agent/SandboxManager.js';

const sessions = new Hono();
sessions.use('*', authMiddleware);

// GET / — list sessions with type and agents
sessions.get('/', async (c) => {
  const { userId } = c.get('user');

  const result = await prisma.session.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, content: true, senderType: true, createdAt: true },
      },
      agents: {
        include: { agent: { select: { id: true, name: true, displayName: true } } },
      },
    },
  });

  return c.json(result.map((s) => ({
    id: s.id,
    title: s.title,
    type: s.type,
    userId: s.userId,
    sandboxContainerId: s.sandboxContainerId,
    agents: s.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
    lastMessage: s.messages[0] ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  })));
});

const createSchema = z.object({
  type: z.enum(['solo', 'group']).optional().default('solo'),
  agentIds: z.array(z.string().uuid()).optional(),
  title: z.string().optional(),
});

// POST / — create session
sessions.post('/', async (c) => {
  const { userId } = c.get('user');

  let body: unknown;
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);

  const { type, agentIds, title } = parsed.data;

  const session = await prisma.session.create({
    data: {
      title: title || (type === 'group' ? 'Group Session' : 'New Session'),
      type,
      userId,
      agents: type === 'group' && agentIds
        ? { create: agentIds.map((agentId) => ({ agentId })) }
        : undefined,
    },
    include: {
      agents: { include: { agent: { select: { id: true, name: true, displayName: true } } } },
    },
  });

  return c.json({
    ...session,
    type: session.type,
    agents: session.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
  }, 201);
});

// GET /:id — get session with messages
sessions.get('/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      agents: { include: { agent: { select: { id: true, name: true, displayName: true } } } },
    },
  });

  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  return c.json({
    ...session,
    type: session.type,
    agents: session.agents.map((sa) => ({
      agentId: sa.agent.id,
      name: sa.agent.name,
      displayName: sa.agent.displayName,
    })),
  });
});

// DELETE /:id — unchanged except destructure
sessions.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('id');

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);

  if (session.sandboxContainerId) {
    SandboxManager.destroy(session.sandboxContainerId).catch((err) =>
      console.error(`[api] Failed to destroy sandbox: ${err.message}`),
    );
    SandboxManager.destroyHostDir(sessionId);
  }

  await prisma.session.delete({ where: { id: sessionId } });
  return c.body(null, 204);
});

export default sessions;
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Test create group session**

```bash
# Get agent IDs first
AGENTS=$(curl -s http://localhost:3000/api/agents -H "Authorization: Bearer <token>")
CODE_ID=$(echo "$AGENTS" | jq -r '.[0].id')
REVIEW_ID=$(echo "$AGENTS" | jq -r '.[1].id')

# Create group session
curl -s -X POST http://localhost:3000/api/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"group\",\"agentIds\":[\"$CODE_ID\",\"$REVIEW_ID\"]}" | jq
```

Expected: session with `type: "group"` and `agents` array with 2 entries.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/sessions.ts
git commit -m "feat: support group sessions with SessionAgent join table"
```

---

### Task 7: WebSocket Handler — Multi-Agent State + Parallel Spawn

**Files:**
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: Refactor agent state tracking**

Current: `agentStates: Map<sessionId, { process, timer }>`
New: `agentStates: Map<sessionId, Map<agentMessageId, { process, timer, agentId }>>`

Also change `runningAgentCount` to count all agent instances.

Replace the `agentStates` declaration and `runningAgentCount` with the multi-agent versions, and update `handleChatMessage` to spawn one process per mention:

The key changes in `apps/api/src/ws/handler.ts`:

Replace line 15:
```typescript
const agentStates = new Map<string, { process: ClaudeCodeProcess; timer: NodeJS.Timeout }>();
```

With:
```typescript
const agentStates = new Map<string, Map<string, { process: ClaudeCodeProcess; timer: NodeJS.Timeout; agentId: string }>>();
```

Replace the `cleanupSessionResources` function (lines 55-78):

```typescript
function cleanupSessionResources(sessionId: string): void {
  const stateMap = agentStates.get(sessionId);
  if (stateMap) {
    for (const [msgId, state] of stateMap) {
      clearTimeout(state.timer);
      state.process.kill();
      runningAgentCount = Math.max(0, runningAgentCount - 1);
    }
    agentStates.delete(sessionId);
  }

  const sandbox = sandboxes.get(sessionId);
  if (sandbox) {
    SandboxManager.destroy(sandbox.containerId).catch((err) =>
      console.error(`[ws] Failed to destroy container: ${err.message}`),
    );
    SandboxManager.destroyHostDir(sessionId);
    sandboxes.delete(sessionId);
    console.log(`[ws] Sandbox cleaned: session=${sessionId}`);
  }

  sessions.delete(sessionId);
}
```

Replace `handleChatMessage` function (lines 201-388). The new version accepts `mentions` and spawns parallel agents:

```typescript
async function handleChatMessage(
  sessionId: string,
  data: { messageId?: string; content?: string; prompt?: string; agentId?: string; trustMode?: boolean; mentions?: { agentId: string; subPrompt: string; messageId: string }[] },
): Promise<void> {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }

  // Normalize mentions: if explicit mentions provided, use them; otherwise single agent
  const mentions: { agentId: string; subPrompt: string; messageId: string }[] =
    (data.mentions && data.mentions.length > 0)
      ? data.mentions
      : [{ agentId: '', subPrompt: data.content || data.prompt || '', messageId: data.messageId || generateId() }];

  const PER_SESSION_MAX = 3;

  for (const mention of mentions) {
    // Global concurrency check
    if (runningAgentCount >= config.agent.maxConcurrent) {
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: mention.messageId,
        error: `Max concurrent agents reached (${config.agent.maxConcurrent}). Please wait.`,
      });
      continue;
    }

    // Per-session concurrency check
    const sessionAgents = agentStates.get(sessionId);
    if (sessionAgents && sessionAgents.size >= PER_SESSION_MAX) {
      broadcast(sessionId, {
        type: 'stream_error',
        agentMessageId: mention.messageId,
        error: `Max ${PER_SESSION_MAX} agents per session. Wait for one to finish.`,
      });
      continue;
    }

    // Set message status to streaming
    try {
      await prisma.message.update({
        where: { id: mention.messageId },
        data: { status: 'streaming', content: '' },
      });
    } catch {
      // message might not exist yet, that's OK
    }

    // Build agent-specific prompt
    let agentPrompt = mention.subPrompt;
    const history = await buildHistory(sessionId);
    if (mention.agentId) {
      const agent = await prisma.agent.findUnique({ where: { id: mention.agentId } });
      if (agent) {
        agentPrompt = `${agent.systemPrompt}\n\n${history ? history + '\n\n---\n' : ''}User request: ${mention.subPrompt}`;
      }
    } else {
      agentPrompt = history ? `${history}\n\n---\nUser: ${mention.subPrompt}` : mention.subPrompt;
    }

    let accumulatedContent = '';
    const agent = new ClaudeCodeProcess();

    agent.onEvent((event) => {
      switch (event.type) {
        case 'text':
          accumulatedContent += event.content;
          broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId: mention.messageId });
          break;
        case 'tool_use':
          broadcast(sessionId, { type: 'agent_status', status: 'tool_use', details: { toolName: event.toolName, input: event.input }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'tool_result':
          broadcast(sessionId, { type: 'agent_status', status: 'tool_result', details: { content: typeof event.content === 'string' ? event.content.slice(0, 200) : '' }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_start':
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_start', details: { agentType: event.agentType, description: event.description }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'subagent_result':
          broadcast(sessionId, { type: 'agent_status', status: 'subagent_result', details: { agentType: event.agentType }, agentMessageId: mention.messageId, timestamp: Date.now() });
          break;
        case 'done': {
          console.log(`[ws] Agent done: session=${sessionId} agentMsg=${mention.messageId} exitCode=${event.exitCode}`);
          prisma.message.update({
            where: { id: mention.messageId },
            data: { content: accumulatedContent, status: event.exitCode === 0 ? 'done' : 'error' },
          }).catch(() => {});
          broadcast(sessionId, { type: 'stream_end', agentMessageId: mention.messageId, fullContent: accumulatedContent, exitCode: event.exitCode });

          const stateMap = agentStates.get(sessionId);
          if (stateMap) {
            const st = stateMap.get(mention.messageId);
            if (st) {
              clearTimeout(st.timer);
              stateMap.delete(mention.messageId);
              runningAgentCount = Math.max(0, runningAgentCount - 1);
            }
            if (stateMap.size === 0) agentStates.delete(sessionId);
          }
          break;
        }
        case 'error':
          broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: event.message });
          break;
      }
    });

    // Timeout per agent
    const timer = setTimeout(() => {
      console.log(`[ws] Agent timeout: session=${sessionId} agentMsg=${mention.messageId}`);
      agent.kill();
      broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: 'Agent execution timed out' });
      const stateMap = agentStates.get(sessionId);
      if (stateMap) {
        const st = stateMap.get(mention.messageId);
        if (st) { clearTimeout(st.timer); stateMap.delete(mention.messageId); runningAgentCount = Math.max(0, runningAgentCount - 1); }
        if (stateMap.size === 0) agentStates.delete(sessionId);
      }
    }, config.agent.timeoutMs);

    // Store agent state
    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(mention.messageId, { process: agent, timer, agentId: mention.agentId });
    runningAgentCount++;

    // Start agent (fire and forget — errors handled in event stream)
    try {
      console.log(`[ws] Starting agent: session=${sessionId} agentMsg=${mention.messageId} prompt="${agentPrompt.slice(0, 80)}..."`);
      agent.start(sessionId, agentPrompt, sandbox.containerId, sandbox.workDir, data.trustMode ?? true, sandbox.hostWorkDir).catch((err) => {
        console.error(`[ws] Agent start failed: session=${sessionId} agentMsg=${mention.messageId} error=${err.message}`);
        broadcast(sessionId, { type: 'stream_error', agentMessageId: mention.messageId, error: `Failed to start agent: ${err.message}` });
      });
    } catch (err: any) {
      console.error(`[ws] Agent spawn error: ${err.message}`);
    }
  }
}
```

Also update `handleMessage` (line 186-197) — push `mentions` through to handler:

```typescript
function handleMessage(ws: WebSocket, sessionId: string, data: any): void {
  switch (data.type) {
    case 'chat':
      handleChatMessage(sessionId, data);
      break;
    case 'permission_response':
      handlePermissionResponse(sessionId, data);
      break;
    default:
      sendTo(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
  }
}
```

No change needed here — `data` already passes through.

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/handler.ts
git commit -m "feat: multi-agent WebSocket state with parallel spawn per mention"
```

---

### Task 8: Frontend Store — Agents + SessionAgents

**Files:**
- Modify: `apps/web/src/store/appStore.ts`

- [ ] **Step 1: Add agents and sessionAgents to store**

Add to `AgentEvent` interface: add `agentId` field for per-agent event routing.

Add new state fields and actions:

```typescript
// apps/web/src/store/appStore.ts
import { create } from 'zustand';
import type { Session, Message, AgentConfig } from '@agenthub/shared';

export interface AgentEvent {
  id: string;
  type: 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request';
  timestamp: number;
  agentId?: string;    // NEW — which agent generated this event
  details: {
    toolName?: string;
    input?: Record<string, unknown>;
    content?: string;
    agentType?: string;
    description?: string;
    tool?: string;
    path?: string;
    permissionId?: string;
  };
}

interface AppState {
  token: string | null;
  user: { id: string; login: string; avatarUrl: string } | null;
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  agentEvents: Record<string, AgentEvent[]>;
  agents: AgentConfig[];                                    // NEW
  streamingMessages: Record<string, Set<string>>;           // NEW — sessionId → set of streaming msgIds

  setToken: (token: string | null) => void;
  setUser: (user: any) => void;
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  addMessage: (sessionId: string, msg: Message) => void;
  appendToMessage: (sessionId: string, msgId: string, chunk: string) => void;
  setMessageStatus: (sessionId: string, msgId: string, status: string) => void;
  addAgentEvent: (messageId: string, event: AgentEvent) => void;
  setAgents: (agents: AgentConfig[]) => void;               // NEW
  addStreamingMessage: (sessionId: string, msgId: string) => void;   // NEW
  removeStreamingMessage: (sessionId: string, msgId: string) => void; // NEW
  isSessionStreaming: (sessionId: string) => boolean;                 // NEW
}

export const useAppStore = create<AppState>((set, get) => ({
  token: localStorage.getItem('agenthub_token'),
  user: null,
  sessions: [],
  activeSessionId: null,
  messages: {},
  agentEvents: {},
  agents: [],                                               // NEW
  streamingMessages: {},                                    // NEW

  setToken: (token) => {
    if (token) localStorage.setItem('agenthub_token', token);
    else localStorage.removeItem('agenthub_token');
    set({ token });
  },

  setUser: (user) => set({ user }),
  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  setAgents: (agents) => set({ agents }),                  // NEW

  addStreamingMessage: (sessionId, msgId) => set((state) => {  // NEW
    const existing = state.streamingMessages[sessionId] ?? new Set<string>();
    const next = new Set(existing);
    next.add(msgId);
    return { streamingMessages: { ...state.streamingMessages, [sessionId]: next } };
  }),

  removeStreamingMessage: (sessionId, msgId) => set((state) => {  // NEW
    const existing = state.streamingMessages[sessionId];
    if (!existing) return state;
    const next = new Set(existing);
    next.delete(msgId);
    return { streamingMessages: { ...state.streamingMessages, [sessionId]: next } };
  }),

  isSessionStreaming: (sessionId) => {                      // NEW
    const s = get().streamingMessages[sessionId];
    return s ? s.size > 0 : false;
  },

  addMessage: (sessionId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] ?? []), msg],
      },
    })),

  appendToMessage: (sessionId, msgId, chunk) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId] ?? [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: sessionMsgs.map((m) =>
            m.id === msgId ? { ...m, content: m.content + chunk } : m
          ),
        },
      };
    }),

  setMessageStatus: (sessionId, msgId, status) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId] ?? [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: sessionMsgs.map((m) =>
            m.id === msgId ? { ...m, status: status as Message['status'] } : m
          ),
        },
      };
    }),

  addAgentEvent: (messageId, event) =>
    set((state) => ({
      agentEvents: {
        ...state.agentEvents,
        [messageId]: [...(state.agentEvents[messageId] ?? []), event],
      },
    })),
}));
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/store/appStore.ts
git commit -m "feat: add agents, streamingMessages state to frontend store"
```

---

### Task 9: Frontend API Client — New Methods

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add agents and update sendMessage**

```typescript
// apps/web/src/lib/api.ts
import type { SendResponse } from '@agenthub/shared';

const BASE_URL = '/api';

function getToken(): string | null {
  return localStorage.getItem('agenthub_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getMe: () => request<any>('/auth/me'),

  getSessions: () => request<any[]>('/sessions'),

  createSession: (body?: { type?: string; agentIds?: string[] }) =>
    request<any>('/sessions', { method: 'POST', body: JSON.stringify(body ?? {}) }),

  getSession: (id: string) => request<any>(`/sessions/${id}`),

  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),

  sendMessage: (sessionId: string, content: string, mentions?: { agentId: string; agentName: string; subPrompt: string }[]) =>
    request<SendResponse>('/chat/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, content, mentions }),
    }),

  getAgents: () => request<any[]>('/agents'),
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat: add getAgents API method, update sendMessage for mentions"
```

---

### Task 10: @ Mention Parser

**Files:**
- Create: `apps/web/src/lib/mentionParser.ts`

- [ ] **Step 1: Write parser**

```typescript
// apps/web/src/lib/mentionParser.ts
import type { Mention, AgentConfig } from '@agenthub/shared';

/**
 * Parse @AgentName mentions from input text.
 * Text between mentions is assigned to the preceding agent.
 * Text before the first @mention is broadcast context (prepended to all sub-prompts).
 */
export function parseMentions(text: string, agents: AgentConfig[]): {
  broadcastContext: string;
  mentions: Mention[];
} {
  const mentionRegex = /@(\S+)/g;
  const matches: { name: string; index: number; endIndex: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    matches.push({ name: match[1], index: match.index, endIndex: match.index + match[0].length });
  }

  if (matches.length === 0) {
    return { broadcastContext: '', mentions: [] };
  }

  // Text before first mention = broadcast context
  const broadcastContext = text.slice(0, matches[0].index).trim();

  const mentions: Mention[] = [];
  for (let i = 0; i < matches.length; i++) {
    const startIndex = matches[i].endIndex;
    const endIndex = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const subPrompt = text.slice(startIndex, endIndex).trim();

    // Find matching agent (case-insensitive prefix match)
    const agent = findAgent(matches[i].name, agents);
    if (agent) {
      const fullPrompt = broadcastContext
        ? `${broadcastContext}\n\n${subPrompt}`
        : subPrompt;
      mentions.push({
        agentId: agent.id,
        agentName: agent.name,
        subPrompt: fullPrompt || text, // fallback to full text if subPrompt empty
      });
    }
  }

  return { broadcastContext, mentions };
}

function findAgent(name: string, agents: AgentConfig[]): AgentConfig | undefined {
  const lower = name.toLowerCase();
  // Exact match first
  const exact = agents.find((a) => a.name === lower);
  if (exact) return exact;
  // Prefix match
  const prefix = agents.find((a) => a.name.startsWith(lower));
  if (prefix) return prefix;
  return undefined;
}

/**
 * Find agents matching @query for autocomplete.
 * Returns [] for empty query; otherwise prefix matches against name and displayName.
 */
export function matchAgents(query: string, agents: AgentConfig[]): AgentConfig[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  return agents.filter(
    (a) => a.name.toLowerCase().startsWith(lower) || a.displayName.toLowerCase().startsWith(lower),
  );
}
```

- [ ] **Step 2: Verify parser exports cleanly**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/mentionParser.ts
git commit -m "feat: add @mention parser and agent autocomplete matcher"
```

---

### Task 11: AgentMentionPopup Component

**Files:**
- Create: `apps/web/src/components/AgentMentionPopup.tsx`

- [ ] **Step 1: Write popup component**

```typescript
// apps/web/src/components/AgentMentionPopup.tsx
import { useEffect, useRef } from 'react';
import type { AgentConfig } from '@agenthub/shared';

interface Props {
  agents: AgentConfig[];
  query: string;
  focusedIndex: number;
  onSelect: (agent: AgentConfig) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export function AgentMentionPopup({ agents, query, focusedIndex, onSelect, onClose, position }: Props) {
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  if (agents.length === 0) return null;

  return (
    <div
      ref={popupRef}
      className="absolute z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl w-56 overflow-hidden"
      style={{ bottom: '100%', left: position.left, marginBottom: 4 }}
    >
      {agents.map((agent, i) => (
        <div
          key={agent.id}
          className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
            i === focusedIndex ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700'
          }`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(agent); }}
        >
          <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
            style={{ backgroundColor: agentColor(agent.name) }}
          >
            {agent.displayName.charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{agent.displayName}</div>
            <div className="text-[10px] text-gray-500 truncate">{agent.description}</div>
          </div>
          <span className="text-[10px] text-gray-500 ml-auto">@{agent.name.charAt(0)}</span>
        </div>
      ))}
    </div>
  );
}

function agentColor(name: string): string {
  const colors: Record<string, string> = {
    'code-agent': '#7c3aed',
    'review-agent': '#059669',
    'devops-agent': '#ea580c',
  };
  return colors[name] ?? '#6b7280';
}

export { agentColor };
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/AgentMentionPopup.tsx
git commit -m "feat: add AgentMentionPopup with keyboard navigation"
```

---

### Task 12: MessageInput — @ Mention Integration

**Files:**
- Modify: `apps/web/src/components/MessageInput.tsx`

- [ ] **Step 1: Rewrite MessageInput with @mention support**

```typescript
// apps/web/src/components/MessageInput.tsx
import { useState, useRef, KeyboardEvent, useCallback } from 'react';
import { Send } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { AgentMentionPopup } from './AgentMentionPopup';
import { matchAgents } from '../lib/mentionParser';
import type { AgentConfig } from '@agenthub/shared';

interface MentionTag {
  agentId: string;
  agentName: string;
  displayName: string;
}

interface Props {
  onSend: (content: string, mentionedAgents: MentionTag[]) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: Props) {
  const agents = useAppStore((s) => s.agents);
  const [value, setValue] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [tags, setTags] = useState<MentionTag[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matchedAgents = matchAgents(mentionQuery, agents);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const pos = e.target.selectionStart ?? 0;
    setValue(newValue);
    setCursorPos(pos);

    // Check if cursor is after @ for popup
    const textBefore = newValue.slice(0, pos);
    const atMatch = textBefore.match(/@(\S*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setShowPopup(true);
      setFocusedIndex(0);
    } else {
      setShowPopup(false);
      setMentionQuery('');
    }
  };

  const handleSelectAgent = (agent: AgentConfig) => {
    const textBefore = value.slice(0, cursorPos);
    const textAfter = value.slice(cursorPos);
    // Replace @query with @displayName
    const newBefore = textBefore.replace(/@\S*$/, `@${agent.displayName} `);
    setValue(newBefore + textAfter);
    setShowPopup(false);
    setMentionQuery('');

    // Add or replace tag
    setTags((prev) => {
      const filtered = prev.filter((t) => t.agentId !== agent.id);
      return [...filtered, { agentId: agent.id, agentName: agent.name, displayName: agent.displayName }];
    });

    ref.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showPopup && matchedAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => (i + 1) % matchedAgents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + matchedAgents.length) % matchedAgents.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSelectAgent(matchedAgents[focusedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowPopup(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const removeTag = (agentId: string) => {
    setTags((prev) => prev.filter((t) => t.agentId !== agentId));
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, tags);
    setValue('');
    setTags([]);
    ref.current?.focus();
  };

  return (
    <div className="border-t border-gray-800 p-4">
      {/* Agent tags */}
      {tags.length > 0 && (
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {tags.map((tag) => (
            <span key={tag.agentId}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-900/50 border border-purple-700 rounded-full text-xs text-purple-300"
            >
              @{tag.displayName}
              <button onClick={() => removeTag(tag.agentId)} className="ml-0.5 hover:text-white">&times;</button>
            </span>
          ))}
        </div>
      )}

      <div className="relative flex gap-2 items-end">
        <textarea
          ref={ref}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... @ to mention an agent"
          rows={1}
          className="flex-1 bg-gray-800 text-gray-200 rounded-lg px-4 py-3 resize-none focus:outline-none focus:ring-1 focus:ring-purple-500 text-sm"
          disabled={disabled}
        />

        {showPopup && (
          <AgentMentionPopup
            agents={matchedAgents}
            query={mentionQuery}
            focusedIndex={focusedIndex}
            onSelect={handleSelectAgent}
            onClose={() => setShowPopup(false)}
            position={{ top: 0, left: 8 }}
          />
        )}

        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="p-3 bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/MessageInput.tsx
git commit -m "feat: add @mention autocomplete and agent tags to MessageInput"
```

---

### Task 13: MessageBubble — Per-Agent Rendering

**Files:**
- Modify: `apps/web/src/components/MessageBubble.tsx`

- [ ] **Step 1: Add per-agent display name and color**

```typescript
// apps/web/src/components/MessageBubble.tsx
import { User, Bot } from 'lucide-react';
import type { Message } from '@agenthub/shared';
import { agentColor } from './AgentMentionPopup';

interface Props {
  message: Message;
  isStreaming?: boolean;
  agentDisplayName?: string;  // NEW
}

const AGENT_ICONS: Record<string, string> = {
  'code-agent': 'C',
  'review-agent': 'R',
  'devops-agent': 'D',
};

export function MessageBubble({ message, isStreaming, agentDisplayName }: Props) {
  const isHuman = message.senderType === 'human';
  const agentName = message.agentId || 'agent';
  const color = isHuman ? undefined : agentColor(agentName);

  const label = isHuman ? 'You' : (agentDisplayName || 'Agent');
  const initial = isHuman
    ? 'U'
    : (AGENT_ICONS[agentName] || (agentDisplayName?.charAt(0) ?? 'A'));

  return (
    <div className={`flex gap-3 px-4 py-3 ${isHuman ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
        style={{ backgroundColor: isHuman ? '#2563eb' : (color ?? '#6b7280'), color: '#fff' }}
      >
        {isHuman ? <User className="w-4 h-4" /> : initial}
      </div>
      <div className={`max-w-[75%] ${isHuman ? 'items-end' : 'items-start'}`}>
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <div className={`rounded-lg px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap font-mono ${
          isHuman ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-200'
        }`}>
          {message.content || (isStreaming && (
            <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse" />
          ))}
          {message.status === 'error' && (
            <span className="text-red-400 text-xs ml-2">(Error)</span>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/MessageBubble.tsx
git commit -m "feat: per-agent avatar color and display name in MessageBubble"
```

---

### Task 14: AgentCard + AgentStatusPanel Components

**Files:**
- Create: `apps/web/src/components/AgentCard.tsx`
- Create: `apps/web/src/components/AgentStatusPanel.tsx`

- [ ] **Step 1: Write AgentCard**

```typescript
// apps/web/src/components/AgentCard.tsx
import { agentColor } from './AgentMentionPopup';
import type { AgentEvent } from '../store/appStore';

interface Props {
  agentId: string;
  displayName: string;
  status: 'running' | 'done' | 'idle';
  events: AgentEvent[];
  contextUsed?: string;
  files?: string[];
}

export function AgentCard({ agentId, displayName, status, events, contextUsed, files }: Props) {
  const color = agentColor(agentId);
  const lastEvent = events[events.length - 1];
  const toolEvents = events.filter((e) => e.type === 'tool_use');
  const subagentEvents = events.filter((e) => e.type === 'subagent_start' || e.type === 'subagent_result');

  return (
    <div className="bg-gray-800/80 border border-gray-700 rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            status === 'running' ? 'bg-green-500 animate-pulse' :
            status === 'done' ? 'bg-green-500' : 'bg-gray-500'
          }`}
        />
        <span className="text-sm font-medium text-gray-200">{displayName}</span>
        <span className="ml-auto text-[10px] text-gray-500">{status}</span>
      </div>

      {status === 'running' && lastEvent && (
        <div className="mt-2 text-[11px] text-gray-400 space-y-0.5">
          <div className="flex justify-between">
            <span>Current</span>
            <span className="text-purple-400 truncate ml-2">
              {lastEvent.type === 'tool_use' && `Running: ${lastEvent.details.toolName ?? 'tool'}`}
              {lastEvent.type === 'tool_result' && 'Processing result...'}
              {lastEvent.type === 'subagent_start' && `Sub-agent: ${lastEvent.details.agentType ?? '?'}`}
            </span>
          </div>
          {contextUsed && (
            <div className="flex justify-between">
              <span>Context</span><span>{contextUsed}</span>
            </div>
          )}
          {files && files.length > 0 && (
            <div className="flex justify-between">
              <span>Files</span><span className="truncate ml-2">{files.join(', ')}</span>
            </div>
          )}
        </div>
      )}

      {subagentEvents.length > 0 && (
        <div className="mt-2">
          {subagentEvents.slice(-3).map((ev, i) => (
            <div key={i} className="text-[10px] bg-gray-900/60 px-2 py-0.5 rounded mt-1 text-gray-400">
              {ev.type === 'subagent_start' ? '🔀' : '✅'} {ev.details.agentType ?? 'subagent'}
              {ev.type === 'subagent_result' && <span className="text-green-500 ml-1">done</span>}
            </div>
          ))}
        </div>
      )}

      {toolEvents.length > 0 && (
        <div className="mt-2 text-[10px] text-gray-500">
          {toolEvents.length} tool call{toolEvents.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write AgentStatusPanel**

```typescript
// apps/web/src/components/AgentStatusPanel.tsx
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import type { AgentConfig } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

interface Props {
  sessionAgents: AgentConfig[];
}

export function AgentStatusPanel({ sessionAgents }: Props) {
  const agentEvents = useAppStore((s) => s.agentEvents);
  const messages = useAppStore((s) => {
    const sessionId = s.activeSessionId;
    return sessionId ? (s.messages[sessionId] ?? []) : [];
  });

  // For each session agent, determine status and collect events
  const agentStates = sessionAgents.map((agent) => {
    const agentMsgs = messages.filter((m) => m.agentId === agent.id);
    const running = agentMsgs.some((m) => m.status === 'streaming');
    const done = agentMsgs.length > 0 && agentMsgs.every((m) => m.status === 'done');
    const status = running ? 'running' : done ? 'done' : 'idle' as const;

    // Collect events for all agent messages
    const events: AgentEvent[] = [];
    for (const msg of agentMsgs) {
      const evs = agentEvents[msg.id];
      if (evs) events.push(...evs);
    }

    return { agent, status, events };
  });

  return (
    <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col h-full">
      <div className="flex border-b border-gray-800">
        {['Files', 'Agents', 'Tasks'].map((tab) => (
          <div
            key={tab}
            className={`flex-1 text-center py-2.5 text-xs cursor-pointer border-b-2 ${
              tab === 'Agents'
                ? 'text-gray-200 border-purple-500'
                : 'text-gray-500 border-transparent hover:text-gray-400'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {agentStates.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-4">No agents in this session</p>
        )}
        {agentStates.map(({ agent, status, events }) => (
          <AgentCard
            key={agent.id}
            agentId={agent.name}
            displayName={agent.displayName}
            status={status}
            events={events}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AgentCard.tsx apps/web/src/components/AgentStatusPanel.tsx
git commit -m "feat: add AgentCard and AgentStatusPanel right-side components"
```

---

### Task 15: SessionList — Solo/Group Creation

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`

- [ ] **Step 1: Add create dialog for solo vs group**

```typescript
// apps/web/src/components/SessionList.tsx (only changed parts shown)
import { useEffect, useState } from 'react';
import { Plus, MessageSquare, Trash2, Users } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function SessionList() {
  const { sessions, activeSessionId, setSessions, setActiveSession, user } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    api.getSessions().then(setSessions).catch(console.error);
  }, []);

  const handleCreate = async (type: 'solo' | 'group') => {
    const session = await api.createSession(type === 'group' ? { type: 'group' } : {});
    setSessions([session, ...sessions]);
    setActiveSession(session.id);
    setShowCreate(false);
  };

  // ... rest of component unchanged (handleSelect, handleDelete)

  return (
    <div className="w-64 h-full bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <h2 className="font-semibold text-white">Sessions</h2>
        <div className="relative">
          <button onClick={() => setShowCreate(!showCreate)} className="p-1 hover:bg-gray-800 rounded" title="New Session">
            <Plus className="w-4 h-4 text-gray-400" />
          </button>
          {showCreate && (
            <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 w-40 overflow-hidden">
              <button onClick={() => handleCreate('solo')} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5" /> Solo Session
              </button>
              <button onClick={() => handleCreate('group')} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2">
                <Users className="w-3.5 h-3.5" /> Group Session
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.map((s: any) => (
          <div
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={`p-3 cursor-pointer hover:bg-gray-800 flex items-start gap-2 group ${
              activeSessionId === s.id ? 'bg-gray-800' : ''
            }`}
          >
            {s.type === 'group' ? (
              <Users className="w-4 h-4 mt-0.5 text-purple-400 shrink-0" />
            ) : (
              <MessageSquare className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-300 truncate">
                {s.title}
                {s.type === 'group' && s.agents && (
                  <span className="text-[10px] text-gray-500 ml-1">
                    ({s.agents.length} agents)
                  </span>
                )}
              </div>
              {s.lastMessage && (
                <div className="text-xs text-gray-500 truncate">{s.lastMessage}</div>
              )}
            </div>
            <button
              onClick={(e) => handleDelete(s.id, e)}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-700 rounded shrink-0"
            >
              <Trash2 className="w-3 h-3 text-gray-500" />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-gray-600 text-sm text-center p-4">No sessions yet</p>
        )}
      </div>
      <div className="p-3 border-t border-gray-800 flex items-center gap-2">
        {user && (
          <>
            <img src={user.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
            <span className="text-sm text-gray-400">{user.login}</span>
          </>
        )}
      </div>
    </div>
  );
}
```

Note: `handleSelect` and `handleDelete` remain the same as current code.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/SessionList.tsx
git commit -m "feat: add solo/group session creation dropdown in SessionList"
```

---

### Task 16: useChat Hook — Multi-Agent Send

**Files:**
- Modify: `apps/web/src/hooks/useChat.ts`

- [ ] **Step 1: Update send to accept mentions and track streaming**

```typescript
// apps/web/src/hooks/useChat.ts
import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { api } from '../lib/api';
import { parseMentions } from '../lib/mentionParser';
import type { Message, AgentConfig } from '@agenthub/shared';

const socketPool = new Map<string, WebSocket>();

interface MentionTag {
  agentId: string;
  agentName: string;
  displayName: string;
}

export function useChat(sessionId: string) {
  const token = useAppStore((s) => s.token);
  const agents = useAppStore((s) => s.agents);
  const { addMessage, appendToMessage, setMessageStatus, addAgentEvent, addStreamingMessage, removeStreamingMessage } = useAppStore();

  const ensureConnection = useCallback(/* ... unchanged from current ... */, [sessionId, token, appendToMessage, setMessageStatus, addAgentEvent]);

  const send = useCallback(async (content: string, mentionedAgents: MentionTag[] = []) => {
    // Add temp user message
    const userMsg: Message = {
      id: 'temp-' + Date.now(),
      sessionId,
      senderType: 'human',
      content,
      status: 'done',
      createdAt: new Date().toISOString(),
    };
    addMessage(sessionId, userMsg);

    // If explicit tags were set in the input, use them. Otherwise parse @mentions from text.
    let mentions: { agentId: string; agentName: string; subPrompt: string }[];
    if (mentionedAgents.length > 0) {
      const { broadcastContext } = parseMentions(content, agents);
      mentions = mentionedAgents.map((tag) => {
        // Extract text directed at this agent from content (simplified: use full text)
        const subPrompt = broadcastContext ? `${broadcastContext}\n\n${content}` : content;
        return { agentId: tag.agentId, agentName: tag.agentName, subPrompt };
      });
    } else {
      const parsed = parseMentions(content, agents);
      if (parsed.mentions.length > 0) {
        mentions = parsed.mentions;
      } else {
        // No @mentions at all — send as generic (solo mode)
        mentions = [];
      }
    }

    try {
      const result = await api.sendMessage(sessionId, content, mentions.length > 0 ? mentions : undefined);

      // Add agent placeholder messages and track them as streaming
      for (const am of result.agentMessages) {
        const agentMsg: Message = {
          id: am.agentMessageId,
          sessionId,
          senderType: 'agent',
          agentId: am.agentId || undefined,
          content: '',
          status: 'streaming',
          createdAt: new Date().toISOString(),
        };
        addMessage(sessionId, agentMsg);
        addStreamingMessage(sessionId, am.agentMessageId);
      }

      // Send WebSocket chat message with mentions
      const ws = await ensureConnection();
      ws.send(JSON.stringify({
        type: 'chat',
        content,
        mentions: result.agentMessages.map((am) => ({
          agentId: am.agentId,
          messageId: am.agentMessageId,
          subPrompt: mentions.find((m) => m.agentId === am.agentId)?.subPrompt ?? content,
        })),
        trustMode: true,
      }));
    } catch (err: any) {
      console.error('[WS] Failed to send message:', err);
    }
  }, [sessionId, agents, addMessage, addStreamingMessage, ensureConnection]);

  // The ensureConnection callback (not duplicated here for brevity — see current
  // apps/web/src/hooks/useChat.ts lines 15-114) requires ONE change in the
  // onmessage switch: add removeStreamingMessage to the stream_end case:
  //
  //   case 'stream_end':
  //     setMessageStatus(sessionId, data.agentMessageId, data.exitCode === 0 ? 'done' : 'error');
  //     removeStreamingMessage(sessionId, data.agentMessageId);
  //     break;
  //
  // Also add removeStreamingMessage to ensureConnection's useCallback dependency
  // array (alongside appendToMessage, setMessageStatus, addAgentEvent).

  const connect = useCallback(() => {
    ensureConnection().catch((err) => console.error('[WS] Connect failed:', err));
  }, [ensureConnection]);

  useEffect(() => {
    if (sessionId) connect();
  }, [sessionId, connect]);

  return { send, connect };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/useChat.ts
git commit -m "feat: multi-agent send with mentions and streaming tracking in useChat"
```

---

### Task 17: ChatView — Three-Column Layout + Status Panel

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Update ChatView for three-column layout**

Key changes:
1. Import `AgentStatusPanel`
2. Determine session type and agents from store
3. When session is group type, show AgentStatusPanel on right
4. Replace `hasRunningAgent` with `isSessionStreaming(sessionId)`
5. Pass `agentDisplayName` to `MessageBubble`

```typescript
// apps/web/src/components/ChatView.tsx (changed parts)
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { AgentStatusPanel } from './AgentStatusPanel';
import { Wrench, FileText, GitBranch, CheckCircle, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import type { Message, AgentConfig } from '@agenthub/shared';

const EMPTY_MESSAGES: Message[] = [];

export function ChatView() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useAppStore((s) => s.agents);

  const messages = useAppStore((s) => {
    if (!activeSessionId) return EMPTY_MESSAGES;
    return s.messages[activeSessionId] ?? EMPTY_MESSAGES;
  });

  const agentEvents = useAppStore((s) => s.agentEvents);
  const isSessionStreaming = useAppStore((s) => s.isSessionStreaming);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { send } = useChat(activeSessionId ?? '');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Agents lookup by id
  const agentMap = new Map<string, AgentConfig>();
  for (const a of agents) agentMap.set(a.id, a);

  // Determine session type and participants
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionAgents: AgentConfig[] = (activeSession as any)?.agents
    ?.map((sa: any) => agentMap.get(sa.agentId))
    .filter(Boolean) ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentEvents]);

  // ... eventIcon, eventLabel, fullEventContent, renderAgentEvents unchanged ...

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Select or create a session to start
      </div>
    );
  }

  const hasRunningAgent = isSessionStreaming(activeSessionId);

  return (
    <div className="flex-1 flex h-full">
      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto chat-scroll">
          {messages.map((msg: any) => (
            <React.Fragment key={msg.id}>
              <MessageBubble
                message={msg}
                isStreaming={msg.status === 'streaming'}
                agentDisplayName={msg.agentId ? agentMap.get(msg.agentId)?.displayName : undefined}
              />
              {msg.senderType === 'agent' && renderAgentEvents(msg.id)}
            </React.Fragment>
          ))}
          <div ref={bottomRef} />
        </div>
        <MessageInput onSend={send} disabled={hasRunningAgent} />
      </div>

      {/* Agent status panel — only for group sessions */}
      {activeSession?.type === 'group' && sessionAgents.length > 0 && (
        <AgentStatusPanel sessionAgents={sessionAgents} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat: three-column layout with AgentStatusPanel in ChatView"
```

---

### Task 18: Frontend Bootstrap — Fetch Agents on Load

**Files:**
- Modify: `apps/web/src/App.tsx` (or wherever the app initializes)

- [ ] **Step 1: Fetch agents when user is authenticated**

Find where the app initializes after login (likely in `ChatPage.tsx` or `App.tsx`). Add:

```typescript
// In a useEffect after user is set:
const setAgents = useAppStore((s) => s.setAgents);

useEffect(() => {
  api.getAgents().then(setAgents).catch(console.error);
}, []);
```

If `ChatPage.tsx`:
```typescript
// apps/web/src/components/ChatPage.tsx
import { useEffect } from 'react';
import { SessionList } from './SessionList';
import { ChatView } from './ChatView';
import { api } from '../lib/api';
import { useAppStore } from '../store/appStore';

export function ChatPage() {
  const setAgents = useAppStore((s) => s.setAgents);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(console.error);
  }, [setAgents]);

  return (
    <div className="flex h-screen bg-gray-950 text-white">
      <SessionList />
      <ChatView />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ChatPage.tsx
git commit -m "feat: fetch agents on app load"
```

---

### Task 19: End-to-End Integration Test

**Files:** (none — manual verification)

- [ ] **Step 1: Start all services**

```bash
docker compose up -d postgres redis
cd apps/api && source ../.env 2>/dev/null && npx tsx src/index.ts &
cd apps/web && npx vite &
```

- [ ] **Step 2: Solo session — backward compatibility**

1. Open http://localhost:5173, log in
2. Click "+" → "Solo Session"
3. Type "say hello" → send
4. Verify: one agent message appears, streams back, shows "done"

- [ ] **Step 3: Group session — create**

1. Click "+" → "Group Session"
2. Verify session appears with Users icon and "(3 agents)" label
3. Click into it — verify right panel shows 3 AgentCards (all "idle")

- [ ] **Step 4: @ mention — single agent**

1. In group session, type "@CodeAgent 写一个 hello world 脚本"
2. Verify: @ popup appears, select CodeAgent
3. Send
4. Verify: One agent message from CodeAgent, right panel shows CodeAgent "running" → "done"
5. Other agents remain "idle"

- [ ] **Step 5: @ mention — two agents parallel**

1. Type "@CodeAgent 创建 server.ts @ReviewAgent 审查 server.ts"
2. Send
3. Verify: Two agent messages appear
4. Both run in parallel (right panel shows both "running")
5. Each streams independently
6. Both finish

- [ ] **Step 6: Verify sandbox isolation**

```bash
# Both agents should be in the same container
docker ps --filter name=agenthub-sandbox
```

Expected: 1 container for the group session.

- [ ] **Step 7: Verify concurrency limit**

Open 3 parallel @mentions to the same agent in rapid succession (should reject the 4th).

---

## Verification Checklist

- [ ] `GET /api/agents` returns 3 default agents
- [ ] Create solo session → backward compatible, single agent works
- [ ] Create group session → SessionAgent rows exist, right panel shows agents
- [ ] `@CodeAgent task` → one agent placeholder, correct agentId in message
- [ ] `@CodeAgent task1 @ReviewAgent task2` → two placeholders, parallel streaming
- [ ] Both agents run in same Docker container (shared sandbox)
- [ ] Stream chunks route to correct agent message bubble (verified in UI)
- [ ] AgentStatusPanel shows real-time running/done/idle states
- [ ] @ autocomplete popup: filters correctly, Enter to select, Esc to close
- [ ] Agent tags in input: removable, shown above textarea
- [ ] MessageBubble shows per-agent color and initial (C/R/D)
- [ ] Concurrency: 4th simultaneous agent in same session rejected
- [ ] Solo sessions: no right panel, no @mention popup (or agents shouldn't be available)
- [ ] History context still works for group sessions (buildHistory per agent)
