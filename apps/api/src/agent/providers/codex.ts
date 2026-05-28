import { Codex, type Thread, type ThreadEvent } from '@openai/codex-sdk';
import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';

function threadEventToUnified(event: ThreadEvent): UnifiedAgentEvent | null {
  const base = { timestamp: Date.now() };
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      switch (item.type) {
        case 'agent_message':
          return { ...base, type: 'thinking', content: item.text };
        case 'reasoning':
          return { ...base, type: 'thinking', content: `[Reasoning] ${item.text}` };
        case 'command_execution':
          if (event.type === 'item.started') {
            return { ...base, type: 'tool_use', toolName: 'Bash', toolInput: { command: item.command } };
          }
          if (event.type === 'item.completed') {
            return { ...base, type: 'tool_result', content: item.aggregated_output };
          }
          return null;
        case 'file_change':
          if (event.type === 'item.completed') {
            const paths = (item.changes as any[]).map((c: any) => `${c.kind} ${c.path}`).join(', ');
            return { ...base, type: 'tool_result', content: `File changes: ${paths} — ${item.status}` };
          }
          return null;
        case 'mcp_tool_call':
          if (event.type === 'item.started') {
            return { ...base, type: 'tool_use', toolName: item.tool, toolInput: item.arguments as Record<string, unknown> };
          }
          if (event.type === 'item.completed' && item.result) {
            return { ...base, type: 'tool_result', content: JSON.stringify(item.result) };
          }
          return null;
        case 'web_search':
          if (event.type === 'item.started') {
            return { ...base, type: 'tool_use', toolName: 'WebSearch', toolInput: { query: item.query } };
          }
          return null;
        case 'error':
          return { ...base, type: 'error', message: item.message };
        default:
          return null;
      }
    }
    case 'turn.completed':
      return { ...base, type: 'done', exitCode: 0 };
    case 'turn.failed':
      return { ...base, type: 'error', message: event.error.message };
    case 'error':
      return { ...base, type: 'error', message: event.message };
    default:
      return null; // thread.started, turn.started — no user-visible event
  }
}

export class CodexProvider implements AbstractProvider {
  readonly name = 'codex';
  readonly capabilities = {
    persistentSession: true,      // resumeThread(id) — native session persistence
    permissionProxy: true,        // approvalPolicy controls permissions
    streamingOutput: true,
    independentMemory: true,      // Thread isolates conversation context
    independentConfig: true,
  };

  private handlers: EventHandler[] = [];
  private sdk: Codex | null = null;
  private thread: Thread | null = null;
  private killed = false;
  private threadId: string | undefined;
  private currentWorkDir = '/workspace';

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  getAgentHome(): string { return this.currentWorkDir; }

  isAlive(): boolean { return !this.killed && this.thread !== null; }

  updateTrustMode(_mode: boolean): void {
    // Codex uses approvalPolicy, not trustMode
  }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.killed = false;
    this.currentWorkDir = config.hostWorkDir || workDir;

    this.sdk = new Codex({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseUrl: config.baseUrl,
    });

    const sandboxMode = config.trustMode ? 'workspace-write' as const : 'read-only' as const;
    const approvalPolicy = 'on-request' as const;

    const threadOptions = {
      model: config.model,
      sandboxMode,
      workingDirectory: config.hostWorkDir || workDir,
      approvalPolicy,
    };

    // Resume existing thread or start new
    this.thread = this.threadId
      ? this.sdk.resumeThread(this.threadId, threadOptions)
      : this.sdk.startThread(threadOptions);

    // Capture thread ID from the first event for future resume
    this.threadId = (this.thread as any).id || undefined;

    try {
      const { events } = await this.thread.runStreamed(prompt);
      for await (const event of events) {
        if (this.killed) break;
        // Capture thread ID on first event
        if (event.type === 'thread.started') {
          this.threadId = (event as any).thread_id;
        }
        const unified = threadEventToUnified(event);
        if (unified) this.emit(unified);
      }
    } catch (err: any) {
      if (!this.killed) {
        this.emit({ type: 'error', message: `Codex error: ${err.message}`, timestamp: Date.now() });
      }
    }
  }

  sendPrompt(prompt: string): void {
    // For follow-up messages, we need to start a new runStreamed
    if (!this.thread || this.killed) return;
    this.thread.runStreamed(prompt).then(({ events }) => {
      (async () => {
        for await (const event of events) {
          if (this.killed) break;
          const unified = threadEventToUnified(event);
          if (unified) this.emit(unified);
        }
      })();
    }).catch((err: any) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: `Codex error: ${err.message}`, timestamp: Date.now() });
      }
    });
  }

  write(_input: string): void {
    // Codex doesn't support stdin writing
  }

  stop(): void {
    this.killed = true;
    this.sdk = null;
    this.thread = null;
  }

  stopChild(): void {
    this.stop();
  }
}
