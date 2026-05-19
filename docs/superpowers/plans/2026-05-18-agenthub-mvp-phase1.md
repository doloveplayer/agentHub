# AgentHub MVP (Phase 1) Implementation Plan

> **For agentic workers:** Use multi-agent parallel execution — tasks marked `[P]` can run concurrently.

**Goal:** A working web chat interface that lets a user log in via GitHub, chat with a Claude Code agent in a Docker sandbox, with streaming text output.

**Architecture:** Monorepo — `apps/api` (Hono + WebSocket + Dockerode), `apps/web` (React + Vite + Tailwind), `packages/shared` (types). Each session gets an isolated Docker sandbox; Claude Code runs as a subprocess inside it. WebSocket bridges stdout to the browser.

**Tech Stack:** Bun, Hono, Prisma, PostgreSQL, Redis, Dockerode, React 18, Vite, Tailwind, shadcn/ui, Zustand, ws

---

## File Structure

```
agentHub/
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config.ts
│   │   │   ├── middleware/auth.ts
│   │   │   ├── middleware/whitelist.ts
│   │   │   ├── routes/auth.ts
│   │   │   ├── routes/sessions.ts
│   │   │   ├── routes/chat.ts
│   │   │   ├── ws/handler.ts
│   │   │   ├── agent/ClaudeCodeProcess.ts
│   │   │   ├── agent/EventParser.ts
│   │   │   ├── agent/SandboxManager.ts
│   │   │   ├── db/prisma.ts
│   │   │   └── lib/jwt.ts
│   │   └── prisma/schema.prisma
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       ├── postcss.config.js
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── index.css
│           ├── lib/api.ts
│           ├── lib/ws.ts
│           ├── hooks/useChat.ts
│           ├── hooks/useAuth.ts
│           ├── store/appStore.ts
│           ├── components/ChatView.tsx
│           ├── components/MessageBubble.tsx
│           ├── components/MessageInput.tsx
│           ├── components/SessionList.tsx
│           ├── components/LoginPage.tsx
│           └── pages/ChatPage.tsx
├── packages/shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/types.ts
├── docker/
│   ├── sandbox.Dockerfile
│   └── nginx.conf
├── docker-compose.yml
└── .env.example
```

---

## Wave 0 — Project Scaffold

### Task 0: Initialize Monorepo

**Files:** Create root & workspace package.json files

- [ ] **Step 0.1: Create root package.json**

