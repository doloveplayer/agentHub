import { useEffect, useRef, useState } from 'react';
import { FileText, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { isLegacyPptFile } from '../lib/workspaceFile';
import { PptxViewer } from './PptxViewer';

interface Props {
  sessionId: string;
  filePath: string;
  fileName?: string;
}

/**
 * Inline PPT/PPTX preview card shown in the chat message area.
 * For .pptx files: downloads and renders directly.
 * For .ppt files: converts via LibreOffice server-side first, then renders.
 */
export function PptxCard({ sessionId, filePath, fileName }: Props) {
  const [pptxUrl, setPptxUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);

  const displayName = fileName || filePath.split('/').pop() || 'presentation.pptx';
  const needsConversion = isLegacyPptFile(filePath);
  const formatLabel = needsConversion ? 'PPT (legacy)' : 'PPTX';

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
        let blob: Blob;
        if (needsConversion) {
          const converted = await api.convertPptToPptx(sessionId, filePath);
          blob = converted.blob;
        } else {
          const result = await api.downloadWorkspacePath(sessionId, filePath);
          blob = result.blob;
        }
        if (cancelled) return;
        setUrl(URL.createObjectURL(blob));
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load presentation');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      setUrl(null);
    };
  }, [sessionId, filePath, needsConversion]);

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
          <div className="text-xs text-hub-tertiary">{formatLabel} Presentation</div>
        </div>
        <span className="text-[10px] text-hub-muted shrink-0">
          {expanded ? 'Collapse' : 'Preview'}
        </span>
      </button>

      {/* Card body — expandable PPTX preview */}
      {expanded && (
        <div className="p-3 bg-hub-root">
          {loading && (
            <div className="flex min-h-[200px] items-center justify-center text-xs text-hub-muted">
              {needsConversion ? 'Converting .ppt to .pptx...' : 'Loading presentation...'}
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
