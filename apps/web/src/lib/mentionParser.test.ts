import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recommendAgents } from './mentionParser.js';

const agents = [
  {
    id: '1',
    name: 'code-agent',
    displayName: 'CodeAgent',
    description: 'Writes code',
    systemPrompt: 'code',
  },
  {
    id: '2',
    name: 'review-agent',
    displayName: 'ReviewAgent',
    description: 'Reviews code',
    systemPrompt: 'review',
  },
];

describe('recommendAgents', () => {
  it('returns all agents for an empty @ query so the mention popup can open', () => {
    const result = recommendAgents('', agents, []);

    assert.deepEqual(result.map((agent) => agent.name), ['code-agent', 'review-agent']);
  });
});
