import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTaskRunOutput,
  clearActiveTaskRun,
  getActiveTaskRun,
  setActiveTaskRun,
} from './taskEventRouter.js';

test('active task run routing follows the latest task for a reused agent provider', () => {
  setActiveTaskRun({
    sessionId: 'session-1',
    agentName: 'code-agent-session-1',
    planId: 'plan-1',
    taskId: 'T-old',
    taskMessageId: 'task-plan-1-T-old',
  });

  setActiveTaskRun({
    sessionId: 'session-1',
    agentName: 'code-agent-session-1',
    planId: 'plan-1',
    taskId: 'T-new',
    taskMessageId: 'task-plan-1-T-new',
  });

  const output = appendTaskRunOutput('session-1', 'code-agent-session-1', 'finished new task');

  assert.equal(output, 'finished new task');
  assert.equal(getActiveTaskRun('session-1', 'code-agent-session-1')?.taskMessageId, 'task-plan-1-T-new');

  clearActiveTaskRun('session-1', 'code-agent-session-1', 'task-plan-1-T-old');
  assert.equal(getActiveTaskRun('session-1', 'code-agent-session-1')?.taskMessageId, 'task-plan-1-T-new');

  clearActiveTaskRun('session-1', 'code-agent-session-1', 'task-plan-1-T-new');
  assert.equal(getActiveTaskRun('session-1', 'code-agent-session-1'), undefined);
});
