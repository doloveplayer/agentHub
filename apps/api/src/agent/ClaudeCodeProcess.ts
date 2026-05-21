import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { EventParser, ParsedEvent } from './EventParser.js';
import { SandboxManager } from './SandboxManager.js';

export type EventHandler = (event: ParsedEvent) => void;

// Safe env vars to forward into the sandbox container.
// Everything else is stripped to prevent leakage of SSH keys, GitHub tokens, etc.
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

    // Exclude host-specific session identifiers
    if (upperKey === 'CLAUDE_CODE_SESSION_ID' || upperKey === 'CLAUDE_CODE_SSE_PORT') continue;

    // Whitelisted prefixes (ANTHROPIC_, CLAUDE_, PATH, HOME, etc.) ALWAYS pass
    const isWhitelisted = SAFE_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    if (isWhitelisted) {
      safe[key] = value;
      continue;
    }

    // Block sensitive suffixes for non-whitelisted vars (GITHUB_TOKEN, SSH_KEY, etc.)
    const blocked = ENV_BLOCKLIST_SUFFIXES.some((suffix) => upperKey.endsWith(suffix));
    if (blocked) continue;

    // Pass everything else
    safe[key] = value;
  }

  // Claude Code standard auth expects ANTHROPIC_API_KEY, but many proxy setups
  // (DeepSeek, etc.) use ANTHROPIC_AUTH_TOKEN. Copy if API_KEY is missing.
  // Case-insensitive lookup (process.env keys may vary).
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

// Startup diagnostic
console.log('[agent:env] Host ANTHROPIC_* vars:', Object.keys(process.env).filter(k => k.toUpperCase().startsWith('ANTHROPIC')));

// Export for debug endpoint
export { buildSafeEnv };

export class ClaudeCodeProcess {
  private containerId: string | null = null;
  private handlers: EventHandler[] = [];
  private doneEmitted = false;
  private killed = false;
  private partialLine = '';  // buffer for partial lines across Docker multiplex frames
  private stdinStream: NodeJS.WritableStream | null = null;  // unused — kept for interface compatibility

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: ParsedEvent): void {
    for (const handler of this.handlers) {
      try { handler(event); } catch { /* isolate handler errors */ }
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
    containerId: string,
    workDir: string,         // container path, e.g. /workspace
    trustMode?: boolean,
    hostWorkDir?: string,    // host path for writing files that bind-mount into container
    promptFileId?: string,   // unique per-agent ID to avoid file race between parallel agents
  ): Promise<void> {
    this.doneEmitted = false;
    this.killed = false;
    this.containerId = containerId;

    // REPL mode (trustMode=false): no --print, no --dangerously-skip-permissions.
    // Claude Code stays alive in interactive mode and emits tool_use events
    // that we intercept as permission requests (Write/Edit/Bash).
    // Pipe: cat file - | claude — keeps stdin open for y/n responses.
    const isReplMode = trustMode === false;
    const args = isReplMode
      ? ['--output-format', 'stream-json', '--verbose']  // REPL: no --print
      : ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

    // Build safe env (includes ANTHROPIC_API_KEY copied from ANTHROPIC_AUTH_TOKEN)
    const safeEnv = buildSafeEnv();

    const promptFile = promptFileId ? `_prompt_${promptFileId}.txt` : '_prompt.txt';

    // Write prompt to bind-mounted host file for stdin delivery.
    // Each agent gets its own prompt file to avoid race conditions when
    // multiple agents run in parallel inside the same container.
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

    console.log(`[agent] Starting Docker exec: container=${containerId.slice(0, 12)} workDir=${workDir} promptFile=${promptFile} trustMode=${trustMode !== false} replMode=${isReplMode}`);
    console.log(`[agent] Auth: API_KEY=${safeEnv['ANTHROPIC_API_KEY'] ? 'yes' : 'no'} BASE_URL=${safeEnv['ANTHROPIC_BASE_URL'] ? 'yes' : 'no'}`);

    // REPL mode: deliver prompt + keep stdin open via `cat -`.
    // The prompt is written to the stdin mux channel, not from a file.
    // This avoids the `cat file -` buffering issue.
    const shellCmd = isReplMode
      ? `. /workspace/_env.sh && cat - | claude ${args.join(' ')}`
      : `. /workspace/_env.sh && cat /workspace/${promptFile} | claude ${args.join(' ')}`;

    SandboxManager.execStream(containerId, ['sh', '-c', shellCmd], {
      workDir,
      stdin: isReplMode ? (prompt + '\n') : undefined,
      keepStdinOpen: isReplMode,
      onStdin: isReplMode ? (stdin) => { this.stdinStream = stdin; } : undefined,
      onStdout: (chunk) => {
        if (this.killed) return;
        // Accumulate partial lines across Docker multiplex frames
        this.partialLine += chunk;
        const lines = this.partialLine.split('\n');
        // Last element is either empty (if chunk ends with \n) or a partial line
        this.partialLine = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = EventParser.parseLine(line);
          if (event) {
            if (event.type === 'done') {
              this.emitDone(event.exitCode);
            } else {
              this.emit(event);
            }
          }
        }
      },
      onStderr: (chunk) => {
        if (this.killed) return;
        const message = chunk.trim();
        if (message) {
          this.emit({ type: 'error', message });
        }
      },
    }).then(({ exitCode }) => {
      if (!this.killed) {
        this.emitDone(exitCode);
      }
    }).catch((err) => {
      if (!this.killed) {
        this.emit({ type: 'error', message: `Docker exec error: ${err.message}` });
        this.emitDone(1);
      }
    });
  }

  write(input: string): void {
    if (this.killed) return;
    // REPL mode: write directly to the persistent stdin stream
    if (this.stdinStream) {
      try { this.stdinStream.write(input); } catch { /* process exited */ }
      return;
    }
    // Fallback for old --print mode: /proc/pid/fd/0
    if (!this.containerId) return;
    const escaped = input.replace(/'/g, "'\\''");
    SandboxManager.execShell(this.containerId,
      `echo '${escaped}' > /proc/$(pgrep -f 'claude.*--(print|verbose)' 2>/dev/null | head -1)/fd/0 2>/dev/null || true`);
  }

  kill(): void {
    this.killed = true;
    if (this.containerId) {
      SandboxManager.execShell(this.containerId, 'pkill -f "claude.*--print" 2>/dev/null || true');
    }
  }
}
