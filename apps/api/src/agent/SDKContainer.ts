import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

export interface SDKContainerOptions {
  containerId: string;
  prompt: string;
  hostWorkDir: string;
  agentTag: string;
  agentConfigTag?: string;
  permissionMode: string;
  allowedTools: string[];
  model?: string;
  resumeSession?: string;
  maxTurns?: number;
}

/**
 * Spawn a `docker exec` process that runs the SDK runner inside the sandbox container.
 *
 * The runner (sdk-runner.mjs) reads the prompt from a bind-mounted file,
 * calls @anthropic-ai/claude-agent-sdk's query(), and streams JSON messages
 * to stdout. Each line is a complete SDK message (type: "assistant" | "tool_result"
 * | "system" | "stream_event" | "result").
 */
export function spawnSDKInDocker(
  opts: SDKContainerOptions,
): { proc: ChildProcess; promptFile: string; cleanup: () => void } {
  const promptFile = `_prompt_${opts.agentTag}.txt`;
  const promptPath = resolve(opts.hostWorkDir, promptFile);
  writeFileSync(promptPath, opts.prompt, 'utf-8');

  // Mirror auth env vars into the container. Only pass the essential ones.
  const envVars: Record<string, string> = {};
  const passthrough = new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_THINKING_EFFORT', 'ANTHROPIC_THINKING_BUDGET',
  ]);
  for (const key of passthrough) {
    const val = process.env[key];
    if (val) envVars[key] = val;
  }
  // Fallback: copy ANTHROPIC_AUTH_TOKEN -> ANTHROPIC_API_KEY if API_KEY is missing
  if (!envVars['ANTHROPIC_API_KEY'] && envVars['ANTHROPIC_AUTH_TOKEN']) {
    envVars['ANTHROPIC_API_KEY'] = envVars['ANTHROPIC_AUTH_TOKEN'];
  }
  // Forward ANTHROPIC_MODEL to sdk-runner via AGENTHUB_MODEL
  if (envVars['ANTHROPIC_MODEL']) {
    envVars['AGENTHUB_MODEL'] = envVars['ANTHROPIC_MODEL'];
  }
  // Forward thinking config to sdk-runner
  if (envVars['ANTHROPIC_THINKING_EFFORT']) {
    envVars['AGENTHUB_THINKING_EFFORT'] = envVars['ANTHROPIC_THINKING_EFFORT'];
  }
  if (envVars['ANTHROPIC_THINKING_BUDGET']) {
    envVars['AGENTHUB_THINKING_BUDGET'] = envVars['ANTHROPIC_THINKING_BUDGET'];
  }

  envVars['AGENTHUB_PROMPT_FILE'] = `/workspace/${promptFile}`;
  envVars['AGENTHUB_PERMISSION_MODE'] = opts.permissionMode;
  envVars['AGENTHUB_ALLOWED_TOOLS'] = JSON.stringify(opts.allowedTools);

  if (opts.model) envVars['AGENTHUB_MODEL'] = opts.model;
  if (opts.resumeSession) envVars['AGENTHUB_RESUME_SESSION'] = opts.resumeSession;
  if (opts.maxTurns) envVars['AGENTHUB_MAX_TURNS'] = String(opts.maxTurns);

  const dockerArgs = ['exec', '-i'];
  for (const [k, v] of Object.entries(envVars)) {
    dockerArgs.push('-e', `${k}=${v}`);
  }

  // Per-agent config isolation (settings.json, memory, skills)
  if (opts.agentConfigTag) {
    const configDir = resolve(opts.hostWorkDir, `_agent_${opts.agentConfigTag}`, '.claude');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    dockerArgs.push(
      '-e',
      `CLAUDE_CONFIG_DIR=/workspace/_agent_${opts.agentConfigTag}/.claude`,
    );
  }

  dockerArgs.push(opts.containerId, 'node', '/usr/local/bin/sdk-runner.mjs');

  const proc = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env, // docker CLI needs host env to talk to docker.sock
  });

  const cleanup = () => {
    try { unlinkSync(promptPath); } catch { /* best-effort */ }
  };

  return { proc, promptFile, cleanup };
}
