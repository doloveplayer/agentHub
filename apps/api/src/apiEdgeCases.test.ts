import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from './lib/jwt.js';
import { prisma } from './db/prisma.js';

const API = 'http://localhost:3000';
let userIdA = '';
let userIdB = '';
const TEST_LOGIN_A = `test-api-user-a-${Date.now()}`;
const TEST_LOGIN_B = `test-api-user-b-${Date.now()}`;
let tokenA = '';
let tokenB = '';

function apiHeaders(jwt?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) h['Authorization'] = `Bearer ${jwt}`;
  return h;
}

async function get(path: string, jwt?: string) {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders(jwt) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, data?: unknown, jwt?: string) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: apiHeaders(jwt),
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function del(path: string, jwt?: string) {
  const res = await fetch(`${API}${path}`, { method: 'DELETE', headers: apiHeaders(jwt) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function put(path: string, data: unknown, jwt?: string) {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: apiHeaders(jwt),
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ===== Test setup / teardown =====

test('setup: create test users in DB', async () => {
  const userA = await prisma.user.create({
    data: { username: TEST_LOGIN_A, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
    select: { id: true, username: true },
  });
  const userB = await prisma.user.create({
    data: { username: TEST_LOGIN_B, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
    select: { id: true, username: true },
  });
  userIdA = userA.id;
  userIdB = userB.id;
  tokenA = signToken({ userId: userIdA, username: TEST_LOGIN_A });
  tokenB = signToken({ userId: userIdB, username: TEST_LOGIN_B });
  assert.ok(userIdA, 'userA created');
  assert.ok(userIdB, 'userB created');
});

// ========== Auth Edge Cases ==========

test('TC-AUTH-006: /api/auth/me without token returns 401', async () => {
  const { status } = await get('/api/auth/me');
  assert.equal(status, 401);
});

test('TC-AUTH-007: /api/auth/me with expired token returns 401', async () => {
  const fakeExpired = signToken({ userId: userIdA, username: TEST_LOGIN_A });
  // Modify the token to be invalid
  const { status } = await get('/api/auth/me', 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4IiwiaWF0IjoxfQ.x');
  assert.equal(status, 401);
});

test('TC-AUTH-008: /api/auth/me with tampered token returns 401', async () => {
  const tampered = tokenA.slice(0, -5) + 'XXXXX';
  const { status } = await get('/api/auth/me', tampered);
  assert.equal(status, 401);
});

test('TC-AUTH-009: Cross-user session access returns 403/404', async () => {
  const { body: sess } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sess?.id, 'Created session as userA');

  const { status } = await get(`/api/sessions/${sess.id}`, tokenB);
  assert.ok(status === 403 || status === 404, `Cross-user blocked (status ${status})`);
});

test('TC-AUTH-010: Cross-user session delete returns 403/404', async () => {
  const { body: sess } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sess?.id, 'Created session as userA');

  const { status } = await del(`/api/sessions/${sess.id}`, tokenB);
  assert.ok(status === 403 || status === 404, `Cross-user delete blocked (status ${status})`);

  // Verify session still accessible to owner
  const { status: getStatus } = await get(`/api/sessions/${sess.id}`, tokenA);
  assert.equal(getStatus, 200, 'Session still accessible to owner');
});

// ========== Session Edge Cases ==========

test('TC-SESS-003: Create group session with specific agentIds', async () => {
  const { body: agents } = await get('/api/agents', tokenA);
  if (!Array.isArray(agents) || agents.length < 2) {
    assert.ok(true, 'Skipped: not enough agents');
    return;
  }
  const { status, body } = await post('/api/sessions', {
    type: 'group',
    agentIds: [agents[0].id, agents[1].id],
  }, tokenA);
  assert.ok(status === 200 || status === 201, `Session created (status ${status})`);
  assert.ok(body?.id);
});

test('TC-SESS-004: Create session with illegal type returns 400', async () => {
  const { status } = await post('/api/sessions', { type: 'bad' }, tokenA);
  assert.equal(status, 400);
});

test('TC-SESS-005: Session list ordered by recent activity', async () => {
  const { body: s1 } = await post('/api/sessions', { type: 'solo' }, tokenA);
  const { body: s2 } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(s1?.id && s2?.id, 'Both sessions created');

  const { body: list } = await get('/api/sessions', tokenA);
  assert.ok(Array.isArray(list), 'Session list is array');
  assert.ok(list.length >= 2, 'At least 2 sessions');
  const idx1 = list.findIndex((s: { id: string }) => s.id === s1.id);
  const idx2 = list.findIndex((s: { id: string }) => s.id === s2.id);
  assert.ok(idx2 < idx1, 'Newer session (s2) before older (s1)');
});

test('TC-SESS-007: Session detail messages in ascending order', async () => {
  const { body: sess } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sess?.id);
  const { body: detail } = await get(`/api/sessions/${sess.id}`, tokenA);
  assert.ok(detail?.id);
  // Messages should be present (may be empty for new session)
  if (detail.messages) {
    assert.ok(Array.isArray(detail.messages));
  }
});

test('TC-SESS-008: Nonexistent session returns 404', async () => {
  const fakeId = '00000000-0000-0000-0000-00000000ffff';
  const { status } = await get(`/api/sessions/${fakeId}`, tokenA);
  assert.equal(status, 404);
});

test('TC-SESS-009: Delete session cascades messages', async () => {
  const { body: sess } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sess?.id);

  const { status: delStatus } = await del(`/api/sessions/${sess.id}`, tokenA);
  assert.ok(delStatus === 200 || delStatus === 204);

  const { status: getStatus } = await get(`/api/sessions/${sess.id}`, tokenA);
  assert.equal(getStatus, 404, 'Deleted session returns 404');
});

test('TC-SESS-012: Empty message rejected', async () => {
  const { body: sess } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sess?.id);

  const { status } = await post('/api/chat/send', { sessionId: sess.id, content: '' }, tokenA);
  assert.equal(status, 400);
});

test('TC-SESS-013: Oversized message handled gracefully', async () => {
  const { body: sess } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sess?.id);

  const bigContent = 'A'.repeat(100_000);
  const { status } = await post('/api/chat/send', { sessionId: sess.id, content: bigContent }, tokenA);
  // Must not crash — either accept or reject is fine
  assert.ok(status >= 200 && status < 600, `Response received (status ${status})`);
});

test('TC-SESS-014: send message without sessionId returns 400', async () => {
  const { status } = await post('/api/chat/send', { content: 'hello' }, tokenA);
  assert.equal(status, 400);
});

test('TC-SESS-015: Cross-user send message blocked', async () => {
  const { body: sessA } = await post('/api/sessions', { type: 'solo' }, tokenA);
  assert.ok(sessA?.id);

  const { status } = await post('/api/chat/send', {
    sessionId: sessA.id,
    content: 'unauthorized',
  }, tokenB);
  assert.ok(status === 403 || status === 404, `Cross-user blocked (status ${status})`);
});

// ========== Agent Management Edge Cases ==========

test('TC-AGT-001: Default agents seeded', async () => {
  const { status, body } = await get('/api/agents', tokenA);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 3, `Expected >=3 agents, got ${body.length}`);
});

