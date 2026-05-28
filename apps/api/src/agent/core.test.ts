// Core unit tests for AgentHub agent layer.
// Run: npx tsx --test apps/api/src/agent/core.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert';

// ============================================================
// Mention matching (turns.ts)
// ============================================================
import { normalizeAgentHandle, matchAgentByHandle, selectDefaultAgent, findClosestAgent } from './turns.js';

describe('normalizeAgentHandle', () => {
  it('strips @ and lowercases', () => {
    assert.strictEqual(normalizeAgentHandle('@CodeAgent'), 'codeagent');
    assert.strictEqual(normalizeAgentHandle('code-agent'), 'codeagent');
    assert.strictEqual(normalizeAgentHandle('@CODE-AGENT'), 'codeagent');
  });
});

describe('matchAgentByHandle', () => {
  const agents = [
    { id: '1', name: 'code-agent', displayName: 'CodeAgent' },
    { id: '2', name: 'review-agent', displayName: 'ReviewAgent' },
  ];

  it('exact name match', () => {
    const m = matchAgentByHandle('code-agent', agents);
    assert.ok(m);
    assert.strictEqual(m!.name, 'code-agent');
  });

  it('displayName match', () => {
    const m = matchAgentByHandle('codeagent', agents);
    assert.ok(m);
    assert.strictEqual(m!.displayName, 'CodeAgent');
  });

  it('prefix match', () => {
    const m = matchAgentByHandle('code', agents);
    assert.ok(m);
    assert.strictEqual(m!.name, 'code-agent');
  });

  it('returns null for no match', () => {
    assert.strictEqual(matchAgentByHandle('unknown', agents), null);
  });
});

describe('selectDefaultAgent', () => {
  const agents = [
    { id: '1', name: 'code-agent', displayName: 'CodeAgent' },
    { id: '2', name: 'planner', displayName: 'Planner' },
  ];

  it('solo session picks code-agent', () => {
    const sessionAgents = [
      { agentId: '1', name: 'code-agent', displayName: 'CodeAgent' },
      { agentId: '2', name: 'planner', displayName: 'Planner' },
    ];
    const result = selectDefaultAgent('solo', sessionAgents, agents);
    assert.ok(result);
    assert.strictEqual(result!.name, 'code-agent');
  });

  it('group session picks planner', () => {
    const sessionAgents = [
      { agentId: '1', name: 'code-agent', displayName: 'CodeAgent' },
      { agentId: '2', name: 'planner', displayName: 'Planner' },
    ];
    const result = selectDefaultAgent('group', sessionAgents, agents);
    assert.ok(result);
    assert.strictEqual(result!.name, 'planner');
  });

  it('group without planner falls back to first', () => {
    const result = selectDefaultAgent('group', [{ agentId: '1', name: 'code-agent', displayName: 'CodeAgent' }], agents);
    assert.ok(result);
    assert.strictEqual(result!.name, 'code-agent');
  });

  it('empty session returns null', () => {
    assert.strictEqual(selectDefaultAgent('solo', [], agents), null);
  });
});

describe('findClosestAgent', () => {
  const available = [
    { name: 'code-agent', displayName: 'CodeAgent' },
    { name: 'review-agent', displayName: 'ReviewAgent' },
  ];

  it('exact match', () => {
    const r = findClosestAgent('CodeAgent', available);
    assert.ok(r);
    assert.strictEqual(r!.name, 'code-agent');
  });

  it('prefix match', () => {
    const r = findClosestAgent('DevOpsAgent', available);
    assert.ok(r);
    // No DevOpsAgent, but code-agent should match via prefix
    assert.strictEqual(r!.name, 'code-agent');
  });

  it('falls back to code-agent', () => {
    const r = findClosestAgent('UnknownAgent', available);
    assert.ok(r);
    assert.strictEqual(r!.name, 'code-agent');
  });

  it('empty available returns null', () => {
    assert.strictEqual(findClosestAgent('CodeAgent', []), null);
  });
});

// ============================================================
// toTaskStates (turns.ts)
// ============================================================
import { toTaskStates } from './turns.js';

describe('toTaskStates', () => {
  it('converts TaskPlan to frontend-friendly states', () => {
    const plan = {
      planTitle: 'Test', summary: 's',
      tasks: [
        { id: 'task-1', title: 'T1', description: 'd1', agentType: 'code-agent' as const, dependsOn: [], expectedOutput: 'f1', priority: 'high' as const },
        { id: 'task-2', title: 'T2', description: 'd2', agentType: 'review-agent' as const, dependsOn: ['task-1'], expectedOutput: 'f2', priority: 'medium' as const },
      ],
    };
    const states = toTaskStates(plan, 'plan-123');
    assert.strictEqual(states.length, 2);
    assert.strictEqual(states[0].taskId, 'task-1');
    assert.strictEqual(states[0].planId, 'plan-123');
    assert.strictEqual(states[0].status, 'waiting');
    assert.deepStrictEqual(states[1].dependsOn, ['task-1']);
  });
});

