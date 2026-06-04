import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { mapPermissionMode, mapAllowedTools, type AgentPermissionProfile } from '../ClaudeAgentSDK.js';
import { EventParser, type ParsedEvent } from '../EventParser.js';
import { spawnSDKInDocker } from '../SDKContainer.js';

function parsedToUnified(event: ParsedEvent): UnifiedAgentEvent | null {
  return EventParser.toUnified(event);
}

/** Map session permission mode + trustMode boolean to SDK permission profile. */
function resolvePermissionProfile(trustMode: boolean, sessionPermMode: string): AgentPermissionProfile {
  if (trustMode) return "bypass";             // trust / smart → all tools, no prompts
  if (sessionPermMode === "read_only") return "read_only"; // only Read/Grep/Glob/Bash
  return "default";                            // ask → all tools, prompt for mutating ops
}

export class ClaudeCodeProvider implements AbstractProvider {
  readonly name = 'claude-code';
  readonly capabilities = {
    persistentSession: true,
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private handlers: EventHandler[] = [];
  private killed = false;
  private claudeSessionId: string | undefined;
  private currentContainerId = '';
  private currentHostWorkDir = '';
  private currentHostSandboxDir = '';
  private currentTrustMode = true;
  private sessionPermissionMode = 'trust';
  private currentAgentTag = '';
  private currentAgentConfigId: string | undefined;
  private currentAgentHomeDir = '';
  private currentModel: string | undefined;
  private childProc: import('child_process').ChildProcess | null = null;
  private stdinRef: import('stream').Writable | null = null;
  private pendingCleanup: (() => void) | null = null;
  private partialLine = '';
  private runSeq = 0;
  private eventParser: EventParser = new EventParser();
  private onSessionIdChange?: (sessionId: string) => void;

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    this.emit({ type: 'done', exitCode, timestamp: Date.now() });
  }

  getAgentHome(): string { return '/workspace'; }

  isAlive(): boolean {
    return !this.killed && this.childProc !== null;
  }

  setSessionIdCallback(cb: (sessionId: string) => void): void {
    this.onSessionIdChange = cb;
  }

  updateTrustMode(mode: boolean): void {
    this.currentTrustMode = mode;
  }

  async start(
    _sessionId: string,
    prompt: string,
    containerId: string,
    _workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.killed = false;
    const hostWorkDir = config.hostWorkDir || _workDir;
    this.currentContainerId = containerId;
    this.currentHostWorkDir = hostWorkDir;
    this.currentHostSandboxDir = config.hostSandboxDir || hostWorkDir;
    this.currentTrustMode = config.trustMode ?? true;
    this.sessionPermissionMode = config.sessionPermissionMode || 'trust';
    this.currentAgentTag = config.agentName || 'agent';
    this.currentAgentConfigId = config.agentName;
    this.currentAgentHomeDir = config.agentHomeDir || '';
    this.currentModel = config.model;

    return this.runInContainer(prompt, undefined);
  }

  sendPrompt(prompt: string): void {
    if (this.killed) return;

    // Kill previous in-flight exec but preserve the killed flag — stop()
    // is the terminal operation.
    this.stopChild();

    this.runInContainer(prompt, this.claudeSessionId).catch((err) => {
      console.error(`[claude-code:sendPrompt] ${err.message}`);
    });
  }

