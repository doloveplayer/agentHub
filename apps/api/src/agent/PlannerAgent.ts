import { createOneShotAgentProcess } from './processFactory.js';
import { extractAndValidate } from './PlanValidator.js';
import type { ValidatedTaskPlan } from './PlanValidator.js';

const MAX_RETRIES = 1;

export class PlannerAgent {
  static async plan(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    hostWorkDir: string,
  ): Promise<ValidatedTaskPlan> {
    return attemptPlan(sessionId, prompt, containerId, workDir, hostWorkDir, 0);
  }
}

async function attemptPlan(
  sessionId: string,
  prompt: string,
  containerId: string,
  workDir: string,
  hostWorkDir: string,
  attempt: number,
): Promise<ValidatedTaskPlan> {
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
      "agentType": "CodeAgent" | "ReviewAgent" | "DevOpsAgent" | "TestAgent" | "DepsAgent",
      "dependsOn": string[],
      "expectedOutput": string,
      "priority": "high" | "medium" | "low"
    }
  ],
  "missingAgents": [{"name": "...", "displayName": "...", "description": "...", "reason": "..."}]
}`;

  return new Promise((resolve, reject) => {
    const proc = createOneShotAgentProcess();
    let accumulated = '';

    proc.onEvent((event) => {
      if (event.type === 'text') accumulated += event.content;

      if (event.type === 'done') {
        if (event.exitCode !== 0) {
          reject(new Error(`Planner exited with code ${event.exitCode}`));
          return;
        }
        const plan = extractAndValidate(accumulated);
        if (plan) {
          resolve(plan);
        } else if (attempt < MAX_RETRIES) {
          console.log(`[planner] Validation failed, retrying (attempt ${attempt + 1})...`);
          resolve(attemptPlan(sessionId, prompt, containerId, workDir, hostWorkDir, attempt + 1));
        } else {
          reject(new Error(`Failed to parse plan JSON after ${MAX_RETRIES + 1} attempts.\nOutput: ${accumulated.slice(-500)}`));
        }
      }

      if (event.type === 'error') {
        if (attempt < MAX_RETRIES) {
          console.log(`[planner] Error, retrying (attempt ${attempt + 1})...`);
          resolve(attemptPlan(sessionId, prompt, containerId, workDir, hostWorkDir, attempt + 1));
        } else {
          reject(new Error(event.message));
        }
      }
    });

    proc.start(sessionId, plannerPrompt, containerId, workDir, true, hostWorkDir, planMessageId)
      .catch(reject);
  });
}
