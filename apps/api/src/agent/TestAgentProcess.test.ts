import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestAgentProcess } from './TestAgentProcess.js';
import type { ParsedEvent } from './EventParser.js';

function waitForEvent(events: ParsedEvent[], predicate: (event: ParsedEvent) => boolean): Promise<ParsedEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const event = events.find(predicate);
      if (event) {
        resolve(event);
        return;
      }
      if (Date.now() - started > 1000) {
        reject(new Error('Timed out waiting for mock event'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('TestAgentProcess emits permission_request and writes only after allow', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agenthub-mock-provider-'));
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  try {
    await proc.start(
      'session-1',
      '请写文件 file: docs/mock-allow.txt',
      'container',
      '/workspace',
      false,
      workDir,
      'msg-1',
      undefined,
      'code-agent',
    );

    const permission = await waitForEvent(events, (event) => event.type === 'permission_request');
    assert.deepEqual(permission, { type: 'permission_request', tool: 'Write', path: 'docs/mock-allow.txt' });
    assert.equal(existsSync(join(workDir, 'docs/mock-allow.txt')), false);

    proc.write('y\n');
    await waitForEvent(events, (event) => event.type === 'done' && event.exitCode === 0);

    assert.equal(existsSync(join(workDir, 'docs/mock-allow.txt')), true);
    assert.match(readFileSync(join(workDir, 'docs/mock-allow.txt'), 'utf8'), /Mock provider wrote this file/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TestAgentProcess denies permission without writing file', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agenthub-mock-provider-'));
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  try {
    await proc.start(
      'session-1',
      'write file: docs/mock-deny.txt',
      'container',
      '/workspace',
      false,
      workDir,
      'msg-1',
      undefined,
      'code-agent',
    );

    await waitForEvent(events, (event) => event.type === 'permission_request');
    proc.write('n\n');
    await waitForEvent(events, (event) => event.type === 'done' && event.exitCode === 1);

    assert.equal(existsSync(join(workDir, 'docs/mock-deny.txt')), false);
    assert.ok(events.some((event) => event.type === 'text' && event.content.includes('Permission denied')));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TestAgentProcess emits deterministic planner JSON', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start('session-1', '/plan SmartSupport 任务拆解', 'container', '/workspace', true);
  await waitForEvent(events, (event) => event.type === 'done' && event.exitCode === 0);

  const text = events.filter((event) => event.type === 'text').map((event) => event.content).join('');
  assert.match(text, /"planTitle": "Mock SmartSupport DAG"/);
  assert.match(text, /"agentType": "CodeAgent"/);
});

test('TestAgentProcess supports deterministic DAG task success with description echo', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start(
    'session-1',
    'Task: Review\nDescription: mock-dag-success edited task description\nExpected Output: report.md\nExecute this task now.',
    'container',
    '/workspace',
    true,
    undefined,
    'task-review',
  );
  await waitForEvent(events, (event) => event.type === 'done' && event.exitCode === 0);

  const text = events.filter((event) => event.type === 'text').map((event) => event.content).join('');
  assert.match(text, /Mock DAG task executing: Review/);
  assert.match(text, /edited task description/);
});

test('TestAgentProcess supports deterministic DAG task failure', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start(
    'session-1',
    'Task: Broken task\nDescription: mock-dag-fail\nExpected Output: error.txt\nExecute this task now.',
    'container',
    '/workspace',
    true,
    undefined,
    'task-broken',
  );

  const done = await waitForEvent(events, (event) => event.type === 'done');
  assert.equal(done.type, 'done');
  assert.equal((done as { type: 'done'; exitCode: number }).exitCode, 1);
});

test('TestAgentProcess emits N high-frequency chunks in order', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start('session-1', 'User request: mock-high-chunk:50 high chunk test', 'container', '/workspace', true);
  await waitForEvent(events, (event) => event.type === 'done');

  const chunks = events.filter((event): event is { type: 'text'; content: string } =>
    event.type === 'text' && event.content.includes('Chunk'),
  );
  assert.equal(chunks.length, 50);
  // Verify order: chunk N must appear before chunk N+1
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].content.includes(`Chunk ${i + 1}/50`), `Chunk ${i + 1} in correct position`);
  }
});

