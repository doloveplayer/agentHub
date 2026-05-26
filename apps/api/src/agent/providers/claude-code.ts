import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { ClaudeAgentSDK, mapPermissionMode, mapAllowedTools, type SDKStreamOptions } from '../ClaudeAgentSDK.js';
import type { ParsedEvent } from '../EventParser.js';

function parsedToUnified(event: ParsedEvent): UnifiedAgentEvent | null {
  const base = { providerRaw: event, timestamp: Date.now() };
  switch (event.type) {
    case 'text': return { ...base, type: 'thinking' as const, content: event.content };
    case 'tool_use': return { ...base, type: 'tool_use' as const, toolName: event.toolName, toolInput: event.input };
    case 'tool_result': return { ...base, type: 'tool_result' as const, content: event.content };
    case 'subagent_start': return { ...base, type: 'subagent_start' as const, content: event.agentType };
    case 'subagent_result': return { ...base, type: 'subagent_result' as const, content: event.agentType };
    case 'permission_request': return { ...base, type: 'permission_request' as const, toolName: event.tool, filePath: event.path };
    case 'done': return { ...base, type: 'done' as const, exitCode: event.exitCode };
    case 'error': return { ...base, type: 'error' as const, message: event.message };
    case 'system': return null;
    default: return null;
  }
}

export class ClaudeCodeProvider implements AbstractProvider {
  readonly name = 'claude-code';
  readonly capabilities = {
    persistentSession: true,     // SDK resume = native session persistence
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private handlers: EventHandler[] = [];
  private sdk: ClaudeAgentSDK | null = null;
  private killed = false;
  private claudeSessionId: string | undefined;
  private currentCwd = '/workspace';
  private currentTrustMode = true;
  private agentHome = '/workspace';

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    this.emit({ type: 'done', exitCode, timestamp: Date.now() });
  }

  getAgentHome(): string { return this.agentHome; }

  isAlive(): boolean {
    return !this.killed && this.sdk !== null;
  }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.killed = false;
    const cwd = config.hostWorkDir || workDir;
    this.currentCwd = cwd;
    this.currentTrustMode = !config.apiKey; // trust mode when no explicit API key override
    this.agentHome = cwd;

    const profile = this.currentTrustMode ? "bypass" as const : "read_only" as const;

    this.sdk = new ClaudeAgentSDK();

    const sdkOptions: SDKStreamOptions = {
      cwd,
      permissionMode: mapPermissionMode(profile),
      allowedTools: mapAllowedTools(profile),
      model: config.model,
      persistSession: true,
      settingSources: ["user", "project"],
    };

    if (config.env) {
      sdkOptions.env = { ...process.env, ...config.env as Record<string, string | undefined> };
    }

    try {
      const result = await this.sdk.stream(prompt, sdkOptions, (event) => {
        if (event.type === "system" && event.sessionId) {
          this.claudeSessionId = event.sessionId;
        }
        // Forward permission requests as-is for the handler to intercept
        if (event.type === "permission_request") {
          this.emit({
            type: "permission_request",
            toolName: event.tool,
            filePath: event.path,
            timestamp: Date.now(),
          });
          return;
        }
        const unified = parsedToUnified(event);
        if (unified) this.emit(unified);
      });

      this.claudeSessionId = result.sessionId || this.claudeSessionId;

      if (!this.killed) {
        this.emitDone(result.exitCode);
      }
    } catch (error: any) {
      if (!this.killed) {
        this.emit({ type: 'error', message: error.message ?? String(error), timestamp: Date.now() });
        this.emitDone(1);
      }
    }
  }

  sendPrompt(prompt: string): void {
    if (this.killed) return;

    // Cancel previous in-flight stream to avoid concurrent session writes
    this.sdk?.kill();
    this.sdk = new ClaudeAgentSDK();
    const profile = this.currentTrustMode ? "bypass" as const : "read_only" as const;

    const sdkOptions: SDKStreamOptions = {
      cwd: this.currentCwd,
      resume: this.claudeSessionId,
      permissionMode: mapPermissionMode(profile),
      allowedTools: mapAllowedTools(profile),
      persistSession: true,
      settingSources: ["user", "project"],
    };

    this.sdk.stream(prompt, sdkOptions, (event) => {
      if (event.type === "system" && event.sessionId) {
        this.claudeSessionId = event.sessionId;
      }
      if (event.type === "permission_request") {
        this.emit({
          type: "permission_request",
          toolName: event.tool,
          filePath: event.path,
          timestamp: Date.now(),
        });
        return;
      }
      const unified = parsedToUnified(event);
      if (unified) this.emit(unified);
    }).then((result) => {
      this.claudeSessionId = result.sessionId || this.claudeSessionId;
      if (!this.killed) {
        this.emitDone(result.exitCode);
      }
    }).catch((error: any) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: error.message ?? String(error), timestamp: Date.now() });
        this.emitDone(1);
      }
    });
  }

  write(input: string): void {
    // Legacy compat: treat write as sendPrompt for permission reply
    // The SDK handles permissions natively, so this is a no-op for the SDK path
    if (input.trim()) {
      this.sendPrompt(input);
    }
  }

  stop(): void {
    this.killed = true;
    this.sdk?.kill();
    this.sdk = null;
  }
}
