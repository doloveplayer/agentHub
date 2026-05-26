# Agent Coordinator — Hub-Driven Multi-Agent Mailbox System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pure prompt-driven mailbox with a hub-driven AgentCoordinator that provides: automatic event routing between agents, three-layer permission enforcement, and fine-grained tool_use-level coordination — all extensible for user-defined custom agents.

**Architecture:** A new `AgentCoordinator` class acts as the central hub, intercepting all agent events at the WebSocket handler level. It delegates to three subsystems: `EventRouter` (routes events to target agent inboxes based on configurable rules), `PermissionEnforcer` (checks tool_use events against agent capability profiles at prompt/filesystem/hub layers), and the existing `InboxManager` (extended to support hub-driven prompt injection). Agent capability profiles and routing rules are stored as data, not hardcoded — custom agents get sensible defaults that users can customize.

**Tech Stack:** TypeScript, existing Express/WS backend, Zustand frontend, Docker sandbox

**Extensibility:** Agent types, profiles, and routing rules are all data-driven. A new agent type just needs: a DB row with `capabilities` JSON, a `PermissionProfile` entry (defaults provided), and optionally custom routing rules.

---

## File Structure

```
apps/api/src/agent/
  AgentCoordinator.ts    (NEW) — Main hub: wires EventRouter + PermissionEnforcer
  PermissionProfiles.ts  (NEW) — Agent capability profiles registry
  EventRoutingRules.ts   (NEW) — Configurable event→action→target rules
  InboxManager.ts        (MODIFY) — Add injectInboxIntoPrompt(), markRead()
  ClaudeCodeProcess.ts   (MODIFY) — Pass agentType through to coordinator
  processFactory.ts      (MODIFY) — Accept agentType parameter

apps/api/src/ws/
  handler.ts             (MODIFY) — Integrate AgentCoordinator into event loop
  taskDispatcher.ts      (MODIFY) — Integrate coordinator into task dispatch

apps/web/src/
  store/appStore.ts      (MODIFY) — Add inboxNotifications state
  components/
    AgentCard.tsx        (MODIFY) — Show inbox notification badge
    AgentStatusPanel.tsx (MODIFY) — Add inbox indicator in agent list
```

---

### Task 1: PermissionProfiles — Agent Capability Registry

**Files:**
- Create: `apps/api/src/agent/PermissionProfiles.ts`

Define agent capabilities as data. Each profile declares what file patterns the agent can write, what tools it can use, and its coordination role. Custom agents get a configurable default.

- [x] **Step 1: Write PermissionProfiles.ts**

