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
