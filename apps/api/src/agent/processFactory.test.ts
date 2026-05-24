import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { createOneShotAgentProcess } from './processFactory.js';
import { TestAgentProcess } from './TestAgentProcess.js';
import { ClaudeCodeProcess } from './ClaudeCodeProcess.js';

test('createOneShotAgentProcess selects only explicit supported providers', () => {
  const original = config.agent.provider;
  try {
    (config.agent as any).provider = 'test';
    assert.ok(createOneShotAgentProcess() instanceof TestAgentProcess);

    (config.agent as any).provider = 'claude-code';
    assert.ok(createOneShotAgentProcess() instanceof ClaudeCodeProcess);

    (config.agent as any).provider = 'unknown-provider';
    assert.throws(() => createOneShotAgentProcess(), /Unknown one-shot agent provider/);
  } finally {
    (config.agent as any).provider = original;
  }
});
