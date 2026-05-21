import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { SandboxManager } from '../SandboxManager.js';
import { EventParser } from '../EventParser.js';
import { buildSafeEnv } from '../ClaudeCodeProcess.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

export class ClaudeCodeProvider implements AbstractProvider {
  readonly name = 'claude-code';
  readonly capabilities = {
    persistentSession: true,
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private containerId: string | null = null;
  private handlers: EventHandler[] = [];
  private killed = false;
  private partialLine = '';
  private stdinStream: NodeJS.WritableStream | null = null;
  private agentHome = '/workspace';

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  getAgentHome(): string { return this.agentHome; }

  isAlive(): boolean {
    return !this.killed && this.stdinStream !== null;
  }

  async start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.killed = false;
    this.containerId = containerId;
    this.agentHome = `/workspace/_agent_${config.agentName || 'agent'}`;

    // REPL mode: no --print. Process stays alive after responding.
    const args = ['--output-format', 'stream-json', '--verbose'];
    // No --dangerously-skip-permissions in REPL mode — Claude Code will emit
    // permission_request events which we route to frontend for interactive approval.

    const safeEnv = buildSafeEnv();
    if (config.apiKey) safeEnv['ANTHROPIC_API_KEY'] = config.apiKey;
    if (config.baseUrl) safeEnv['ANTHROPIC_BASE_URL'] = config.baseUrl;

    const agentConfigDir = `${this.agentHome}/.claude`;

    // Write per-agent env file to avoid race condition with concurrent agents
    // Each agent gets its own CLAUDE_CONFIG_DIR for independent memory
    const agentTag = config.agentName || 'agent';
    const envFile = `_env_${agentTag}.sh`;
    if (config.hostWorkDir) {
      const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
      const envLines: string[] = [];
      envLines.push(`export CLAUDE_CONFIG_DIR='${agentConfigDir}'`);
      for (const k of authKeys) {
        if (safeEnv[k]) {
          envLines.push(`export ${k}='${String(safeEnv[k]).replace(/'/g, "'\\''")}'`);
        }
      }
      writeFileSync(resolve(config.hostWorkDir, envFile), envLines.join('\n'), 'utf-8');
    }

    // Write prompt to file for `cat file -` delivery
    const promptFile = `_repl_prompt_${agentTag}.txt`;
    if (config.hostWorkDir) {
      writeFileSync(resolve(config.hostWorkDir, promptFile), prompt + '\n', 'utf-8');
    }

    // REPL: `cat file - | claude`
    // First cat outputs the prompt file, then `-` reads from Docker exec stdin.
    // stdin stays open via keepStdinOpen for sendPrompt() and write().
    const shellCmd = `. /workspace/${envFile} && cd ${workDir} && cat /workspace/${promptFile} - | claude ${args.join(' ')}`;

    console.log(`[agent:repl] Starting REPL: container=${containerId.slice(0, 12)} agent=${config.agentName || 'unknown'}`);

    SandboxManager.execStream(containerId, ['sh', '-c', shellCmd], {
      workDir,
      keepStdinOpen: true,
      onStdin: (stdin) => { this.stdinStream = stdin; },
      onStdout: (chunk) => {
        if (this.killed) return;
        this.partialLine += chunk;
        const lines = this.partialLine.split('\n');
        this.partialLine = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = EventParser.parseLine(line);
          if (event) {
            const unified = EventParser.toUnified(event);
            if (unified) this.emit(unified);
          }
        }
      },
      onStderr: (chunk) => {
        if (this.killed) return;
        const msg = chunk.trim();
        if (msg) this.emit({ type: 'error', message: msg, timestamp: Date.now() });
      },
    }).catch((err) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: `Docker exec error: ${err.message}`, timestamp: Date.now() });
      }
    });
  }

  sendPrompt(prompt: string): void {
    if (!this.stdinStream || this.killed) return;
    try {
      // Claude Code REPL reads until newline. Truncate safely at char boundary.
      const truncated = prompt.length > 2000 ? prompt.slice(0, 2000) + '...' : prompt;
      const singleLine = truncated.replace(/\n/g, '\\n');
      this.stdinStream.write(singleLine + '\n');
    } catch { /* process already exited */ }
  }

  write(input: string): void {
    if (!this.stdinStream || this.killed) return;
    try { this.stdinStream.write(input); } catch { /* ignore */ }
  }

  stop(): void {
    this.killed = true;
    if (this.stdinStream) {
      try { this.stdinStream.end(); } catch { /* ignore */ }
      this.stdinStream = null;
    }
    if (this.containerId) {
      SandboxManager.execShell(this.containerId, 'pkill -f "claude.*--verbose" 2>/dev/null || true');
    }
  }
}
