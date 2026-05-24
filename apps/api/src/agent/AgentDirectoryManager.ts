import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export class AgentDirectoryManager {
  /**
   * Initialize per-agent directory structure inside the sandbox host dir.
   *
   * Structure:
   *   {hostWorkDir}/_agent_{agentName}/
   *     CLAUDE.md
   *     .claude/
   *       settings.json   (if settings provided)
   *       memory/
   *       skills/
   */
  static initialize(
    hostWorkDir: string,
    agentName: string,
    systemPrompt: string,
    settings?: Record<string, unknown> | null,
  ): string {
    const agentDir = resolve(hostWorkDir, `_agent_${agentName}`);
    const claudeConfigDir = resolve(agentDir, '.claude');

    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(resolve(claudeConfigDir, 'memory'), { recursive: true });
      mkdirSync(resolve(claudeConfigDir, 'skills'), { recursive: true });
    }

    const claudeMd = `# Agent: ${agentName}

${systemPrompt}

## Collaboration Rules
- You are part of a multi-agent session. Other agents may observe your work.
- Your workspace is at /workspace. All agents share this filesystem.
- Your personal files (memory, config) are at /workspace/_agent_${agentName}/
- When you complete a significant phase, note it in your output.
- You may be contacted by other agents. Check your inbox at /workspace/_agent_${agentName}/_inbox.jsonl
- This CLAUDE.md defines your persistent identity and behavior rules. The user message passed at runtime contains only the task — do not expect system prompt in each message.
`;

    writeFileSync(resolve(agentDir, 'CLAUDE.md'), claudeMd, 'utf-8');

    // Write Claude Code settings.json if provided (model, permissions, etc.)
    if (settings) {
      writeFileSync(resolve(claudeConfigDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
    }

    return agentDir;
  }

  /** Clean up agent directory on session close */
  static cleanup(hostWorkDir: string, agentName: string): void {
    const agentDir = resolve(hostWorkDir, `_agent_${agentName}`);
    // Memory is preserved; full cleanup on session destroy handled by SandboxManager.destroyHostDir
  }
}
