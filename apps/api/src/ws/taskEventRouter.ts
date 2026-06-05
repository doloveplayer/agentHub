export interface ActiveTaskRun<TQueue = unknown, TTask = unknown> {
  sessionId: string;
  agentName: string;
  planId: string;
  taskId: string;
  taskMessageId: string;
  queue?: TQueue;
  task?: TTask;
  output: string;
  notifiedKeys: Set<string>;
}

const activeRuns = new Map<string, ActiveTaskRun<any, any>>();

function runKey(sessionId: string, agentName: string): string {
  return `${sessionId}:${agentName}`;
}

export function setActiveTaskRun<TQueue, TTask>(
  run: Omit<ActiveTaskRun<TQueue, TTask>, 'output' | 'notifiedKeys'> & { output?: string; notifiedKeys?: Set<string> },
): void {
  activeRuns.set(runKey(run.sessionId, run.agentName), {
    ...run,
    output: run.output ?? '',
    notifiedKeys: run.notifiedKeys ?? new Set<string>(),
  });
}

export function getActiveTaskRun<TQueue = unknown, TTask = unknown>(
  sessionId: string,
  agentName: string,
): ActiveTaskRun<TQueue, TTask> | undefined {
  return activeRuns.get(runKey(sessionId, agentName));
}

export function appendTaskRunOutput(sessionId: string, agentName: string, chunk: string): string {
  const run = getActiveTaskRun(sessionId, agentName);
  if (!run) return '';
  run.output += chunk;
  return run.output;
}

export function clearActiveTaskRun(
  sessionId: string,
  agentName: string,
  taskMessageId?: string,
): void {
  const key = runKey(sessionId, agentName);
  const run = activeRuns.get(key);
  if (!run) return;
  if (taskMessageId && run.taskMessageId !== taskMessageId) return;
  activeRuns.delete(key);
}
