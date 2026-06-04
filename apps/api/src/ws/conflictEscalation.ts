// Conflict escalation: routes unresolved file conflicts to the Planner agent.
// Follows the same pattern as dispatchEscalationToPlanner in taskDispatcher.ts.

import { prisma } from '../db/prisma.js';
import { agentRuntime } from '../agent/AgentRuntime.js';
import { InboxManager } from '../agent/InboxManager.js';
import { sandboxes, broadcast } from './state.js';

interface ConflictTaskInfo {
  filePath: string;
  agents: string[];
  agentTasks: Array<{ agentName: string; planId?: string; taskId?: string }>;
}

/**
 * Escalate unresolved file conflicts to the Planner agent.
 * Sends a structured prompt asking the Planner to analyze the conflict
 * and decide: re-execute sequentially, re-plan, or report to user.
 */
export async function escalateUnresolvedConflicts(
  sessionId: string,
  workspacePath: string,
  unresolved: ConflictTaskInfo[],
): Promise<void> {
  const plannerSA = await prisma.sessionAgent.findFirst({
    where: { sessionId, agent: { name: { startsWith: 'planner' } } },
    select: { agent: { select: { id: true, name: true } } },
  });
  if (!plannerSA) {
    console.log(`[conflict] No planner in session ${sessionId.slice(0, 8)}, skipping escalation`);
    return;
  }

  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) return;

  const allTaskIds = new Set<string>();
  const conflictLines = unresolved.map((c) => {
    const agentList = c.agentTasks.map((a) => {
      if (a.taskId) allTaskIds.add(a.taskId);
      return `  - ${a.agentName}${a.taskId ? ` (task: ${a.taskId})` : ''}`;
    }).join('\n');
    return `### ${c.filePath}\n${agentList}`;
  });

  const planId = unresolved[0]?.agentTasks[0]?.planId || 'unknown';
  const taskIdsList = [...allTaskIds].join(', ');

  const escalationPrompt = [
    '## File Conflict Detected — Auto-Merge Failed',
    '',
    'The following files have overlapping changes from multiple agents that could not be automatically merged:',
    '',
    ...conflictLines,
    '',
    `**Plan**: ${planId}`,
    taskIdsList ? `**Conflicting tasks**: ${taskIdsList}` : '',
    '',
    '## Your Role as Planner',
    'You created this plan and understand the task dependencies. Analyze this conflict and decide:',
    '',
    '1. **Re-execute sequentially** — If the tasks would resolve the conflict when run one after another, specify the order.',
    '2. **Re-plan** — If the task structure needs to change, describe new tasks.',
    '3. **Report to user** — If neither approach works, explain why.',
    '',
    'Respond in Chinese. This is an analysis request — do NOT call any tools or output AGENTHUB_PLAN.',
  ].filter(Boolean).join('\n');

  const messageId = `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    await prisma.message.create({
      data: { id: messageId, sessionId, senderType: 'agent', agentId: plannerSA.agent.id, content: '', status: 'streaming' },
    });
  } catch { return; }

  // Write to Planner's inbox for awareness
  InboxManager.write(sandbox.hostSandboxDir, plannerSA.agent.name, {
    type: 'intervention_request',
    id: `conflict-${messageId}`,
    from: 'system',
    to: plannerSA.agent.name,
    summary: `File conflicts: ${unresolved.map(c => c.filePath).join(', ')}. Auto-merge failed. Decide next steps.`,
    risk: 'high',
    timestamp: Date.now(),
  }, sessionId);

  broadcast(sessionId, {
    type: 'conflict_escalated',
    messageId,
    files: unresolved.map(c => ({ filePath: c.filePath, agents: c.agents })),
    planId,
    taskIds: [...allTaskIds],
    plannerAgentId: plannerSA.agent.id,
    plannerAgentName: plannerSA.agent.name,
  });

  const fullPrompt = [
    '[Group - Multi-Agent Collaboration]',
    '',
    escalationPrompt,
  ].join('\n');

  await agentRuntime.sendPrompt(
    plannerSA.agent.id, sessionId, fullPrompt, messageId, sandbox,
    false,
  );
}
