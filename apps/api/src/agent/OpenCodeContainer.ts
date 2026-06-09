import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { stripAnsi } from './stripAnsi.js';

export interface OpenCodeContainerOptions {
  containerId: string;
  prompt: string;
  hostSandboxDir: string;
  trustMode: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  variant?: string;
  resumeSession?: string;
}

/**
 * Generate opencode.json configuration for DeepSeek / OpenAI-compatible providers.
 *
 * Uses the `{env:AGENTHUB_OPENCODE_API_KEY}` placeholder so the actual key
 * is injected at runtime via docker exec -e, never written to disk.
 */
export function generateOpenCodeConfig(
  baseUrl: string,
  model: string,
): object {
  const modelName = stripAnsi(model);

  return {
    model: `deepseek/${modelName}`,
    provider: {
      deepseek: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepSeek',
        options: {
          baseURL: baseUrl,
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
  // --- Resolve config with fallback chain (mirrors Claude Code's SDKContainer pattern) ---
  // API Key : OPENCODE_API_KEY → agent config apiKey → ''
  const apiKey = process.env.OPENCODE_API_KEY || opts.apiKey || '';

  // Model   : agent config model → OPENCODE_MODEL → 'deepseek-chat'
  const resolvedModel = stripAnsi(
    opts.model || process.env.OPENCODE_MODEL || 'deepseek-chat',
  );

  // Base URL: agent config baseUrl → OPENCODE_BASE_URL → ANTHROPIC_BASE_URL → default
  const resolvedBaseUrl =
    opts.baseUrl ||
    process.env.OPENCODE_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    'https://api.deepseek.com/v1';

  // Variant : agent config variant → OPENCODE_VARIANT → ANTHROPIC_THINKING_EFFORT → 'high'
  const resolvedVariant =
    opts.variant ||
    process.env.OPENCODE_VARIANT ||
    process.env.ANTHROPIC_THINKING_EFFORT ||
    'high';

  // Write opencode.json to sandbox dir so the container sees it at /sandbox/opencode.json
  const config = generateOpenCodeConfig(resolvedBaseUrl, resolvedModel);
  const configPath = resolve(opts.hostSandboxDir, 'opencode.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  const dockerArgs = [
    'exec',
    '-e', `AGENTHUB_OPENCODE_API_KEY=${apiKey}`,
    '-e', 'OPENCODE_CONFIG=/sandbox/opencode.json',
    '-w', '/workspace',
    opts.containerId,
    'opencode', 'run',
    '--format', 'json',
    '-m', `deepseek/${resolvedModel}`,
  ];

  if (opts.resumeSession) {
    dockerArgs.push('--session', opts.resumeSession);
  }

  dockerArgs.push('--variant', resolvedVariant);

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
