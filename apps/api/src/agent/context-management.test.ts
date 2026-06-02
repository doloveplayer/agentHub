import { describe, it, expect } from 'vitest';
import { EventParser } from './EventParser.js';
import { IntentParser } from './IntentParser.js';

describe('Context Management Integration', () => {
  describe('EventParser — NEEDS HELP detection', () => {
    it('parses NEEDS HELP patterns from agent output', () => {
      const output = `I've completed the login page. NEEDS HELP from @review-agent: Please review Login.tsx for security issues.`;

      const intents = IntentParser.scan(output);

      expect(intents).toHaveLength(1);
      expect(intents[0].targetAgentName).toBe('review-agent');
      expect(intents[0].description).toContain('Login.tsx');
    });

    it('handles multiple NEEDS HELP in one output', () => {
      const output = `Task done. NEEDS HELP from @review-agent: check auth.
NEEDS HELP from @test-agent: write tests for login.`;
      const intents = IntentParser.scan(output);

      expect(intents).toHaveLength(2);
      expect(intents[0].targetAgentName).toBe('review-agent');
      expect(intents[1].targetAgentName).toBe('test-agent');
    });
  });

  describe('EventParser — token_usage events', () => {
    it('emits token_usage from assistant message with usage', () => {
      const parser = new EventParser();
      const events = parser.parseLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 5000, output_tokens: 1000 },
        },
      }));

      const tokenEv = events.find(e => e.type === 'token_usage');
      expect(tokenEv).toBeDefined();
      if (tokenEv?.type === 'token_usage') {
        expect(tokenEv.inputTokens).toBe(5000);
        expect(tokenEv.outputTokens).toBe(1000);
      }
    });
  });

  describe('calcContextPct — threshold detection', () => {
    it('returns correct percentages at boundaries', () => {
      const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
        'claude-sonnet-4-6': 200000,
      };
      const calcContextPct = (inputTokens: number, model: string): number => {
        const window = MODEL_CONTEXT_WINDOWS[model] || 200000;
        return Math.round((inputTokens / window) * 100);
      };

      expect(calcContextPct(140000, 'claude-sonnet-4-6')).toBe(70);
      expect(calcContextPct(150000, 'claude-sonnet-4-6')).toBe(75);
      expect(calcContextPct(100000, 'claude-sonnet-4-6')).toBe(50);
    });
  });
});
