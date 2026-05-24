import { createOneShotAgentProcess } from './processFactory.js';
import type { TaskPlan } from '@agenthub/shared';

export class PlannerAgent {
  /**
   * Invoke a Claude Code subprocess to decompose a requirement into a
   * structured TaskPlan with dependency ordering.
   */
  static async plan(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    hostWorkDir: string,
  ): Promise<TaskPlan> {
    const planMessageId = `plan-${Date.now()}`;

    const plannerPrompt = `You are a software engineering task planning expert.
First, explore the project structure using ls and cat package.json (or equivalent).
Then, break down the following requirement into parallelizable subtasks:

${prompt}

Output ONLY a valid JSON object (no markdown fences) with this schema:
{
  "planTitle": string,
  "summary": string,
  "tasks": [
    {
      "id": "task-N",
      "title": string,
      "description": string,
      "agentType": "CodeAgent" | "ReviewAgent" | "DevOpsAgent",
      "dependsOn": string[],
      "expectedOutput": string,
      "priority": "high" | "medium" | "low"
    }
  ]
}`;

    return new Promise((resolve, reject) => {
      const proc = createOneShotAgentProcess();
      let accumulated = '';

      proc.onEvent((event) => {
        if (event.type === 'text') {
          accumulated += event.content;
        }
        if (event.type === 'done') {
          if (event.exitCode !== 0) {
            reject(new Error(`Planner exited with code ${event.exitCode}`));
            return;
          }
          try {
            // Extract JSON from accumulated output (may contain surrounding text).
            // Use balanced brace matching to find the outermost JSON object with "tasks".
            const tasksIdx = accumulated.indexOf('"tasks"');
            if (tasksIdx === -1) {
              reject(new Error('No valid task plan JSON found in Planner output'));
              return;
            }
            // Find the enclosing { by scanning backwards
            let depth = 0; let start = -1;
            for (let i = tasksIdx; i >= 0; i--) {
              if (accumulated[i] === '}') depth++;
              else if (accumulated[i] === '{') {
                if (depth === 0) { start = i; break; }
                depth--;
              }
            }
            if (start === -1) {
              reject(new Error('Cannot find opening brace for task plan JSON'));
              return;
            }
            // Find matching closing brace
            depth = 0; let end = -1;
            for (let i = start; i < accumulated.length; i++) {
              if (accumulated[i] === '{') depth++;
              else if (accumulated[i] === '}') {
                depth--;
                if (depth === 0) { end = i; break; }
              }
            }
            if (end === -1) {
              reject(new Error('Cannot find closing brace for task plan JSON'));
              return;
            }
            const plan: TaskPlan = JSON.parse(accumulated.slice(start, end + 1));
            if (!plan.tasks || plan.tasks.length === 0) {
              reject(new Error('Task plan has no tasks'));
              return;
            }
            for (const t of plan.tasks) {
              if (!t.id || !t.title || !t.agentType) {
                reject(new Error(`Task missing required fields: ${JSON.stringify(t)}`));
                return;
              }
              if (!Array.isArray(t.dependsOn)) t.dependsOn = [];
              if (!t.priority) t.priority = 'medium';
            }
            resolve(plan);
          } catch (err: any) {
            reject(new Error(`Failed to parse plan JSON: ${err.message}\nOutput: ${accumulated.slice(-500)}`));
          }
        }
        if (event.type === 'error') {
          reject(new Error(event.message));
        }
      });

      proc.start(sessionId, plannerPrompt, containerId, workDir, true, hostWorkDir, planMessageId)
        .catch(reject);
    });
  }
}