```typescript
// apps/api/src/agent/PermissionProfiles.ts

export interface AgentCapability {
  /** Human-readable description of what this agent does */
  description: string;
  /** File path patterns this agent is allowed to write (glob-like) */
  writePatterns: string[];
  /** File path patterns this agent is allowed to read (glob-like, empty = all) */
  readPatterns: string[];
  /** Tool names this agent is allowed to use (empty = all allowed) */
  allowedTools: string[];
  /** Tool names this agent is forbidden to use */
  forbiddenTools: string[];
  /** Agent types this agent should notify on tool_use */
  notifyOnToolUse: string[];
  /** Agent types this agent should notify on completion */
  notifyOnComplete: string[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  /** If denied, which agent type should handle this instead */
  delegateTo?: string;
}

// Built-in agent profiles
const BUILTIN_PROFILES: Record<string, AgentCapability> = {
  planner: {
    description: 'Task planner — analyzes requirements and creates DAG task plans',
    writePatterns: [], // Planner never writes files
    readPatterns: ['**/*'],
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    forbiddenTools: ['Write', 'Edit', 'NotebookEdit'],
    notifyOnToolUse: [],
    notifyOnComplete: ['*'], // Notify all agents when plan is ready
  },
  'code-agent': {
    description: 'Code agent — writes and modifies source code',
    writePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.css', '**/*.html', '**/*.json', '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.yml', '**/*.yaml', '**/*.toml', '**/*.md', '**/*.sql', '**/Dockerfile', '**/*.env*', '**/*.cfg', '**/*.conf'],
    readPatterns: ['**/*'],
    allowedTools: [],
    forbiddenTools: [],
    notifyOnToolUse: ['test-agent', 'review-agent'], // Notify test/review agents on file writes
    notifyOnComplete: ['planner'],
  },
  'test-agent': {
    description: 'Test agent — writes tests and reports results',
    writePatterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/tests/**'],
    readPatterns: ['**/*'],
    allowedTools: [],
    forbiddenTools: ['Write', 'Edit'], // Cannot write to non-test files via Write/Edit
    notifyOnToolUse: [],
    notifyOnComplete: ['code-agent', 'planner'],
  },
  'review-agent': {
    description: 'Review agent — reads code and reports issues',
    writePatterns: [], // Review agent never writes files
    readPatterns: ['**/*'],
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    forbiddenTools: ['Write', 'Edit', 'NotebookEdit'],
    notifyOnToolUse: [],
    notifyOnComplete: ['code-agent', 'planner'],
  },
  'devops-agent': {
    description: 'DevOps agent — handles deployment and infrastructure',
    writePatterns: ['**/Dockerfile', '**/docker-compose*', '**/*.yml', '**/*.yaml', '**/*.conf', '**/*.toml', '**/.env*', '**/nginx/**', '**/k8s/**', '**/terraform/**'],
    readPatterns: ['**/*'],
    allowedTools: [],
    forbiddenTools: [],
    notifyOnToolUse: [],
    notifyOnComplete: ['code-agent', 'planner'],
  },
  'deps-agent': {
    description: 'Dependency agent — audits and upgrades dependencies',
    writePatterns: ['**/package.json', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum', '**/requirements.txt', '**/Pipfile', '**/Pipfile.lock', '**/pyproject.toml', '**/Gemfile', '**/Gemfile.lock'],
    readPatterns: ['**/*'],
    allowedTools: [],
    forbiddenTools: ['Write', 'Edit'], // Only modify dep files
    notifyOnToolUse: [],
    notifyOnComplete: ['code-agent', 'test-agent', 'planner'],
  },
};

/** Default profile for user-registered custom agents */
export const CUSTOM_AGENT_DEFAULT: AgentCapability = {
  description: 'Custom agent — user-defined capabilities',
  writePatterns: ['**/*'], // Permissive default, user can restrict
  readPatterns: ['**/*'],
  allowedTools: [],
  forbiddenTools: [],
  notifyOnToolUse: [],
  notifyOnComplete: ['planner'],
};

export class PermissionProfiles {
  private profiles = new Map<string, AgentCapability>(Object.entries(BUILTIN_PROFILES));

  /** Register or update a profile for an agent name */
  register(agentName: string, profile: Partial<AgentCapability>): void {
    const base = this.profiles.get(agentName) ?? { ...CUSTOM_AGENT_DEFAULT };
    this.profiles.set(agentName, { ...base, ...profile });
  }

  /** Get profile for an agent name */
  get(agentName: string): AgentCapability {
    return this.profiles.get(agentName) ?? { ...CUSTOM_AGENT_DEFAULT };
  }

  /**
   * Check if a tool_use event is permitted for this agent.
   * Returns the check result — allowed, or denied with delegation hint.
   */
  check(agentName: string, toolName: string, filePath?: string): PermissionCheckResult {
    const profile = this.get(agentName);

    // Check forbidden tools
    if (profile.forbiddenTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `${agentName} is forbidden from using ${toolName}`,
        delegateTo: 'code-agent',
      };
    }

    // Check allowed tools whitelist (if set)
    if (profile.allowedTools.length > 0 && !profile.allowedTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `${toolName} is not in ${agentName}'s allowed tools`,
        delegateTo: 'code-agent',
      };
    }

    // Check file write patterns for Write/Edit tools
    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName) && filePath) {
      if (profile.writePatterns.length === 0) {
        return {
          allowed: false,
          reason: `${agentName} is not allowed to write any files`,
          delegateTo: 'code-agent',
        };
      }
      const matches = profile.writePatterns.some(pattern => {
        const regex = new RegExp('^' + pattern.replace(/\*\*/g, '<<GLOBSTAR>>').replace(/\*/g, '[^/]*').replace(/<<GLOBSTAR>>/g, '.*') + '$');
        return regex.test(filePath);
      });
      if (!matches) {
        return {
          allowed: false,
          reason: `${agentName} cannot write to ${filePath} — outside allowed patterns`,
          delegateTo: 'code-agent',
        };
      }
    }

    return { allowed: true };
  }

  /** Get agent types that should be notified for this agent's action */
  getNotifyTargets(agentName: string, eventType: 'tool_use' | 'complete'): string[] {
    const profile = this.get(agentName);
    if (eventType === 'complete') return profile.notifyOnComplete;
    return profile.notifyOnToolUse;
  }
}

/** Global singleton */
export const permissionProfiles = new PermissionProfiles();
```

- [x] **Step 2: Verify compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors (vitest pre-existing error ok)

- [x] **Step 3: Commit**

```bash
git add apps/api/src/agent/PermissionProfiles.ts
git commit -m "feat: add PermissionProfiles — agent capability registry for coordinator"
```

---

### Task 2: EventRoutingRules — Configurable Event-to-Action Router

**Files:**
- Create: `apps/api/src/agent/EventRoutingRules.ts`

Define routing rules as data. Each rule says: when an event matching these conditions occurs, deliver this message to these target agent types.

- [x] **Step 1: Write EventRoutingRules.ts**

```typescript
// apps/api/src/agent/EventRoutingRules.ts
import type { InboxEntry } from './InboxManager.js';

