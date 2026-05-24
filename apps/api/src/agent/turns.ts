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

export function extractPlannerPlan(content: string): TaskPlan | null {
  const candidates = [
    ...extractFencedJson(content),
    content,
    ...extractJsonObjects(content),
  ];

  for (const candidate of candidates) {
    const parsed = parsePlan(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export function toTaskStates(plan: TaskPlan, planId: string): TaskStatePayload[] {
  return plan.tasks.map((task, index) => ({
    taskId: task.id || `task-${index + 1}`,
    planId,
    title: task.title || `Task ${index + 1}`,
    agentType: task.agentType || 'CodeAgent',
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

function extractFencedJson(content: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (match[1]) blocks.push(match[1].trim());
  }
  return blocks;
}

function extractJsonObjects(content: string): string[] {
  const objects: string[] = [];
  const tasksIndex = content.indexOf('"tasks"');
  if (tasksIndex === -1) return objects;

  for (let start = tasksIndex; start >= 0; start--) {
    if (content[start] !== '{') continue;
    let depth = 0;
    for (let end = start; end < content.length; end++) {
      if (content[end] === '{') depth++;
      if (content[end] === '}') depth--;
      if (depth === 0) {
        objects.push(content.slice(start, end + 1));
        return objects;
      }
    }
  }
  return objects;
}

function parsePlan(candidate: string): TaskPlan | null {
  try {
    const parsed = JSON.parse(candidate) as Partial<TaskPlan>;
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return null;
    return {
      planTitle: parsed.planTitle || 'Task Plan',
      summary: parsed.summary || '',
      tasks: parsed.tasks.map(normalizeTask),
    };
  } catch {
    return null;
  }
}

function normalizeTask(task: Partial<TaskNode>, index: number): TaskNode {
  return {
    id: task.id || `task-${index + 1}`,
    title: task.title || `Task ${index + 1}`,
    description: task.description || '',
    agentType: isKnownAgentType(task.agentType) ? task.agentType : 'CodeAgent',
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
    expectedOutput: task.expectedOutput || '',
    priority: isKnownPriority(task.priority) ? task.priority : 'medium',
  };
}

function isKnownAgentType(value: unknown): value is TaskNode['agentType'] {
  return value === 'CodeAgent' || value === 'ReviewAgent' || value === 'DevOpsAgent' || value === 'TestAgent' || value === 'DepsAgent';
}

function isKnownPriority(value: unknown): value is TaskNode['priority'] {
  return value === 'high' || value === 'medium' || value === 'low';
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