```json
// agentHub/package.json
{
  "name": "agent-hub",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

- [ ] **Step 0.2: Create packages/shared**

```json
// agentHub/packages/shared/package.json
{
  "name": "@agenthub/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/types.ts",
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

```typescript
// agentHub/packages/shared/src/types.ts
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
  userId: string;
  sandboxContainerId?: string;
  createdAt: string;
  updatedAt: string;
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
```

```json
// agentHub/packages/shared/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "./dist"
  }
}
```

- [ ] **Step 0.3: Create apps/api package.json**

```json
// agentHub/apps/api/package.json
{
  "name": "@agenthub/api",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@agenthub/shared": "workspace:*",
    "hono": "^4.6.0",
    "@prisma/client": "^5.22.0",
    "dockerode": "^4.0.0",
    "jsonwebtoken": "^9.0.0",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/ws": "^8.5.0",
    "prisma": "^5.22.0",
    "bun-types": "latest",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 0.4: Create apps/web package.json**

```json
// agentHub/apps/web/package.json
{
  "name": "@agenthub/web",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build"
  },
  "dependencies": {
    "@agenthub/shared": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.28.0",
    "zustand": "^5.0.0",
    "lucide-react": "^0.460.0",
    "clsx": "^2.1.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 0.5: Create tsconfig files**

```json
// agentHub/apps/api/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "paths": { "@agenthub/shared": ["../../packages/shared/src"] }
  },
  "include": ["src/**/*"]
}
```

```json
// agentHub/apps/web/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "paths": { "@agenthub/shared": ["../../packages/shared/src"] }
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 0.6: Install dependencies**

Run: `cd agentHub && bun install`

---

## Wave 1 — Backend Core (can run parallel to Wave 2 after Wave 0)

### Task 1: Prisma Schema + Config + JWT

**Files:** Create `apps/api/prisma/schema.prisma`, `apps/api/src/config.ts`, `apps/api/src/db/prisma.ts`, `apps/api/src/lib/jwt.ts`, `.env.example`

- [ ] **Step 1.1: Create env example**

```bash
# agentHub/.env.example
DATABASE_URL="postgresql://agenthub:agenthub@localhost:5432/agenthub"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="change-me-in-production"
GITHUB_CLIENT_ID="your-github-oauth-app-id"
GITHUB_CLIENT_SECRET="your-github-oauth-app-secret"
GITHUB_CALLBACK_URL="http://localhost:3000/api/auth/github/callback"
GITHUB_ALLOWED_USERS="user1,user2"
HOST_DOCKER_SOCKET="/var/run/docker.sock"
SANDBOX_IMAGE="agenthub-sandbox:latest"
```

- [ ] **Step 1.2: Create Prisma schema**

```prisma
// agentHub/apps/api/prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String    @id @default(uuid())
  githubId  Int       @unique
  login     String
  avatarUrl String
  email     String?
  sessions  Session[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Session {
  id                 String    @id @default(uuid())
  title              String    @default("New Session")
  userId             String
  user               User      @relation(fields: [userId], references: [id])
  sandboxContainerId String?
  messages           Message[]
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
}

model Message {
  id         String   @id @default(uuid())
  sessionId  String
  session    Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  senderType String   // "human" | "agent"
  agentId    String?
  content    String
  status     String   @default("done") // "sending" | "streaming" | "done" | "error"
  createdAt  DateTime @default(now())
}

model Agent {
  id           String @id @default(uuid())
  name         String @unique
  displayName  String
  description  String
  systemPrompt String
  isActive     Boolean @default(true)
  createdAt    DateTime @default(now())
}
```

- [ ] **Step 1.3: Create config**

```typescript
// agentHub/apps/api/src/config.ts
const env = (key: string, fallback?: string): string =>
  process.env[key] ?? fallback ?? (() => { throw new Error(`Missing env: ${key}`) })();

export const config = {
  port: parseInt(env('PORT', '3000')),
  jwtSecret: env('JWT_SECRET'),
  github: {
    clientId: env('GITHUB_CLIENT_ID'),
    clientSecret: env('GITHUB_CLIENT_SECRET'),
    callbackUrl: env('GITHUB_CALLBACK_URL'),
    allowedUsers: env('GITHUB_ALLOWED_USERS').split(',').map(s => s.trim()),
  },
  databaseUrl: env('DATABASE_URL'),
  redisUrl: env('REDIS_URL'),
  docker: {
    socketPath: env('HOST_DOCKER_SOCKET', '/var/run/docker.sock'),
    sandboxImage: env('SANDBOX_IMAGE', 'agenthub-sandbox:latest'),
  },
};
```

- [ ] **Step 1.4: Create Prisma client singleton**

```typescript
// agentHub/apps/api/src/db/prisma.ts
import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
```

- [ ] **Step 1.5: Create JWT helpers**

```typescript
// agentHub/apps/api/src/lib/jwt.ts
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface JwtPayload {
  userId: string;
  githubLogin: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
```

- [ ] **Step 1.6: Run Prisma migrate**

Run: `cd agentHub/apps/api && bunx prisma migrate dev --name init`

---

### Task 2: Hono App + Middleware + Auth Routes

**Files:** Create `apps/api/src/index.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/middleware/whitelist.ts`, `apps/api/src/routes/auth.ts`

- [ ] **Step 2.1: Create auth middleware**

```typescript
// agentHub/apps/api/src/middleware/auth.ts
import { Context, Next } from 'hono';
import { verifyToken } from '../lib/jwt';

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const payload = verifyToken(authHeader.slice(7));
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
}
```

- [ ] **Step 2.2: Create whitelist middleware**

```typescript
// agentHub/apps/api/src/middleware/whitelist.ts
import { config } from '../config';

export function isUserAllowed(githubLogin: string): boolean {
  return config.github.allowedUsers.includes(githubLogin);
}
```

- [ ] **Step 2.3: Create auth routes**

```typescript
// agentHub/apps/api/src/routes/auth.ts
import { Hono } from 'hono';
import { signToken, JwtPayload } from '../lib/jwt';
import { prisma } from '../db/prisma';
import { config } from '../config';
import { isUserAllowed } from '../middleware/whitelist';

const auth = new Hono();

// Step 1: Redirect to GitHub
auth.get('/github', (c) => {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.github.clientId);
  url.searchParams.set('redirect_uri', config.github.callbackUrl);
  url.searchParams.set('scope', 'read:user user:email');
  return c.redirect(url.toString());
});

// Step 2: GitHub callback — exchange code for token, fetch user, check whitelist
auth.get('/github/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.json({ error: 'Missing code' }, 400);

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
    }),
  });
  const tokenData = await tokenRes.json() as any;
  if (!tokenData.access_token) {
    return c.json({ error: 'Failed to get access token' }, 400);
  }

  // Fetch GitHub user
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const githubUser = await userRes.json() as any;

  // Check whitelist
  if (!isUserAllowed(githubUser.login)) {
    return c.html('<h1>Access Denied</h1><p>Your GitHub account is not in the allowed list.</p>', 403);
  }

  // Upsert user
  const user = await prisma.user.upsert({
    where: { githubId: githubUser.id },
    update: { login: githubUser.login, avatarUrl: githubUser.avatar_url },
    create: {
      githubId: githubUser.id,
      login: githubUser.login,
      avatarUrl: githubUser.avatar_url,
      email: githubUser.email,
    },
  });

  const token = signToken({ userId: user.id, githubLogin: user.login });
  // Redirect to frontend with token in query param
  return c.redirect(`http://localhost:5173/auth/callback?token=${token}`);
});

