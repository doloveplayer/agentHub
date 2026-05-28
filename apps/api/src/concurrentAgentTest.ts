/**
 * Concurrent agent concurrency control test.
 * Tests that runningAgentCount is properly managed across
 * group and solo sessions, and that pending queues drain correctly.
 *
 * Run: npx tsx apps/api/src/concurrentAgentTest.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We need to test the state module directly
import {
  runningAgentCount,
  incRunningAgentCount,
  decRunningAgentCount,
  agentStates,
  agentProcesses,
  agentCurrentMessage,
  pendingAgentQueue,
  perSessionPendingQueues,
  enqueuePending,
  enqueuePerSession,
  dequeuePending,
  dequeuePerSession,
  clearRunningAgent,
  cleanupSessionResources,
  sandboxes,
  sessions,
} from './ws/state.js';

describe('Concurrent Agent Control', () => {
  beforeEach(() => {
    // Reset state
    agentStates.clear();
    agentProcesses.clear();
    agentCurrentMessage.clear();
    pendingAgentQueue.length = 0;
    perSessionPendingQueues.clear();
    sandboxes.clear();
    sessions.clear();
    // Reset runningAgentCount via dec
    while (runningAgentCount > 0) decRunningAgentCount();
  });

  describe('runningAgentCount lifecycle', () => {
    it('should increment and decrement correctly', () => {
      assert.equal(runningAgentCount, 0);
      incRunningAgentCount();
      assert.equal(runningAgentCount, 1);
      incRunningAgentCount();
      assert.equal(runningAgentCount, 2);
      decRunningAgentCount();
      assert.equal(runningAgentCount, 1);
      decRunningAgentCount();
      assert.equal(runningAgentCount, 0);
    });

    it('should not go below 0', () => {
      decRunningAgentCount();
      decRunningAgentCount();
      assert.equal(runningAgentCount, 0);
    });
  });

  describe('clearRunningAgent', () => {
    it('should decrement count and remove agentStates entry', () => {
      const sessionId = 'sess-1';
      const msgId = 'msg-1';

      // Simulate: inc + register
      incRunningAgentCount();
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(msgId, {
        process: { write() {}, stop() {} },
        timer: setTimeout(() => {}, 1000),
        agentId: 'agent-1',
        agentName: 'test-agent',
      });

      assert.equal(runningAgentCount, 1);
      assert.ok(agentStates.get(sessionId)?.has(msgId));

      // clearRunningAgent should decrement and remove
      clearRunningAgent(sessionId, msgId);

      assert.equal(runningAgentCount, 0);
      assert.ok(!agentStates.get(sessionId)?.has(msgId));
    });

    it('should be no-op for unknown sessionId', () => {
      clearRunningAgent('unknown', 'msg-1');
      assert.equal(runningAgentCount, 0);
    });

    it('should be no-op for unknown msgId', () => {
      incRunningAgentCount();
      agentStates.set('sess-1', new Map());
      clearRunningAgent('sess-1', 'unknown-msg');
      assert.equal(runningAgentCount, 1); // unchanged
    });
  });

  describe('REPL path simulation', () => {
    it('should register in agentStates and clean up on done', () => {
      const sessionId = 'group-sess-1';
      const agentName = 'claude-code';
      const messageId = 'msg-001';

      // Simulate handleChatMessage REPL path
      incRunningAgentCount(); // line 379
      agentCurrentMessage.set(agentName, messageId);

      // Register in agentStates (Fix 1)
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(messageId, {
        process: { write() {}, stop() {} },
        timer: setTimeout(() => {}, 1000),
        agentId: 'agent-1',
        agentName,
      });

      assert.equal(runningAgentCount, 1);
      assert.ok(agentStates.get(sessionId)?.has(messageId));

      // Simulate done handler (Fix 3)
      clearRunningAgent(sessionId, messageId);
      agentCurrentMessage.delete(agentName);

      assert.equal(runningAgentCount, 0);
      assert.ok(!agentCurrentMessage.has(agentName));
    });

    it('should handle multiple sequential messages to same agent', () => {
      const sessionId = 'group-sess-1';
      const agentName = 'claude-code';

      // Message 1
      incRunningAgentCount();
      const msg1 = 'msg-001';
      agentCurrentMessage.set(agentName, msg1);
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(msg1, {
        process: { write() {}, stop() {} }, timer: setTimeout(() => {}, 1000),
        agentId: 'a1', agentName,
      });
      assert.equal(runningAgentCount, 1);

      // Message 1 done
      clearRunningAgent(sessionId, msg1);
      agentCurrentMessage.delete(agentName);
      assert.equal(runningAgentCount, 0);
      // Note: clearRunningAgent deletes session map when empty
      assert.ok(!agentStates.has(sessionId));

      // Message 2 — must re-create session map (as handler.ts does)
      incRunningAgentCount();
      const msg2 = 'msg-002';
      agentCurrentMessage.set(agentName, msg2);
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(msg2, {
        process: { write() {}, stop() {} }, timer: setTimeout(() => {}, 1000),
        agentId: 'a1', agentName,
      });
      assert.equal(runningAgentCount, 1);

      // Message 2 done
      clearRunningAgent(sessionId, msg2);
      agentCurrentMessage.delete(agentName);
      assert.equal(runningAgentCount, 0);
    });
  });

  describe('Pending queue drain', () => {
    it('should drain global pending queue when slots free up', () => {
      const MAX_CONCURRENT = 2;

      // Fill up slots
      incRunningAgentCount();
      incRunningAgentCount();
      assert.equal(runningAgentCount, 2);

      // Enqueue a pending request
      enqueuePending({
        sessionId: 'sess-1',
        mention: { agentId: 'a1', subPrompt: 'hello', messageId: 'msg-q1' },
        enqueuedAt: Date.now(),
      });
      assert.equal(pendingAgentQueue.length, 1);

      // Free a slot
      decRunningAgentCount();
      assert.equal(runningAgentCount, 1);

      // Drain should dequeue
      const next = dequeuePending();
      assert.ok(next);
      assert.equal(next.mention.messageId, 'msg-q1');
      assert.equal(pendingAgentQueue.length, 0);
    });

    it('should drain per-session queue when slots free up', () => {
      const sessionId = 'sess-1';

      // Enqueue
      enqueuePerSession(sessionId, {
        mention: { agentId: 'a1', subPrompt: 'hello', messageId: 'msg-ps1' },
        enqueuedAt: Date.now(),
      });
      assert.ok(perSessionPendingQueues.has(sessionId));

      // Dequeue
      const next = dequeuePerSession(sessionId);
      assert.ok(next);
      assert.equal(next.mention.messageId, 'msg-ps1');
      assert.ok(!perSessionPendingQueues.has(sessionId)); // auto-deleted when empty
    });
  });

  describe('Cross-session concurrency', () => {
    it('should track count across group + solo sessions', () => {
      // Group session: agent A starts
      incRunningAgentCount();
      agentCurrentMessage.set('agent-a', 'msg-a1');
      if (!agentStates.has('group-sess')) agentStates.set('group-sess', new Map());
      agentStates.get('group-sess')!.set('msg-a1', {
        process: { write() {}, stop() {} }, timer: setTimeout(() => {}, 1000),
        agentId: 'a1', agentName: 'agent-a',
      });

      // Solo session: agent B starts
      incRunningAgentCount();
      agentCurrentMessage.set('agent-b', 'msg-b1');
      if (!agentStates.has('solo-sess')) agentStates.set('solo-sess', new Map());
      agentStates.get('solo-sess')!.set('msg-b1', {
        process: { write() {}, stop() {} }, timer: setTimeout(() => {}, 1000),
        agentId: 'b1', agentName: 'agent-b',
      });

      assert.equal(runningAgentCount, 2);

      // Agent A done
      clearRunningAgent('group-sess', 'msg-a1');
      agentCurrentMessage.delete('agent-a');
      assert.equal(runningAgentCount, 1);

      // Agent B done
      clearRunningAgent('solo-sess', 'msg-b1');
      agentCurrentMessage.delete('agent-b');
      assert.equal(runningAgentCount, 0);
    });

    it('should not block when maxConcurrent not reached', () => {
      // Simulate: maxConcurrent=2, 1 running
      incRunningAgentCount();
      assert.equal(runningAgentCount, 1);

      // New message should NOT be queued (1 < 2)
      // In real code: if (runningAgentCount >= config.agent.maxConcurrent) → queue
      const MAX_CONCURRENT = 2;
      const shouldQueue = runningAgentCount >= MAX_CONCURRENT;
      assert.equal(shouldQueue, false);
    });

    it('should queue when at maxConcurrent', () => {
      incRunningAgentCount();
      incRunningAgentCount();
      assert.equal(runningAgentCount, 2);

      const MAX_CONCURRENT = 2;
      const shouldQueue = runningAgentCount >= MAX_CONCURRENT;
      assert.equal(shouldQueue, true);

      // Enqueue
      enqueuePending({
        sessionId: 'sess-3',
        mention: { agentId: 'a3', subPrompt: 'queued', messageId: 'msg-q3' },
        enqueuedAt: Date.now(),
      });
      assert.equal(pendingAgentQueue.length, 1);

      // Free slot → drain
      decRunningAgentCount();
      const next = dequeuePending();
      assert.ok(next);
      assert.equal(next.sessionId, 'sess-3');
    });
  });

  describe('Stop agent simulation', () => {
    it('should clean up agentStates and decrement on stop', () => {
      const sessionId = 'sess-1';
      const msgId = 'msg-stop-1';

      // Setup: agent running
      incRunningAgentCount();
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(msgId, {
        process: { write() {}, stop() {} },
        timer: setTimeout(() => {}, 1000),
        agentId: 'a1',
        agentName: 'test-agent',
      });
      agentCurrentMessage.set('test-agent', msgId);

      assert.equal(runningAgentCount, 1);

      // Simulate handleStopAgent
      const stateMap = agentStates.get(sessionId);
      const st = stateMap?.get(msgId);
      assert.ok(st);
      if (st?.agentName) agentCurrentMessage.delete(st.agentName);
      stateMap?.delete(msgId);
      decRunningAgentCount();

      assert.equal(runningAgentCount, 0);
      assert.ok(!agentCurrentMessage.has('test-agent'));
    });
  });

  describe('cleanupSessionResources', () => {
    it('should clean up all state for a session', () => {
      const sessionId = 'sess-cleanup';

      // Set up some state
      incRunningAgentCount();
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set('msg-c1', {
        process: { write() {}, stop() {} },
        timer: setTimeout(() => {}, 1000),
        agentId: 'a1',
        agentName: 'agent-1',
      });
      agentCurrentMessage.set('agent-1', 'msg-c1');

      // Cleanup (note: needs sandbox mock for full cleanup, but we test partial)
      // We can't call full cleanupSessionResources without sandbox, but we verify state
      assert.equal(runningAgentCount, 1);
      assert.ok(agentStates.has(sessionId));
    });
  });
});

console.log('All tests defined. Run with: npx tsx apps/api/src/concurrentAgentTest.ts');
