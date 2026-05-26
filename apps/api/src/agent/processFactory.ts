import { config } from '../config.js';
import type { ParsedEvent } from './EventParser.js';
import { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import { TestAgentProcess } from './TestAgentProcess.js';

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
 * Creates an SDK-backed process. Returns null if SDK is unavailable.
 * Callers should fall back to createOneShotAgentProcess().
 */
export async function createSDKAgentProcess(): Promise<OneShotAgentProcess | null> {
  if (config.agent.provider === "test") return new TestAgentProcess();
  try {
    const { ClaudeAgentSDK, mapPermissionMode, mapAllowedTools } = await import("./ClaudeAgentSDK.js");
    const sdk = { ClaudeAgentSDK, mapPermissionMode, mapAllowedTools };
    return new ClaudeSDKProcess(sdk);
  } catch {
    console.log("[processFactory] Claude Agent SDK not available, falling back to CLI spawn");
    return null;
  }
}

// ClaudeSDKProcess now takes SDK deps via constructor (no static import)
class ClaudeSDKProcess implements OneShotAgentProcess {
  private sdk: any = null;
  private handlers: Array<(event: ParsedEvent) => void> = [];
  private _onClaudeSession: ((sessionId: string) => void) | undefined;
  private sdkLib: any;

  constructor(sdkLib: any) {
    this.sdkLib = sdkLib;
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

  emit(event: ParsedEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  isAlive(): boolean { return this.sdk !== null; }

  async start(
    _sessionId: string,
    prompt: string,
    _containerId: string,
    workDir: string,
    trustMode?: boolean,
    hostWorkDir?: string,
    _promptFileId?: string,
    claudeSessionId?: string,
    _agentConfigId?: string,
  ): Promise<void> {
    const ClaudeAgentSDK = this.sdkLib.ClaudeAgentSDK;
    const mapPermissionMode = this.sdkLib.mapPermissionMode;
    const mapAllowedTools = this.sdkLib.mapAllowedTools;
    this.sdk = new ClaudeAgentSDK();
    const cwd = hostWorkDir || workDir;
    const profile: string = trustMode ? "bypass" : "read_only";

    const result = await this.sdk.stream(prompt, {
      cwd,
      resume: claudeSessionId,
      permissionMode: mapPermissionMode(profile),
      allowedTools: mapAllowedTools(profile),
      persistSession: true,
    }, (event: ParsedEvent) => {
      if (event.type === "system" && event.sessionId && this._onClaudeSession) {
        this._onClaudeSession(event.sessionId);
      }
      this.emit(event);
    });

    // Also capture session ID from result in case no system event was emitted
    if (result.sessionId && this._onClaudeSession) {
      this._onClaudeSession(result.sessionId);
    }

    this.emit({ type: "done", exitCode: result.exitCode });
  }

  write(_input: string): void { /* SDK handles stdin through query prompt */ }
  kill(): void { this.sdk?.kill(); this.sdk = null; }
}
