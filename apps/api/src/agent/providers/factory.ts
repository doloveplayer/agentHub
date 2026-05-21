import { AbstractProvider } from './base.js';
import { ClaudeCodeProvider } from './claude-code.js';

const registry = new Map<string, () => AbstractProvider>();

export class ProviderFactory {
  static register(name: string, factory: () => AbstractProvider): void {
    registry.set(name, factory);
  }

  static create(providerName: string): AbstractProvider {
    const factory = registry.get(providerName);
    if (!factory) {
      throw new Error(
        `Unknown provider: ${providerName}. Available: ${[...registry.keys()].join(', ')}`
      );
    }
    return factory();
  }

  static list(): string[] {
    return [...registry.keys()];
  }

  /** Initialize built-in providers. Called once on startup. */
  static init(): void {
    ProviderFactory.register('claude-code', () => new ClaudeCodeProvider());
    console.log('[provider] Registered: claude-code');
  }
}
