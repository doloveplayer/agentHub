import type { UnifiedAgentEvent } from './providers/base.js';

export type ParsedEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; content: string }
  | { type: 'permission_request'; tool: string; path?: string }
  | { type: 'subagent_start'; agentType: string; description: string }
  | { type: 'subagent_result'; agentType: string }
  | { type: 'system'; subtype: string; message: string; sessionId?: string }
  | { type: 'token_usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }
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
  // Shared instance for static backward compatibility.
  // Tests and legacy code that don't need concurrent safety call the static methods.
  private static _shared = new EventParser();

  // Guard against text duplication when Claude Code --verbose emits both
  // content_block_delta (streaming) and assistant (final) events.
  private receivedDeltaText = false;
  // Accumulate tool input from content_block_delta chunks
  private pendingToolName: string | null = null;
  private pendingToolInputJson = '';
  private pendingToolInitialInput: Record<string, unknown> | null = null;

  // ---- Static backward-compat API (uses shared instance) ----

  static resetDeltaState(): void {
    EventParser._shared.reset();
  }

  static parseLine(line: string): ParsedEvent[] {
    return EventParser._shared.parseLine(line);
  }

  // ---- Instance API (concurrency-safe — one instance per provider) ----

  /** Reset all mutable state. Equivalent to the old static resetDeltaState(). */
  reset(): void {
    this.receivedDeltaText = false;
    this.pendingToolName = null;
    this.pendingToolInputJson = '';
    this.pendingToolInitialInput = null;
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let data: StreamJsonLine;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return [{ type: 'text', content: trimmed }];
    }

    if (!data || typeof data !== 'object' || !data.type) {
      return [];
    }

    switch (data.type) {
      case 'assistant':
        return this.parseAssistant(data);
      case 'content_block_start':
        return this.parseContentBlockStart(data);
      case 'content_block_delta':
        return this.parseContentBlockDelta(data);
      case 'content_block_stop':
        return this.parseContentBlockStop();
      case 'tool_use':
        return this.parseToolUse(data);
      case 'tool_result':
        return this.parseToolResult(data);
      case 'stream_event':
        return this.parseStreamEvent(data);
      case 'permission_request':
        return this.parsePermissionRequest(data);
      case 'subagent_start':
        return this.parseSubagentStart(data);
      case 'subagent_result':
        return this.parseSubagentResult(data);
      case 'system':
        return this.parseSystem(data);
      case 'result':
        return this.parseResult(data);
      default:
        return [];
    }
  }

  private parseAssistant(data: StreamJsonLine): ParsedEvent[] {
    const msg = data.message as {
      content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    } | undefined;
    const content = msg?.content;
    const events: ParsedEvent[] = [];

    // Extract token usage from SDK assistant message
    if (msg?.usage) {
      events.push({
        type: 'token_usage',
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheCreateTokens: msg.usage.cache_creation_input_tokens ?? 0,
      });
    }

    if (!content || !Array.isArray(content)) return events;

    const skipText = this.receivedDeltaText;

    if (!skipText) {
      const chunks: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          chunks.push(block.text);
        }
      }
      if (chunks.length > 0) {
        events.push({ type: 'text', content: chunks.join('') });
      }
    }

    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        events.push({
          type: 'tool_use',
          toolName: block.name,
          input: block.input || {},
        });
      }
    }

    return events;
  }

  private parseContentBlockStart(data: StreamJsonLine): ParsedEvent[] {
    const cb = (data as any).content_block;
    if (cb && cb.type === 'tool_use' && cb.name) {
      // Don't emit yet — SDK streams tool input via subsequent content_block_delta events.
      // Accumulate and emit on content_block_stop instead.
      this.pendingToolName = cb.name;
      this.pendingToolInputJson = '';
      this.pendingToolInitialInput = cb.input && Object.keys(cb.input).length > 0 ? cb.input : null;
      return [];
    }
    return [];
  }

  /** SDK emits stream_event wrapping content_block_start / content_block_delta / content_block_stop */
  private parseStreamEvent(data: StreamJsonLine): ParsedEvent[] {
    const evt = (data as any).event;
    if (!evt) return [];
    if (evt.type === 'content_block_start') {
      return this.parseContentBlockStart({ ...data, content_block: evt.content_block } as any);
    }
    if (evt.type === 'content_block_delta') {
      return this.parseContentBlockDelta({ ...data, delta: evt.delta } as any);
    }
    if (evt.type === 'content_block_stop') {
      return this.parseContentBlockStop();
    }
    return [];
  }

  private parseContentBlockDelta(data: StreamJsonLine): ParsedEvent[] {
    const delta = (data as any).delta;
    if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
      this.receivedDeltaText = true;
      return [{ type: 'text', content: delta.text }];
    }
    // Accumulate tool input JSON chunks
    if (delta && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      this.pendingToolInputJson += delta.partial_json;
    }
    return [];
  }

  /** Emit accumulated tool_use event when content_block completes. */
  private parseContentBlockStop(): ParsedEvent[] {
    if (!this.pendingToolName) return [];
    const toolName = this.pendingToolName;
    let input: Record<string, unknown> = this.pendingToolInitialInput || {};

    // Merge accumulated JSON deltas over initial input (they are complementary, not exclusive)
    if (this.pendingToolInputJson) {
      try {
        const deltaInput = JSON.parse(this.pendingToolInputJson);
        input = { ...input, ...deltaInput };
      } catch (err: any) {
        console.error(`[EventParser] Failed to parse pending tool input JSON for "${toolName}":`, err?.message ?? err, 'raw:', this.pendingToolInputJson.slice(0, 200));
        if (Object.keys(input).length === 0) {
          input = { _raw: this.pendingToolInputJson.slice(0, 200) };
        }
      }
    }

    // Reset pending state
    this.pendingToolName = null;
    this.pendingToolInputJson = '';
    this.pendingToolInitialInput = null;

    return [{ type: 'tool_use', toolName, input }];
  }

  private parseToolUse(data: StreamJsonLine): ParsedEvent[] {
    const tu = data.tool_use || data;
    const toolName = tu.name || (data as any).name || 'unknown';
    const input = tu.input || (data as any).input || {};
    return [{ type: 'tool_use', toolName, input }];
  }

  private parseToolResult(data: StreamJsonLine): ParsedEvent[] {
    const content =
      typeof (data as any).content === 'string'
        ? (data as any).content
        : typeof data.message === 'string'
          ? data.message
          : '';
    return [{ type: 'tool_result', content }];
  }

  private parsePermissionRequest(data: StreamJsonLine): ParsedEvent[] {
    const pr = data.permission_request || data;
    const tool = pr.tool || data.tool || '';
    const path = pr.path || data.path;
    if (!tool) return [];
    return [{ type: 'permission_request', tool, path }];
  }

  private parseSubagentStart(data: StreamJsonLine): ParsedEvent[] {
    const sa = data.subagent_start || data;
    const agentType = sa.agentType || data.agentType || '';
    const description = sa.description || data.description || '';
    return [{ type: 'subagent_start', agentType, description }];
  }

  private parseSubagentResult(data: StreamJsonLine): ParsedEvent[] {
    const sr = data.subagent_result || data;
    const agentType = sr.agentType || data.agentType || '';
    return [{ type: 'subagent_result', agentType }];
  }

  private parseSystem(data: StreamJsonLine): ParsedEvent[] {
    const subtype = data.subtype || '';
    const message = typeof data.message === 'string' ? data.message : '';
    const sessionId = data.session_id;
    return [{ type: 'system', subtype, message, sessionId }];
  }

  private parseResult(data: StreamJsonLine): ParsedEvent[] {
    if (data.subtype === 'success') {
      return [{ type: 'done', exitCode: data.is_error ? 1 : 0 }];
    }
    return [];
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
      case 'permission_request':  return { ...base, type: 'permission_request' as const, tool: event.tool, path: event.path };
      case 'done':                return { ...base, type: 'done' as const, exitCode: event.exitCode };
      case 'error':               return { ...base, type: 'error' as const, message: event.message };
      case 'token_usage':          return { ...base, type: 'token_usage' as const, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheCreateTokens: event.cacheCreateTokens };
      case 'system':              return null; // system events handled by StateTracker
      default:                    return null;
    }
  }
}
