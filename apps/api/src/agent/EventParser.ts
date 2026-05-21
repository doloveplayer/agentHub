import type { UnifiedAgentEvent } from './providers/base.js';

export type ParsedEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; content: string }
  | { type: 'permission_request'; tool: string; path?: string }
  | { type: 'subagent_start'; agentType: string; description: string }
  | { type: 'subagent_result'; agentType: string }
  | { type: 'system'; subtype: string; message: string; sessionId?: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

interface StreamJsonLine {
  type: string;
  subtype?: string;
  message?: unknown;
  tool?: string;
  path?: string;
  agentType?: string;
  description?: string;
  name?: string;
  input?: Record<string, unknown>;
  exitCode?: number;
  is_error?: boolean;
  session_id?: string;
  tool_use?: { name: string; input: Record<string, unknown> };
  permission_request?: { tool: string; path?: string };
  subagent_start?: { agentType: string; description: string };
  subagent_result?: { agentType: string };
}

export class EventParser {
  // Guard against text duplication when Claude Code --verbose emits both
  // content_block_delta (streaming) and assistant (final) events.
  private static receivedDeltaText = false;
  static resetDeltaState(): void { EventParser.receivedDeltaText = false; }

  static parseLine(line: string): ParsedEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let data: StreamJsonLine;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Non-JSON lines → emit as plain text
      return { type: 'text', content: trimmed };
    }

    if (!data || typeof data !== 'object' || !data.type) {
      return null;
    }

    switch (data.type) {
      case 'assistant':
        return EventParser.parseAssistant(data);
      case 'content_block_start':
        return EventParser.parseContentBlockStart(data);
      case 'content_block_delta':
        return EventParser.parseContentBlockDelta(data);
      case 'content_block_stop':
        return null; // structural event, no content to emit
      case 'tool_use':
        return EventParser.parseToolUse(data);
      case 'tool_result':
        return EventParser.parseToolResult(data);
      case 'permission_request':
        return EventParser.parsePermissionRequest(data);
      case 'subagent_start':
        return EventParser.parseSubagentStart(data);
      case 'subagent_result':
        return EventParser.parseSubagentResult(data);
      case 'system':
        return EventParser.parseSystem(data);
      case 'result':
        return EventParser.parseResult(data);
      default:
        return null;
    }
  }

  private static parseAssistant(data: StreamJsonLine): ParsedEvent | null {
    const msg = data.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    const content = msg?.content;
    if (!content || !Array.isArray(content)) return null;

    // When delta events already streamed text, skip text extraction from
    // the final assistant event to avoid duplication. Still extract tool_use blocks.
    const skipText = EventParser.receivedDeltaText;

    if (!skipText) {
      const chunks: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          chunks.push(block.text);
        }
      }
      if (chunks.length > 0) {
        return { type: 'text', content: chunks.join('') };
      }
    }

    // Check for tool_use blocks embedded in assistant message content
    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolUseBlock = block as { type: 'tool_use'; name: string; input: Record<string, unknown> };
        if (toolUseBlock.name) {
          return {
            type: 'tool_use',
            toolName: toolUseBlock.name,
            input: toolUseBlock.input || {},
          };
        }
      }
    }

    return null;
  }

  private static parseContentBlockStart(data: StreamJsonLine): ParsedEvent | null {
    const cb = (data as any).content_block;
    if (cb && cb.type === 'tool_use' && cb.name) {
      return { type: 'tool_use', toolName: cb.name, input: cb.input || {} };
    }
    return null;
  }

  private static parseContentBlockDelta(data: StreamJsonLine): ParsedEvent | null {
    const delta = (data as any).delta;
    if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
      EventParser.receivedDeltaText = true;
      return { type: 'text', content: delta.text };
    }
    return null;
  }

  private static parseToolUse(data: StreamJsonLine): ParsedEvent | null {
    const tu = data.tool_use || data;
    const toolName = tu.name || (data as any).name || 'unknown';
    const input = tu.input || (data as any).input || {};
    return { type: 'tool_use', toolName, input };
  }

  private static parseToolResult(data: StreamJsonLine): ParsedEvent | null {
    const content =
      typeof (data as any).content === 'string'
        ? (data as any).content
        : typeof data.message === 'string'
          ? data.message
          : '';
    return { type: 'tool_result', content };
  }

  private static parsePermissionRequest(data: StreamJsonLine): ParsedEvent | null {
    const pr = data.permission_request || data;
    const tool = pr.tool || data.tool || '';
    const path = pr.path || data.path;
    if (!tool) return null;
    return { type: 'permission_request', tool, path };
  }

  private static parseSubagentStart(data: StreamJsonLine): ParsedEvent | null {
    const sa = data.subagent_start || data;
    const agentType = sa.agentType || data.agentType || '';
    const description = sa.description || data.description || '';
    return { type: 'subagent_start', agentType, description };
  }

  private static parseSubagentResult(data: StreamJsonLine): ParsedEvent | null {
    const sr = data.subagent_result || data;
    const agentType = sr.agentType || data.agentType || '';
    return { type: 'subagent_result', agentType };
  }

  private static parseSystem(data: StreamJsonLine): ParsedEvent | null {
    const subtype = data.subtype || '';
    const message = typeof data.message === 'string' ? data.message : '';
    const sessionId = data.session_id;
    return { type: 'system', subtype, message, sessionId };
  }

  private static parseResult(data: StreamJsonLine): ParsedEvent | null {
    if (data.subtype === 'success') {
      return { type: 'done', exitCode: data.is_error ? 1 : 0 };
    }
    return null;
  }

  /** Convert a parsed event to a unified provider-agnostic event */
  static toUnified(event: ParsedEvent): UnifiedAgentEvent | null {
    const base = { providerRaw: event, timestamp: Date.now() };
    switch (event.type) {
      case 'text':                return { ...base, type: 'thinking' as const, content: event.content };
      case 'tool_use':            return { ...base, type: 'tool_use' as const, toolName: event.toolName, toolInput: event.input };
      case 'tool_result':         return { ...base, type: 'tool_result' as const, content: event.content };
      case 'subagent_start':      return { ...base, type: 'subagent_start' as const, content: event.agentType };
      case 'subagent_result':     return { ...base, type: 'subagent_result' as const, content: event.agentType };
      case 'permission_request':  return { ...base, type: 'permission_request' as const, toolName: event.tool, filePath: event.path };
      case 'done':                return { ...base, type: 'done' as const, exitCode: event.exitCode };
      case 'error':               return { ...base, type: 'error' as const, message: event.message };
      case 'system':              return null; // system events handled by StateTracker
      default:                    return null;
    }
  }
}
