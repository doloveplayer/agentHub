// Task-to-Agent dispatch: routes Planner tasks to session agents via REPL.
// Extracted from handler.ts.

import { ClaudeCodeProvider } from '../agent/providers/claude-code.js';
import { ProviderFactory } from '../agent/providers/factory.js';
import { stateTracker } from '../agent/StateTracker.js';
import { findClosestAgent } from '../agent/turns.js';
import { topologicalSort } from '../agent/TaskQueue.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';

import { ClaudeCodeProcess, buildSafeEnv } from '../agent/ClaudeCodeProcess.js';
import {
  broadcast, agentProcesses, agentStates, agentTaskQueues,
  agentCurrentTask, agentCurrentMessage, sandboxes,
  incRunningAgentCount, decRunningAgentCount,
  ENABLE_PERSISTENT_REPL,
  type AgentTaskQueue, type TaskDispatchNode,
} from './state.js';

export { type AgentTaskQueue, type TaskDispatchNode };

function buildTaskPrompt(task: TaskDispatchNode): string {
  return `Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}
${task.dependsOn.length > 0 ? `\nDepends on: ${task.dependsOn.join(', ')}\n` : ''}
Execute this task now. Output results to the specified files.`;
}

export async function processNextInQueue(
  sessionId: string,
  agentName: string,
  queue: AgentTaskQueue,
): Promise<void> {
  if (queue.tasks.length === 0) {
    agentTaskQueues.delete(agentName);
    return;
  }

  const task = queue.tasks.shift()!;
  queue.current = task;
  agentCurrentTask.set(agentName, { planId: queue.planId, taskId: task.id });

  const procInfo = agentProcesses.get(sessionId)?.get(agentName);

  if (procInfo && procInfo.provider.isAlive()) {
    const taskPrompt = buildTaskPrompt(task);
    agentCurrentMessage.set(agentName, `task-${task.id}`);
    const taskMsg = await prisma.message.create({
      data: { id: `task-${task.id}`, sessionId, senderType: 'agent', agentId: procInfo.agentId, content: '', status: 'streaming' },
    }).catch(() => null);
    if (taskMsg) {
      if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
      agentStates.get(sessionId)!.set(taskMsg.id, {
        process: procInfo.provider, timer: procInfo.timer, agentId: procInfo.agentId, agentName,
      });
      incRunningAgentCount();
    }
    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: procInfo.agentId });
    procInfo.provider.sendPrompt(taskPrompt);
  } else if (!ENABLE_PERSISTENT_REPL) {
    // One-shot fallback: start a ClaudeCodeProcess directly for the task
    const sandbox = sandboxes.get(sessionId);
    if (!sandbox) { console.log(`[ws] Task dispatch: no sandbox for session ${sessionId}`); return; }
    const agent = await prisma.agent.findUnique({ where: { name: agentName }, select: { id: true, name: true, systemPrompt: true } });
    if (!agent) { console.log(`[ws] Task dispatch: agent ${agentName} not found in DB`); return; }
    const fullPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}`;
    const proc = new ClaudeCodeProcess();
    const taskMsgId = `task-${task.id}`;
    let output = '';

    proc.onEvent((event) => {
      switch (event.type) {
        case 'text':
          output += event.content;
          broadcast(sessionId, { type: 'stream_chunk', content: event.content, agentMessageId: taskMsgId });
          break;
        case 'done':
          broadcast(sessionId, { type: 'stream_end', agentMessageId: taskMsgId, fullContent: output || '[Task completed]', exitCode: event.exitCode });
          broadcast(sessionId, { type: event.exitCode === 0 ? 'task_completed' : 'task_failed', planId: queue.planId, taskId: task.id, agentName, output: output.slice(0, 200) });
          stateTracker.setDone(taskMsgId);
          agentCurrentTask.delete(agentName);
          queue.current = null;
          processNextInQueue(sessionId, agentName, queue);
          break;
        case 'error':
          broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: event.message });
          stateTracker.setError(taskMsgId);
          break;
      }
    });

    broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: agent.id });
    console.log(`[ws] Task dispatch (one-shot): agent=${agentName} task=${task.id}`);
    proc.start(sessionId, fullPrompt, sandbox.containerId, sandbox.workDir, true, sandbox.hostWorkDir, taskMsgId)
      .catch((err: any) => {
        console.error(`[ws] Task one-shot failed: ${err.message}`);
        broadcast(sessionId, { type: 'stream_error', agentMessageId: taskMsgId, error: `Task failed: ${err.message}` });
      });
  } else {
    queue.tasks.unshift(task);
    queue.current = null;
    agentCurrentTask.delete(agentName);
    console.log(`[ws] Task dispatch: agent ${agentName} not running, task ${task.id} queued until agent activation`);
  }
}

export async function startTaskAgent(
  sessionId: string,
  agent: { id: string; name: string; displayName: string; systemPrompt: string },
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const provider = ProviderFactory.create('claude-code') as ClaudeCodeProvider;
  const safeEnv = buildSafeEnv();
  const agentName = agent.name;

  const queue = agentTaskQueues.get(agentName);
  if (!queue || queue.tasks.length === 0) return;

  const task = queue.tasks.shift()!;
  queue.current = task;
  agentCurrentTask.set(agentName, { planId: queue.planId, taskId: task.id });

  const taskPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}`;

  provider.onEvent((ev) => {
    const msgId = agentCurrentMessage.get(agentName) || `task-${task.id}`;
    switch (ev.type) {
      case 'thinking':
        broadcast(sessionId, { type: 'stream_chunk', content: ev.content || '', agentMessageId: msgId });
        break;
      case 'tool_use':
        broadcast(sessionId, { type: 'agent_status', status: 'tool_use',
          details: { toolName: ev.toolName, input: ev.toolInput }, agentMessageId: msgId, timestamp: Date.now() });
        break;
      case 'done': {
        broadcast(sessionId, { type: 'stream_end', agentMessageId: msgId,
          fullContent: ev.exitCode === 0 ? '[Task completed]' : '[Task failed]', exitCode: ev.exitCode ?? 0 });
        broadcast(sessionId, {
          type: ev.exitCode === 0 ? 'task_completed' : 'task_failed',
          planId: queue.planId, taskId: task.id, output: ev.exitCode === 0 ? 'done' : `exit code ${ev.exitCode}`,
        });
        stateTracker.setDone(msgId);
        agentCurrentTask.delete(agentName);
        agentCurrentMessage.delete(agentName);
        queue.current = null;
        processNextInQueue(sessionId, agentName, queue);
        break;
      }
      case 'error':
        broadcast(sessionId, { type: 'stream_error', agentMessageId: msgId, error: ev.message || 'Unknown error' });
        stateTracker.setError(msgId);
        break;
    }
  });

  if (!agentProcesses.has(sessionId)) agentProcesses.set(sessionId, new Map());
  const timer = setTimeout(() => {
    provider.stop();
    agentProcesses.get(sessionId)?.delete(agentName);
    agentCurrentMessage.delete(agentName);
  }, config.agent.timeoutMs);
  agentProcesses.get(sessionId)!.set(agentName, { provider, timer, agentId: agent.id });

  agentCurrentMessage.set(agentName, `task-${task.id}`);

  const taskMsg = await prisma.message.create({
    data: { id: `task-${task.id}`, sessionId, senderType: 'agent', agentId: agent.id, content: '', status: 'streaming' },
  }).catch(() => null);

  if (taskMsg) {
    if (!agentStates.has(sessionId)) agentStates.set(sessionId, new Map());
    agentStates.get(sessionId)!.set(taskMsg.id, { process: provider, timer, agentId: agent.id, agentName });
    incRunningAgentCount();
  }

  broadcast(sessionId, { type: 'task_assigned', planId: queue.planId, taskId: task.id, agentName, agentId: agent.id });
  console.log(`[ws] Starting task agent REPL: session=${sessionId} agent=${agentName} task=${task.id}`);
  provider.start(sessionId, taskPrompt, sandbox.containerId, sandbox.workDir, {
    agentName, hostWorkDir: sandbox.hostWorkDir, env: safeEnv,
  }).catch((err) => {
    console.error(`[ws] Task provider start failed: ${err.message}`);
    broadcast(sessionId, { type: 'stream_error', agentMessageId: `task-${task.id}`, error: `Task agent start failed: ${err.message}` });
  });
}

