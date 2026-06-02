import type { ContextEntry, ContextEntryType, ContextEntryStatus } from '@agenthub/shared';

interface SetOptions {
  key: string;
  value: unknown;
  type: ContextEntryType;
  author: string;
  taskId?: string;
  planId?: string;
  tags: string[];
  status: ContextEntryStatus;
}

export interface ContextQuery {
  type?: ContextEntryType;
  tags?: string[];
  status?: ContextEntryStatus;
  planId?: string;
  author?: string;
  limit?: number;
}

export class ContextBus {
  private store = new Map<string, ContextEntry>();
  private newKeys = new Set<string>();
  private maxEntries: number;
  /** Session ID for logging — set by getSessionContextBus(). */
  sessionId: string | null = null;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  set(opts: SetOptions): ContextEntry {
    const now = Date.now();
    const existing = this.store.get(opts.key);
    const entry: ContextEntry = {
      key: opts.key,
      value: opts.value,
      type: opts.type,
      version: existing ? existing.version + 1 : 1,
      author: opts.author,
      taskId: opts.taskId,
      planId: opts.planId,
      tags: opts.tags,
      status: opts.status,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.store.set(opts.key, entry);
    this.newKeys.add(opts.key);

    // Log to SessionCommLog for observability
    if (this.sessionId) {
      import('./SessionCommLog.js').then(({ SessionCommLog }) => {
        SessionCommLog.log(this.sessionId!, 'contextbus', 'set', {
          key: opts.key,
          type: opts.type,
          value: opts.value,
          author: opts.author,
          tags: opts.tags,
          status: opts.status,
        });
      }).catch(() => {});
    }

    if (this.store.size > this.maxEntries) {
      const sorted = [...this.store.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (let i = 0; i < sorted.length - this.maxEntries; i++) {
        this.store.delete(sorted[i][0]);
        this.newKeys.delete(sorted[i][0]);
      }
    }

    return entry;
  }

  get(key: string): ContextEntry | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): boolean {
    this.newKeys.delete(key);
    return this.store.delete(key);
  }

  query(filter: ContextQuery = {}): ContextEntry[] {
    let results = [...this.store.values()];

    if (filter.type) {
      results = results.filter(e => e.type === filter.type);
    }
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter(e =>
        filter.tags!.some(t => e.tags.includes(t))
      );
    }
    if (filter.status) {
      results = results.filter(e => e.status === filter.status);
    }
    if (filter.planId) {
      results = results.filter(e => e.planId === filter.planId);
    }
    if (filter.author) {
      results = results.filter(e => e.author === filter.author);
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt);

    if (filter.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  getProjectDigest(maxTokens: number): string {
    const active = this.query({ status: 'active' });
    if (active.length === 0) return '';

    const maxChars = maxTokens * 4;
    let digest = '## Project State\n\n';
    let remaining = maxChars - digest.length;

    const priority = (e: ContextEntry): number => {
      const order: ContextEntryType[] = ['convention', 'decision', 'known-issue', 'dependency-map', 'project-fact', 'task-handoff', 'artifact'];
      return order.indexOf(e.type);
    };
    const sorted = [...active].sort((a, b) => {
      const p = priority(a) - priority(b);
      if (p !== 0) return p;
      return a.createdAt - b.createdAt;
    });

    for (const e of sorted) {
      const valStr = typeof e.value === 'string' ? e.value.slice(0, 80) : JSON.stringify(e.value).slice(0, 80);
      const line = `- [${e.type}] **${e.key}**: ${valStr}\n`;
      if (line.length > remaining) break;
      digest += line;
      remaining -= line.length;
    }

    return digest;
  }

  getRelevantExperience(agentType: string, taskDescription: string): string {
    const normalizedType = agentType.toLowerCase();
    const experiences = this.query({ status: 'active' }).filter(e =>
      e.type === 'known-issue' || e.type === 'convention'
    );

    if (experiences.length === 0) return '';

    let relevant = experiences.filter(e =>
      e.tags.some(t => t.toLowerCase() === normalizedType)
    );

    const taskWords = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const keywordMatches = experiences.filter(e =>
      !relevant.includes(e) &&
      e.tags.some(t => taskWords.some(w => t.toLowerCase().includes(w) || w.includes(t.toLowerCase())))
    );
    relevant = [...relevant, ...keywordMatches.slice(0, 3)];

    if (relevant.length === 0) return '';

    let result = '\n## Relevant Experience\n\n';
    for (const e of relevant.slice(0, 5)) {
      const label = typeof e.value === 'string' ? e.value : JSON.stringify(e.value).slice(0, 150);
      result += `- [${e.type}] ${e.key}: ${label}\n`;
    }
    return result;
  }

  getNewEntriesOfType(type: ContextEntryType): ContextEntry[] {
    return [...this.newKeys]
      .map(k => this.store.get(k))
      .filter((e): e is ContextEntry => e !== undefined && e.type === type);
  }

  serialize(): string {
    return JSON.stringify([...this.store.values()]);
  }

  static deserialize(data: string): ContextBus {
    const bus = new ContextBus();
    try {
      const entries: ContextEntry[] = JSON.parse(data);
      for (const e of entries) {
        bus.store.set(e.key, e);
      }
    } catch { /* ignore corrupt data */ }
    return bus;
  }

  archive(planId: string): ContextEntry[] {
    const entries = this.query({ planId });
    for (const e of entries) {
      this.store.delete(e.key);
      this.newKeys.delete(e.key);
    }
    return entries;
  }

  gc(ageMs = 7 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (
        (entry.status === 'resolved' || entry.status === 'superseded') &&
        now - entry.updatedAt > ageMs
      ) {
        this.store.delete(key);
        this.newKeys.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.newKeys.clear();
  }

  hasNewEntriesOfType(type: ContextEntryType): boolean {
    return this.getNewEntriesOfType(type).length > 0;
  }

  /** Clear the "new" tracking set — called after experience extraction to prevent cross-plan duplicates. */
  clearNewKeys(): void {
    this.newKeys.clear();
  }
}

/** Per-session singleton — created by WS handler on session connect, destroyed on disconnect. */
const sessionBuses = new Map<string, ContextBus>();

export function getSessionContextBus(sessionId: string): ContextBus {
  let bus = sessionBuses.get(sessionId);
  if (!bus) {
    bus = new ContextBus();
    bus.sessionId = sessionId;
    sessionBuses.set(sessionId, bus);
  }
  return bus;
}

export function destroySessionContextBus(sessionId: string): void {
  sessionBuses.delete(sessionId);
}
