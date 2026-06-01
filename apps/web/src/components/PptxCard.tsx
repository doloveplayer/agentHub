import { useEffect, useRef, useState } from 'react';
import { FileText, ChevronDown, ChevronRight, X } from 'lucide-react';
import { api } from '../lib/api';
import { PptxViewer } from './PptxViewer';

interface Props {
  sessionId: string;
  filePath: string;
  fileName?: string;
  onDismiss?: () => void;
}

/**
 * Inline PPTX preview card shown in the chat message area.
 * Downloads the PPTX from workspace and renders an embedded PptxViewer.
 */
export function PptxCard({ sessionId, filePath, fileName, onDismiss }: Props) {
  const [pptxUrl, setPptxUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);

  const displayName = fileName || filePath.split('/').pop() || 'presentation.pptx';

  const setUrl = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setPptxUrl(url);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.downloadWorkspacePath(sessionId, filePath);
        if (cancelled) return;
        setUrl(URL.createObjectURL(result.blob));
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load PPTX');
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

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      {/* Card header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 border-b border-hub px-4 py-3 hover:bg-hub-hover/50 transition"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-hub-tertiary shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-hub-tertiary shrink-0" />
        )}
        <FileText className="h-4 w-4 text-hub-warning shrink-0" />
        <div className="min-w-0 flex-1 text-left">
          <div className="text-sm font-semibold text-hub-primary truncate">
            {displayName}
          </div>
          <div className="text-xs text-hub-tertiary">PPTX Presentation</div>
        </div>
        <span className="text-[10px] text-hub-muted shrink-0">
          {expanded ? 'Collapse' : 'Preview'}
        </span>
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
      </button>

      {/* Card body — expandable PPTX preview */}
      {expanded && (
        <div className="p-3 bg-hub-root">
          {loading && (
            <div className="flex min-h-[200px] items-center justify-center text-xs text-hub-muted">
              Loading presentation...
            </div>
          )}
          {error && (
            <div className="flex min-h-[120px] items-center justify-center text-xs text-hub-danger">
              {error}
            </div>
          )}
          {!loading && pptxUrl && <PptxViewer src={pptxUrl} />}
          {!loading && !pptxUrl && !error && (
            <div className="flex min-h-[120px] items-center justify-center text-xs text-hub-muted">
              No preview available
            </div>
          )}
          <div className="mt-2 text-[11px] text-hub-muted">
            Click and drag on a slide to select a region for quoting.
          </div>
        </div>
      )}
    </div>
  );
}
