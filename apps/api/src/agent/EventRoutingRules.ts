import type { InboxEntry } from './InboxManager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteRule {
  id: string;
  eventType: 'tool_use' | 'tool_result' | 'done' | 'error';
  /** Optional tool name to match (e.g. 'Write', 'Edit'). */
  toolName?: string;
  /** Optional sender agent types to match. Empty/undefined = match all. */
  senderTypes?: string[];
  /** Optional glob-like pattern for file paths (e.g. '**\/package.json'). */
  filePathPattern?: string;
  /** Optional substring that must appear in tool result content. */
  resultContains?: string;
  /** Optional exit code to match. */
  exitCode?: number;
  /** Target agent types to notify when this rule fires. */
  notifyTypes: string[];
  /** Higher priority rules are checked first. */
  priority: number;
  /** Template string with {{senderName}}, {{filePath}}, {{errorMessage}}, {{outputFile}}. */
  summaryTemplate: string;
  risk: 'low' | 'high';
}

export interface RouteEvent {
  eventType: 'tool_use' | 'tool_result' | 'done' | 'error';
  toolName?: string;
  senderType: string;
  senderName: string;
  filePath?: string;
  resultContent?: string;
  exitCode?: number;
  errorMessage?: string;
  outputFile?: string;
}

export interface RouteMatch {
  targetType: string;
  entry: InboxEntry;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp for matching file paths.
 *
 * Supported syntax:
 *   **  – matches any number of characters (including "/")
 *   *   – matches any character except "/"
 *   ?   – matches a single character except "/"
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // **/  — zero or more directory segments
        regexStr += '(.*/)?';
        i += 3;
      } else {
        // **  — matches everything (including /)
        regexStr += '.*';
        i += 2;
      }
    } else if (pattern[i] === '*') {
      // *  — matches anything except /
      regexStr += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      regexStr += '[^/]';
      i += 1;
    } else {
      // Escape regex-special characters
      if ('.+^${}()|[\\]'.includes(pattern[i])) {
        regexStr += '\\' + pattern[i];
      } else {
        regexStr += pattern[i];
      }
      i += 1;
    }
  }
  return new RegExp('^' + regexStr + '$');
}

