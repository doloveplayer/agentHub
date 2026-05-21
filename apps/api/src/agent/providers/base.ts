export interface UnifiedAgentEvent {
  type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start'
      | 'subagent_result' | 'permission_request' | 'milestone'
      | 'blocked' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  filePath?: string;
  exitCode?: number;
  message?: string;
  providerRaw?: unknown;
  timestamp: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  env?: Record<string, string>;
  agentName?: string;
  hostWorkDir?: string;
}

export type EventHandler = (event: UnifiedAgentEvent) => void;

export interface AbstractProvider {
  readonly name: string;
  readonly capabilities: {
    persistentSession: boolean;
    permissionProxy: boolean;
    streamingOutput: boolean;
    independentMemory: boolean;
    independentConfig: boolean;
  };

  start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void>;

  sendPrompt(prompt: string): void;
  write(input: string): void;
  stop(): void;
  onEvent(handler: EventHandler): void;
  isAlive(): boolean;
  getAgentHome(): string;
}
