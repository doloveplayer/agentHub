import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { Server } from 'http';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import { config } from './config.js';
import { attachWebSocket, setTaskQueueManager, broadcast } from './ws/handler.js';
import { ProviderFactory } from './agent/providers/factory.js';
import { SandboxManager } from './agent/SandboxManager.js';
import { prisma } from './db/prisma.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import agentRoutes from './routes/agents.js';
import workspaceRoutes from './routes/workspace.js';

// Startup cleanup: remove orphaned sandbox containers and directories
// from previous backend runs
try {
  execSync("docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null", { encoding: 'utf8' });
  execSync("docker rm -f $(docker ps -aq --filter name=agenthub-agent-) 2>/dev/null", { encoding: 'utf8' });
  console.log('[startup] Cleaned orphaned containers');
} catch { /* no orphaned containers */ }
try {
  execSync(`rm -rf ${config.sandbox.root}/* 2>/dev/null`, { encoding: 'utf8' });
  console.log('[startup] Cleaned orphaned sandbox directories');
} catch { /* nothing to clean */ }

// Clean up stale streaming messages from previous run
try {
  const result = await prisma.message.updateMany({
    where: { status: 'streaming' },
    data: { status: 'done' },
  });
  if (result.count > 0) {
    console.log(`[startup] Reset ${result.count} stale streaming message(s) to done`);
  }
} catch { /* DB might not be ready or prisma not connected yet */ }

