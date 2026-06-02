/** Supported model context window sizes in tokens. Single source of truth. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-7': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-3.5-sonnet': 200_000,
  'claude-3.5-haiku': 200_000,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
};

const DEFAULT_WINDOW = 200_000;

/** Merge env overrides at startup. */
export function mergeModelWindowOverrides(
  envVar: string | undefined,
): Record<string, number> {
  if (!envVar) return { ...MODEL_CONTEXT_WINDOWS };
  try {
    const overrides = JSON.parse(envVar) as Record<string, number>;
    return { ...MODEL_CONTEXT_WINDOWS, ...overrides };
  } catch {
    console.warn('[config] AGENTHUB_MODEL_WINDOWS is not valid JSON, ignoring');
    return { ...MODEL_CONTEXT_WINDOWS };
  }
}

/**
 * Parse suffix from model name like "deepseek-v4-pro[1M]" or "claude-opus-4-7[200K]".
 * Returns { baseName, window } or null if no suffix.
 */
export function parseModelSuffix(
  modelName: string,
): { baseName: string; window: number } | null {
  const match = modelName.match(/^(.+)\[(\d+)([KM])\]$/);
  if (!match) return null;
  const size = parseInt(match[2], 10);
  const window = match[3] === 'M' ? size * 1_000_000 : size * 1_000;
  return { baseName: match[1], window };
}

/**
 * Calculate context window usage percentage.
 * Priority: suffix [1M] > exact table match > baseName match > 200K fallback.
 */
export function calcContextPct(
  inputTokens: number,
  model?: string,
  windows: Record<string, number> = MODEL_CONTEXT_WINDOWS,
): number {
  if (!inputTokens || inputTokens <= 0) return 0;
  if (!model) return Math.round((inputTokens / DEFAULT_WINDOW) * 100);

  // 1. Parse suffix: "deepseek-v4-pro[1M]" → window from suffix value
  const suffix = parseModelSuffix(model);
  if (suffix) {
    return Math.round((inputTokens / suffix.window) * 100);
  }

  // 2. Exact table match
  if (windows[model]) {
    return Math.round((inputTokens / windows[model]) * 100);
  }

  // 3. Fallback — unknown model defaults to 200K
  return Math.round((inputTokens / DEFAULT_WINDOW) * 100);
}
