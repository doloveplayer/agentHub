/**
 * Detects the primary human language in a text string.
 * Used to inject a language consistency prompt so agents don't mix Chinese/English.
 */
export function detectLanguage(text: string): 'zh' | 'en' {
  const cjkChars = text.match(/[一-鿿㐀-䶿]/g);
  const cjkCount = cjkChars ? cjkChars.length : 0;
  // Require at least 4 CJK characters to avoid false positives from isolated char refs
  return cjkCount >= 4 ? 'zh' : 'en';
}

/**
 * Returns a language consistency instruction to be injected into the agent prompt.
 * The instruction tells the agent to stick to one language, keeping code/commands/file paths in English.
 */
export function languageConsistencyPrompt(lang: 'zh' | 'en'): string {
  if (lang === 'zh') {
    return '\n## 语言一致性\n请始终用中文回复，除了代码、命令、变量名、文件路径保持英文。\n';
  }
  return '\n## Language Consistency\nAlways respond in English, except for code, commands, variable names, and file paths.\n';
}
