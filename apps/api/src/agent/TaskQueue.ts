import { Queue, Worker, Job } from 'bullmq';
import { config, redis } from '../config.js';
import { createOneShotAgentProcess } from './processFactory.js';
import type { TaskNode, TaskPlan } from '@agenthub/shared';

/** Topological sort: DAG → ordered execution layers */
export function topologicalSort(tasks: TaskNode[]): TaskNode[][] {
  const layers: TaskNode[][] = [];
  const remaining = new Map(tasks.map(t => [t.id, { ...t, dependsOn: [...t.dependsOn] }]));
  const completed = new Set<string>();

  while (remaining.size > 0) {
    const layer: TaskNode[] = [];
    for (const [id, task] of remaining) {
      if (task.dependsOn.every((did: string) => completed.has(did))) {
        layer.push(task);
        remaining.delete(id);
      }
    }
    if (layer.length === 0) {
      // Circular dependency or stuck tasks — add as final layer
      layers.push(Array.from(remaining.values()));
      break;
    }
    layers.push(layer);
    layer.forEach(t => completed.add(t.id));
  }
  return layers;
}

export interface TaskJobData {
  planId: string;
  sessionId: string;
  task: TaskNode;
  contextPrompt: string;
  containerId: string;
  workDir: string;
  hostWorkDir: string;
  /** Resolved agent name (e.g. "code-agent") — used for promptFileId + directory naming */
  agentName?: string;
  /** Resolved agent systemPrompt — prepended to task context */
  agentSystemPrompt?: string;
}

export class TaskQueueManager {
  private queue: Queue<TaskJobData>;
  private worker: Worker<TaskJobData> | null = null;

  constructor() {
    this.queue = new Queue<TaskJobData>('agenthub-tasks', {
      connection: { host: redis.host, port: redis.port },
    });
  }

  /** Remove all stale jobs from previous runs (sandboxes are cleaned on startup) */
  async drain(): Promise<void> {
    try {
      await this.queue.obliterate({ force: true });
      console.log('[queue] Drained all stale jobs');
    } catch (err: any) {
      console.log(`[queue] Drain skipped: ${err.message}`);
    }
  }

  /** Submit an entire Plan to the queue, handling dependency ordering */
  async submitPlan(
    planId: string,
    sessionId: string,
    plan: TaskPlan,
    containerId: string,
    workDir: string,
    hostWorkDir: string,
    agentMap?: Map<string, { name: string; systemPrompt: string }>,
  ): Promise<void> {
    const layers = topologicalSort(plan.tasks);

    for (const layer of layers) {
      const children: { name: string; data: TaskJobData; opts: any }[] = [];

      for (const task of layer) {
        const depsInfo = task.dependsOn.map(did => {
          const dep = plan.tasks.find(t => t.id === did);
          return dep
            ? `- ${dep.title}: expected output ${dep.expectedOutput}`
            : `- task ${did}`;
        }).join('\n');

        const agent = agentMap?.get(task.agentType);

        const contextPrompt = `Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}

${depsInfo ? `Previous tasks completed:\n${depsInfo}\n` : ''}
Execute this task now. Output the results to the specified files.`;

        children.push({
          name: task.id,
          data: {
            planId,
            sessionId,
            task,
            contextPrompt,
            containerId,
            workDir,
            hostWorkDir,
            agentName: agent?.name,
            agentSystemPrompt: agent?.systemPrompt,
          },
          opts: {
            attempts: config.taskQueue.maxRetries + 1,
            backoff: { type: 'fixed' as const, delay: config.taskQueue.retryDelayMs },
            priority: task.priority === 'high' ? 1 : task.priority === 'medium' ? 2 : 3,
          },
        });
      }

      await this.queue.addBulk(children);
    }
  }

