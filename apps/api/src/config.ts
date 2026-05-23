import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root (two levels up from apps/api/src/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

// Apply HTTPS proxy for external API calls (e.g., GitHub OAuth behind GFW).
// undici's native fetch() respects https_proxy when set in process.env.
const httpsProxy = process.env.HTTPS_PROXY || '';
if (httpsProxy) {
  process.env.https_proxy = httpsProxy;
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),

  database: {
    url: required('DATABASE_URL'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: '7d' as const,
  },

  github: {
    clientId: required('GITHUB_CLIENT_ID'),
    clientSecret: required('GITHUB_CLIENT_SECRET'),
    callbackUrl: required('GITHUB_CALLBACK_URL'),
    allowedUsers: required('GITHUB_ALLOWED_USERS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  redis: {
    url: optional('REDIS_URL', ''),
  },

  sandbox: {
    hostDockerSocket: optional('HOST_DOCKER_SOCKET', '/var/run/docker.sock'),
    image: optional('SANDBOX_IMAGE', 'agenthub-sandbox:latest'),
    root: optional('SANDBOXES_ROOT', resolve(PROJECT_ROOT, '.sandboxes')),
  },

  agent: {
    timeoutMs: optionalInt('AGENT_TIMEOUT_MS', 300_000),  // 5 min default
    maxConcurrent: optionalInt('MAX_CONCURRENT_AGENTS', 5),
  },

  taskQueue: {
    concurrency: optionalInt('TASK_CONCURRENCY', 3),
    maxRetries: optionalInt('TASK_MAX_RETRIES', 2),
    retryDelayMs: optionalInt('TASK_RETRY_DELAY_MS', 30_000),
  },
} as const;

export const redis = {
  host: optional('REDIS_HOST', 'localhost'),
  port: optionalInt('REDIS_PORT', 6379),
};
