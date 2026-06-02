import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { ExperienceEntry } from '@agenthub/shared';
import { config } from '../config.js';
import { CapabilityInventory } from './CapabilityInventory.js';

const AGENTS_ROOT = config.agentContainer.hostRoot;

export class AgentDirectoryManager {

  /** Ensure agent persistent home directory exists at .agents/<agentId>/ */
  static ensureAgentHome(agentId: string, agentName: string, systemPrompt: string): string {
    const homeDir = resolve(AGENTS_ROOT, agentId);
    const claudeConfigDir = resolve(homeDir, '.claude');

    if (!existsSync(homeDir)) {
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(resolve(claudeConfigDir, 'memory'), { recursive: true });
      mkdirSync(resolve(claudeConfigDir, 'skills'), { recursive: true });

      const claudeMd = `# Agent: ${agentName}

${systemPrompt}

## Collaboration Rules
- You are a pluggable agent with persistent identity and memory.
- Your working directory is /workspace — write all user-facing code and files here.
- Your personal files (memory, config, skills) are at /home/agent/.claude/ — do NOT write config files to /workspace.
- When you complete a significant phase, note it in your output.
- This CLAUDE.md defines your persistent identity and behavior rules.
`;

      writeFileSync(resolve(homeDir, 'CLAUDE.md'), claudeMd, 'utf-8');
    }

    return homeDir;
  }

  /** Get the host path to an agent's persistent home directory */
  static getAgentHome(agentId: string): string {
    return resolve(AGENTS_ROOT, agentId);
  }

  /** Write a single experience entry to the agent's memory directory using Claude Code SDK MEMORY.md format. */
  static writeAgentMemory(homeDir: string, exp: ExperienceEntry): void {
    const category = exp.type.replace(/-/g, '_');
    const slug = exp.title
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    const memoryDir = resolve(homeDir, '.claude', 'memory', category);
    mkdirSync(memoryDir, { recursive: true });

    const frontmatter = `---
name: ${slug}
description: ${exp.detail.slice(0, 120)}
metadata:
  type: reference
  tags: [${exp.tags.join(', ')}]
  severity: ${exp.severity}
  sourcePlan: ${exp.sourcePlan || ''}
  sourceTask: ${exp.sourceTask || ''}
---

## ${exp.title}

${exp.detail}
`;

    const filePath = resolve(memoryDir, `${slug}.md`);
    writeFileSync(filePath, frontmatter, 'utf-8');

    // Update MEMORY.md index
    const indexPath = resolve(homeDir, '.claude', 'memory', 'MEMORY.md');
    let index = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '# Agent Memory Index\n\n';
    const entryLine = `- [${slug}](${category}/${slug}.md) — ${exp.detail.slice(0, 80)}`;
    if (!index.includes(entryLine)) {
      index += entryLine + '\n';
      writeFileSync(indexPath, index, 'utf-8');
    }
  }

  /**
   * Initialize per-agent directory structure inside the sandbox host dir.
   *
   * Structure:
   *   {sandboxDir}/_agent_{agentName}/
   *     CLAUDE.md
   *     .claude/
   *       settings.json   (if settings provided)
   *       memory/
   *       skills/
   *
   * @param sandboxDir - host path to sandbox dir (agent config files go here)
   * @param agentName - agent name for directory naming
   * @param systemPrompt - agent's system prompt written to CLAUDE.md
   * @param settings - optional Claude Code settings.json content
   * @param sessionId - optional session ID for capability inventory
   */
  static initialize(
    sandboxDir: string,
    agentName: string,
    systemPrompt: string,
    settings?: Record<string, unknown> | null,
    sessionId?: string,
  ): string {
    const agentDir = resolve(sandboxDir, `_agent_${agentName}`);
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
- Your working directory is /workspace — write all user-facing code and files here.
- Your personal files (memory, config) are at /sandbox/_agent_${agentName}/ — do NOT write config files to /workspace.
- When you complete a significant phase, note it in your output.
- You may be contacted by other agents. Check your inbox at /sandbox/_agent_${agentName}/_inbox.jsonl
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
    if (sessionId) {
      CapabilityInventory.regenerate(sessionId, sandboxDir).catch((err) =>
        console.error(`[AgentDirectory] Failed to regenerate cap-inventory:`, err.message)
      );
    }

    return agentDir;
  }

  /** Clean up agent directory on session close */
  static cleanup(sandboxDir: string, agentName: string): void {
    const agentDir = resolve(sandboxDir, `_agent_${agentName}`);
    // Memory is preserved; full cleanup on session destroy handled by SandboxManager.destroyHostDir
  }
}
