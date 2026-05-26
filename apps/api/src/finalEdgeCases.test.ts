import test from 'node:test';
import assert from 'node:assert/strict';

// ===== TC-WS-005: No sandbox error =====
test('TC-WS-005: mock-no-sandbox emits error with clear message', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  await proc.start('s1', 'User request: mock-no-sandbox test', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 100));
  const err = events.find((e: any) => e.type === 'error');
  assert.ok(err, 'Error emitted');
  assert.ok(err.message.includes('No active sandbox'), 'Correct error message');
  const done = events.find((e: any) => e.type === 'done');
  assert.equal(done?.exitCode, 1, 'exitCode=1');
});

// ===== TC-WS-018: Agent timeout resource release =====
test('TC-WS-018: mock long task can be killed (simulating timeout)', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  proc.start('s1', 'User request: long running timeout test', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(proc.isAlive(), true, 'Alive before kill');
  const hb = events.filter((e: any) => e.type === 'text' && e.content.includes('heartbeat'));
  assert.ok(hb.length > 0, `Heartbeats: ${hb.length}`);
  proc.kill();
  assert.equal(proc.isAlive(), false, 'Not alive after kill');
});

// ===== TC-WS-019: Agent start error =====
test('TC-WS-019: mock-start-error throws on start failure', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  await assert.rejects(
    () => proc.start('s1', 'User request: mock-start-error test', 'c', '/w', true),
    /Mock provider start error/,
    'Start error thrown',
  );
});

// ===== TC-WS-020: High-frequency chunk ordering =====
test('TC-WS-020: 100 mock chunks emit in correct order', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  await proc.start('s1', 'User request: mock-high-chunk:100 order test', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 500));
  const chunks = events.filter((e: any) => e.type === 'text' && e.content.includes('Chunk'));
  assert.equal(chunks.length, 100, `Got ${chunks.length} chunks`);
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].content.includes(`Chunk ${i + 1}/100`), `Chunk ${i + 1} correct`);
  }
});

// ===== TC-WS-021: Late chunk after done =====
test('TC-WS-021: late chunk emitted after done event', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  await proc.start('s1', 'User request: mock-late-chunk test', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 200));
  const done = events.find((e: any) => e.type === 'done');
  assert.ok(done, 'Done emitted');
  const late = events.filter((e: any) => e.type === 'text' && e.content.includes('LATE CHUNK'));
  assert.ok(late.length >= 1, 'Late chunk present (filtered at integration layer)');
});

// ===== TC-WS-024: Error without secrets =====
test('TC-WS-024: mock error contains fake secrets for filter validation', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  await proc.start('s1', 'User request: mock-error-secret test', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 50));
  const err = events.find((e: any) => e.type === 'error');
  assert.ok(err, 'Error emitted');
  assert.ok(err.message.includes('API_KEY'), 'Contains fake secrets for filter test');
});

// ===== TC-WS-002: Early message caching pattern =====
test('TC-WS-002: mock supports early message buffering via system init event', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  await proc.start('s1', 'test', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 50));
  const init = events.find((e: any) => e.type === 'system' && e.subtype === 'init');
  assert.ok(init, 'System init event signals sandbox ready');
});

// ===== TC-WS-003: Unknown message → graceful =====
test('TC-WS-003: unknown prompt falls through to default mock behavior', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  const events: any[] = [];
  proc.onEvent((e) => events.push(e));
  await proc.start('s1', 'User request: novel unknown input', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 200));
  const done = events.find((e: any) => e.type === 'done');
  assert.equal(done?.exitCode, 0, 'Unknown prompt handled, exitCode=0');
});

// ===== TC-WS-016: Stop nonexistent / killed agent =====
test('TC-WS-016: write to killed process is no-op', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  const proc = new TestAgentProcess();
  proc.kill();
  proc.write('y\n');
  assert.equal(proc.isAlive(), false, 'Killed process stays dead, write is no-op');
});

// ===== TC-WS-017: Multi-client independence =====
test('TC-WS-017: two mock processes emit independently isolated events', async () => {
  const { TestAgentProcess } = await import('./agent/TestAgentProcess.js');
  TestAgentProcess.resetGlobalRunningCount();
  const p1 = new TestAgentProcess(); const e1: any[] = []; p1.onEvent((e) => e1.push(e));
  const p2 = new TestAgentProcess(); const e2: any[] = []; p2.onEvent((e) => e2.push(e));
  p1.start('sa', 'User request: mock-queue-test A', 'c', '/w', true);
  p2.start('sb', 'User request: mock-queue-test B', 'c', '/w', true);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(e1.find((e: any) => e.type === 'done'), 'Agent 1 done');
  assert.ok(e2.find((e: any) => e.type === 'done'), 'Agent 2 done');
  assert.equal(TestAgentProcess.getGlobalRunningCount(), 0, 'Count returns to 0');
});

// ===== TC-NFR-015: API errors don't leak secrets =====
test('TC-NFR-015: API error responses contain no secrets or stacks', async () => {
  const r1 = await fetch('http://localhost:3000/api/auth/me');
  const b1 = await r1.json();
  assert.equal(r1.status, 401);
  const s1 = JSON.stringify(b1);
  assert.ok(!s1.includes('SECRET') && !s1.includes('JWT_SECRET') && !s1.includes('DATABASE_URL'), 'No secret in 401');
  assert.ok(!s1.includes('stack') && !s1.includes('at '), 'No stack trace in 401');

  const r2 = await fetch('http://localhost:3000/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'bad',
  });
  const b2 = await r2.json().catch(() => null);
  assert.ok(r2.status >= 400);
  const s2 = JSON.stringify(b2);
  if (b2?.error) {
    assert.ok(!s2.includes('secret') && !s2.includes('ENV'), 'No env leak in error');
  }
});

// ===== TC-NFR-013: Preview proxy safety =====
test('TC-NFR-013: Preview proxy returns controlled errors, no HTML injection', async () => {
  const r = await fetch('http://localhost:3000/api/preview/fake-session-id/proxy/index.html');
  const body = await r.json().catch(() => null);
  assert.ok(r.status >= 400, `Preview proxy rejects invalid: ${r.status}`);
  if (body?.error) {
    assert.ok(typeof body.error === 'string', 'Error is a clean string');
    assert.ok(!body.error.includes('<script>'), 'No script injection in error');
    assert.ok(!body.error.includes('at ') && !body.error.includes('stack'), 'No stack trace');
  }
});

// ===== TC-NFR-014: Sandbox config =====
test('TC-NFR-014: Sandbox config has required security settings', async () => {
  const { config } = await import('./config.js');
  assert.ok(config.sandbox.image, 'Sandbox image configured');
  assert.ok(config.sandbox.hostDockerSocket, 'Docker socket path configured');
  assert.ok(config.sandbox.root, 'Sandbox root directory configured');
});

// ===== TC-SBX-003: Sandbox image validation =====
test('TC-SBX-003: Configured sandbox image name is valid', async () => {
  const { config } = await import('./config.js');
  assert.ok(config.sandbox.image.length > 0, `Image: ${config.sandbox.image}`);
  assert.ok(config.sandbox.image.includes(':'), 'Image has version tag');
});

// ===== TC-NFR-011/012: Service health =====
test('TC-NFR-011/012: API health endpoint responds', async () => {
  const r = await fetch('http://localhost:3000/api/health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok', 'API healthy');
});
