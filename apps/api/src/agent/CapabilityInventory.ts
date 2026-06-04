import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '../db/prisma.js';
import type { SkillDef } from '@agenthub/shared';

export class CapabilityInventory {
  /**
   * Generate cap-inventory.md skill for all agents in a session.
   * Writes to every Planner agent's .claude/skills/ directory.
   */
  static async generate(sessionId: string, knownHostWorkDir?: string): Promise<void> {
    const sessionAgents = await prisma.sessionAgent.findMany({
      where: { sessionId },
      include: {
        agent: {
          select: {
            id: true,
            name: true,
            displayName: true,
            description: true,
            capabilities: true,
          },
        },
      },
    });

    if (sessionAgents.length === 0) return;

    const content = buildInventoryMarkdown(sessionAgents);

    for (const sa of sessionAgents) {
      const isPlanner = sa.agent.name === 'planner' || sa.agent.name.startsWith('planner-');
      if (!isPlanner) continue;

      // Prefer explicit hostWorkDir (set when Planner is first initialized and DB
      // hasn't been updated yet), then fall back to the Agent table record
      const dbAgent = await prisma.agent.findUnique({
        where: { id: sa.agentId },
        select: { hostWorkDir: true, name: true },
      });
      const hostWorkDir = knownHostWorkDir || dbAgent?.hostWorkDir;
      const agentName = dbAgent?.name || sa.agent.name;
      if (!hostWorkDir) continue;

      const skillsDir = resolve(hostWorkDir, `_agent_${agentName}`, '.claude', 'skills');
      if (!existsSync(skillsDir)) continue;

      const capPath = resolve(skillsDir, 'cap-inventory.md');

      // Content change check: skip if file exists with same content (ignoring timestamp)
      if (existsSync(capPath)) {
        try {
          const existing = readFileSync(capPath, 'utf-8');
          const stripTimestamp = (s: string) => s.replace(/>.Last updated by AgentHub at.*/g, '');
          if (stripTimestamp(existing) === stripTimestamp(content)) continue;
        } catch { /* read error, proceed with write */ }
      }

      writeFileSync(capPath, content, 'utf-8');
      console.log(`[CapabilityInventory] Generated cap-inventory for ${agentName} in session ${sessionId.slice(0, 8)}`);

      // Upsert cap-inventory skill into agent DB record so AgentCard shows it
      try {
        const { AgentDirectoryManager } = await import('./AgentDirectoryManager.js');
        await AgentDirectoryManager.upsertAgentSkill(sa.agentId, {
          name: 'cap-inventory',
          description: 'Current session agent capability inventory',
          content: content,
        });
      } catch (err: any) {
        console.warn(`[CapabilityInventory] Failed to upsert cap-inventory skill for ${agentName}: ${err.message}`);
      }

      // Push inbox notification if Planner is actively running
      try {
        const { InboxManager } = await import('./InboxManager.js');
        InboxManager.write(hostWorkDir, agentName, {
          type: 'context_update',
          id: `cap-update-${Date.now().toString(36)}`,
          from: 'hub',
          to: agentName,
          summary: 'Agent capability inventory has been updated. Please re-read cap-inventory.md skill.',
          timestamp: Date.now(),
        }, sessionId);
      } catch {
        // Non-critical — Planner will pick up updated skill on next message
      }
    }
  }

  static async regenerate(sessionId: string, knownHostWorkDir?: string): Promise<void> {
    return CapabilityInventory.generate(sessionId, knownHostWorkDir);
  }
}

function buildInventoryMarkdown(
  sessionAgents: any[],
): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const agentTypes = sessionAgents.map((sa: any) => sa.agent.name.toLowerCase());

  let md = `---
name: cap-inventory
description: Current session agent capability inventory — available agents, their roles, and agentType values for task planning
---

# Agent Capability Inventory

> Last updated by AgentHub at ${now}
> Total agents: ${sessionAgents.length}

## Agents

`;

  for (const sa of sessionAgents) {
    const caps = sa.agent.capabilities as Record<string, unknown> | null;
    md += `### ${sa.agent.displayName} (\`${sa.agent.name}\`)\n`;
    md += `- **ID**: ${sa.agentId}\n`;
    md += `- **Role**: ${sa.agent.description || 'No description'}\n`;
    if (caps?.allowedTools) {
      md += `- **Capabilities**: ${Array.isArray(caps.allowedTools) ? caps.allowedTools.join(', ') : 'All'}\n`;
    }
    md += `- **agentType for plan**: \`${sa.agent.name.toLowerCase()}\`\n\n`;
  }

  md += `---

## Schema Reference

When creating tasks, agentType MUST be one of:
${agentTypes.map((t: string) => `- \`${t}\``).join('\n')}

DO NOT append session IDs or suffixes to agentType.
`;

  return md;
}