// Get current user
auth.get('/me', async (c) => {
  const payload = c.get('user') as JwtPayload;
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json({
    id: user.id,
    login: user.login,
    avatarUrl: user.avatarUrl,
  });
});

export { auth };
```

- [ ] **Step 2.4: Create main entry point**

```typescript
// agentHub/apps/api/src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from './routes/auth';
import { sessions } from './routes/sessions';
import { chat } from './routes/chat';
import { upgradeWebSocket } from './ws/handler';
import { authMiddleware } from './middleware/auth';
import { config } from './config';

const app = new Hono();

app.use('*', cors({ origin: 'http://localhost:5173', credentials: true }));

// Public routes
app.route('/api/auth', auth);

// Protected routes (stubs — implemented in later tasks)
app.use('/api/*', authMiddleware);
app.route('/api/sessions', sessions);
app.route('/api/chat', chat);

// WebSocket: Hono doesn't have native WS upgrade in all versions,
// so we handle it via Bun's native server in ws/handler.ts

export default {
  port: config.port,
  fetch: app.fetch,
  websocket: upgradeWebSocket,
};
```

Note: We'll use Bun.serve with WebSocket support. The actual server entry will be refactored in Task 5 when we integrate WebSocket properly. For now, this creates the HTTP skeleton.

---

### Task 3: Session + Chat REST Routes

**Files:** Create `apps/api/src/routes/sessions.ts`, `apps/api/src/routes/chat.ts`

- [ ] **Step 3.1: Create session routes**

```typescript
// agentHub/apps/api/src/routes/sessions.ts
import { Hono } from 'hono';
import { prisma } from '../db/prisma';

const sessions = new Hono();

// List sessions for current user
sessions.get('/', async (c) => {
  const { userId } = c.get('user') as any;
  const list = await prisma.session.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } },
  });
  return c.json(list.map(s => ({
    id: s.id,
    title: s.title,
    lastMessage: s.messages[0]?.content?.slice(0, 80) ?? null,
    updatedAt: s.updatedAt,
  })));
});

// Create session
sessions.post('/', async (c) => {
  const { userId } = c.get('user') as any;
  const session = await prisma.session.create({
    data: { userId, title: 'New Session' },
  });
  return c.json(session, 201);
});

// Get session with messages
sessions.get('/:id', async (c) => {
  const { userId } = c.get('user') as any;
  const session = await prisma.session.findFirst({
    where: { id: c.req.param('id'), userId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!session) return c.json({ error: 'Not found' }, 404);
  return c.json(session);
});

// Delete session
sessions.delete('/:id', async (c) => {
  const { userId } = c.get('user') as any;
  await prisma.session.deleteMany({
    where: { id: c.req.param('id'), userId },
  });
  return c.body(null, 204);
});

export { sessions };
```

- [ ] **Step 3.2: Create chat route (message send, triggers agent)**

```typescript
// agentHub/apps/api/src/routes/chat.ts
import { Hono } from 'hono';
import { prisma } from '../db/prisma';
import { z } from 'zod';

const chat = new Hono();

const sendSchema = z.object({
  sessionId: z.string(),
  content: z.string().min(1),
});

// Send message — creates DB record, agent execution handled by WebSocket pipeline
chat.post('/send', async (c) => {
  const { userId } = c.get('user') as any;
  const body = await c.req.json();
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const { sessionId, content } = parsed.data;

  // Verify session ownership
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // Save user message
  const userMsg = await prisma.message.create({
    data: { sessionId, senderType: 'human', content, status: 'done' },
  });

  // Create placeholder agent message (will be filled by WebSocket stream)
  const agentMsg = await prisma.message.create({
    data: { sessionId, senderType: 'agent', content: '', status: 'streaming' },
  });

  // Update session timestamp
  await prisma.session.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  });

  // Return message IDs so frontend can subscribe to the stream
  return c.json({
    userMessageId: userMsg.id,
    agentMessageId: agentMsg.id,
  }, 201);
});

export { chat };
```

This route creates the DB records and returns IDs. The actual Claude Code execution is triggered by the WebSocket handler (Task 5), which reads the pending message and spawns the agent.

---

### Task 4: Sandbox Manager (Dockerode)

**Files:** Create `apps/api/src/agent/SandboxManager.ts`

- [ ] **Step 4.1: Write SandboxManager**

```typescript
// agentHub/apps/api/src/agent/SandboxManager.ts
import Docker from 'dockerode';
import { config } from '../config';

const docker = new Docker({ socketPath: config.docker.socketPath });

export interface SandboxInfo {
  containerId: string;
  workDir: string;
}

