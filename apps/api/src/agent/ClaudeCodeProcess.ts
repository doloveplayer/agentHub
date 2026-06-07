import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';
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

// Only pass Anthropic API credentials to the sandbox.
// Proxy vars are intentionally excluded — the container uses --network host
// and reaches external APIs directly via the host's internet connection.
const DOCKER_ENV_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'TZ',
  'LANG',
  'LC_ALL',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);
const MUTATING_PERMISSION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

interface RunOptions {
  sessionId: string;
  workDir: string;
  hostWorkDir?: string;
  agentHomeDir?: string;
  promptFile: string;
  containerName: string;
  agentConfigTag: string;
  claudeSessionId?: string;
  trustMode: boolean;
  safeEnv: Record<string, string>;
}

function buildSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const upperKey = key.toUpperCase();
    if (upperKey === 'CLAUDE_CODE_SESSION_ID' || upperKey === 'CLAUDE_CODE_SSE_PORT') continue;
    const isWhitelisted = SAFE_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    if (!isWhitelisted) continue;
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

export function buildDockerEnvArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const key of Object.keys(env)) {
    if (DOCKER_ENV_NAMES.has(key)) {
      args.push('-e', key);
      if (key === 'ANTHROPIC_BASE_URL') {
        console.log(`[agent:env] Docker -e ${key}=<set>`);
      }
    }
  }
  return args;
}

