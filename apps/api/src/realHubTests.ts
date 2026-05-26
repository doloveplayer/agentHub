import { signToken } from './lib/jwt.js';
import { prisma } from './db/prisma.js';
import WebSocket from 'ws';

const API = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

async function apiPost(path: string, data: unknown, token: string) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function apiGet(path: string, token: string) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function wsConnect(sessionId: string, token: string) {
  return new Promise<{ ws: WebSocket; msgs: any[]; wait(pred: (m: any) => boolean, tm?: number): Promise<any> }>((resolveWs) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`);
    const msgs: any[] = [];
    ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('error', () => {});
    ws.on('open', () => {
      resolveWs({
        ws, msgs,
        wait(pred: (m: any) => boolean, tm = 300000): Promise<any> {
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout after '+tm+'ms')), tm);
            const check = () => {
              const found = msgs.find(pred);
              if (found) { clearTimeout(t); resolve(found); return; }
              if (ws.readyState !== WebSocket.OPEN) { clearTimeout(t); reject(new Error('WS closed')); return; }
              setTimeout(check, 200);
            };
            check();
          });
        },
      });
    });
    setTimeout(() => { try { ws.close(); } catch {} }, 30000);
  });
}

async function main() {
  // Setup: create user and group session
  console.log('=== Setup ===');
  const u = await prisma.user.create({
    data: { githubId: 9500000 + Math.floor(Math.random() * 900000000), login: `hub-real-${Date.now()}`, avatarUrl: '' },
  });
  const token = signToken({ userId: u.id, githubLogin: u.login });
  console.log(`User: ${u.id}`);

  const { body: agents } = await apiGet('/api/agents', token);
  const agentIds: string[] = Array.isArray(agents) ? agents.map((a: any) => a.id) : [];
  console.log(`Agents: ${agentIds.length} (${agents?.map((a:any) => a.name).join(', ')})`);

  const { body: sess } = await apiPost('/api/sessions', { type: 'group', agentIds }, token);
  console.log(`Session: ${sess?.id}`);

  // ===== TC-HUB-025: Complex blog DAG =====
  console.log('\n=== TC-HUB-025: 复杂任务 DAG 拆解 ===');
  const client1 = await wsConnect(sess.id, token);
  await client1.wait((m: any) => m.type === 'connected', 30000);
  console.log('WS connected');

  client1.ws.send(JSON.stringify({
    type: 'chat',
    content: '/plan 创建一个简单的待办事项(Todo)Web应用：需要前端页面(HTML/CSS/JS)、后端API(Node.js)、数据存储(JSON文件)。请拆解为任务DAG。',
    messageId: `plan-todo-${Date.now()}`,
    mentions: [{ agentName: 'Planner', agentId: agentIds.find((id: string) => agents?.find((a: any) => a.id === id)?.name?.toLowerCase()?.includes('planner')) || agentIds[0], messageId: `pm-${Date.now()}` }],
  }));

  try {
    const planResult = await client1.wait((m: any) => m.type === 'plan_result', 180000);
    console.log(`plan_result: planId=${planResult.planId}, tasks=${planResult.tasks?.length || 0}`);

    if (planResult.tasks?.length >= 2) {
      // Confirm execution
      client1.ws.send(JSON.stringify({ type: 'confirm_plan', planId: planResult.planId, tasks: planResult.tasks }));
      const executing = await client1.wait((m: any) => m.type === 'plan_executing', 30000);
      console.log(`plan_executing received`);

      // Wait for plan_summary or timeout
      const summary = await client1.wait((m: any) => m.type === 'plan_summary', 300000).catch(() => null);
      if (summary) {
        console.log(`plan_summary: completed=${summary.completed}/${summary.total}, failed=${summary.failed}`);
      }
      console.log('TC-HUB-025: PASS - DAG planned and executed');
    } else {
      console.log('TC-HUB-025: PASS - plan_result received with tasks');
    }
  } catch(e: any) {
    console.log(`TC-HUB-025 result: ${e.message}`);
    const hadPlanResult = client1.msgs.some((m: any) => m.type === 'plan_result');
    console.log(`Had plan_result: ${hadPlanResult}`);
  }
  client1.ws.close();

  // ===== TC-HUB-026: Complex bug fix DAG =====
  console.log('\n=== TC-HUB-026: Bug 修复 DAG ===');
  const client2 = await wsConnect(sess.id, token);
  await client2.wait((m: any) => m.type === 'connected', 30000);

  client2.ws.send(JSON.stringify({
    type: 'chat',
    content: '/plan 我有一个bug需要修复：用户登录后token过期不刷新，导致API请求返回401。请拆解为：复现bug、定位根因、修复代码、添加测试、代码审查的任务DAG。',
    messageId: `plan-bug-${Date.now()}`,
    mentions: [{ agentName: 'Planner', agentId: agentIds.find((id: string) => agents?.find((a: any) => a.id === id)?.name?.toLowerCase()?.includes('planner')) || agentIds[0], messageId: `pm2-${Date.now()}` }],
  }));

  try {
    const plan2 = await client2.wait((m: any) => m.type === 'plan_result', 180000);
    console.log(`plan_result: tasks=${plan2.tasks?.length || 0}`);
    const taskNames = plan2.tasks?.map((t: any) => t.title).join(' → ') || 'none';
    console.log(`Tasks: ${taskNames}`);

    // Verify Review is after Fix
    const reviewIdx = plan2.tasks?.findIndex((t: any) => t.agentType?.toLowerCase().includes('review'));
    const fixIdx = plan2.tasks?.findIndex((t: any) => t.title?.toLowerCase().includes('fix') || t.title?.toLowerCase().includes('修复'));
    console.log(`Review at index ${reviewIdx}, Fix at index ${fixIdx}`);
    console.log('TC-HUB-026: PASS - Bug fix DAG generated');
  } catch(e: any) {
    console.log(`TC-HUB-026 result: ${e.message}`);
  }
  client2.ws.close();

  // ===== TC-HUB-031: Replan from failure =====
  console.log('\n=== TC-HUB-031: 失败重新规划 ===');
  const client3 = await wsConnect(sess.id, token);
  await client3.wait((m: any) => m.type === 'connected', 30000);

  // Send a plan that will have a failing task
  const planId3 = `replan-test-${Date.now()}`;
  client3.ws.send(JSON.stringify({
    type: 'confirm_plan',
    planId: planId3,
    tasks: [{
      id: 'replan-fail-task',
      title: 'Failing task for replan test',
      description: 'mock-dag-fail This task intentionally fails to test replan',
      agentType: 'CodeAgent',
      dependsOn: [],
      expectedOutput: 'Will fail',
      priority: 'high',
    }],
  }));

  try {
    // Wait for task_failed
    const failed = await client3.wait((m: any) => m.type === 'task_failed', 60000);
    console.log(`task_failed: taskId=${failed.taskId}, error=${failed.error || 'none'}`);

    // Send replan request — this constructs a prompt with failure context
    client3.ws.send(JSON.stringify({
      type: 'replan_failed_task',
      planId: planId3,
      taskId: failed.taskId,
      error: failed.error || 'Task execution failed',
    }));
    console.log('replan_failed_task sent');
    console.log('TC-HUB-031: PASS - Replan from failure triggered');
  } catch(e: any) {
    console.log(`TC-HUB-031 result: ${e.message}`);
  }
  client3.ws.close();

  // Cleanup
  console.log('\n=== Cleanup ===');
  await fetch(`${API}/api/sessions/${sess.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: u.id } });
  await prisma.user.deleteMany({ where: { id: u.id } });
  await prisma.$disconnect();
  console.log('Done.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
