import type { ExperienceEntry } from '@agenthub/shared';
import type { ContextBus } from './ContextBus.js';

export interface ExtractionTask {
  id: string;
  title: string;
  agentType: string;
  status: string;
  outputSummary: string;
  outputFiles: string[];
  modifiedFiles: string[];
}

export interface FailedTaskInfo {
  taskId: string;
  agentType: string;
  error: string;
  retryCount: number;
}

export interface ExtractionContext {
  planId: string;
  sessionId: string;
  tasks: ExtractionTask[];
  failedTasks: FailedTaskInfo[];
  contextBus: ContextBus;
}

type ExtractionRule = {
  name: string;
  match: (ctx: ExtractionContext) => boolean;
  extract: (ctx: ExtractionContext) => ExperienceEntry[];
};

const BUILTIN_RULES: ExtractionRule[] = [
  {
    name: 'review-rejection-pattern',
    match: (ctx) => ctx.failedTasks.some(f => f.agentType === 'review-agent'),
    extract: (ctx) => {
      const reviewBlocked = ctx.failedTasks.filter(f => f.agentType === 'review-agent');
      return reviewBlocked.map(f => {
        const task = ctx.tasks.find(t => t.id === f.taskId);
        const fileHint = extractFilePath(f.error);
        return {
          type: 'bug-pattern' as const,
          title: `${task?.title || f.taskId} 被审查拒绝`,
          detail: f.error.slice(0, 500),
          agentTypes: ['code-agent'],
          tags: ['review-rejection', ...(fileHint ? [fileHint] : [])],
          sourcePlan: ctx.planId,
          sourceTask: f.taskId,
          severity: 'high' as const,
        };
      });
    },
  },
  {
    name: 'file-conflict-warning',
    match: (ctx) => {
      const fileEdits = new Map<string, string[]>();
      for (const t of ctx.tasks) {
        for (const f of t.modifiedFiles) {
          if (!fileEdits.has(f)) fileEdits.set(f, []);
          fileEdits.get(f)!.push(t.title);
        }
      }
      return [...fileEdits.values()].some(titles => titles.length >= 2);
    },
    extract: (ctx) => {
      const fileEdits = new Map<string, string[]>();
      for (const t of ctx.tasks) {
        for (const f of t.modifiedFiles) {
          if (!fileEdits.has(f)) fileEdits.set(f, []);
          fileEdits.get(f)!.push(t.title);
        }
      }
      const entries: ExperienceEntry[] = [];
      for (const [file, titles] of fileEdits) {
        if (titles.length >= 2) {
          entries.push({
            type: 'dependency-topology',
            title: `文件 ${file} 被多 task 并发修改`,
            detail: `文件 ${file} 被 ${titles.join(', ')} 并发修改`,
            agentTypes: ['code-agent', 'planner'],
            tags: ['concurrent-edit', ...file.split('/')],
            sourcePlan: ctx.planId,
            severity: 'medium',
          });
        }
      }
      return entries;
    },
  },
  {
    name: 'convention-from-contextbus',
    match: (ctx) => ctx.contextBus.hasNewEntriesOfType('convention'),
    extract: (ctx) =>
      ctx.contextBus.getNewEntriesOfType('convention').map(e => ({
        type: 'project-convention' as const,
        title: e.key,
        detail: typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 300),
        agentTypes: e.tags,
        tags: e.tags,
        sourcePlan: ctx.planId,
        severity: 'medium' as const,
      })),
  },
  {
    name: 'known-issue-from-contextbus',
    match: (ctx) => ctx.contextBus.hasNewEntriesOfType('known-issue'),
    extract: (ctx) =>
      ctx.contextBus.getNewEntriesOfType('known-issue').map(e => ({
        type: 'bug-pattern' as const,
        title: e.key,
        detail: typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 300),
        agentTypes: e.tags,
        tags: e.tags,
        sourcePlan: ctx.planId,
        severity: 'high' as const,
      })),
  },
];

function extractFilePath(text: string): string | null {
  const match = text.match(/([a-zA-Z0-9_/.-]+\.[a-z]{2,5})(?::\d+)?/);
  return match ? match[1] : null;
}

export class ExperienceExtractor {
  private rules: ExtractionRule[];

  constructor(rules?: ExtractionRule[]) {
    this.rules = rules ?? BUILTIN_RULES;
  }

  extract(ctx: ExtractionContext): ExperienceEntry[] {
    const entries: ExperienceEntry[] = [];
    for (const rule of this.rules) {
      try {
        if (rule.match(ctx)) {
          entries.push(...rule.extract(ctx));
        }
      } catch (err: any) {
        console.error(`[ExperienceExtractor] Rule ${rule.name} failed: ${err.message}`);
      }
    }
    return entries;
  }
}
