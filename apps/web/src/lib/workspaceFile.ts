const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  txt: "plaintext",
  log: "plaintext",
};

const NON_EDITABLE_EXTENSIONS = new Set([
  "ppt",
  "pptx",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "zip",
  "gz",
  "tar",
]);

function getExtension(path: string): string {
  const match = path.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? "";
}

export function inferWorkspaceLanguage(path: string): string {
  const ext = getExtension(path);
  if (!ext) return "plaintext";
  return LANGUAGE_BY_EXTENSION[ext] || "plaintext";
}

export function isEditableWorkspaceFile(path: string): boolean {
  const ext = getExtension(path);
  if (!ext) return true;
  return !NON_EDITABLE_EXTENSIONS.has(ext);
}

const HTML_EXTENSIONS = new Set(["html", "htm"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function isHtmlFile(path: string): boolean {
  return HTML_EXTENSIONS.has(getExtension(path));
}

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(getExtension(path));
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

export function isPptxWorkspaceFile(path: string): boolean {
  return getExtension(path) === "pptx";
}

export function safeDownloadName(path: string): string {
  if (path.endsWith("/")) return "artifact.txt";
  const name = path.split("/").filter(Boolean).pop() || "";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return safe || "artifact.txt";
}

export function workspaceDownloadName(
  path: string,
  type: "file" | "directory",
): string {
  if (type === "file") return safeDownloadName(path);
  const clean = path.replace(/^\/workspace\/?/, "").replace(/\/+$/, "");
  const name = clean.split("/").filter(Boolean).pop() || "workspace";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return `${safe || "workspace"}.zip`;
}

export function displayWorkspacePath(path: string): string {
  return path.replace(/^\/workspace\/?/, "").replace(/^\//, "") || "/";
}
