import { execFile } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { buildDeploymentFiles } from '../artifacts/ArtifactTools.js';
import { broadcast } from '../ws/state.js';

const execFileAsync = promisify(execFile);
const deploy = new Hono();
deploy.use('*', authMiddleware);

type DeployTarget = 'docker' | 'vercel' | 'cloudflare';

async function getSessionWorkspace(sessionId: string, userId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return null;
  return resolve(process.cwd(), '..', '..', '.sandboxes', sessionId);
}

deploy.post('/:sessionId/config', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const files = buildDeploymentFiles({
    appName: String(body.appName || `agenthub-${sessionId.slice(0, 8)}`),
    buildCommand: body.buildCommand ? String(body.buildCommand) : undefined,
    startCommand: body.startCommand ? String(body.startCommand) : undefined,
    env: Array.isArray(body.env) ? body.env.map(String) : [],
  });
  writeFileSync(resolve(workDir, 'Dockerfile'), files.dockerfile, 'utf8');
  writeFileSync(resolve(workDir, 'docker-compose.yml'), files.compose, 'utf8');
  writeFileSync(resolve(workDir, '.env.example'), files.envExample, 'utf8');
  return c.json({ files: ['Dockerfile', 'docker-compose.yml', '.env.example'] }, 201);
});

deploy.post('/:sessionId/run', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const target = normalizeTarget(body.target);
  const production = Boolean(body.production);
  if (production && body.confirmPhrase !== `DEPLOY ${target.toUpperCase()}`) {
    return c.json({ error: `Confirmation phrase must be DEPLOY ${target.toUpperCase()}` }, 400);
  }

  const deploymentId = startDeployment(sessionId, workDir, target);
  return c.json({ deploymentId, status: 'queued' }, 202);
});

deploy.post('/:sessionId/rollback', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const workDir = await getSessionWorkspace(sessionId, userId);
  if (!workDir) return c.json({ error: 'Forbidden' }, 403);
  const result = await runShell(workDir, 'docker compose up -d --rollback');
  return c.json({ ok: result.exitCode === 0, output: result.output });
});

export function startDeployment(sessionId: string, workDir: string, target: DeployTarget): string {
  const deploymentId = `dep-${Date.now()}`;
  void runDeployment(sessionId, deploymentId, workDir, target);
  return deploymentId;
}

async function runDeployment(sessionId: string, deploymentId: string, workDir: string, target: DeployTarget): Promise<void> {
  const started = Date.now();
  emit(sessionId, deploymentId, target, 'building', 'Starting build');
  try {
    let build = await runShell(workDir, commandForTarget(target, 'build'));
    if (build.exitCode !== 0) throw new Error(build.output);
    emit(sessionId, deploymentId, target, 'deploying', build.output.slice(-2000));

    const deployResult = await runShell(workDir, commandForTarget(target, 'deploy'));
    if (deployResult.exitCode !== 0) throw new Error(deployResult.output);
    const imageSha = target === 'docker' ? await imageId(workDir) : undefined;
    emit(sessionId, deploymentId, target, 'success', deployResult.output.slice(-2000), {
      buildTimeMs: Date.now() - started,
      imageSha,
      url: extractDeployUrl(deployResult.output),
    });
  } catch (err: any) {
    emit(sessionId, deploymentId, target, 'rolling_back', err.message?.slice(0, 2000) || 'Deploy failed');
    const rollback = target === 'docker' ? await runShell(workDir, 'docker compose up -d --rollback') : { output: 'Rollback is provider-managed', exitCode: 0 };
    emit(sessionId, deploymentId, target, 'failed', rollback.output.slice(-2000), { error: err.message });
  }
}

function emit(sessionId: string, deploymentId: string, target: DeployTarget, status: string, log: string, extra: Record<string, unknown> = {}) {
  broadcast(sessionId, {
    type: 'deployment_status',
    deploymentId,
    target,
    status,
    log,
    timestamp: Date.now(),
    ...extra,
  });
}

export function normalizeTarget(value: unknown): DeployTarget {
  if (value === 'vercel' || value === 'cloudflare' || value === 'docker') return value;
  return 'docker';
}

function commandForTarget(target: DeployTarget, stage: 'build' | 'deploy'): string {
  if (target === 'vercel') {
    if (!process.env.VERCEL_TOKEN) throw new Error('VERCEL_TOKEN is required for Vercel deployment');
    return stage === 'build'
      ? 'npx vercel build --token "$VERCEL_TOKEN"'
      : 'npx vercel deploy --prebuilt --prod --token "$VERCEL_TOKEN"';
  }
  if (target === 'cloudflare') {
    if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required for Cloudflare Pages deployment');
    return stage === 'build'
      ? 'npm run build'
      : 'npx wrangler pages deploy dist --commit-dirty=true';
  }
  return stage === 'build' ? 'docker compose build' : 'docker compose up -d';
}

async function runShell(cwd: string, command: string): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-lc', command], {
      cwd,
      timeout: 15 * 60_000,
      maxBuffer: 1024 * 1024 * 5,
      env: process.env,
    });
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (err: any) {
    return { exitCode: err.code || 1, output: `${err.stdout || ''}${err.stderr || ''}${err.message || ''}` };
  }
}

async function imageId(cwd: string): Promise<string | undefined> {
  const result = await runShell(cwd, 'docker compose images -q | head -n 1');
  return result.output.trim() || undefined;
}

function extractDeployUrl(output: string): string | undefined {
  return output.match(/https?:\/\/[^\s)]+/)?.[0];
}

export default deploy;