export class SandboxManager {
  // Create a new sandbox container for a session
  static async create(sessionId: string): Promise<SandboxInfo> {
    const containerName = `agenthub-sandbox-${sessionId}`;
    const workDir = `/workspace`;

    // Remove existing container with same name if any
    await this.cleanup(containerName);

    const container = await docker.createContainer({
      name: containerName,
      Image: config.docker.sandboxImage,
      WorkingDir: workDir,
      Tty: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        // Mount Docker socket for nested Docker access (optional)
        // Use tmpfs for /workspace to auto-clean on stop
        Memory: 512 * 1024 * 1024,  // 512MB limit
        MemorySwap: 1024 * 1024 * 1024, // 1GB swap
        NetworkMode: 'bridge',
      },
    });

    await container.start();

    return {
      containerId: container.id,
      workDir,
    };
  }

  // Execute a command inside the container
  static async exec(containerId: string, command: string[], workDir?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: command,
      WorkingDir: workDir ?? '/workspace',
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false, Tty: false });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      // Dockerode combines stdout/stderr in multiplexed stream
      docker.modem.demuxStream(stream, {
        write: (chunk: Buffer) => { stdout += chunk.toString(); },
      }, {
        write: (chunk: Buffer) => { stderr += chunk.toString(); },
      });
      stream.on('end', async () => {
        const inspect = await exec.inspect();
        resolve({ stdout, stderr, exitCode: inspect.ExitCode ?? 0 });
      });
      stream.on('error', reject);
    });
  }

  // Stop and remove a container
  static async destroy(containerId: string): Promise<void> {
    try {
      const container = docker.getContainer(containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode === 404) return; // Already gone
      throw err;
    }
  }

  // Clean up by container name
  private static async cleanup(containerName: string): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true, filters: { name: [containerName] } });
      for (const c of containers) {
        await this.destroy(c.Id);
      }
    } catch { /* ignore cleanup errors */ }
  }
}
```

---

### Task 5: Claude Code Process Manager + Event Parser

**Files:** Create `apps/api/src/agent/ClaudeCodeProcess.ts`, `apps/api/src/agent/EventParser.ts`

- [ ] **Step 5.1: Create EventParser**

```typescript
// agentHub/apps/api/src/agent/EventParser.ts

export type ParsedEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; content: string }
  | { type: 'permission_request'; tool: string; path?: string }
  | { type: 'subagent_start'; agentType: string; description: string }
  | { type: 'subagent_result'; agentType: string }
  | { type: 'system'; subtype: string; message: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

export class EventParser {
  static parseLine(line: string): ParsedEvent | null {
    if (!line.trim()) return null;
    try {
      const data = JSON.parse(line);
      return this.classify(data);
    } catch {
      // Non-JSON line (raw stdout) — treat as text
      return { type: 'text', content: line };
    }
  }

  private static classify(data: any): ParsedEvent | null {
    switch (data.type) {
      case 'assistant':
        // Extract text content from assistant message
        if (data.message?.content) {
          const textParts = data.message.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          if (textParts) return { type: 'text', content: textParts };
        }
        return null;

      case 'tool_use':
        return {
          type: 'tool_use',
          toolName: data.name,
          input: data.input ?? {},
        };

      case 'tool_result':
        return { type: 'tool_result', content: data.content ?? '' };

      case 'permission_request':
        return {
          type: 'permission_request',
          tool: data.tool,
          path: data.path,
        };

      case 'subagent_start':
        return {
          type: 'subagent_start',
          agentType: data.agent_type,
          description: data.description ?? '',
        };

      case 'subagent_result':
        return { type: 'subagent_result', agentType: data.agent_type };

      case 'system':
        return {
          type: 'system',
          subtype: data.subtype ?? 'unknown',
          message: data.message ?? '',
        };

      default:
        // Unknown event type — ignore
        return null;
    }
  }
}
```

- [ ] **Step 5.2: Create ClaudeCodeProcess**

```typescript
// agentHub/apps/api/src/agent/ClaudeCodeProcess.ts
import { ChildProcess, spawn } from 'child_process';
import { EventParser, ParsedEvent } from './EventParser';

export type EventHandler = (event: ParsedEvent) => void;

export class ClaudeCodeProcess {
  private process: ChildProcess | null = null;
  private handlers: EventHandler[] = [];

  onEvent(handler: EventHandler) {
    this.handlers.push(handler);
  }

  private emit(event: ParsedEvent) {
    for (const h of this.handlers) h(event);
  }

  async start(sessionId: string, prompt: string, workDir: string, trustMode = false): Promise<void> {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
    ];
    if (trustMode) args.push('--dangerously-skip-permissions');

    // Add session-specific config
    args.push('--session-id', sessionId);

    this.process = spawn('claude', args, {
      cwd: workDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const event = EventParser.parseLine(line);
        if (event) this.emit(event);
      }
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.emit({ type: 'error', message: chunk.toString() });
    });

    this.process.on('close', (code) => {
      this.emit({ type: 'done', exitCode: code ?? 1 });
      this.process = null;
    });
  }

  // Write to stdin (for permission responses: "allow\n" or "deny\n")
  write(input: string) {
    this.process?.stdin?.write(input);
  }

  // Force kill the process
  kill() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