export interface RouteRule {
  id: string;
  /** Event type to match */
  eventType: 'tool_use' | 'tool_result' | 'done' | 'error';
  /** Optional: match specific tool name */
  toolName?: string;
  /** Optional: match agent types (sender) — empty = match all */
  senderTypes?: string[];
  /** Optional: match file path pattern */
  filePathPattern?: string;
  /** Optional: match when tool_result contains this substring */
  resultContains?: string;
  /** Optional: match when exitCode equals this value */
  exitCode?: number;
  /** Target agent types to notify */
  notifyTypes: string[];
  /** Priority: higher rules checked first */
  priority: number;
  /** Template for inbox message summary */
  summaryTemplate: string;
  /** Risk level for the notification */
  risk: 'low' | 'high';
}

/**
 * Default routing rules.
 * These use agent type tags, not hardcoded names, so custom agents
 * with matching types automatically participate.
 */
const DEFAULT_RULES: RouteRule[] = [
  // Test failures → notify CodeAgent
  {
    id: 'test-failure-notify-code',
    eventType: 'done',
    senderTypes: ['test-agent'],
    exitCode: 1,
    notifyTypes: ['code-agent'],
    priority: 10,
    summaryTemplate: 'Tests failed — check {{senderName}} output for failure details',
    risk: 'high',
  },
  // Test completion (success) → notify Planner
  {
    id: 'test-success-notify-planner',
    eventType: 'done',
    senderTypes: ['test-agent'],
    exitCode: 0,
    notifyTypes: ['planner'],
    priority: 10,
    summaryTemplate: 'All tests passed for {{outputFile}}',
    risk: 'low',
  },
  // CodeAgent writes a file → notify TestAgent + ReviewAgent
  {
    id: 'code-write-notify-test-review',
    eventType: 'tool_use',
    toolName: 'Write',
    senderTypes: ['code-agent'],
    notifyTypes: ['test-agent', 'review-agent'],
    priority: 5,
    summaryTemplate: 'File written: {{filePath}} — tests and review may be needed',
    risk: 'low',
  },
  {
    id: 'code-edit-notify-test-review',
    eventType: 'tool_use',
    toolName: 'Edit',
    senderTypes: ['code-agent'],
    notifyTypes: ['test-agent', 'review-agent'],
    priority: 5,
    summaryTemplate: 'File edited: {{filePath}} — tests and review may be needed',
    risk: 'low',
  },
  // DepsAgent modifies lockfile → notify TestAgent
  {
    id: 'deps-change-notify-test',
    eventType: 'tool_use',
    toolName: 'Write',
    senderTypes: ['deps-agent'],
    filePathPattern: '**/package.json',
    notifyTypes: ['test-agent'],
    priority: 8,
    summaryTemplate: 'Dependencies updated — tests should be re-run',
    risk: 'high',
  },
  // ReviewAgent finds issues → notify CodeAgent
  {
    id: 'review-issues-notify-code',
    eventType: 'done',
    senderTypes: ['review-agent'],
    notifyTypes: ['code-agent'],
    priority: 10,
    summaryTemplate: 'Code review completed with findings — check {{senderName}} output',
    risk: 'high',
  },
  // DevOpsAgent deploy failure → notify CodeAgent
  {
    id: 'devops-fail-notify-code',
    eventType: 'done',
    senderTypes: ['devops-agent'],
    exitCode: 1,
    notifyTypes: ['code-agent'],
    priority: 10,
    summaryTemplate: 'Deployment failed — check {{senderName}} output for logs',
    risk: 'high',
  },
  // Error events → notify Planner
  {
    id: 'agent-error-notify-planner',
    eventType: 'error',
    notifyTypes: ['planner'],
    priority: 15,
    summaryTemplate: '{{senderName}} encountered an error: {{errorMessage}}',
    risk: 'high',
  },
  // Agent completes successfully → notify Planner
  {
    id: 'agent-done-notify-planner',
    eventType: 'done',
    exitCode: 0,
    notifyTypes: ['planner'],
    priority: 1, // Low priority — most completions don't need planner attention
    summaryTemplate: '{{senderName}} completed successfully',
    risk: 'low',
  },
];

export class EventRoutingRules {
  private rules: RouteRule[] = [...DEFAULT_RULES];

