import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';
import { SandboxManager } from '../agent/SandboxManager.js';
import { parseTestOutput } from '../artifacts/ArtifactTools.js';
import { broadcast } from '../ws/state.js';

const testRoutes = new Hono();
testRoutes.use('*', authMiddleware);

async function getSessionContainer(sessionId: string, userId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId || !session.sandboxContainerId) return null;
  return session.sandboxContainerId;
}

testRoutes.post('/:sessionId/run', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const containerId = await getSessionContainer(sessionId, userId);
  if (!containerId) return c.json({ error: 'Sandbox not ready' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const command = String(body.command || 'npm test');
  let output = '';
  const result = await SandboxManager.execStream(containerId, ['sh', '-lc', command], {
    workDir: '/workspace',
    onStdout: (chunk) => { output += chunk; },
    onStderr: (chunk) => { output += chunk; },
  });
  const report = parseTestOutput(output);
  broadcast(sessionId, { type: 'test_report', report, exitCode: result.exitCode, timestamp: Date.now() });
  return c.json({ report, exitCode: result.exitCode });
});

testRoutes.post('/:sessionId/generate', async (c) => {
  const { userId } = c.get('user');
  const sessionId = c.req.param('sessionId');
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    prompt: `请以 TestAgent 身份分析并为以下目标生成测试：${body.target || '当前项目'}。生成后运行测试并汇报通过/失败/耗时。`,
  });
});

export default testRoutes;
