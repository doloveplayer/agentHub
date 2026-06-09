import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { prisma } from '../../../../apps/api/src/db/prisma.ts';
import { signToken } from '../../../../apps/api/src/lib/jwt.ts';

const API_WS = 'ws://127.0.0.1:3000/ws';
const OUT = resolve('docs/superpowers/reports/evidence/planner-dag-ws-evidence.json');
const stamp = Date.now();

type EventRecord = {
  at: number;
  type: string;
  planId?: string;
  taskId?: string;
  agentName?: string;
  agentMessageId?: string;
  output?: string;
  error?: string;
  blockedBy?: string;
  content?: string;
  total?: number;
  completed?: number;
  failed?: number;
};

type WsClient = {
  ws: WebSocket;
  events: EventRecord[];
  send: (data: Record<string, unknown>) => void;
  waitFor: (label: string, predicate: (event: EventRecord) => boolean, timeoutMs?: number) => Promise<EventRecord>;
  close: () => Promise<void>;
};

function now(startedAt: number): number {
  return Date.now() - startedAt;
}

async function main() {
  const startedAt = Date.now();
  const user = await prisma.user.upsert({
    where: { githubId: 990025 },
    update: { login: 'dag-test-user', avatarUrl: 'https://example.com/dag.png', email: 'dag@example.com' },
    create: { githubId: 990025, login: 'dag-test-user', avatarUrl: 'https://example.com/dag.png', email: 'dag@example.com' },
  });
  const agents = await prisma.agent.findMany({
    where: { name: { in: ['planner', 'test-agent', 'review-agent', 'deps-agent', 'code-agent'] } },
    orderBy: { name: 'asc' },
  });
  assert.ok(agents.length >= 4, `expected default agents, got ${agents.length}`);

  const session = await prisma.session.create({
    data: {
      title: `DAG WS evidence ${stamp}`,
      type: 'group',
      userId: user.id,
      agents: { create: agents.map((agent) => ({ agentId: agent.id })) },
    },
  });
  const token = signToken({ userId: user.id, githubLogin: user.login });
  const client = await openClient(session.id, token, startedAt);
  const checks: Record<string, unknown> = {};

  try {
    const orderPlanId = `plan-dag-order-${stamp}`;
    const orderTasks = [
      task('task-a', 'Root slow task', 'TestAgent', 'mock-dag-delay:350 root must finish before review', []),
      task('task-b', 'Dependent review task', 'ReviewAgent', 'mock-dag-success must wait for task-a', ['task-a']),
      task('task-c', 'Independent dependency audit', 'DepsAgent', 'mock-dag-delay:80 sibling can run in parallel', []),
    ];
    client.send({ type: 'confirm_plan', planId: orderPlanId, tasks: orderTasks });
    await client.waitFor('order plan summary', (event) => event.type === 'plan_summary' && event.planId === orderPlanId, 8_000);
    const orderEvents = planEvents(client.events, orderPlanId);
    const taskACompleted = indexOf(orderEvents, 'task_completed', 'task-a');
    const taskBAssigned = indexOf(orderEvents, 'task_assigned', 'task-b');
    const taskCAssigned = indexOf(orderEvents, 'task_assigned', 'task-c');
    assert.ok(taskACompleted >= 0, 'task-a completed');
    assert.ok(taskBAssigned > taskACompleted, 'task-b assigned only after task-a completed');
    assert.ok(taskCAssigned >= 0 && taskCAssigned < taskACompleted, 'independent task-c started before task-a finished');
    checks.order = { taskACompleted, taskBAssigned, taskCAssigned };

    const failPlanId = `plan-dag-failure-${stamp}`;
    const failTasks = [
      task('fail-root', 'Failing root task', 'TestAgent', 'mock-dag-fail root failure', []),
      task('sibling', 'Independent sibling task', 'DepsAgent', 'mock-dag-success sibling unaffected', []),
      task('dependent', 'Dependent task blocked by fail-root', 'ReviewAgent', 'mock-dag-success should not run', ['fail-root']),
    ];
    client.send({ type: 'confirm_plan', planId: failPlanId, tasks: failTasks });
    await client.waitFor('failure plan summary', (event) => event.type === 'plan_summary' && event.planId === failPlanId, 8_000);
    const failureEvents = planEvents(client.events, failPlanId);
    assert.ok(hasEvent(failureEvents, 'task_failed', 'fail-root'), 'fail-root failed');
    assert.ok(hasEvent(failureEvents, 'task_completed', 'sibling'), 'independent sibling completed');
    assert.ok(hasEvent(failureEvents, 'task_blocked', 'dependent'), 'dependent was blocked');
    assert.equal(hasEvent(failureEvents, 'task_assigned', 'dependent'), false, 'blocked dependent was not assigned');
    checks.failure = {
      failRootFailed: true,
      siblingCompleted: true,
      dependentBlocked: true,
      dependentAssigned: false,
    };

    const modifyPlanId = `plan-dag-modify-${stamp}`;
    client.send({
      type: 'modify_task',
      planId: modifyPlanId,
      taskId: 'task-edit',
      newDescription: 'mock-dag-success edited description from modify_task',
    });
    await client.waitFor('task_modified', (event) => event.type === 'task_modified' && event.planId === modifyPlanId && event.taskId === 'task-edit', 2_000);
    client.send({
      type: 'confirm_plan',
      planId: modifyPlanId,
      tasks: [task('task-edit', 'Editable task', 'ReviewAgent', 'mock-dag-success original description', [])],
    });
    await client.waitFor('modify plan summary', (event) => event.type === 'plan_summary' && event.planId === modifyPlanId, 5_000);
    const editPromptSeen = client.events.some((event) =>
      event.type === 'stream_chunk' &&
      event.agentMessageId?.includes('task-edit') &&
      event.content?.includes('edited description from modify_task')
    );
    assert.equal(editPromptSeen, true, 'modified description reached task prompt');
    checks.modifyTask = { editedPromptSeen: true };

    const retryPlanId = `plan-dag-retry-${stamp}`;
    const retryTask = task('retry-task', 'Retry once task', 'ReviewAgent', 'mock-dag-fail-once retry should pass on second attempt', []);
    client.send({ type: 'confirm_plan', planId: retryPlanId, tasks: [retryTask] });
    await client.waitFor('retry first failure', (event) => event.type === 'task_failed' && event.planId === retryPlanId && event.taskId === 'retry-task', 5_000);
    client.send({ type: 'retry_task', planId: retryPlanId, taskId: 'retry-task', task: retryTask });
    await client.waitFor('retry completion', (event) => event.type === 'task_completed' && event.planId === retryPlanId && event.taskId === 'retry-task', 5_000);
    checks.retry = {
      failedThenCompleted: true,
      assignedCount: planEvents(client.events, retryPlanId).filter((event) => event.type === 'task_assigned' && event.taskId === 'retry-task').length,
    };

    const retryDagPlanId = `plan-dag-retry-dependent-${stamp}`;
    const retryRoot = task('retry-root', 'Retry root task', 'ReviewAgent', 'mock-dag-fail-once root should release child after retry', []);
    const retryChild = task('retry-child', 'Retry child task', 'DepsAgent', 'mock-dag-success child waits for retry-root', ['retry-root']);
    client.send({ type: 'confirm_plan', planId: retryDagPlanId, tasks: [retryRoot, retryChild] });
    await client.waitFor(
      'retry dag first summary',
      (event) => event.type === 'plan_summary' && event.planId === retryDagPlanId && event.failed === 2,
      5_000,
    );
    client.send({ type: 'retry_task', planId: retryDagPlanId, taskId: 'retry-root', task: retryRoot });
    await client.waitFor(
      'retry dag recovered summary',
      (event) =>
        event.type === 'plan_summary' &&
        event.planId === retryDagPlanId &&
        event.total === 2 &&
        event.completed === 2 &&
        event.failed === 0,
      8_000,
    );
    const retryDagEvents = planEvents(client.events, retryDagPlanId);
    assert.ok(indexOf(retryDagEvents, 'task_completed', 'retry-child') > indexOf(retryDagEvents, 'task_completed', 'retry-root'));
    checks.retryDag = {
      failedSummarySeen: true,
      recoveredSummarySeen: true,
      dependentCompletedAfterRetry: true,
    };

    client.send({ type: 'retry_task', planId: `plan-dag-retry-missing-${stamp}`, taskId: 'missing-task' });
    await client.waitFor(
      'retry missing task rejection',
      (event) => event.type === 'stream_error' && /Retry requires full task data/.test(event.error || ''),
      3_000,
    );
    checks.retryRequiresTaskData = true;

    const duplicatePlanId = `plan-dag-duplicate-${stamp}`;
    const duplicateTask = task('dupe-task', 'Duplicate confirm task', 'DepsAgent', 'mock-dag-success duplicate dispatch guard', []);
    client.send({ type: 'confirm_plan', planId: duplicatePlanId, tasks: [duplicateTask] });
    client.send({ type: 'confirm_plan', planId: duplicatePlanId, tasks: [duplicateTask] });
    await client.waitFor('duplicate plan summary', (event) => event.type === 'plan_summary' && event.planId === duplicatePlanId, 5_000);
    await sleep(250);
    const duplicateAssigned = planEvents(client.events, duplicatePlanId).filter((event) => event.type === 'task_assigned' && event.taskId === 'dupe-task');
    assert.equal(duplicateAssigned.length, 1, 'duplicate confirm did not redispatch task');
    checks.duplicateConfirm = { assignedCount: duplicateAssigned.length };

    const cyclePlanId = `plan-dag-cycle-${stamp}`;
    client.send({
      type: 'confirm_plan',
      planId: cyclePlanId,
      tasks: [
        task('cycle-a', 'Cycle A', 'ReviewAgent', 'mock-dag-success', ['cycle-b']),
        task('cycle-b', 'Cycle B', 'DepsAgent', 'mock-dag-success', ['cycle-a']),
      ],
    });
    await client.waitFor('cycle stream_error', (event) => event.type === 'stream_error' && /Circular dependency/.test(event.error || ''), 3_000);
    await sleep(250);
    assert.equal(planEvents(client.events, cyclePlanId).some((event) => event.type === 'task_assigned'), false, 'cycle plan was not assigned');
    checks.cycleRejection = { streamError: true, assigned: false };

    const evidence = {
      createdAt: new Date().toISOString(),
      provider: 'test',
      deploymentScope: 'excluded by request',
      api: 'http://127.0.0.1:3000',
      sessionId: session.id,
      agents: agents.map((agent) => ({ name: agent.name, displayName: agent.displayName })),
      checks,
      events: client.events,
    };
    writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, evidence: OUT, checks }, null, 2));
  } finally {
    await client.close();
    await prisma.$disconnect();
  }
}

