import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { mapPermissionMode, mapAllowedTools } from '../ClaudeAgentSDK.js';
import { EventParser, type ParsedEvent } from '../EventParser.js';
import { spawnSDKInDocker } from '../SDKContainer.js';

function parsedToUnified(event: ParsedEvent): UnifiedAgentEvent | null {
  return EventParser.toUnified(event);
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
  private currentTrustMode = true;
  private currentAgentTag = '';
  private currentAgentConfigId: string | undefined;
  private childProc: import('child_process').ChildProcess | null = null;
  private pendingCleanup: (() => void) | null = null;
  private partialLine = '';
  private runSeq = 0;

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
    this.currentTrustMode = config.trustMode ?? true;
    this.currentAgentTag = config.agentName || 'agent';
    this.currentAgentConfigId = config.agentName;

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
    EventParser.resetDeltaState();

    const profile = this.currentTrustMode ? "bypass" : "read_only";

    const { proc, cleanup } = spawnSDKInDocker({
      containerId: this.currentContainerId,
      prompt,
      hostWorkDir: this.currentHostWorkDir,
      agentTag: this.currentAgentTag,
      agentConfigTag: this.currentAgentConfigId,
      permissionMode: mapPermissionMode(profile),
      allowedTools: mapAllowedTools(profile),
      resumeSession,
    });

    this.childProc = proc;
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
          const events = EventParser.parseLine(line);
          for (const event of events) {
            if (event.type === 'system' && event.sessionId) {
              this.claudeSessionId = event.sessionId;
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
            const events = EventParser.parseLine(this.partialLine);
            for (const event of events) {
              if (event.type === 'system' && event.sessionId) {
                this.claudeSessionId = event.sessionId;
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

    if (this.childProc) {
      try { this.childProc.kill('SIGTERM'); } catch { /* ignore */ }
      this.childProc = null;
    }
    if (this.pendingCleanup) {
      this.pendingCleanup();
      this.pendingCleanup = null;
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
