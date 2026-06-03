import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Download,
  Eye,
  FileText,
  Maximize2,
  Minimize2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, appendTokenParam } from "../lib/api";
import {
  displayWorkspacePath,
  inferWorkspaceLanguage,
  isEditableWorkspaceFile,
  isHtmlFile,
  isImageFile,
  isMarkdownFile,
  isPptxWorkspaceFile,
  safeDownloadName,
} from "../lib/workspaceFile";
import { PptxViewer } from "./PptxViewer";

interface Props {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onDownloadOriginal?: (path: string) => void;
}

interface LoadedFile {
  content: string;
  size?: number;
  modifiedAt?: string;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

export function WorkspaceFileEditor({
  sessionId,
  path,
  onClose,
  onSaved,
  fullscreen = false,
  onToggleFullscreen,
  onDownloadOriginal,
}: Props) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pptxUrl, setPptxUrl] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const pptxUrlRef = useRef<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const language = useMemo(() => inferWorkspaceLanguage(path), [path]);
  const editable = useMemo(() => isEditableWorkspaceFile(path), [path]);
  const previewablePptx = useMemo(() => isPptxWorkspaceFile(path), [path]);
  const isHtml = useMemo(() => isHtmlFile(path), [path]);
  const isMd = useMemo(() => isMarkdownFile(path), [path]);
  const isImg = useMemo(() => isImageFile(path), [path]);
  const previewable = isHtml || isMd || isImg;
  const [previewMode, setPreviewMode] = useState<"code" | "preview">("preview");
  const [htmlProxyUrl, setHtmlProxyUrl] = useState<string | null>(null);
  const [htmlProxyLoading, setHtmlProxyLoading] = useState(false);
  const dirty = loaded !== null && content !== loaded.content;

  // Reset preview mode when file path changes to avoid stale mode across file types
  useEffect(() => {
    setPreviewMode("preview");
  }, [path]);

  const setPreviewUrl = (url: string | null) => {
    if (pptxUrlRef.current) URL.revokeObjectURL(pptxUrlRef.current);
    pptxUrlRef.current = url;
    setPptxUrl(url);
  };

  const setImgUrl = (url: string | null) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = url;
    setImageUrl(url);
  };

  const loadFile = async () => {
    // Skip for binary formats and non-editable images (but allow editable images like SVG in code mode)
    if (previewablePptx || (isImg && !editable)) {
      setLoaded(null);
      setContent("");
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const file = await api.getWorkspaceFile(sessionId, path);
      const next = {
        content: String(file.content ?? ""),
        size: typeof file.size === "number" ? file.size : undefined,
        modifiedAt:
          typeof file.modifiedAt === "string" ? file.modifiedAt : undefined,
      };
      setLoaded(next);
      setContent(next.content);
    } catch (err: any) {
      setError(err?.message || "Failed to load file");
    } finally {
      setLoading(false);
    }
  };

  const loadPreviewBlob = async (
    onUrl: (url: string) => void,
    label: string,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.downloadWorkspacePath(sessionId, path);
      onUrl(URL.createObjectURL(result.blob));
    } catch (err: any) {
      setError(err?.message || `Failed to load ${label} preview`);
    } finally {
      setLoading(false);
    }
  };

  const loadPptxPreview = () =>
    loadPreviewBlob((url) => setPreviewUrl(url), "PPTX");
  const loadImagePreview = () =>
    loadPreviewBlob((url) => setImgUrl(url), "image");

  // For HTML preview: start static server for the file's parent directory
  useEffect(() => {
    if (!isHtml || previewMode !== "preview") {
      setHtmlProxyUrl(null);
      return;
    }
    let cancelled = false;
    const parentDir = path.substring(0, path.lastIndexOf("/")) || "/workspace";
    const fileName = path.substring(path.lastIndexOf("/") + 1);
    setHtmlProxyLoading(true);
    setError(null);
    api
      .serveStaticDir(sessionId, parentDir)
      .then((result) => {
        if (cancelled) return;
        setHtmlProxyUrl(
          appendTokenParam(`${result.proxyUrl}${fileName}?_t=${Date.now()}`),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err?.message || "Failed to start static server for HTML preview",
        );
      })
      .finally(() => {
        if (!cancelled) setHtmlProxyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, isHtml, previewMode]);

  useEffect(() => {
    setLoaded(null);
    setContent("");
    setPreviewUrl(null);
    setImgUrl(null);
    if (previewablePptx) loadPptxPreview();
    else if (isImg && previewMode === "preview") loadImagePreview();
    else if (isHtml && previewMode === "preview") {
    } // handled by static server effect above
    else if (!isImg || previewMode === "code") loadFile();
    return () => {
      setPreviewUrl(null);
      setImgUrl(null);
    };
  }, [sessionId, path, previewablePptx, isImg, previewMode]);

  const save = async () => {
    if (!editable) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateWorkspaceFile(sessionId, path, content);
      setLoaded({ content, size: result.size, modifiedAt: result.modifiedAt });
      onSaved?.();
    } catch (err: any) {
      setError(err?.message || "Failed to save file");
    } finally {
      setSaving(false);
    }
  };

  const download = () => {
    if (!editable || previewablePptx || isImg) {
      onDownloadOriginal?.(path);
      return;
    }
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeDownloadName(path);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const editorHeight = fullscreen ? "calc(100vh - 164px)" : "420px";

  const editor = (
    <div
      data-testid={
        fullscreen ? "workspace-editor-fullscreen" : "workspace-editor-inline"
      }
      className={`flex flex-col overflow-hidden rounded-md border border-hub bg-hub-surface ${
        fullscreen
          ? "fixed left-1/2 top-1/2 z-50 h-[calc(100vh-48px)] w-[min(1180px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 shadow-2xl"
          : "min-h-[420px]"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-hub px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-hub-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-hub-primary">
            {safeDownloadName(path)}
          </div>
          <div className="truncate text-[11px] text-hub-muted">
            {displayWorkspacePath(path)}
          </div>
        </div>
        {dirty && (
          <span className="rounded bg-hub-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-hub-warning">
            Unsaved
          </span>
        )}
        <button
          onClick={() => {
            if (previewablePptx) loadPptxPreview();
            else if (isImg && previewMode === "preview") loadImagePreview();
            else if (isHtml && previewMode === "preview")
              setHtmlProxyUrl(null); // triggers useEffect to restart static server
            else loadFile();
          }}
          disabled={loading || saving}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
        </button>
        <button
          onClick={save}
          disabled={
            loading ||
            saving ||
            !dirty ||
            !editable ||
            previewablePptx ||
            (isImg && previewMode === "preview")
          }
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-success hover:bg-hub-hover disabled:opacity-40"
          title="Save"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={download}
          disabled={loading || (editable && loaded === null && !isImg)}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-link hover:bg-hub-hover disabled:opacity-40"
          title={editable && !isImg ? "Save as local file" : "Download file"}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        {previewable && (
          <div className="flex rounded bg-hub-surface border border-hub px-0.5 py-0.5">
            <button
              onClick={() => setPreviewMode("code")}
              className={`px-2 py-0.5 text-[11px] rounded ${previewMode === "code" ? "bg-hub-accent text-white" : "text-hub-secondary hover:text-hub-primary"}`}
            >
              Code
            </button>
            <button
              onClick={() => setPreviewMode("preview")}
              className={`px-2 py-0.5 text-[11px] rounded ${previewMode === "preview" ? "bg-hub-accent text-white" : "text-hub-secondary hover:text-hub-primary"}`}
            >
              Preview
            </button>
          </div>
        )}
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen editor"}
          >
            {fullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {(loaded?.size !== undefined || loaded?.modifiedAt) && (
        <div className="border-b border-hub px-3 py-1 text-[11px] text-hub-muted">
          {loaded.size !== undefined && <span>{formatSize(loaded.size)}</span>}
          {loaded.modifiedAt && (
            <span className="ml-2">
              {new Date(loaded.modifiedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="border-b border-hub bg-hub-danger/10 px-3 py-2 text-xs text-hub-danger">
          {error}
        </div>
      )}

      {previewablePptx ? (
        <div
          data-testid="pptx-preview-panel"
          className="min-h-0 flex-1 overflow-auto bg-hub-root p-3"
        >
          {loading && (
            <div className="flex min-h-[260px] items-center justify-center text-xs text-hub-muted">
              Loading PPTX preview...
            </div>
          )}
          {!loading && pptxUrl && <PptxViewer src={pptxUrl} />}
          {!loading && !pptxUrl && !error && (
            <div className="flex min-h-[260px] items-center justify-center text-xs text-hub-muted">
              No preview available
            </div>
          )}
          <div className="mt-2 text-[11px] text-hub-muted">
            PPTX preview is read-only. Use Download to save the original file.
          </div>
        </div>
      ) : isHtml && previewMode === "preview" ? (
        <div className="min-h-0 flex-1 bg-white">
          {htmlProxyLoading && (
            <div className="flex h-full items-center justify-center text-xs text-hub-muted">
              Starting preview server...
            </div>
          )}
          {htmlProxyUrl && (
            <iframe
              src={htmlProxyUrl}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
              title="HTML Preview"
            />
          )}
        </div>
      ) : isMd && previewMode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-hub-root px-6 py-4">
          {loading ? (
            <div className="flex min-h-[260px] items-center justify-center text-xs text-hub-muted">
              Loading...
            </div>
          ) : (
            <div
              className="prose prose-sm prose-invert max-w-none
              prose-headings:text-hub-primary
              prose-p:text-hub-secondary
              prose-a:text-hub-link prose-a:no-underline hover:prose-a:underline
              prose-strong:text-hub-primary
              prose-code:text-hub-accent prose-code:bg-hub-code prose-code:px-1 prose-code:py-0.5 prose-code:rounded
              prose-pre:bg-hub-code prose-pre:border prose-pre:border-hub
              prose-blockquote:border-hub-accent prose-blockquote:text-hub-tertiary
              prose-li:text-hub-secondary
              prose-th:text-hub-primary prose-td:text-hub-secondary
              prose-hr:border-hub
              prose-img:rounded-lg"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      ) : isImg && previewMode === "preview" ? (
        <div className="min-h-0 flex-1 flex items-center justify-center bg-hub-root p-4">
          {loading && (
            <div className="flex min-h-[260px] items-center justify-center text-xs text-hub-muted">
              Loading image...
            </div>
          )}
          {!loading && imageUrl && (
            <img
              src={imageUrl}
              alt={safeDownloadName(path)}
              className="max-w-full max-h-full object-contain rounded"
            />
          )}
          {!loading && !imageUrl && !error && (
            <div className="flex min-h-[260px] items-center justify-center text-xs text-hub-muted">
              <Eye className="h-4 w-4 mr-2" /> No preview available
            </div>
          )}
        </div>
      ) : editable ? (
        <div className="min-h-0 flex-1">
          <Editor
            height={editorHeight}
            language={language}
            value={content}
            theme="vs-dark"
            loading={
              <div className="px-3 py-2 text-xs text-hub-muted">Loading...</div>
            }
            onChange={(value) => setContent(value ?? "")}
            options={{
              minimap: { enabled: fullscreen },
              fontSize: fullscreen ? 13 : 12,
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-[260px] flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileText className="h-10 w-10 text-hub-muted" />
          <div>
            <div className="text-sm font-medium text-hub-primary">
              Binary artifact
            </div>
            <div className="mt-1 max-w-md text-xs leading-5 text-hub-muted">
              This file type cannot be edited safely as text in the browser.
              Download it and edit it with a desktop app, then ask an agent to
              regenerate or replace it.
            </div>
          </div>
          <button
            onClick={download}
            className="inline-flex items-center gap-2 rounded bg-hub-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-hub-accent-hover"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>
      )}
    </div>
  );

  if (!fullscreen) return editor;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/70" onClick={onClose} />
      {editor}
    </>
  );
}
