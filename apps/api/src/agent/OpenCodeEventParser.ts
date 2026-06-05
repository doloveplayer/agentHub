import type { UnifiedAgentEvent } from './providers/base.js';

interface OpenCodeEvent {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: {
    id: string;
    messageID: string;
    sessionID: string;
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    reason?: string;
    tokens?: {
      total: number;
      input: number;
      output: number;
      reasoning: number;
      cache: { write: number; read: number };
    };
    cost?: number;
    state?: {
      status: string;
      input: Record<string, unknown>;
      output: string;
      metadata?: Record<string, unknown>;
      title?: string;
      time?: { start: number; end: number };
    };
    time?: { start: number; end: number };
  };
  error?: {
    name: string;
    data?: {
      message?: string;
      statusCode?: number;
    };
  };
}

/**
 * Parses NDJSON lines from `opencode run --format json` stdout
 * into provider-agnostic UnifiedAgentEvent objects.
 *
 * One instance per provider invocation — not shared across concurrent runs.
 */
export class OpenCodeEventParser {
  private sessionId: string | null = null;

  /** Reset parser state for a new `opencode run` invocation. */
  reset(): void {
    this.sessionId = null;
  }

  /** Get the captured session ID for `--session <id>` resume on follow-up turns. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Parse one NDJSON line from opencode stdout.
   * Returns zero or more UnifiedAgentEvent objects.
   * - step_start: captures sessionID, no UI event emitted
   * - text: emits thinking
   * - tool_use: emits tool_use + tool_result (two events from one line)
   * - step_finish: emits token_usage
   * - error: emits error
   */
  parseLine(rawLine: string): UnifiedAgentEvent[] {
    const trimmed = rawLine.trim();
    if (!trimmed) return [];

    let event: OpenCodeEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON line — surface as thinking text so it's visible in logs
      return [{ type: 'thinking', content: trimmed, timestamp: Date.now() }];
    }

    if (!event || typeof event !== 'object' || !event.type) {
      return [];
    }

    const base: Pick<UnifiedAgentEvent, 'timestamp'> = {
      timestamp: event.timestamp || Date.now(),
    };

    switch (event.type) {
      case 'step_start': {
        if (event.sessionID) {
          this.sessionId = event.sessionID;
        }
        if (event.part?.sessionID) {
          this.sessionId = event.part.sessionID;
        }
        return [];
      }

      case 'text': {
        const content = event.part?.text;
        if (!content) return [];
        return [{ ...base, type: 'thinking', content }];
      }

      case 'tool_use': {
        if (!event.part || event.part.type !== 'tool') return [];
        const toolName = event.part.tool || 'unknown';
        const toolInput = (event.part.state?.input ?? {}) as Record<string, unknown>;
        const toolOutput = event.part.state?.output ?? '';

        return [
          {
            ...base,
            type: 'tool_use',
            toolName,
            toolInput,
            content: event.part.state?.title,
          },
          {
            ...base,
            type: 'tool_result',
            content: toolOutput,
          },
        ];
      }

      case 'step_finish': {
        if (!event.part?.tokens) return [];
        const t = event.part.tokens;
        return [
          {
            ...base,
            type: 'token_usage',
            inputTokens: t.input,
            outputTokens: t.output,
          },
        ];
      }

      case 'error': {
        const message =
          event.error?.data?.message ??
          event.error?.name ??
          'Unknown OpenCode error';
        return [{ ...base, type: 'error', message }];
      }

      default:
        // Unknown event types — ignore silently
        return [];
    }
  }
}
