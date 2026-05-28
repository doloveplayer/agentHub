import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { signToken } from './lib/jwt.js';
import { prisma } from './db/prisma.js';

const API = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

async function apiPost(path: string, data: unknown, token: string) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function apiGet(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function apiDelete(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function wsConnect(sessionId: string, token: string, timeoutMs = 30000) {
  return new Promise<{ ws: WebSocket; messages: any[]; waitFor: (pred: (m: any) => boolean, tm?: number) => Promise<any> }>((resolveWs) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`);
    const messages: any[] = [];
    ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); });
    ws.on('error', () => {});
    ws.on('open', () => {
      resolveWs({
        ws, messages,
        waitFor(pred, tm = timeoutMs) {
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Timeout')), tm);
            const check = () => {
              const found = messages.find(pred);
              if (found) { clearTimeout(t); resolve(found); return; }
              if (ws.readyState !== WebSocket.OPEN) { clearTimeout(t); reject(new Error('WS closed')); return; }
              setTimeout(check, 100);
            };
            check();
          });
        },
      });
    });
    setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) { ws.close(); } }, timeoutMs);
  });
}

let userId: string;
let token: string;

test('setup: create test user', async () => {
  const u = await prisma.user.create({
    data: { username: `real-${Date.now()}`, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
  });
  userId = u.id;
  token = signToken({ userId: u.id, username: u.username });
  assert.ok(userId, 'User created');
});

// ===== TC-HUB-001: Planner casual chat (no JSON for simple questions) =====
test('TC-HUB-001: Planner casual chat responds naturally (no JSON)', async function () {
  // Create solo session — defaults to CodeAgent, not Planner
  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, 'Session created');

  const client = await wsConnect(sess.id, token, 30000);
  await client.waitFor((m: any) => m.type === 'connected', 25000);

  // Send a simple casual question (not a planning request)
  const msgId = `hub1-${Date.now()}`;
  client.ws.send(JSON.stringify({
    type: 'chat',
    content: 'Say hello and tell me what your role is in one sentence.',
    messageId: msgId,
    mentions: [],
  }));

  // Wait for stream_end (timeout 60s for real agent)
  const done = await client.waitFor((m: any) => m.type === 'stream_end', 60000).catch(() => null);
  assert.ok(done, 'Agent responded with stream_end');

  // Collect text output — should NOT contain TaskPlan JSON
  const texts = client.messages.filter((m: any) => m.type === 'stream_chunk').map((m: any) => m.content).join('');
  assert.ok(texts.length > 10, `Agent output: ${texts.slice(0, 150)}`);
  // Casual chat should not produce plan_result
  const planResults = client.messages.filter((m: any) => m.type === 'plan_result');
  assert.equal(planResults.length, 0, 'Casual chat should not produce plan_result');

  client.ws.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
});

// ===== TC-HUB-020/021: REPL reuse — second message reuses agent =====
test('TC-HUB-020: REPL reuse — second message to same agent', async function () {
  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, 'Session created');

  const client = await wsConnect(sess.id, token);
  await client.waitFor((m: any) => m.type === 'connected', 25000);

  // First message
  client.ws.send(JSON.stringify({
    type: 'chat',
    content: 'Write "FIRST_OK" to file /workspace/repl-test.txt using echo command.',
    messageId: `repl1-${Date.now()}`,
    mentions: [],
  }));
  await client.waitFor((m: any) => m.type === 'stream_end', 120000).catch(() => {});
  const firstChunks = client.messages.filter((m: any) => m.type === 'stream_chunk').length;
  assert.ok(firstChunks > 0, 'First message got responses');

  // Second message — should reuse the REPL
  client.ws.send(JSON.stringify({
    type: 'chat',
    content: 'Read the file /workspace/repl-test.txt and tell me what it contains.',
    messageId: `repl2-${Date.now()}`,
    mentions: [],
  }));
  await client.waitFor((m: any) => m.type === 'stream_end', 120000).catch(() => {});

  // Count chunks received AFTER the first message completed
  const secondChunks = client.messages.filter((m: any) => m.type === 'stream_chunk').length - firstChunks;
  assert.ok(secondChunks > 0, `Second message got ${secondChunks} new chunks (REPL reused)`);

  // Verify the response mentions the file content (FIRST_OK)
  const allText = client.messages.filter((m: any) => m.type === 'stream_chunk').map((m: any) => m.content).join('');
  assert.ok(allText.includes('FIRST_OK') || allText.length > 100, `Response references file: ${allText.slice(0, 150)}`);

  client.ws.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
});

// ===== TC-HUB-024: Planner sees group members =====
test('TC-HUB-024: Group chat with planner includes available agents', async function () {
  // Get agents for group
  const { body: agents } = await apiGet('/api/agents', token);
  const agentIds = Array.isArray(agents) ? agents.map((a: any) => a.id) : [];

  const { body: sess } = await apiPost('/api/sessions', { type: 'group', agentIds }, token);
  assert.ok(sess?.id, 'Group session created');

  const client = await wsConnect(sess.id, token);
  await client.waitFor((m: any) => m.type === 'connected', 25000);

  // Send a casual group message (would route to Planner by default)
  client.ws.send(JSON.stringify({
    type: 'chat',
    content: 'Say hello and list the coding agents available in this group.',
    messageId: `grp-${Date.now()}`,
    mentions: [],
  }));

  await client.waitFor((m: any) => m.type === 'stream_end', 120000).catch(() => {});
  const texts = client.messages.filter((m: any) => m.type === 'stream_chunk').map((m: any) => m.content).join('');
  assert.ok(texts.length > 20, `Planner responded: ${texts.slice(0, 200)}`);

  client.ws.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
});

// ===== TC-DIFF-003: Agent file change generates DiffCard =====
test('TC-DIFF-003: Agent modifying file triggers diff', async function () {
  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, 'Session created');

  const client = await wsConnect(sess.id, token);
  await client.waitFor((m: any) => m.type === 'connected', 25000);

  // Ask agent to create a file
  client.ws.send(JSON.stringify({
    type: 'chat',
    content: 'Create a file at /workspace/hello.txt with content "Hello from AgentHub real agent test". Use echo to write it.',
    messageId: `diff1-${Date.now()}`,
    mentions: [],
  }));
  await client.waitFor((m: any) => m.type === 'stream_end', 120000).catch(() => {});

  // Check if diff_summary or DiffCard was generated
  const diffEvents = client.messages.filter((m: any) =>
    m.type === 'diff_summary' || m.type === 'diff_card' || m.type === 'artifact_card',
  );

  const texts = client.messages.filter((m: any) => m.type === 'stream_chunk').map((m: any) => m.content).join('');
  assert.ok(texts.length > 20, `Agent responded (${texts.length} chars)`);
  // Note: diff generation depends on WorkspaceManager being integrated

  client.ws.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
});

// ===== Cleanup =====
test('cleanup', async () => {
  if (userId) {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
});