function matchGlob(pattern: string, filePath: string): boolean {
  if (!filePath || !pattern) return false;
  return globToRegex(pattern).test(filePath);
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

const PLACEHOLDERS: Record<string, keyof RouteEvent> = {
  '{{senderName}}': 'senderName',
  '{{filePath}}': 'filePath',
  '{{errorMessage}}': 'errorMessage',
  '{{outputFile}}': 'outputFile',
};

function renderTemplate(template: string, event: RouteEvent): string {
  let result = template;
  for (const [placeholder, key] of Object.entries(PLACEHOLDERS)) {
    result = result.replaceAll(placeholder, String(event[key] ?? ''));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: RouteRule[] = [
  {
    id: 'agent-error-notify-planner',
    eventType: 'error',
    notifyTypes: ['planner'],
    priority: 15,
    summaryTemplate: '[{{senderName}}] encountered error: {{errorMessage}}',
    risk: 'high',
  },
  {
    id: 'test-failure-notify-code',
    eventType: 'done',
    senderTypes: ['test-agent'],
    exitCode: 1,
    notifyTypes: ['code-agent'],
    priority: 10,
    summaryTemplate: '[{{senderName}}] tests failed (exit code 1)',
    risk: 'high',
  },
  {
    id: 'test-success-notify-planner',
    eventType: 'done',
    senderTypes: ['test-agent'],
    exitCode: 0,
    notifyTypes: ['planner'],
    priority: 10,
    summaryTemplate: '[{{senderName}}] tests passed',
    risk: 'low',
  },
  {
    id: 'review-issues-notify-code',
    eventType: 'done',
    senderTypes: ['review-agent'],
    notifyTypes: ['code-agent'],
    priority: 10,
    summaryTemplate: '[{{senderName}}] completed review — check findings',
    risk: 'high',
  },
  {
    id: 'code-write-notify-test-review',
    eventType: 'tool_use',
    toolName: 'Write',
    senderTypes: ['code-agent'],
    notifyTypes: ['test-agent', 'review-agent'],
    priority: 5,
    summaryTemplate: '[{{senderName}}] wrote {{filePath}}',
    risk: 'low',
  },
  {
    id: 'code-edit-notify-test-review',
    eventType: 'tool_use',
    toolName: 'Edit',
    senderTypes: ['code-agent'],
    notifyTypes: ['test-agent', 'review-agent'],
    priority: 5,
    summaryTemplate: '[{{senderName}}] edited {{filePath}}',
    risk: 'low',
  },
  {
    id: 'review-report-file-written',
    eventType: 'tool_use',
    toolName: 'Write',
    senderTypes: ['review-agent'],
    filePathPattern: '**/*review*',
    notifyTypes: ['code-agent', 'planner'],
    priority: 12,
    summaryTemplate: '[{{senderName}}] wrote review report to {{filePath}} — check and fix issues',
    risk: 'high',
  },
  {
    id: 'code-agent-done-after-fix',
    eventType: 'done',
    senderTypes: ['code-agent'],
    notifyTypes: ['review-agent', 'test-agent'],
    priority: 6,
    summaryTemplate: '[{{senderName}}] completed code changes — re-review and re-test needed',
    risk: 'high',
  },
  {
    id: 'agent-done-notify-planner',
    eventType: 'done',
    exitCode: 0,
    notifyTypes: ['planner'],
    priority: 1,
    summaryTemplate: '[{{senderName}}] completed successfully',
    risk: 'low',
  },
];

// ---------------------------------------------------------------------------
// Routing engine
// ---------------------------------------------------------------------------

export class EventRoutingRules {
  private rules: RouteRule[] = [...DEFAULT_RULES].sort((a, b) => b.priority - a.priority);

  /** Add custom rules, then re-sort by priority descending. */
  addRules(rules: RouteRule[]): void {
    this.rules.push(...rules);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /** Replace all rules (including defaults) with the given set. */
  setRules(rules: RouteRule[]): void {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Match an event against all rules in priority order.
   * Returns one entry per (rule, notifyType) combination that matches.
   */
  match(event: RouteEvent): RouteMatch[] {
    const results: RouteMatch[] = [];

    for (const rule of this.rules) {
      if (!this.ruleMatches(rule, event)) continue;

      const summary = renderTemplate(rule.summaryTemplate, event);
      const baseEntry: Omit<InboxEntry, 'to'> = {
        type: 'intervention_request',
        id: `${rule.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        from: event.senderName,
        summary,
        risk: rule.risk,
        timestamp: Date.now(),
      };

      for (const targetType of rule.notifyTypes) {
        results.push({
          targetType,
          entry: { ...baseEntry, to: targetType },
        });
      }
    }

    return results;
  }

  /** Get the current rule set (for inspection / debugging). */
  getRules(): ReadonlyArray<RouteRule> {
    return this.rules;
  }

  // ---- private helpers ----------------------------------------------------

  private ruleMatches(rule: RouteRule, event: RouteEvent): boolean {
    // eventType must match
    if (rule.eventType !== event.eventType) return false;

    // toolName: if specified on rule, must match event
    if (rule.toolName !== undefined && rule.toolName !== event.toolName) return false;

    // senderTypes: if specified and non-empty, must include event senderType.
    // Supports prefix matching: 'review-agent' matches 'review-agent-6064e856'.
    if (rule.senderTypes && rule.senderTypes.length > 0) {
      const matches = rule.senderTypes.some(
        (t) => event.senderType === t || event.senderType.startsWith(t + '-')
      );
      if (!matches) return false;
    }

    // exitCode: if specified on rule, must match event (undefined = no check)
    if (rule.exitCode !== undefined && rule.exitCode !== event.exitCode) return false;

    // filePathPattern: if specified, event must have a matching filePath
    if (rule.filePathPattern !== undefined) {
      if (!event.filePath) return false;
      if (!matchGlob(rule.filePathPattern, event.filePath)) return false;
    }

    // resultContains: if specified, event resultContent must include it
    if (rule.resultContains !== undefined) {
      if (!event.resultContent) return false;
      if (!event.resultContent.includes(rule.resultContains)) return false;
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const eventRoutingRules = new EventRoutingRules();