  /** Register custom routing rules (for user-defined agents) */
  addRules(rules: RouteRule[]): void {
    this.rules.push(...rules);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /** Replace all rules (for testing or full customization) */
  setRules(rules: RouteRule[]): void {
    this.rules = [...rules];
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Match event against rules and return the InboxEntry notifications to deliver.
   * Returns an array of { targetType, entry } pairs.
   */
  match(event: {
    eventType: 'tool_use' | 'tool_result' | 'done' | 'error';
    toolName?: string;
    senderType: string;
    senderName: string;
    filePath?: string;
    resultContent?: string;
    exitCode?: number;
    errorMessage?: string;
    outputFile?: string;
  }): Array<{ targetType: string; entry: InboxEntry }> {
    const deliveries: Array<{ targetType: string; entry: InboxEntry }> = [];

    for (const rule of this.rules) {
      // Match event type
      if (rule.eventType !== event.eventType) continue;

      // Match tool name (if specified)
      if (rule.toolName && rule.toolName !== event.toolName) continue;

      // Match sender type (if specified)
      if (rule.senderTypes && rule.senderTypes.length > 0 && !rule.senderTypes.includes(event.senderType)) continue;

      // Match file path pattern (if specified)
      if (rule.filePathPattern && event.filePath) {
        const regex = new RegExp(
          '^' + rule.filePathPattern.replace(/\*\*/g, '<<GLOBSTAR>>').replace(/\*/g, '[^/]*').replace(/<<GLOBSTAR>>/g, '.*') + '$'
        );
        if (!regex.test(event.filePath)) continue;
      }

      // Match result content (if specified)
      if (rule.resultContains && event.resultContent && !event.resultContent.includes(rule.resultContains)) continue;

      // Match exit code (if specified)
      if (rule.exitCode !== undefined && rule.exitCode !== event.exitCode) continue;

      // Build summary from template
      const summary = rule.summaryTemplate
        .replace(/\{\{senderName\}\}/g, event.senderName)
        .replace(/\{\{filePath\}\}/g, event.filePath || '')
        .replace(/\{\{errorMessage\}\}/g, event.errorMessage || '')
        .replace(/\{\{outputFile\}\}/g, event.outputFile || '');

      // Create inbox entries for each target type
      for (const targetType of rule.notifyTypes) {
        deliveries.push({
          targetType,
          entry: {
            type: 'intervention_request',
            id: `auto-${rule.id}-${Date.now()}`,
            from: event.senderName,
            to: targetType,
            summary,
            risk: rule.risk,
            timestamp: Date.now(),
          },
        });
      }
    }

    return deliveries;
  }
}

/** Global singleton */
export const eventRoutingRules = new EventRoutingRules();
```

- [x] **Step 2: Verify compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors

- [x] **Step 3: Commit**

```bash
git add apps/api/src/agent/EventRoutingRules.ts
git commit -m "feat: add EventRoutingRules — configurable event-to-notification router"
```

---

### Task 3: Extend InboxManager for Hub-Driven Delivery

**Files:**
- Modify: `apps/api/src/agent/InboxManager.ts`

Add methods for hub-driven prompt injection and tracking read/unread state.

- [x] **Step 1: Add injectIntoPrompt() method**

```typescript
// Add to InboxManager class in apps/api/src/agent/InboxManager.ts

  /**
   * Build the inbox-awareness prompt fragment for hub-driven mode.
   * Differs from inboxPrompt() — hub mode is more directive.
   */
  static hubModePrompt(agentName: string): string {
    return `\n## Multi-Agent Coordination
You are part of a multi-agent session coordinated by AgentHub.

OTHER AGENTS: The hub will route important messages from other agents to you automatically.
When you receive a message from another agent, consider it carefully and respond if relevant.

PERMISSIONS: You have defined capabilities. If you attempt an operation outside your scope,
the hub will notify you and suggest delegating to the right agent.

COLLABORATION: If you encounter a problem that another agent should handle, output
a clear message like "NEEDS HELP from @CodeAgent: <description>" and the hub will route it.`;
  }

  /**
   * Check if agent has unread inbox entries.
   * Returns count without clearing the file.
   */
  static unreadCount(hostWorkDir: string, agentName: string): number {
    const inboxPath = resolve(hostWorkDir, `_inbox_${agentName}.jsonl`);
    if (!existsSync(inboxPath)) return 0;
    try {
      const raw = readFileSync(inboxPath, 'utf-8');
      return raw.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }
```

- [x] **Step 2: Verify compilation and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/agent/InboxManager.ts
git commit -m "feat: extend InboxManager with hub-driven delivery and unread tracking"
```

---

### Task 4: AgentCoordinator — Main Hub Integration

**Files:**
- Create: `apps/api/src/agent/AgentCoordinator.ts`

The central coordinator that wires EventRouter + PermissionEnforcer + InboxManager, and is called from the WebSocket handler event loop.

- [x] **Step 1: Write AgentCoordinator.ts**

```typescript
// apps/api/src/agent/AgentCoordinator.ts
import { permissionProfiles, type PermissionCheckResult } from './PermissionProfiles.js';
import { eventRoutingRules } from './EventRoutingRules.js';
import { InboxManager } from './InboxManager.js';
import type { ParsedEvent } from './EventParser.js';

export interface CoordinationContext {
  sessionId: string;
  agentName: string;
  agentType: string;     // e.g., 'code-agent', 'test-agent'
  messageId: string;
  hostWorkDir: string;
  /** Resolve agentType → agentName in this session */
  resolveAgent: (agentType: string) => string | null;
  /** Broadcast a message to all WebSocket clients in this session */
  broadcast: (sessionId: string, data: unknown) => void;
}

export class AgentCoordinator {
  /**
   * Called when an agent performs a tool_use.
   * 1. Check permissions (L3 hub enforcement)
   * 2. Route event to other agents' inboxes
   */
  onToolUse(ctx: CoordinationContext, event: ParsedEvent & { type: 'tool_use' }): PermissionCheckResult {
    const filePath = event.input?.file_path || event.input?.path || event.input?.filePath;
    const filePathStr = typeof filePath === 'string' ? filePath : undefined;

    // L3: Hub permission check
    const check = permissionProfiles.check(ctx.agentName, event.toolName, filePathStr);
    if (!check.allowed) {
      ctx.broadcast(ctx.sessionId, {
        type: 'permission_violation',
        agentName: ctx.agentName,
        toolName: event.toolName,
        filePath: filePathStr,
        reason: check.reason,
        delegateTo: check.delegateTo,
        agentMessageId: ctx.messageId,
        timestamp: Date.now(),
      });

      // Auto-delegate: write to the delegate agent's inbox
      if (check.delegateTo) {
        const delegateAgentName = ctx.resolveAgent(check.delegateTo);
        if (delegateAgentName) {
          InboxManager.write(ctx.hostWorkDir, delegateAgentName, {
            type: 'intervention_request',
            id: `delegate-${Date.now()}`,
            from: ctx.agentName,
            to: delegateAgentName,
            summary: `${ctx.agentName} attempted ${event.toolName} on ${filePathStr || 'unknown'} but was blocked. Delegating to you.`,
            risk: 'high',
            timestamp: Date.now(),
          });
        }
      }

      return check;
    }

    // Route event to interested agents
    const deliveries = eventRoutingRules.match({
      eventType: 'tool_use',
      toolName: event.toolName,
      senderType: ctx.agentType,
      senderName: ctx.agentName,
      filePath: filePathStr,
    });

    for (const { targetType, entry } of deliveries) {
      const targetAgentName = ctx.resolveAgent(targetType);
      if (targetAgentName && targetAgentName !== ctx.agentName) {
        InboxManager.write(ctx.hostWorkDir, targetAgentName, entry);
      }
    }

    return check;
  }

  /**
   * Called when an agent's output chunk arrives (tool_result).
   */
  onToolResult(ctx: CoordinationContext, content: string): void {
    const deliveries = eventRoutingRules.match({
      eventType: 'tool_result',
      senderType: ctx.agentType,
      senderName: ctx.agentName,
      resultContent: content,
    });

    for (const { targetType, entry } of deliveries) {
      const targetAgentName = ctx.resolveAgent(targetType);
      if (targetAgentName && targetAgentName !== ctx.agentName) {
        InboxManager.write(ctx.hostWorkDir, targetAgentName, entry);
      }
    }
  }

  /**
   * Called when an agent finishes (done) or errors.
   */
  onAgentDone(ctx: CoordinationContext, exitCode: number, outputSummary: string): void {
    const deliveries = eventRoutingRules.match({
      eventType: exitCode === 0 ? 'done' : 'error',
      senderType: ctx.agentType,
      senderName: ctx.agentName,
      exitCode,
      errorMessage: exitCode !== 0 ? outputSummary : undefined,
      outputFile: outputSummary,
    });

    for (const { targetType, entry } of deliveries) {
      const targetAgentName = ctx.resolveAgent(targetType);
      if (targetAgentName && targetAgentName !== ctx.agentName) {
        InboxManager.write(ctx.hostWorkDir, targetAgentName, entry);
      }
    }

    // Notify frontend about inbox counts
    ctx.broadcast(ctx.sessionId, {
      type: 'inbox_update',
      agentName: ctx.agentName,
      agentType: ctx.agentType,
      timestamp: Date.now(),
    });
  }

  /**
   * Build the coordination prompt fragment for an agent about to start.
   * Injects unread inbox messages directly into the prompt.
   */
  buildCoordinationPrompt(ctx: CoordinationContext): string {
    const prompt = InboxManager.hubModePrompt(ctx.agentName);

    // Read and inject unread messages
    const entries = InboxManager.read(ctx.hostWorkDir, ctx.agentName);
    if (entries.length === 0) return prompt;

    const highRisk = entries.filter(e => e.risk === 'high');
    const lowRisk = entries.filter(e => e.risk === 'low');

    let inboxBlock = `\n\n## Inbox (${entries.length} new messages)\n\n`;
    if (highRisk.length > 0) {
      inboxBlock += `### High Priority\n`;
      for (const e of highRisk) {
        inboxBlock += `- [HIGH] From **${e.from}**: ${e.summary}\n`;
      }
    }
    if (lowRisk.length > 0) {
      inboxBlock += `### Info\n`;
      for (const e of lowRisk) {
        inboxBlock += `- From **${e.from}**: ${e.summary}\n`;
      }
    }

    return prompt + inboxBlock;
  }

  /**
   * Resolve an agentType string to an agentName in the session.
   * This bridges the gap between type-based rules and name-based agent instances.
   */
  resolveTargetAgent(
    agentType: string,
    resolveAgent: (type: string) => string | null,
  ): string | null {
    return resolveAgent(agentType);
  }
}

/** Global singleton */
export const agentCoordinator = new AgentCoordinator();
```

- [x] **Step 2: Verify compilation and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/agent/AgentCoordinator.ts
git commit -m "feat: add AgentCoordinator — hub-driven multi-agent coordination"
```

---

### Task 5: Integrate AgentCoordinator into WebSocket Handler

**Files:**
- Modify: `apps/api/src/ws/handler.ts`
- Modify: `apps/api/src/agent/ClaudeCodeProcess.ts`

Wire the coordinator into the existing event loop so every agent event passes through it.

- [x] **Step 1: Add agentType tracking to process start**

In `handler.ts`, when starting an agent process, pass the agent's type name. Modify the `handleChatMessage` function to look up and store the agent type alongside the agent name.

Add a helper map `agentNameToType` in handler.ts:

```typescript
// Near other state imports
const agentNameToType = new Map<string, string>();

// In handleChatMessage, after resolving agentNameForProc:
if (agentNameForProc && mention.agentId) {
  const agent = await prisma.agent.findUnique({ where: { id: mention.agentId }, select: { name: true } });
  if (agent) {
    agentNameToType.set(agentNameForProc, agent.name);
  }
}
```

- [x] **Step 2: Wire coordinator into tool_use events**

In the one-shot path's `case 'tool_use'` handler, add coordinator call:

```typescript
case 'tool_use': {
  stateTracker.updateTool(mention.messageId, event.toolName, event.input || {});
  // ... existing file mod tracking ...

  // AgentCoordinator: permission check + event routing
  if (agentNameForProc && sandbox) {
    const agentType = agentNameToType.get(agentNameForProc) ?? agentNameForProc;
    const check = agentCoordinator.onToolUse({
      sessionId,
      agentName: agentNameForProc,
      agentType,
      messageId: mention.messageId,
      hostWorkDir: sandbox.hostWorkDir,
      resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
      broadcast,
    }, event as ParsedEvent & { type: 'tool_use' });

    // If permission denied, we can optionally kill the tool
    // For now, broadcast the violation and let the agent continue
    // (the agent's prompt warns it about its boundaries)
  }

  broadcast(sessionId, { type: 'agent_status', status: 'tool_use', ... });
  break;
}
```

Add a helper to resolve agentType → agentName using the current session's agents:

```typescript
function resolveAgentNameInSession(sessionId: string, agentType: string): string | null {
  // Check agentTaskQueues and agentProcesses for matching agent names
  for (const [name] of agentProcesses.get(sessionId) ?? []) {
    if (name === agentType) return name;
  }
  // Check known agent types in the session
  return agentNameToType.get(agentType) ?? null;
}
```

- [x] **Step 3: Wire coordinator into tool_result events**

In the one-shot path's `case 'tool_result'`:

```typescript
case 'tool_result':
  if (agentNameForProc && sandbox) {
    const agentType = agentNameToType.get(agentNameForProc) ?? agentNameForProc;
    const content = typeof event.content === 'string' ? event.content : '';
    agentCoordinator.onToolResult({
      sessionId, agentName: agentNameForProc, agentType,
      messageId: mention.messageId,
      hostWorkDir: sandbox.hostWorkDir,
      resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
      broadcast,
    }, content);
  }
  broadcast(sessionId, { type: 'agent_status', status: 'tool_result', ... });
  break;
```

- [x] **Step 4: Wire coordinator into done events**

In the one-shot path's `case 'done'`, add after the existing logic:

```typescript
if (agentNameForProc && sandbox) {
  const agentType = agentNameToType.get(agentNameForProc) ?? agentNameForProc;
  const summary = finalContent.slice(0, 200);
  agentCoordinator.onAgentDone({
    sessionId, agentName: agentNameForProc, agentType,
    messageId: mention.messageId,
    hostWorkDir: sandbox.hostWorkDir,
    resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  }, event.exitCode, summary);
}
```

- [x] **Step 5: Inject coordination prompt**

When building the agent prompt (before sending to agent), append coordination context:

```typescript
// After building agentPrompt, add coordination context:
if (agentNameForProc && sandbox) {
  const agentType = agentNameToType.get(agentNameForProc) ?? agentNameForProc;
  const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
    sessionId, agentName: agentNameForProc, agentType,
    messageId: mention.messageId,
    hostWorkDir: sandbox.hostWorkDir,
    resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
    broadcast,
  });
  agentPrompt += coordinationPrompt;
}
```

- [x] **Step 6: Verify compilation**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [x] **Step 7: Commit**

```bash
git add apps/api/src/ws/handler.ts
git commit -m "feat: integrate AgentCoordinator into WebSocket handler event loop"
```

---

### Task 6: Integrate Coordinator into Task Dispatch

**Files:**
- Modify: `apps/api/src/ws/taskDispatcher.ts`

Apply the same coordination to task-dispatched agents.

- [x] **Step 1: Add coordination to startTaskAgent**

Add coordinator calls in `startTaskAgent`'s onEvent handler, similar to Task 5. The key additions:

```typescript
// In startTaskAgent, after proc.onEvent((event) => {
// Add a helper to look up the agent type:
const agentType = agent.name; // agent.name is the type like 'code-agent'

// In case 'tool_use':
const check = agentCoordinator.onToolUse({
  sessionId, agentName: agent.name, agentType,
  messageId: taskMsgId,
  hostWorkDir: sandbox.hostWorkDir,
  resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
  broadcast,
}, { type: 'tool_use', toolName: event.toolName, input: event.input || {} } as any);

// In case 'done':
agentCoordinator.onAgentDone({
  sessionId, agentName: agent.name, agentType,
  messageId: taskMsgId,
  hostWorkDir: sandbox.hostWorkDir,
  resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
  broadcast,
}, event.exitCode ?? 0, output.slice(0, 200));
```

- [x] **Step 2: Inject coordination prompt into task prompts**

In `buildTaskPrompt` or when creating the full prompt:

```typescript
// After building the task prompt, inject coordination context:
const coordinationPrompt = agentCoordinator.buildCoordinationPrompt({
  sessionId, agentName: agent.name, agentType,
  messageId: taskMsgId,
  hostWorkDir: sandbox.hostWorkDir,
  resolveAgent: (type) => resolveAgentNameInSession(sessionId, type),
  broadcast,
});
const fullPrompt = `${agent.systemPrompt}\n\n---\n\n${buildTaskPrompt(task)}\n${coordinationPrompt}`;
```

- [x] **Step 3: Verify compilation and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/ws/taskDispatcher.ts
git commit -m "feat: integrate AgentCoordinator into task dispatch"
```

---

### Task 7: Initialize Permission Profiles on Session Start

**Files:**
- Modify: `apps/api/src/ws/handler.ts` (handleConnection or handleConfirmPlan)

Register all session agents' profiles when a session starts, so custom agents get their profiles set up.

- [x] **Step 1: Register profiles when session sandbox is ready**

In the `handleConnection` function, after sandbox is ready and session agents are loaded:

```typescript
// After sandbox creation, load session agents and register their profiles
const sessionAgents = await prisma.sessionAgent.findMany({
  where: { sessionId },
  include: { agent: { select: { id: true, name: true, displayName: true, description: true, capabilities: true } } },
});

for (const sa of sessionAgents) {
  // Register each agent's profile. Custom agents use their stored capabilities
  // or fall back to CUSTOM_AGENT_DEFAULT.
  const profile = buildProfileFromAgent(sa.agent);
  permissionProfiles.register(sa.agent.name, profile);
  agentNameToType.set(sa.agent.name, sa.agent.name);
}
```

Add a helper to convert agent DB record to a PermissionProfile:

```typescript
function buildProfileFromAgent(agent: { name: string; description: string; capabilities?: unknown }): Partial<AgentCapability> {
  if (agent.capabilities && typeof agent.capabilities === 'object') {
    return agent.capabilities as Partial<AgentCapability>;
  }
  return {}; // Falls back to built-in or CUSTOM_AGENT_DEFAULT
}
```

- [x] **Step 2: Add capabilities JSON field to Agent model (if not exists)**

Check if `capabilities` column exists in the Agent table. If not, add migration:

```sql
ALTER TABLE "Agent" ADD COLUMN "capabilities" JSONB;
```

Only run this if the column doesn't already exist.

- [x] **Step 3: Verify compilation and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/ws/handler.ts
git commit -m "feat: register agent permission profiles on session start"
```

---

### Task 8: Frontend — Inbox Notification Badge on AgentCard

**Files:**
- Modify: `apps/web/src/store/appStore.ts`
- Modify: `apps/web/src/components/AgentCard.tsx`
- Modify: `apps/web/src/hooks/useChat.ts`

Show a notification badge when an agent has unread inbox messages.

- [x] **Step 1: Add inbox state to appStore**

```typescript
// In appStore.ts interface:
inboxNotifications: Record<string, number>; // agentName → unread count
addInboxNotification: (agentName: string) => void;
clearInboxNotifications: (agentName: string) => void;

// In create() initial state:
inboxNotifications: {},

// Implementations:
addInboxNotification: (agentName) =>
  set((state) => ({
    inboxNotifications: {
      ...state.inboxNotifications,
      [agentName]: (state.inboxNotifications[agentName] || 0) + 1,
    },
  })),

clearInboxNotifications: (agentName) =>
  set((state) => ({
    inboxNotifications: { ...state.inboxNotifications, [agentName]: 0 },
  })),
```

- [x] **Step 2: Handle inbox_update WebSocket event in useChat.ts**

```typescript
case 'inbox_update':
  if (data.agentName) {
    useAppStore.getState().addInboxNotification(data.agentName);
  }
  break;

case 'permission_violation':
  if (data.agentName) {
    useAppStore.getState().addInboxNotification(data.agentName);
    // Also add as agent event for visibility
    if (data.agentMessageId) {
      addAgentEvent(data.agentMessageId, {
        id: 'pv-' + Date.now(),
        type: 'permission_request',
        timestamp: data.timestamp || Date.now(),
        details: {
          tool: data.toolName,
          path: data.filePath,
          content: `${data.reason} → Delegating to ${data.delegateTo}`,
        },
      });
    }
  }
  break;
```

- [x] **Step 3: Add inbox badge to AgentCard header**

In `AgentCard.tsx`, after the display name, add:

```tsx
const inboxCount = useAppStore(s => agentName ? (s.inboxNotifications[agentName] || 0) : 0);

// In the header, after displayName span:
{inboxCount > 0 && (
  <span
    className="text-[10px] px-1.5 py-0.5 rounded-full bg-hub-accent/20 text-hub-accent font-bold cursor-pointer"
    title={`${inboxCount} unread messages from other agents`}
    onClick={() => useAppStore.getState().clearInboxNotifications(agentName!)}
  >
    {inboxCount}
  </span>
)}
```

- [x] **Step 4: Verify compilation and commit**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
git add apps/web/src/store/appStore.ts apps/web/src/components/AgentCard.tsx apps/web/src/hooks/useChat.ts
git commit -m "feat: add inbox notification badge to AgentCard"
```

---

### Task 9: End-to-End Verification

**Files:** None (manual testing)

Verify the full flow with the snake game test scenario.

- [x] **Step 1: Start the app**

```bash
bash scripts/startup.sh
```

- [x] **Step 2: Run through the test scenario**

1. Open the app, create a new group session
2. Send "为我规划一个简单的贪吃蛇html脚本"
3. Planner creates plan with CodeAgent + TestAgent tasks
4. Confirm the plan
5. Observe: CodeAgent starts → AgentCard shows running → tool_use events flow → test-agent gets inbox notification
6. CodeAgent finishes → TestAgent gets task → runs tests
7. If TestAgent finds issues → inbox to CodeAgent → CodeAgent receives notification in next prompt
8. Verify AgentCards show inbox badges when notifications arrive
9. Verify PermissionEnforcer blocks TestAgent from writing non-test files

- [x] **Step 3: Verify custom agent extensibility**

1. Register a new agent type via the API
2. Verify it gets CUSTOM_AGENT_DEFAULT profile
3. Send it a message → verify it participates in coordination
4. Customize its profile via capabilities → verify the new rules apply

---

### Task 10: Cleanup and Documentation

**Files:**
- Modify: `CLAUDE.md`

- [x] **Step 1: Add AgentCoordinator section to CLAUDE.md**

```markdown
## Multi-Agent Coordination (AgentCoordinator)

The AgentCoordinator provides hub-driven multi-agent coordination:
- **PermissionProfiles**: Defines what each agent type can do (file patterns, tools)
- **EventRoutingRules**: Configurable rules for auto-routing events between agents
- **AgentCoordinator**: Central hub that checks permissions and routes events

### Adding a new agent type
1. Register the agent in the DB with optional `capabilities` JSON
2. It automatically gets CUSTOM_AGENT_DEFAULT profile
3. Customize permissions via `PermissionProfiles.register()`
4. Add routing rules via `EventRoutingRules.addRules()` if needed
```

- [x] **Step 2: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: add AgentCoordinator documentation to CLAUDE.md"
```