function task(id: string, title: string, agentType: string, description: string, dependsOn: string[]) {
  return {
    taskId: id,
    id,
    planId: '',
    title,
    description,
    agentType,
    dependsOn,
    expectedOutput: `${id}.txt`,
    priority: 'medium',
    status: 'waiting',
  };
}

async function openClient(sessionId: string, token: string, startedAt: number): Promise<WsClient> {
  const ws = new WebSocket(`${API_WS}?token=${encodeURIComponent(token)}&sessionId=${sessionId}`);
  const events: EventRecord[] = [];

  ws.on('message', (raw) => {
    const data = JSON.parse(raw.toString());
    const record: EventRecord = {
      at: now(startedAt),
      type: data.type,
      planId: data.planId,
      taskId: data.taskId,
      agentName: data.agentName,
      agentMessageId: data.agentMessageId,
      output: data.output,
      error: data.error || data.message,
      blockedBy: data.blockedBy,
      content: data.content,
      total: data.total,
      completed: data.completed,
      failed: data.failed,
    };
    events.push(record);
    if (data.type === 'permission_request' && data.permissionId) {
      ws.send(JSON.stringify({ type: 'permission_response', permissionId: data.permissionId, allowed: true }));
    }
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once('open', () => resolveOpen());
    ws.once('error', rejectOpen);
    setTimeout(() => rejectOpen(new Error('Timed out opening WebSocket')), 5_000);
  });

  return {
    ws,
    events,
    send(data) {
      ws.send(JSON.stringify(data));
    },
    waitFor(label, predicate, timeoutMs = 5_000) {
      return waitForEvent(events, label, predicate, timeoutMs);
    },
    close() {
      return new Promise<void>((resolveClose) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolveClose();
          return;
        }
        ws.once('close', () => resolveClose());
        ws.close();
        setTimeout(() => resolveClose(), 1_000);
      });
    },
  };
}

function waitForEvent(
  events: EventRecord[],
  label: string,
  predicate: (event: EventRecord) => boolean,
  timeoutMs: number,
): Promise<EventRecord> {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const tick = () => {
      const event = events.find(predicate);
      if (event) {
        resolveWait(event);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        rejectWait(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function planEvents(events: EventRecord[], planId: string): EventRecord[] {
  return events.filter((event) => event.planId === planId);
}

function hasEvent(events: EventRecord[], type: string, taskId: string): boolean {
  return events.some((event) => event.type === type && event.taskId === taskId);
}

function indexOf(events: EventRecord[], type: string, taskId: string): number {
  return events.findIndex((event) => event.type === type && event.taskId === taskId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
