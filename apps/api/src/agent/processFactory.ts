import { config } from '../config.js';
import type { ParsedEvent } from './EventParser.js';
import { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import { TestAgentProcess } from './TestAgentProcess.js';

export interface OneShotAgentProcess {
  onClaudeSession?: (sessionId: string) => void;
  onEvent(handler: (event: ParsedEvent) => void): void;
  start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    trustMode?: boolean,
    hostWorkDir?: string,
    promptFileId?: string,
    claudeSessionId?: string,
    agentConfigId?: string,
  ): Promise<void>;
  write(input: string): void;
  kill(): void;
}

export function createOneShotAgentProcess(): OneShotAgentProcess {
  if (config.agent.provider === 'test') {
    return new TestAgentProcess();
  }
  if (config.agent.provider === 'claude-code') {
    return new ClaudeCodeProcess();
  }
  throw new Error(`Unknown one-shot agent provider: ${config.agent.provider}`);
}
