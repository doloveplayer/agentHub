import { prisma } from '../db/prisma.js';

/**
 * Build group context CLAUDE.md snippet for a session.
 * Returns empty string for solo sessions (no group context needed).
 */
export async function buildGroupContext(sessionId: string, sessionTitle: string): Promise<string> {
  const sessionAgents = await prisma.sessionAgent.findMany({
    where: { sessionId },
    include: { agent: { select: { name: true, displayName: true, description: true } } },
  });

  if (sessionAgents.length <= 1) return ''; // solo session — no group context needed

  const memberList = sessionAgents
    .map((sa) => `- **${sa.agent.displayName}** (\`${sa.agent.name}\`): ${sa.agent.description}`)
    .join('\n');

  return `\n## Group Chat Context\n
You are participating in a group chat session: **"${sessionTitle}"**.

### Team Members
${memberList}

### Coordination Rules
- You are one of multiple agents collaborating in this session.
- Other agents may send you messages via the inbox system — check for new messages at the start of each turn.
- When you complete a task or make important changes, other agents will be notified automatically.
- If you need help from another agent, you can request it — the hub will route your request.
- Stay focused on your role as described in your system prompt. Do not attempt tasks that belong to other agents unless explicitly asked.

### Current Session
- Session title (topic): **"${sessionTitle}"**
- This title reflects the current goal. If it changes, you will be notified.\n`;
}
