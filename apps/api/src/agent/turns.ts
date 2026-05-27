import type { AgentConfig, SessionAgentInfo, TaskPlan, TaskNode } from '@agenthub/shared';

export interface AgentTarget {
  id: string;
  name: string;
  displayName: string;
}

export interface TaskStatePayload {
  taskId: string;
  planId: string;
  title: string;
  agentType: TaskNode['agentType'];
  status: 'waiting';
  dependsOn: string[];
  expectedOutput: string;
  priority: TaskNode['priority'];
  description: string;
}

export function normalizeAgentHandle(handle: string): string {
  return handle
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function matchAgentByHandle(
  handle: string,
  agents: Pick<AgentConfig, 'id' | 'name' | 'displayName'>[],
): AgentTarget | null {
  const normalized = normalizeAgentHandle(handle);
  if (!normalized) return null;

  const exact = agents.find((agent) =>
    normalizeAgentHandle(agent.name) === normalized ||
    normalizeAgentHandle(agent.displayName) === normalized
  );
  if (exact) return toTarget(exact);

  const prefix = agents.find((agent) =>
    normalizeAgentHandle(agent.name).startsWith(normalized) ||
    normalizeAgentHandle(agent.displayName).startsWith(normalized)
  );
  return prefix ? toTarget(prefix) : null;
}

export function selectDefaultAgent(
  sessionType: 'solo' | 'group' | string | undefined,
  sessionAgents: SessionAgentInfo[],
  allAgents: Pick<AgentConfig, 'id' | 'name' | 'displayName'>[],
): AgentTarget | null {
  const available = sessionAgents
    .map((sessionAgent) => allAgents.find((agent) => agent.id === sessionAgent.agentId))
    .filter((agent): agent is Pick<AgentConfig, 'id' | 'name' | 'displayName'> => !!agent);

  if (available.length === 0) return null;

  if (sessionType === 'group') {
    const planner = available.find((agent) => agent.name === 'planner');
    return toTarget(planner || available[0]);
  }

  const codeAgent = available.find((agent) => agent.name === 'code-agent');
  return toTarget(codeAgent || available[0]);
}

export function buildClaudePrintArgs(trustMode = true): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (trustMode) args.push('--dangerously-skip-permissions');
  return args;
}

export function toTaskStates(plan: TaskPlan, planId: string): TaskStatePayload[] {
  return plan.tasks.map((task, index) => ({
    taskId: task.id || `task-${index + 1}`,
    planId,
    title: task.title || `Task ${index + 1}`,
    agentType: task.agentType || 'code-agent',
    status: 'waiting',
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
    expectedOutput: task.expectedOutput || '',
    priority: task.priority || 'medium',
    description: task.description || '',
  }));
}

function toTarget(agent: Pick<AgentConfig, 'id' | 'name' | 'displayName'>): AgentTarget {
  return {
    id: agent.id,
    name: agent.name,
    displayName: agent.displayName,
  };
}

/** Find the closest available agent when exact type match fails */
export function findClosestAgent(
  neededType: string,
  available: { name: string; displayName: string }[],
): { name: string; displayName: string } | null {
  if (available.length === 0) return null;
  // Exact match on displayName
  const exact = available.find(a => a.displayName === neededType);
  if (exact) return exact;
  // Prefix match: "Code" matches "CodeAgent"
  const prefix = available.find(a =>
    a.displayName.toLowerCase().includes(neededType.toLowerCase().replace('agent', ''))
  );
  if (prefix) return prefix;
  // Fallback to code-agent
  return available.find(a => a.name === 'code-agent') ?? available[0];
}
