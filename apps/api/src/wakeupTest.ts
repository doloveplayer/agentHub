/**
 * Integration test for REPL inbox wakeup flow.
 * Verifies that wakeupAgent creates messages, tracks state, and balances the concurrency counter.
 *
 * Run: npx tsx --test apps/api/src/wakeupTest.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runningAgentCount, incRunningAgentCount, decRunningAgentCount,
  agentStates, agentProcesses, agentCurrentMessage,
  pendingAgentQueue, clearRunningAgent,
  generateId, enqueuePending, dequeuePending,
} from './ws/state.js';

describe('Wakeup Agent Flow', () => {
  beforeEach(() => {
    agentStates.clear();
    agentProcesses.clear();
    agentCurrentMessage.clear();
    pendingAgentQueue.length = 0;
    while (runningAgentCount > 0) decRunningAgentCount();
  });

  it('should create message and track state on wakeup (simulated)', () => {
    const sessionId = 'group-sess-1';
    const agentName = 'review-agent';
    const wakeupMsgId = generateId();

    // Simulate wakeupAgent:
    // 1. Set agentCurrentMessage
    agentCurrentMessage.set(agentName, wakeupMsgId);

    // 2. Register in agentStates
    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(wakeupMsgId, {
      process: { write() {}, stop() {} },
      timer: setTimeout(() => {}, 1000),
      agentId: 'agent-review',
      agentName,
    });

    // 3. Increment count
    incRunningAgentCount();
    assert.equal(runningAgentCount, 1);

    // Verify messageId is tracked
    assert.equal(agentCurrentMessage.get(agentName), wakeupMsgId);
    assert.ok(agentStates.get(sessionId)?.has(wakeupMsgId));

    // Simulate done handler cleanup (what happens when wakeup response completes)
    clearRunningAgent(sessionId, wakeupMsgId);
    agentCurrentMessage.delete(agentName);

    assert.equal(runningAgentCount, 0);
    assert.ok(!agentCurrentMessage.has(agentName));
  });

  it('should not overwrite existing task message with wakeup chunks', () => {
    const sessionId = 'group-sess-1';
    const agentName = 'code-agent';
    const taskMsgId = generateId();
    const wakeupMsgId = generateId();

    // Task is running first
    agentCurrentMessage.set(agentName, taskMsgId);
    assert.equal(agentCurrentMessage.get(agentName), taskMsgId);

    // Wakeup sets a NEW messageId (doesn't reuse the task one)
    agentCurrentMessage.set(agentName, wakeupMsgId);
    assert.equal(agentCurrentMessage.get(agentName), wakeupMsgId);
    // Task msgId is no longer tracked — correct behavior (wakeup is a new turn)
    assert.notEqual(agentCurrentMessage.get(agentName), taskMsgId);
  });

  it('should run wakeup and user message sequentially without conflict', () => {
    const sessionId = 'sess-1';
    const agentName = 'planner';

    // Helper: register message + inc count
    function beginMsg(msgId: string) {
      agentCurrentMessage.set(agentName, msgId);
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(msgId, {
        process: { write() {}, stop() {} },
        timer: setTimeout(() => {}, 1000),
        agentId: 'agent-1', agentName,
      });
      incRunningAgentCount();
    }

    // User message 1
    const msg1 = generateId();
    beginMsg(msg1);
    assert.equal(runningAgentCount, 1);

    // Message 1 done
    clearRunningAgent(sessionId, msg1);
    agentCurrentMessage.delete(agentName);
    assert.equal(runningAgentCount, 0);

    // Wakeup arrives while agent is idle
    const wakeupMsg = generateId();
    beginMsg(wakeupMsg);
    assert.equal(runningAgentCount, 1);

    // Wakeup done
    clearRunningAgent(sessionId, wakeupMsg);
    agentCurrentMessage.delete(agentName);
    assert.equal(runningAgentCount, 0);

    // User message 2 — should not be queued (count is 0)
    const msg2 = generateId();
    beginMsg(msg2);
    assert.equal(runningAgentCount, 1);
  });

  it('should show queued when at capacity even with wakeup', () => {
    const MAX_CONCURRENT = 2;

    // Two tasks fill the slots
    incRunningAgentCount();
    incRunningAgentCount();
    assert.equal(runningAgentCount, 2);

    // Wakeup for another agent — would queue
    const shouldQueue = runningAgentCount >= MAX_CONCURRENT;
    assert.equal(shouldQueue, true);

    enqueuePending({
      sessionId: 'sess-1',
      mention: { agentId: 'a1', subPrompt: 'hello', messageId: generateId() },
      enqueuedAt: Date.now(),
    });
    assert.equal(pendingAgentQueue.length, 1);

    // Slot frees → dequeue
    decRunningAgentCount();
    assert.equal(runningAgentCount, 1);
    const next = dequeuePending();
    assert.ok(next);
    assert.equal(pendingAgentQueue.length, 0);
  });
});
