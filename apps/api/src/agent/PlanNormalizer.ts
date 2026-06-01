import type { Plan, PlanTask } from '@agenthub/shared';

/**
 * Strip session-specific suffix from agentType.
 * "code-agent-2a593a92" → "code-agent"
 * "review-agent-abc123" → "review-agent"
 * "test-agent" → "test-agent" (no suffix, unchanged)
 */
function stripSessionSuffix(agentType: string): string {
  const match = agentType.match(/^(.+?)-[a-f0-9]{6,}$/);
  return match ? match[1] : agentType;
}

/**
 * Normalize raw plan JSON into a standardized Plan object.
 * Handles field name variations and agentType suffix stripping.
 */
export function normalizePlan(raw: Record<string, unknown>): Plan {
  return {
    planTitle: String(
      raw.planTitle || raw.title || raw.project || raw.planId || raw.name || 'Untitled Plan'
    ),
    summary: String(raw.summary || raw.description || ''),
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((t: Record<string, unknown>) => normalizeTask(t))
      : [],
  };
}

function normalizeTask(t: Record<string, unknown>): PlanTask {
  return {
    id: String(t.id || t.taskId || t.task_id || ''),
    title: String(t.title || t.subject || t.name || ''),
    description: String(t.description || t.desc || ''),
    agentType: stripSessionSuffix(String(t.agentType || t.agent_type || t.agent || '')),
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String)
      : Array.isArray(t.dependencies) ? t.dependencies.map(String)
      : [],
    expectedOutput: String(t.expectedOutput || t.expected_output || t.output || ''),
    risk: t.risk === 'high' ? 'high' : 'low',
  };
}

/**
 * Basic validation: plan must have a non-empty title and at least one task.
 * Does NOT validate agentType against an enum — dispatcher does final matching.
 */
export function validateBasic(plan: Plan): { valid: true } | { valid: false; reason: string } {
  if (!plan.planTitle.trim()) {
    return { valid: false, reason: 'planTitle is empty' };
  }
  if (plan.tasks.length === 0) {
    return { valid: false, reason: 'tasks array is empty' };
  }
  for (const task of plan.tasks) {
    if (!task.id.trim()) {
      return { valid: false, reason: `task has empty id: ${JSON.stringify(task.title)}` };
    }
    if (!task.title.trim()) {
      return { valid: false, reason: `task ${task.id} has empty title` };
    }
    if (!task.agentType.trim()) {
      return { valid: false, reason: `task ${task.id} has empty agentType` };
    }
  }
  return { valid: true };
}

/**
 * Assess overall plan risk: high if ANY task is high risk.
 */
export function assessRisk(plan: Plan): 'low' | 'high' {
  return plan.tasks.some((t) => t.risk === 'high') ? 'high' : 'low';
}

/**
 * Compute a stable hash for dedup — same plan should produce same hash.
 */
export function planHash(plan: Plan): string {
  const ids = plan.tasks.map((t) => t.id).sort().join(',');
  return `${plan.planTitle}|${ids}`;
}
