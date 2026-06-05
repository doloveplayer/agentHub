import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { spawnOpenCodeInDocker } from '../OpenCodeContainer.js';
import { OpenCodeEventParser } from '../OpenCodeEventParser.js';

export class OpenCodeProvider implements AbstractProvider {
  readonly name = 'opencode';
  readonly capabilities = {
    persistentSession: true,    // --session <id> native support
    permissionProxy: true,      // --dangerously-skip-permissions
    streamingOutput: true,      // NDJSON stdout
    independentMemory: true,    // OpenCode session isolation
    independentConfig: true,
  };

  private handlers: EventHandler[] = [];
  private killed = false;
  private openCodeSessionId: string | undefined;
  private currentContainerId = '';
  private currentHostSandboxDir = '';
  private currentTrustMode = true;
  private currentModel: string | undefined;
  private currentBaseUrl: string | undefined;
  private childProc: import('child_process').ChildProcess | null = null;
  private pendingCleanup: (() => void) | null = null;
  private partialLine = '';
  private runSeq = 0;
  private eventParser = new OpenCodeEventParser();
  private onSessionIdChange?: (sessionId: string) => void;

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    this.emit({ type: 'done', exitCode, timestamp: Date.now() });
  }

  getAgentHome(): string {
    return '/workspace';
  }

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
    this.currentContainerId = containerId;
    this.currentHostSandboxDir =
      config.hostSandboxDir || config.hostWorkDir || _workDir;
    this.currentTrustMode = config.trustMode ?? true;
    this.currentModel = config.model;
    this.currentBaseUrl = config.baseUrl;

    return this.runInContainer(prompt, undefined);
  }

  sendPrompt(prompt: string): void {
    if (this.killed) return;

    // Kill the previous in-flight docker exec so only one runs at a time.
    this.stopChild();

    this.runInContainer(prompt, this.openCodeSessionId).catch((err) => {
      console.error(`[opencode:sendPrompt] ${err.message}`);
    });
  }

  private async runInContainer(
    prompt: string,
    resumeSession?: string,
  ): Promise<void> {
    this.partialLine = '';
    this.pendingCleanup = null;
    this.eventParser.reset();

    // Inject platform marker so the agent can identify its runtime provider.
    // Both Claude Code and OpenCode may use DeepSeek as the underlying model,
    // so without this marker the agent cannot distinguish between them.
    const platformPrompt = `\n[System: You are running on the OpenCode platform.]\n${prompt}`;

    const { proc, cleanup }= spawnOpenCodeInDocker({
      containerId: this.currentContainerId,
      prompt: platformPrompt,
      hostSandboxDir: this.currentHostSandboxDir,
      trustMode: this.currentTrustMode,
      baseUrl: this.currentBaseUrl,
      model: this.currentModel,
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
          const events = this.eventParser.parseLine(line);
          for (const event of events) {
            // Capture session ID from parser after step_start is processed
            const sid = this.eventParser.getSessionId();
            if (sid && sid !== this.openCodeSessionId) {
              this.openCodeSessionId = sid;
              this.onSessionIdChange?.(sid);
            }
            this.emit(event);
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        if (runId !== this.runSeq) return;
        const msg = chunk.toString().trim();
        if (msg) {
          console.log(`[opencode:stderr] ${msg.slice(0, 500)}`);
        }
      });

      proc.on('close', (code) => {
        if (runId !== this.runSeq) return;
        cleanup();
        this.childProc = null;
        this.pendingCleanup = null;
        if (!this.killed) {
          // Process any remaining partial line
          if (this.partialLine.trim()) {
            const events = this.eventParser.parseLine(this.partialLine);
            for (const event of events) {
              if (event.type !== 'done') this.emit(event);
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
          this.emit({
            type: 'error',
            message: `docker exec error: ${err.message}`,
            timestamp: Date.now(),
          });
          this.emitDone(1);
          resolve();
        }
      });
    });
  }

  /** Kill current in-flight docker exec without stopping the provider. */
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
