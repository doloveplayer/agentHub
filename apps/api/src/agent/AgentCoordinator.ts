import { permissionProfiles, type PermissionCheckResult } from './PermissionProfiles.js';
import { eventRoutingRules } from './EventRoutingRules.js';
import { InboxManager } from './InboxManager.js';
import type { ParsedEvent } from './EventParser.js';

export interface CoordinationContext {
  sessionId: string;
  agentName: string;
  agentType: string;
  messageId: string;
  hostWorkDir: string;
  resolveAgent: (agentType: string) => string | null;
  broadcast: (sessionId: string, data: unknown) => void;
}

export class AgentCoordinator {
  onToolUse(ctx: CoordinationContext, event: ParsedEvent & { type: 'tool_use' }): PermissionCheckResult {
    const filePath = event.input?.file_path || event.input?.path || event.input?.filePath;
    const filePathStr = typeof filePath === 'string' ? filePath : undefined;

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
          }, ctx.sessionId);
        }
      }

      return check;
    }

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
        InboxManager.write(ctx.hostWorkDir, targetAgentName, entry, ctx.sessionId);
      }
    }

    return check;
  }

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
        InboxManager.write(ctx.hostWorkDir, targetAgentName, entry, ctx.sessionId);
      }
    }
  }

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
        InboxManager.write(ctx.hostWorkDir, targetAgentName, entry, ctx.sessionId);
      }
    }

    ctx.broadcast(ctx.sessionId, {
      type: 'inbox_update',
      agentName: ctx.agentName,
      agentType: ctx.agentType,
      timestamp: Date.now(),
    });
  }

  buildCoordinationPrompt(ctx: CoordinationContext): string {
    const prompt = InboxManager.hubModePrompt(ctx.agentName);

    const entries = InboxManager.read(ctx.hostWorkDir, ctx.agentName, ctx.sessionId);
    if (entries.length === 0) return prompt;

    const highRisk = entries.filter((e) => e.risk === 'high');
    const lowRisk = entries.filter((e) => e.risk === 'low');

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
}

export const agentCoordinator = new AgentCoordinator();
