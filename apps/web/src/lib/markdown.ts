export function safeMarkdownUrl(url: string): string | null {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();

  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('/') ||
    lower.startsWith('./') ||
    lower.startsWith('../') ||
    /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(trimmed)
  ) {
    return trimmed;
  }

  return null;
}
