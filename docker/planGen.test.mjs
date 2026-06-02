/**
 * planGen unit tests — run inside the sandbox container:
 *   docker run --rm agenthub-sandbox:latest node /usr/local/bin/planGen.test.mjs
 *
 * Or run directly if Node and planGen.mjs are available:
 *   node docker/planGen.test.mjs
 */

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_GEN = resolve(__dirname, 'planGen.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
  }
}

function run(input, ...args) {
  try {
    const result = execFileSync('node', [PLAN_GEN, ...args], { input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { exitCode: 0, stdout: result, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

// ===== Flat mode =====

test('flat mode: valid plan', () => {
  const input = JSON.stringify({
    planTitle: 'Test', summary: 'A plan',
    tasks: [{ id: 'T1', title: 'Task', description: 'Do', agentType: 'code-agent', dependsOn: [], risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.planTitle, 'Test');
  assert.equal(out.tasks.length, 1);
});

test('flat mode: missing planTitle → default', () => {
  const input = JSON.stringify({
    tasks: [{ id: 'T1', title: 'Task', agentType: 'code-agent', risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.planTitle, 'Untitled Plan');
});

test('flat mode: empty tasks array → error', () => {
  const r = run('{"planTitle":"X","tasks":[]}', '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('at least one task is required'));
});

test('flat mode: task missing id → error', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [{ title: 'Task', agentType: 'code-agent', risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('task id is required'));
});

test('flat mode: task missing title → error', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [{ id: 'T1', agentType: 'code-agent', risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('task title is required'));
});

test('flat mode: task missing agentType → error', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [{ id: 'T1', title: 'Task', risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('agentType is required'));
});

test('flat mode: invalid risk "medium" → auto-normalized to low', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [{ id: 'T1', title: 'Task', agentType: 'code-agent', risk: 'medium' }],
  });
  const r = run(input, '--mode', 'flat', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tasks[0].risk, 'low');
});

test('flat mode: alias depends_on → dependsOn', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [
      { id: 'T1', title: 'A', agentType: 'code-agent', risk: 'low' },
      { id: 'T2', title: 'B', agentType: 'review-agent', depends_on: ['T1'], risk: 'low' },
    ],
  });
  const r = run(input, '--mode', 'flat', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.tasks[1].dependsOn, ['T1']);
});

test('flat mode: alias agent_type → agentType', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [{ id: 'T1', title: 'Task', agent_type: 'code-agent', risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tasks[0].agentType, 'code-agent');
});

test('flat mode: alias title/project at top level', () => {
  const input = JSON.stringify({
    project: 'My Project', description: 'A great project',
    tasks: [{ id: 'T1', title: 'Task', agentType: 'code-agent', risk: 'low' }],
  });
  const r = run(input, '--mode', 'flat', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.planTitle, 'My Project');
  assert.equal(out.summary, 'A great project');
});

test('flat mode: dependsOn references unknown task → error', () => {
  const input = JSON.stringify({
    planTitle: 'X',
    tasks: [
      { id: 'T1', title: 'A', agentType: 'code-agent', risk: 'low' },
      { id: 'T2', title: 'B', agentType: 'review-agent', dependsOn: ['T99'], risk: 'low' },
    ],
  });
  const r = run(input, '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('unknown task "T99"'));
});

// ===== Phased mode =====

test('phased mode: valid phased plan flattens correctly', () => {
  const input = JSON.stringify({
    title: 'Phased', description: 'desc',
    phases: [
      { name: 'P1', tasks: [{ id: 'T1', title: 'A', agentType: 'code-agent', risk: 'low' }] },
      { name: 'P2', tasks: [{ id: 'T2', title: 'B', agentType: 'review-agent', depends_on: ['T1'], risk: 'low' }] },
    ],
  });
  const r = run(input, '--mode', 'phased', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.planTitle, 'Phased');
  assert.equal(out.tasks.length, 2);
  assert.deepEqual(out.tasks[1].dependsOn, ['T1']);
});

test('phased mode: empty phases → error', () => {
  const r = run('{"title":"X","phases":[]}', '--mode', 'phased');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('at least one task is required'));
});

test('phased mode: phase with no tasks skipped gracefully', () => {
  const input = JSON.stringify({
    title: 'Phased',
    phases: [
      { name: 'P1', tasks: [] },
      { name: 'P2', tasks: [{ id: 'T1', title: 'A', agentType: 'code-agent', risk: 'low' }] },
    ],
  });
  const r = run(input, '--mode', 'phased', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tasks.length, 1);
});

// ===== Pipeline mode =====

test('pipeline mode: stage2 tasks auto-depend on stage1', () => {
  const input = JSON.stringify({
    title: 'Pipeline',
    stages: [
      { name: 'Build', tasks: [{ id: 'T1', title: 'Build', agentType: 'code-agent', risk: 'low' }] },
      { name: 'Test', tasks: [{ id: 'T2', title: 'Test', agentType: 'test-agent', risk: 'low' }] },
    ],
  });
  const r = run(input, '--mode', 'pipeline', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tasks.length, 2);
  assert.deepEqual(out.tasks[1].dependsOn, ['T1']);
});

test('pipeline mode: stage3 auto-depends on stage1+stage2', () => {
  const input = JSON.stringify({
    title: 'Pipeline',
    stages: [
      { name: 'Build', tasks: [{ id: 'T1', title: 'Build', agentType: 'code-agent', risk: 'low' }] },
      { name: 'Test', tasks: [{ id: 'T2', title: 'Testing', agentType: 'test-agent', risk: 'low' }, { id: 'T3', title: 'Lint', agentType: 'review-agent', risk: 'low' }] },
      { name: 'Deploy', tasks: [{ id: 'T4', title: 'Deploy', agentType: 'devops-agent', risk: 'high' }] },
    ],
  });
  const r = run(input, '--mode', 'pipeline', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tasks.length, 4);
  // T4 depends on all of T1, T2, T3
  const t4 = out.tasks.find(t => t.id === 'T4');
  assert.deepEqual(t4.dependsOn.sort(), ['T1', 'T2', 'T3']);
});

test('pipeline mode: explicit dependsOn merged with auto-deps', () => {
  const input = JSON.stringify({
    title: 'Pipeline',
    stages: [
      { name: 'S1', tasks: [{ id: 'T1', title: 'A', agentType: 'code-agent', risk: 'low' }] },
      { name: 'S2', tasks: [{ id: 'T2', title: 'B', agentType: 'test-agent', dependsOn: ['T1'], risk: 'low' }] },
      { name: 'S3', tasks: [{ id: 'T3', title: 'C', agentType: 'devops-agent', risk: 'high' }] },
    ],
  });
  const r = run(input, '--mode', 'pipeline', '--dry-run');
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  const t3 = out.tasks.find(t => t.id === 'T3');
  assert.deepEqual(t3.dependsOn.sort(), ['T1', 'T2']);
});

test('pipeline mode: empty stages → error', () => {
  const r = run('{"title":"X","stages":[]}', '--mode', 'pipeline');
  assert.equal(r.exitCode, 1);
});

// ===== General =====

test('rejects invalid JSON', () => {
  const r = run('not json{', '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('Invalid JSON'));
});

test('rejects empty stdin', () => {
  const r = run('', '--mode', 'flat');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('Empty input'));
});

test('--help shows usage', () => {
  const r = run('', '--help');
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes('Usage:'));
  assert.ok(r.stdout.includes('Modes:'));
});

test('missing --mode exits with error', () => {
  const r = run('{}');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('--mode is required'));
});

test('unknown --mode exits with error', () => {
  const r = run('{}', '--mode', 'unknown');
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderr.includes('Unknown mode'));
});

// ===== Summary =====
console.log(`\n${'='.repeat(50)}`);
console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