// Auto-seed default agents
async function seedDefaultAgents() {
  const { defaultAgents } = await import('./defaultAgents.js');
  const prisma = new PrismaClient();
  try {
    for (const a of defaultAgents) {
      await prisma.agent.upsert({ where: { name: a.name }, update: a, create: a });
    }
    console.log('[seed] Default agents seeded');
  } catch (err: any) {
    console.log('[seed] Agent seed skipped:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

await seedDefaultAgents();

// Initialize agent providers
ProviderFactory.init();

const app = new Hono();

// CORS — allow frontend on localhost:5173
app.use(
  '*',
  cors({
    origin: 'http://localhost:5173',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

// Public routes
app.route('/api/auth', authRoutes);

// Protected routes (middleware applied inside each router)
app.route('/api/sessions', sessionRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/agents', agentRoutes);
app.route('/api/workspace', workspaceRoutes);

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint: test Claude Code auth inside a sandbox container
app.get('/api/debug/claude-auth', async (c) => {
  const debugId = 'debug-' + Date.now();
  try {
    const { buildSafeEnv } = await import('./agent/ClaudeCodeProcess.js');

    const sb = await SandboxManager.create(debugId);
    const safeEnv = buildSafeEnv();

    // Only write critical auth vars — full safeEnv can break shell quoting
    const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
    const envLines: string[] = [];
    for (const k of authKeys) {
      if (safeEnv[k]) envLines.push(`export ${k}='${String(safeEnv[k]).replace(/'/g, "'\\''")}'`);
    }
    writeFileSync(resolve(sb.hostWorkDir, '_env.sh'), envLines.join('\n'), 'utf-8');

    // Test 1: pipe approach (known working)
    const cmd1 = `. /workspace/_env.sh && echo "hello" | claude --print --output-format stream-json --verbose --dangerously-skip-permissions 2>&1 || true`;
    // Test 2: file redirect approach
    const cmd2 = `. /workspace/_env.sh && cat /workspace/_prompt.txt | claude --print --output-format stream-json --verbose --dangerously-skip-permissions 2>&1 || true`;
    // Test 3: without dangerously-skip-permissions
    const cmd3 = `. /workspace/_env.sh && cat /workspace/_prompt.txt | claude --print --output-format stream-json --verbose 2>&1 || true`;
    // Test 4: without env (just cat + claude)
    const cmd4 = `cat /workspace/_prompt.txt | claude --print --output-format stream-json --verbose --dangerously-skip-permissions 2>&1 || true`;

    writeFileSync(resolve(sb.hostWorkDir, '_prompt.txt'), 'say hello', 'utf-8');

    const results: Record<string, string> = {};
    for (const [name, cmd] of [['pipe_ok', cmd1], ['file_redirect', cmd2], ['no_skip_perm', cmd3], ['no_env', cmd4]] as const) {
      let out = '';
      await SandboxManager.execStream(sb.containerId, ['sh', '-c', cmd], {
        workDir: '/workspace',
        onStdout: (d) => { out += d; },
        onStderr: (d) => { out += d; },
      }).catch(() => {});
      results[name] = out.slice(0, 500);
    }

    SandboxManager.destroy(sb.containerId).catch(() => {});
    SandboxManager.destroyHostDir(debugId);
    return c.json(results);
  } catch (err: any) {
    SandboxManager.destroyHostDir(debugId);
    return c.json({ error: err.message }, 500);
  }
});

// Start HTTP server with Hono's Node.js adapter
const server = serve(
  { fetch: app.fetch, port: config.port },
  (info) => {
    console.log(`[api] Server listening on http://localhost:${info.port}`);
  },
);

// Initialize Task Queue (BullMQ + Redis) for Orchestrator
let taskQueueManager: any = null;
try {
  const { TaskQueueManager } = await import('./agent/TaskQueue.js');
  taskQueueManager = new TaskQueueManager();
  taskQueueManager.startWorker((planId: string, taskId: string, result: any) => {
    console.log(`[queue] Task completed: plan=${planId} task=${taskId} output=${String(result?.output || '').slice(0, 100)}`);
    // Broadcast task status update to all connected clients in this session
    // The sessionId is embedded in the job data; we need to look it up
    // For now, broadcast to a known session via the plan lookup
  });
  // Wire Worker failed event to broadcast task_failed
  taskQueueManager.worker?.on('failed', (job: any, err: Error) => {
    if (job?.data?.sessionId) {
      broadcast(job.data.sessionId, {
        type: 'task_failed',
        planId: job.data.planId,
        taskId: job.data.task.id,
        error: err.message,
      });
    }
  });
  // Wire Worker completed event to broadcast task_completed
  taskQueueManager.worker?.on('completed', async (job: any, result: any) => {
    const sid = job?.data?.sessionId;
    const planId = job?.data?.planId;
    if (!sid || !planId) return;

    broadcast(sid, {
      type: 'task_completed', planId,
      taskId: job.data.task.id,
      result: { output: String(result?.output || '').slice(0, 200) },
    });

    // Check if all tasks in this plan are done → broadcast plan_summary
    try {
      const progress = await taskQueueManager.getPlanProgress(planId);
      if (progress.waiting === 0 && progress.running === 0) {
        // All tasks finished (or failed) — generate summary
        const sb = await import('./agent/SandboxManager.js');
        let fileChanges = '';
        try {
          fileChanges = await sb.SandboxManager.execCapture(
            job.data.containerId,
            'git diff --name-only 2>/dev/null || find . -newer /workspace -type f 2>/dev/null | head -20',
          );
        } catch { /* no git */ }

        broadcast(sid, {
          type: 'plan_summary',
          planId,
          total: progress.total,
          completed: progress.completed,
          failed: progress.failed,
          fileChanges: fileChanges.split('\n').filter(Boolean),
        });
      }
    } catch { /* progress check failed */ }
  });
  setTaskQueueManager(taskQueueManager);
  await taskQueueManager.drain();
  console.log('[startup] Task queue initialized');
} catch (err: any) {
  console.log(`[startup] Task queue skipped (Redis not available): ${err.message}`);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[shutdown] Closing task queue...');
  await taskQueueManager?.shutdown();
  process.exit(0);
});

// Attach WebSocket handler (Hono's serve returns a Node http.Server at runtime)
attachWebSocket(server as unknown as Server);

export default app;