```

---

### Task 6: WebSocket Handler (Full Integration)

**Files:** Modify `apps/api/src/index.ts`, Create `apps/api/src/ws/handler.ts`

- [ ] **Step 6.1: Create WebSocket handler**

```typescript
// agentHub/apps/api/src/ws/handler.ts
import type { ServerWebSocket } from 'bun';
import { ClaudeCodeProcess } from '../agent/ClaudeCodeProcess';
import { SandboxManager } from '../agent/SandboxManager';
import { prisma } from '../db/prisma';
import { verifyToken } from '../lib/jwt';

// Track active connections: sessionId -> Set<WebSocket>
const sessions = new Map<string, Set<ServerWebSocket<any>>>();

export async function handleWebSocket(ws: ServerWebSocket<any>) {
  const url = new URL(ws.data.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');

  if (!token || !sessionId) {
    ws.close(1008, 'Missing token or sessionId');
    return;
  }

  // Verify JWT
  let userId: string;
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch {
    ws.close(1008, 'Invalid token');
    return;
  }

  // Verify session ownership
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  // Register connection
  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId)!.add(ws);

  // Ensure sandbox exists
  if (!session.sandboxContainerId) {
    const sandbox = await SandboxManager.create(sessionId);
    await prisma.session.update({
      where: { id: sessionId },
      data: { sandboxContainerId: sandbox.containerId },
    });
    session.sandboxContainerId = sandbox.containerId;
  }

  ws.send(JSON.stringify({ type: 'connected', sessionId }));

  ws.on('message', async (raw: string) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'chat') {
        await handleChatMessage(ws, sessionId, msg.content);
      } else if (msg.type === 'permission_response') {
        // Forwarded to active agent process
        handlePermissionResponse(sessionId, msg.permissionId, msg.action);
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: String(err) }));
    }
  });

  ws.on('close', () => {
    const conns = sessions.get(sessionId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        sessions.delete(sessionId);
        // Optionally cleanup sandbox after timeout
      }
    }
  });
}

// Active agent processes: sessionId -> ClaudeCodeProcess
const activeAgents = new Map<string, ClaudeCodeProcess>();

async function handleChatMessage(ws: ServerWebSocket<any>, sessionId: string, content: string) {
  // Create agent process
  const agent = new ClaudeCodeProcess();

  // Collect streaming content for DB save
  let fullContent = '';
  let agentMessageId: string | null = null;

  agent.onEvent(async (event) => {
    if (event.type === 'text') {
      fullContent += event.content;
      broadcast(sessionId, {
        type: 'stream_chunk',
        content: event.content,
        agentMessageId,
      });
    } else if (event.type === 'tool_use') {
      broadcast(sessionId, {
        type: 'agent_status',
        status: 'running',
        currentTool: `${event.toolName}(${JSON.stringify(event.input).slice(0, 100)})`,
      });
    } else if (event.type === 'permission_request') {
      broadcast(sessionId, {
        type: 'permission_request',
        permissionId: Date.now().toString(),
        tool: event.tool,
        path: event.path,
      });
    } else if (event.type === 'done') {
      // Update agent message in DB
      if (agentMessageId) {
        await prisma.message.update({
          where: { id: agentMessageId },
          data: { content: fullContent, status: event.exitCode === 0 ? 'done' : 'error' },
        });
      }
      broadcast(sessionId, { type: 'stream_end', exitCode: event.exitCode, agentMessageId });
      activeAgents.delete(sessionId);
    } else if (event.type === 'error') {
      broadcast(sessionId, { type: 'stream_error', message: event.message });
    }
  });

  // Save placeholder agent message
  const agentMsg = await prisma.message.create({
    data: { sessionId, senderType: 'agent', content: '', status: 'streaming' },
  });
  agentMessageId = agentMsg.id;

  activeAgents.set(sessionId, agent);

  // Start agent in sandbox
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  const workDir = '/workspace';
  await agent.start(sessionId, content, workDir, false);
}

function handlePermissionResponse(sessionId: string, permissionId: string, action: 'allow' | 'deny') {
  const agent = activeAgents.get(sessionId);
  if (agent) {
    agent.write(action === 'allow' ? 'allow\n' : 'deny\n');
  }
}

function broadcast(sessionId: string, message: object) {
  const conns = sessions.get(sessionId);
  if (!conns) return;
  const data = JSON.stringify(message);
  for (const ws of conns) {
    try { ws.send(data); } catch { /* ignore send errors */ }
  }
}

// Bun upgrade handler for Hono integration
export const upgradeWebSocket = {
  open: handleWebSocket,
};
```

- [ ] **Step 6.2: Update main entry to use Bun.serve with WebSocket**

```typescript
// agentHub/apps/api/src/index.ts (updated version)
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from './routes/auth';
import { sessions } from './routes/sessions';
import { chat } from './routes/chat';
import { authMiddleware } from './middleware/auth';
import { handleWebSocket } from './ws/handler';
import { config } from './config';

const app = new Hono();

app.use('*', cors({ origin: ['http://localhost:5173'], credentials: true }));