export async function dispatchTasksToAgents(
  sessionId: string,
  planId: string,
  tasks: TaskDispatchNode[],
  sandbox: { containerId: string; workDir: string; hostWorkDir: string },
): Promise<void> {
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { id: true, name: true, displayName: true, systemPrompt: true } } },
  });
  if (sessionAgents.length === 0) {
    broadcast(sessionId, { type: 'stream_error', error: 'No agents in this session to execute tasks' });
    return;
  }

  const agentsByType = new Map<string, typeof sessionAgents[number]['agent'][]>();
  for (const sa of sessionAgents) {
    const list = agentsByType.get(sa.agent.displayName) || [];
    list.push(sa.agent);
    agentsByType.set(sa.agent.displayName, list);
  }

  const layers = topologicalSort(tasks.map(t => ({
    ...t, agentType: t.agentType as 'CodeAgent' | 'ReviewAgent' | 'DevOpsAgent',
  })));

  const missingTypes = new Set<string>();
  const assigned = new Map<string, AgentTaskQueue>();

  for (const layer of layers) {
    for (const task of layer) {
      const candidates = agentsByType.get(task.agentType) || [];
      if (candidates.length === 0) {
        const allAvailable = sessionAgents.map(sa => sa.agent);
        const closest = findClosestAgent(task.agentType, allAvailable);
        if (closest && !missingTypes.has(task.agentType)) {
          console.log(`[ws] Task dispatch: no ${task.agentType}, fallback to ${closest.displayName} for task ${task.id}`);
          const fallbackList = agentsByType.get(closest.displayName) || [closest];
          let bestAgent = fallbackList[0];
          let bestLoad = Infinity;
          for (const a of fallbackList) {
            const q = assigned.get(a.name) || agentTaskQueues.get(a.name);
            const load = q ? q.tasks.length : 0;
            if (load < bestLoad) { bestLoad = load; bestAgent = a; }
          }
          const existing = assigned.get(bestAgent.name) || agentTaskQueues.get(bestAgent.name);
          const queue: AgentTaskQueue = existing || { planId, sessionId, tasks: [], current: null, sandbox };
          queue.tasks.push({
            id: task.id, title: task.title, description: task.description,
            agentType: task.agentType, dependsOn: task.dependsOn,
            expectedOutput: task.expectedOutput, priority: task.priority || 'medium',
          });
          assigned.set(bestAgent.name, queue);
          broadcast(sessionId, {
            type: 'agent_missing', planId, taskId: task.id,
            agentType: task.agentType, taskTitle: task.title,
            fallbackAgent: closest.displayName,
            suggestedAgent: {
              name: task.agentType.toLowerCase().replace('agent', '-agent'),
              displayName: task.agentType,
              description: `Auto-suggested ${task.agentType} for task: ${task.title}`,
            },
          });
          continue;
        }
        missingTypes.add(task.agentType);
        broadcast(sessionId, {
          type: 'agent_missing', planId, taskId: task.id,
          agentType: task.agentType, taskTitle: task.title,
          suggestedAgent: {
            name: task.agentType.toLowerCase().replace('agent', '-agent'),
            displayName: task.agentType,
            description: `Auto-suggested ${task.agentType} for task: ${task.title}`,
          },
        });
        continue;
      }
      let bestAgent = candidates[0];
      let bestLoad = Infinity;
      for (const a of candidates) {
        const q = assigned.get(a.name) || agentTaskQueues.get(a.name);
        const load = q ? q.tasks.length : 0;
        if (load < bestLoad) { bestLoad = load; bestAgent = a; }
      }
      const existing = assigned.get(bestAgent.name) || agentTaskQueues.get(bestAgent.name);
      const queue: AgentTaskQueue = existing || { planId, sessionId, tasks: [], current: null, sandbox };
      queue.tasks.push({
        id: task.id, title: task.title, description: task.description,
        agentType: task.agentType, dependsOn: task.dependsOn,
        expectedOutput: task.expectedOutput, priority: task.priority || 'medium',
      });
      assigned.set(bestAgent.name, queue);
    }
  }

  for (const [agentName, queue] of assigned) {
    agentTaskQueues.set(agentName, queue);
    await processNextInQueue(sessionId, agentName, queue);
  }
}
