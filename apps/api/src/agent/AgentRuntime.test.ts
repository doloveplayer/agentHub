import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentRuntime } from './AgentRuntime.js';

describe('AgentRuntime', () => {
  it('should return empty queue for unknown agent', () => {
    const status = agentRuntime.getQueueStatus('nonexistent-agent-id');
    assert.equal(status.pending, 0);
    assert.equal(status.currentSession, null);
  });

  it('should report not running for unknown agent', () => {
    assert.equal(agentRuntime.isRunning('nonexistent-agent-id'), false);
  });
});
