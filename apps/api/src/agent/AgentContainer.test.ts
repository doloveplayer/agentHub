import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('AgentContainer', () => {
  it('config agentContainer settings are defined', async () => {
    const { config } = await import('../config.js');
    assert.ok(config.agentContainer.hostRoot.endsWith('.agents'), 'hostRoot should end with .agents');
    assert.equal(typeof config.agentContainer.memoryMb, 'number');
    assert.equal(typeof config.agentContainer.idleTimeoutMs, 'number');
  });
});