export class ClaudeCodeProcess {
  private containerId: string | null = null;
  private handlers: EventHandler[] = [];
  private doneEmitted = false;
  private killed = false;
  private partialLine = '';
  private childProc: ChildProcess | null = null;
  private runOptions: RunOptions | null = null;
  private runSeq = 0;
  private suppressCloseDone = false;
  private pendingPermission: { tool: string; path?: string } | null = null;
  private currentTrustMode = true;
  private approvedToolForRun: string | undefined;
  onClaudeSession?: (sessionId: string) => void;

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
    claudeSessionId?: string,    // for --resume: continue previous Claude session
    agentConfigId?: string,      // stable per Agent so --resume can find prior session state
    agentHomeDir?: string,       // persistent agent home (.agents/<agentId>)
  ): Promise<void> {
    this.doneEmitted = false;
    this.killed = false;
    EventParser.resetDeltaState();

    const safeEnv = buildSafeEnv();
    const agentTag = promptFileId || 'agent';
    const agentConfigTag = agentConfigId || agentTag;
    const containerTag = agentConfigId
      ? `${agentConfigId}-${agentTag.slice(-8)}`
      : agentTag.slice(0, 12);
    const containerName = `agenthub-agent-${sessionId.slice(0, 8)}-${containerTag}`;
    this.containerId = containerName;
    const promptFile = `_prompt_${agentTag}.txt`;

    // Write only prompt data to the bind-mounted workspace. Provider secrets are
    // passed with docker -e so the agent cannot read a workspace _env.sh file.
    if (hostWorkDir) {
      writeFileSync(resolve(hostWorkDir, promptFile), prompt, 'utf-8');
    }

    this.runOptions = {
      sessionId,
      workDir,
      hostWorkDir,
      agentHomeDir,
      promptFile,
      containerName,
      agentConfigTag,
      claudeSessionId,
      trustMode: trustMode ?? true,
      safeEnv,
    };
    this.pendingPermission = null;
    this.suppressCloseDone = false;
    this.startDockerRun();
  }

  private startDockerRun(approvedTool?: string): void {
    if (!this.runOptions) return;
    const {
      sessionId,
      workDir,
      hostWorkDir,
      agentHomeDir,
      promptFile,
      containerName,
      agentConfigTag,
      claudeSessionId,
      trustMode,
      safeEnv,
    } = this.runOptions;
    const effectiveTrustMode = approvedTool ? false : trustMode;
    this.currentTrustMode = effectiveTrustMode;
    this.approvedToolForRun = approvedTool;
    this.partialLine = '';
    this.suppressCloseDone = false;

    // docker run -i: native stdin/stdout pipes, no Docker multiplex.
    // Container PID 1 = claude, dies when claude exits.
    // --rm auto-removes container on exit.
    const hwDir = hostWorkDir || workDir;
    const claudeArgsParts = buildClaudePrintArgs(effectiveTrustMode);
    if (approvedTool) claudeArgsParts.push('--allowedTools', approvedTool);
    if (claudeSessionId) {
      claudeArgsParts.push('--resume', claudeSessionId);
      console.log(`[agent:spawn] Resuming Claude session: ${claudeSessionId.slice(0, 20)}...`);
    }
    const claudeArgs = claudeArgsParts.join(' ');
    // --network host: container shares host network, can access localhost services
    // (proxy, API endpoints) directly without host.docker.internal rewriting.
    const args: string[] = [
      'run', '--rm', '-i',
      '--network', 'host',
      '--name', containerName,
      '-v', `${hwDir}:/workspace`,
      '-w', '/workspace',
      ...buildDockerEnvArgs(safeEnv),
      'agenthub-sandbox:latest',
      'sh', '-c',
      `cat /workspace/${promptFile} | claude ${claudeArgs}`,
    ];

    // Per-agent CLAUDE_CONFIG_DIR: uses the sandbox agent directory,
    // which already contains global skills/memory (copied on init) + session-specific skills.
    // The directory is available inside the container via the /sandbox bind mount.
    if (agentConfigTag) {
      const configPath = `/sandbox/_agent_${agentConfigTag}/.claude`;
      args.splice(7, 0, '-e', `CLAUDE_CONFIG_DIR=${configPath}`);
    }

    console.log(`[agent:spawn] docker ${args.slice(0, 6).join(' ')} ... container=${containerName}`);
    console.log(`[agent:spawn] Auth: API_KEY=${safeEnv['ANTHROPIC_API_KEY'] ? 'yes' : 'no'} BASE_URL=${safeEnv['ANTHROPIC_BASE_URL'] ? 'yes' : 'no'}`);
    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...safeEnv } });
    this.childProc = proc;
    const runId = ++this.runSeq;

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
        const events = EventParser.parseLine(line);
        if (events.length > 0) {
          for (const event of events) {
            // Extract Claude session ID from system init event for --resume
            if (event.type === 'system' && event.subtype === 'init' && event.sessionId && this.onClaudeSession) {
              this.onClaudeSession(event.sessionId);
            }
            if (this.proxyPermissionIfNeeded(event)) continue;
            if (event.type === 'done') this.emitDone(event.exitCode);
            else this.emit(event);
          }
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
      if (runId !== this.runSeq) return;
      if (runId === this.runSeq) this.childProc = null;

      // Clean up prompt file to prevent sandbox clutter
      const { hostWorkDir, promptFile } = this.runOptions || {};
      if (hostWorkDir && promptFile) {
        try { require('fs').unlinkSync(resolve(hostWorkDir, promptFile)); } catch {}
      }

      if (this.suppressCloseDone || this.pendingPermission) return;
      if (!this.killed) {
        // Flush remaining partial line if any
        if (this.partialLine.trim()) {
          const events = EventParser.parseLine(this.partialLine);
          for (const event of events) {
            if (event.type !== 'done' && !this.proxyPermissionIfNeeded(event)) this.emit(event);
          }
        }
        this.emitDone(code ?? 1);
      }
    });

    proc.on('error', (err) => {
      if (runId !== this.runSeq) return;
      if (!this.killed) {
        this.emit({ type: 'error', message: `docker run error: ${err.message}` });
        this.emitDone(1);
      }
    });
  }

  private proxyPermissionIfNeeded(event: ParsedEvent): boolean {
    if (this.currentTrustMode || this.pendingPermission || event.type !== 'tool_use') return false;
    if (this.approvedToolForRun === event.toolName) return false;
    if (!MUTATING_PERMISSION_TOOLS.has(event.toolName)) return false;
    const path = extractToolPath(event.input);
    this.emit(event);
    this.pendingPermission = { tool: event.toolName, path };
    this.emit({ type: 'permission_request', tool: event.toolName, path });
    this.suppressCloseDone = true;
    this.stopCurrentProcess();
    return true;
  }

  private stopCurrentProcess(): void {
    const proc = this.childProc;
    this.childProc = null;
    if (proc) {
      try { proc.stdin?.end(); } catch { /* ignore */ }
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // 容器已带 --rm，会在进程退出后自动清理。不显式 docker rm -f。
  }

  write(input: string): void {
    if (this.pendingPermission) {
      const allowed = input.trim().toLowerCase().startsWith('y');
      const pending = this.pendingPermission;
      this.pendingPermission = null;
      if (!allowed) {
        this.emit({ type: 'error', message: 'Permission denied by user' });
        this.emitDone(1);
        return;
      }
      this.startDockerRun(pending.tool);
      return;
    }
    if (this.killed || !this.childProc?.stdin) return;
    try { this.childProc.stdin.write(input); } catch { /* process exited */ }
  }

  kill(): void {
    this.killed = true;
    this.stopCurrentProcess();
  }
}

function extractToolPath(input: Record<string, unknown>): string | undefined {
  const value = input.file_path || input.path || input.filePath || input.command;
  return typeof value === 'string' ? value : undefined;
}