  /** Get execution progress for a plan */
  async getPlanProgress(planId: string): Promise<{
    total: number; completed: number; failed: number; running: number; waiting: number;
  }> {
    const jobs = await this.queue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed']);
    const relevant = jobs.filter(j => (j as any).data?.planId === planId);

    return {
      total: relevant.length,
      completed: relevant.filter(j => !!(j as any).finishedOn && !(j as any).failedReason).length,
      failed: relevant.filter(j => !!(j as any).failedReason).length,
      running: relevant.filter(j => !(j as any).finishedOn && (j as any).attemptsStarted > 0).length,
      waiting: relevant.filter(j => !(j as any).finishedOn && (j as any).attemptsStarted === 0).length,
    };
  }

  /** Start the worker to process tasks */
  startWorker(onTaskComplete?: (planId: string, taskId: string, result: any) => void): void {
    this.worker = new Worker<TaskJobData>(
      'agenthub-tasks',
      async (job: Job<TaskJobData>) => {
        const { contextPrompt, containerId, workDir, hostWorkDir, sessionId, task, agentName, agentSystemPrompt } = job.data;

        const proc = createOneShotAgentProcess();
        let output = '';

        // Use real agent name for prompt file and directory naming (PRD section 4.2)
        const promptFileId = agentName ? `${agentName}-${task.id}` : `task-${task.id}`;
        const fullPrompt = agentSystemPrompt
          ? `${agentSystemPrompt}\n\n---\n\n${contextPrompt}`
          : contextPrompt;

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error(`Task ${task.id} timed out`));
          }, 300_000);

          proc.onEvent((event) => {
            if (event.type === 'text') output += event.content;
            if (event.type === 'done') {
              clearTimeout(timeout);
              if (event.exitCode === 0) {
                resolve({ output, taskId: task.id });
              } else {
                reject(new Error(`Task ${task.id} failed (exit ${event.exitCode}): ${output.slice(-500)}`));
              }
            }
            if (event.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(event.message));
            }
          });

          proc.start(
            sessionId, fullPrompt, containerId, workDir,
            /* trustMode= */ true, hostWorkDir, promptFileId,
          ).catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
      },
      {
        connection: { host: redis.host, port: redis.port },
        concurrency: config.taskQueue.concurrency,
      }
    );

    this.worker.on('completed', (job, result) => {
      if (onTaskComplete) onTaskComplete(job.data.planId, job.data.task.id, result);
    });

    this.worker.on('failed', (job, err) => {
      const taskId = job?.data?.task?.id || 'unknown';
      console.error(`[queue] Task ${taskId} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err?.message || err}`);
      // When all retries exhausted, block downstream dependents
      if (job && job.opts && job.attemptsMade >= (job.opts.attempts as number || 1)) {
        const planId = job.data?.planId;
        if (planId) {
          this.blockDependents(planId, job.data.task.id).catch(e =>
            console.error(`[queue] blockDependents error: ${e.message}`));
        }
      }
    });
  }

  /** Re-enqueue a single failed task for retry */
  async retryTask(
    planId: string, sessionId: string,
    task: TaskNode, containerId: string, workDir: string, hostWorkDir: string,
    agentName?: string, agentSystemPrompt?: string,
  ): Promise<void> {
    const contextPrompt = `Task: ${task.title}
Description: ${task.description}
Expected Output: ${task.expectedOutput}

Retry this failed task. Review the current state of the workspace and attempt again.`;

    await this.queue.add(task.id, {
      planId, sessionId, task, contextPrompt, containerId, workDir, hostWorkDir,
      agentName, agentSystemPrompt,
    }, {
      attempts: config.taskQueue.maxRetries + 1,
      backoff: { type: 'fixed' as const, delay: config.taskQueue.retryDelayMs },
      priority: task.priority === 'high' ? 1 : task.priority === 'medium' ? 2 : 3,
    });
  }

  /** Block dependents when a task exhausts retries */
  async blockDependents(planId: string, failedTaskId: string): Promise<void> {
    const jobs = await this.queue.getJobs(['waiting', 'delayed']);
    for (const job of jobs) {
      const data = (job as any).data as TaskJobData | undefined;
      if (data?.planId === planId && data?.task?.dependsOn?.includes(failedTaskId)) {
        await job.moveToFailed(
          new Error(`Blocked: upstream task ${failedTaskId} failed`),
          'agenthub-tasks',
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
