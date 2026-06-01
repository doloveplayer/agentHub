import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { CapabilityInventory } from './CapabilityInventory.js';

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
    sessionId?: string,
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

    // Inject plan-and-dispatch skill for Planner agents
    if (agentName === 'planner' || agentName.startsWith('planner-')) {
      const __dirname = new URL('.', import.meta.url).pathname;
      const skillTemplatePath = resolve(__dirname, 'skills', 'plan-and-dispatch.md');
      try {
        const skillContent = readFileSync(skillTemplatePath, 'utf-8');
        writeFileSync(resolve(claudeConfigDir, 'skills', 'plan-and-dispatch.md'), skillContent, 'utf-8');
      } catch (err: any) {
        console.warn(`[AgentDirectory] Could not write plan skill for ${agentName}: ${err.message}`);
      }
    }

    // Write Claude Code settings.json if provided (model, permissions, etc.)
    if (settings) {
      writeFileSync(resolve(claudeConfigDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
    }

    // Regenerate capability inventory for Planner agents when any agent is added.
    // Also generate immediately when the Planner itself is initialized (hostWorkDir
    // passed explicitly since the DB may not have it yet).
    if (sessionId) {
      CapabilityInventory.regenerate(sessionId, hostWorkDir).catch((err) =>
        console.error(`[AgentDirectory] Failed to regenerate cap-inventory:`, err.message)
      );
    }

    return agentDir;
  }

  /** Clean up agent directory on session close */
  static cleanup(hostWorkDir: string, agentName: string): void {
    const agentDir = resolve(hostWorkDir, `_agent_${agentName}`);
    // Memory is preserved; full cleanup on session destroy handled by SandboxManager.destroyHostDir
  }
}
