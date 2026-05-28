import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root (two levels up from apps/api/src/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

// Apply HTTPS proxy for external API calls (e.g., GitHub OAuth behind GFW).
// Node 18+ native fetch (undici) respects https_proxy when set in process.env.
const httpsProxy = process.env.HTTPS_PROXY || '';
if (httpsProxy) {
  process.env.https_proxy = httpsProxy;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // tolerate proxy cert issues
  console.log(`[config] HTTPS proxy configured: ${httpsProxy.replace(/\/\/.*@/, '//***@')}`);
} else {
  console.warn('[config] No HTTPS_PROXY set — GitHub OAuth will fail behind GFW');
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

/**
 * Mutable runtime configuration for agent parameters.
 * Values can be changed at runtime via sync setters (for tests) or async persist setters (for API).
 * On startup, loadPersisted() restores values from the GlobalConfig DB table.
 */
export class RuntimeAgentConfig {
  private _maxConcurrent: number;
  private _timeoutMs: number;
  private _queueTimeoutMs: number;
  private _perSessionMax: number;

  constructor() {
    this._maxConcurrent = optionalInt('MAX_CONCURRENT_AGENTS', 2);
    this._timeoutMs = optionalInt('AGENT_TIMEOUT_MS', 300_000);
    this._queueTimeoutMs = optionalInt('AGENT_QUEUE_TIMEOUT_MS', 120_000);
    this._perSessionMax = optionalInt('AGENT_PER_SESSION_MAX', 8);
  }

  /** Load persisted values from DB, falling back to env vars */
  async loadPersisted(prisma: any) {
    try {
      const rows = await prisma.globalConfig.findMany({
        where: { key: { in: ['maxConcurrent', 'timeoutMs', 'queueTimeoutMs', 'perSessionMax'] } },
      });
      for (const row of rows) {
        const val = Number(row.value);
        if (!isNaN(val)) (this as any)[`_${row.key}`] = val;
      }
      console.log('[config] Loaded persisted runtime config:', this.toJSON());
    } catch (err: any) { console.error('[config] Failed to load persisted config:', err?.message ?? err); }
  }

  /** Persist a single key to DB */
  private async persist(prisma: any, key: string, value: number) {
    try {
      await prisma.globalConfig.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      });
    } catch (err: any) { console.error('[config] Failed to persist config key:', key, err?.message ?? err); }
  }

  // Async setters with validation and DB persistence
  async setMaxConcurrent(prisma: any, v: number) {
    if (v > 0 && v <= 20) { this._maxConcurrent = v; await this.persist(prisma, 'maxConcurrent', v); }
  }
  async setTimeoutMs(prisma: any, v: number) {
    if (v >= 10_000 && v <= 3_600_000) { this._timeoutMs = v; await this.persist(prisma, 'timeoutMs', v); }
  }
  async setQueueTimeoutMs(prisma: any, v: number) {
    if (v >= 10_000 && v <= 1_800_000) { this._queueTimeoutMs = v; await this.persist(prisma, 'queueTimeoutMs', v); }
  }
  async setPerSessionMax(prisma: any, v: number) {
    if (v > 0 && v <= 50) { this._perSessionMax = v; await this.persist(prisma, 'perSessionMax', v); }
  }

  // Sync getters/setters (for test compatibility and backward compat)
  get maxConcurrent(): number { return this._maxConcurrent; }
  set maxConcurrent(v: number) {
    if (v > 0 && v <= 20) this._maxConcurrent = v;
  }

  get timeoutMs(): number { return this._timeoutMs; }
  set timeoutMs(v: number) {
    if (v >= 10_000 && v <= 3_600_000) this._timeoutMs = v;
  }

  get queueTimeoutMs(): number { return this._queueTimeoutMs; }
  set queueTimeoutMs(v: number) {
    if (v >= 10_000 && v <= 1_800_000) this._queueTimeoutMs = v;
  }

  get perSessionMax(): number { return this._perSessionMax; }
  set perSessionMax(v: number) {
    if (v > 0 && v <= 50) this._perSessionMax = v;
  }

  toJSON() {
    return {
      maxConcurrent: this._maxConcurrent,
      timeoutMs: this._timeoutMs,
      queueTimeoutMs: this._queueTimeoutMs,
      perSessionMax: this._perSessionMax,
    };
  }
}

/** The singleton runtime config instance, used for mutable agent parameters */
export const runtimeConfig = {
  agent: new RuntimeAgentConfig(),
};

/**
 * Frozen config object for static configuration (DB, JWT, GitHub, sandbox, etc.).
 * Agent runtime params delegate to runtimeConfig.agent via getters for backward compat.
 */
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
    soloMemoryMb: optionalInt('SOLO_SANDBOX_MEMORY_MB', 512),
    groupMemoryMb: optionalInt('GROUP_SANDBOX_MEMORY_MB', 2048),
  },

  frontendUrl: optional('FRONTEND_URL', 'http://localhost:5175'),

  agent: {
    get maxConcurrent() { return runtimeConfig.agent.maxConcurrent; },
    get timeoutMs() { return runtimeConfig.agent.timeoutMs; },
    get queueTimeoutMs() { return runtimeConfig.agent.queueTimeoutMs; },
    get perSessionMax() { return runtimeConfig.agent.perSessionMax; },
    provider: optional('AGENTHUB_AGENT_PROVIDER', optional('AGENT_PROVIDER', 'claude-code')),
    contextWindowTokens: optionalInt('AGENT_CONTEXT_WINDOW_TOKENS', 200_000), // Claude Sonnet 4 default
  },

} as const;