// ============================================================
// EventParser (basic)
// ============================================================
import { EventParser } from './EventParser.js';

describe('EventParser', () => {
  it('parses assistant text', () => {
    const evs = EventParser.parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}');
    assert.ok(evs.length > 0);
    assert.strictEqual(evs[0].type, 'text');
    if (evs[0].type === 'text') assert.strictEqual(evs[0].content, 'hello');
  });

  it('parses tool_use', () => {
    const evs = EventParser.parseLine('{"type":"tool_use","name":"Write","input":{"file_path":"/test.ts"}}');
    assert.ok(evs.length > 0);
    assert.strictEqual(evs[0].type, 'tool_use');
  });

  it('accumulates tool input from content_block_start/delta/stop', () => {
    EventParser.resetDeltaState();
    // content_block_start with tool_use — should NOT emit yet
    const start = EventParser.parseLine('{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash","input":{}}}');
    assert.strictEqual(start.length, 0);

    // content_block_delta with input JSON chunks
    const d1 = EventParser.parseLine('{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"comm"}}');
    assert.strictEqual(d1.length, 0);
    const d2 = EventParser.parseLine('{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"and\\":\\"ls -la\\"}"}}');
    assert.strictEqual(d2.length, 0);

    // content_block_stop — should emit complete tool_use with accumulated input
    const stop = EventParser.parseLine('{"type":"content_block_stop"}');
    assert.strictEqual(stop.length, 1);
    assert.strictEqual(stop[0].type, 'tool_use');
    assert.strictEqual((stop[0] as any).toolName, 'Bash');
    assert.deepStrictEqual((stop[0] as any).input, { command: 'ls -la' });

    EventParser.resetDeltaState();
  });

  it('parses result as done', () => {
    const evs = EventParser.parseLine('{"type":"result","subtype":"success"}');
    assert.ok(evs.length > 0);
    assert.strictEqual(evs[0].type, 'done');
  });

  it('returns empty array for structural events', () => {
    assert.strictEqual(EventParser.parseLine('{"type":"content_block_stop"}').length, 0);
  });

  it('handles non-JSON as text', () => {
    const evs = EventParser.parseLine('raw stdout output');
    assert.ok(evs.length > 0);
    assert.strictEqual(evs[0].type, 'text');
  });

  it('ignores empty lines', () => {
    assert.strictEqual(EventParser.parseLine('').length, 0);
    assert.strictEqual(EventParser.parseLine('  ').length, 0);
  });

  it('extracts token usage from assistant message', () => {
    const evs = EventParser.parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1500,"output_tokens":200}}}');
    const tokenEv = evs.find(e => e.type === 'token_usage');
    assert.ok(tokenEv);
    if (tokenEv?.type === 'token_usage') {
      assert.strictEqual(tokenEv.inputTokens, 1500);
      assert.strictEqual(tokenEv.outputTokens, 200);
    }
    const textEv = evs.find(e => e.type === 'text');
    assert.ok(textEv);
  });
});

// ============================================================
// Unified event conversion
// ============================================================

describe('EventParser.toUnified', () => {
  it('converts text → thinking', () => {
    const unified = EventParser.toUnified({ type: 'text', content: 'hello' });
    assert.ok(unified);
    assert.strictEqual(unified!.type, 'thinking');
    assert.strictEqual(unified!.content, 'hello');
  });

  it('converts tool_use', () => {
    const unified = EventParser.toUnified({ type: 'tool_use', toolName: 'Write', input: { file_path: '/f' } });
    assert.ok(unified);
    assert.strictEqual(unified!.type, 'tool_use');
    assert.strictEqual(unified!.toolName, 'Write');
  });

  it('converts done', () => {
    const unified = EventParser.toUnified({ type: 'done', exitCode: 0 });
    assert.ok(unified);
    assert.strictEqual(unified!.type, 'done');
    assert.strictEqual(unified!.exitCode, 0);
  });

  it('converts error', () => {
    const unified = EventParser.toUnified({ type: 'error', message: 'fail' });
    assert.ok(unified);
    assert.strictEqual(unified!.type, 'error');
  });

  it('returns null for system events', () => {
    assert.strictEqual(EventParser.toUnified({ type: 'system', subtype: 'init', message: '', sessionId: 's1' }), null);
  });
});