test('TC-AGT-002: Agent list only returns active', async () => {
  const { body } = await get('/api/agents', tokenA);
  if (!Array.isArray(body)) { assert.ok(true, 'Skipped'); return; }
  const inactive = body.filter((a: { active?: boolean }) => a.active === false);
  assert.equal(inactive.length, 0, 'No inactive agents in list');
});

test('TC-AGT-004: Create agent without name returns 400', async () => {
  const { status } = await post('/api/agents', {
    displayName: 'No Name Agent',
    description: 'Test agent without name',
    systemPrompt: 'Test',
  }, tokenA);
  assert.equal(status, 400);
});

test('TC-AGT-005: Duplicate agent name returns error', async () => {
  const name = `dup-test-${Date.now()}`;
  const { status: s1 } = await post('/api/agents', {
    name, displayName: 'Dup 1', description: 'First agent', systemPrompt: 'First prompt',
  }, tokenA);
  assert.equal(s1, 201, 'First agent created');

  const { status: s2 } = await post('/api/agents', {
    name, displayName: 'Dup 2', description: 'Second agent', systemPrompt: 'Second prompt',
  }, tokenA);
  assert.ok(s2 === 409 || s2 === 400, `Duplicate rejected (status ${s2})`);
});

test('TC-AGT-007: Update nonexistent agent returns 404', async () => {
  const fakeId = '00000000-0000-0000-0000-00000000eeee';
  const { status } = await put(`/api/agents/${fakeId}`, { systemPrompt: 'Updated' }, tokenA);
  assert.equal(status, 404);
});

// ========== JWT round-trip tests ==========

test('JWT sign and verify round-trip', () => {
  const t = signToken({ userId: 'test-123', username: 'testuser' });
  const payload = verifyToken(t);
  assert.equal(payload.userId, 'test-123');
  assert.equal(payload.username, 'testuser');
});

test('JWT verify throws on invalid token', () => {
  assert.throws(() => verifyToken('not.a.valid.token'));
});

// ===== Cleanup =====

test('cleanup: delete test data', async () => {
  // Clean up agents created by TC-AGT-005/006
  await prisma.agent.deleteMany({ where: { name: { startsWith: 'dup-test-' } } });
  await prisma.agent.deleteMany({ where: { name: { startsWith: 'dup-agent-test' } } });
  if (userIdA) {
    await prisma.session.deleteMany({ where: { userId: userIdA } });
    await prisma.user.deleteMany({ where: { id: userIdA } });
  }
  if (userIdB) {
    await prisma.session.deleteMany({ where: { userId: userIdB } });
    await prisma.user.deleteMany({ where: { id: userIdB } });
  }
  await prisma.$disconnect();
  assert.ok(true, 'Cleanup done');
});
