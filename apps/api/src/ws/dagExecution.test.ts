import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDagExecutionState,
  consumeReadyTasks,
  markTaskDone,
  markTaskFailed,
  markTaskRetryQueued,
  type DagTaskAssignment,
} from './dagExecution.js';

const baseTask = {
  title: 'Task',
  description: 'mock-dag-success',
  agentType: 'TestAgent',
  expectedOutput: 'out.txt',
  priority: 'medium' as const,
};

function assignment(id: string, dependsOn: string[] = [], agentName = 'test-agent'): DagTaskAssignment {
  return {
    task: { ...baseTask, id, dependsOn },
    agentName,
    agentId: `${agentName}-id`,
  };
}

test('DAG execution releases dependents only after prerequisites complete', () => {
  const state = createDagExecutionState('plan-1', [
    assignment('task-a', [], 'test-agent'),
    assignment('task-b', ['task-a'], 'review-agent'),
  ]);

  assert.deepEqual(consumeReadyTasks(state).map((item) => item.task.id), ['task-a']);
  assert.deepEqual(consumeReadyTasks(state), []);

  const released = markTaskDone(state, 'task-a');
  assert.deepEqual(released.map((item) => item.task.id), ['task-b']);
});

test('DAG execution blocks only descendants when one task fails', () => {
  const state = createDagExecutionState('plan-1', [
    assignment('task-a', [], 'test-agent'),
    assignment('task-b', [], 'deps-agent'),
    assignment('task-c', ['task-a'], 'review-agent'),
  ]);

  assert.deepEqual(consumeReadyTasks(state).map((item) => item.task.id), ['task-a', 'task-b']);
  const blocked = markTaskFailed(state, 'task-a');

  assert.deepEqual(blocked.map((item) => item.task.id), ['task-c']);
  assert.equal(state.tasks.get('task-b')?.status, 'queued');
});

test('DAG execution rejects circular dependencies', () => {
  assert.throws(
    () => createDagExecutionState('plan-1', [
      assignment('task-a', ['task-b']),
      assignment('task-b', ['task-a']),
    ]),
    /Circular dependency/,
  );
});

test('DAG execution retry releases descendants after failed task succeeds', () => {
  const state = createDagExecutionState('plan-1', [
    assignment('task-a', [], 'test-agent'),
    assignment('task-b', ['task-a'], 'review-agent'),
  ]);

  assert.deepEqual(consumeReadyTasks(state).map((item) => item.task.id), ['task-a']);
  assert.deepEqual(markTaskFailed(state, 'task-a').map((item) => item.task.id), ['task-b']);
  assert.equal(state.tasks.get('task-b')?.status, 'blocked');

  const retry = markTaskRetryQueued(state, 'task-a');
  assert.equal(retry?.task.id, 'task-a');
  assert.equal(state.tasks.get('task-a')?.status, 'queued');
  assert.equal(state.tasks.get('task-b')?.status, 'waiting');

  assert.deepEqual(consumeReadyTasks(state), []);
  assert.deepEqual(markTaskDone(state, 'task-a').map((item) => item.task.id), ['task-b']);
});

test('DAG execution retry does not release descendants blocked by another failed dependency', () => {
  const state = createDagExecutionState('plan-1', [
    assignment('task-a', [], 'test-agent'),
    assignment('task-b', [], 'deps-agent'),
    assignment('task-c', ['task-a', 'task-b'], 'review-agent'),
  ]);

  assert.deepEqual(consumeReadyTasks(state).map((item) => item.task.id), ['task-a', 'task-b']);
  assert.deepEqual(markTaskFailed(state, 'task-a').map((item) => item.task.id), ['task-c']);
  assert.deepEqual(markTaskFailed(state, 'task-b'), []);

  const retry = markTaskRetryQueued(state, 'task-a');
  assert.equal(retry?.task.id, 'task-a');
  assert.equal(state.tasks.get('task-c')?.status, 'blocked');
  assert.deepEqual(markTaskDone(state, 'task-a'), []);
});