// Public routes
app.route('/api/auth', auth);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Protected routes
app.use('/api/sessions/*', authMiddleware);
app.use('/api/chat/*', authMiddleware);
app.route('/api/sessions', sessions);
app.route('/api/chat', chat);

// Bun native server with WebSocket
const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  websocket: {
    open: (ws) => handleWebSocket(ws),
  },
});

console.log(`AgentHub API running on http://localhost:${server.port}`);
```

---

## Wave 2 — Frontend (can run parallel to Wave 1 after Wave 0)

### Task 7: Vite Setup + Tailwind + shadcn/ui Init

**Files:** Create `apps/web/vite.config.ts`, `apps/web/tailwind.config.js`, `apps/web/postcss.config.js`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/index.css`

- [ ] **Step 7.1: Create Vite config**

```typescript
// agentHub/apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@agenthub/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: { port: 5173 },
});
```

- [ ] **Step 7.2: Create Tailwind config**

```javascript
// agentHub/apps/web/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [],
};
```

```javascript
// agentHub/apps/web/postcss.config.js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 7.3: Create index.html and main.tsx**

```html
<!-- agentHub/apps/web/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AgentHub</title>
</head>
<body class="bg-gray-950 text-gray-100">
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

```tsx
// agentHub/apps/web/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

- [ ] **Step 7.4: Create base CSS with Tailwind directives**

```css
/* agentHub/apps/web/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

* { margin: 0; padding: 0; box-sizing: border-box; }

/* Custom scrollbar for chat */
.chat-scroll::-webkit-scrollbar { width: 6px; }
.chat-scroll::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
.chat-scroll::-webkit-scrollbar-track { background: transparent; }
```

- [ ] **Step 7.5: Verify Vite dev server starts**

Run: `cd agentHub/apps/web && bun run dev`
Expected: Vite starts on port 5173, blank page loads.

---

### Task 8: Zustand Store + API Client + Auth Hook

**Files:** Create `apps/web/src/store/appStore.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/hooks/useAuth.ts`, `apps/web/src/App.tsx`

- [ ] **Step 8.1: Create API client**

```typescript
// agentHub/apps/web/src/lib/api.ts

const BASE_URL = 'http://localhost:3000/api';

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
  return res.json();
}

export const api = {
  getMe: () => request<any>('/auth/me'),

  getSessions: () => request<any[]>('/sessions'),

  createSession: () => request<any>('/sessions', { method: 'POST' }),

  getSession: (id: string) => request<any>(`/sessions/${id}`),

  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),

  sendMessage: (sessionId: string, content: string) =>
    request<{ userMessageId: string; agentMessageId: string }>('/chat/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, content }),
    }),
};
```

- [ ] **Step 8.2: Create Zustand store**

```typescript
// agentHub/apps/web/src/store/appStore.ts
import { create } from 'zustand';
import type { Session, Message } from '@agenthub/shared';

interface AppState {
  token: string | null;
  user: { id: string; login: string; avatarUrl: string } | null;
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;

