import { spawn, execSync, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { EventParser } from '../EventParser.js';
import { buildDockerEnvArgs, buildSafeEnv } from '../ClaudeCodeProcess.js';

export class ClaudeCodeProvider implements AbstractProvider {
  readonly name = 'claude-code';
  readonly capabilities = {
    persistentSession: false,
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private containerName: string | null = null;
  private handlers: EventHandler[] = [];
  private doneEmitted = false;
  private killed = false;
  private partialLine = '';
  private childProc: ChildProcess | null = null;
  private agentHome = '/workspace';

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: UnifiedAgentEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    this.emit({ type: 'done', exitCode, timestamp: Date.now() });
  }

  getAgentHome(): string { return this.agentHome; }

  isAlive(): boolean {
    return !this.killed && this.childProc !== null && !this.childProc.killed;
  }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.doneEmitted = false;
    this.killed = false;
    EventParser.resetDeltaState();

    const safeEnv = buildSafeEnv();
    if (config.apiKey) safeEnv['ANTHROPIC_API_KEY'] = config.apiKey;
    if (config.baseUrl) safeEnv['ANTHROPIC_BASE_URL'] = config.baseUrl;

    const agentTag = config.agentName || 'agent';
    this.containerName = `agenthub-repl-${sessionId.slice(0, 8)}-${agentTag.slice(0, 12)}`;
    this.agentHome = `/workspace/_agent_${agentTag}`;
    const promptFile = `_repl_prompt_${agentTag}.txt`;

    // Write only prompt data to the bind-mounted workspace. Provider secrets
    // are passed with docker -e and are not written into workspace files.
    const hwDir = config.hostWorkDir || workDir;
    if (config.hostWorkDir) {
      writeFileSync(resolve(config.hostWorkDir, promptFile), prompt + '\n', 'utf-8');

      // Per-agent config directory for independent memory/skills.
      const agentConfigDir = resolve(config.hostWorkDir, `_agent_${agentTag}`, '.claude');
      const agentHomeInside = '/home/node/.claude';
      if (!existsSync(agentConfigDir)) {
        mkdirSync(agentConfigDir, { recursive: true });
      }
    }

    // docker run -i: native stdin/stdout pipes, no Docker multiplex.
    // Container PID 1 = claude REPL, dies when claude exits.
    // --rm auto-removes container on exit.
    // NO --print (REPL mode: process stays alive for sendPrompt reuse).
    // NO --dangerously-skip-permissions (permission_request events are emitted and intercepted).
    const args: string[] = [
      'run', '--rm', '-i',
      '--name', this.containerName,
      '-v', `${hwDir}:/workspace`,
      '-w', '/workspace',
      ...buildDockerEnvArgs(safeEnv),
      'agenthub-sandbox:latest',
      'sh', '-c',
      `cd ${workDir} && cat /workspace/${promptFile} - | claude --output-format stream-json --verbose`,
    ];

    // Per-agent CLAUDE_CONFIG_DIR bind-mount (independent memory/skills for each agent)
    if (config.hostWorkDir) {
      const agentConfigDir = resolve(config.hostWorkDir, `_agent_${agentTag}`, '.claude');
      const agentHomeInside = '/home/node/.claude';
      // Insert after the workspace -v pair (index 6) → splice at 7
      args.splice(7, 0, '-v', `${agentConfigDir}:${agentHomeInside}`, '-e', `CLAUDE_CONFIG_DIR=${agentHomeInside}`);
    }

    console.log(`[agent:repl] Starting REPL: container=${this.containerName.slice(0, 24)} agent=${agentTag}`);
    console.log(`[agent:repl] Auth: API_KEY=${safeEnv['ANTHROPIC_API_KEY'] ? 'yes' : 'no'} BASE_URL=${safeEnv['ANTHROPIC_BASE_URL'] ? 'yes' : 'no'}`);

    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...safeEnv } });
    this.childProc = proc;

    // Temporary: log unrecognized event types
    let unknownEventCount = 0;
    const MAX_UNKNOWN_LOG = 20;
    const structuralTypes = new Set(['content_block_stop']);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.killed) return;
      this.partialLine += chunk.toString();
      const lines = this.partialLine.split('\n');
      this.partialLine = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = EventParser.parseLine(line);
        if (event) {
          const unified = EventParser.toUnified(event);
          if (unified) this.emit(unified);
        } else if (unknownEventCount < MAX_UNKNOWN_LOG) {
          try {
            const raw = JSON.parse(line);
            if (structuralTypes.has(raw.type)) continue;
          } catch { /* non-JSON */ }
          unknownEventCount++;
          console.log(`[agent:repl:unknown] ${line.slice(0, 200)}`);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      if (this.killed) return;
      const message = chunk.toString().trim();
      if (!message) return;
      const isDockerNoise = /^(Unable to find|Pulling from|Digest:|Status:|Downloaded|Extracting|Pull complete)/.test(message);
      if (!isDockerNoise) this.emit({ type: 'error', message, timestamp: Date.now() });
    });

    proc.on('close', (code) => {
      if (!this.killed) {
        // Flush remaining partial line
        if (this.partialLine.trim()) {
          const event = EventParser.parseLine(this.partialLine);
          if (event) {
            const unified = EventParser.toUnified(event);
            if (unified && unified.type !== 'done') this.emit(unified);
          }
        }
        this.emitDone(code ?? 1);
      }
    });

    proc.on('error', (err) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: `docker run error: ${err.message}`, timestamp: Date.now() });
        this.emitDone(1);
      }
    });
  }

  sendPrompt(prompt: string): void {
    if (this.killed || !this.childProc?.stdin) return;
    try {
      // Native pipe: write prompt directly. No truncation, no newline escaping.
      // cat - reads from stdin and pipes to claude REPL.
      this.childProc.stdin.write(prompt + '\n');
    } catch { /* process already exited */ }
  }

  write(input: string): void {
    if (this.killed || !this.childProc?.stdin) return;
    try { this.childProc.stdin.write(input); } catch { /* process exited */ }
  }

  stop(): void {
    this.killed = true;
    if (this.childProc) {
      try { this.childProc.stdin?.end(); } catch { /* ignore */ }
      try { this.childProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (this.containerName) {
      try { execSync(`docker rm -f ${this.containerName} 2>/dev/null`, { timeout: 5000 }); } catch { /* ignore */ }
    }
  }
}
