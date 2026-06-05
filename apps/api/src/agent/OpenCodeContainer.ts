import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

export interface OpenCodeContainerOptions {
  containerId: string;
  prompt: string;
  hostSandboxDir: string;
  trustMode: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  resumeSession?: string;
}

/**
 * Generate opencode.json configuration for DeepSeek / OpenAI-compatible providers.
 *
 * Uses the `{env:AGENTHUB_OPENCODE_API_KEY}` placeholder so the actual key
 * is injected at runtime via docker exec -e, never written to disk.
 */
export function generateOpenCodeConfig(
  baseUrl?: string,
  model?: string,
): object {
  const endpoint = baseUrl || 'https://api.deepseek.com/v1';
  const modelName = model || 'deepseek-chat';

  return {
    model: `deepseek/${modelName}`,
    provider: {
      deepseek: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepSeek',
        options: {
          baseURL: endpoint,
          apiKey: '{env:AGENTHUB_OPENCODE_API_KEY}',
          timeout: 300000,
        },
        models: {
          [modelName]: { name: modelName },
        },
      },
    },
  };
}

/**
 * Spawn a `docker exec` process that runs `opencode run --format json`
 * inside the sandbox container.
 *
 * Writes opencode.json to the host sandbox directory (bind-mounted at
 * /sandbox inside the container). Each NDJSON line on stdout is a
 * complete opencode event.
 */
export function spawnOpenCodeInDocker(
  opts: OpenCodeContainerOptions,
): { proc: ChildProcess; cleanup: () => void } {
  // Write opencode.json to sandbox dir so the container sees it at /sandbox/opencode.json
  const config = generateOpenCodeConfig(opts.baseUrl, opts.model);
  const configPath = resolve(opts.hostSandboxDir, 'opencode.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Read API key from environment (same pattern as Claude Code's ANTHROPIC_API_KEY).
  // Falls back to opts.apiKey for per-agent overrides.
  const apiKey = process.env.DEEPSEEK_API_KEY || opts.apiKey || '';

  const model = opts.model || 'deepseek-chat';

  const dockerArgs = [
    'exec',
    '-e', `AGENTHUB_OPENCODE_API_KEY=${apiKey}`,
    '-e', 'OPENCODE_CONFIG=/sandbox/opencode.json',
    '-w', '/workspace',
    opts.containerId,
    'opencode', 'run',
    '--format', 'json',
    '-m', `deepseek/${model}`,
  ];

  if (opts.resumeSession) {
    dockerArgs.push('--session', opts.resumeSession);
  }

  if (opts.trustMode) {
    dockerArgs.push('--dangerously-skip-permissions');
  }

  dockerArgs.push(opts.prompt);

  const proc = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env, // docker CLI needs host env to talk to docker.sock
  });

  const cleanup = () => {
    try { unlinkSync(configPath); } catch { /* best-effort */ }
  };

  return { proc, cleanup };
}