  setToken: (token: string | null) => void;
  setUser: (user: any) => void;
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  addMessage: (sessionId: string, msg: Message) => void;
  appendToMessage: (sessionId: string, msgId: string, chunk: string) => void;
  setMessageStatus: (sessionId: string, msgId: string, status: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  token: localStorage.getItem('agenthub_token'),
  user: null,
  sessions: [],
  activeSessionId: null,
  messages: {},

  setToken: (token) => {
    if (token) localStorage.setItem('agenthub_token', token);
    else localStorage.removeItem('agenthub_token');
    set({ token });
  },

  setUser: (user) => set({ user }),

  setSessions: (sessions) => set({ sessions }),

  setActiveSession: (id) => set({ activeSessionId: id }),

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
            m.id === msgId ? { ...m, status } : m
          ),
        },
      };
    }),
}));
```

- [ ] **Step 8.3: Create auth hook**

```typescript
// agentHub/apps/web/src/hooks/useAuth.ts
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function useAuth() {
  const { token, user, setToken, setUser } = useAppStore();
  const isLoggedIn = !!token && !!user;

  // On mount, verify token by fetching /me
  useEffect(() => {
    if (token && !user) {
      api.getMe()
        .then(setUser)
        .catch(() => setToken(null));
    }
  }, [token]);

  const login = () => {
    window.location.href = 'http://localhost:3000/api/auth/github';
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  // Parse token from callback URL
  const handleCallback = () => {
    const params = new URLSearchParams(window.location.search);
    const cbToken = params.get('token');
    if (cbToken) {
      setToken(cbToken);
      window.history.replaceState({}, '', '/');
    }
  };

  return { isLoggedIn, user, token, login, logout, handleCallback };
}
```

- [ ] **Step 8.4: Create App with routing**

```tsx
// agentHub/apps/web/src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './store/appStore';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './components/LoginPage';
import { AuthCallback } from './components/AuthCallback';

export function App() {
  const token = useAppStore((s) => s.token);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={token ? <ChatPage /> : <Navigate to="/login" />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
      </Routes>
    </BrowserRouter>
  );
}
```

### Task 9: Chat UI Components

**Files:** Create `apps/web/src/components/LoginPage.tsx`, `apps/web/src/components/AuthCallback.tsx`, `apps/web/src/components/SessionList.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/MessageBubble.tsx`, `apps/web/src/components/MessageInput.tsx`, `apps/web/src/pages/ChatPage.tsx`

- [ ] **Step 9.1: LoginPage**

```tsx
// agentHub/apps/web/src/components/LoginPage.tsx
import { useAuth } from '../hooks/useAuth';
import { Github } from 'lucide-react';

export function LoginPage() {
  const { login, isLoggedIn } = useAuth();
  if (isLoggedIn) return null; // Will redirect

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-2">AgentHub</h1>
        <p className="text-gray-400 mb-8">IM-powered AI agent collaboration</p>
        <button
          onClick={login}
          className="inline-flex items-center gap-2 px-6 py-3 bg-white text-black rounded-lg hover:bg-gray-200 transition font-medium"
        >
          <Github className="w-5 h-5" />
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 9.2: AuthCallback**

```tsx
// agentHub/apps/web/src/components/AuthCallback.tsx
import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function AuthCallback() {
  const { handleCallback, token } = useAuth();

  useEffect(() => {
    handleCallback();
  }, []);

  if (token) return <Navigate to="/" />;

  return <div className="flex items-center justify-center min-h-screen text-gray-400">
    Authenticating...
  </div>;
}
```

- [ ] **Step 9.3: SessionList**

```tsx
// agentHub/apps/web/src/components/SessionList.tsx
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { Plus, MessageSquare, Trash2 } from 'lucide-react';
import { useEffect } from 'react';

export function SessionList() {
  const { sessions, activeSessionId, setSessions, setActiveSession, user } = useAppStore();

  useEffect(() => {
    api.getSessions().then(setSessions).catch(console.error);
  }, []);

  const handleCreate = async () => {
    const session = await api.createSession();
    setSessions([session, ...sessions]);
    setActiveSession(session.id);
  };

  const handleSelect = async (id: string) => {
    setActiveSession(id);
    const session = await api.getSession(id);
    useAppStore.setState((s) => ({
      messages: { ...s.messages, [id]: session.messages },
    }));
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteSession(id);
    setSessions(sessions.filter((s) => s.id !== id));
    if (activeSessionId === id) setActiveSession(sessions[0]?.id ?? null);
  };

  return (
    <div className="w-64 h-full bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <h2 className="font-semibold text-white">Sessions</h2>
        <button onClick={handleCreate} className="p-1 hover:bg-gray-800 rounded" title="New Session">
          <Plus className="w-4 h-4 text-gray-400" />
        </button>
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
            <MessageSquare className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-300 truncate">{s.title}</div>
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

- [ ] **Step 9.4: MessageBubble**

```tsx
// agentHub/apps/web/src/components/MessageBubble.tsx
import { User, Bot } from 'lucide-react';
import type { Message } from '@agenthub/shared';

interface Props {
  message: Message;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming }: Props) {
  const isHuman = message.senderType === 'human';
  return (
    <div className={`flex gap-3 px-4 py-3 ${isHuman ? 'flex-row-reverse' : ''}`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
        isHuman ? 'bg-blue-600' : 'bg-purple-600'
      }`}>
        {isHuman ? <User className="w-4 h-4 text-white" /> : <Bot className="w-4 h-4 text-white" />}
      </div>
      <div className={`max-w-[75%] ${isHuman ? 'items-end' : 'items-start'}`}>
        <div className="text-xs text-gray-500 mb-1">{isHuman ? 'You' : 'Agent'}</div>
        <div className={`rounded-lg px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap font-mono ${
          isHuman ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-200'
        }`}>
          {message.content || (isStreaming && <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse" />)}
          {message.status === 'error' && (
            <span className="text-red-400 text-xs ml-2">(Error)</span>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 9.5: MessageInput**

```tsx
// agentHub/apps/web/src/components/MessageInput.tsx
import { useState, useRef, KeyboardEvent } from 'react';
import { Send } from 'lucide-react';

interface Props {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    ref.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-gray-800 p-4">
      <div className="flex gap-2 items-end">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
          rows={1}
          className="flex-1 bg-gray-800 text-gray-200 rounded-lg px-4 py-3 resize-none focus:outline-none focus:ring-1 focus:ring-purple-500 text-sm"
          disabled={disabled}
        />
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

- [ ] **Step 9.6: ChatView + useChat hook**

```typescript
// agentHub/apps/web/src/hooks/useChat.ts
import { useRef, useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import type { Message } from '@agenthub/shared';

export function useChat(sessionId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const token = useAppStore((s) => s.token);
  const { addMessage, appendToMessage, setMessageStatus } = useAppStore();

  const connect = useCallback(() => {
    if (!token || !sessionId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`ws://localhost:3000/ws?token=${token}&sessionId=${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => console.log('WS connected');
    ws.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === 'stream_chunk') {
        appendToMessage(sessionId, data.agentMessageId, data.content);
      } else if (data.type === 'stream_end') {
        setMessageStatus(sessionId, data.agentMessageId, data.exitCode === 0 ? 'done' : 'error');
      } else if (data.type === 'stream_error') {
        setMessageStatus(sessionId, data.agentMessageId ?? '', 'error');
      }
    };
    ws.onclose = () => { wsRef.current = null; };
  }, [sessionId, token]);

  const send = useCallback(async (content: string) => {
    // Optimistic user message
    const userMsg: any = {
      id: 'temp-' + Date.now(),
      sessionId,
      senderType: 'human',
      content,
      status: 'done',
      createdAt: new Date().toISOString(),
    };
    addMessage(sessionId, userMsg);

    // Ensure WS connection
    connect();

    // Send message via REST API, then trigger via WS
    const result = await api.sendMessage(sessionId, content);

    // Optimistic agent placeholder
    const agentMsg: any = {
      id: result.agentMessageId,
      sessionId,
      senderType: 'agent',
      content: '',
      status: 'streaming',
      createdAt: new Date().toISOString(),
    };
    addMessage(sessionId, agentMsg);

    // Trigger agent start via WebSocket
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat', content }));
    }
  }, [sessionId, connect, addMessage]);

  return { send, connect };
}
```

```tsx
// agentHub/apps/web/src/components/ChatView.tsx
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';