  private async runInContainer(prompt: string, resumeSession?: string): Promise<void> {
    this.partialLine = '';
    this.pendingCleanup = null;
    this.eventParser.reset();

    // Map session permission mode to SDK permission profile.
    // trust/smart → bypass (all tools, no prompts)
    // ask → default (all tools, prompt for mutating operations)
    // read_only → read_only (only Read/Grep/Glob/Bash, no Write/Edit)
    const profile = resolvePermissionProfile(this.currentTrustMode, this.sessionPermissionMode);

    const { proc, cleanup } = spawnSDKInDocker({
      containerId: this.currentContainerId,
      prompt,
      hostWorkDir: this.currentHostWorkDir,
      hostSandboxDir: this.currentHostSandboxDir,
      agentHomeDir: this.currentAgentHomeDir,
      agentTag: this.currentAgentTag,
      agentConfigTag: this.currentAgentConfigId,
      permissionMode: mapPermissionMode(profile),
      allowedTools: mapAllowedTools(profile),
      resumeSession,
      model: this.currentModel,
    });

    this.childProc = proc;
    this.stdinRef = proc.stdin!;
    this.pendingCleanup = cleanup;
    const runId = ++this.runSeq;

    return new Promise<void>((resolve) => {
      proc.stdout!.on('data', (chunk: Buffer) => {
        if (this.killed || runId !== this.runSeq) return;
        this.partialLine += chunk.toString();
        const lines = this.partialLine.split('\n');
        this.partialLine = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const events = this.eventParser.parseLine(line);
          for (const event of events) {
            if (event.type === 'system' && event.sessionId) {
              this.claudeSessionId = event.sessionId;
              if (this.onSessionIdChange) {
                this.onSessionIdChange(event.sessionId);
              }
            }
            const unified = parsedToUnified(event);
            if (unified) this.emit(unified);
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        if (runId !== this.runSeq) return;
        const msg = chunk.toString().trim();
        if (msg && !msg.includes('WARNING:')) {
          console.log(`[claude-code:stderr] ${msg.slice(0, 500)}`);
        }
      });

      proc.on('close', (code) => {
        if (runId !== this.runSeq) return;
        cleanup();
        this.childProc = null;
        this.pendingCleanup = null;
        if (!this.killed) {
          if (this.partialLine.trim()) {
            const events = this.eventParser.parseLine(this.partialLine);
            for (const event of events) {
              if (event.type === 'system' && event.sessionId) {
                this.claudeSessionId = event.sessionId;
                if (this.onSessionIdChange) {
                  this.onSessionIdChange(event.sessionId);
                }
              }
              const unified = parsedToUnified(event);
              if (unified && unified.type !== 'done') this.emit(unified);
            }
          }
          this.emitDone(code ?? 1);
          resolve();
        }
      });

      proc.on('error', (err) => {
        if (runId !== this.runSeq) return;
        cleanup();
        if (!this.killed) {
          this.emit({ type: 'error', message: `docker exec error: ${err.message}`, timestamp: Date.now() });
          this.emitDone(1);
          resolve();
        }
      });
    });
  }

  /** Kill current in-flight docker exec without killing the provider. */
  stopChild(): void {
    this.stdinRef = null;
    if (this.childProc) {
      try { this.childProc.kill('SIGTERM'); } catch { /* ignore */ }
      this.childProc = null;
    }
    if (this.pendingCleanup) {
      this.pendingCleanup();
      this.pendingCleanup = null;
    }
  }

  /** Write a permission response to the SDK runner's stdin. */
  respondToPermission(permissionId: string, allowed: boolean): void {
    const stdin = this.stdinRef;
    if (!stdin) return;
    try {
      stdin.write(JSON.stringify({ permissionId, allowed }) + '\n');
    } catch {
      // Pipe may be closed — ignore
    }
  }

  /** Write a control_response to the SDK's stdin for the native control_request protocol. */
  respondControlRequest(requestId: string, allowed: boolean): void {
    const stdin = this.stdinRef;
    if (!stdin) return;
    try {
      const response = allowed
        ? { type: 'control_response', response: { subtype: 'success', request_id: requestId } }
        : { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'User denied permission' } };
      stdin.write(JSON.stringify(response) + '\n');
    } catch {
      // Pipe may be closed — ignore
    }
  }

  write(input: string): void {
    if (input.trim()) {
      this.sendPrompt(input);
    }
  }

  stop(): void {
    this.killed = true;
    this.stopChild();
  }
}
