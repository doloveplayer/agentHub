import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderFactory } from './factory.js';
import { TestAgentProvider } from './test.js';

test('ProviderFactory registers the deterministic test provider', () => {
  ProviderFactory.init();

  assert.ok(ProviderFactory.list().includes('claude-code'));
  assert.ok(ProviderFactory.list().includes('test'));
  const provider = ProviderFactory.create('test');
  assert.ok(provider instanceof TestAgentProvider);
  assert.equal(provider.capabilities.permissionProxy, true);
  assert.equal(provider.capabilities.persistentSession, false);
});