export function ChatView() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const messages = useAppStore((s) => activeSessionId ? s.messages[activeSessionId] ?? [] : []);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { send, connect } = useChat(activeSessionId ?? '');

  useEffect(() => {
    if (activeSessionId) connect();
  }, [activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Select or create a session to start
      </div>
    );
  }

  const hasRunningAgent = messages.some((m: any) => m.status === 'streaming');

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex-1 overflow-y-auto chat-scroll">
        {messages.map((msg: any) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isStreaming={msg.status === 'streaming'}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      <MessageInput onSend={send} disabled={hasRunningAgent} />
    </div>
  );
}
```

- [ ] **Step 9.7: ChatPage layout**

```tsx
// agentHub/apps/web/src/pages/ChatPage.tsx
import { SessionList } from '../components/SessionList';
import { ChatView } from '../components/ChatView';

export function ChatPage() {
  return (
    <div className="h-screen flex">
      <SessionList />
      <ChatView />
    </div>
  );
}
```

---

## Wave 3 — DevOps + Integration

### Task 10: Docker Sandbox Image + docker-compose.yml + Nginx Config

**Files:** Create `docker/sandbox.Dockerfile`, `docker-compose.yml`, `docker/nginx.conf`

- [ ] **Step 10.1: Create sandbox Dockerfile**

```dockerfile
# agentHub/docker/sandbox.Dockerfile
FROM oven/bun:1.1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
```

- [ ] **Step 10.2: Create docker-compose.yml**

```yaml
# agentHub/docker-compose.yml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: docker/api.Dockerfile
    ports:
      - '3000:3000'
    environment:
      - DATABASE_URL=postgresql://agenthub:agenthub@postgres:5432/agenthub
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
      - GITHUB_CALLBACK_URL=${GITHUB_CALLBACK_URL}
      - GITHUB_ALLOWED_USERS=${GITHUB_ALLOWED_USERS}
      - HOST_DOCKER_SOCKET=/var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: agenthub
      POSTGRES_PASSWORD: agenthub
      POSTGRES_DB: agenthub
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U agenthub']
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    volumes:
      - redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 10.3: Create Nginx config for preview proxy**

```nginx
# agentHub/docker/nginx.conf
server {
    listen 80;
    server_name localhost;

    # API + WebSocket
    location /api {
        proxy_pass http://api:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
    location /ws {
        proxy_pass http://api:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Preview proxy for sandbox dev servers
    location ~ ^/preview/(?<session_id>[^/]+)(?<path>/.*)?$ {
        # This will be dynamically configured per-session
        proxy_pass http://127.0.0.1:$preview_port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

- [ ] **Step 10.4: Build sandbox image**

Run: `cd agentHub && docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .`

- [ ] **Step 10.5: Create .env file**

Copy `.env.example` to `.env` and fill in real values.

---

## Verification Checklist

After all tasks complete, verify end-to-end:

1. [ ] `docker compose up` starts all services without errors
2. [ ] `bun run dev` in `apps/api` starts API on port 3000
3. [ ] `bun run dev` in `apps/web` starts frontend on port 5173
4. [ ] `curl http://localhost:3000/api/health` returns `{"status":"ok"}`
5. [ ] Open browser → see Login page → click "Sign in with GitHub"
6. [ ] After OAuth callback → redirected to chat page
7. [ ] Create a new session → type a message → Agent bubble appears
8. [ ] Agent stream outputs text character by character
9. [ ] Refresh page → messages persist
10. [ ] Create multiple sessions → switch between them → messages are isolated
