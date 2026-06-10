import { z } from 'zod';

export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  agentType: z.string().min(1, 'agentType is required'),
  dependsOn: z.array(z.string()).default([]),
  expectedOutput: z.string().default(''),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export const TaskPlanSchema = z.object({
  planTitle: z.string().min(1),
  summary: z.string().default(''),
  tasks: z.array(TaskNodeSchema).min(1, 'Plan must have at least one task'),
  missingAgents: z.array(z.object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    reason: z.string(),
  })).optional(),
});

export type ValidatedTaskNode = z.infer<typeof TaskNodeSchema>;
export type ValidatedTaskPlan = z.infer<typeof TaskPlanSchema>;

/**
 * Extract and validate a TaskPlan from raw LLM output.
 * Handles markdown code fences, loose JSON, and strict JSON.
 * Returns null if no valid plan can be extracted.
 */
export function extractAndValidate(raw: string): ValidatedTaskPlan | null {
  const candidates = extractJsonCandidates(raw);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = TaskPlanSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Not valid JSON, try next candidate
    }
  }
  return null;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];

  // 1. Extract from ```json fences
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    if (match[1]) candidates.push(match[1].trim());
  }

  // 2. Try the whole string as-is
  candidates.push(raw);

  // 3. Find JSON object containing "tasks" via brace matching
  const tasksIdx = raw.indexOf('"tasks"');
  if (tasksIdx !== -1) {
    let depth = 0; let start = -1;
    for (let i = tasksIdx; i >= 0; i--) {
      if (raw[i] === '}') depth++;
      else if (raw[i] === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start !== -1) {
      depth = 0; let end = -1;
      for (let i = start; i < raw.length; i++) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) candidates.push(raw.slice(start, end + 1));
    }
  }

  return candidates;
}
