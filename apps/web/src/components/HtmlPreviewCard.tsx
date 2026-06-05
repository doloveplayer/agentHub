import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Download,
  Globe,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import { api, appendTokenParam } from "../lib/api";

interface Props {
  sessionId: string;
  filePath: string;
  fileName?: string;
  onDismiss?: () => void;
}

export function HtmlPreviewCard({
  sessionId,
  filePath,
  fileName,
  onDismiss,
}: Props) {
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const urlRef = useRef<string | null>(null);

  const displayName =
    fileName || filePath.split("/").pop() || "index.html";

  const setUrl = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setIframeUrl(url);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.downloadWorkspacePath(sessionId, filePath);
        if (cancelled) return;
        const blob = new Blob([result.blob], { type: "text/html" });
        setUrl(URL.createObjectURL(blob));
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load HTML");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      setUrl(null);
    };
  }, [sessionId, filePath]);

  const downloadBlob = (url: string, name: string) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleDownload = async (event?: MouseEvent) => {
    event?.stopPropagation();
    if (iframeUrl) {
      downloadBlob(iframeUrl, displayName);
      return;
    }
    setDownloading(true);
    try {
      const result = await api.downloadWorkspacePath(sessionId, filePath);
      const url = URL.createObjectURL(result.blob);
      downloadBlob(url, result.filename || displayName);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || "Failed to download HTML");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className="flex w-full items-center gap-2 border-b border-hub px-4 py-3 hover:bg-hub-hover/50 transition cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-hub-tertiary shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-hub-tertiary shrink-0" />
        )}
        <Globe className="h-4 w-4 text-hub-link shrink-0" />
        <div className="min-w-0 flex-1 text-left">
          <div className="text-sm font-semibold text-hub-primary truncate">
            {displayName}
          </div>
          <div className="text-xs text-hub-tertiary">HTML Preview</div>
        </div>
        <span className="text-[10px] text-hub-muted shrink-0">
          {expanded ? "Collapse" : "Preview"}
        </span>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover hover:text-hub-secondary disabled:opacity-50 shrink-0"
          title="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        {onDismiss && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover hover:text-hub-secondary shrink-0"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="p-3 bg-hub-root">
          {loading && (
            <div className="flex min-h-[200px] items-center justify-center text-xs text-hub-muted">
              Loading preview...
            </div>
          )}
          {error && (
            <div className="flex min-h-[120px] items-center justify-center text-xs text-hub-danger">
              {error}
            </div>
          )}
          {!loading && iframeUrl && (
            <iframe
              src={iframeUrl}
              className="w-full min-h-[400px] border-0 rounded bg-white"
              sandbox="allow-scripts"
              title={`Preview: ${displayName}`}
            />
          )}
          {!loading && !iframeUrl && !error && (
            <div className="flex min-h-[120px] items-center justify-center text-xs text-hub-muted">
              No preview available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
