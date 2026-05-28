import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import WebSocket from 'ws';
import { signToken } from './lib/jwt.js';
import { prisma } from './db/prisma.js';
import { SandboxManager } from './agent/SandboxManager.js';

const API = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';
import { config } from './config.js';

const SANDBOXES_ROOT = config.sandbox.root;

// ---- helpers ----

function hdr(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function apiPost(path: string, data: unknown, token: string) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: hdr(token), body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function apiGet(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { headers: hdr(token) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function apiDelete(path: string, token: string) {
  const res = await fetch(`${API}${path}`, { method: 'DELETE', headers: hdr(token) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function wsConnect(sessionId: string, token: string): Promise<{ ws: WebSocket; connected: Promise<{ type: string; sessionId: string }> }> {
  return new Promise((resolveWs) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`);
    const connected = new Promise<{ type: string; sessionId: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS connect timeout after 30s')), 30000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connected') { clearTimeout(t); resolve(msg); }
        if (msg.type === 'error') { clearTimeout(t); reject(new Error(msg.message || msg.error || 'WS error')); }
      });
      ws.on('error', () => { clearTimeout(t); reject(new Error('WS transport error')); });
    });
    ws.on('open', () => resolveWs({ ws, connected }));
  });
}

function dockerContainerExists(containerId: string): boolean {
  try {
    return execSync(`docker ps -a --filter "id=${containerId}" --format "{{.ID}}"`, { encoding: 'utf-8' }).trim().length > 0;
  } catch { return false; }
}

function dockerContainersForSession(sessionId: string): number {
  const out = execSync(`docker ps -a --filter "name=agenthub-sandbox-${sessionId}" --format "{{.ID}}"`, { encoding: 'utf-8' }).trim();
  return out ? out.split('\n').length : 0;
}

// ---- Each test is fully self-contained ----

test('TC-SBX-001: First WS connection creates a sandbox container', async () => {
  // Setup user
  const u = await prisma.user.create({
    data: { username: `sbx1-${Date.now()}`, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', avatarUrl: '' },
  });
  const token = signToken({ userId: u.id, username: u.username });

  // Create session
  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, `Session created: ${JSON.stringify(sess)}`);

  // Connect WS → triggers sandbox creation
  const { ws, connected } = await wsConnect(sess.id, token);
  const connMsg = await connected;
  assert.equal(connMsg.type, 'connected');

  // Verify DB has containerId
  const { body: detail } = await apiGet(`/api/sessions/${sess.id}`, token);
  assert.ok(detail?.sandboxContainerId, `DB has sandboxContainerId: ${JSON.stringify(detail)}`);

  // Verify Docker container exists
  assert.ok(dockerContainerExists(detail.sandboxContainerId), 'Docker container running');

  // Verify host workdir
  const hostDir = resolve(SANDBOXES_ROOT, sess.id);
  assert.ok(existsSync(hostDir), `Host workdir exists: ${hostDir}`);

  ws.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
  // Cleanup DB user
  await prisma.session.deleteMany({ where: { userId: u.id } });
  await prisma.user.deleteMany({ where: { id: u.id } });
});

test('TC-SBX-002: Second WS connection reuses existing sandbox', async () => {
  const u = await prisma.user.create({
    data: { username: `sbx2-${Date.now()}`, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
  });
  const token = signToken({ userId: u.id, username: u.username });

  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, `Session created`);

  // First WS → creates sandbox
  const { ws: ws1, connected: c1 } = await wsConnect(sess.id, token);
  await c1;
  const { body: d1 } = await apiGet(`/api/sessions/${sess.id}`, token);
  const cid1 = d1.sandboxContainerId;
  assert.ok(cid1, 'First sandbox created');

  // Second WS → should reuse
  const { ws: ws2, connected: c2 } = await wsConnect(sess.id, token);
  await c2;
  const { body: d2 } = await apiGet(`/api/sessions/${sess.id}`, token);
  assert.equal(d2.sandboxContainerId, cid1, 'Container ID unchanged');

  // Only one container per session
  assert.equal(dockerContainersForSession(sess.id), 1, 'Exactly 1 container');

  ws1.close(); ws2.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
  await prisma.session.deleteMany({ where: { userId: u.id } });
  await prisma.user.deleteMany({ where: { id: u.id } });
});

test('TC-SBX-004: Cross-session workspace isolation', async () => {
  const u = await prisma.user.create({
    data: { username: `sbx4-${Date.now()}`, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
  });
  const token = signToken({ userId: u.id, username: u.username });

  // Create two sessions
  const { body: s1 } = await apiPost('/api/sessions', { type: 'solo' }, token);
  const { body: s2 } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(s1?.id && s2?.id, `Sessions created: s1=${s1?.id}, s2=${s2?.id}`);

  // Connect both → each gets its own sandbox
  const { ws: ws1, connected: c1 } = await wsConnect(s1.id, token);
  const { ws: ws2, connected: c2 } = await wsConnect(s2.id, token);
  await Promise.all([c1, c2]);

  const { body: d1 } = await apiGet(`/api/sessions/${s1.id}`, token);
  const { body: d2 } = await apiGet(`/api/sessions/${s2.id}`, token);
  const cid1 = d1.sandboxContainerId;
  const cid2 = d2.sandboxContainerId;
  assert.ok(cid1 && cid2, `Both sandboxes created: c1=${cid1}, c2=${cid2}`);
  assert.notEqual(cid1, cid2, 'Different containers per session');

  // Write file in session1's sandbox
  await SandboxManager.execCapture(cid1, 'echo "s1-isolated-data" > /workspace/iso.txt');
  const out1 = await SandboxManager.execCapture(cid1, 'cat /workspace/iso.txt');
  assert.equal(out1, 's1-isolated-data', 'Session 1 can read own file');

  // Session2 cannot read session1's file
  const out2 = await SandboxManager.execCapture(cid2, 'cat /workspace/iso.txt 2>&1; echo EXIT:$?');
  assert.ok(out2.includes('No such file') || out2.includes('EXIT:1'), `File isolated: ${out2.slice(0, 100)}`);

  ws1.close(); ws2.close();
  await apiDelete(`/api/sessions/${s1.id}`, token);
  await apiDelete(`/api/sessions/${s2.id}`, token);
  await prisma.session.deleteMany({ where: { userId: u.id } });
  await prisma.user.deleteMany({ where: { id: u.id } });
});

test('TC-SBX-005: Multi-agent same session shares workspace', async () => {
  const u = await prisma.user.create({
    data: { username: `sbx5-${Date.now()}`, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
  });
  const token = signToken({ userId: u.id, username: u.username });

  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, `Session created`);

  const { ws, connected } = await wsConnect(sess.id, token);
  await connected;
  const { body: detail } = await apiGet(`/api/sessions/${sess.id}`, token);
  const cid = detail.sandboxContainerId;
  assert.ok(cid, 'Sandbox created');

  // Agent A writes a file
  await SandboxManager.execCapture(cid, 'echo "multi-agent-shared" > /workspace/shared.txt');
  // Agent B (same session, same container) reads it
  const content = await SandboxManager.execCapture(cid, 'cat /workspace/shared.txt');
  assert.equal(content, 'multi-agent-shared', 'Same-session agent can read shared file');

  ws.close();
  await apiDelete(`/api/sessions/${sess.id}`, token);
  await prisma.session.deleteMany({ where: { userId: u.id } });
  await prisma.user.deleteMany({ where: { id: u.id } });
});

test('TC-SBX-006: Session deletion destroys container and host workdir', async () => {
  const u = await prisma.user.create({
    data: { username: `sbx6-${Date.now()}`, password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy' },
  });
  const token = signToken({ userId: u.id, username: u.username });

  const { body: sess } = await apiPost('/api/sessions', { type: 'solo' }, token);
  assert.ok(sess?.id, `Session created`);

  const { ws, connected } = await wsConnect(sess.id, token);
  await connected;
  const { body: detail } = await apiGet(`/api/sessions/${sess.id}`, token);
  const cid = detail.sandboxContainerId;
  assert.ok(cid, 'Sandbox created');
  assert.ok(dockerContainerExists(cid), 'Container exists before delete');

  const hostDir = resolve(SANDBOXES_ROOT, sess.id);
  assert.ok(existsSync(hostDir), 'Host workdir exists before delete');

  ws.close();

  // Delete session — triggers sandbox cleanup
  await apiDelete(`/api/sessions/${sess.id}`, token);

  // Allow time for async Docker cleanup (Docker stop+rm can take 5-10s)
  await new Promise((r) => setTimeout(r, 8000));

  // Container should be gone
  assert.ok(!dockerContainerExists(cid), `Container destroyed (was ${cid.slice(0,12)})`);

  // Host workdir should be cleaned
  assert.ok(!existsSync(hostDir), `Host workdir cleaned: ${hostDir}`);

  await prisma.session.deleteMany({ where: { userId: u.id } });
  await prisma.user.deleteMany({ where: { id: u.id } });
  await prisma.$disconnect();
});
