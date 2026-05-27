export interface AgentCapability {
  description: string;
  writePatterns: string[];
  readPatterns: string[];
  allowedTools: string[];
  forbiddenTools: string[];
  notifyOnToolUse: string[];
  notifyOnComplete: string[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  delegateTo?: string;
}

const BUILTIN_PROFILES: Record<string, AgentCapability> = {
  planner: {
    description: 'Task planner — analyzes requirements and creates DAG task plans',
    writePatterns: [],
    readPatterns: ['**/*'],
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    forbiddenTools: ['Write', 'Edit', 'NotebookEdit'],
    notifyOnToolUse: [],
    notifyOnComplete: ['*'],
  },
  'code-agent': {
    description: 'Code agent — writes and modifies source code',
    writePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.css', '**/*.html', '**/*.json', '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.yml', '**/*.yaml', '**/*.toml', '**/*.md', '**/*.sql', '**/Dockerfile', '**/*.env*', '**/*.cfg', '**/*.conf'],
    readPatterns: ['**/*'],
    allowedTools: [],
    forbiddenTools: [],
    notifyOnToolUse: ['test-agent', 'review-agent'],
    notifyOnComplete: ['planner'],
  },
  'test-agent': {
    description: 'Test agent — writes tests and reports results',
    writePatterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/tests/**'],
    readPatterns: ['**/*'],
    allowedTools: [],
    forbiddenTools: ['Write', 'Edit'],
    notifyOnToolUse: [],
    notifyOnComplete: ['code-agent', 'planner'],
  },
  'review-agent': {
    description: 'Review agent — reads code and reports issues',
    writePatterns: [],
    readPatterns: ['**/*'],
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    forbiddenTools: ['Write', 'Edit', 'NotebookEdit'],
    notifyOnToolUse: [],
    notifyOnComplete: ['code-agent', 'planner'],
  },
};

export const CUSTOM_AGENT_DEFAULT: AgentCapability = {
  description: 'Custom agent — user-defined capabilities',
  writePatterns: ['**/*'],
  readPatterns: ['**/*'],
  allowedTools: [],
  forbiddenTools: [],
  notifyOnToolUse: [],
  notifyOnComplete: ['planner'],
};

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*');
  return new RegExp('^' + escaped + '$');
}

export class PermissionProfiles {
  private profiles = new Map<string, AgentCapability>(Object.entries(BUILTIN_PROFILES));

  register(agentName: string, profile: Partial<AgentCapability>): void {
    const base = this.profiles.get(agentName) ?? { ...CUSTOM_AGENT_DEFAULT };
    this.profiles.set(agentName, { ...base, ...profile });
  }

  get(agentName: string): AgentCapability {
    return this.profiles.get(agentName) ?? { ...CUSTOM_AGENT_DEFAULT };
  }

  check(agentName: string, toolName: string, filePath?: string): PermissionCheckResult {
    const profile = this.get(agentName);

    if (profile.forbiddenTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `${agentName} is forbidden from using ${toolName}`,
        delegateTo: 'code-agent',
      };
    }

    if (profile.allowedTools.length > 0 && !profile.allowedTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `${toolName} is not in ${agentName}'s allowed tools`,
        delegateTo: 'code-agent',
      };
    }

    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName) && filePath) {
      if (profile.writePatterns.length === 0) {
        return {
          allowed: false,
          reason: `${agentName} is not allowed to write any files`,
          delegateTo: 'code-agent',
        };
      }
      const matches = profile.writePatterns.some((pattern) => globToRegex(pattern).test(filePath));
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

  getNotifyTargets(agentName: string, eventType: 'tool_use' | 'complete'): string[] {
    const profile = this.get(agentName);
    if (eventType === 'complete') return profile.notifyOnComplete;
    return profile.notifyOnToolUse;
  }
}

export const permissionProfiles = new PermissionProfiles();
