import { config } from '../config.js';
import { EventParser, type ParsedEvent } from './EventParser.js';
import { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import { TestAgentProcess } from './TestAgentProcess.js';
import { spawnSDKInDocker } from './SDKContainer.js';

export interface OneShotAgentProcess {
  onClaudeSession?: (sessionId: string) => void;
  onEvent(handler: (event: ParsedEvent) => void): void;
  start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    trustMode?: boolean,
    hostWorkDir?: string,
    promptFileId?: string,
    claudeSessionId?: string,
    agentConfigId?: string,
    hostSandboxDir?: string,
  ): Promise<void>;
  write(input: string): void;
  kill(): void;
}

export function createOneShotAgentProcess(): OneShotAgentProcess {
  if (config.agent.provider === "test") {
    return new TestAgentProcess();
  }
  if (config.agent.provider === "claude-code") {
    return new ClaudeCodeProcess(); // default: CLI spawn (always available)
  }
  throw new Error(`Unknown one-shot agent provider: ${config.agent.provider}`);
}

/**
 * Creates an SDK-backed process running inside the sandbox Docker container.
 * Returns null if SDK is unavailable. Callers fall back to createOneShotAgentProcess().
 */
export async function createSDKAgentProcess(): Promise<OneShotAgentProcess | null> {
  if (config.agent.provider === "test") return new TestAgentProcess();
  try {
    const { mapPermissionMode, mapAllowedTools } = await import("./ClaudeAgentSDK.js");
    return new ClaudeSDKDockerProcess({ mapPermissionMode, mapAllowedTools });
  } catch {
    console.log("[processFactory] Claude Agent SDK not available, falling back to CLI spawn");
    return null;
  }
}

class ClaudeSDKDockerProcess implements OneShotAgentProcess {
  private handlers: Array<(event: ParsedEvent) => void> = [];
  private _onClaudeSession: ((sessionId: string) => void) | undefined;
  private killed = false;
  private childProc: import('child_process').ChildProcess | null = null;
  private pendingCleanup: (() => void) | null = null;
  private partialLine = '';
  private runSeq = 0;
  private doneReceived = false;  // guard against double-done (SDK result + close handler)
  private eventParser: EventParser = new EventParser();
  private mapPermissionMode: (profile: string) => any;
  private mapAllowedTools: (profile: string) => string[];

  constructor(deps: { mapPermissionMode: (profile: any) => any; mapAllowedTools: (profile: any) => string[] }) {
    this.mapPermissionMode = deps.mapPermissionMode;
    this.mapAllowedTools = deps.mapAllowedTools;
  }

  get onClaudeSession(): ((sessionId: string) => void) | undefined {
    return this._onClaudeSession;
  }
  set onClaudeSession(fn: ((sessionId: string) => void) | undefined) {
    this._onClaudeSession = fn;
  }

  onEvent(handler: (event: ParsedEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(event: ParsedEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  async start(
    sessionId: string,
    prompt: string,
    containerId: string,
    _workDir: string,
    trustMode?: boolean,
    hostWorkDir?: string,
    promptFileId?: string,
    claudeSessionId?: string,
    agentConfigId?: string,
    hostSandboxDir?: string,
  ): Promise<void> {
    this.killed = false;
    this.doneReceived = false;
    this.partialLine = '';
    this.pendingCleanup = null;
    this.eventParser.reset();

    const hwDir = hostWorkDir || _workDir;
    const sbDir = hostSandboxDir || hwDir;
    const agentTag = promptFileId || 'agent';
    const profile = trustMode ? "bypass" : "read_only";

    const { proc, cleanup } = spawnSDKInDocker({
      containerId,
      prompt,
      hostWorkDir: hwDir,
      hostSandboxDir: sbDir,
      agentTag,
      agentConfigTag: agentConfigId,
      permissionMode: this.mapPermissionMode(profile),
      allowedTools: this.mapAllowedTools(profile),
      resumeSession: claudeSessionId,
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
          const events = this.eventParser.parseLine(line);
          for (const event of events) {
            if (event.type === 'system' && event.sessionId && this._onClaudeSession) {
              this._onClaudeSession(event.sessionId);
            }
            if (event.type === 'done') this.doneReceived = true;
            this.emit(event);
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        if (runId !== this.runSeq) return;
        const msg = chunk.toString().trim();
        if (msg) console.log(`[sdk-docker:stderr] ${msg.slice(0, 500)}`);
      });

      proc.on('close', (code) => {
        if (runId !== this.runSeq) return;
        cleanup();
        this.childProc = null;
        this.pendingCleanup = null;
        if (!this.killed) {
          // Flush remaining partial line
          if (this.partialLine.trim()) {
            const events = this.eventParser.parseLine(this.partialLine);
            for (const event of events) {
              if (event.type === 'system' && event.sessionId && this._onClaudeSession) {
                this._onClaudeSession(event.sessionId);
              }
              if (event.type === 'done') this.doneReceived = true;
              if (event.type !== 'done') this.emit(event);
            }
          }
          if (!this.doneReceived) {
            this.emit({ type: 'done', exitCode: code ?? 1 });
          }
          resolve();
        }
      });

      proc.on('error', (err) => {
        if (runId !== this.runSeq) return;
        cleanup();
        if (!this.killed) {
          this.emit({ type: 'error', message: `docker exec error: ${err.message}` });
          this.emit({ type: 'done', exitCode: 1 });
          resolve();
        }
      });
    });
  }

  write(_input: string): void {
    // SDK handles permissions internally via permissionMode setting.
    // No stdin forwarding needed.
  }

  kill(): void {
    this.killed = true;
    if (this.childProc) {
      try { this.childProc.kill('SIGTERM'); } catch { /* ignore */ }
      this.childProc = null;
    }
    this.pendingCleanup?.();
    this.pendingCleanup = null;
  }
}