test('TestAgentProcess emits late chunk after done (for filtering test)', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start('session-1', 'User request: mock-late-chunk late chunk test', 'container', '/workspace', true);
  await waitForEvent(events, (event) => event.type === 'done');
  // Wait for the late chunk scheduled at 50ms to fire
  await new Promise((resolve) => setTimeout(resolve, 80));

  // After done, the late chunk should still appear in the mock output
  // (the filtering is the integration layer's responsibility)
  const lateChunk = events.filter((event) =>
    event.type === 'text' && event.content.includes('LATE CHUNK AFTER DONE'),
  );
  assert.ok(lateChunk.length >= 1, 'Late chunk is emitted by mock');
});

test('TestAgentProcess emits error with fake secrets for filter validation', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start('session-1', 'User request: mock-error-secret error secret test', 'container', '/workspace', true);
  const done = await waitForEvent(events, (event) => event.type === 'done');

  assert.equal((done as { type: 'done'; exitCode: number }).exitCode, 1);
  const errorEvent = events.find((event): event is { type: 'error'; message: string } => event.type === 'error');
  assert.ok(errorEvent, 'Error event emitted');
  assert.ok(errorEvent.message.includes('API_KEY'), 'Error contains fake secret pattern');
});

test('TestAgentProcess stop lifecycle reports killed state', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  const startPromise = proc.start('session-1', 'User request: mock-stop-verify stop lifecycle test', 'container', '/workspace', true);

  // Give the process time to start emitting
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(proc.isAlive(), true, 'Process alive before kill');

  proc.kill();
  assert.equal(proc.isAlive(), false, 'Process not alive after kill');

  await startPromise;
  const stoppedMsg = events.find((event) => event.type === 'text' && event.content.includes('stopped by user'));
  assert.ok(stoppedMsg, 'Stop message emitted');
});

test('TestAgentProcess no-sandbox emits error and done with exitCode 1', async () => {
  const proc = new TestAgentProcess();
  const events: ParsedEvent[] = [];
  proc.onEvent((event) => events.push(event));

  await proc.start('session-1', 'User request: mock-no-sandbox no sandbox test', 'container', '/workspace', true);
  const done = await waitForEvent(events, (event) => event.type === 'done');

  assert.equal((done as { type: 'done'; exitCode: number }).exitCode, 1);
  const errorEvent = events.find((event): event is { type: 'error'; message: string } => event.type === 'error');
  assert.ok(errorEvent, 'Error event emitted');
  assert.ok(errorEvent.message.includes('No active sandbox'), 'Error message mentions sandbox');
});

test('TestAgentProcess queue test reports global running count', async () => {
  TestAgentProcess.resetGlobalRunningCount();

  const proc1 = new TestAgentProcess();
  const events1: ParsedEvent[] = [];
  proc1.onEvent((event) => events1.push(event));

  const proc2 = new TestAgentProcess();
  const events2: ParsedEvent[] = [];
  proc2.onEvent((event) => events2.push(event));

  await Promise.all([
    proc1.start('session-1', 'User request: mock-queue-test queue test A', 'container', '/workspace', true),
    proc2.start('session-2', 'User request: mock-queue-test queue test B', 'container', '/workspace', true),
  ]);

  await Promise.all([
    waitForEvent(events1, (event) => event.type === 'done'),
    waitForEvent(events2, (event) => event.type === 'done'),
  ]);

  // Both should have completed
  const done1 = events1.find((event) => event.type === 'done');
  const done2 = events2.find((event) => event.type === 'done');
  assert.equal(done1?.exitCode, 0);
  assert.equal(done2?.exitCode, 0);
  assert.equal(TestAgentProcess.getGlobalRunningCount(), 0, 'Global count returns to 0');
});
