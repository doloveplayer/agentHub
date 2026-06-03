import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { CommLogEntry, CommLogCategory } from '@agenthub/shared';
import { config } from '../config.js';

const SANDBOXES_ROOT = config.sandbox.root;

export class SessionCommLog {
  private static broadcastFn: ((sessionId: string, data: unknown) => void) | null = null;

  /** Inject the broadcast function (called once at startup). */
  static setBroadcast(fn: (sessionId: string, data: unknown) => void): void {
    SessionCommLog.broadcastFn = fn;
  }

  /** Log a communication event to the session's JSONL file + broadcast via WebSocket. */
  static log(
    sessionId: string,
    category: CommLogCategory,
    action: string,
    payload: Record<string, unknown>,
  ): void {
    const entry: CommLogEntry = {
      ts: Date.now(),
      category,
      action,
      sessionId,
      payload: SessionCommLog.truncatePayload(payload),
    };

    // Write to JSONL file
    try {
      const logDir = resolve(SANDBOXES_ROOT, sessionId);
      mkdirSync(logDir, { recursive: true });
      const logPath = resolve(logDir, '_comm_log.jsonl');
      appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err: any) {
      console.error(`[SessionCommLog] Failed to write log: ${err.message}`);
    }

    // Broadcast to connected clients
    if (SessionCommLog.broadcastFn) {
      try {
        SessionCommLog.broadcastFn(sessionId, { type: 'comm_log', entry });
      } catch { /* ignore broadcast failures */ }
    }
  }

  /** Read all log entries for a session. */
  static readAll(sessionId: string): CommLogEntry[] {
    const logPath = resolve(SANDBOXES_ROOT, sessionId, '_comm_log.jsonl');
    if (!existsSync(logPath)) return [];

    try {
      const raw = readFileSync(logPath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line) as CommLogEntry; }
          catch { return null; }
        })
        .filter((e): e is CommLogEntry => e !== null);
    } catch {
      return [];
    }
  }

  /** Truncate string values in payload to prevent log bloat. */
  private static truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.length > 300) {
        result[k] = v.slice(0, 300) + '…';
      } else {
        result[k] = v;
      }
    }
    return result;
  }
}
