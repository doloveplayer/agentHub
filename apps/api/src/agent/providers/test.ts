import { AbstractProvider, EventHandler, ProviderConfig, UnifiedAgentEvent } from './base.js';
import { EventParser } from '../EventParser.js';
import { TestAgentProcess } from '../TestAgentProcess.js';

export class TestAgentProvider implements AbstractProvider {
  readonly name = 'test';
  readonly capabilities = {
    persistentSession: false,
    permissionProxy: true,
    streamingOutput: true,
    independentMemory: true,
    independentConfig: true,
  };

  private process = new TestAgentProcess();
  private handlers: EventHandler[] = [];
  private alive = false;
  private agentHome = '/workspace/_agent_test';

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  async start(
    sessionId: string,
    prompt: string,
    containerId: string,
    workDir: string,
    config: ProviderConfig,
  ): Promise<void> {
    this.alive = true;
    this.agentHome = `/workspace/_agent_${config.agentName || 'test'}`;
    this.process = new TestAgentProcess();
    this.process.onEvent((event) => {
      const unified = EventParser.toUnified(event);
      if (unified) this.emit(unified);
      if (event.type === 'done' || event.type === 'error') this.alive = false;
    });
    await this.process.start(sessionId, prompt, containerId, workDir, true, config.hostWorkDir, config.agentName, undefined, config.agentName);
  }

  sendPrompt(prompt: string): void {
    if (!this.alive) return;
    this.emit({ type: 'thinking', content: `Mock provider received follow-up: ${prompt}\n`, timestamp: Date.now() });
    this.emit({ type: 'done', exitCode: 0, timestamp: Date.now() });
    this.alive = false;
  }

  write(input: string): void {
    this.process.write(input);
  }

  stop(): void {
    this.process.kill();
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive && this.process.isAlive();
  }

  getAgentHome(): string {
    return this.agentHome;
  }

  updateTrustMode(_mode: boolean): void {
    // Test provider — no real permissions needed
  }

  private emit(event: UnifiedAgentEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Keep provider handlers isolated.
      }
    }
  }
}
