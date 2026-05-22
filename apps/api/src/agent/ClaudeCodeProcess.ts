import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { EventParser, ParsedEvent } from './EventParser.js';
import { buildClaudePrintArgs } from './turns.js';

export type EventHandler = (event: ParsedEvent) => void;

// Safe env vars to forward into the sandbox container.
const SAFE_ENV_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_',      // Claude auth
  'PATH', 'HOME',                // Essential
  'NVM_',                        // nvm (node resolution)
  'LANG', 'LC_',                 // Locale
  'TERM', 'COLOR',               // Terminal
  'NO_COLOR', 'FORCE_COLOR',     // Color control
  'TZ',                          // Timezone
  'DEBIAN_FRONTEND',             // System
];

const ENV_BLOCKLIST_SUFFIXES = ['_TOKEN', '_SECRET', '_KEY', '_PASSWORD'];

function buildSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const upperKey = key.toUpperCase();
    if (upperKey === 'CLAUDE_CODE_SESSION_ID' || upperKey === 'CLAUDE_CODE_SSE_PORT') continue;
    const isWhitelisted = SAFE_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    if (isWhitelisted) { safe[key] = value; continue; }
    const blocked = ENV_BLOCKLIST_SUFFIXES.some((suffix) => upperKey.endsWith(suffix));
    if (blocked) continue;
    safe[key] = value;
  }
  const apiKey = Object.keys(safe).find(k => k.toUpperCase() === 'ANTHROPIC_API_KEY');
  const authToken = Object.keys(safe).find(k => k.toUpperCase() === 'ANTHROPIC_AUTH_TOKEN');
  if (!apiKey && authToken) {
    safe['ANTHROPIC_API_KEY'] = safe[authToken];
    console.log(`[agent:env] Copied ${authToken} → ANTHROPIC_API_KEY (len=${safe[authToken].length})`);
  }
  if (!apiKey && !authToken) {
    console.log('[agent:env] WARNING: No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in safe env!');
  }
  return safe;
}

console.log('[agent:env] Host ANTHROPIC_* vars:', Object.keys(process.env).filter(k => k.toUpperCase().startsWith('ANTHROPIC')));

export { buildSafeEnv };

export class ClaudeCodeProcess {
  private containerId: string | null = null;
  private handlers: EventHandler[] = [];
  private doneEmitted = false;
  private killed = false;
  private partialLine = '';
  private childProc: ChildProcess | null = null;

  onEvent(handler: EventHandler): void { this.handlers.push(handler); }

  private emit(event: ParsedEvent): void {
    for (const handler of this.handlers) {
      try { handler(event); } catch { /* isolate */ }
    }
  }

  private emitDone(exitCode: number): void {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    this.emit({ type: 'done', exitCode });
  }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,        // kept for API compat, unused
    workDir: string,
    trustMode?: boolean,
    hostWorkDir?: string,
    promptFileId?: string,
  ): Promise<void> {
    this.doneEmitted = false;
    this.killed = false;
    EventParser.resetDeltaState();

    const safeEnv = buildSafeEnv();
    const agentTag = promptFileId || 'agent';
    const containerName = `agenthub-agent-${sessionId.slice(0, 8)}-${agentTag.slice(0, 12)}`;
    this.containerId = containerName;
    const promptFile = `_prompt_${agentTag}.txt`;

    // Write prompt + env files to bind-mounted hostWorkDir
    if (hostWorkDir) {
      writeFileSync(resolve(hostWorkDir, promptFile), prompt, 'utf-8');
      const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
      const envLines: string[] = [];
      for (const k of authKeys) {
        if (safeEnv[k]) {
          envLines.push(`export ${k}='${String(safeEnv[k]).replace(/'/g, "'\\''")}'`);
        }
      }
      writeFileSync(resolve(hostWorkDir, '_env.sh'), envLines.join('\n'), 'utf-8');
    }

    // docker run -i: native stdin/stdout pipes, no Docker multiplex.
    // Container PID 1 = claude, dies when claude exits.
    // --rm auto-removes container on exit.
    const hwDir = hostWorkDir || workDir;
    const claudeArgs = buildClaudePrintArgs(trustMode ?? true).join(' ');
    const args: string[] = [
      'run', '--rm', '-i',
      '--name', containerName,
      '-v', `${hwDir}:/workspace`,
      '-w', '/workspace',
      'agenthub-sandbox:latest',
      'sh', '-c',
      `. /workspace/_env.sh && cat /workspace/${promptFile} | claude ${claudeArgs}`,
    ];

    // Per-agent CLAUDE_CONFIG_DIR for independent memory/skills (only when hostWorkDir is set)
    if (hostWorkDir) {
      const agentConfigDir = resolve(hostWorkDir, `_agent_${agentTag}`, '.claude');
      // Pre-create directory so it's owned by the host user, not root (Docker would create it as root)
      if (!existsSync(agentConfigDir)) {
        mkdirSync(agentConfigDir, { recursive: true });
      }
      const agentHomeInside = '/home/node/.claude';
      // Insert CLAUDE_CONFIG_DIR mount + env after the workspace -v pair
      args.splice(7, 0, '-v', `${agentConfigDir}:${agentHomeInside}`, '-e', `CLAUDE_CONFIG_DIR=${agentHomeInside}`);
    }

    console.log(`[agent:spawn] docker ${args.slice(0, 6).join(' ')} ... container=${containerName}`);
    console.log(`[agent:spawn] Auth: API_KEY=${safeEnv['ANTHROPIC_API_KEY'] ? 'yes' : 'no'} BASE_URL=${safeEnv['ANTHROPIC_BASE_URL'] ? 'yes' : 'no'}`);

    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.childProc = proc;

    // Temporary: log unrecognized event types to diagnose output format issues.
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
          if (event.type === 'done') this.emitDone(event.exitCode);
          else this.emit(event);
        } else if (unknownEventCount < MAX_UNKNOWN_LOG) {
          // Skip known structural events that we intentionally ignore
          try {
            const raw = JSON.parse(line);
            if (structuralTypes.has(raw.type)) continue;
          } catch { /* non-JSON line, log it */ }
          unknownEventCount++;
          console.log(`[agent:stdout:unknown] ${line.slice(0, 300)}`);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      if (this.killed) return;
      const message = chunk.toString().trim();
      if (!message) return;
      // Filter Docker CLI progress noise (image pull, etc.) from agent errors
      const isDockerNoise = /^(Unable to find|Pulling from|Digest:|Status:|Downloaded|Extracting|Pull complete)/.test(message);
      if (!isDockerNoise) this.emit({ type: 'error', message });
    });

    proc.on('close', (code) => {
      if (!this.killed) {
        // Flush remaining partial line if any
        if (this.partialLine.trim()) {
          const event = EventParser.parseLine(this.partialLine);
          if (event && event.type !== 'done') this.emit(event);
        }
        this.emitDone(code ?? 1);
      }
    });

    proc.on('error', (err) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: `docker run error: ${err.message}` });
        this.emitDone(1);
      }
    });
  }

  write(input: string): void {
    if (this.killed || !this.childProc?.stdin) return;
    try { this.childProc.stdin.write(input); } catch { /* process exited */ }
  }

  kill(): void {
    this.killed = true;
    if (this.childProc) {
      try { this.childProc.stdin?.end(); } catch { /* ignore */ }
      try { this.childProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // docker rm -f as fallback
    if (this.containerId) {
      try { execSync(`docker rm -f ${this.containerId} 2>/dev/null`, { timeout: 5000 }); } catch { /* ignore */ }
    }
  }
}
